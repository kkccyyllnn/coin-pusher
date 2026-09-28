import * as THREE from 'three';
import * as RAPIER from '@dimforge/rapier3d-compat';
import { COIN, type CoinKind } from '../game/constants';
import { coinPhysics } from '../game/coinPhysics';
import { coinColliderKey, coinColliderSpec } from './coinModels';

/**
 * 渲染挂接点。P3 起币的渲染走 CoinPool 的 4 组 InstancedMesh，
 * Coin 自己不再持有 Mesh——spawn/despawn 时通过这对回调让池分配/回收实例槽。
 */
export interface CoinRenderHooks {
  attach(coin: Coin, kind: CoinKind): void;
  detach(coin: Coin): void;
}

/**
 * `clampSpeed` 压到了一次时交出去的读数（R4-P3 的 ⑥ 冷热配对判据读它）：
 *
 * - `pre`：**截断前总速率**（`Math.hypot`，含横向）——不是向上分量，也不是截断后的值。
 *   它的合法上界是落体预算 6.68 米/秒（见 `COIN.maxUpwardSpeed` 注释第 ④ 条），
 *   不是喷泉初速度 2.2；把这两个量混了就是一条假红。
 * - `postUpward`：**截断后向上分量**。「泄流律只减不增」需要的是这个直接观测量；
 *   只有 `pre` 的话那句话就只是推断。
 */
export interface SpeedClampSample {
  pre: number;
  postUpward: number;
}

// sync() 每帧对几百枚币各跑一次，矩阵与向量全部模块级复用，不在堆上分配。
const _position = new THREE.Vector3();
const _quaternion = new THREE.Quaternion();
const _scale = new THREE.Vector3(1, 1, 1);
const _matrix = new THREE.Matrix4();

/**
 * 一枚可复用的币。物理体与全部玩法状态都在这里；
 * 渲染只是「持有 (组 InstancedMesh, 实例下标) 引用」，同步只发生在 sync()。
 * 停用时不销毁，靠 setEnabled(false) 移出模拟，避免反复建体。
 */
export class Coin {
  readonly body: RAPIER.RigidBody;

  /**
   * 碰撞体。S15 起**形状随币种变**（见 `applyCollider`），所以这里要留引用。
   *
   * ⚠️ 在 `RAPIER.ColliderDesc` 上改形状是做不到的 —— `ColliderDesc` 只在创建时
   * 被消费一次。运行期改形状只能走 `Collider.setShape()`。
   */
  private readonly collider: RAPIER.Collider;
  /**
   * 当前碰撞体形状的指纹。**用来跳过无谓的 `setShape()`**：
   * 每一局开局要 spawn 三百多枚币，绝大多数是普通币、形状从头到尾没变过，
   * 无脑 setShape 会让开局多三百多次 wasm 调用（而且每次都重算质量属性）。
   */
  private colliderKey = '';

  /** 渲染槽：所属组的 InstancedMesh 与组内实例下标。未激活时为 null / -1。 */
  renderMesh: THREE.InstancedMesh | null = null;
  renderIndex = -1;

