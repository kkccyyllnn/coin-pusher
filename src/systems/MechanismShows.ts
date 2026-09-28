import * as THREE from 'three';
import type { Coin } from '../entities/Coin';
import { TABLE } from '../game/constants';
import { COIN_SCALE } from '../game/coinScale';
import { makeToonMaterial } from '../render/ToonMaterial';
import { MECHANISM_CONSTANTS, type MechanismPlan, type Mechanisms } from './Mechanisms';

/**
 * 机关构件（R5）：扫板的**横扫臂**与抓斗的**爪**。
 *
 * ## 这一轮补的是什么债
 *
 * R5 之前两个机关是**零视觉构件**的：`sweep()` 一次给完冲量、`grapple()` 一次瞬移完，
 * 画面上什么都没动，玩家只能从 HUD 的一行字推断「刚才有个机关发生过」。
 * 对比 `ShowDirector` 的投放演出至少有锥体喷头与闸板。
 *
 * ## 分工
 *
 * | | 归谁 |
 *---|---|
 * | 谁被影响、影响多少、扣几次 | `Mechanisms`（出**计划**） |
 * | 什么时候生效、装置长什么样、走多快 | 这里（**交付** + 几何） |
 *
 * 于是效果从「调用即生效」变成**延迟交付**：臂扫到某一枚才推那一枚，爪升到顶才松手。
 * 总冲量与落点一字未改，改的只有时刻分布——所以账本类判据对二者不敏感，
 * `mechanisms` 模式为此新增了两条只看**交付时刻**的判据（跨度 / 松手晚于提升）。
 *
 * ## 预算
 *
 * 每件装置 +1 draw call、+0 program：材质走 `ramp: 'device'` 且**不给贴图**，
 * defines 与 `gatePanel` / `towerCylinder` 完全一致，命中同一份已编译程序。
 * 几何都是演出期临时件（`dispose()` 连几何带材质一起拆），空闲时这里零 draw call。
 *
 * ## 为什么不复用 `TimedShow`
 *
 * 那个基类在 `ShowDirector` 里，签名字字写着 `promised` / `downgraded` / `kind` 与
 * 「到点 spawn 真币」的语义。机关不发币——它搬的是**已经在盘面上的币**，
 * 硬套会让 `ShowId` 多出不属于投放演出的成员。这里只沿用它的**约定**：
 * 首帧挂几何、降动效 3× 提速、时间轴走完即拆件。
 */

export type MechanismShowId = 'sweep' | 'grapple';

/** 一场机关演出的**交付剖面**（判据读它，不拿墙钟去抢跑）。 */
export type MechanismShowRecord = {
  id: MechanismShowId;
  /** 计划里的币数（触发瞬间快照）。 */
  targeted: number;
  delivered: number;
  /** 演出期间已经自己越线消失、因而没被交付的币。 */
  skipped: number;
  /** 首次 / 末次交付在**时间轴**上的时刻（秒）。 */
  firstHitAt: number;
  lastHitAt: number;
  /** 交付完成点：扫板 = 末次命中，抓斗 = 松手那一帧。 */
  deliveredAt: number;
};

export type MechanismShowReport = {
  active: MechanismShowId | null;
  busy: boolean;
  /**
   * 在场装置的**世界坐标**与**是否挂在场景图上**（无演出时 mesh 为 null）。
   *
   * ★ `mounted` 不是多余的：一个 `new THREE.Mesh()` 造出来就已经有世界坐标了
   * （没有父级时世界 == 局部），所以**只读坐标证明不了它被渲染**。
   * 第一版就漏了这一格：装置全程挂在空气里，draw call 一动不动，
   * 而 `mesh.name` 与坐标全都「正确」——零报错的静默失效，只能靠这两项一起读。
   */
  mesh: { name: string; x: number; y: number; z: number; mounted: boolean } | null;
  /** 最近一场演出的交付剖面（含被 abort 提前交付的那场）。 */
  last: MechanismShowRecord | null;
};

type ShowDeps = {
  mechanisms: Mechanisms;
  /** 降动效：只压缩时间轴，**一枚币都不少给**（这是玩家当场花钱买的效果）。 */
  reducedMotion: () => boolean;
};

/**
 * 时间轴（秒）。
 *
 * ⚠️ 判据读到的所有时刻都记在**压缩后的时间轴**上：降动效是把 `delta` 乘 3，
 * 总时长这条线本身不变。所以「跨度 ≥ 50 毫秒」这类判据不会因为玩家降动效而假红。
 */
