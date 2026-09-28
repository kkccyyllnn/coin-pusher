import * as THREE from 'three';
import * as RAPIER from '@dimforge/rapier3d-compat';
import { COLORS, PUSHER_CYCLE, RULES, TABLE } from '../game/constants';
import { ROLE_DETAIL } from '../game/artDirection';
import { SLOT_SYMBOL_ICONS, XIXI_SEGMENT } from '../game/xixi';
import type { IconId } from '../game/icons';
import { createBadgeTexture, xixiBadgeSize } from '../render/iconTexture';
import { makeToonMaterial, type LitMaterial } from '../render/ToonMaterial';

export type PusherPhase = 'extend' | 'holdFront' | 'retract' | 'holdBack';

export type PusherTick = {
  /** 完整走完一个「前推 → 停留 → 回撤 → 停留」循环。 */
  cycleCompleted: boolean;
  /** 新的前推行程开始（加力在此刻结算）。 */
  boostConsumed: boolean;
};

const PHASE_ORDER: PusherPhase[] = ['extend', 'holdFront', 'retract', 'holdBack'];

/**
 * 各相位时长的**出厂默认值**（秒）。
 *
 * 它不是运行时读取点——真正被读的是实例字段 `Pusher.durations`（初值取这里）。
 * 之所以要有这一层，是为了让调试面板能实时改相位时长，同时保证默认行为一字不变。
 */
export const PHASE_DURATION_DEFAULTS: Readonly<Record<PusherPhase, number>> = {
  extend: PUSHER_CYCLE.extend,
  holdFront: PUSHER_CYCLE.holdFront,
  retract: PUSHER_CYCLE.retract,
  holdBack: PUSHER_CYCLE.holdBack,
};

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

const HALF_DEPTH = (TABLE.pusherFrontZAtRest - TABLE.pusherBackZ) / 2;
const CENTER_Z = (TABLE.pusherFrontZAtRest + TABLE.pusherBackZ) / 2;
/** 碰撞体半高：币实际踩在 `y = TABLE.pusherTopY` 上，**这个值不许动**。 */
const HALF_HEIGHT = TABLE.pusherTopY / 2;
/** 上层台面薄板的厚度（`buildVisuals` 里的 `top`）。 */
const TOP_SLAB_THICKNESS = 0.012;
/**
 * `body` **可视体**的顶面高度 = `TABLE.pusherTopY - TOP_SLAB_THICKNESS`。
 *
 * ## 为什么必须比 `top` 薄板低一档
 *
 * `body` 与 `top` 的 footprint **完全相同**（`1.58 × 2.19`）。原先把 `body` 做成
 * `y ∈ [0, 0.2]`，薄板贴在上面的 `y ∈ [0.188, 0.2]` —— 于是**两个朝上的面
 * 落在同一个 `y = 0.2` 上**，共面 z-fighting。画面上的表现就是用户报的
 * 「**上层台面在闪**」。
 *
 * 把 `body` 的顶面压到薄板底面（两者**背靠背**：body 顶朝上 / 薄板底朝下），
 * 背面剔除之后不再有任何一对共面片。
 *
 * ★ 只改可视体，**物理碰撞体仍用 `HALF_HEIGHT`**（币踩在 `y = 0.2` 上，
 * 不能因为消一个 z-fighting 就把台面降 12 毫米 —— 那会让币悬空/下沉，
 * 而且 `isOnDeck` 的高度带判据会跟着错）。
 */
const BODY_TOP_Y = TABLE.pusherTopY - TOP_SLAB_THICKNESS;