  kind: CoinKind = 'bronze';
  active = false;
  /** 只有玩家主动投入的币才有资格点亮 XIXI 槽位。 */
  playerDropped = false;
  /**
   * 这枚币是**开局预置**的（`Game.startRun` 摆盘时落下），不是运行期注入的。
   *
   * 存在的唯一理由是给台面输送带留一个例外，见 `Game.fixedUpdate` 里那段：
   * 预置的上层币不吃输送（它们的唯一动力是推板顶面的摩擦，于是随推板前后滑动、
   * 停在原地——「推币台上下都有金币」的观感才留得住）；**运行期注入的币一律要吃**，
   * 否则它们会停在推板顶面上再也下不来。
   *
   * ⚠️ 这个区分以前是**借用 `playerDropped` 表达的**（「不是玩家投的就不输送」），
   * 在只有预置币的年代恰好等价。P10 把 `gate` 接成自动补币装置之后就不等价了：
   * 闸门从背板吐出的币落在推板顶面，被判成「不是玩家投的」→ 不吃输送 →
   * 在顶面原地停住，**一枚都到不了币床**。而 `show` 模式的判据只数「活跃币多了 7 枚」，
   * 全绿。补币的第一条行为判据（币床枚数要回升）才把它照出来。
   */
  preset = false;
  /**
   * 这枚币是**投放演出**（塔 / 闸门 / 喷泉 / 宝箱）从 `spawnOne` 生成的。
   *
   * 只为一件事存在：R4-4b 之后柱体会真的推币，于是「越线一枚币」在账本上是同一个读数，
   * 但经济意义完全不同 —— 演出自己顶出来的币（水源）vs **柱子把存量币床拱过线**（白送）。
   * 后者是 4b 唯一没被测过的风险，而且只有币自己知道自己出自哪里；
   * 让验证脚本去反推就等于抄第二份口径（纪律 2）。
   *
   * ⚠️ 池化对象 ⇒ 必须在 `spawn()` 里归位，否则一枚币演过一次塔就永远是「演出币」。
   */
  fromShow = false;
  /** 已经登记过 XIXI 槽位（每枚只登记首次）。 */
  xixiMarked = false;
  /** 已越过得分线，防止重复结算。 */
  settled = false;
  /**
   * 这枚币投出时的加注倍率（1 / 2 / 4）。
   *
   * 加注买的是「这一投的返值倍率」，而倍率必须在**投出那一刻**定下来：
   * 玩家可以在币在途时改档，若在越线时读当前档位，就变成「用 1 枚的价
   * 享受 5 枚的倍率」。所以档位要盖在币身上。
   */
  betMul = 1;
  /** 上一物理步是否在推板顶面上，用于识别「离开台面」这一刻。 */
  onDeck = false;
  /**
   * 本次下落的**峰值下坠速度**（米/秒，取最负值）。`0` 表示"当前没在下落"。
   *
   * 落定音靠它识别「下落 → 静止」的转变：`vy` 越过阈值不再为负时，
   * 若 `fallVy` 仍为负，说明这一子步就是落地那一刻。
   *
   * ★ 记录**最负值**而不是"上一子步的 vy"：落地瞬间 vy 已经归零，
   * 只有峰值能反映撞击力度，用来区分轻撞（单币触台）与重撞（砸进币堆）。
   */
  fallVy = 0;

  constructor(
    world: RAPIER.World,
    private readonly render: CoinRenderHooks,
  ) {
    const desc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(0, -60, 0)
      // 阻尼与下面 collider 的密度/摩擦/弹性一律读 `coinPhysics` 注册表，
      // **不是** `COIN.*` 常量——调试面板要能在运行时改它们，构造期与改参期
      // 必须读同一处，否则会出现「拖了滑块但新建的币仍按常量建」的半生效状态。
      .setLinearDamping(coinPhysics.linearDamping)
      .setAngularDamping(coinPhysics.angularDamping)
      // 额外迭代次数默认 0（见 `constants.COIN.additionalSolverIterations` 的注释）：
      // 设成 1 的那一版实测会把整堆币压进地板，所以这里不硬编码，由 `Game.applyTuning`
      // 从调参表统一施加，方便 A/B 对照。
      .setAdditionalSolverIterations(COIN.additionalSolverIterations)
      .setCanSleep(true);
    this.body = world.createRigidBody(desc);

    // 半径与半厚仍走 `COIN.*`：它们是「尺寸」，无法热切换（见 `coinScale.ts`）。
    const collider = RAPIER.ColliderDesc.cylinder(COIN.halfThickness, COIN.radius)
      .setDensity(coinPhysics.density)
      .setFriction(coinPhysics.friction)
      .setRestitution(coinPhysics.restitution);
    this.collider = world.createCollider(collider, this.body);
    // 构造函数建的就是「普通币」那一档，指纹同步记下来，第一次 spawn 普通币时不必 setShape。
    this.colliderKey = coinColliderKey(coinColliderSpec('bronze'));

    this.body.setEnabled(false);
  }