const ARM = { drop: 0.12, travel: 0.55, lift: 0.28 } as const;
const CLAW = {
  descend: 0.34,
  clamp: 0.2,
  lift: 0.34,
  carry: 0.4,
  open: 0.18,
  retreat: 0.3,
} as const;

/**
 * 扫板臂的观感尺寸（米）。厚度与高度随币径档位走，`depth` 必须盖住整条扫板带。
 *
 * ★ 高度 0.22 是**截图量出来的**，不是拍的：初版取 0.12 时臂顶只到床面上方 9 厘米，
 * 而币塔能堆到 9 层（约 11 厘米）—— 臂整段埋在币堆里，画面上只看得见左边缘露出的
 * 一小片橙色，「横扫」这个信息完全没送到玩家眼睛里。
 */
const ARM_SIZE = {
  width: 0.045 * COIN_SCALE,
  height: 0.22 * COIN_SCALE,
  depth: MECHANISM_CONSTANTS.sweepZone + 0.05 * COIN_SCALE,
} as const;

/** 扫板时臂底所在的**高度**：推板顶面之下 3 厘米——刀刃要**吃进币床**才读得出在扫。 */
const ARM_SWEEP_Y = TABLE.pusherTopY - 0.03 + ARM_SIZE.height / 2;

/**
 * 爪的观感尺寸（米）。
 *
 * ⚠️ 开口半径从 `grappleHalf` 派生（×1.4 = 罩住那个 0.3×0.3 米的方格需要的外接半径），
 * **不随币尺寸档位走**：抓斗的作用区是一个绝对长度（`GRAPPLE_HALF = 0.15` 米），
 * 币放大到 ×1.2 时它罩的还是一样大的一格。初版写死 0.11 米，实测只有**一枚币那么宽**，
 * 而它一次抓走 39 枚 —— 观感与事实对不上，等于没有构件。
 */
const CLAW_SIZE = {
  mouthRadius: MECHANISM_CONSTANTS.grappleHalf * 1.4,
  topRadius: 0.06,
  height: 0.26,
} as const;

/** 夹紧时爪的横向缩放（1 = 张口，0.55 = 咬合）。 */
const CLAW_CLOSED_SCALE = 0.55;

function seg01(t: number, start: number, length: number): number {
  return Math.min(1, Math.max(0, (t - start) / length));
}

abstract class Apparatus {
  /** 装置网格；首帧 `update()` 时建。`MechanismShows.report()` 要读它的世界坐标。 */
  mesh: THREE.Mesh | null = null;
  protected elapsed = 0;
  private deliveredCount = 0;
  private skippedCount = 0;
  private firstAt = 0;
  private lastAt = 0;
  private settled = false;
  protected readonly targeted: number;

  constructor(
    protected readonly deps: ShowDeps,
    protected readonly plan: MechanismPlan,
    protected readonly mount: THREE.Group,
  ) {
    this.targeted = plan.targets.length;
  }

  abstract readonly id: MechanismShowId;
  protected abstract duration(): number;
  protected abstract build(): THREE.Mesh;
  /** 时间轴推进：几何动画 +（扫板的）分批交付。 */
  protected abstract animate(t: number): void;
  /** 把还没交付的一次结清。幂等。 */
  protected abstract settleTargets(): void;

  /** 交付记时刻：`mark(true)` 才算实发，`mark(false)` 是流失（币已经自己走了）。 */
  protected mark(ok: boolean): void {
    if (!ok) {
      this.skippedCount += 1;
      return;
    }
    if (this.deliveredCount === 0) this.firstAt = this.elapsed;
    this.deliveredCount += 1;
    this.lastAt = this.elapsed;
  }

  update(delta: number): boolean {
    if (!this.mesh) {
      this.mesh = this.build();
      // ★ 挂进场景：build() 只造物件、不挂载。漏掉这一行装置就**存在但看不见**，
      //   而 report() 的世界坐标照样读得出数（见 MechanismShowReport.mesh 的注释）。
      this.mount.add(this.mesh);
    }
    const speed = this.deps.reducedMotion() ? 3 : 1;
    this.elapsed += delta * speed;
    this.animate(this.elapsed);
    const done = this.elapsed >= this.duration();
    // 时间轴走完即结清：正常应该已经交付完了（臂扫满全幅、爪走完松手），
    // 这一句只兜住「最后一帧跨过终点」那种一帧级的漏交付。
    if (done) this.settle();
    return !done;
  }