/**
 * 推板**前上棱**的 45° 斜角（S21 批注 ④）。单位米 —— z 与 y 各切掉这么多。
 *
 * ## 为什么只切 `body`，**不切**上面那块薄板
 *
 * 斜角只做**视觉**：碰撞体一动不动（见构造函数里的 `ColliderDesc.cuboid`，
 * 前表面仍在 `TABLE.pusherFrontZAtRest`），所以不影响物理与经济判据。
 *
 * 但**台面（薄板）的前缘必须留在物理前缘上**：若把薄板也一起切掉，
 * 看得见的台面边就比币真正踩到的边后退 0.05 米 ⇒ 上层台面的币会在离台面边
 * 还有 5 厘米时就开始「悬空」（480p 下约 25 像素，看得见）。
 * 只切 `body` 的后果正好反过来、而且是良性的：
 *   - 台面前缘 = 物理前缘 ⇒ 币的落点与碰撞体一致；
 *   - 斜角面朝**上前方**（法线 `(0, √2/2, √2/2)`），正对相机，看得见；
 *   - 薄板在斜角上方留一条 5 厘米的「檐」，两者之间那道凹槽是有意保留的造型。
 *
 * 取 0.05 米：推板立面总高 `BODY_TOP_Y` = 0.188 米，切掉约 1/4 ——
 * 480p 下约 25 像素，看得出是斜角而不是倒角。
 */
const FRONT_CHAMFER = 0.05;

/**
 * 由 (z, y) 平面的轮廓沿 x 挤出一块推板件（S21）。
 *
 * 与 `TableBuilder.cabinetPrismMesh` 同一套坐标约定（`rotateY(-π/2)` 把 shape.x
 * 映到世界 z、把挤出方向映到世界 −x），区别只在这里 x 是**居中**的：
 * 挤出宽度取 `2 × pusherHalfWidth`，再把整体平移回 `x = 0`。
 *
 * 轮廓点直接用**世界 (z, y) 坐标**写（不是中心 + 尺寸），所以网格自身不带偏移 ——
 * 行程由 `this.group.position.z` 统一承担。
 */
function pusherPrism(profile: readonly (readonly [number, number])[]): THREE.ExtrudeGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(profile[0][0], profile[0][1]);
  for (let i = 1; i < profile.length; i += 1) shape.lineTo(profile[i][0], profile[i][1]);
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: TABLE.pusherHalfWidth * 2,
    bevelEnabled: false,
    curveSegments: 1,
  });
  geometry.rotateY(-Math.PI / 2);
  // 挤出段落在 x ∈ [−2·halfWidth, 0]，平移一个半宽即居中（±halfWidth）。
  geometry.translate(TABLE.pusherHalfWidth, 0, 0);
  return geometry;
}

/**
 * XIXI 四槽在推板前缘的**内嵌标牌**（P5 的槽位映射见 `game/xixi.ts`）。
 *
 * ## 为什么挂在推板上
 *
 * 槽位是「币落到币床上那一刻的 x」决定的，而玩家瞄准的落点就在推板前缘上方
 * —— HUD 那排 `X I X I` 圆点的锚点也正是推板前缘（`Game.updateMarksAnchor`）。
 * 把它从 DOM 搬进模型，最自然的位置就是同一处：**推板前缘的立面上**。
 *
 * ## 尺寸（P10 改成等宽 + 像素徽章后重新推过）
 *
 * - **段宽 0.34 米**：从 `xixiSlot()` 的分段推出来（`halfLane = 0.68`，四段各占
 *   `halfLane / 2`），**不能随手改**——改了就与 HUD 的锚点、与玩家瞄准的落点对不上。
 *   四段合计 1.36 米，正好铺满 `±0.68`，段与段之间不留缝（连成一条徽章带）。
 *   ★ 这一份几何现在**从 `XIXI_SEGMENT` 派生**，不再在两边各写一遍 `halfLane / 2`。
 * - **段高 0.14 米 / 中心 y = 0.12**：立面本身是 y ∈ [0, 0.2]，下缘要避开币床堆积
 *   （币堆贴到 y ≈ 0.10），上缘要留出推板压条。0.14 是能给的接近上限的一档。
 *   它同时把图标做到 **1:1**：推板前立面处约 **113 后备像素/米**（1280×720，
 *   `f = 360/tan21° = 937.8`，该处视深约 4.15 米，再除以像素倍率 2），
 *   于是 0.14 米 ≈ 15.8 后备像素，而贴图里的图标是 **16 纹素**（32 的整数一半）
 *   —— 差 1%，肉眼不可分。
 *
 * ## 贴图：像素徽章（P10）
 *
 * 段面贴 `createBadgeTexture('cross', …)` —— 贴图**按条子的世界比例**生成
 * （见 `xixiBadgeSize`），图标按高度等比居中、两侧补徽章底色。直接铺 32×32
 * 的方形贴图会被横向拉成 2.4:1，叉就不是叉了。
 *
 * ## 状态靠 `instanceColor`，不靠材质
 *
 * 四段共用一个 `InstancedMesh`（**1 个 draw call**），亮灭写 `instanceColor`。
 * 已核实 three 0.184 支持：`WebGLProgram` 在 `instancingColor` 时给片元补
 * `#define USE_COLOR`，而 `color_vertex` 里 `vColor.rgb *= instanceColor.rgb`。
 * 材质基色填**纯白**，让 `instanceColor` 直接当 albedo 用（它是乘在基色上的）。
 *
 * ★ 因为 albedo 被 `instanceColor` 乘，「灭」的档位会把徽章一起压暗 —— 这是**有意的**：
 * 亮的段是金色徽章、灭的段是暗铜板，形状仍然可辨但不出跳。
 *
 * 命中爆闪复用同一实例（把颜色临时拉到 1 以上），**不额外占 draw call**。
 */