  /**
   * 把碰撞体调成这个币种该有的形状（S15）。
   *
   * ## 为什么必须跟着币种变
   *
   * `diamond` / `chest` 是**低多面体模型**，S16 起高 132 / 224 mm，是普通币（24 mm）
   * 的 5.5 / 9.3 倍，外接直径 216 / 360 mm 是币径（144 mm）的 1.5 / 2.5 倍。
   * 沿用扁平圆柱碰撞体的后果不是「轻微穿模」，而是**两枚模型币视觉上互相插进对方身体里**
   * （碰撞体允许它们靠到币心距 144 mm，而宝箱光半宽就有 161 mm，
   * 高度方向更是完全没有约束）。
   *
   * ## 顺序：必须在 `setEnabled(true)` **之前**调用
   *
   * `setShape()` 会按新形状重算质量属性，而币此刻还停在上一局的位姿上；
   * 先改形状再启用，等于让币「以最终形状出生」，不会有任何一帧用错形状参与求解。
   *
   * ⚠️ `setShape()` 之后要补一次 `setDensity()`：Rapier 只在密度**被设置**时按
   * 「密度 × 新体积」重算质量，光换形状不重设密度在某些版本下会留下旧质量 ——
   * 那会表现成「模型币比看起来轻得多」，是零报错的静默错。
   */
  private applyCollider(kind: CoinKind): void {
    const spec = coinColliderSpec(kind);
    const key = coinColliderKey(spec);
    if (key === this.colliderKey) return;
    this.colliderKey = key;
    this.collider.setShape(
      spec.shape === 'cylinder'
        ? new RAPIER.Cylinder(spec.halfHeight, spec.radius)
        : new RAPIER.Cuboid(spec.halfExtents[0], spec.halfExtents[1], spec.halfExtents[2]),
    );
    // ★ 这一行必须读 `coinPhysics` 而不是 `COIN`：币种切换（模型币 ↔ 普通币）会走到
    // 这里，而 `setShape()` 会重算质量。若写成常量，调试面板上调过的密度会在**换币种时
    // 被悄悄回退**——表现是「模型币比看起来轻得多」，零报错的静默错。
    this.collider.setDensity(coinPhysics.density);
  }

  /**
   * 把 `coinPhysics` 注册表的当前值施加到这枚币上。
   *
   * 由 `Game.applyTuning()` 在参数真的变化时统一调用（不是每帧）。这里是**运行时可改**
   * 的那一半物理参数的另一半通路：构造期负责「新建的币」，这个方法负责「已经存在的币」。
   * 少了它，拖滑块只会影响之后新生成的币。
   *
   * 不包含 `maxSpeed` / `maxUpwardSpeed`——那两个不写进刚体，而是在
   * `Game.fixedUpdate` 里每子步读注册表直接用作护栏阈值。
   */
  applyPhysics(): void {
    this.body.setLinearDamping(coinPhysics.linearDamping);
    this.body.setAngularDamping(coinPhysics.angularDamping);
    this.collider.setFriction(coinPhysics.friction);
    this.collider.setRestitution(coinPhysics.restitution);
    // setDensity 会按「密度 × 当前体积」重算质量，所以它必须最后调。
    this.collider.setDensity(coinPhysics.density);
  }