  /** 拆台不拆交付：中止动画也要先把钱货两讫（见 `MechanismShows.abort`）。 */
  settle(): void {
    if (this.settled) return;
    this.settled = true;
    this.settleTargets();
  }

  record(): MechanismShowRecord {
    return {
      id: this.id,
      targeted: this.targeted,
      delivered: this.deliveredCount,
      skipped: this.skippedCount,
      firstHitAt: Number(this.firstAt.toFixed(4)),
      lastHitAt: Number(this.lastAt.toFixed(4)),
      deliveredAt: Number((this.id === 'grapple' ? this.firstAt : this.lastAt).toFixed(4)),
    };
  }

  dispose(): void {
    const mesh = this.mesh;
    if (!mesh) return;
    mesh.geometry.dispose();
    const material = mesh.material;
    if (Array.isArray(material)) material.forEach((m) => m.dispose());
    else material.dispose();
    mesh.removeFromParent();
    this.mesh = null;
  }
}

/**
 * 装置 A · 横扫臂：一根横在扫板带里的刮板，从左侧壁扫到右侧壁。
 *
 * 分批规则只有一句：**臂的前缘越过谁的 x，就推谁**。所以「臂过去 → 币跟着倒」
 * 的因果是真的，不是先动再补效果。行程取满 `TABLE.halfWidth`，
 * 保证静止在盘面任何位置的贴线币都会被扫到（漏扫=静默少给冲量）。
 */
class SweepArmShow extends Apparatus {
  readonly id = 'sweep' as const;
  /** 还没被臂扫到的币。 */
  private readonly pending: Coin[];
  private readonly durationValue = ARM.drop + ARM.travel + ARM.lift;

  constructor(deps: ShowDeps, plan: MechanismPlan, mount: THREE.Group) {
    super(deps, plan, mount);
    this.pending = [...plan.targets];
  }

  protected duration(): number {
    return this.durationValue;
  }

  protected build(): THREE.Mesh {
    const material = makeToonMaterial({
      name: 'sweepArm',
      color: '#d9542f',
      ramp: 'device',
      emissive: '#4d1a0c',
      emissiveIntensity: 0.55,
    });
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(ARM_SIZE.width, ARM_SIZE.height, ARM_SIZE.depth),
      material,
    );
    mesh.name = 'sweepArm';
    // 刮板正对推进方向：局部 +z 朝得分线，扫过去时是**面**在推币，不是棱。
    mesh.position.set(-TABLE.halfWidth, ARM_SWEEP_Y + 0.08, TABLE.scoreLineZ - MECHANISM_CONSTANTS.sweepZone / 2);
    return mesh;
  }

  protected animate(t: number): void {
    const mesh = this.mesh;
    if (!mesh) return;
    const dropped = seg01(t, 0, ARM.drop);
    const swept = seg01(t, ARM.drop, ARM.travel);
    const lifted = seg01(t, ARM.drop + ARM.travel, ARM.lift);
    mesh.position.x = -TABLE.halfWidth + 2 * TABLE.halfWidth * swept;
    // 落下 → 吃进币床 → 抬起退出。
    mesh.position.y = ARM_SWEEP_Y + 0.08 * (1 - dropped) + 0.12 * lifted;
    // 行程走完之前，臂不会越过最右侧的币，所以这里不需要 `t < duration` 的额外闸门。
    const leading = mesh.position.x + ARM_SIZE.width / 2;
    for (let i = this.pending.length - 1; i >= 0; i -= 1) {
      const coin = this.pending[i];
      if (coin.position.x > leading) continue;
      this.pending.splice(i, 1);
      this.mark(this.deps.mechanisms.sweepHit(coin));
    }
  }

  protected settleTargets(): void {
    while (this.pending.length > 0) {
      const coin = this.pending.pop();
      if (coin) this.mark(this.deps.mechanisms.sweepHit(coin));
    }
  }
}