const XIXI_LANE = {
  /** 段宽 —— **从 `xixiSlot()` 的分段派生**（`XIXI_SEGMENT.width`），不能随手改。 */
  width: XIXI_SEGMENT.width,
  /** 段高：立面 y ∈ [0, 0.2] 里能给的接近上限的一档（下缘避开币床堆积、上缘留推板压条）。 */
  height: 0.14,
  depth: 0.014,
  /** 板中心的世界 y（推板前立面 y ∈ [0, 0.2]，取中偏上，避开币床堆积的遮挡）。 */
  y: 0.12,
} as const;

/**
 * 四段上画的徽章图标。**I 用 X 替代**（用户拍板）——所以四段都是同一个叉，
 * 字义（`X I X I`）仍由 HUD 的逻辑字形承担（见 `XIXI_GLYPHS`）。
 *
 * 走 `SLOT_SYMBOL_ICONS.boost`（= `'cross'`）而不是写字面量 `'cross'`：
 * 「叉 → 力」这条对应关系只有 `xixi.ts` 一份真源，标牌跟着它走。
 */
const XIXI_LANE_ICON: IconId = SLOT_SYMBOL_ICONS.boost;

/** 未点亮：暗青灰。**不能近黑** —— 色带是乘在 albedo 上的，近黑乘任何色带还是近黑。 */
const XIXI_LANE_DIM = new THREE.Color(0.09, 0.12, 0.14);
/** 已点亮：主橙金（`COLORS.bounty`），与背板老虎机的奖励色同源。 */
const LANE_LIT_COLOR = new THREE.Color().setStyle(COLORS.bounty);
/** 命中爆闪：超过 1 的 albedo，经 ACES 之后是干净的白闪。 */
const XIXI_LANE_FLASH = new THREE.Color(2.4, 2.4, 2.4);

/**
 * 往复推板。一整块运动学刚体：顶面是上层台面，前表面是推币面。
 * 未开始前静止；由 Game 在首次有效投币后调用 start()。
 */
export class Pusher {
  readonly body: RAPIER.RigidBody;
  readonly group = new THREE.Group();

  running = false;
  cyclesCompleted = 0;
  /** 单程行程，可由调试面板实时调整。 */
  travel: number = TABLE.pusherTravel;

  /**
   * 各相位时长（秒），可由调试面板实时调整。
   *
   * ★ 生效语义与 `travel` **不同**：这里是**每帧现读**（见 `update` 的相位判据与
   * `computeOffset`），所以改完**当场生效**，不需要等下一周期。反过来说，若把
   * 当前相位的时长调到小于已经累计的 `phaseTime`，`while` 会立刻推进相位
   * （`guard < 4` 兜底，最多一帧翻 4 个相位）。
   *
   * 而 `travel` 是**按行程锁存**的：只在进入 `extend` 的那一帧读一次。
   */
  durations: Record<PusherPhase, number> = { ...PHASE_DURATION_DEFAULTS };