  spawn(
    kind: CoinKind,
    x: number,
    y: number,
    z: number,
    yaw: number,
    playerDropped: boolean,
    preset = false,
  ): void {
    this.kind = kind;
    this.playerDropped = playerDropped;
    this.preset = preset;
    this.fromShow = false;
    this.xixiMarked = false;
    this.settled = false;
    this.betMul = 1;
    this.onDeck = false;
    this.fallVy = 0;
    this.active = true;

    // 先定形状、再摆位姿：`setShape()` 按新形状重算质量与惯量，
    // 摆在错位姿上再改形状会让第一步求解解出一个假的位移。
    this.applyCollider(kind);

    this.body.setTranslation({ x, y, z }, true);
    const half = yaw / 2;
    this.body.setRotation({ x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setEnabled(true);
    this.body.wakeUp();

    // 物理就位后再入组：attach 会立刻写一次实例矩阵，读到的必须是新位姿。
    this.render.attach(this, kind);
  }

  despawn(): void {
    if (!this.active) return;
    this.active = false;
    this.body.setEnabled(false);
    this.render.detach(this);
  }

  /** 唯一的位置同步点：物理 → 渲染（写进所属组的实例矩阵）。 */
  sync(): void {
    if (!this.active || !this.renderMesh) return;
    const t = this.body.translation();
    const r = this.body.rotation();
    _position.set(t.x, t.y, t.z);
    _quaternion.set(r.x, r.y, r.z, r.w);
    _matrix.compose(_position, _quaternion, _scale);
    this.renderMesh.setMatrixAt(this.renderIndex, _matrix);
  }

  /**
   * 渲染侧位置（从实例矩阵读回）。诊断探针用：把渲染与物理放到同一把尺子上量。
   * 未渲染（未激活）时返回 null。
   */
  renderPosition(): THREE.Vector3 | null {
    if (!this.renderMesh || this.renderIndex < 0) return null;
    this.renderMesh.getMatrixAt(this.renderIndex, _matrix);
    return new THREE.Vector3().setFromMatrixPosition(_matrix);
  }

  get position(): RAPIER.Vector {
    return this.body.translation();
  }

  speed(): number {
    return Math.hypot(...this.velocity3());
  }

  /**
   * 线速度三分量。诊断用：异常币只报一个速率是不够的——
   * 「被币堆弹飞」（vy 明显为负/正且 |v| 远大于推板速度）与
   * 「沿台面滑出侧壁」（vx 主导、|v| 接近推板速度）是两种完全不同的缺陷。
   */
  velocity3(): [number, number, number] {
    const v = this.body.linvel();
    return [v.x, v.y, v.z];
  }

  /**
   * 速度护栏：把求解器**凭空造出来的**速度压回这台机器物理上可能的值。
   *
   * 两个上限的取值依据见 `COIN.maxSpeed` / `COIN.maxUpwardSpeed` 的注释。
   * 一次压到就交出一个 `SpeedClampSample`（没压到返回 null）——调用方拿它做遥测，
   * 这样「求解器还在不在造能量」与「压完还剩多少」都是可观测的，而不是被悄悄抹平。
   *
   * 只在**醒着**的币上调用：睡着的币不参与积分，不可能产生速度尖峰。
   *
   * **向上那一路是连续泄流（R4-P3），不是硬截断**：
   * `y -= (y - maxUpward) × (1 - exp(-dt / tau))`，`tau = coinPhysics.upwardBleedTau`。
   * 阈值处修正量恰好为 0 ⇒ 整条律对速度连续，于是「同一次弹跳是否被削、削多少」
   * 不再取决于尖峰落在哪一子步（原来的 `if (y > maxUpward) y = maxUpward` 在阈值处
   * 有折角，本身就是噪声源）。代价：超阈部分存续更久 ⇒ `peakSpikeSpeed` 会合理地变高，
   * 所以判据 6.3 的口径与 `tau` 的标定是绑在一起的，见 `COIN.upwardBleedTau`。
   *
   * `dt` 由调用方传**子步长**（`Game.fixedUpdate` 的 `fixedDt`），不在这里读常量：
   * 这条律的自变量是积分步长，写死会随 `maxSubSteps` 的变化悄悄改变含义。
   * `tau` 读 `coinPhysics` 注册表（**仍然没有滑块**，理由见那个键的注释）：
   * A/B 要在一次页面加载里换臂，而改常量会触发整页刷新、作废进行中的验证批。
   */
  clampSpeed(maxSpeed: number, maxUpward: number, dt: number): SpeedClampSample | null {
    const v = this.body.linvel();
    let { x, y, z } = v;
    const before = Math.hypot(x, y, z);
    if (y > maxUpward) {
      y -= (y - maxUpward) * (1 - Math.exp(-dt / coinPhysics.upwardBleedTau));
    }

    let after = Math.hypot(x, y, z);
    if (after > maxSpeed) {
      const scale = maxSpeed / after;
      x *= scale;
      y *= scale;
      z *= scale;
      after = maxSpeed;
    }

    if (after === before) return null;
    this.body.setLinvel({ x, y, z }, true);
    return { pre: before, postUpward: y };
  }

  /** 台面输送：只补足向前速度，不覆盖横向与垂直运动。 */
  applyConveyor(targetSpeedZ: number): void {
    const v = this.body.linvel();
    if (v.z >= targetSpeedZ) return;
    const mass = this.body.mass();
    this.body.applyImpulse({ x: 0, y: 0, z: (targetSpeedZ - v.z) * mass }, true);
  }
}