/**
 * 装置 B · 抓斗爪：下降 → 夹紧 → 提升到顶 → 平移到前沿 → **松手** → 张口退回。
 *
 * ## 为什么是「空手演完」
 *
 * 爪与币之间**没有**任何附着约束：币在松手那一刻才由 `grappleRelease()` 瞬移到爪的正下方。
 * 真跟随（把币钉在爪上一路抬过去）会撞上两条护栏——`maxUpwardSpeed` 与 `anomalies`
 * 判据，而「跟随期间该不该豁免速度护栏」是一个还没定的问题，不能静默放行。
 * 所以这一版把**唯一的物理动作**留在原来那一行 `setTranslation` 上，
 * 只是挪到了爪升到顶的时刻：交付点与爪当时的位置重合，观感上就是「爪把它放下去」。
 *
 * ## 落点为什么从币自己量
 *
 * 爪罩住的是**目标币的质心**，不是玩家点的那条 x 线：玩家点的是投币道，
 * 而抓的是「附近 0.3×0.3 米」那一格——两者可以差 0.15 米。写死点选线会看到爪
 * 落在币堆旁边空抓。`clamp` 到 `drop.halfLane` 的是**松手后的搬运落点**（`grappleRelease` 里），
 * 不是爪的下降点，两处职责不同。
 */
class GrappleClawShow extends Apparatus {
  readonly id = 'grapple' as const;
  private readonly durationValue =
    CLAW.descend + CLAW.clamp + CLAW.lift + CLAW.carry + CLAW.open + CLAW.retreat;
  /** 爪罩住的中心（币的质心）与币顶。 */
  private readonly at: { x: number; z: number; topY: number };
  private readonly liftY = MECHANISM_CONSTANTS.grappleLiftY;
  private readonly aboveY: number;

  constructor(deps: ShowDeps, plan: MechanismPlan, mount: THREE.Group) {
    super(deps, plan, mount);
    let x = 0;
    let z = 0;
    let topY = -Infinity;
    for (const coin of plan.targets) {
      x += coin.position.x;
      z += coin.position.z;
      topY = Math.max(topY, coin.position.y);
    }
    const n = Math.max(1, plan.targets.length);
    // 一枚币的 `position.y` 是**币心**；爪要停在币顶之上，所以补半个币高。
    this.at = { x: x / n, z: z / n, topY: (Number.isFinite(topY) ? topY : this.liftY) + COIN_SCALE * 0.012 };
    // 出场高度 = 罩住币顶之上（爪自己的高度 + 一点余量），不然第一帧它会埋在币堆里。
    this.aboveY = this.at.topY + CLAW_SIZE.height + 0.18;
  }

  protected duration(): number {
    return this.durationValue;
  }

  protected build(): THREE.Mesh {
    const material = makeToonMaterial({
      name: 'grappleClaw',
      color: '#7d8794',
      ramp: 'device',
      emissive: '#232a33',
      emissiveIntensity: 0.55,
    });
    // **三段锥台 = 三瓣爪**：`radialSegments = 3` 把侧面切成三块平板，
    // 这是「一个 geometry、一次 draw call」拿到多瓣爪的写法（分成三个 Mesh 就是 +3）。
    // ⚠️ 两端**封口**：截图里开口的漏斗从上方看是「看得见底、看不见近侧壁」
    // （背面被剔除），整只爪会塌成一枚白色菱形，读不出体积。封口后从任何角度都是实体。
    const geometry = new THREE.CylinderGeometry(
      CLAW_SIZE.topRadius,
      CLAW_SIZE.mouthRadius,
      CLAW_SIZE.height,
      3,
      1,
      false,
    );
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'grappleClaw';
    mesh.position.set(this.at.x, this.aboveY, this.at.z);
    return mesh;
  }

  protected animate(t: number): void {
    const mesh = this.mesh;
    if (!mesh) return;
    const descend = seg01(t, 0, CLAW.descend);
    const clampT = seg01(t, CLAW.descend, CLAW.clamp);
    const lift = seg01(t, CLAW.descend + CLAW.clamp, CLAW.lift);
    const carry = seg01(t, CLAW.descend + CLAW.clamp + CLAW.lift, CLAW.carry);
    const open = seg01(t, this.durationValue - CLAW.open - CLAW.retreat, CLAW.open);
    const retreat = seg01(t, this.durationValue - CLAW.retreat, CLAW.retreat);

    // 张口 → 咬合 → 保持咬合 → 张开退回
    const grip =
      1 - (1 - CLAW_CLOSED_SCALE) * clampT + (1.06 - CLAW_CLOSED_SCALE) * open;
    mesh.scale.set(grip, 1, grip);

    // 高度：下降到币顶之上 → 提升到松手高度 → 松手后落一点（吐币）→ 抽回上方
    const mouthY =
      this.aboveY +
      (this.at.topY + CLAW_SIZE.height / 2 - this.aboveY) * descend +
      (this.liftY - (this.at.topY + CLAW_SIZE.height / 2)) * lift -
      0.05 * open +
      (this.liftY + 0.22 - this.liftY) * retreat;
    mesh.position.y = mouthY;
    mesh.position.x = this.at.x;
    mesh.position.z = this.at.z + (MECHANISM_CONSTANTS.grappleTargetZ - this.at.z) * carry;

    // 走到平移的末尾 = 爪已经在松手高度、已经在前沿 → 交付。
    if (carry >= 1) this.settle();
  }