  /**
   * 加力追加的行程比例（0.2 = 追加 20%），可由调试面板实时调整。
   *
   * 注意它乘的是 `travelForStroke`，而回撤段也用同一个值——所以加力把
   * **整趟往返**都放大了，不只是前推段。
   */
  boostTravelBonus: number = RULES.boostTravelBonus;

  /** 推板当前的世界速度（米/秒），台面输送需要用它做参考系。 */
  velocityZ = 0;
  /** 前缘高亮条的材质：加力生效时由 Game 闪一下（动效只放大已发生的事）。 */
  lipMaterial!: LitMaterial;
  /** XIXI 四槽的内嵌标牌（1 个 InstancedMesh，4 个实例）。 */
  xixiLanes!: THREE.InstancedMesh;
  /** 徽章贴图的纹素尺寸（判据读它核对「图标 16 纹素 1:1」，见 `xixiLaneReport`）。 */
  private xixiBadgeTexels: { width: number; height: number } = { width: 0, height: 0 };
  /** 上一次写入的亮灭状态，用来避免每帧重传 `instanceColor`。 */
  private xixiLaneState: boolean[] = [false, false, false, false];
  private xixiFlashSlot = -1;
  private xixiFlashIntensity = 0;

  private phase: PusherPhase = 'holdBack';
  private phaseTime = 0;
  private offsetZ = 0;
  private travelForStroke: number = TABLE.pusherTravel;
  private boostQueued = false;

  constructor(world: RAPIER.World) {
    this.body = world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, 0, 0),
    );

    world.createCollider(
      RAPIER.ColliderDesc.cuboid(TABLE.pusherHalfWidth, HALF_HEIGHT, HALF_DEPTH)
        .setTranslation(0, HALF_HEIGHT, CENTER_Z)
        .setFriction(0.35)
        .setRestitution(0.02),
      this.body,
    );

    this.buildVisuals();
    this.applyTransform();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.phase = 'holdBack';
    this.phaseTime = 0;
    this.offsetZ = 0;
    this.velocityZ = 0;
  }

  stop(): void {
    this.running = false;
    this.velocityZ = 0;
  }

  /** 复位到归位状态，用于重试与切关。**瞬时传送**，不是一次归位行程。 */
  reset(): void {
    this.running = false;
    this.phase = 'holdBack';
    this.phaseTime = 0;
    this.offsetZ = 0;
    this.velocityZ = 0;
    this.travelForStroke = this.travel;
    this.boostQueued = false;
    this.cyclesCompleted = 0;
    this.applyTransform(true);
  }

  /** 请求在下一次完整前推上追加行程。返回 false 表示已有一发待用。 */
  requestBoost(): boolean {
    if (this.boostQueued) return false;
    this.boostQueued = true;
    return true;
  }

  get pendingBoost(): boolean {
    return this.boostQueued;
  }

  cancelBoost(): void {
    this.boostQueued = false;
  }

  get currentPhase(): PusherPhase {
    return this.phase;
  }

  /**
   * 一个完整往复周期的时长（秒）= 四段相位之和。
   *
   * 原来是 `constants.PUSHER_PERIOD` 这个模块常量；相位时长变成实例字段之后，
   * 周期也必须跟着变成派生量——否则调完时长，诊断里读到的还是旧的 1.95 秒，
   * 而 `scripts/verify-game.mjs` 正是从诊断读它来推导推进率的。
   */
  get period(): number {
    return (
      this.durations.extend +
      this.durations.holdFront +
      this.durations.retract +
      this.durations.holdBack
    );
  }

  get offset(): number {
    return this.offsetZ;
  }

  /** 当前推币面的 z 坐标。 */
  get frontFaceZ(): number {
    return this.offsetZ + CENTER_Z + HALF_DEPTH;
  }

  /** 推板顶面（上层台面）的世界 z 区间。 */
  get topRange(): { back: number; front: number } {
    return { back: this.offsetZ + TABLE.pusherBackZ, front: this.frontFaceZ };
  }

  /** 推进一步。必须在 world.step() 之前调用。 */
  update(delta: number): PusherTick {
    const tick: PusherTick = { cycleCompleted: false, boostConsumed: false };
    if (!this.running) {
      this.velocityZ = 0;
      return tick;
    }

    this.phaseTime += delta;
    let guard = 0;
    while (this.phaseTime >= this.durations[this.phase] && guard < 4) {
      this.phaseTime -= this.durations[this.phase];
      const previous = this.phase;
      const nextIndex = (PHASE_ORDER.indexOf(this.phase) + 1) % PHASE_ORDER.length;
      this.phase = PHASE_ORDER[nextIndex];
      guard += 1;

      if (this.phase === 'extend') {
        this.travelForStroke = this.travel;
        if (this.boostQueued) {
          this.travelForStroke = this.travel * (1 + this.boostTravelBonus);
          this.boostQueued = false;
          tick.boostConsumed = true;
        }
      }

      if (previous === 'holdBack' && this.phase === 'extend') {
        this.cyclesCompleted += 1;
        tick.cycleCompleted = true;
      }
    }

    const previousOffset = this.offsetZ;
    this.offsetZ = this.computeOffset();
    this.velocityZ = delta > 0 ? (this.offsetZ - previousOffset) / delta : 0;
    this.applyTransform();
    return tick;
  }

  private computeOffset(): number {
    const duration = this.durations[this.phase];
    const t = duration > 0 ? Math.min(this.phaseTime / duration, 1) : 1;
    switch (this.phase) {
      case 'holdBack':
        return 0;
      case 'extend':
        return this.travelForStroke * smoothstep(t);
      case 'holdFront':
        return this.travelForStroke;
      case 'retract':
        return this.travelForStroke * (1 - smoothstep(t));
      default:
        return 0;
    }
  }

  /**
   * 把推板搬到 `offsetZ` 处。
   *
   * `teleport = false`（默认，走行程时用）：只设 `setNextKinematicTranslation`，
   * 表达「**下一步到达**这里」——引擎据此算出一段平滑的 kinematic 速度。
   *
   * `teleport = true`（**复位**用）：先 `setTranslation` **立刻**搬过去，再设同值的 next。
   * 这一步不能省，理由是实测出来的：
   * `reset()` 从行程最大处（+`travel`）归位到 0，若只用 next 目标，引擎会把这段
   * 位移当成**一帧内走完**，等效速度 ≈ `travel × 60` ≈ **21 米/秒**——
   * 也就是推板以 21 米/秒**倒着扫过币床**。新开局摆好的背排币正好在这个扫掠带里，
   * 会被挤飞出机柜（实测单局丢 16~31 枚，全被记成 `anomalies`，盘面因此比预置少一截）。
   *
   * **复位是传送，不是运动。** 这条必须写在实现里，不能靠调用顺序兜底
   * （`startRun` 现在也按「先归位、再摆盘」排序，两层都防着）。
   * 两个都设是为了避免下一步又朝某个陈旧的 next 目标掠过去。
   */
  private applyTransform(teleport = false): void {
    if (teleport) this.body.setTranslation({ x: 0, y: 0, z: this.offsetZ }, true);
    this.body.setNextKinematicTranslation({ x: 0, y: 0, z: this.offsetZ });
    this.group.position.z = this.offsetZ;
  }

  private buildVisuals(): void {
    const halfWidth = TABLE.pusherHalfWidth;

    const body = new THREE.Mesh(
      // ★ S21（批注 ④）：从 `BoxGeometry` 换成沿 x 挤出的轮廓，前上棱切 45° 斜角。
      //   轮廓按 (z, y) 写：底边 → 前立面 → 斜角 → 顶面。
      //   高度用 `BODY_TOP_Y`（不是 `HALF_HEIGHT * 2`）：顶面要让开薄板，
      //   见该常量的注释；斜角也在这个高度以下切。
      pusherPrism([
        [TABLE.pusherBackZ, 0],
        [TABLE.pusherFrontZAtRest, 0],
        [TABLE.pusherFrontZAtRest, BODY_TOP_Y - FRONT_CHAMFER],
        [TABLE.pusherFrontZAtRest - FRONT_CHAMFER, BODY_TOP_Y],
        [TABLE.pusherBackZ, BODY_TOP_Y],
      ]),
      makeToonMaterial({
        name: 'pusherFace',
        color: COLORS.pusherFace,
        ramp: 'metal',
        ...ROLE_DETAIL.pusherFace,
      }),
    );
    // 轮廓已经是世界 (z, y) 坐标 ⇒ 网格自身不再需要位置偏移（行程由 `group` 承担）。
    body.castShadow = true;
    body.receiveShadow = true;
    body.userData.role = 'pusherFace';
    body.userData.part = 'pusherFace';
    this.group.add(body);

    // 上层台面：薄板贴在最上面，比推币面浅一档，让上下两层在画面上分得开。
    // 薄板底面正好落在 `BODY_TOP_Y` 上（背靠背，不共面 —— 见 `BODY_TOP_Y` 的注释）。
    // ★ S21：薄板**刻意不跟着**前上棱一起切斜角 —— 台面前缘必须留在
    // `TABLE.pusherFrontZAtRest`（= 碰撞体前表面）上，理由见 `FRONT_CHAMFER` 的注释。
    const top = new THREE.Mesh(
      new THREE.BoxGeometry(halfWidth * 2, TOP_SLAB_THICKNESS, HALF_DEPTH * 2),
      makeToonMaterial({
        name: 'pusherTop',
        color: COLORS.pusherTop,
        ramp: 'cabinet',
        // V3：推板顶面是玩家看得最久的平面之一，给它木纹（与出币托盘同组）。
        ...ROLE_DETAIL.pusherTop,
      }),
    );
    top.position.set(0, TABLE.pusherTopY - TOP_SLAB_THICKNESS / 2, CENTER_Z);
    top.castShadow = true;
    top.receiveShadow = true;
    top.userData.role = 'pusherTop';
    top.userData.part = 'pusherTop';
    this.group.add(top);

    // 台面压条：把整块台面切成「落币段 / 输送段 / 出币段」，否则大片单色看不出进度。
    const grooveMaterial = makeToonMaterial({
      name: 'pusherGroove',
      // 抬高明度：色带是乘在 albedo 上的，近黑压条在 toon 下会糊成一片（见 COLORS 的注释）。
      color: '#55685f',
      ramp: 'cabinet',
    });
    //
    // ⚠️ 压条的位置以**落币口**为基准（`drop.z ± 0.34`），所以落币口或背板一动，
    // 最靠后的那一条就可能跑到**背板后面**去（可见背板前平面 = `TABLE.backZ`），
    // 在画面上直接消失 —— 零报错的静默退化。S23 就撞上了：`drop.z = −1.02` 时
    // `drop.z − 0.34 = −1.36` 已经越过 `TABLE.backZ = −1.178`。
    // 所以这里把位置**夹到可见台面区间**里。两端各留 0.02 米是为了不让压条贴到背板/前唇上
    // （贴上去会糊成一条缝，看上去像穿模）。
    const grooveBack = TABLE.backZ + 0.02;
    const grooveFront = TABLE.pusherFrontZAtRest - 0.02;
    for (const z of [TABLE.drop.z - 0.34, TABLE.drop.z + 0.34, TABLE.pusherFrontZAtRest - 0.26]) {
      const grooveZ = Math.min(Math.max(z, grooveBack), grooveFront);
      const groove = new THREE.Mesh(new THREE.BoxGeometry(halfWidth * 2 - 0.06, 0.004, 0.014), grooveMaterial);
      groove.position.set(0, TABLE.pusherTopY + 0.001, grooveZ);
      groove.userData.part = 'pusherGroove';
      this.group.add(groove);
    }

    // 前缘高亮条：把「上层台面的出口」标出来，玩家才能预判币什么时候掉下去。
    // ★ S21：位置**不动** —— 它贴着薄板前缘（= 币真正掉下去的那条边），
    //   下方正是新加的 45° 斜角（`FRONT_CHAMFER`），所以它读作「台面出口的沿口」。
    const lipMaterial = makeToonMaterial({
      name: 'pusherLip',
      color: COLORS.pusherLip,
      ramp: 'accent',
      emissive: COLORS.pusherLip,
      emissiveIntensity: 0.16,
    });
    this.lipMaterial = lipMaterial;
    const lip = new THREE.Mesh(new THREE.BoxGeometry(halfWidth * 2, 0.016, 0.026), lipMaterial);
    lip.position.set(0, TABLE.pusherTopY - 0.004, TABLE.pusherFrontZAtRest - 0.013);
    lip.userData.part = 'pusherLip';
    this.group.add(lip);

    this.buildXixiLanes();
  }

  /**
   * XIXI 四槽标牌：贴在推板**前立面**上的四段内嵌板。
   *
   * 基色填纯白 —— `instanceColor` 是**乘**在材质基色上的，基色若不是白，
   * 后面写进去的亮/灭颜色就永远被压暗一档（这正是「暗色材质 + instanceColor」
   * 最容易踩的坑：调半天颜色都出不来）。
   *
   * ## 为什么是薄 `BoxGeometry` 而不是 `RoundedBoxGeometry`
   *
   * ① 圆角半径在 (0.34, 0.14, 0.014) 这种扁板上会被 `RoundedBoxGeometry`
   * 自动夹到 `min(w,h,d)/2` 再按实例缩放，z 向被压成 1/24，圆角变成一圈怪边；
   * ② 徽章贴图要的是干净的矩形 UV 边界，圆角会把四角切掉一圈纹样。
   * 尺寸直接烘进几何（四段等宽，不再需要逐实例缩放）。
   */
  private buildXixiLanes(): void {
    const geometry = new THREE.BoxGeometry(XIXI_LANE.width, XIXI_LANE.height, XIXI_LANE.depth);
    // 徽章贴图：尺寸按条子的世界比例生成（图标 16 纹素、两侧补底色）。
    const badgeTexels = xixiBadgeSize(XIXI_LANE.width, XIXI_LANE.height);
    this.xixiBadgeTexels = badgeTexels;
    const material = makeToonMaterial({
      name: 'xixiLane',
      color: '#ffffff',
      ramp: 'accent',
      map: createBadgeTexture(XIXI_LANE_ICON, badgeTexels.width, badgeTexels.height),
      // 只给一点点自发光：真正表达「亮/灭」的是 `instanceColor`，
      // 自发光是**共享**的（四段一起亮），给多了会掩盖掉灭的段。
      emissive: COLORS.bounty,
      emissiveIntensity: 0.12,
    });

    const lanes = new THREE.InstancedMesh(geometry, material, XIXI_SEGMENT.centers.length);
    lanes.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // ★ **刻意不挂 `userData.role`。**
    //
    // `applyCabinetSkin` 会遍历整棵树，把有 role 的网格颜色改成机柜配色。
    // 这段标牌的基色必须是**纯白**（`instanceColor` 是乘在它上面的），
    // 被换肤改掉之后亮/灭两档颜色会一起偏色，而且「灭」的段会亮起来 —— 静默错。
    // 它的颜色语义属于玩法（`COLORS.bounty`），不属于机柜配色。
    // 身份照挂：导出工具与 `cabinet` 判据靠 `part` 认件，`applyCabinetSkin` 只看 `role`。
    lanes.userData.part = 'xixiLane';

    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3(1, 1, 1);
    XIXI_SEGMENT.centers.forEach((centerX, slot) => {
      // 四段**等宽无缝**：段宽已烘进几何，这里只摆位置（缩放恒为 1）。
      // 段间距恒等于段宽 ⇒ 既不留缝也不重叠，连成一条 `X I X I` 徽章带。
      position.set(centerX, XIXI_LANE.y, TABLE.pusherFrontZAtRest + XIXI_LANE.depth / 2);
      matrix.compose(position, quaternion, scale);
      lanes.setMatrixAt(slot, matrix);
      lanes.setColorAt(slot, XIXI_LANE_DIM);
    });
    lanes.instanceMatrix.needsUpdate = true;
    if (lanes.instanceColor) lanes.instanceColor.needsUpdate = true;
    this.group.add(lanes);
    this.xixiLanes = lanes;
  }

  /**
   * 写入 XIXI 四槽的亮灭。
   *
   * `flashSlot` / `flashIntensity` 是本次命中的那一段与它的爆闪强度（0~1 递减）。
   * 强度参与颜色插值，所以调用方可以每帧递减来做出「闪一下再落回」的观感。
   *
   * 只在状态真的变了才重传 `instanceColor` —— 这个方法会被 `publishHud()` 每帧调到，
   * 无条件上传等于每帧往 GPU 推一次颜色缓冲。
   */
  setXixiLanes(lit: readonly boolean[], flashSlot = -1, flashIntensity = 0): void {
    if (!this.xixiLanes) return;
    const intensity = Math.max(0, Math.min(1, flashIntensity));
    const changed =
      flashSlot !== this.xixiFlashSlot ||
      Math.abs(intensity - this.xixiFlashIntensity) > 0.01 ||
      lit.some((value, slot) => value !== this.xixiLaneState[slot]);
    if (!changed) return;

    this.xixiLaneState = [...lit];
    this.xixiFlashSlot = flashSlot;
    this.xixiFlashIntensity = intensity;
    const color = new THREE.Color();
    for (let slot = 0; slot < this.xixiLanes.count; slot += 1) {
      color.copy(slot === flashSlot ? LANE_LIT_COLOR : lit[slot] ? LANE_LIT_COLOR : XIXI_LANE_DIM);
      if (slot === flashSlot) color.lerp(XIXI_LANE_FLASH, intensity);
      this.xixiLanes.setColorAt(slot, color);
    }
    if (this.xixiLanes.instanceColor) this.xixiLanes.instanceColor.needsUpdate = true;
  }

  /**
   * 标牌的当前状态（**判据读它，不读截图**）。
   *
   * 「四段里哪几段是亮的」这种缺陷在截图上只表现为「某个角有一块颜色不太对」，
   * 肉眼反推要来回试很多轮；直接读 `instanceColor` 就是一组可枚举的颜色。
   *
   * ## 为什么还要读几何与贴图
   *
   * 「四段是不是等宽无缝铺满 ±0.68」「徽章图标是不是 16 纹素」这两件事在截图上是
   * **看不出来的**（差 3% 的段宽肉眼无感、图标被拉扁一点也像「风格」）。
   * 但它们错了就是错：段宽与 `xixiSlot()` 的分段脱钩 → 亮的槽和玩家瞄准的位置对不上。
   *
   * 读数取的都是**实际几何/实际贴图**，不是再抄一份常量：
   * `segment` 来自 `geometry.boundingBox`，`centers` 来自实例矩阵，
   * 判据因此能抓「改了常量忘了重建几何」这类不同源。
   */
  xixiLaneReport(): {
    count: number;
    colors: string[];
    lit: boolean[];
    /** 四段上画的徽章图标（**身份读数**：抓「贴错图标 / 四段各不相同」）。 */
    badgeIcon: IconId;
    /** 徽章贴图的纹素尺寸。 */
    badgeTexels: { width: number; height: number };
    /** 单段的世界尺寸（来自几何包围盒）。 */
    segment: { width: number; height: number; depth: number };
    /** 四段中心 x（来自实例矩阵）。 */
    centers: number[];
    /** 徽章带的总宽 = 段宽 × 4。 */
    totalWidth: number;
  } {
    const colors: string[] = [];
    const centers: number[] = [];
    const color = new THREE.Color();
    const matrix = new THREE.Matrix4();
    for (let slot = 0; slot < this.xixiLanes.count; slot += 1) {
      this.xixiLanes.getColorAt(slot, color);
      colors.push(`#${color.getHexString()}`);
      this.xixiLanes.getMatrixAt(slot, matrix);
      centers.push(Number(matrix.elements[12].toFixed(6)));
    }

    const geometry = this.xixiLanes.geometry;
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    const box = geometry.boundingBox;
    const segment = box
      ? {
          width: Number((box.max.x - box.min.x).toFixed(6)),
          height: Number((box.max.y - box.min.y).toFixed(6)),
          depth: Number((box.max.z - box.min.z).toFixed(6)),
        }
      : { width: 0, height: 0, depth: 0 };

    return {
      count: this.xixiLanes.count,
      colors,
      lit: [...this.xixiLaneState],
      badgeIcon: XIXI_LANE_ICON,
      badgeTexels: { ...this.xixiBadgeTexels },
      segment,
      centers,
      totalWidth: Number((segment.width * this.xixiLanes.count).toFixed(6)),
    };
  }
}