  protected settleTargets(): void {
    const count = this.deps.mechanisms.grappleRelease(this.plan);
    this.deliver(count.delivered, count.skipped);
  }

  /**
   * 抓斗的交付是**一次调用批量完成**的（`grappleRelease` 搬整堆），
   * 所以时刻记账在这里聚合，而不是逐枚 `mark`。
   */
  private deliver(delivered: number, skipped: number): void {
    for (let i = 0; i < delivered; i += 1) this.mark(true);
    for (let i = 0; i < skipped; i += 1) this.mark(false);
  }
}

export class MechanismShows {
  /** 装置的统一挂载点（与 `ShowDirector.group` 分开：机关不受投放演出的队列管）。 */
  readonly group = new THREE.Group();

  private active: Apparatus | null = null;
  private lastRecord: MechanismShowRecord | null = null;
  private readonly world = new THREE.Vector3();

  constructor(private readonly deps: ShowDeps) {}

  get busy(): boolean {
    return this.active !== null;
  }

  /** 扫板：臂横扫，冲量按行程分批给。 */
  runSweep(plan: MechanismPlan): void {
    this.start(new SweepArmShow(this.deps, plan, this.group));
  }

  /** 抓斗：爪下降夹紧、升到前沿再松手。 */
  runGrapple(plan: MechanismPlan): void {
    this.start(new GrappleClawShow(this.deps, plan, this.group));
  }

  /**
   * 上一件装置还没走完就让新的接管。
   *
   * 台面上同一时刻只放一件装置（两件都在得分线附近活动，叠在一起会互相穿模），
   * 所以**先结清再开新的**：抓斗有 2 次次数，连点两下时第二下不能把第一下的货吞了。
   */
  private start(show: Apparatus): void {
    this.abort();
    this.active = show;
  }

  /** 每帧推进（挂在 `Game.update`，与投放演出同一节奏：暂停时一起冻结）。 */
  update(delta: number): void {
    const show = this.active;
    if (!show) return;
    if (!show.update(delta)) {
      this.lastRecord = show.record();
      show.dispose();
      this.active = null;
    }
  }

  /**
   * 中止演出（开局 / 收工）。
   *
   * ⚠️ 与 `ShowDirector.abort()` 的语义**相反**，而且是故意的：
   * 那边中止时**不再补发**剩余承诺数，因为那是「本局的奖励」，本局作废它就作废，
   * 补发就成了跨局平移。这里是玩家**当场花钱买的**效果（抓斗 2 枚已经扣了、
   * 扫板次数已经用了），吞掉就是钱货不两讫。所以 abort 先 `settle()` 再拆件。
   */
  abort(): void {
    const show = this.active;
    if (!show) return;
    show.settle();
    this.lastRecord = show.record();
    show.dispose();
    this.active = null;
  }

  dispose(): void {
    this.abort();
    this.group.clear();
  }

  /** 读数（`verify-game.mjs` 的 `mechanisms` 判据消费）。 */
  report(): MechanismShowReport {
    const show = this.active;
    const mesh = show?.mesh ?? null;
    if (!mesh) {
      return { active: show?.id ?? null, busy: show !== null, mesh: null, last: this.lastRecord };
    }
    mesh.getWorldPosition(this.world);
    return {
      active: show?.id ?? null,
      busy: true,
      mesh: {
        name: mesh.name,
        mounted: mesh.parent !== null,
        x: Number(this.world.x.toFixed(4)),
        y: Number(this.world.y.toFixed(4)),
        z: Number(this.world.z.toFixed(4)),
      },
      last: this.lastRecord,
    };
  }
}
