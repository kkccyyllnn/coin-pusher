import * as THREE from 'three';
import { InputController, type LaneInput, type LaneMode } from '../core/InputController';
import { Loop } from '../core/Loop';
import { createRenderer, resizeRenderer } from '../core/Renderer';
import { surfaceDetailEnabled } from './artDirection';
import {
  PIXEL_SCALE_DEFAULTS,
  applyPixelated,
  readPixelOverride,
  resolvePixelScale,
  type PixelScale,
  type PixelScaleSettings,
} from '../render/PixelScale';
import { iconReport } from '../render/iconTexture';
import { GBuffer } from '../render/GBuffer';
import {
  FINAL_PASS_SHADOW_RANGE,
  FINAL_PASS_SHADOW_TINT,
  FinalPass,
  readFinalView,
} from '../render/FinalPass';
import { attachGInfoFallback } from '../render/glsl/gbuffer.glsl';
import {
  applyCameraRig,
  cameraRig,
  cameraRigReport,
  fitCameraRig,
  placeCameraRig,
  syncCameraRigAngles,
  toRad,
} from '../render/cameraRig';
import { marqueeScreen } from '../render/marqueeScreen';
import { rampLutCount } from '../render/RampLut';
import {
  makeToonMaterial,
  isLitMaterial,
  rimBreakOf,
  rimStrengthOf,
  type LitMaterial,
} from '../render/ToonMaterial';
import {
  createArcaneHotZoneTexture,
  createArcaneLampHousingTexture,
  createArcaneMarqueeTexture,
  createArcaneRoofSeamTexture,
  createArcaneBackPanelTexture,
  createArcaneScoreLineTexture,
  type ArcanePaletteKey,
} from '../render/cabinetTexture';
import { Coin } from '../entities/Coin';
import { CoinPool } from '../entities/CoinPool';
import { Pusher } from '../entities/Pusher';
import { AudioSystem, type SelectorKey, SELECTORS } from '../systems/AudioSystem';
import { AUDIO_EVENTS, audioEventNames, auditionEvent, findAudioEvent } from '../systems/audioCatalog';
import { CollectionPanel } from '../systems/CollectionPanel';
import { CoinSpray } from '../systems/CoinSpray';
import { DebugTools, createDefaultTuning, type GameTuning } from '../systems/DebugTools';
import { ModelMode } from '../systems/ModelMode';
import { Hud, type MechanismSnapshot } from '../systems/Hud';
import { Mechanisms, MECHANISM_COST } from '../systems/Mechanisms';
import { MechanismShows } from '../systems/MechanismShows';
import { BOOST_OVERFLOW_FALLBACK, ShowDirector, type ShowId } from '../systems/ShowDirector';
import { MotionPrefs } from '../systems/MotionPrefs';
import { PerformanceGovernor, type QualityTier } from '../systems/PerformanceGovernor';
import { PhysicsWorld } from '../systems/PhysicsWorld';
import { RunState } from '../systems/RunState';
import { SaveStore } from '../systems/SaveStore';
import { SlotMachine } from '../systems/SlotMachine';
import {
  applyCabinetSkin,
  buildCabinetShell,
  buildTable,
  disposeCabinetShell,
  FEEDBACK_EMISSIVE,
} from '../systems/TableBuilder';
import type { CabinetSkin } from './cosmetics';
import { Telemetry } from '../systems/Telemetry';
import { RAPIER } from '../systems/PhysicsWorld';
import { createSeededRandom } from '../utils/random';
import { setCoinTexelScale } from '../utils/coinTexture';
import {
  COLORS,
  COIN,
  COIN_KIND,
  COIN_KINDS,
  DRAIN,
  REFILL,
  ENDLESS,
  RULES,
  TABLE,
  baseChips,
  kindSpec,
  type ClimaxTone,
  type CoinKind,
} from './constants';
import { cabinetSkinById, coinSkinById } from './cosmetics';
import {
  CABINET_SHELL_PARTS,
  cabinetPartBox,
  cabinetShape,
  cabinetWallOutline,
  isCabinetOverridden,
  type Box3Like,
} from './cabinetShape';
import { COIN_SCALE } from './coinScale';
import { coinPhysics } from './coinPhysics';
import { BET_TIERS, betTier, crossingReturn, ledgerBalances } from './economy';
import { endlessCapacity, endlessLevel, type EndlessConfig } from './endless';
import { crossingFeedback, FEEDBACK, flyTier, type FeedbackCounts } from './feedback';
import {
  LAYER_STEP,
  MAX_JITTER,
  MIN_SPACING,
  MIN_STEP,
  REST_Y,
  insideDrain,
  isOnDeckVolume,
  layoutSummary,
  layoutValue,
} from './layout';
import {
  SLOT_OUTCOME_KEYS,
  SLOT_OUTCOME_WEIGHTS,
  SLOT_SYMBOL_WEIGHTS,
  SLOT_TIER4_SYMBOLS,
  outcomeTotalWeight,
  outcomeWeightKey,
  reelFacesFor,
  rollSlotOutcome,
  xixiSlot,
  type SlotOutcome,
  type SlotSymbol,
  type SlotTier,
} from './xixi';

/** 高于此高度视为「在途」，收尾时先等它们落到台面。 */
const IN_FLIGHT_Y = 0.55;

/** 选位遥测的采样间隔（秒）。50ms 足够看出速度曲线，又不会把数组撑爆。 */
const LANE_SAMPLE_INTERVAL = 0.05;

/** 自发光闪烁：持续时长与峰值增量。 */
const FLASH_SECONDS = 0.22;
const FLASH_PEAK = 0.85;

/**
 * 落定判定：下坠速度低于此值才算"正在下落"（米/秒）。
 *
 * 取 -0.35 是为了把「真的掉下来」与「被推板/币堆横向挤动」分开——
 * 后者 vy 接近 0，不该发落定音，否则整个币床一被推就会响成一片。
 */
const LANDING_FALL_VY = -0.35;
/** 撞击速度低于此值时算"重撞"（砸进币堆深处），否则是轻触台面。 */
const LANDING_HEAVY_VY = -1.2;

/**
 * XIXI 槽位命中时，推板前缘标牌的爆闪时长（秒）。
 *
 * 比 `FLASH_SECONDS` 长一倍：那个闪的是材质自发光（一眼就能看到），
 * 这个闪的是推板立面上一块 12 厘米高的实例颜色，短了会读不出来。
 */
const XIXI_FLASH_SECONDS = 0.45;

/**
 * 编排层：持有世界、实体与规则，按固定顺序推进。
 *
 * 更新顺序：输入意图 → 固定步长物理 → 通道/出口事件 → 得分与返币 → 胜负状态 → HUD。
 */
export class Game {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(42, 1, 0.05, 40);
  /**
   * G1 通道复用：场景**先**渲染进这块 MRT（附件 0 = 颜色 + 面 ID，附件 1 = 深度 / 线宽），
   * 再由 `finalPass` 补上色调映射与 sRGB 编码出画。
   *
   * 尺寸跟着**内部分辨率**（`pixelScale.internalWidth/Height`）走，在
   * `applyPixelScale()` 里同步 —— 与 backing store 不一致会让最后一遍做一次非整数缩放。
   * 初值 1×1 只是占位：字段初始化必须早于第一次 `applyPixelScale()`（它在构造函数里就被调用）。
   */
  private readonly gbuffer = new GBuffer(1, 1);
  private readonly finalPass = new FinalPass();
  /** `?view=depth` / `?view=id`：把附件直接摊成灰度看，判描边阈值前的前置观测。 */
  private readonly finalView: number = readFinalView(window.location.search);
  private readonly hud = new Hud();
  private readonly audio = new AudioSystem();
  /**
   * UI 点击音。
   *
   * 用**事件委托**挂在 document 上，而不是给每个按钮单独绑：按钮分散在
   * `Hud`（静态）与 `CollectionPanel`（图鉴卡片，运行时才创建）两处，
   * 逐个绑既容易漏、又要给两个类都塞一份音频依赖。委托一行覆盖全部。
   */
  private readonly onDocumentClick = (event: MouseEvent): void => {
    const target = event.target as Element | null;
    if (!target?.closest?.('button')) return;
    // 调试面板里的按钮不发声：那是调试操作，不是玩法输入。试听按钮本身已经够响了，
    // 再叠一声 UI 点击只会干扰判断。
    if (target.closest('.lil-gui')) return;
    this.audio.uiClick();
  };
  private readonly save = new SaveStore();
  private readonly tuning: GameTuning = createDefaultTuning();
  /** 上一次已逐枚施加到币上的物理参数指纹，避免 `applyTuning` 每次都遍历 700 枚币。 */
  private appliedCoinPhysics = '';
  private readonly loop: Loop;

  private readonly physics: PhysicsWorld;
  private readonly coins: CoinPool;
  private readonly pusher: Pusher;
  /** 三个机关：扫板 / 抓斗 / 后装填（P7 起风险转轮已删除）。 */
  private readonly mechanisms: Mechanisms;
  /**
   * 机关构件（R5）：扫板的横扫臂与抓斗的爪。
   *
   * 与 `ShowDirector` 分开持有：那边管「庄家发币」的投放演出（有队列、有承诺数、
   * 中止时不补发），这边只是**玩家当场花钱买的机关**的交付动画（无队列、中止前先把货给完）。
   * 两者的中止语义**相反**，合成一个类迟早会在注释里打架。
   */
  private readonly mechanismShows: MechanismShows;
  private readonly shows: ShowDirector;
  /**
   * 纯视觉币通道（S16）：喷泉演出时从机柜顶部溢流口喷出去、飞到机柜外的筹码。
   *
   * **它不是「另一个币池」**：没有刚体、不进账本、不进 `processOutcomes`。
   * 持有在 `Game` 而不是 `ShowDirector` 上，是因为在飞的币必须活过演出本身
   * （`TimedShow.dispose()` 会把自己挂的 Mesh 全拆掉，装置一结束币就没了）。
   */
  private readonly spray: CoinSpray;
  private readonly slotMachine: SlotMachine;
  /**
   * XIXI 四槽亮灭（P5）。**不进 RunState**：它是跨局持续的收集进度
   * （存档 `coin-pusher:save:v4` 的 xixi 字段），每局重置的是账本，不是收集线。
   */
  private xixi: boolean[];
  /** 集齐时老虎机正在转：排队一次，转完补摇（集齐奖励不允许被吞）。 */
  private pendingXixiSpin = false;
  private readonly input: InputController;
  private readonly debugTools: DebugTools;
  private readonly governor = new PerformanceGovernor();
  /**
   * 像素分辨率的求解入参（V1）。
   *
   * **真源是 `tuning.pixelTargetHeight` / `tuning.pixelated`**（调参面板与画质分档都写它），
   * 这个对象只是每帧同步一次的稳定容器——避免每帧分配，也让 `resolvePixelScale` 是纯函数。
   */
  private readonly pixelSettings: PixelScaleSettings = { ...PIXEL_SCALE_DEFAULTS };
  /** 由 CSS 尺寸与 `pixelSettings` 解出的当前内部渲染尺寸（诊断与截图断言要读）。 */
  private pixelScale: PixelScale = resolvePixelScale(1, 1, PIXEL_SCALE_DEFAULTS);
  private readonly collection: CollectionPanel;
  private readonly telemetry = new Telemetry();
  private drainRecorded = false;
  private tableGroup: THREE.Group | null = null;
  /**
   * 机柜外壳那一具（S24）。
   *
   * 只有 `?model` 模型模式会碰它 —— 那是唯一允许「参数改了就整具换掉」的部件。
   * 非 `?model` 下它只是个长期不动的引用，零成本。
   */
  private cabinetShell: THREE.Group | null = null;
  /** 模型模式（`?model`）。非该模式下为 null。 */
  private modelMode: ModelMode | null = null;
  /** 钉阵长度信息：网格长度是显示值，碰撞体长度是物理值，刻意不同。 */
  private readonly pegs = { count: 0, colliderHalfLength: 0, visualHalfLength: 0 };
  /** 选位遥测：上一帧的模式与采样计时。 */
  private lastLaneMode: LaneMode = 'auto';
  private laneSampleTimer = 0;
  /** 最近一帧的输入意图，供诊断对象读取（选位模式、落点）。 */
  private lastIntent: LaneInput | null = null;
  /** 落币口材质：投币时闪一下。 */
  private spitterMaterial: LitMaterial | null = null;
  /** 正在衰减的自发光闪烁（材质 → 基准强度与剩余时间）。 */
  private readonly flashes = new Map<LitMaterial, { base: number; life: number }>();
  /** XIXI 命中爆闪：命中的槽位与剩余时间（写的是推板标牌的 `instanceColor`）。 */
  private xixiFlashSlot = -1;
  private xixiFlashTimer = 0;

  private run: RunState;
  private readonly config: EndlessConfig;
  /** 本局的跪求次数。 */
  private begsThisRun = 0;
  /** 破产弹窗是否正在显示。 */
  private ruinVisible = false;
  /** 结算卡片是否正在显示。 */
  private summaryVisible = false;
  /** 加注档位下标（0 = 1 投 · ×1）。 */
  private betIndex = 0;
  /** 热区高亮条与它当前的世界 x（无尽恒开，见 EndlessConfig.hotZone）。 */
  private hotZoneStrip: THREE.Mesh | null = null;
  private hotZoneX = 0;
  private hotZoneDir: 1 | -1 = 1;
  /**
   * 得分反馈的三个衰减量（P10 ⑨），取值 0~1，每帧按固定速率落回 0。
   *
   * 用**一个 0~1 的标量 + 线性衰减**而不是三条 CSS/`setTimeout` 动画：
   * 它们要驱动的都是 3D 材质的 `emissiveIntensity`，而那个值必须**每帧连续**——
   * 交给 DOM 动画就会出现「暂停时特效还在跑」（渲染循环停了、动画没停），
   * 而暂停是全局约定（`paused` 冻结一切）。挂在 `update()` 上天然与它一致。
   */
  private scoreLinePulse = 0;
  private hotZoneFlash = 0;
  private drainFlashLevel = 0;
  /** 三个反馈材质的引用（P10 ⑨）：脉冲直接改 `emissiveIntensity`。 */
  private scoreLineMaterial: LitMaterial | null = null;
  private hotZoneMaterial: LitMaterial | null = null;
  /** 洞口闪光走的是**排水口格栅**自己的自发光（不另建网格，见 `TableBuild`）。 */
  private drainGrateMaterial: LitMaterial | null = null;
  /**
   * 反馈计数（判据读它，**不读截图**）。
   *
   * 「连落 3 有没有真的脉冲」「热区命中是不是真的走了一条不同的路」这类问题
   * 在截图上只能靠肉眼反推；分成几档、各发生了几次是可枚举的事实。
   * 计数与视觉**同源**：两个都在 `settleCrossing` 里、由同一个
   * `crossingFeedback()` 结果驱动，所以计数不会和画面分叉。
   */
  private readonly feedbackCounts: FeedbackCounts = {
    flyNormal: 0,
    flyBig: 0,
    comboPulse: 0,
    comboClimax: 0,
    hotHit: 0,
    drainFlash: 0,
  };
  private rng = createSeededRandom(1);
  private seedOverride: number | null = null;

  private frame = 0;
  private elapsed = 0;
  private dropCooldown = 0;
  private paused = false;
  private pausedForScreenshot = false;
  /** 动效偏好：系统媒体查询 + 测试覆盖，CSS 与 JS 共用同一个信号。 */
  private readonly motion = new MotionPrefs();
  private restTimer = 0;
  private settleWindow = 0;
  private anomalyCount = 0;
  /**
   * 掉进币床前侧角下水道的币数（P10 的「汇」，见 `DRAIN`）。
   *
   * **它和 `anomalyCount` 是两件事**：排水是设计好的合法损失，异常是缺陷。
   * 两者都让盘面少一枚币，所以判据必须分开读——混在一起就再也分不清
   * 「洞开得太大」和「求解器又把币甩出去了」。
   */
  private drainCount = 0;
  /**
   * 自动补币（P10 ⑦）：本局已触发的补货次数、冷却计时、盘点计时与最近一次读数。
   *
   * `bedCoins` 每 `REFILL.checkEvery` 秒刷一次（不是每帧），诊断直接发布它——
   * 所以**它是「上一轮盘点」的值，不是当帧值**。判据要读它就得先等一个盘点周期，
   * 否则会读到补币前的旧值而误判成「补币没生效」。
   */
  private refillCount = 0;
  private refillCooldown = 0;
  private refillTimer = 0;
  private bedCoins = 0;
  /**
   * 最近几次「异常」发生时那枚币在哪。诊断用，最多留 12 条。
   *
   * **异常币会被立刻 `despawn()`**，所以事后再看盘面是看不到它们的
   * （实测：`coins()` 里已经查不到任何越界币，只留下一个变小的 `activeCoins`）。
   * 「异常 = 币飞出机柜」这条判据必须能说出**它从哪儿出去的、当时多快**，
   * 否则只剩一个计数，等于没有信息。
   */
  private anomalySamples: Array<{
    frame: number;
    kind: string;
    x: number;
    y: number;
    z: number;
    vx: number;
    vy: number;
    vz: number;
    speed: number;
  }> = [];
  /**
   * 速度护栏的遥测（见 `COIN.maxSpeed` 的注释）。
   *
   * 存在的意义是**让修法本身可被检验**：如果只压速度、不留数，那么「求解器还在不在
   * 造能量」就重新变成不可见——币不再飞出机柜，缺陷却还在，只是被盖住了。
   * 这两个数让判据可以问一个更准的问题：不是「有没有币飞出去」（被围板挡住之后
   * 必然为 0，什么都说明不了），而是「**还有没有能量注入**」。
   */
  private spikeClamps = 0;
  private peakSpikeSpeed = 0;
  /**
   * 泄流律压完之后剩下的**向上**速度峰值（R4-P3 的「只减不增」判据）。
   * 与 `peakSpikeSpeed` 成对：那条是截断前总速率，这条是截断后向上分量。
   * 只有前者时「律不造能量」只能靠 `anomalies === 0` 间接推断。
   */
  private peakPostClampUpward = 0;
  /** 本局累计越线枚数（遥测用：节奏测量不能被热度倍率污染）。 */
  private settledCoins = 0;
  private drainPromptVisible = false;
  private readonly laneMarker = new THREE.Group();
  /**
   * 镜头基准位置（`fitCamera()` 按取景算出来的）。
   *
   * ★ S16 起相机**完全静止**：这里原先叠加过两路运动（中币的镜头抖动、
   * 推板前推时的 2 毫米台面微震），两者都已按用户要求删除。
   * 现在 `cameraBase` 只作为 `trackCameraOffset()` 的比较基准存在。
   */
  private readonly cameraBase = new THREE.Vector3();
  /**
   * 相机偏离基准位置的**峰值**（米），本局内取最大值。
   *
   * 存在的理由：S16 里用户先后要求删掉相机上的两路运动（中币的镜头抖动、
   * 推板前推时的 2 毫米台面微震），而那是一个**只能靠逐帧观测发现的静默回归** ——
   * 有人把它加回来时，截图看不出来（抖的是运动，静止帧完全一样），
   * 而 `camera.position` 也不在诊断快照里。
   * 所以这里把峰值记下来，`feedbackReport()` 交出去给判据断言**恒为 0**。
   */
  private cameraPeakOffset = 0;
  /** S18：单帧 draw call 峰值，cabinet-tex 模式拿来对位 perf 上限。 */
  private rendererPeakDrawCalls = 0;
  /**
   * G1 之后一帧有**两遍** `renderer.render()`（场景 → MRT，再最后一遍出画），
   * 而 `renderer.info` 每次 render() 开头自己清一次 ⇒ 帧末直接读只剩最后一遍。
   * 所以这里分开记：
   * - `sceneDrawCalls`：场景那一遍，**与 G1 之前完全同口径**（three 的 `info.reset()`
   *   排在 `shadowMap.render()` 之后，阴影 pass 从来不计入 —— 见 `core/Renderer.ts` 的警告）。
   * - `frameDrawCalls`：两遍合计，才是这一帧真正的绘制调用数。判据读的是这个。
   */
  private sceneDrawCalls = 0;
  private frameDrawCalls = 0;
  /** 同上，三角形数。两遍出画之后 `info.render.triangles` 也只剩最后一遍的 2 个。 */
  private sceneTriangles = 0;
  private frameTriangles = 0;

  private constructor(canvas: HTMLCanvasElement, physics: PhysicsWorld) {
    this.physics = physics;
    this.renderer = createRenderer(canvas);
    this.renderer.toneMappingExposure = this.tuning.exposure;

    // ★ 币面分辨率倍率必须在**建币池之前**写进全局 —— `CoinPool` 构造时就按
    // `coinTexels()` 把六种币的贴图烘出来了，晚一步设就是「第一局还是糊的」。
    setCoinTexelScale(this.tuning.coinTexelScale);

    this.input = new InputController(
      canvas,
      this.getElement('#drop-button'),
      this.getElement('#boost-button'),
      this.getElement('#giveup-button'),
      this.getElement('#sweeper-button'),
      this.getElement('#grapple-button'),
      this.getElement('#reload-button'),
      this.getElement('#bet-button'),
    );

    this.coins = new CoinPool(physics.world);
    this.pusher = new Pusher(physics.world);
    this.mechanisms = new Mechanisms(this.coins);
    // 视觉币的材质与币池的铜币材质同源（`createCoinMaterial('bronze', skin)`），
    // 所以这里用币池当前的外观初始化，之后每次换肤都要跟着换（见 `applyCoinSkin` 调用点）。
    this.spray = new CoinSpray(this.coins.currentSkin);
    this.shows = new ShowDirector({
      coins: this.coins,
      // R4-4b：塔的柱顶要上真碰撞（kinematic 圆柱），所以演出系统现在拿着物理世界。
      // 只有 `TowerShow` 用它建刚体，其余装置照旧纯视觉（见 `ShowDeps.world` 的注释）。
      world: physics.world,
      telemetry: this.telemetry,
      notify: (message) => this.announce(message),
      now: () => this.elapsed,
      rng: () => this.rng(),
      reducedMotion: () => this.motion.reduced,
      spray: this.spray,
    });
    this.mechanismShows = new MechanismShows({
      mechanisms: this.mechanisms,
      reducedMotion: () => this.motion.reduced,
    });
    this.slotMachine = new SlotMachine({
      shows: this.shows,
      telemetry: this.telemetry,
      notify: (message) => this.announce(message),
      now: () => this.elapsed,
      rng: () => this.rng(),
      reducedMotion: () => this.motion.reduced,
      grantBoost: () => this.run.grantBoost(),
      onBoostReady: () => this.audio.boostReady(),
      // 胡萝卜四连的罚款（S5b 两步）：实扣那一截走 `RunState.fineChips` → `spendChips`
      // （唯一扣减入口，另记 `fines` 供对账）；扣不掉的 shortfall 交给
      // `SaveStore.chargeFine` 转成欠款。**两笔都不新增恒等式项**：
      // `spent` 吸收实扣，`debt` 是未来产出的分流承诺、不是余额的进出。
      fineChips: (amount) => this.run.fineChips(amount),
      chargeFine: (shortfall) => {
        const applied = this.save.chargeFine(shortfall);
        // 欠款行要当场改文案：惩罚发生在滚筒停格那一刻，等下一帧 publishHud 也来得及，
        // 但 HUD 的 debt 行只在显式调用时才重算 —— 不推就是「罚了款而债没动」的假象。
        this.publishHud();
        return applied;
      },
      /** S5a 四同「力」：排 N 发连续加长行程（与玩家按钮的「去重一发」是两个动作）。 */
      jackpotPush: (strokes) => this.pusher.queueJackpotPush(strokes),
      /** S5a 四同的闪色：复用越线反馈那条**同一个** `triggerClimax`，不另开一条闪光通道。 */
      climax: (tone) => this.triggerClimax(tone),
      onReveal: (outcome) => this.audio.slotReveal(outcome.kind),
      // 转动的机械声要覆盖整段转动（3.4~4.0 秒），所以把时长传下去让音效排程。
      onSpinStart: (seconds) => this.audio.slotSpin(seconds),
    });
    // XIXI 进度从存档恢复：跨局持续，破产不清零。
    this.xixi = [...this.save.snapshot.xixi];

    // ── 模型模式（S24）──
    //
    // ★ 必须在 `buildTable()` **之前**构造：它在构造函数里调
    // `beginCabinetOverride()`，而 `buildTable()` 建外壳时读的就是那份覆盖。
    // 顺序反了的表现是「刷新之后造型弹回默认、得再动一次滑块才回来」——
    // 因为第一具外壳读到的是编译期默认值。
    this.modelMode = new ModelMode(this.camera, this.renderer.domElement, {
      rebuild: () => this.rebuildCabinetShell(),
      applyCamera: () => this.applyCameraRigFromPanel(),
    });
    if (this.modelMode.enabled) {
      // 模型模式下机位归用户。不交出所有权的话，改窗口尺寸 / FOV 会被
      // `fitCamera()` 弹回默认视角 —— 就是面板上「改了没用」的那个老坑。
      this.tuning.cameraAutoFit = false;
    }

    const table = buildTable(physics.world);
    /* R4-P2：弹性合并规则统一成 Min，且**必须在台面建完之后**扫。
       币池（`:396`）与推板（`:397`）比这一步早，台面是最后一批，所以这一扫覆盖全部。
       放在 `buildTable` 之前会漏掉整层台面 + 钉子 + 围板。 */
    physics.applyRestitutionCombineRule();
    // S24：外壳单独留一份引用 —— `?model` 模型模式要能把它整具拆掉重建。
    // 台面 / 钉子 / 推板都与碰撞体绑定，**不参与**热重建（用户明确要求不动碰撞边界）。
    this.cabinetShell = table.cabinetShell;
    // ★ 必须在这里把首具外壳绑给模型模式。
    //
    // 漏了这一步的表现是：面板一切正常、数值一切正常，**但选中件不高亮**
    // —— 因为 `ModelMode.shell` 还是 null，`findMesh()` 直接返回 null。
    // 这个缺陷靠截图是发现不了的（1 像素的线在构图上本来就看不清），
    // 是 `modelModeOutlineCount()` 把它抓出来的。
    this.modelMode.attach(table.cabinetShell);
    this.pegs.count = table.pegCount;
    this.pegs.colliderHalfLength = table.pegColliderHalfLength;
    this.pegs.visualHalfLength = table.pegVisualHalfLength;
    this.hotZoneStrip = table.hotZoneStrip;
    this.scoreLineMaterial = table.scoreLineMaterial;
    this.hotZoneMaterial = table.hotZoneMaterial;
    this.drainGrateMaterial = table.drainGrateMaterial;

    this.debugTools = new DebugTools(
      physics.world,
      this.tuning,
      () => this.applyTuning(),
      {
        onRefillWallet: () => {
          this.save.refillWallet(100);
          this.publishHud();
          this.hud.setStatus(`已充值 100 筹码，当前钱包：${this.save.balance}`);
        },
        onClearSave: () => {
          this.save.clear();
          this.xixi = [...this.save.snapshot.xixi];
          this.collection.refresh();
          this.applySkins();
          this.publishHud();
          this.hud.setStatus('已重置本地存档');
        },
        onCoinTexelChange: () => {
          this.applyCoinResolution();
        },
        // 10-01 画质锁：手动改像素目标高度 = 人工意图 ⇒ 顺手锁上，别让它被下一次降档覆盖。
        onQualityManualChange: () => {
          if (this.governor.isFrozen) return;
          this.setQualityLock(true);
        },
        // S22：面板动完机位 → 只摆相机，不走 `applyTuning()`（那会顺带遍历 700 枚币）。
        onCameraChange: () => {
          this.applyCameraRigFromPanel();
        },
      },
      // 调试面板的音效试听/上传挂载需要它（只有 `?debug` 时才会用到）。
      this.audio,
    );

    this.config = endlessLevel();
    // 占位实例：**真正的那一局是在构造函数末尾的 `startRun()` 里创建的**，
    // 那一次才把 `initial` 快照成当时的余额。
    // ⚠️ S4 合并账户之后这里没有「扣两份买入」的风险了（买入这个动作已经消失），
    // 但占位实例仍然必须在同一次构造里被换掉：它的 `initial` 是构造那一刻的余额，
    // 留着不用就是拿着一个过期的起点去记账。
    // 这个实例在同一次构造里就被 `startRun()` 换掉，中间不会有任何一帧跑在它上面。
    this.run = new RunState(this.save);

    this.buildScene(table.group);
    this.hud.bindPauseToggle(() => this.togglePause());
    this.hud.bindQualityToggle(() => this.setQualityLock(!this.governor.isFrozen));
    this.hud.setQualityLock(false, this.governor.current.tier);
    this.hud.bindRuinActions(
      () => this.begForChips(),
      () => this.endRun(),
      () => this.loanToContinue(),
    );
    // UI 点击音（事件委托，见 `onDocumentClick` 的注释）。
    document.addEventListener('click', this.onDocumentClick);

    this.collection = new CollectionPanel(
      this.save,
      ({ coinSkin, cabinetSkin }) => {
        this.coins.applyCoinSkin(coinSkin);
        if (this.tableGroup) applyCabinetSkin(this.tableGroup, cabinetSkin);
        applyCabinetSkin(this.pusher.group, cabinetSkin);
        // S18：Arcane 风贴图走 `map` 通道，挂在得分线 / 热区 / 招牌上；
        // 切肤时只能重生成贴图并 swap 进材质（材质 instance 仍是同一份 ⇒ 不涨程序）。
        this.applyCabinetMapTextures(cabinetSkin);
        this.hud.setStatus(`已换装：${coinSkin.name} · ${cabinetSkin.name}`);
      },
    );
    this.applySkins();

    this.loop = new Loop(
      (delta) => this.update(delta),
      () => this.render(),
    );

    // `?pixel=off` / `?pixel=2` 覆盖默认像素档（A/B 对比观感、真机调试用）。
    // 数字是**显式倍率**（1 = 原生、2 = 半像素），不是目标高度——目标高度会被整数化吞掉。
    // 数字档还会顺带打开最近邻：写 `?pixel=2` 的意图是「看像素风」，只降分辨率不换采样是半条路径。
    // 注意：它只改**初始值**——画质分档真的换档时仍由 `applyQuality` 接管
    // （换档要连续 2 个低帧窗口或 6 个高帧窗口，正常一局里不会发生）。
    const pixelOverride = readPixelOverride(window.location.search);
    if (pixelOverride.pixelated !== undefined) this.tuning.pixelated = pixelOverride.pixelated;
    if (pixelOverride.upscaleOverride !== undefined) {
      this.pixelSettings.upscaleOverride = pixelOverride.upscaleOverride;
    }
    this.applyPixelScale();
    this.fitCamera();
    this.startRun();
    this.installTestHooks();
    this.publishDiagnostics();
  }

  static async create(canvas: HTMLCanvasElement): Promise<Game> {
    const physics = await PhysicsWorld.create();
    return new Game(canvas, physics);
  }

  start(): void {
    this.loop.start();
  }

  dispose(): void {
    this.loop.stop();
    document.removeEventListener('click', this.onDocumentClick);
    this.input.dispose();
    this.audio.dispose();
    this.debugTools.dispose();
    this.coins.dispose();
    this.mechanismShows.dispose();
    // 视觉币通道（S16）：它自带一份圆柱几何与一份材质，**不是**币池的资源，
    // 所以要单独释放 —— 漏了这一行会在重开游戏时漏掉几何体与一张贴图。
    this.spray.dispose();
    // G1 的两遍出画资源：MRT 是**显式分配**的 GPU 纹理（两张附件 + MSAA 缓冲），
    // 不释放就是重开一局漏一整帧的显存 —— 这类泄漏 `renderer.info` 看不出来。
    this.gbuffer.dispose();
    this.finalPass.dispose();
    this.renderer.dispose();
    window.__THREE_GAME_DIAGNOSTICS__ = undefined;
    window.__THREE_GAME_TEST_HOOKS__ = undefined;
  }

  // ── 每帧 ────────────────────────────────────────────────────────────────

  private update(delta: number): void {
    this.frame += 1;
    if (this.pausedForScreenshot) {
      this.publishDiagnostics();
      return;
    }

    if (this.applyPixelScale()) this.fitCamera();

    if (this.paused) {
      this.publishDiagnostics();
      return;
    }

    this.elapsed += delta;
    this.run.tick(delta);
    this.dropCooldown = Math.max(0, this.dropCooldown - delta);

    const intent = this.input.sample(delta);
    this.lastIntent = intent;
    this.handleIntent(intent);
    this.recordLaneTelemetry(intent, delta);

    this.physics.step(delta, (fixedDt) => this.fixedUpdate(fixedDt));

    this.coins.syncAll();
    this.processOutcomes();
    this.updateRunState(delta);
    this.updateRefill(delta);
    this.laneMarker.position.x = intent.laneX;
    this.updateHotZone(delta);
    this.updateFeedbackVisuals(delta);
    this.updateFlashes(delta);
    this.updateXixiFlash(delta);
    this.shows.update(delta);
    // ★ 大奖演出期间推板停在回收位，动画播完再接着推（用户口径）。
    //
    // 除了「演出期间不该同时有两股推动」这条体验理由，实测还有第二条：
    // 推板不按住时，它把新spawn出来的塔币往柱体上挤 —— 同一场 16 枚的塔，
    // 速度护栏从 **0 次** 变成 **39 次、峰值 13.7 米/秒**（`show` 模式 P3 判据的读数，
    // 变异测试时顺手量到的）。所以这条不是纯观感开关，它同时是一条**注入路径的闸门**。
    //
    // 每帧都调而不是只在 busy 翻转时调：`park` / `resume` 都是幂等的，
    // 而只在翻转时调会漏掉「演出还在、中途 `startRun` 重启了推板」这条路
    // （`start()` 会清掉 parked，若这里不重新按下去，推板就在演出里推完了整程）。
    if (this.shows.busy) this.pusher.park();
    else this.pusher.resume();
    this.mechanismShows.update(delta);
    // 视觉币自己积分（没有 Rapier 刚体）。放在演出之后：演出这一帧刚喷出来的币
    // 当帧就动起来，不会出现「先停一帧再飞」。
    this.spray.update(delta);
    this.slotMachine.update(delta);
    if (this.pendingXixiSpin && this.slotMachine.spin()) this.pendingXixiSpin = false;
    this.trackCameraOffset();
    if (this.governor.sample(delta)) this.applyQuality();
    this.debugTools.update();
    this.publishHud();
    // 招牌屏的推进放在**循环**里而不是 `publishHud()`：后者还有六个来自测试钩子
    // 与重置流程的调用点，那些地方没有 delta，也不该被当成过了帧。
    // 常态行留空（用户批注：不要「无尽 · xixi 大王大赏」这行字）。
    // 屏上只在该有内容时出字：账本一行 + 开奖/机关字幕，平时不拿机器名去占第二行。
    marqueeScreen().tick(delta, '');
    this.publishDiagnostics();
  }

  /**
   * 一次性自发光闪烁。
   *
   * 动效只放大**物理已经发生的事**：投币闪落币口、加力闪推板前缘。
   * 不伪造结果，也不改任何数值。降动效时整段跳过。
   */
  private flash(material: LitMaterial | null, base: number): void {
    if (!material || this.motion.reduced) return;
    this.flashes.set(material, { base, life: FLASH_SECONDS });
    material.emissiveIntensity = base + FLASH_PEAK;
  }

  private updateFlashes(delta: number): void {
    if (this.flashes.size === 0) return;
    for (const [material, state] of this.flashes) {
      state.life -= delta;
      if (state.life <= 0) {
        material.emissiveIntensity = state.base;
        this.flashes.delete(material);
      } else {
        material.emissiveIntensity = state.base + FLASH_PEAK * (state.life / FLASH_SECONDS);
      }
    }
  }

  /**
   * 选位遥测。
   *
   * 「自动选位是否匀速」「手动接管与恢复是否跳变」这两条不能靠外部按帧采样判定
   * （采样间隔会漏掉切换当帧），所以由模拟内部记录：每 50ms 一个采样点，
   * 模式切换时额外记一个事件点。
   */
  private recordLaneTelemetry(intent: LaneInput, delta: number): void {
    if (!this.telemetry.active) return;
    if (intent.mode !== this.lastLaneMode) {
      this.telemetry.recordLaneEvent(
        this.elapsed,
        intent.laneX,
        intent.mode,
        intent.mode === 'manual' ? 'enter' : 'resume',
      );
      this.lastLaneMode = intent.mode;
    }
    this.laneSampleTimer += delta;
    if (this.laneSampleTimer >= LANE_SAMPLE_INTERVAL) {
      this.laneSampleTimer = 0;
      this.telemetry.recordLaneSample(this.elapsed, intent.laneX, intent.mode);
    }
  }

  /**
   * 热区：得分线上一段匀速左右扫的亮条，币在其中越线得分翻倍。
   *
   * 和自动选位用同一套三角波（世界坐标匀速 + 反射折返），
   * 所以两个「时机」是同一个节拍，玩家能学会预判它们的交汇。
   */
  private updateHotZone(delta: number): void {
    if (!this.hotZoneStrip) return;
    if (!this.config.hotZone) {
      this.hotZoneStrip.visible = false;
      return;
    }
    this.hotZoneStrip.visible = true;
    const limit = TABLE.drop.halfLane - TABLE.hotZone.halfWidth;
    let x = this.hotZoneX + this.hotZoneDir * TABLE.hotZone.speed * delta;
    if (x > limit) {
      x = 2 * limit - x;
      this.hotZoneDir = -1;
    } else if (x < -limit) {
      x = -2 * limit - x;
      this.hotZoneDir = 1;
    }
    this.hotZoneX = x;
    this.hotZoneStrip.position.x = x;
  }

  /** 这枚币是不是在热区里越的线。 */
  private isInHotZone(x: number): boolean {
    return this.config.hotZone && Math.abs(x - this.hotZoneX) <= TABLE.hotZone.halfWidth;
  }

  /**
   * 高潮反馈：HUD 全屏闪色（连落 ≥ 5 的**白闪**优先于币种自身的色调）。
   *
   * ## ★ S16：这里**去掉了镜头抖动**
   *
   * 用户原话：「现在中币整个画面就会震荡，不要这个震动的动画」。
   *
   * 原先这个方法里还有一句 `this.shake = Math.max(this.shake, strength)`，
   * 由 `applyCameraShake` 换算成 `strength² × 0.055` 米的相机位移 ——
   * 强度 1 的币种（大赏 / 钻石 / 宝箱）一越线，**整个画面就跳 5.5 厘米**。
   * 现在「中币」的反馈只剩 HUD 闪色与三个 3D 自发光脉冲，相机一动不动。
   *
   * `feedback.climax.strength` 这个字段**保留**：它是分级结果的公开契约
   * （`crossingFeedbackProbe` 的判据核它 —— 「连落白闪的强度是 1」），
   * 只是不再驱动相机。
   */
  private triggerClimax(tone: ClimaxTone): void {
    if (this.motion.reduced) return;
    this.hud.flashClimax(tone);
  }

  /**
   * 三个 3D 反馈的衰减（P10 ⑨）：得分线脉冲 / 热区爆闪 / 洞口闪光。
   *
   * ## 为什么挂在 `update()` 而不是各自起一个动画
   *
   * 它们改的都是材质的 `emissiveIntensity`，那个值必须**每帧连续**。
   * 挂在渲染循环上有两个直接好处：
   * ① 暂停（`paused`）时特效跟着停 —— 暂停是全局约定，DOM 动画不会遵守它；
   * ② 峰值/基线全部读 `FEEDBACK_EMISSIVE`（`TableBuilder` 的同一份常量），
   *    所以「脉冲回到基线」是精确的，不会因为浮点残留让得分线一直偏亮。
   *
   * 衰减速率取 `delta * 4.5`：约 0.22 秒落回，比一次飞字（0.42 秒）短——
   * 反馈要**跟着因果**走，比币本身还慢的话就变成了背景噪声。
   */
  private updateFeedbackVisuals(delta: number): void {
    const decay = delta * 4.5;

    if (this.scoreLinePulse > 0) {
      this.scoreLinePulse = Math.max(0, this.scoreLinePulse - decay);
      if (this.scoreLineMaterial) {
        this.scoreLineMaterial.emissiveIntensity =
          FEEDBACK_EMISSIVE.scoreLineBase +
          (FEEDBACK_EMISSIVE.scoreLinePeak - FEEDBACK_EMISSIVE.scoreLineBase) * this.scoreLinePulse;
      }
    }
    if (this.hotZoneFlash > 0) {
      this.hotZoneFlash = Math.max(0, this.hotZoneFlash - decay);
      if (this.hotZoneMaterial) {
        this.hotZoneMaterial.emissiveIntensity =
          FEEDBACK_EMISSIVE.hotZoneBase +
          (FEEDBACK_EMISSIVE.hotZonePeak - FEEDBACK_EMISSIVE.hotZoneBase) * this.hotZoneFlash;
      }
    }
    if (this.drainFlashLevel > 0) {
      // 洞口闪得比另外两个慢一档：它要表达的是「掉了」，需要多停一会儿才读得到。
      // 基线与峰值同取 `FEEDBACK_EMISSIVE`：格栅平时是 0（不发光的黑铁），
      // 所以这里是纯乘，回落到 0 就是真的回到不发光的常态。
      this.drainFlashLevel = Math.max(0, this.drainFlashLevel - delta * 2.6);
      if (this.drainGrateMaterial) {
        this.drainGrateMaterial.emissiveIntensity =
          FEEDBACK_EMISSIVE.drainPeak * this.drainFlashLevel;
      }
    }
  }

  /** 反馈计数 + 三个材质的**实时**自发光（判据读它：计数与画面必须同源）。 */
  private feedbackReport(): {
    counts: FeedbackCounts;
    emissive: { scoreLine: number; hotZone: number; drainFlash: number };
    /** 本局相机偏离基准位置的峰值（米）。相机已完全静止（S16），它应当恒为 0。 */
    cameraPeakOffset: number;
  } {
    return {
      counts: { ...this.feedbackCounts },
      emissive: {
        scoreLine: round3(this.scoreLineMaterial?.emissiveIntensity ?? 0),
        hotZone: round3(this.hotZoneMaterial?.emissiveIntensity ?? 0),
        drainFlash: round3(this.drainGrateMaterial?.emissiveIntensity ?? 0),
      },
      cameraPeakOffset: round3(this.cameraPeakOffset),
    };
  }

  /**
   * 相机偏移记账（每帧，**不移动相机**）。
   *
   * ## ★ 相机现在一动不动
   *
   * S16 里这里先后删掉了**两路**相机运动，都是用户要求的：
   * 1. 中币的镜头抖动（`shake² × 0.055` 米，强度 1 时整个画面跳 5.5 厘米）——
   *    「现在中币整个画面就会震荡，不要这个震动的动画」；
   * 2. 推板前推时的 2 毫米台面微震（`sin(elapsed × 92) × 0.002`）—— 「微震也去掉」。
   *
   * 现在 `fitCamera()` 把位置同时写进 `camera.position` 与 `cameraBase` 之后，
   * **再没有任何代码改过相机位置**。这个方法是那两路删除之后剩下的空壳。
   *
   * ## 为什么空壳也要留着
   *
   * 它只做一件事：把「相机偏离基准位置」的**峰值**记进 `cameraPeakOffset`，
   * 由 `feedbackReport()` 交给判据断言恒为 0。
   *
   * 相机运动是**只能靠逐帧观测发现的静默回归** —— 抖的是运动，
   * 静止截图完全看不出来（`shots` 模式与 `npx playwright test` 的截图断言都抓不到），
   * 而 `camera.position` 也不在诊断快照里。没有这条记账，
   * 以后有人把任何一路抖动加回来都不会被任何判据发现。
   * 实测：改之前这条读数是 **0.055**，删完之后是 **0**。
   */
  private trackCameraOffset(): void {
    this.cameraPeakOffset = Math.max(
      this.cameraPeakOffset,
      Math.abs(this.camera.position.x - this.cameraBase.x),
      Math.abs(this.camera.position.y - this.cameraBase.y),
      Math.abs(this.camera.position.z - this.cameraBase.z),
    );
    this.rendererPeakDrawCalls = Math.max(
      this.rendererPeakDrawCalls,
      // 读**自己按帧累计的那份**，不读 `renderer.info.render.calls`：
      // 两遍出画之后，那个数在帧末只剩最后一遍的 1 次（判据会绿得毫无意义）。
      this.frameDrawCalls,
    );
  }

  /**
   * V2：材质族统计 + 色带数量 + 已编译程序数。
   *
   * 三个用途，都是**只能靠计数发现的静默缺陷**：
   * 1. `toon` 数骤降 = 有人绕过了 `makeToonMaterial()`（裸建材质、或 `clone()` 掉了补丁）——
   *    画面只是「差一点」，肉眼在截图里几乎看不出来。
   * 2. `standard` 应恰好等于币的材质数（V4 之前币仍是标准材质）。
   *    如果机柜类部件还在里面，说明有地方漏改了。
   * 3. `programs` 是首帧编译爆炸的哨兵（风险 R4）：色带补丁的
   *    `customProgramCacheKey` 是常量，所以 toon 材质无论多少个都只该编译 1~2 份程序。
   */
  private materialReport(): Record<string, number> {
    const counts = { toon: 0, standard: 0, basic: 0, other: 0 };
    // V3：按细节种类计数。漏传 `...ROLE_DETAIL.x` 时这里会少一种——
    // 画面只是「少了一点纹样」，肉眼几乎看不出来，所以必须靠计数钉住。
    const detailKinds: Record<string, number> = {};
    // S16：带非零边缘光强度的材质数。**应当恰好 2**（钻石 + 宝箱）。
    //
    // 边缘光的 GLSL 是无条件注入给所有 toon 材质的（为了不新增 define ⇒ 不新增程序变体），
    // 所以「哪几个材质真的有边缘光」这件事**完全由这个数表达**。它是 0 或 3 都说明
    // 参数传错了，而画面上的表现只是「宝石看起来平了一点」——截图判不出来。
    let rim = 0;
    // G0-b 断线的两个读数：开了几个、其中几个是**空转**。
    // 空转 = 传了 `rimBreak` 但这件没有边缘光 —— 掩码乘在 0 上，零视觉变化，
    // 而面板/判据上都显示「断线开了」。这就是「以为开了其实没开」，只能数出来。
    let rimBreak = 0;
    let rimBreakIdle = 0;
    const seen = new Set<THREE.Material>();
    this.scene.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      const list = Array.isArray(child.material) ? child.material : [child.material];
      for (const material of list) {
        if (seen.has(material)) continue;
        seen.add(material);
        if (material instanceof THREE.MeshToonMaterial) {
          counts.toon += 1;
          const kind = String(material.defines?.SD_DETAIL_KIND ?? '?');
          detailKinds[kind] = (detailKinds[kind] ?? 0) + 1;
          if (rimStrengthOf(material) > 0) rim += 1;
          if (rimBreakOf(material) > 0) {
            rimBreak += 1;
            if (rimStrengthOf(material) === 0) rimBreakIdle += 1;
          }
        } else if (material instanceof THREE.MeshStandardMaterial) counts.standard += 1;
        else if (material instanceof THREE.MeshBasicMaterial) counts.basic += 1;
        else counts.other += 1;
      }
    });
    const flattened: Record<string, number> = { ...counts, ...detailKinds, rim, rimBreak, rimBreakIdle };
    flattened.total = seen.size;
    flattened.ramps = rampLutCount();
    flattened.programs = this.renderer.info.programs?.length ?? 0;
    // 肌理总开关的读数（1 = on）。判据靠它决定「该不该有纹样」——
    // harness 里再抄一个 `false` 就是第二份真源，翻开关的人不会记得改，判据会静默反向。
    flattened.detailEnabled = surfaceDetailEnabled() ? 1 : 0;
    return flattened;
  }

  /**
   * G3-a：回读附件 0，量面 ID 的**可分差**（描边阈值的地基）。
   *
   * ## 为什么必须回读，而不是看截图
   *
   * 「这条边描没描出来」在截图里只能定性看，而它真正的答案是一个数：
   * **相邻两像素的 ID 差有多小**。ID 存进 8 位 alpha 之后，两个挨着的物件
   * 完全可能落进同一个桶（`fract()` 只是「几乎必然不同」，不是唯一 ID）——
   * 那种边**永远不会出现**，而它在截图里长得和「阈值调高了」一模一样。
   * 参考笔记 §6 第 4 条因此一直标着 `待验证`：**判据要按可分差设计，
   * 不是按「看起来有描边」设计**，也不能抄参考的数（他的场景是树/叶子尺度）。
   *
   * ## 三个数各管什么
   *
   * - `distinctIds` 明显小于可见物件数 ⇒ 有物件撞进同一个 ID。
   * - `minGap` 是「相邻且不同」的 ID 里最小的一档；阈值必须**离它有余量**，
   *   否则最紧的那条边会随机消失（判据要离噪声远，不是离读数近）。
   * - `belowThreshold` 是按当前阈值会被**漏掉**的交界像素数 —— 0 才是可接受状态。
   * - `idBlindButDepthSees`：ID 完全相同、但深度有明显跳变的相邻像素数。
   *   这一格就是「ID 通道看不见、靠深度兜住」的那批边 —— 也是
   *   **不能只抄一条判据**的直接证据（只描 ID 会整批漏掉）。
   *
   * 两个附件都读：附件 0 的 alpha 只用来认背景（255 = `glClear` 填的），
   * 真正的 ID 在附件 1（半浮点两维）。半浮点要自己解码 —— `readPixels` 交回来的是
   * 原始位模式，不是 JS number。
   */
  private gbufferReport(): Record<string, number> {
    const target = this.gbuffer.target;
    const width = target.width;
    const height = target.height;
    const count = width * height;
    const color = new Uint8Array(count * 4);
    const info = new Uint16Array(count * 4);
    this.renderer.readRenderTargetPixels(target, 0, 0, width, height, color, 0, 0);
    this.renderer.readRenderTargetPixels(target, 0, 0, width, height, info, 0, 1);
    const thresholds = this.finalPass.outlineThresholds;

    /** IEEE 754 half → number。`readPixels` 交回的是位模式，不解码全是整数垃圾。 */
    const half = (raw: number): number => {
      const sign = raw & 0x8000 ? -1 : 1;
      const exp = (raw >> 10) & 0x1f;
      const frac = raw & 0x3ff;
      if (exp === 0) return sign * frac * 2 ** -24;
      if (exp === 31) return frac ? NaN : sign * Infinity;
      return sign * (1 + frac / 1024) * 2 ** (exp - 15);
    };

    // 先整帧解码一遍再扫邻居：省掉每个像素被反复解码 4~5 次（921k 像素的邻接扫描
    // 是百万级调用，边扫边解码会明显卡到判据超时）。
    const ids = new Float32Array(count * 2);
    const depths = new Float32Array(count);
    const isBackground = new Uint8Array(count);
    for (let i = 0; i < count; i++) {
      const o = i * 4;
      ids[i * 2] = half(info[o + 1]);
      ids[i * 2 + 1] = half(info[o + 2]);
      depths[i] = half(info[o]);
      isBackground[i] = color[o + 3] === 255 ? 1 : 0;
    }

    const buckets = new Set<number>();
    let background = 0;
    let objectEdges = 0;
    let silhouetteEdges = 0;
    let belowThreshold = 0;
    let idBlindButDepthSees = 0;
    let minGap = Number.POSITIVE_INFINITY;

    const measure = (a: number, b: number): void => {
      const bgA = isBackground[a] === 1;
      const bgB = isBackground[b] === 1;
      if (bgA && bgB) return;
      if (bgA !== bgB) {
        silhouetteEdges++;
        return;
      }
      const gap =
        Math.abs(ids[a * 2] - ids[b * 2]) + Math.abs(ids[a * 2 + 1] - ids[b * 2 + 1]);
      if (gap === 0) {
        // 同一 ID：要么真是同一件物体（正常），要么撞桶（缺陷）。
        // 用深度当旁证 —— 两件挨着的物体几乎总有深度差。
        if (Math.abs(depths[a] - depths[b]) > thresholds.depth) idBlindButDepthSees++;
        return;
      }
      objectEdges++;
      if (gap < minGap) minGap = gap;
      if (gap < thresholds.id) belowThreshold++;
    };

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (isBackground[i] === 1) background++;
        else {
          // 量化到 1/512 两维再计数：不量化会把 MSAA resolve 出来的中间值当成新桶，
          // 数出来的「不同 ID 数」会远大于物件数而毫无意义。
          buckets.add(
            (Math.round(ids[i * 2] * 512) << 10) | Math.round(ids[i * 2 + 1] * 512),
          );
        }
        // 水平 + 垂直邻居：与描边那次十字采样覆盖的是同一批边。
        if (x + 1 < width) measure(i, i + 1);
        if (y + 1 < height) measure(i, i + width);
      }
    }

    return {
      width,
      height,
      distinctIds: buckets.size,
      // 没量到任何物件交界 ⇒ 报 0 而不是 Infinity：
      // 「没有样本」和「可分差是满量程」是两件事，判据要分得开。
      minGap: Number.isFinite(minGap) ? Number(minGap.toFixed(5)) : 0,
      objectEdges,
      silhouetteEdges,
      belowThreshold,
      idBlindButDepthSees,
      backgroundShare: Number(((background / count) * 100).toFixed(2)),
      idThreshold: thresholds.id,
      depthThreshold: thresholds.depth,
      // 全 0 = readPixels 什么都没写进来（尺寸不对 / 类型不可读）。
      // 那时上面所有数都是假的，必须让判据看得见这件事而不是读到「一切正常」。
      readFailed: buckets.size === 0 && background === 0 ? 1 : 0,
    };
  }

  private applyQuality(): void {
    const settings = this.governor.current;
    // 降档 = 内部分辨率更低（targetHeight 更小 → 整数倍率更大）→ 更省。
    // 原来的 maxDpr 语义被它取代。默认不开最近邻，所以降档表现为轻微模糊而非方块。
    this.tuning.pixelTargetHeight = settings.pixelTargetHeight;
    this.renderer.shadowMap.enabled = settings.shadows;
    this.renderer.shadowMap.needsUpdate = true;
    this.coins.setCastShadow(settings.coinShadows);
    if (this.applyPixelScale()) this.fitCamera();
    this.hud.setStatus(`画质已切到${settings.tier === 'high' ? '高' : settings.tier === 'medium' ? '中' : '低'}档`);
  }

  /**
   * 画质锁（10-01 用户点名「不要切画质啊」）。
   *
   * ## 为什么是"加锁"而不是"默认不降档"
   * 自动降档是低端设备的保护，废掉它 = 老设备上直接卡死；
   * 而玩家真正缺的是**一句话的否决权**：「这一档我觉得挺好，别再动了」。
   * ⇒ 默认仍然自动降档，锁上之后 governor 只继续采样帧率、不再换档
   *   （复用 `freeze()`，与截图/测试同一条路径，**不新增第二套换档逻辑**）。
   *
   * ## 为什么锁档要连"手动改像素高度"一起触发
   * `applyQuality()` 写的是 `this.tuning.pixelTargetHeight`，与调试面板**同一个字段**。
   * 于是旧行为是：玩家在面板里手动拖回 720，下一次降档又把它覆盖回去，
   * 而且**没有任何地方说明为什么"我设的值不生效"**。
   * ⇒ 手动改这个字段 = 明确的人工意图 = 自动上锁（`DebugTools` 那条 `onFinishChange`）。
   *
   * ⚠️ 锁**不落盘**（与档位本身同规格：`tier` 与 `pixelTargetHeight` 都不进存档，
   *   刷新页面回到「自动 + 高档」）。这是刻意的：把锁持久化 = 让一次误触永久生效，
   *   而玩家看到的会是"画质再也回不到自动"。
   */
  setQualityLock(locked: boolean): QualityTier {
    this.governor.freeze(locked);
    const tier = this.governor.current.tier;
    this.hud.setQualityLock(locked, tier);
    this.hud.setStatus(
      locked
        ? `画质已锁定在${tier === 'high' ? '高' : tier === 'medium' ? '中' : '低'}档（不再自动降档）`
        : '画质恢复自动调节',
    );
    this.publishHud();
    return tier;
  }

  /**
   * 重算并套用像素分辨率（V1）。返回画布 backing store 是否真的变了。
   *
   * 顺序：先从 `tuning` 同步入参（调参面板与画质分档都写 `tuning`）→
   * 按 CSS 尺寸解出**整数倍率** → 写 `:root[data-pixel]` → `resizeRenderer`。
   *
   * `applyPixelated` 只改 CSS 的 `image-rendering`、不动布局，所以先调后调都安全。
   */
  private applyPixelScale(): boolean {
    this.pixelSettings.targetHeight = this.tuning.pixelTargetHeight;
    this.pixelSettings.pixelated = this.tuning.pixelated;
    const canvas = this.renderer.domElement;
    this.pixelScale = resolvePixelScale(canvas.clientWidth, canvas.clientHeight, this.pixelSettings);
    applyPixelated(this.pixelScale.pixelated);
    const resized = resizeRenderer(this.renderer, this.camera, this.pixelScale);
    // G1：MRT 必须与 backing store **同尺寸**，否则最后一遍要做一次非整数缩放
    //（像素风档下就是「明明设了最近邻却还是糊」）。这里跟 `resizeRenderer` 同一条路径，
    // 所以画质分档 / 视口变化 / `?pixel=` 三种来源都会一起走到。
    this.gbuffer.resize(this.pixelScale.internalWidth, this.pixelScale.internalHeight);
    return resized;
  }

  /**
   * 两遍出画（G1）。
   *
   * `scene → GBuffer(MRT) → FinalPass → canvas`。
   *
   * 为什么不能像以前那样一遍画完：参考那套观感要的是「物体之间必然有线」，
   * 而那条线要读的是**面 ID + 深度**，canvas 是 `alpha: false`（`core/Renderer.ts:8`），
   * 没有通道可写。所以必须先有一块带 alpha 的渲染目标 —— 见 `render/GBuffer.ts`。
   *
   * ★ 代价：色调映射与 sRGB 编码**不再由 three 自动做**（进 RT 时它把两者都关了，
   *   `WebGLPrograms.js:173-182` / `:209`），语义整个搬到 `FinalPass` 里。
   *   `renderer.toneMapping` / `toneMappingExposure` 那两行仍然是唯一真源，
   *   这里只是把 exposure 现值交给最后一遍。
   */
  private render(): void {
    // 第一遍：场景 → MRT。目标必须在 `render()` 之前设好（`FinalPass` 那边会自己切回 null）。
    this.renderer.setRenderTarget(this.gbuffer.target);
    // three 在这次调用内部会先清一次 `info`（`autoReset` 保持默认），
    // 所以紧接着采样到的就是**场景这一遍**的 draw call —— 与 G1 之前同一个口径
    //（阴影 pass 在 three 的 `info.reset()` 之前跑，历史上从来不计入，见 `core/Renderer.ts`）。
    this.renderer.render(this.scene, this.camera);
    this.sceneDrawCalls = this.renderer.info.render.calls;
    this.sceneTriangles = this.renderer.info.render.triangles;
    this.finalPass.render(this.renderer, this.gbuffer.color, this.gbuffer.info, {
      exposure: this.renderer.toneMappingExposure,
      view: this.finalView,
      outlineScale: this.tuning.outlineScale,
      shadowAmount: this.tuning.shadowGrade,
      // CSS 尺寸（不是 RT 尺寸）：见 `FinalPass.render` 与 `glsl/outline.glsl.ts`。
      cssWidth: this.renderer.domElement.clientWidth,
      cssHeight: this.renderer.domElement.clientHeight,
    });
    // 第二遍又清一次，所以此刻 `info` 里只剩最后一遍自己 —— 加起来才是这一帧的全部。
    this.frameDrawCalls = this.sceneDrawCalls + this.renderer.info.render.calls;
    this.frameTriangles = this.sceneTriangles + this.renderer.info.render.triangles;
  }

  /**
   * 这枚币此刻是否落在**推板顶面**（上层台面）上。
   *
   * 抽成一份判据是因为它有**两个读者**：输送本身（`fixedUpdate`）与诊断
   * （`deckCoins`）。两边各写一遍的话，改判据时很容易只改一处，于是
   * 「诊断说台面上没有币、输送却在送币」这种自相矛盾的读数就会一直挂着。
   *
   * ★ 实现走 `layout.isOnDeckVolume` —— **台面/币床的归属判据只有那一份**，
   * `CoinPool.countBed()` 与 `assertLayoutValid` 也调它。
   * S13 之前这里是「`y` 在 `TABLE.conveyor` 的高度带里 && z 在推板顶面区间里」，
   * 那条高度带把币塔卡在 5 层；现在归属是**体积**问题（多了一条 z 条件，
   * 而塔在 `z = 0.62`，不在体积里）。见 `isOnDeckVolume` 的注释。
   *
   * ★ 直接算、不读 `coin.onDeck`：那个标志只在 `fixedUpdate` 里更新，
   * 而降动效会跳过 `fixedUpdate`（MEMORY 已记），于是诊断会恒读成 0。
   */
  private isOnDeck(coin: Coin): boolean {
    const p = coin.position;
    return isOnDeckVolume(p.x, p.y, p.z, this.pusher.topRange);
  }

  /** 停在推板顶面上的活跃币数（诊断用，判据见 `publishDiagnostics` 的 `deckCoins`）。 */
  private countDeckCoins(): number {
    let count = 0;
    this.coins.forEachActive((coin) => {
      if (this.isOnDeck(coin)) count += 1;
    });
    return count;
  }

  /**
   * 追踪这枚币是否在下落，并在「下落 → 静止」的那一刻发落定音。
   *
   * 判据是 **vy 越过阈值**而不是位置高度：币可能落在币堆顶上（位置很高）、
   * 也可能直接落在床面，位置阈值没法通用；而"正在下落"这件事两种情形一致。
   *
   * 用 `fallVy` 记录本次下落的**最负速度**（见 `Coin.fallVy`）：落地那一子步
   * vy 已经归零，只有峰值能反映撞击力度。
   */
  private trackFall(coin: Coin): void {
    const vy = coin.body.linvel().y;
    if (vy < LANDING_FALL_VY) {
      if (vy < coin.fallVy) coin.fallVy = vy;
      return;
    }
    this.resolveLanding(coin);
  }

  /** 若这枚币刚结束一次下落就发落定音；没在下落则什么都不做（绝大多数币走这条）。 */
  private resolveLanding(coin: Coin): void {
    if (coin.fallVy >= 0) return;
    const heavy = coin.fallVy < LANDING_HEAVY_VY;
    coin.fallVy = 0;
    this.audio.landing(heavy ? 'heavy' : 'light');
  }

  /** 物理子步：只做必须在 world.step() 之前完成的写入。 */
  private fixedUpdate(fixedDt: number): void {
    const tick = this.pusher.update(fixedDt);

    if (tick.cycleCompleted) {
      this.run.onCycleCompleted();
      this.telemetry.recordCycle(this.pusher.cyclesCompleted, this.run.earned, this.settledCoins);
    }
    if (tick.boostConsumed) {
      this.hud.setStatus('加力生效：本次前推行程追加 20%');
      // 推板前缘闪一次，让玩家「看见」加力生效。
      this.flash(this.pusher.lipMaterial, 0.16);
    }

    // 速度护栏：**在每个子步推进之前**把上一子步被求解器注入的超额速度压回去，
    // 于是下一子步不会带着这个速度继续积分。睡着的币不参与积分，跳过它们
    // （满盘静置时绝大多数币都在睡，这个判断把开销从 318 枚降到个位数）。
    this.coins.forEachActive((coin) => {
      // ★ 落定检测必须在 isSleeping 提前返回**之前**：币停稳的那一子步往往正好
      // 进入 sleeping，先 return 就永远看不到「下落 → 静止」的转变，落定音会整段丢失。
      if (coin.body.isSleeping()) {
        this.resolveLanding(coin);
        return;
      }
      this.trackFall(coin);

      // 读注册表而不是 `COIN.*` 常量：这两个护栏要能被调试面板实时改，
      // 而且注册表是唯一真源（`applyCoinPhysics` 把调参值写进去）。
      // 第三个参数是**子步长**：向上的那一路按 `COIN.upwardBleedTau` 连续泄流，
      // 律的自变量必须跟着积分步长走（见 `Coin.clampSpeed`）。
      const spike = coin.clampSpeed(
        coinPhysics.maxSpeed,
        coinPhysics.maxUpwardSpeed,
        fixedDt,
      );
      if (spike) {
        this.spikeClamps += 1;
        if (spike.pre > this.peakSpikeSpeed) this.peakSpikeSpeed = spike.pre;
        if (spike.postUpward > this.peakPostClampUpward) {
          this.peakPostClampUpward = spike.postUpward;
        }
      }
    });

    // 台面输送：只作用于确实落在推板顶面上的币。
    // 速度以推板为参考系，所以推板回撤时币在世界里会跟着后退——和真机一致。
    //
    // ★ 2026-09-24 起 `conveyorSpeed = 0`（用户拍板「把输送速度改成 0.85→0、摩擦不改」）。
    // 归零的**正确实现是不施加**，不是让 `targetSpeed` 退化成 `pusher.velocityZ`——
    // `applyConveyor` 会把币的 z 速度直接拉成 targetSpeed，那样等于**每子步把币焊在推板上**
    // （相对滑动恒为 0），比原来的「向前推」更不物理。所以这里对 0 短路，
    // 台面上的币只受真实接触力（推板往复的摩擦拖曳 + 后来落下的币的碰撞）。
    const conveyoring = this.tuning.conveyorSpeed !== 0;
    const targetSpeed = this.pusher.velocityZ + this.tuning.conveyorSpeed;
    const { front } = this.pusher.topRange;
    this.coins.forEachActive((coin) => {
      const p = coin.position;
      const onDeck = this.isOnDeck(coin);
      const wasOnDeck = coin.onDeck;
      coin.onDeck = onDeck;

      // 记录「越过台面前缘」这一刻：这是币从上层掉到币床的唯一通道，
      // 位置必须贴合推板前缘，不能是任何形式的隐藏传送。
      //
      // ★ S1b/#49：记录条件**不再要求 `playerDropped`**，而是给每条事件打来源标签。
      //   原写法把「谁的币」混进了「要不要记」，于是 accept ④ 的样本只剩玩家币——
      //   而 S1a 实测单枚玩家币走完台面要四位数循环（对称行程下摩擦净输送精确 0），
      //   结果这条判据的失败**不是物理问题，是取样问题**（09-25 那次台面从 62 掉到 8，
      //   遥测一条都没有，就是同一件事的极端表现）。
      //   ⇒ 现在全记、按 source 分流：判据既能用全样本判「离台位置贴不贴前缘」，
      //     也能单独用 player 子集判「玩家真正投入的那枚币有没有被偷偷传送」。
      if (wasOnDeck && !onDeck && p.z > front) {
        this.telemetry.recordFallOff({
          z: round3(p.z),
          frontFaceZ: round3(this.pusher.frontFaceZ),
          offset: round3(this.pusher.offset),
          phase: this.pusher.currentPhase,
          source: coin.playerDropped ? 'player' : 'bed',
        });
      }

      if (!onDeck) return;
      if (!conveyoring) return;
      // 台面输送**只对开局预置的上层币让路**（`Coin.preset`）。
      //
      // 预置的上层币刻意不吃这一口：它们的唯一动力是推板顶面的摩擦，
      // 于是随着推板前后滑动、停在原地——「推币台上下都有金币」的观感才留得住。
      //
      // ★ **运行期注入的币（闸门 / 喷泉 / 塔 / 大赏）一律要吃**：
      // 它们落在推板顶面上，不吃输送就永远下不来。这条以前写成
      // `if (!coin.playerDropped) return;`——在只有预置币的年代恰好等价，
      // 而 P10 把 `gate` 接成自动补币之后，闸门吐的 7 枚币全被判成
      // 「不是玩家投的」→ 原地停在顶面 → 补币一枚都没到币床（见 `Coin.preset`）。
      if (coin.preset) return;
      coin.applyConveyor(targetSpeed);
    });
  }

  // ── 输入 ────────────────────────────────────────────────────────────────

  private handleIntent(intent: LaneInput): void {
    if (intent.giveUpPressed && this.drainPromptVisible) {
      this.run.abandonBoost();
      this.setDrainPrompt(false);
      this.finishRun();
      return;
    }
    if (intent.boostPressed) this.tryBoost();
    if (intent.dropPressed) this.tryDrop(intent.laneX);
    if (intent.sweepPressed) this.trySweep();
    if (intent.grapplePressed) this.tryGrapple(intent.laneX);
    if (intent.reloadPressed) this.tryReload();
    if (intent.betPressed) this.cycleBet();
  }

  // ── 机关 ────────────────────────────────────────────────────────────────

  /** 扫板：收尾停板后把贴着得分线的币推过去。与加力互斥（同一次收尾只能选一个）。 */
  private trySweep(): boolean {
    if (this.run.phase !== 'drainOut' || !this.run.plateStopped) return false;
    if (this.run.canUseBoost) {
      this.hud.setStatus('先决定加力：用掉或放弃，然后再扫板');
      return false;
    }
    const plan = this.mechanisms.sweep();
    if (!plan.ok) {
      this.hud.setStatus(plan.reason ?? '扫板不可用');
      return false;
    }
    this.audio.payoutReturn();
    // ★ R5：冲量交给横扫臂**扫到哪里推哪里**，所以这一行返回时币还没动 ——
    //   `mechanisms` 的判据要等演出落地再读账。
    this.mechanismShows.runSweep(plan);
    this.hud.setStatus(`扫板：横扫臂去送 ${plan.targets.length} 枚贴线的币`);
    return true;
  }

  /** 抓斗：花 2 枚额度，把选位标记附近 0.3×0.3 米区域内的币整堆搬到前沿。 */
  private tryGrapple(centerX: number): boolean {
    if (this.run.phase !== 'playing') return false;
    if (this.mechanisms.usesLeft('grapple') <= 0) {
      this.hud.setStatus('本局抓斗已用完');
      return false;
    }
    if (this.run.chips < MECHANISM_COST.grapple) {
      this.hud.setStatus(`筹码不足：抓斗要花 ${MECHANISM_COST.grapple} 枚`);
      return false;
    }
    const plan = this.mechanisms.grapple(centerX);
    if (!plan.ok) {
      this.hud.setStatus(plan.reason ?? '抓斗不可用');
      return false;
    }
    // 成本从局内筹码里扣，和直接投币用的是同一个池子——这就是它的机会成本。
    this.run.spendChips(MECHANISM_COST.grapple);
    this.audio.boostUse();
    // ★ R5：爪「下降 → 夹紧 → 提升到前沿」之后才松手搬运，同样是延迟交付。
    this.mechanismShows.runGrapple(plan);
    this.hud.setStatus(`抓斗：爪去搬 ${plan.targets.length} 枚币，送到前沿`);
    return true;
  }

  /** 后装填：花 1 枚额度，往盘面后区注入一小叠币（额度的延迟投资）。 */
  private tryReload(): boolean {
    if (this.run.phase !== 'ready' && this.run.phase !== 'playing') return false;
    if (this.run.chips < MECHANISM_COST.reload) {
      this.hud.setStatus(`筹码不足：后装填要花 ${MECHANISM_COST.reload} 枚`);
      return false;
    }
    const result = this.mechanisms.reload();
    if (!result.ok) {
      this.hud.setStatus(result.reason ?? '后装填不可用');
      return false;
    }
    this.run.beginPlay();
    this.run.spendChips(MECHANISM_COST.reload);
    this.pusher.start();
    this.audio.drop();
    this.hud.setStatus(`后装填：注入 ${result.affected} 枚，等两三个循环才开始产出`);
    return true;
  }

  /** 切换加注档位。 */
  private cycleBet(): boolean {
    this.betIndex = (this.betIndex + 1) % ENDLESS.bets.length;
    const bet = ENDLESS.bets[this.betIndex];
    this.hud.setStatus(`加注切到 ${bet.label}`);
    return true;
  }

  private mechanismSnapshot(): MechanismSnapshot {
    return {
      sweeper: this.mechanisms.usesLeft('sweeper'),
      grapple: this.mechanisms.usesLeft('grapple'),
      reload: this.mechanisms.usesLeft('reload'),
    };
  }

  private tryDrop(laneX: number): boolean {
    if (!this.run.acceptingDrops) return false;
    if (this.dropCooldown > 0) return false;

    // 加注：一次押 1 / 2 / 5 枚筹码，换这一投更高的**返值倍率**。
    const bet = betTier(this.betIndex);
    if (this.run.chips < bet.chips) {
      this.hud.setStatus(`筹码不足：当前加注要 ${bet.chips} 枚`);
      return false;
    }

    const coin = this.coins.acquire();
    if (!coin) {
      // 预算耗尽不再静默失败：不提示的话玩家只会觉得按钮坏了。
      this.hud.setStatus('盘面已满：等几枚币越线腾出空位再投');
      return false;
    }

    const jitterX = (this.rng() - 0.5) * 2 * TABLE.drop.jitterX;
    const jitterZ = (this.rng() - 0.5) * 2 * TABLE.drop.jitterZ;
    coin.spawn(
      'bronze',
      clamp(laneX + jitterX, -TABLE.drop.halfLane, TABLE.drop.halfLane),
      TABLE.drop.y,
      TABLE.drop.z + jitterZ,
      this.rng() * Math.PI * 2,
      true,
    );
    // 倍率盖在币身上，而不是越线时读当前档位：否则玩家可以在币在途时改档，
    // 用 1 枚的价钱享受 5 枚的倍率。
    coin.betMul = bet.mul;

    this.run.beginPlay();
    this.run.spendChips(bet.chips);
    this.run.noteDrop();
    this.dropCooldown = this.tuning.dropCooldown;
    this.pusher.start();
    this.audio.drop();
    // 落币口亮一下，与真实生成同步（不提前）。
    this.flash(this.spitterMaterial, 0.42);
    // 每 N 投注入一枚金色大赏币（方差的主杠杆）。
    if (this.run.drops % ENDLESS.bountyEveryDrops === 0) this.spawnBounty();
    return true;
  }

  /**
   * 注入一枚金色大赏币。
   *
   * 落点随机：有时贴着得分线（马上兑现），有时埋在后排（长线悬念）。
   * 视觉与铜币同尺寸同碰撞体，靠贴图与自发光区分——不动物理。
   */
  private spawnBounty(): boolean {
    const coin = this.coins.acquire();
    if (!coin) return false;
    const x = (this.rng() - 0.5) * 2 * TABLE.drop.halfLane;
    const z = -0.1 + this.rng() * 1.05;
    coin.spawn('bounty', x, TABLE.pusherTopY + 0.5, z, this.rng() * Math.PI * 2, false);
    // 只在真的注入成功时计数：预算耗尽时 `acquire` 返回 null，那次没发生。
    this.run.noteBounty();
    this.hud.setStatus(`金色大赏币注入：越线固定 +${baseChips('bounty')} 筹码`);
    return true;
  }

  private tryBoost(): boolean {
    if (this.pusher.pendingBoost) return false;
    if (!this.run.canUseBoost) return false;
    if (!this.run.useBoost()) return false;

    this.pusher.requestBoost();
    this.audio.boostUse();
    if (this.run.settling && !this.pusher.running) {
      this.pusher.start();
      this.settleWindow = 0;
      this.restTimer = 0;
      this.setDrainPrompt(false);
    }
    this.hud.setStatus('加力已排队，下一次前推追加行程');
    return true;
  }

  // ── 事件处理 ────────────────────────────────────────────────────────────

  private processOutcomes(): void {
    this.coins.forEachActive((coin) => {
      const p = coin.position;

      // ★ **排水判定必须排在 anomaly 之前**（P10，见 `DRAIN`）。
      //
      // `DRAIN.yKill = -0.06` 远高于 anomaly 的 `y < -0.8`：顺序对了，掉进洞的币
      // 在变成异常**之前**就被回收；顺序反了，`anomalies` 会随游戏时长单调上涨，
      // 把「求解器还在不在造能量」那条真判据淹掉（那是一条靠 `spikeClamps` 才勉强
      // 分辨得出的残留缺陷，多一路假阳性就彻底查不动了）。
      //
      // 也**排在得分判定之前**：洞的上界刻意压到 `TABLE.scoreLineZ` 以内，
      // 币在洞里下落时 z 还没过线；万一将来有人把洞开到线外，
      // 这个顺序仍然能保证「掉进去的币不会被算成入账」——
      // 「掉进洞里还给了筹码」是这条机制最荒谬的失效形态。
      //
      // 后果上它是一次**合法的损失**：0 筹码、不计分、不算异常。它是 P10 的「汇」。
      if (
        p.y < DRAIN.yKill &&
        Math.abs(p.x) > DRAIN.xMin &&
        p.z >= DRAIN.zMin &&
        p.z <= DRAIN.zMax
      ) {
        this.drainCount += 1;
        this.telemetry.recordDrain({
          side: p.x > 0 ? 1 : -1,
          kind: coin.kind,
          x: round3(p.x),
          z: round3(p.z),
          y: round3(p.y),
          offset: round3(this.pusher.offset),
          t: this.elapsed,
        });
        this.audio.drain();
        // 洞口闪光（P10 ⑨）：与那声 `drain()` 是**同一件事的两路证据**。
        // 只有声音的话，玩家在余光里看不到声源，会以为币是被挤没了；
        // 而「没进（还在床上）」与「掉了（永久离开）」对盘面的影响方向相反。
        this.drainFlashLevel = 1;
        this.feedbackCounts.drainFlash += 1;
        return true;
      }

      // 穿模/掉出机柜：开发期记录为缺陷，不当作合法损失。
      if (p.y < -0.8 || Math.abs(p.x) > 1.3 || p.z < TABLE.pusherBackZ - 0.6) {
        this.anomalyCount += 1;
        if (this.anomalySamples.length < 12) {
          const [vx, vy, vz] = coin.velocity3();
          this.anomalySamples.push({
            frame: this.frame,
            kind: coin.kind,
            x: round3(p.x),
            y: round3(p.y),
            z: round3(p.z),
            vx: round3(vx),
            vy: round3(vy),
            vz: round3(vz),
            speed: round3(Math.hypot(vx, vy, vz)),
          });
        }
        return true;
      }

      if (p.z > TABLE.scoreLineZ) {
        this.settleCrossing(coin);
        return true;
      }

      // XIXI 集章：只有玩家主动投入的币、且已经掉到币床上（离开上层台面）才登记——
      // 集章门槛：`p.y < channel.registerY`（0.13）。⚠️ 它与「在币床上」**不是同一件事**：
      // 币床判据是 `isOnDeckVolume` 的体积带。停在上层台面的币心 ≈ 0.213 > 0.13 ⇒
      // 只有币真的走完台面、从前唇掉下去之后才可能跨过这条线（S1a 实测：满盘后排币要四位数循环）。
      if (coin.playerDropped && !coin.xixiMarked) {
        if (p.y < TABLE.channel.registerY) {
          coin.xixiMarked = true;
          this.markXixi(p.x);
        }
      }

      return false;
    });
  }

  /**
   * 登记一枚落床币的 XIXI 槽位（拍板 #2：按物理落点 x，不按投币口）。
   *
   * 四槽集齐 → 清空 → 触发背板老虎机。进度**跨局持续**（存档 v4 的 xixi 字段），
   * 破产不清零——它是收集线，不是赌本。同一槽重复点亮不累计（P8 可再调）。
   */
  private markXixi(x: number): void {
    const slot = xixiSlot(x);
    if (slot < 0 || this.xixi[slot]) return;

    this.xixi[slot] = true;
    this.save.setXixi(this.xixi);
    this.telemetry.recordXixi({ phase: 'lit', slot, t: this.elapsed });
    this.audio.mark();
    // 3D 标牌爆闪：写的是**实例颜色**，由 `publishHud` 每帧按剩余强度重算。
    this.xixiFlashSlot = slot;
    this.xixiFlashTimer = XIXI_FLASH_SECONDS;

    if (this.xixi.every(Boolean)) {
      this.xixi = [false, false, false, false];
      this.save.setXixi(this.xixi);
      this.telemetry.recordXixi({ phase: 'completed', t: this.elapsed });
      // 老虎机正在转时不吞这次集齐：排队到转完再摇（见 update 里的 pendingXixiSpin）。
      if (!this.slotMachine.spin()) this.pendingXixiSpin = true;
    }
  }

  /**
   * **演出窗口内**的越线分类计数（R4-4b 的「汇」）。**累计、不按局归零**——
   * 判据读的是某场演出前后的**差值**，跟 `cycles.coins` 一个口径。
   *
   * 为什么要在引擎里分这一刀：柱子上真碰撞体之后，「越线一枚币」在账本上是同一个读数，
   * 但「演出自己顶出来的币」是水源、「柱子把存量币床拱过线」是**白送**。
   * 让脚本按时刻自己配对分类就是抄第二份口径（纪律 2）。
   *
   * ★ 窗口取「**任意**演出在跑」而不是只取 `tower`，两个理由：
   * ① 演出队列一次一场（`shows.busy` 拒并行），所以某场演出前后的差值仍是它的专属窗口；
   * ② 这条判据要能被**正对照**否证——只数 tower 的话一局里只有一场塔、读数又是 0，
   *    永远分不清「没拱到币」和「线没接上」。整个 run 的累计值 > 0 才把后者否证掉。
   */
  private showWindowCrossings = 0;
  private showWindowForeign = 0;

  /**
   * 一枚币越过得分线：结算筹码。
   *
   * 顺序不能反：**先算连落**（热度倍率挂在 combo 上），再算返值，最后入账。
   * 入账**不取消沉降**（见 `RunState.gainChips` 的说明）：沉降期返值照记，
   * 但本局能不能继续由「沉降走完时手里有没有筹码」决定，不靠某一枚币。
   *
   * 随机数在这里取（走游戏 RNG），所以概率返值是可复现的：
   * 同一个种子跑出同一串结果，账本恒等式才能逐笔核对。
   */
  private settleCrossing(coin: Coin): void {
    const kind = coin.kind;
    const combo = this.run.nextCombo(this.elapsed);
    // 热区：币在亮条范围内越线，返值翻倍。
    const hot = this.isInHotZone(coin.position.x);
    const outcome = crossingReturn({
      kind,
      combo: combo.combo,
      hot,
      betMul: coin.betMul,
      roll: this.rng(),
    });

    const chipsBefore = this.run.chips;
    // ★ 甲规则（用户 09-28 拍板）：产出按 `debt : balance` 比例**实时分流抵债**，
    // 落到玩家手里的是剩下的那一截。`balance` = 钱包 + 本局筹码 = 玩家此刻的全部持有
    // （S4 合并账户之后就剩一个 `balance`，所以这里刻意不写单只口袋的 `save.wallet`）。
    //
    // ⚠️ 分流**不进三账本恒等式**：`earned` 只记到账那一截，抵债额记进 `run.repaid`
    //（与 `fines` 同族的对账计数）。`RunState.ts` 里写明「加一项就要同步
    // Ledger / ledgerBalances / 所有断言点」，这条分流照罚款的先例走，正好绕开那笔债。
    const gross = outcome.chips;
    const repaid = this.save.repayFrom(gross, this.save.balance + this.run.chips);
    this.run.repaid += repaid;
    this.run.gainChips(gross - repaid);
    const chipsAfter = this.run.chips;
    if (repaid > 0) {
      // HUD 必须实时显示分流额，否则玩家看到的是「越了一枚币，筹码怎么只加了一点」——那就是 bug 的形状。
      this.hud.setStatus(`产出 ${gross} 筹码：抵债 −${repaid}，实得 +${gross - repaid}`);
    }

    // ★ 4b 的汇判据：**这一枚**越线时是不是有装置正在跑。
    // 读 `activeId` 而不是「距演出开始多久」：窗口由演出自己定义，
    // 降动效（`speed` 压时长）与 P7 的「演出期间暂停收尾计时」都自动跟着变
    // （P7 只暂停计时，物理照跑、结算照记，见 `Game` 里那处 `shows.busy` 的注释）。
    if (this.shows.activeId !== null) {
      this.showWindowCrossings += 1;
      if (!coin.fromShow) this.showWindowForeign += 1;
    }

    coin.settled = true;
    this.settledCoins += 1;

    this.telemetry.recordScore(
      {
        kind,
        // 入账筹码（含热度倍率、热区翻倍与加注倍率），不是面值——否则逐笔合计对不上。
        value: outcome.chips,
        z: round3(coin.position.z),
        combo: combo.combo,
        chipsBefore,
        chipsAfter,
        hot,
      },
      this.elapsed,
    );

    this.audio.score(kind, combo.combo);
    // 没返值的铜币要**诚实呈现**：灰字 +0，而不是假装什么都没发生。
    this.hud.flashScore(outcome.chips);
    // 飞字必须从**真的越线位置**起飞，所以这里把币的世界坐标投影到屏幕。
    const from = this.toScreen(coin.position.x, coin.position.y, coin.position.z);

    // ── 反馈分级（P10 ⑨）──────────────────────────────────────────────
    //
    // 「什么输入产生什么反馈」抽在 `crossingFeedback()` 里（纯函数），
    // 这里只负责**执行**它给出的结论。所以判据可以枚举边界点核对全部分支，
    // 而这里不会偷偷多出第四条分支。
    const feedback = crossingFeedback({
      chips: outcome.chips,
      combo: combo.combo,
      hot,
      kindClimax: kindSpec(kind).climax,
      // 被闸门拦下的币种不许闪自己的高潮（否则金闪 + 灰字 +0 = 画面说谎）。
      // 连落白闪不受影响：那是玩家自己连推出来的。
      blocked: outcome.blocked,
    });

    this.hud.flyScore(from.x, from.y, outcome.chips, feedback.flyTier);
    this.feedbackCounts[feedback.flyTier === 'big' ? 'flyBig' : 'flyNormal'] += 1;

    // 热区命中：专属音效 + 亮条爆闪。热区是**玩家瞄出来的**，
    // 与普通越线同音同色的话，那条来回扫的亮条就只是装饰。
    if (feedback.hotFlash) {
      this.audio.hotHit();
      this.hotZoneFlash = 1;
      this.feedbackCounts.hotHit += 1;
    }
    if (feedback.scoreLinePulse) {
      this.scoreLinePulse = 1;
      this.feedbackCounts.comboPulse += 1;
    }

    if (outcome.chips > 0 && (kind === 'payout' || kind === 'bounty')) this.audio.payoutReturn();
    if (combo.combo >= 3) this.hud.showCombo(combo.combo, COIN_KIND[kind].label);

    // 效果型币种（宝箱）：越线返 **0 筹码**，改派一场投放演出。
    // 0 是硬值——这里绝不能写成负数，否则三账本恒等式会立刻报。
    // 派发目标写在 `kinds.ts` 的 `payout.show` 里，这里不再手写币种名单。
    const payoutRule = kindSpec(kind).payout;
    if (payoutRule.mode === 'effect') this.shows.request(payoutRule.show);

    // 高潮反馈：读分级结果（连落 ≥ 5 的**白闪**优先于币种自身的高潮定义）。
    // 只驱动 HUD 闪色 —— 镜头抖动已在 S16 按用户要求删除（见 `triggerClimax`）。
    if (feedback.climax) {
      if (feedback.climax.reason === 'combo') this.feedbackCounts.comboClimax += 1;
      this.triggerClimax(feedback.climax.tone);
    }
  }

  // ── 状态机推进 ──────────────────────────────────────────────────────────

  private updateRunState(delta: number): void {
    if (this.run.phase === 'settled') return;

    this.run.setInFlight(this.countInFlight() > 0);

    // 筹码归零不立即判破产，先让盘面沉降——
    // 沉降期照样有币越线返值（照记进账本），但**返值本身不取消沉降**：
    // 满盘一波就能返十几枚，若返值能立刻复活，沉降永远走不完。
    // 能不能继续由沉降走完那一刻手里的筹码决定（见下面 drainWindow 分支）。
    if (this.run.phase === 'playing' && this.run.chips <= 0) {
      this.run.enterRuinSettle();
      this.hud.setStatus('筹码见底：盘面沉降中，撑到沉降结束就能带着盘面回吐的筹码继续');
    }

    if (!this.run.settling) {
      this.setDrainPrompt(false);
      return;
    }

    if (this.run.settleReason !== null && !this.drainRecorded) {
      this.drainRecorded = true;
      this.telemetry.recordDrainStart(this.run.settleReason, this.elapsed, this.run.earned);
    }

    if (!this.run.plateStopped && this.run.shouldStopPlate()) {
      this.run.stopPlate();
      this.pusher.stop();
      this.settleWindow = 0;
      this.restTimer = 0;
      this.audio.settle(this.run.settleReason ?? 'exhausted');
      this.hud.setStatus('推板已停板，等待盘面沉降');
    }

    if (!this.run.plateStopped) return;

    // 加力不能被吞：持有加力时提示玩家使用或放弃，不静默清空。
    // 提示不再 return——破产弹窗必须能同时弹出（加力在沉降期仍能救命）。
    this.setDrainPrompt(this.run.canUseBoost);

    // 演出期间**暂停收尾计时**（P7）。演出本身要花时间，不暂停的话
    // 「加宽后的停板窗口」会被演出吃掉——玩家刚按下机关，窗口就在演出途中走完了。
    // 暂停的只是**计时**：物理照跑、结算照记，所以这不是「暂停游戏」。
    if (this.shows.busy) return;

    this.settleWindow += delta;
    this.restTimer = this.allResting() ? this.restTimer + delta : 0;
    if (this.restTimer >= RULES.restHold || this.settleWindow >= RULES.drainWindow) {
      // 沉降走完，两条路：
      // · 盘面在这段时间里把筹码还回来了 → **本局继续**。玩家手里有筹码就该能接着玩，
      //   这里不能悄悄结束本局——那等于把返值吞掉。
      // · 一枚都没回来 → 破产弹窗（跪求是唯一救济 / 保留尊严收工）。
      if (this.run.chips > 0) {
        // 这一轮收尾到此结束，先把结算落盘再继续本局：
        // 不落盘的话「收尾持续了多久」这条断言就再也测不到了。
        this.telemetry.recordSettle(this.elapsed, this.run.earned);
        this.run.reviveFromRuin();
        this.pusher.start();
        this.settleWindow = 0;
        this.restTimer = 0;
        this.setDrainPrompt(false);
        // 允许下一轮沉降重新开一条记录（刚走完的那条留着）。
        this.resetDrainRecord();
        this.hud.setStatus(`盘面回吐筹码，本局继续（手里 ${this.run.chips} 枚）`);
      } else {
        this.showRuin();
      }
    }
  }

  /**
   * 自动补币（P10 ⑦，用户拍板 #1）：台面见底 → 请求一场闸门落币。
   *
   * ## 口径
   *
   * 「台面」= `CoinPool.countBed()`（**不在台面体积里**、且在得分线内的活跃币），
   * **不是 `activeCoins`**。两者的差别是这条机制的成败所在：`activeCoins` 含正在下落的、
   * 演出排队没落的、上层台面的币，盘面已经掏空它还是三位数 → 补币永不触发，
   * 而且**零报错**（判据只会看到「补币没发生」）。见 `CoinPool.countBed()` 的注释。
   *
   * ## 为什么走 `shows.request('gate')` 而不是自己 `acquire()`
   *
   * `gate` 是既有的「庄家补货」装置，它自带**预算协商**：余量不足时按实有降级并
   * 在事件里如实记 `promised`，彻底没有时**明确拒绝并给出原因**。
   * 自己写 `coins.acquire()` 循环会绕开这一层，撞上「池满时静默返回 null」的历史坑
   * （不扣额度、不提示，玩家只看到「什么都没发生」）。
   *
   * ## 三个守卫，各自对应一种误触发
   *
   * - **`phase === 'playing'`**：沉降期补币 = 庄家替玩家续命。续命是跪求按钮的语义
   *   （`grantBeg`，见 `RunState` 的恒等式），不能由补币悄悄代劳——否则破产永远弹不出来。
   * - **`cooldown`**：盘面会在阈值上下抖动。没有冷却时每 0.5 秒补一次，
   *   `gate` 演出排队到天上去，玩家看到的是「闸门一直在掉币」——
   *   补币从「救场」退化成「背景噪声」。
   * - **`!shows.busy`**：演出排队中不叠加请求。`gate` 自己会拒绝，
   *   但每 0.5 秒拒绝一次会把遥测刷满，HUD 也会反复闪同一句话。
   *
   * ★ 失败**不重置冷却**：这次没补成（排队/余量不足），下一轮盘点接着试，
   * 别把 8 秒白等掉。
   */
  private updateRefill(delta: number): void {
    this.refillCooldown = Math.max(0, this.refillCooldown - delta);
    this.refillTimer += delta;
    if (this.refillTimer < REFILL.checkEvery) return;
    this.refillTimer = 0;

    this.bedCoins = this.coins.countBed(this.pusher.topRange);

    if (this.run.phase !== 'playing') return;
    if (this.bedCoins >= REFILL.bedThreshold) return;
    if (this.refillCooldown > 0) return;
    if (this.shows.busy) return;

    const result = this.shows.request('gate', { count: REFILL.count });
    if (!result.ok) return;

    this.refillCount += 1;
    this.refillCooldown = REFILL.cooldown;
    this.hud.showRefill(this.bedCoins, result.promised, result.downgraded);
  }

  /**
   * 破产弹窗：嘲讽 + 两条真实选择。
   *
   * 跪求 → 领递减赏赐，**盘面保留**（你堆起来的台面是沉没价值，这是「再跪一次」的拉力）。
   * 保留尊严 → 结束本局、盘面清空。
   *
   * ★ S4：这里旧写法还有一句「不回存钱包，因为本局还没结束，玩家随时可能跪求续命」——
   *   合并账户之后收工本来就不动钱，那条顺序顾虑随之消失；**留下来的顾虑是另一个**：
   *   弹窗出现时盘面还在沉降，迟到返值会继续进账，所以成绩单读的是收工那一刻的快照。
   */
  private showRuin(): void {
    if (this.ruinVisible) return;
    this.ruinVisible = true;
    this.pusher.stop();
    // 破产也是「本次收尾结束」，必须和 finishRun 一样落一条结算记录，
    // 否则遥测里永远看不到破产局的收尾时长与迟到返值。
    this.telemetry.recordSettle(this.elapsed, this.run.earned);
    this.hud.showRuin({
      earned: this.run.earned,
      chips: this.run.chips,
      drops: this.run.drops,
      chipsPeak: this.run.chipsPeak,
      begs: this.begsThisRun,
      totalBegs: this.save.begCount(),
      best: this.save.snapshot.bestEarned,
      balance: this.save.balance,
      runs: this.save.snapshot.runs,
      grant: ENDLESS.begs[Math.min(this.begsThisRun, ENDLESS.begs.length - 1)],
      // 贷款报价（S3）。到上限时 `available=false`，HUD 会藏掉按钮而不是留着可点。
      loan: this.save.loanOffer,
    });
    this.hud.setStatus('破产。跪求 xixi 大王，还是保留尊严？');
  }

  /** 跪求 xixi 大王大赏：递减赏赐，只给筹码，盘面保留。 */
  private begForChips(): boolean {
    if (!this.ruinVisible) return false;
    const grant = ENDLESS.begs[Math.min(this.begsThisRun, ENDLESS.begs.length - 1)];
    this.begsThisRun += 1;
    this.ruinVisible = false;
    this.hud.hideRuin();
    // 赏赐走 grantBeg 而不是 gainChips：它记进 begged（脏钱），
    // 所以它**不能拿去换永久进度**（`SaveStore.spendable` 把它扣掉了）——
    // 否则「破产 → 跪求 → 买图鉴」就成了无限刷进度的漏洞。
    this.run.grantBeg(grant);
    // 赏赐只续命：不计入赚进、不给任何加成。
    this.run.reviveFromRuin();
    // 本局被拉回收尾之前：那次收尾没有结算，清掉记录重新计时。
    this.resetDrainRecord();
    this.pusher.start();
    this.settleWindow = 0;
    this.restTimer = 0;
    this.audio.payoutReturn();
    this.hud.setStatus(`xixi 大王赏你 ${grant} 筹码。滚去推币，别再回来。`);
    return true;
  }

  /**
   * 贷款续玩（S3 去局感）：**同一副盘面、同一个 RNG 序列、不重开任何东西**，
   * 只是把「又买了一次筹码」的钱记成欠款。
   *
   * 与 `begForChips()` **同形**（都保留盘面、都从沉降里拉回来、都重记收尾），
   * 差别只在账上：跪给的是**脏钱**（`begged`：不能换成永久进度、也不计入成绩），
   * 贷来的是**干净进账**（`loaned`，恒等式里的第四项）⇒ 两条都不必改动恒等式的形状。
   *
   * ★ **刻意不调 `startRun()`**：那会重摆盘面、重置 RNG、中止在途演出、
   * 把本局计数器与异常统计全部清零。而「贷款前后**盘面枚数一动不动**」
   * 是本功能唯一近确定性的判据（比任何分布统计都硬），一调 `startRun` 就没得验了。
   * 这也是 S3「一局一局的感觉消失」在代码上的落点：触底不再是终点。
   */
  private loanToContinue(): boolean {
    if (!this.ruinVisible) return false;
    const stake = this.save.loanToStake();
    // `stake === 0` 只在欠款到顶时发生。HUD 那时已经把按钮藏了
    //（见 `Hud.showRuin` 里 `loan.available` 的行级 gating），所以这条是第二层防线，
    // 不是给用户看的死按钮 —— 而且它必须返回 false，钩子才能把「没给钱」如实报出来。
    if (stake <= 0) return false;
    this.ruinVisible = false;
    this.hud.hideRuin();
    this.run.recordLoan(stake);
    this.run.reviveFromRuin();
    // 与跪求同一手：这次收尾没有结算，清掉记录重新计时。
    this.resetDrainRecord();
    this.pusher.start();
    this.settleWindow = 0;
    this.restTimer = 0;
    this.audio.payoutReturn();
    this.hud.setStatus(
      `贷款 +${stake} 筹码续玩。欠款 ${this.save.debt}/${this.save.debtCeiling}，产出会按比例自动抵债。`,
    );
    this.publishHud();
    return true;
  }

  /** 保留尊严，收工：记录本局，盘面清空；若已在总结页则直接再来一局。 */
  private endRun(): void {
    if (this.summaryVisible) {
      this.summaryVisible = false;
      this.hud.hideRuin();
      this.startRun();
      return;
    }
    if (!this.ruinVisible) return;
    this.ruinVisible = false;
    this.hud.hideRuin();
    // 收工即收摊：在途演出/摇奖一并作废，本局成绩单不再被「收工后才落地的币」追改
    // （那些迟到越线会让 earned 在快照之后继续涨，快照与实时读数就对不上了）。
    this.shows.abort();
    // 机关构件收摊前**先把交付结清**（钱已经扣了），再拆件。
    this.mechanismShows.abort();
    this.slotMachine.abort();
    this.pendingXixiSpin = false;
    // 视觉币与演出同生命周期：本局已经结清，在飞的筹码不该继续出现在收工画面上。
    this.spray.clear();
    this.showEndlessSummary();
  }

  /**
   * 本局结算卡片。
   *
   * ★ S4：旧写法这里有一条顺序要求（「先回存钱包、再记这一局」，否则卡片上的钱包数
   * 与存档不一致）。合并账户之后**回存这个动作不存在了**，卡片显示的余额与存档
   * 是同一个数的同一次读取 ⇒ 顺序要求一起消失。保留的是另一件事：
   * `recordRun` 读的是**收工那一刻**的 snapshot，之后的迟到返值只进账本、不进成绩单。
   *
   * 跪求次数是排行榜的第二列：把羞辱变成收集品。
   */
  private showEndlessSummary(): void {
    const snapshot = this.run.snapshot();
    /*
     * ★ S4：这里原本有三行 —— `const cashOut = this.run.cashOut` →
     *   `this.save.depositWallet(cashOut)` → 卡片上打「回存钱包 +N」。
     *   合并账户之后**这三行一起删掉，不是改写**：钱从始至终都在同一个余额里，
     *   「回存」这个动作没有对象了。玩家眼里少掉一次「钱从一个口袋搬进另一个口袋」的表演，
     *   而这正是他抱怨的那个别扭处（「我的钱怎么少了 20？」）。
     *   脏钱的约束没有丢：它现在长在 `SaveStore.spendable`（买图鉴的门槛）上，
     *   等价性见 `economy.spendableOf` 的代入验算。
     */
    const record = this.save.recordRun(snapshot.earned, snapshot.drops, this.begsThisRun);
    this.summaryVisible = true;
    this.hud.showRuin({
      earned: snapshot.earned,
      chips: snapshot.chips,
      balance: this.save.balance,
      drops: snapshot.drops,
      chipsPeak: snapshot.chipsPeak,
      begs: this.begsThisRun,
      totalBegs: record.totalBegs,
      best: record.best,
      runs: this.save.snapshot.runs,
      grant: 0,
      summary: true,
    });
    this.hud.setStatus(`本段结束：余额 ${this.save.balance}`);
    this.publishDiagnostics();
  }

  private setDrainPrompt(visible: boolean): void {
    if (this.drainPromptVisible === visible) return;
    this.drainPromptVisible = visible;
    this.hud.showDrainPrompt(visible);
  }

  /**
   * 本局从收尾被拉回进行中：允许下一轮收尾重新开一条记录。
   *
   * 只复位这个一次性标志，**不清遥测记录**——刚走完的那轮收尾记录要留给断言读
   * （`Telemetry.recordDrainStart` 每次覆盖，所以不需要手动清）。
   */
  private resetDrainRecord(): void {
    this.drainRecorded = false;
  }

  /** 收尾：定格本局并弹结算卡片。 */
  private finishRun(): void {
    this.run.finish();
    this.setDrainPrompt(false);
    this.pusher.stop();
    this.telemetry.recordSettle(this.elapsed, this.run.earned);
    this.showEndlessSummary();
  }

  // ── 开局装载 ────────────────────────────────────────────────────────────

  /** 开一局新的：盘面预置，筹码从钱包买入。 */
  private startRun(): void {
    // ★ S4：这里原来第一件事是「买入扣钱包」，必须排在任何状态重置之前。
    //   合并账户之后 `new RunState(save)` 就是把**当时的余额**快照成本局起始额，
    //   所以「先扣后重置」这件事自然成立，不再有独立的扣款步骤。
    //   余额见底时起始就是 0：本局以 0 开局、立刻进沉降，玩家跪求一次就能继续——
    //   这条路必须走得通，否则余额空就成了死状态。
    this.run = new RunState(this.save);
    this.rng = createSeededRandom(this.seedOverride ?? this.config.seed);

    // **推板先归位，再摆盘。顺序不能反。**
    //
    // 摆盘是按「推板归位」的几何算出来的（上层币就在推板后缘与归位前缘之间）。
    // 如果先摆盘、后归位，这一帧里推板还停在上一局结束时的位置（最远在行程前方
    // 0.36 米），而摆盘用的是归位几何 —— 两件事错开，背排的币会落在推板体内。
    // 更糟的是 `reset()` 会把推板从行程最大处一路搬回来，那段位移在一步内完成，
    // 等效 21 米/秒的**倒扫**，直接把背排币挤飞出机柜。
    // 实测：重开一局盘面只剩 287~295 枚（应 318），丢的 16~31 枚全部记进 `anomalies`。
    //
    // `travel` 必须在 `reset()` **之前**赋值：`reset()` 拿 `this.travel` 初始化
    // `travelForStroke`，反了的话第一趟行程用的还是上一局的行程值。
    this.pusher.travel = this.tuning.pusherTravel;
    this.pusher.reset();

    this.coins.releaseAll();
    for (const placement of this.config.layout) {
      const coin = this.coins.acquire();
      if (!coin) break;
      // `preset = true`：开局摆盘的上层币**不吃台面输送**（见 `Coin.preset`）。
      // 漏掉这个参数会让 18 枚上层预置币在一秒内被整片冲下前缘。
      coin.spawn(placement.kind, placement.x, placement.y, placement.z, placement.yaw, false, true);
    }
    this.coins.syncAll();

    this.mechanisms.reset();
    // 在途演出与摇奖必须随本局作废：不中止的话，上一局的塔/喷泉会把剩余承诺数
    // 吐进**这一局**的开局盘面（实测重开后 318 变 324 枚）。
    this.shows.abort();
    this.mechanismShows.abort();
    this.slotMachine.abort();
    this.pendingXixiSpin = false;
    // 视觉币与演出同生命周期：上一局飞出去的筹码不能飘进这一局的画面。
    this.spray.clear();
    this.physics.freeze();
    this.telemetry.reset();
    this.drainRecorded = false;
    this.begsThisRun = 0;
    this.betIndex = 0;
    this.ruinVisible = false;
    this.summaryVisible = false;
    this.hud.hideRuin();

    this.elapsed = 0;
    this.dropCooldown = 0;
    this.restTimer = 0;
    this.settleWindow = 0;
    this.anomalyCount = 0;
    this.anomalySamples.length = 0;
    // 镜头偏移峰值随局清零：`feedbackReport()` 的读数必须只反映**本局**
    // （上一局的峰值留着会让「本局没抖」这条判据永远过不了）。
    this.cameraPeakOffset = 0;
    this.drainCount = 0;
    this.refillCount = 0;
    this.rendererPeakDrawCalls = 0;
    // 冷却**从满值开始**：开局那一下盘面本来就是满的，不需要补；
    // 而且开局帧 `bedCoins` 还没盘过点（是 0），不设冷却的话
    // 第一轮盘点会立刻判定「见底」并白送一场闸门落币。
    this.refillCooldown = REFILL.cooldown;
    this.refillTimer = 0;
    this.bedCoins = 0;
    this.spikeClamps = 0;
    this.peakSpikeSpeed = 0;
    this.peakPostClampUpward = 0;
    this.settledCoins = 0;
    this.setDrainPrompt(false);
    this.hud.resetCombo();
    // 爆闪不跨局：上一局最后一枚币点亮的那一下不该在新开局里继续闪。
    this.xixiFlashTimer = 0;
    this.xixiFlashSlot = -1;
    // 反馈计数与三个衰减量也按局清零（P10 ⑨）：
    // 「本局出了几次大号飞字 / 几次热区命中」是可断言的量，跨局累加就说不清是谁贡献的。
    // 衰减量归零还不够，**材质也要写回基线**——否则上一局结束时正亮着的得分线
    // 会把那一帧的亮度带进新一局的开局画面。
    this.scoreLinePulse = 0;
    this.hotZoneFlash = 0;
    this.drainFlashLevel = 0;
    if (this.scoreLineMaterial) this.scoreLineMaterial.emissiveIntensity = FEEDBACK_EMISSIVE.scoreLineBase;
    if (this.hotZoneMaterial) this.hotZoneMaterial.emissiveIntensity = FEEDBACK_EMISSIVE.hotZoneBase;
    if (this.drainGrateMaterial) this.drainGrateMaterial.emissiveIntensity = 0;
    for (const key of Object.keys(this.feedbackCounts) as Array<keyof typeof this.feedbackCounts>) {
      this.feedbackCounts[key] = 0;
    }
    this.hud.setStatus(
      `${this.config.focus} · 余额 ${this.save.balance} 筹码 · 选位自动左右摆，轻点机台或按空格投币`,
    );
    this.input.setEnabled(true);
    this.publishHud();

    // ── 钱包见底：买入 0 筹码 ──────────────────────────────────────────────
    //
    // ★ 这是一个**必须显式处理**的状态，否则整局卡死。
    //
    // 不处理的话会发生什么：`RunState` 停在 `phase='ready'` 且 `chips=0`，
    // 于是 ① `acceptingDrops` 为假 → 投不出币，阶段永远升不到 `playing`；
    // ② `updateRunState` 的沉降分支要求 `phase==='playing'` → 沉降永远不触发；
    // ③ 破产弹窗只在「沉降走完」或 `forceRuin` 时弹 → 永远不弹。
    // 而**跪求按钮挂在破产弹窗里** → 玩家既不能投币也不能跪求，画面彻底无响应。
    //
    // 走既有的沉降机制而不是另开一条路，有两个好处：
    //   1. `revive()` 只在 `phase==='drainOut'` 时生效 —— 只有真的进过沉降，
    //      跪求才能把本局拉回 `playing`。不绕这一圈的话 `grantBeg` 的 `resumed`
    //      会静默返回 false，阶段永远停在 `ready`。
    //   2. 盘面如果在这段时间里回吐筹码（满盘开局很常见），沉降走完会**本局继续**
    //      —— 钱包空但币床是满的，本来就该让玩家接着打。
    //
    // 注意 `pusher.reset()` 已经跑过，盘面也已摆好；这里只是把「开局即破产」
    // 这件事交给沉降去表达，不额外动任何物理。
    if (this.run.chips <= 0) {
      this.run.beginPlay();
      this.run.enterRuinSettle();
      this.showRuin();
      this.hud.setStatus('钱包见底（本局买入 0 筹码）。向 xixi 大王跪求赏赐，或保留尊严收工。');
    }
  }

  // ── 场景 ────────────────────────────────────────────────────────────────

  /**
   * 灯光组（V2 收敛）。
   *
   * ★ **只能有一盏直接光。** `MeshToonMaterial` 的 `RE_Direct_Toon` 会**对每盏直接光
   * 各调一次** `getGradientIrradiance`，所以 N 盏方向光的最终颜色是
   * `palette(N·L₁) + palette(N·L₂) + …` —— 三盏灯就等于背光面拿到三倍阴影色、
   * 迎光面叠出三倍亮度。这是**结构性**问题，不是调参能救的。
   *
   * 收敛后的分工：
   * - `key` 是唯一采样色带、也是唯一投影的灯。**形阴影**由色带给出（暗部换冷色阶）。
   * - `HemisphereLight` **不走** `getGradientIrradiance`（它走间接项），
   *   所以不参与色带叠加。它负责**投射阴影**里的冷色填充 ——
   *   于是「形阴影走色带、投射阴影走环境」互不重复，不会双重暗化。
   * - 原来的 rim / fill 两盏方向光删掉：它们的职责（暖高光、冷轮廓）
   *   分别由色带的顶段与底段承接。
   */
  private buildScene(tableGroup: THREE.Group): void {
    this.scene.background = new THREE.Color(COLORS.screenDeep);
    // 冷天空 + 冷地面：投射阴影落进冷色，与色带的冷暗部同向。
    //
    // 强度 2.0 是**实测调出来的**：只留一盏直接光之后，背光的那半台面
    // （右侧板 N·L < 0 → 色带暗段）会暗到看不清机器结构。
    // hemisphere **不走** `getGradientIrradiance`（它是间接项），
    // 所以抬它只抬暗部、不改色带台阶——这是给背光面补光最干净的办法。
    this.scene.add(new THREE.HemisphereLight('#cfe4ff', '#1b2a3a', 2.0));

    // 唯一直接光。位置与 shadow 参数**全部保持原样**（阴影贴图的取景别动）。
    // 颜色改成纯白：暖色现在由色带顶段给，灯再暖会双重偏色。
    const key = new THREE.DirectionalLight('#ffffff', 3.4);
    key.position.set(-1.6, 3.2, 2.4);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.near = 0.5;
    key.shadow.camera.far = 9;
    key.shadow.camera.left = -1.6;
    key.shadow.camera.right = 1.6;
    key.shadow.camera.top = 1.8;
    key.shadow.camera.bottom = -1.2;
    this.scene.add(key);

    this.scene.add(tableGroup);
    this.tableGroup = tableGroup;
    this.scene.add(this.pusher.group);
    this.scene.add(this.coins.group);
    this.scene.add(this.shows.group);
    // 机关构件（R5）与投放演出分开挂：臂与爪只在各自机关的演出期存在。
    this.scene.add(this.mechanismShows.group);
    // 视觉币通道（S16）。挂 `spray.group` 而不是让演出装置自己持有 ——
    // 在飞的币必须活过演出（见 `CoinSpray` 的模块注释）。
    this.scene.add(this.spray.group);
    this.scene.add(this.slotMachine.group);
    this.scene.add(this.debugTools.overlay);
    this.scene.add(this.buildLaneMarker());
  }

  /** 套用存档里选用的外观。只改渲染，不动物理与数值。 */
  private applySkins(): void {
    const coinSkin = coinSkinById(this.save.snapshot.selectedCoinSkin);
    const cabinetSkin = cabinetSkinById(this.save.snapshot.selectedCabinetSkin);
    this.coins.applyCoinSkin(coinSkin);
    // 视觉币必须跟着换：它的材质是**另一份实例**（与币池同 defines，共享程序但不同 uniform），
    // 不换的话飞出去的是旧外观 —— 这种「一半新一半旧」在截图里很难发现。
    this.spray.setSkin(coinSkin);
    if (this.tableGroup) applyCabinetSkin(this.tableGroup, cabinetSkin);
    applyCabinetSkin(this.pusher.group, cabinetSkin);
    this.applyCabinetMapTextures(cabinetSkin);
  }

  /**
   * 切肤时把 Arcane 风贴图按 palette 重画，swap 进对应材质。
   *
   * 受影响的件：`scoreLine` / `hotZone` / 招牌 + 顶板 + 檐板（三者共用一份 `trimMaterial`）。
   * `applyCabinetSkin` 已经把 trim 颜色刷过一遍；这里**只动 map**，不动 color ⇒
   * 招牌底色保持机身色，涂鸦叠在上面。
   *
   * ★ 判据是 `userData.part`（S19），不是 `role`：见 `pickCabinetMap` 的长注释 ——
   * 按 `role` 判时得分线 / 热区两条分支永远不会命中。
   *
   * ★ 同一份材质可能被多件共用（`trimMaterial` 被招牌 / 顶板 / 檐板共用），
   * 所以逐件处理会对同一份材质反复 `create*` 再 `dispose` —— 白造两张 1024×512 的
   * `CanvasTexture`。`touched` 让每份材质只处理一次。
   *
   * 老贴图必须 `dispose()`，否则 GC 收不掉，泄漏的是 GPU 资源——四张 CanvasTexture
   * 全坏掉也会有「gpu memory leak」的红色（headless Chrome 会报）。
   */
  private applyCabinetMapTextures(cabinetSkin: CabinetSkin): void {
    const palette = cabinetSkin.marqueePalette;
    const table = this.tableGroup;
    if (!table) return;
    const touched = new Set<THREE.Material>();
    table.traverse((child) => {
      if (!(child as THREE.Mesh).isMesh) return;
      const mesh = child as THREE.Mesh;
      const part = mesh.userData.part as string | undefined;
      if (!part) return;
      const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const entry of list) {
        if (!isLitMaterial(entry)) continue;
        if (touched.has(entry)) continue;
        const next = pickCabinetMap(part, palette);
        if (!next) continue;
        touched.add(entry);
        const previous = entry.map;
        entry.map = next.map;
        // 灯饰的亮条走 `emissiveMap` = **同一张**贴图：`emissive` 给纯白，于是
        // 「按贴图自己的颜色发光」（亮条亮、暗腔仍暗，见 `ToonMaterial.emissiveMap` 注释）。
        // 不新增纹理单元（同 0 通道同 UV），也不新增 draw call。
        //
        // ★ 只在 `glow` 时动 emissive 三件套，**不要**给不发光的那几件写回黑色：
        //   得分线 / 热区的材质在建场时带了 `emissive: COLORS.scoreLine`（`TableBuilder`），
        //   这里清零 = 换肤把它们的自发光照一起关掉，又是一条静默失效。
        // ⚠️ emissiveMap 不单独 dispose：它和 `map` 永远是同一个实例，再 dispose 一次
        //    会让下次换肤拿到已释放的纹理。
        if (next.glow) {
          entry.emissiveMap = next.map;
          entry.emissive.set('#ffffff');
          entry.emissiveIntensity = 0.85;
        }
        entry.needsUpdate = true;
        previous?.dispose();
      }
    });
  }

  /**
   * 重建币面贴图（调参面板改分辨率时调用）。
   *
   * 顺序不能反：**先写全局倍率、再强制重建**。`applyCoinSkin` 默认会在
   * 「外观 id 没变」时短路返回，而改分辨率恰恰不改 id，所以要显式 `force`。
   */
  private applyCoinResolution(): void {
    setCoinTexelScale(this.tuning.coinTexelScale);
    const coinSkin = coinSkinById(this.save.snapshot.selectedCoinSkin);
    this.coins.applyCoinSkin(coinSkin, true);
    // 视觉币那张贴图是**另一个 `CanvasTexture` 实例**（同一个 `coinTexels` 真源），
    // 所以倍率变了它也必须重建 —— 漏了这一行，调分辨率时飞出去的币还是旧纹素。
    this.spray.setSkin(coinSkin);
  }

  private buildLaneMarker(): THREE.Group {
    const spitterMaterial = makeToonMaterial({
      name: 'spitter',

      color: COLORS.bronzeRim,
      ramp: 'metal',
      emissive: COLORS.bronzeRim,
      emissiveIntensity: 0.42,
    });
    this.spitterMaterial = spitterMaterial;
    const spitter = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.05, 0.07), spitterMaterial);
    spitter.position.set(0, TABLE.drop.y + 0.09, TABLE.drop.z);
    this.laneMarker.add(spitter);

    const guideBottom = TABLE.pusherTopY + 0.02;
    const guideHeight = TABLE.drop.y - guideBottom;
    const guideMaterial = new THREE.MeshBasicMaterial({
      color: COLORS.bronzeRim,
      transparent: true,
      opacity: 0.22,
    });
    // G1：这是全场景唯一**不走 toon 工厂**的网格材质，所以拿不到 `gInfo` 那条输出。
    // MRT 下少写一个附件是每帧都刷的验证错误（`visual.spec` 的「无控制台报错」直接红），
    // 必须补 —— 见 `attachGInfoFallback` 的注释。
    attachGInfoFallback(guideMaterial);
    const guide = new THREE.Mesh(
      new THREE.BoxGeometry(0.006, guideHeight, 0.006),
      guideMaterial,
    );
    guide.position.set(0, guideBottom + guideHeight / 2, TABLE.drop.z);
    this.laneMarker.add(guide);

    return this.laneMarker;
  }

  /**
   * 把机位落到相机上。
   *
   * ★ S22 起机位的真源是 `cameraRig`（模块单例，见 `render/cameraRig.ts`），
   * 相机的位置与朝向都只是它的投影。两种模式：
   *
   * - `tuning.cameraAutoFit === true`（默认）：先按取景框解一次机位，
   *   与 S19~S21 的算式**逐字相同** ⇒ 默认构图零变化。
   * - `false`（调试面板动过机位之后）：**不重新取景**，直接把 `cameraRig` 落到相机上。
   *   这条分支是「交出机位所有权」的兑现处 —— 不这样，改 FOV 或改窗口尺寸
   *   都会把用户手动摆好的机位弹回默认视角。
   *
   * 收尾三行（`cameraBase` / 投影矩阵 / `updateMarksAnchor`）两条路共用，
   * 因为「相机基准位置」是 S17 那条铁律（`cameraPeakOffset` 恒为 0）的记账基准。
   */
  private fitCamera(): void {
    this.camera.fov = this.tuning.cameraFov;
    if (this.tuning.cameraAutoFit) fitCameraRig(this.tuning.cameraFov, this.camera.aspect);
    applyCameraRig(this.camera);
    this.cameraBase.copy(this.camera.position);
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld(true);
    this.updateMarksAnchor();
    // 自动取景会解出新的距离（改 FOV / 改窗口尺寸都会），滑块显示必须跟着刷新，
    // 否则面板上的「距离」会一直停在上一次的值上，看起来像坏了。
    this.debugTools.refreshCameraControllers();
  }

  /**
   * 重建机柜外壳（S24，只服务 `?model` 模型模式）。
   *
   * ## 为什么只 dispose 几何
   *
   * 材质是 `TableBuilder.cabinetMaterials()` 的**模块单例**，重建后仍是同一份。
   * 于是重建的代价只剩几何，而且：
   *   - 已编译程序数不涨（每建一次新材质会让 `programs` 随拖滑块一路涨，
   *     `perf` 判据直接红）；
   *   - 换肤颜色与 Arcane 贴图都还在（它们刷的就是那几份单例材质）。
   * 反过来做会得到一个**零报错的静默失效**：
   * 「换肤之后一调模型参数，机柜就变回默认色」。
   *
   * ## 为什么不碰台面 / 钉子 / 推板
   *
   * 用户明确要求「不打算动碰撞边界」。台面、钉子、侧壁碰撞体、推板都与
   * `ColliderDesc` 一一对应，热重建会让视觉与碰撞分叉 —— 所以只有
   * **纯视觉的外壳**参与重建。
   */
  private rebuildCabinetShell(): THREE.Object3D {
    const parent = this.tableGroup;
    if (!parent || !this.cabinetShell) {
      // 理论上到不了（外壳在 `buildTable()` 里就建好了）。真到了这里就现建一具
      // 挂上去，免得模型模式整个失效 —— 这比抛异常好，因为这条路径只在开发模式。
      const fresh = buildCabinetShell();
      parent?.add(fresh);
      this.cabinetShell = fresh;
      return fresh;
    }
    disposeCabinetShell(this.cabinetShell);
    const next = buildCabinetShell();
    parent.add(next);
    this.cabinetShell = next;
    return next;
  }

  /**
   * 调试面板动完机位后调这里：把 `cameraRig` 落到相机上，**不重新取景**。
   *
   * 刻意不复用 `fitCamera()`：那条路会走 `applyTuning()`（含 700 枚币的额外迭代遍历），
   * 而拖一次机位滑块要跑几十次。这里只做「摆相机 + 记账 + 重算锚点」四件事，
   * 剩下的（FOV / 物理 / 经济）本来就没被机位改动碰到。
   */
  applyCameraRigFromPanel(): void {
    applyCameraRig(this.camera);
    this.cameraBase.copy(this.camera.position);
    this.camera.updateMatrixWorld(true);
    this.updateMarksAnchor();
  }

  /** 世界坐标 → 屏幕 CSS 像素。飞字与集章贴台面都要用它。 */
  private toScreen(x: number, y: number, z: number): { x: number; y: number } {
    const projected = new THREE.Vector3(x, y, z).project(this.camera);
    const canvas = this.renderer.domElement;
    return {
      x: (projected.x * 0.5 + 0.5) * canvas.clientWidth,
      y: (-projected.y * 0.5 + 0.5) * canvas.clientHeight,
    };
  }

  /**
   * 世界尺寸 → **后备缓冲像素**边长（P10 的诊断用）。
   *
   * 为什么不复用 `toScreen` 量两点差：那量的是 **CSS 像素**，而像素画的 1:1 是对着
   * **后备缓冲**说的——倍率 > 1 且开最近邻时，图标纹素与后备像素一一对应才干净。
   * 这里按透视公式直接算，再除掉 `pixelScale.upscale`，得到的就是真正决定
   * 「图标糊不糊」的那个数。判据写「≥ 24 后备像素」这种与档位无关的断言。
   *
   * 近似口径：把该点当作**垂直于视轴**的平面上的尺寸。滚筒窗确实近似正对相机，
   * 所以这个近似对它是准的；不要拿它去量斜面上的件。
   */
  private backPixelSize(worldSize: number, x: number, y: number, z: number): number {
    const view = new THREE.Vector3(x, y, z).applyMatrix4(this.camera.matrixWorldInverse);
    const depth = Math.max(0.001, -view.z);
    const canvas = this.renderer.domElement;
    const cssPerMeter =
      (canvas.clientHeight * 0.5) / (depth * Math.tan((this.camera.fov * Math.PI) / 360));
    return (worldSize * cssPerMeter) / Math.max(1, this.pixelScale.upscale);
  }

  /**
   * 把三路集章贴到币床上缘。
   *
   * 用世界坐标投影而不是百分比定位——竖屏与横屏下机台在画面里的位置不同，
   * 百分比会把圆点漂到别处。锚点取币床最深处（推板归位时的推币面）。
   */
  private updateMarksAnchor(): void {
    const anchor = this.toScreen(0, TABLE.pusherTopY + 0.02, TABLE.pusherFrontZAtRest);
    this.hud.setMarksAnchor(anchor.y);
  }

  private togglePause(): void {
    this.paused = !this.paused;
    this.hud.showPause(this.paused);
    if (this.paused) this.physics.freeze();
    this.hud.setStatus(this.paused ? '已暂停：推板与物理都已冻结' : '继续游戏');
  }

  // ── 查询 ────────────────────────────────────────────────────────────────

  private countInFlight(): number {
    let count = 0;
    this.coins.forEachActive((coin) => {
      if (coin.position.y > IN_FLIGHT_Y) count += 1;
    });
    return count;
  }

  private allResting(): boolean {
    let resting = true;
    this.coins.forEachActive((coin) => {
      if (coin.speed() > RULES.restSpeed) resting = false;
    });
    return resting;
  }

  /**
   * 一句要让玩家看见的话：**同时**进状态行与招牌屏（R3-U4）。
   *
   * 只开这一个口，是因为「老虎机开奖说了什么」在 DOM 和 3D 招牌上是同一件事 ——
   * 分成两处调用的话，早晚会有一处漏掉某个事件，而那种不一致没有任何判据能发现。
   */
  private announce(message: string): void {
    this.hud.setStatus(message);
    marqueeScreen().subtitle(message);
  }

  private publishHud(): void {
    // XIXI 标牌跟着 HUD 一起刷新：**同一个数据源**（`this.xixi`），
    // 所以 3D 标牌与 DOM 圆点不可能对不上。爆闪由 `updateXixiFlash` 递减。
    this.pusher.setXixiLanes(
      this.xixi,
      this.xixiFlashTimer > 0 ? this.xixiFlashSlot : -1,
      this.xixiFlashTimer > 0 ? this.xixiFlashTimer / XIXI_FLASH_SECONDS : 0,
    );
    const snapshot = this.run.snapshot();
    // 欠款跟着 HUD 一起刷新：读的是 `SaveStore` 本尊，HUD 不存副本。
    this.hud.setDebt(this.save.debt, this.save.debtCeiling);
    this.hud.update(
      snapshot,
      this.config,
      this.save.snapshot.bestEarned,
      this.mechanismSnapshot(),
      betTier(this.betIndex),
      this.xixi,
    );
    // 屏上的账本与 DOM 读的是**同一个 snapshot 对象**：不存在「HUD 说 56、招牌说 54」。
    marqueeScreen().pushLedger({ balance: this.save.balance, earned: snapshot.earned });
  }

  /**
   * XIXI 命中爆闪的衰减。
   *
   * 与 `updateFlashes` 分开是刻意的：那个管的是**材质自发光**（spitter / lip），
   * 这个管的是**实例颜色**（`instanceColor`），两者的载体不是同一种东西。
   */
  private updateXixiFlash(delta: number): void {
    if (this.xixiFlashTimer <= 0) return;
    this.xixiFlashTimer = Math.max(0, this.xixiFlashTimer - delta);
  }

  // ── 测试钩子与诊断 ──────────────────────────────────────────────────────

  private installTestHooks(): void {
    window.__THREE_GAME_TEST_HOOKS__ = {
      seed: (value: number) => {
        this.seedOverride = value;
        this.rng = createSeededRandom(value);
      },
      setState: (name: string) => {
        const state = this.applyTestState(name);
        this.render();
        this.publishDiagnostics();
        return { state };
      },
      setPausedForScreenshot: (paused: boolean) => {
        this.pausedForScreenshot = paused;
      },
      /**
       * 只停/启推板，**不重置盘面**（测试用）。
       *
       * 存在的理由：穿模判据如果取「推板跑到第 10 个循环那一瞬间」的快照，
       * 量到的是**推板正在挤压**的瞬时姿态——币会顺着推币面爬上去、
       * 短暂地彼此嵌入，几秒后又自己解开。那是推币机的正常形态，不是缺陷。
       * 有了这个钩子，判据可以「停推板 → 等币堆自己静止 → 再量」，
       * 量到的才是**稳定下来的穿模**，同一条盘面每次跑结论一致。
       */
      setPusherRunning: (running: boolean) => {
        if (running) this.pusher.start();
        else this.pusher.stop();
        return { running: this.pusher.running, cycles: this.pusher.cyclesCompleted };
      },
      setReducedMotion: (enabled: boolean) => {
        this.motion.setOverride(enabled);
        if (enabled) {
          // 截图用：停掉环境动效，让同一状态两次渲染一致。
          // （相机不用归位 —— S16 起它本来就一动不动，见 `trackCameraOffset`。）
          this.pusher.stop();
        }
        this.render();
        this.publishDiagnostics();
        return { reduced: this.motion.reduced, source: this.motion.source };
      },
      hideDebugUi: (hidden: boolean) => {
        this.debugTools.setHidden(hidden);
      },
      setQuality: (tier: string) => {
        const settings = this.governor.force(tier as QualityTier);
        this.governor.freeze(true);
        this.applyQuality();
        this.hud.setQualityLock(true, settings.tier);
        this.render();
        return {
          tier: settings.tier,
          pixelTargetHeight: settings.pixelTargetHeight,
          shadows: settings.shadows,
        };
      },
      /**
       * 画质锁（10-01 用户点名）。`locked` 省略时**读**当前锁状态而不改 ——
       * 判据要能分清「没锁」与「锁在高档」，而这两件事在 tier 上看起来一样。
       */
      qualityLock: (locked?: boolean) => {
        if (locked === undefined) {
          return { locked: this.governor.isFrozen, tier: this.governor.current.tier, fps: this.governor.fps };
        }
        const tier = this.setQualityLock(locked);
        return { locked: this.governor.isFrozen, tier, fps: this.governor.fps };
      },
      /**
       * 灌 N 个「低帧」采样窗口，用来验锁档真的拦住了自动降档。
       *
       * 为什么要有这条钩子：判据不能靠"等机器真的卡"——那是不可复现的等待。
       * `sample()` 是纯的（吃 delta 出换档决定），所以把 delta 喂进去就能确定性地
       * 复现「连续两个 1 秒窗口低于 45 ⇒ 降一档」这条规则本身。
       */
      feedFrames: (delta: number, windows: number) => {
        let changed = 0;
        for (let i = 0; i < Math.max(0, Math.round(windows)); i += 1) {
          // 一个窗口 = 累计满 1 秒仿真时间；`1 / delta` 帧就是那个窗口的帧数。
          const frames = Math.max(2, Math.ceil(1 / Math.max(0.001, delta)));
          for (let f = 0; f < frames; f += 1) {
            if (this.governor.sample(delta)) {
              changed += 1;
              this.applyQuality();
            }
          }
        }
        return { changed, tier: this.governor.current.tier, fps: this.governor.fps };
      },
      /**
       * 像素分辨率开关（V1，V2 解耦）：`pixelated` 只管最近邻/平滑，`upscale` 管内部分辨率。
       * 两个旋钮独立可断言——`visual.spec.ts` 专门钉「关最近邻不改倍率」。
       */
      setPixelScale: (patch: { targetHeight?: number; upscale?: number | null; pixelated?: boolean }) => {
        if (patch.targetHeight !== undefined) this.tuning.pixelTargetHeight = patch.targetHeight;
        if (patch.pixelated !== undefined) this.tuning.pixelated = patch.pixelated;
        // `upscale: null` 取消显式倍率，回到 `targetHeight` 推导。
        if (patch.upscale !== undefined) this.pixelSettings.upscaleOverride = patch.upscale;
        this.applyPixelScale();
        this.render();
        return { ...this.pixelScale };
      },
      drop: (lane: number) => {
        this.input.setLane(lane);
        return this.tryDrop(clamp(lane, -1, 1) * TABLE.drop.halfLane);
      },
      /** 只设定选位、不投币；视为一次手动接管（自动选位会让位 2 秒）。 */
      setLane: (lane: number) => {
        this.input.setLane(lane);
        return { lane, laneX: clamp(lane, -1, 1) * TABLE.drop.halfLane };
      },
      boost: () => this.tryBoost(),
      /** 机关：直接触发，返回是否生效（测试用）。 */
      sweep: () => this.trySweep(),
      grapple: (laneX: number) => this.tryGrapple(laneX),
      reload: () => this.tryReload(),
      cycleBet: () => this.cycleBet(),
      mechanisms: () => this.mechanismSnapshot(),
      /**
       * 机关构件的在场与**交付剖面**（R5）。
       *
       * 为什么必须暴露：扫板「分批给冲量」与老写法「一次全给」在**账本上完全等价**
       * （总冲量一样、越线一样），任何计数型判据都读不出区别。只有交付时刻
       * （`firstHitAt` ~ `lastHitAt` 的跨度、抓斗 `deliveredAt` 晚于提升）能证明这件事，
       * 而那两个字段的唯一出处就是这里。
       */
      mechanismShow: () => this.mechanismShows.report(),
      /** 开一局新的 / 跪求 / 收工，供自动化试玩。 */
      startRun: () => {
        this.startRun();
        return true;
      },
      beg: () => this.begForChips(),
      quitRun: () => this.endRun(),
      /**
       * 把**当前这一局就地**推到破产弹窗（测试用）。
       *
       * 与 `setState('ruin')` 的区别是关键的：那个会先 `startRun()` 重开一局，
       * 于是 `earned` / `begsThisRun` / 消耗**全被清零**。拿它去搭「收工 → 总结页」
       * 的场景，会把**被测的东西本身**擦掉——总结页要显示的正是「本局赚了多少、
       * 跪求过几次」，而它读的是 `recordRun(earned, drops, begsThisRun)`
       * （实测踩过：跪求过一次之后用 `setState('ruin')` 搭场景，总结页报「累计跪求 0」）。
       *
       * 这个钩子只走收尾那一步：清零筹码 → 进沉降 → 弹窗。账本身份原样保留，
       * 所以 `spent` 会记上这次清空，恒等式仍然平。
       */
      forceRuin: () => {
        if (this.hud.ruinVisible) return false;
        this.run.spendChips(this.run.chips);
        this.run.enterRuinSettle();
        this.showRuin();
        return true;
      },
      /**
       * 把币床掏空到只剩 `keep` 枚，返回实际删掉的枚数（P10 ⑦ 补币判据的**状态构造器**）。
       *
       * 为什么要一个构造器：「台面见底」在真实玩法里要玩好几分钟才到得了
       * ——盘面每局只掉几十枚，而阈值落在预置量的一半以下。用它当验收的**入口**
       * 会让判据变成一条几分钟的慢测，而且不确定（掉多少取决于玩家怎么投）。
       *
       * ★ **从最靠前（z 最大）的开始删**：那是币床自然变薄时的顺序——
       * 推板把币往前挤，前沿的先越线、先掉进下水道。所以构造出来的状态与
       * 「真的玩到那一步」是**同一个形态**，而不是一个「随机挖空」的人造态。
       *
       * 只 `despawn`，不碰账本：币不是筹码，`balance = initial + earned + begged + loaned − spent`
       * 不受影响。判据要的是「盘面变薄」这一个变量，别的一律不动。
       */
      clearBedTo: (keep = 120) => {
        const bed: Coin[] = [];
        const range = this.pusher.topRange;
        this.coins.forEachActive((coin) => {
          const p = coin.position;
          if (p.z >= TABLE.scoreLineZ) return;
          // 与 `CoinPool.countBed()` 同一份口径（「不在台面体积里」= 在币床上）：
          // 币塔上的币也算币床库存，否则「把盘面掏到 120 枚」会留下一座塔没动。
          if (isOnDeckVolume(p.x, p.y, p.z, range)) return;
          bed.push(coin);
        });
        if (bed.length <= keep) return 0;
        bed.sort((a, b) => b.position.z - a.position.z);
        let removed = 0;
        for (const coin of bed) {
          if (bed.length - removed <= keep) break;
          coin.despawn();
          removed += 1;
        }
        return removed;
      },
      run: () => ({
        begs: this.begsThisRun,
        totalBegs: this.save.begCount(),
        best: this.save.snapshot.bestEarned,
        balance: this.save.balance,
        // 验证脚本会主动充值钱包（见 `refillWallet` 钩子），所以钱包守恒的
        // 算式必须把 Σ充值 算进去，否则会报出假失败。
        refilled: this.save.refilled,
        ruinVisible: this.hud.ruinVisible,
        summaryVisible: this.summaryVisible,
      }),
      /**
       * 本局账本 + 账户读数：验收要逐笔核对
       * `balance = initial + earned + begged + loaned − spent`（S4 合并账户之后的式子）。
       *
       * ★ `balanced` 是**这条恒等式唯一的真源**（直接调 `economy.ledgerBalances`）。
       * 原先 harness 的 `ledgerOk()`、Playwright 的 `expect(...).toBe(...)`、以及
       * `ledgerText()` 打的中文式子**各自手抄了一遍同一个算式**（共四处）。
       * 于是 S4 合并账户动 `Ledger` 那一族时要同步改四个地方——漏一处就是
       * 「src 绿、spec 红」的假回归对。现在下游一律**读这个字段**，不再自己算。
       */
      ledger: () => ({
        ...this.run.ledger,
        balance: this.save.balance,
        spendable: this.save.spendable,
        refilled: this.save.refilled,
        balanced: ledgerBalances(this.run.ledger),
        /**
         * ★ S4 的全局守恒式（验证批 ②）要用它。
         * 局级账本每次开局重新快照，抓不到「上一局收尾时那笔没记进任何局账的余额变动」
         * —— 旧 ② 报的「差 26」正是这种。这份累计表不按局清零，所以抓得到。
         */
        totals: this.save.accountTotals,
      }),
      /** 加注档位表（含返值倍率），供验证脚本做「换档重算」。 */
      betTiers: () => BET_TIERS.map((tier) => ({ ...tier })),
      /**
       * 经济纯函数：验证脚本拿它做蒙特卡洛。
       *
       * 之所以要暴露到页面里而不是在脚本里重写一遍：**只有真的调这条函数**，
       * 测出来的期望才是游戏实际的期望。脚本里抄一份公式，改了一边忘了另一边，
       * 测试就会一直绿着骗人。
       */
      crossingReturn: (input: { kind: CoinKind; combo: number; hot: boolean; betMul: number; roll: number }) =>
        crossingReturn(input),
      snapshot: () => this.run.snapshot(),
      coins: () => this.sampleCoins(),
      probeColliders: (x: number, y: number, z: number) => this.probeColliders(x, y, z),
      /**
       * 调试用：从某点竖直向下打一条射线，返回第一个命中的碰撞体。
       *
       * 用来回答「这枚币脚下到底是什么、支撑面在哪个高度」——币堆穿模排查时，
       * 光看币的坐标只能知道它沉下去了，射线才知道它沉进了什么。
       */
      castDown: (x: number, y: number, z: number) => this.castDown(x, y, z),
      /** 调试用：报告地板网格与最低几枚币的**网格**世界包围盒（渲染侧真实位置）。 */
      probeMeshes: () => this.probeMeshes(),
      /**
       * 调试/验证用：从**接触流形**里读真实穿透深度。
       *
       * 为什么不用「同层横向距离」那种几何启发式：币堆里出现倾斜的币时，
       * 两枚币心可以靠得很近、高度也只差几毫米，却是**合法的倚靠**（斜币的边缘
       * 搭在另一枚的币面上）。启发式会把它们全判成穿模，于是币堆一变硬就满屏误报。
       * 接触流形的 `contactDist` 是物理引擎自己算出来的穿透量，与姿态无关。
       */
      penetrationReport: (limitMillimeters: number) => this.penetrationReport(limitMillimeters),
      setTuning: (patch: Record<string, number | boolean>) => {
        Object.assign(this.tuning, patch);
        this.applyTuning();
        return { ...this.tuning, physics: this.physics.tuning };
      },
      /**
       * 直接写 `coinPhysics` 注册表——**不经调参表、不上滑块**。
       *
       * 存在的唯一理由：有些注册表键刻意不给滑块（`upwardBleedTau` 是「护栏以什么形状
       * 生效」的定义，不是手感旋钮），但它的 A/B 仍然必须能在**同一次页面加载**里换臂。
       * 换臂的另一条路是改 `constants.ts` ⇒ 整页刷新 ⇒ 进行中的验证批全部作废。
       *
       * 键名逐个校验（与 `requireSelectorKey` 同一条理由）：拼错的键会静悄悄写进一个
       * 不存在的属性，然后 A/B 的两条臂测的是同一个东西。
       */
      setCoinPhysics: (patch: Record<string, number>) => {
        for (const key of Object.keys(patch)) {
          if (!(key in coinPhysics)) {
            throw new Error(
              `未知的硬币物理键「${key}」。可用键：${Object.keys(coinPhysics).join(', ')}`,
            );
          }
        }
        Object.assign(coinPhysics, patch);
        return { ...coinPhysics };
      },
      // ── 音频调试 ──────────────────────────────────────────────────────
      // 这组钩子与调试面板共用同一条路径（`audioCatalog` 的事件表），
      // 所以脚本能试听到与面板完全一致的东西。
      soundNames: () => audioEventNames(),
      sound: (name: string) => auditionEvent(this.audio, name),
      soundInfo: (name?: string) => {
        const snapshot = this.audio.debug;
        if (name === undefined) {
          return {
            ...snapshot,
            events: AUDIO_EVENTS.map((event) => ({
              name: event.name,
              label: event.label,
              selector: event.selector,
              mountable: event.selector !== null,
              mounted: event.selector !== null && this.audio.hasOverride(event.selector),
            })),
          };
        }
        const event = findAudioEvent(name);
        if (!event) return null;
        const info = event.selector
          ? this.audio.selectorInfos().find((entry) => entry.key === event.selector)
          : null;
        return {
          name: event.name,
          label: event.label,
          selector: event.selector,
          mountable: event.selector !== null,
          mounted: event.selector !== null && this.audio.hasOverride(event.selector),
          gain: info?.gain ?? null,
          throttleMs: info?.throttleMs ?? null,
          samples: info ? [...info.samples] : [],
        };
      },
      setSoundGain: (selector: string, value: number) => {
        const key = this.requireSelectorKey(selector);
        return { selector: key, gain: this.audio.setGain(key, value) };
      },
      clearSoundOverride: (selector?: string) => {
        const key = selector === undefined ? undefined : this.requireSelectorKey(selector);
        return { cleared: this.audio.clearOverride(key) };
      },
      /**
       * 从 URL 拉一个音频文件解码后挂到槽位。
       *
       * 这是 GUI 之外的能力，专供脚本化验证：不用真的去操作 `<input type=file>`，
       * 就能把「挂载 → 事件走 override 路径」这条链跑通。
       */
      overrideSoundFromUrl: async (selector: string, url: string) => {
        const key = this.requireSelectorKey(selector);
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const bytes = await response.arrayBuffer();
        const buffer = await this.audio.decodeFile(new File([bytes], url));
        this.audio.overrideSelector(key, buffer, url);
        return { ok: true, selector: key, name: url, duration: buffer.duration };
      },
      table: () => {
        const summary = layoutSummary(this.config.layout);
        return {
          name: this.config.name,
          coins: this.config.layout.length,
          value: layoutValue(this.config.layout),
          // 按币种计数：`byKind` 是 P6 之后的通路口径（新增币种自动出现），
          // bronze/pattern/payout 三个旧字段保留给既有判据读。
          byKind: { ...summary.byKind },
          // 币种清单也一并给出：判据用「byKind 的键集 == kinds」来核对，
          // 这样新增币种时判据自动跟上，不用在测试脚本里再抄一份名单。
          kinds: [...COIN_KINDS],
          bronze: this.config.layout.filter((coin) => coin.kind === 'bronze').length,
          pattern: this.config.layout.filter((coin) => coin.kind === 'pattern').length,
          payout: this.config.layout.filter((coin) => coin.kind === 'payout').length,
          /**
           * 上层台面（推板顶面）与币床的预置枚数。
           *
           * 补币判据要它：`bedCoins` 的口径是「币床上的币」，而 `activeCoins` 含上层台面，
           * 所以「`bedCoins < activeCoins`」这条守卫必须能说出**差在哪里**——
           * 差值应当 ≈ `deck` + 在途币。差得离谱就说明口径写错了（例如把上层也算进来了）。
           */
          deck: summary.deck,
          bed: summary.bed,
          /**
           * 盘面**容量**：把稀疏铺去掉后这份配置能放多少枚。
           *
           * 判据用它算「填充率」。**不要**拿它当「满盘应当多少枚」——
           * 满盘枚数随币尺寸档位下降，而填充率不随。见 `layoutCapacity()`。
           */
          capacity: endlessCapacity(),
        };
      },
      /**
       * 币的几何派生量（S13）：**验证脚本的唯一真源**。
       *
       * 存在的理由（纪律 2「判据不写第二份公式」）：脚本里原先手抄了一串
       * `0.12`（币径）、`0.0212`（层高）、`0.005`（抖动）之类的常量，
       * 而 `?coin=1.1/1.2` 会把这些**全部**改掉。手抄的那份不会跟着变，
       * 于是判据在别的档位下会**假绿**——拿旧尺寸去量新币，怎么看都合格。
       * 所以脚本一律改读这个钩子，把手抄常量删掉。
       *
       * `mass` 一并给出：`Mechanisms` 的定值冲量必须按质量比（`k³`）补偿，
       * 判据要能算出「同样的冲量在别的档位下给出多少 Δv」。
       */
      coinGeometry: () => ({
        scale: COIN_SCALE,
        radius: COIN.radius,
        halfThickness: COIN.halfThickness,
        diameter: COIN.radius * 2,
        /** 单层高度步距（币厚 + 余量）。 */
        layerStep: LAYER_STEP,
        /** 台面上币心的静置高度。 */
        restY: REST_Y,
        maxJitter: MAX_JITTER,
        /** 自检的同层最小间距判据：币径 × 0.98。 */
        minSpacing: MIN_SPACING,
        /** 网格步距下限：`minSpacing + 2 × maxJitter`。区域列/行数由它反算。 */
        minStep: MIN_STEP,
        /** 单枚币的质量（千克）：πr² × 2h × ρ。定值冲量的补偿基准。 */
        mass: Math.PI * COIN.radius ** 2 * COIN.halfThickness * 2 * coinPhysics.density,
        // ⚠️ 以下四项一律读 `coinPhysics` 注册表，**不是** `COIN.*` 常量。
        // 这份钩子自称「派生量唯一真源、脚本不准手抄」，那就必须反映调参后的实际值；
        // 读常量会让脚本在调试面板改过之后拿到陈旧数据，判据**假绿**。
        density: coinPhysics.density,
        friction: coinPhysics.friction,
        restitution: coinPhysics.restitution,
        linearDamping: coinPhysics.linearDamping,
        angularDamping: coinPhysics.angularDamping,
        /** 台面输送带的高度上界与当前速度（`?debug` 面板可实时改）。下界见 `isOnDeckAt`。 */
        conveyor: {
          maxY: TABLE.conveyor.maxY,
          speed: this.tuning.conveyorSpeed,
        },
        /** 推板顶面高度（上层台面的基准 y）。 */
        pusherTopY: TABLE.pusherTopY,
        /**
         * 推板行程，以及推币面的 z 区间（归位 → 全伸）。
         *
         * 为什么把它放进这份「派生量真源」（纪律 2「判据不写第二份公式」）：
         * `accept` ④ 要判「币离开台面的位置贴合推板前缘，且不同时机的落点确实不同」，
         * 而**「不同」的尺度只能是推板行程本身**。那条判据原先写死 `spread > 0.3`，
         * 是按 `conveyor = 0.85` 标定的：那时台面币被输送带在 ~1 秒内送到前唇，
         * 落点能落在整个行程里的任意一点。`conveyor` 归零之后离台**只发生在回撤的
         * 前半段**（见 `runTimingCheck` 的注释），实测跨度 0.145 米 = 行程的 40%，
         * 写死的 0.3 永远够不到。改成「行程的比例」之后，改行程不会让判据失真。
         *
         * ⚠️ 读 `this.pusher.travel` 而不是 `TABLE.pusherTravel`：后者是**出厂常量**，
         * 面板改过行程之后它就是陈旧的——上面这段「改行程不会让判据失真」的承诺
         * 只有在读运行时值时才成立。
         */
        pusherTravel: this.pusher.travel,
        pusherFrontZ: {
          rest: TABLE.pusherFrontZAtRest,
          extended: TABLE.pusherFrontZAtRest + this.pusher.travel,
        },
        /**
         * 落币口。判据要用它来定位**落币走廊与钉阵**。
         *
         * `accept` ⓪ 的探针点原先写死 `(0, 1.16, −0.72)` —— 那个 z 就是旧的落币口。
         * 2026-09-25 落币口后移到 `−1.20` 之后，探针会探空，读出来的是
         * 「钉子碰撞体半长种类数 = 0」，判据**红在别的地方**，很容易被误判成钉子本身坏了。
         * 所以口径一律从引擎读。
         */
        drop: { y: TABLE.drop.y, z: TABLE.drop.z, halfLane: TABLE.drop.halfLane },
        /** 速度护栏，判据拿它当「求解器有没有造能量」的阈值。 */
        maxSpeed: coinPhysics.maxSpeed,
        maxUpwardSpeed: coinPhysics.maxUpwardSpeed,
      }),
      /**
       * 某个 (x, z) 是否落在币床前侧角的排水口里（含抖动余量）。
       *
       * 暴露它的理由（纪律 2「判据不写第二份公式」）：`physics` ⑤ 要判「币床的币
       * 坐在台面上」，而**掉进排水口的币本来就该在地板高度以下**——它们正在被
       * 这张桌子合法地回收。判据必须把这一块排除掉，而排除的口径只能来自
       * 引擎自己的 `insideDrain`（真源是 `DRAIN_FOOTPRINT`，含 `MAX_JITTER` 退让）。
       * 在脚本里另抄一个 `|x| > 0.66 && z ∈ [0.98, 1.15]` 就是第二份公式，
       * 它不会跟着 `DRAIN` / `MAX_JITTER` 一起改，下一次调洞就会假红或假绿。
       */
      insideDrain: (x: number, z: number) => insideDrain(x, z),
      /**
       * 某个世界坐标是否落在**上层台面的体积**里（与 `Game.isOnDeck` 同一份判据）。
       *
       * 暴露它的理由与 `insideDrain` 同：验证脚本要按「台面 / 币床」分桶统计，
       * 而**分桶口径必须来自引擎**。S13 之前脚本用 `deckY()`（一个高度中点）近似，
       * 那在塔顶高过台面之后会把塔上的币算进台面 —— 读数看着正常，其实是假的。
       * 现在塔能盖到 9 层（塔顶 0.216 > 高度中点 0.177），这条口径必须精确。
       *
       * `z` 用**当前**推板行程（`pusher.topRange`），所以前缘被推出去的币仍算台面币。
       */
      isOnDeckAt: (x: number, y: number, z: number) =>
        isOnDeckVolume(x, y, z, this.pusher.topRange),
      /**
       * V2：材质族统计（toon / standard / basic / other）+ 色带数 + 已编译程序数。
       * 见 `materialReport()` 的注释：这三项都是「只能靠计数发现的静默缺陷」。
       */
      materialReport: () => {
        const base = this.materialReport();
        // S18：把 draw call 顺路带上，cabinet-tex 模式可以读到。
        // ★ 读**自己按帧累计的两份**，不读 `renderer.info`：两遍出画之后那里
        //   只剩最后一遍的 1 次调用 / 2 个三角形，判据会绿得毫无意义。
        (base as unknown as Record<string, unknown>).renderer = {
          calls: this.frameDrawCalls,
          triangles: this.frameTriangles,
          sceneCalls: this.sceneDrawCalls,
          max: this.rendererPeakDrawCalls,
        };
        return base;
      },
      /**
       * G3-a：回读通道附件，量「面 ID 能不能分开**真正相邻**的物体」。
       *
       * 这条读数是 G3 全部阈值的地基。参考笔记 §6 第 4 条一直标着 `待验证`，
       * 理由写得很清楚：ID 是 `fract()` 出来的连续标量，量化到 8 位之后
       * 「两个相邻物体的可分差」可能小于噪声 —— 而**判据要按可分差设计，不是按
       * 「看起来有描边」设计**。抄参考的数值不行：他的场景尺度（树/叶子）与我们
       * 的（一米级柜体 + 几厘米的币）完全不同。
       */
      gbufferReport: () => this.gbufferReport(),
      /**
       * 招牌显示屏的**实测读数**（R3-U4）。
       *
       * 屏是第 8 个外壳网格，但**故意不带** `userData.part` / `role`：换肤与贴图分发
       * 都按这两个字段找件，屏两者都不吃。代价是 `cabinetReport()` 那 7 件看不见它 ——
       * 没有这个通道，「屏到底在不在、贴没贴上、有没有吃自己的纹理」就只能盯截图。
       */
      marqueeReport: () => {
        const mesh = this.tableGroup?.getObjectByName('marqueeScreen') as THREE.Mesh | undefined;
        if (!mesh) return null;
        const texture = marqueeScreen().texture;
        const material = mesh.material as THREE.MeshToonMaterial;
        const size = (mesh.geometry as THREE.PlaneGeometry).parameters;
        const world = mesh.getWorldPosition(new THREE.Vector3());
        return {
          width: size.width ?? 0,
          height: size.height ?? 0,
          // 纹理自己的尺寸：判据要的是「纹理宽高比 == 面板宽高比」这条**比值相等**关系，
          // 而不是某个写死的 4:1（做满之后面板比例是几何算出来的，会随 `?model` 变）。
          textureWidth: marqueeScreen().texels.width,
          textureHeight: marqueeScreen().texels.height,
          // 画布上出现过的不同颜色数：LED 面板本该是个位数，抗锯齿灰边会把它推到几百。
          distinctColors: marqueeScreen().distinctColors,
          world: [world.x, world.y, world.z] as [number, number, number],
          materialName: material.name,
          mapIsScreen: material.map === texture,
          emissiveMapIsScreen: material.emissiveMap === texture,
          offsetX: Number(texture.offset.x.toFixed(4)),
        };
      },
      /**
       * 播一条招牌屏字幕（与玩法里的 `announce()` 同一条路径）。
       *
       * 存在的理由很具体：屏的**两行态**（亮色账本行 + 暗色字幕行）原来只有玩法事件能触发
       *（老虎机开奖、机关提示），于是「两行时画布还剩几种颜色」这件事在测试里根本测不到 ——
       * 判据只能给单行态留余量。补上这个钩子之后，两行态是一个**可主动进入的状态**。
       */
      marqueeSubtitle: (message: string): void => {
        // 刻意**不**回读 `distinctColors`：重画是节流的（≤8 fps），这一行立刻读到的
        // 还是上一帧的调色板 —— 返回一个看着像结果的旧数，比不返回更容易骗人。
        marqueeScreen().subtitle(message);
      },
      /**
       * 已编译程序的**指纹名单**（R2-T2）。
       *
       * `perf` 原来只断言「程序数 < 30」。那条判据从 20 涨到 29 都还是绿的，
       * 而「谁多要了一份程序」完全读不出来 —— 加参数的人只能猜，守门的人只能看总数。
       * 这里把 `renderer.info.programs` 的 cacheKey 折叠成**可读指纹**并按指纹分组：
       * 程序数一旦变化，跑一次 `perf` 就能看到多出来的是哪一行。
       *
       * cacheKey 里一半以上是 `true` / `false` 的布尔位，读起来全是噪声；丢掉它们之后剩下的
       * 就是有语义的部分（shader 组合、`SD|DETAIL|KIND`、`uv`、`customProgramCacheKey` 的
       * `toon-ramp-v1`）。⚠️ 序号**要留**：丢掉数字会把四种 detail 纹样折叠成同一行指纹，
       * 而「哪种纹样多要了一份程序」恰恰是这里要看的东西。
       */
      programRoster: (): Array<{ fingerprint: string; variants: number }> => {
        const groups = new Map<string, number>();
        for (const program of this.renderer.info.programs ?? []) {
          const key = String((program as unknown as { cacheKey?: string }).cacheKey ?? '');
          const fingerprint = key
            .split(',')
            .filter((token) => token !== '' && token !== 'true' && token !== 'false')
            .join(',');
          groups.set(fingerprint, (groups.get(fingerprint) ?? 0) + 1);
        }
        return [...groups.entries()]
          .map(([fingerprint, variants]) => ({ fingerprint, variants }))
          .sort((a, b) => b.variants - a.variants || a.fingerprint.localeCompare(b.fingerprint));
      },
      /**
       * 机柜外壳**实测读数**（S19）：逐件给出世界轴对齐盒 + 那件局部 +z 的世界方向。
       *
       * 判据（`verify-game.mjs cabinet`）拿它比对 `game/cabinetShape.ts` 里的
       * `cabinetPartBox()`。★ 为什么必须开这个通道：S18 那次「实心砖」之所以
       * `perf` / `drawcall` / `programs` / `cabinetTex` / `models` **全绿**通过，
       * 就是因为没有任何办法把「场景里的几何长什么样」读出来 —— 尺寸全在
       * `buildCabinetShell` 的函数体里，判据只能手抄第二份公式。
       *
       * 返回里的 `normal` 是**局部 +z** 的世界方向，也就是件的「正面法线」。
       * 招牌靠它判朝向：S18 把倾角符号写反，招牌正面朝了地面，
       * 而那件事**任何计数型判据都看不见**。S21 删招牌之后它改判檐板正面（法线 ≈ +z）。
       *
       * ## `profile`：包围盒内部那些**斜边**的唯一观测通道（S21）
       *
       * S21 的侧墙有两处斜边（檐板托的斜接面、低段的斜顶），它们**整个落在包围盒内部**
       * ⇒ 解析盒比对看不到，写平了也是全绿。所以这里额外把每件几何的**顶点集合**
       * 投影到 (y, z) 平面去重后带出来，由判据与 `cabinetWallOutline()` 的折线比对。
       *
       * 去掉 x 是有意的：轮廓沿 x 挤出，同一组 (y, z) 在两个端面上各出现一次，
       * 投影后自然合并成一份；坐标先量化到 1e-4 米（float32 的舍入在 1.7e-7 量级，
       * 差四个数量级，量化不会把两个不同的顶点并成一个）。
       */
      cabinetReport: () => {
        const out: Array<{
          part: string;
          role: string | null;
          min: [number, number, number];
          max: [number, number, number];
          normal: [number, number, number];
          profile: Array<[number, number]>;
          /**
           * 这件**吃不吃倒角**（S25）。由 `cabinetBoxMesh()` 亲手挂进 `userData`，
           * 也就是「几何会不会理你」的同一个事实 —— 判据据此断言「剖面挤出件改了倒角
           * 顶点数不许变」，而不是再抄一份直角盒名单。
           */
          bevelable: boolean;
          /**
           * 顶点数（S25）：倒角唯一**看得见**的观测通道。
           *
           * ⚠️ 半径**没有**任何观测通道 —— `RoundedBoxGeometry` 始终把外尺寸做满，
           * 包围盒一格不变（`cabinet` 判据的「解析盒 = 实测盒」正是靠这一点才不会被
           * 倒角搞红）。所以「面板拖了到底生没生效」只能数顶点：分段数一变顶点必变，
           * 半径那一条要靠 `?model` 的截图人眼核。
           */
          vertices: number;
          /**
           * 这件挂的**材质实例名**与 `map` 的 uuid（S25 / R1-M3 新增，无 map 时为 null）。
           *
           * 为什么判据需要它：`cabinetMapCount()` 只数「全场带 map 的材质有几份」，
           * 那是个**总量**——币面贴图也算进去（实测 16），所以「侧板到底挂没挂上图」
           * 「侧板和背板是不是被刷成同一张」这类问题它一个都答不了。
           * 而这两件事恰恰是 `panelArt` 那份材质拆分的**全部意义**：
           * 拆坏了（并回 `panel`）就是背板也被画满灯位，零报错。
           */
          material: string | null;
          map: string | null;
          glow: string | null;
        }> = [];
        const vertex = new THREE.Vector3();
        this.tableGroup?.traverse((child) => {
          const mesh = child as THREE.Mesh;
          if (mesh.isMesh !== true) return;
          const part = mesh.userData.part as string | undefined;
          if (!part) return;
          mesh.updateWorldMatrix(true, false);
          const box = new THREE.Box3().setFromObject(mesh);
          const normal = new THREE.Vector3(0, 0, 1).transformDirection(mesh.matrixWorld).normalize();

          // (y, z) 顶点集合：量化去重 + 排序，顺序无关（比对的是集合）。
          const seen = new Set<string>();
          const profile: Array<[number, number]> = [];
          const position = mesh.geometry?.getAttribute?.('position');
          if (position) {
            for (let i = 0; i < position.count; i += 1) {
              vertex.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld);
              const y = Math.round(vertex.y * 1e4) / 1e4;
              const z = Math.round(vertex.z * 1e4) / 1e4;
              const key = `${y},${z}`;
              if (seen.has(key)) continue;
              seen.add(key);
              profile.push([y, z]);
            }
            profile.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
          }

          out.push({
            part,
            role: (mesh.userData.role as string | undefined) ?? null,
            min: [box.min.x, box.min.y, box.min.z],
            max: [box.max.x, box.max.y, box.max.z],
            normal: [normal.x, normal.y, normal.z],
            profile,
            bevelable: mesh.userData.bevelable === true,
            vertices: mesh.geometry?.getAttribute?.('position')?.count ?? 0,
            material: (mesh.material as THREE.Material | undefined)?.name ?? null,
            map:
              ((mesh.material as { map?: THREE.Texture | null } | undefined)?.map?.uuid ?? null),
            // 「贴图挂上了」≠「灯真的亮」：`emissiveMap` 才是让深色色带上的亮条活过来的
            // 那一环，漏了它画面照样「有图」但只剩暗斑 —— 本仓库最恨的静默失效。
            glow:
              (mesh.material as { emissiveMap?: THREE.Texture | null } | undefined)?.emissiveMap
                ?.uuid ?? null,
          });
        });
        return out;
      },
      /**
       * 外壳形状的**应用实例**读数（S24）。
       *
       * ★ 它不能用 `page.evaluate(import('/src/game/cabinetShape.ts'))` 代替：
       * Vite 给应用内的模块 URL 带了 HMR 查询串，裸 `import()` 拿到的是
       * **另一个模块实例** —— 实测把 `hood.valanceInnerZ` 改成 0.3 之后，
       * 那边读到的仍是 0.195、`isCabinetOverridden()` 仍是 false。
       * 用它验「覆盖层生效了吗」会**恒 false**（永远绿），等于没查。
       */
      cabinetShapeReport: () => {
        const boxes: Record<string, Box3Like> = {};
        for (const part of CABINET_SHELL_PARTS) boxes[part] = cabinetPartBox(part);
        return {
          overridden: isCabinetOverridden(),
          shape: cabinetShape() as unknown as Record<string, unknown>,
          parts: [...CABINET_SHELL_PARTS],
          boxes,
          outlines: {
            tall: cabinetWallOutline('tall').map(([z, y]) => [z, y]),
            low: cabinetWallOutline('low').map(([z, y]) => [z, y]),
          },
        };
      },
      /**
       * 模型模式（S24，`?model`）的测试钩子。
       *
       * 判据（`verify-game.mjs model`）只走这几个 —— 它们内部走的是
       * **与面板同一条路**（`setFieldForTest` → `onShapeChanged` → 重建整具外壳），
       * 而不是自己另造一具。两条路一旦分叉就会出现「面板上能用、判据红」
       * 这种没法解释的差异。
       *
       * 非 `?model` 下 `modelMode` 为 null ⇒ 一律回答「未启用」。
       */
      modelModeEnabled: () => this.modelMode?.enabled === true,
      modelModeDiffCount: () => this.modelMode?.diffCount() ?? -1,
      modelModeSelected: () => this.modelMode?.selectedPart() ?? null,
      modelModeSet: (path: string, value: number) => this.modelMode?.setFieldForTest(path, value),
      modelModeReset: () => this.modelMode?.resetForTest(),
      modelModeSelect: (part: string) => this.modelMode?.selectForTest(part) ?? false,
      modelModeOutlineCount: () => this.modelMode?.outlineCount() ?? -1,
      // 「挂了几条线」与「那些线在不在场景里」是两件事：前者查不出重建把
      // `ModelMode.shell` 换成游离节点这件事（见 `ModelMode.shellAttached()`）。
      modelModeShellAttached: () => this.modelMode?.shellAttached() ?? null,
      /**
       * V4：币面贴图的实际纹素与采样设置。
       * 把「贴图本身对不对」与「渲染对不对」切开——币的颜色链路有四层，
       * 只看截图没法定位是哪一层出的问题。
       */
      /**
       * S22：摄影机机位读数。
       *
       * 连同 `autoFit` 与 `cameraPeakOffset` 一起交出来，因为「手动动机位」最容易
       * 踩坏的就是 S17 那条铁律：`cameraPeakOffset` 必须恒为 0
       * （电机位之后 `cameraBase` 要跟着走，否则每一帧都在记「相机偏离了基准」）。
       */
      cameraReport: () => ({
        ...cameraRigReport(),
        autoFit: this.tuning.cameraAutoFit,
        cameraPeakOffset: this.cameraPeakOffset,
      }),
      /**
       * S22：改写机位。与调试面板的「摄影机」分组走**同一组纯函数**
       * （`placeCameraRig` / `syncCameraRigAngles`），不另开一条脚本专用通道 ——
       * 两条路一旦分叉就会出现「面板绿、脚本红」这类没法解释的差异。
       *
       * ★ 手动字段（角度 / 相机坐标 / 观察点）一旦出现就**交出所有权**
       * （`cameraAutoFit = false`），与面板 setter 里的 `takeOwnership()` 完全同义。
       * 不这样做的话，脚本摆完机位之后改 FOV 会被 `fitCamera()` 弹回默认视角，
       * 而面板上不会 —— 那正是「两条路分叉」。
       * 只给 `autoFit` 一项时不翻：否则「回到默认取景」（`{ autoFit: true }`）
       * 会把自己刚打开的开关关掉。
       */
      setCameraRig: (patch) => {
        const manual =
          patch.yawDeg !== undefined ||
          patch.pitchDeg !== undefined ||
          patch.distance !== undefined ||
          patch.camX !== undefined ||
          patch.camY !== undefined ||
          patch.camZ !== undefined ||
          patch.targetX !== undefined ||
          patch.targetY !== undefined ||
          patch.targetZ !== undefined;
        if (manual) this.tuning.cameraAutoFit = false;
        else if (patch.autoFit !== undefined) this.tuning.cameraAutoFit = patch.autoFit;
        // 先按取景框解一次（只在**要求**自动、且没有手动字段时），后面给的显式字段一律盖在它上面。
        if (patch.autoFit === true && !manual) {
          fitCameraRig(this.tuning.cameraFov, this.camera.aspect);
        }

        if (patch.targetX !== undefined || patch.targetY !== undefined || patch.targetZ !== undefined) {
          if (patch.targetX !== undefined) cameraRig.target.x = patch.targetX;
          if (patch.targetY !== undefined) cameraRig.target.y = patch.targetY;
          if (patch.targetZ !== undefined) cameraRig.target.z = patch.targetZ;
          // 观察点动了、相机没动 ⇒ 只有朝向变，所以是反解角度。
          syncCameraRigAngles();
        }
        if (patch.camX !== undefined || patch.camY !== undefined || patch.camZ !== undefined) {
          if (patch.camX !== undefined) cameraRig.position.x = patch.camX;
          if (patch.camY !== undefined) cameraRig.position.y = patch.camY;
          if (patch.camZ !== undefined) cameraRig.position.z = patch.camZ;
          syncCameraRigAngles();
        }
        if (patch.yawDeg !== undefined || patch.pitchDeg !== undefined || patch.distance !== undefined) {
          if (patch.yawDeg !== undefined) cameraRig.yaw = toRad(patch.yawDeg);
          if (patch.pitchDeg !== undefined) cameraRig.pitch = toRad(patch.pitchDeg);
          if (patch.distance !== undefined) cameraRig.distance = patch.distance;
          placeCameraRig();
        }

        this.applyCameraRigFromPanel();
        this.debugTools.refreshCameraControllers();
        // 带上 `autoFit`：不然脚本没法在一句话里验「手动字段是否顺手交出了所有权」
        // （面板那侧靠复选框显示，脚本没得看）。
        return { ...cameraRigReport(), autoFit: this.tuning.cameraAutoFit };
      },
      coinReport: () => this.coins.coinReport(),
      collection: () => ({
        balance: this.save.balance,
        coinSkins: [...this.save.snapshot.coinSkins],
        cabinetSkins: [...this.save.snapshot.cabinetSkins],
        selectedCoinSkin: this.save.snapshot.selectedCoinSkin,
        selectedCabinetSkin: this.save.snapshot.selectedCabinetSkin,
      }),
      clearSave: () => {
        this.save.clear();
        // 存档清了多少，内存态就同步多少——XIXI 是存档背书的进度，不同步就是假重置。
        this.xixi = [...this.save.snapshot.xixi];
        this.collection.refresh();
        this.applySkins();
        return { balance: this.save.balance };
      },
      /**
       * 往钱包里补筹码（测试/调试用）。
       *
       * 存在的理由：**验证脚本会在同一个会话里反复 `startRun`，而一局就是把余额投到底**，
       * 脚本跑几条用例就把余额见底，于是下一局以 0 起始开局 —— 引擎会正确地以
       * 「开局即破产」响应（见 `startRun` 的零余额分支）。
       * 那些用例测的是玩法而不是破产，所以在 `startRun` 之前先补满。
       *
       * 充值额记进 `SaveStore` 的 `totals.refill`（旧名 `refilled`），
       * 余额守恒算式把它算进去（`run()` / `ledger()` 两个钩子都暴露）。
       */
      // R4-4b 的生命周期自证用（见 `PhysicsWorld.countColliders` 为何不进 diagnostics）。
      countColliders: () => this.physics.countColliders(),
      /**
       * S5a 四同「力」的对账读数：待发的加长行程**发数** + 引擎侧那次排了几发。
       * 判据要能分清「四同真的排了 N 发」与「只排了一发普通加力」——
       * 这两件事在画面上只差几个循环，看截图是判不出来的。
       */
      boostQueue: () => ({
        strokes: this.pusher.pendingBoostStrokes,
        jackpotStrokes: RULES.jackpotBoostStrokes,
        travelBonus: this.pusher.boostTravelBonus,
      }),
      // R4-4b 的「汇」：演出窗口内越线的枚数，按出处分成「演出币 / 存量币」。
      showWindow: () => ({
        crossings: this.showWindowCrossings,
        foreign: this.showWindowForeign,
      }),
      refillWallet: (amount = 200) => {
        this.save.refillWallet(amount);
        this.publishHud();
        return { balance: this.save.balance, refilled: this.save.refilled };
      },
      /**
       * 贷一笔款（S2）。返回**实际到账额**——到上限时它小于请求额，甚至为 0。
       *
       * 与 `refillWallet` 刻意分成两个钩子：`refillWallet` 是**验证脚本发钱**（记进 `refilled`，
       * 守恒式要减掉它），`loan` 是**游戏机制发钱**（记进 `debt` 与 `loanedTotal`）。
       * 合成一个的话，钱包守恒那条判据就分不出「白给的」与「借的」，
       * 而 S2 的全部意义就在这两者的区别上。
       */
      loan: (amount?: number) => {
        const applied = this.save.loan(amount);
        this.publishHud();
        return {
          applied,
          balance: this.save.balance,
          debt: this.save.debt,
          ceiling: this.save.debtCeiling,
          loanedTotal: this.save.loanedTotal,
        };
      },
      /** 只读欠款状态（判据与调试用，不改任何账）。 */
      debt: () => ({
        debt: this.save.debt,
        ceiling: this.save.debtCeiling,
        loanedTotal: this.save.loanedTotal,
        repaidThisRun: this.run.repaid,
        offer: this.save.loanOffer,
      }),
      /**
       * 走一次「贷款续玩」（S3）。返回 false = 什么都没发生
       * （不在破产态，或欠款已到顶 ⇒ 破产弹窗上那个按钮本来就该是藏着的）。
       *
       * ★ 判据要拿它验的是**盘面枚数不变**：这条路径不调 `startRun()`，
       * 所以调用前后 `coins().length` 必须逐枚相同。那是本功能唯一近确定性的判据。
       */
      loanToContinue: () => {
        const before = {
          onDeck: this.coins.activeCount(),
          chips: this.run.chips,
          loaned: this.run.loaned,
        };
        const applied = this.loanToContinue();
        return {
          applied,
          before,
          after: { onDeck: this.coins.activeCount(), chips: this.run.chips, loaned: this.run.loaned },
          debt: this.save.debt,
          ceiling: this.save.debtCeiling,
        };
      },
      /**
       * 把钱包设成指定值（验证脚本用）。
       *
       * 存在的理由：**「钱包见底 → 开局筹码 0」那条死锁必须能被确定性地构造出来。**
       * 靠反复 `startRun` 把 200 扣完要跑十局、又慢又不稳；直接置零才是一步到位的
       * 冷路径判据。差额记进 `SaveStore.refilled`，守恒式照样精确。
       */
      setWallet: (amount: number) => {
        this.save.setWallet(amount);
        this.publishHud();
        return { balance: this.save.balance, refilled: this.save.refilled };
      },
      unlockSkin: (kind: string, id: string, cost: number) => {
        const unlocked = this.save.unlockSkin(kind as 'coin' | 'cabinet', id, cost);
        this.collection.refresh();
        return { unlocked, balance: this.save.balance };
      },
      selectSkin: (kind: string, id: string) => {
        const selected = this.save.selectSkin(kind as 'coin' | 'cabinet', id);
        if (selected) this.applySkins();
        this.collection.refresh();
        return { selected, coinSkin: this.save.snapshot.selectedCoinSkin, cabinetSkin: this.save.snapshot.selectedCabinetSkin };
      },
      enableTelemetry: () => {
        this.telemetry.enable();
        return { enabled: true };
      },
      telemetry: () => this.telemetry.summary(),
      /** P4 投放演出：统一入口。返回值含承诺数/降级标记，事件进 telemetry.showEvents。 */
      showRequest: (id: string, opts?: { count?: number; kind?: CoinKind; x?: number }) =>
        this.shows.request(id as ShowId, opts),
      /**
       * 纯视觉币通道的读数 + 统计清零（S16）。
       *
       * 为什么需要它：这条通道**故意不进任何账本**，所以「它到底跑没跑」
       * 在 `activeCoins` / `earned` / `drained` 上一个字都看不出来。
       * 判据要证明的三件事都只能从这里读：
       *   ① `launched > 0` —— 演出真的喷了视觉币；
       *   ② `peakYOutside >= 1.6` —— 币是**从玻璃顶沿之上**飞出去的，不是穿过围板；
       *   ③ `active === 0 && visible === false` —— 演出结束后全部回收，空闲不占 draw call。
       */
      sprayReport: (reset = false) => {
        const snapshot = this.spray.report();
        if (reset) this.spray.resetStats();
        return snapshot;
      },
      /** 视觉币的材质与铜币材质是否同 defines（判据：证明 0 新增程序）。 */
      sprayMaterial: () => {
        const spray = this.spray.currentMaterial;
        const bronze = this.coins.materialFor('bronze');
        return {
          spray: { ...(spray.defines ?? {}) },
          bronze: { ...(bronze.defines ?? {}) },
          /**
           * 两张贴图的 **uuid**（不是内容）。
           *
           * 判据用它对两件事：① 换肤 / 改分辨率之后视觉币的贴图**真的重建了**
           * （uuid 变了）；② 它与铜币那张是**两个实例**——
           * 共享同一个实例会让 `CoinPool.dispose()` 把视觉币的贴图一起释放掉，
           * 那是零报错的静默失效（币渲染成空）。
           */
          sprayMap: spray.map?.uuid ?? null,
          bronzeMap: bronze.map?.uuid ?? null,
        };
      },
      /**
       * S18：数 scene 里挂 `map` 通道的机柜部件材质数。
       *
       * 招牌 + 得分线 + 热区三件都挂了——剩 0 表示漏挂，剩 > 3 表示别处加了。
       */
      cabinetMapCount: () => {
        let count = 0;
        const seen = new Set<THREE.Material>();
        this.scene.traverse((child) => {
          if (!(child as THREE.Mesh).isMesh) return;
          const mesh = child as THREE.Mesh;
          const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          for (const entry of list) {
            if (!isLitMaterial(entry)) continue;
            if (seen.has(entry)) continue;
            seen.add(entry);
            if (entry.map) count += 1;
          }
        });
        return count;
      },
      /**
       * 装置规模表（枚数 / 最低交付）。
       *
       * 判据写「实发 = 承诺」时必须**读这张表**而不是手抄数字——
       * S6 把塔从 1 枚改到 16 枚是配置变更，不是回归。
       */
      showSpecs: () => ShowDirector.showSpecs(),
      /**
       * 「加力已存满」的兜底配置（P10 ⑨）。
       *
       * 判据同样**从引擎读**：兜底用哪个装置、发几枚都是可调的平衡旋钮，
       * 抄进脚本就成了第二份真源。
       */
      boostOverflowSpec: () => ({ ...BOOST_OVERFLOW_FALLBACK, cap: RULES.boostStoreCap }),
      /**
       * 自动补币的配置（P10 ⑦）。
       *
       * 判据**从引擎读阈值**，不在脚本里手抄 180 / 8 / 7：那些是可调的平衡旋钮，
       * 抄一份到测试里，S11 标定时判据就会开始骗人（改配置却报红，或者更糟——
       * 配置改了判据还在用旧值，于是它测的根本不是线上那套数）。
       */
      refillSpec: () => ({ ...REFILL, budget: COIN.budget }),
      /**
       * 得分反馈分级（P10 ⑨）。
       *
       * 判据**从引擎读阈值**（飞字大号 25 / 连落 3 脉冲 / 连落 5 白闪），
       * 不在脚本里手抄——S11 标定时会调它们，抄一份到测试里就会开始骗人。
       * 峰值一并给出：判据要核对「脉冲确实到了峰值」而不是只涨了一点点。
       */
      feedbackSpec: () => ({
        ...FEEDBACK,
        emissive: { ...FEEDBACK_EMISSIVE },
      }),
      /**
       * 反馈分级的**纯函数**（判据枚举边界点，不重写分支）。
       *
       * 输入只给「筹码 / 连落 / 是否热区 / 币种」，`kindClimax` 由引擎自己
       * 从 `kindSpec()` 取——币种的高潮定义单一真源在 `kinds.ts`，
       * 让测试传进来等于把它抄成第二份。
       */
      crossingFeedbackProbe: (input: {
        chips: number;
        combo: number;
        hot: boolean;
        kind?: string;
        blocked?: boolean;
      }) =>
        crossingFeedback({
          chips: input.chips,
          combo: input.combo,
          hot: input.hot,
          kindClimax: kindSpec((input.kind ?? 'bronze') as CoinKind).climax,
          blocked: input.blocked,
        }),
      /**
       * 反馈的**实时状态**：计数 + 三个材质的自发光。
       *
       * 计数与画面同源（都由 `crossingFeedback()` 的结果驱动），所以判据读它们
       * 就能同时证明「分支走对了」与「视觉真的动了」——只读计数会漏掉
       * 「计数在涨但材质没接上」这种半接线状态。
       */
      feedbackReport: () => this.feedbackReport(),
      /**
       * 直接走一次飞字（测试用）：坐标是合成的，**代码路径是真的**
       * （`Hud.flyScore` + `flyTier` 的分档判定）。
       *
       * 存在的理由：`chips ≥ 25` 的入账要靠高价值币越线才出得来，
       * 而「大号飞字有没有生效」不该等一枚钻石走到线上才能验。
       */
      flyScoreProbe: (chips: number) => {
        const tier = flyTier(chips);
        // ★ **刻意不动 `feedbackCounts`**：计数属于引擎那条路（`settleCrossing`），
        //   这条探针只验表现层（`Hud.flyScore` 有没有按档位画）。
        //   两者混在一起之后，「真实对局里出了几次大号飞字」就再也说不清了。
        this.hud.flyScore(640, 360, chips, tier);
        return {
          tier,
          datasetTier: document.querySelector('#hud')?.getAttribute('data-last-fly-tier') ?? null,
        };
      },
      /** XIXI 槽位映射（引擎纯函数）：判据枚举调用它收成集合，不在测试里手写分段。 */
      xixiSlot: (x: number) => xixiSlot(x),
      /**
       * 直接设定 XIXI 四槽的亮灭（测试用）。
       *
       * 存在的理由：四槽要**真的投中**才会亮，而「哪个落点进哪个槽」是物理决定的，
       * 想凑出「槽 0 与槽 2 亮、槽 1 与 3 灭」这种指定组合得投很多枚。
       * 这条路径只改渲染状态（`this.xixi` + 推板标牌），不碰存档、不碰遥测。
       */
      setXixi: (slots: boolean[]) => {
        this.xixi = slots.map(Boolean).slice(0, 4);
        while (this.xixi.length < 4) this.xixi.push(false);
        this.publishHud();
        return this.pusher.xixiLaneReport();
      },
      /** 推板前缘 XIXI 标牌的实际颜色（判据按计数比对，不看截图）。 */
      xixiLanes: () => this.pusher.xixiLaneReport(),
      /**
       * 直接摇一次背板老虎机（可指定符号）。
       * 奖励路径必须可逐一指定验证：「力力力→加力入账且 earned 不动」、
       * 「塔塔塔→ShowDirector 登记」，不能靠权重随机去赌。
       */
      xixiSpin: (forced?: string, tier?: SlotTier | null) => {
        // ⚠️ `?? 3` 而不是直接把 `tier` 传下去：TS 的默认参数只在 `undefined` 时生效，
        // 而脚本从页面外面传进来的是 `null` —— 不夹的话强制三同会摇出一个 `tier: null` 的结果，
        // 四同分支判断 `tier === 4` 为假、时间轴判断也跟着走空。
        const result = this.slotMachine.spin(
          forced as SlotSymbol | 'fine' | 'miss' | undefined,
          tier ?? 3,
        );
        if (!result) return null;
        return {
          kind: result.outcome.kind,
          symbol: result.outcome.kind === 'win' ? result.outcome.symbol : undefined,
          tier: result.outcome.kind === 'win' ? result.outcome.tier : undefined,
          faces: this.slotMachine.reelWindowReport().faces,
        };
      },
      /** 滚筒窗读数（与诊断同一个读数，见 `reelDiagnostics`）。 */
      reelWindowReport: () => this.reelDiagnostics(),
      /** 像素图标图集的读数：来源、尺寸、每格调色板大小。 */
      iconReport: () => iconReport(),
      /**
       * 结果表的实测分布：把 `rollSlotOutcome` 在 `[0,1)` 上均匀枚举。
       *
       * ★ S5a：计数桶**按权重表的键开**（`SLOT_OUTCOME_KEYS`），并把权重表本身与
       * 符号数一起吐出去 ⇒ 判据拿「枚举出来的比例」对「引擎自己的表」，
       * 测试里不再出现 45/15/40 与「5 个符号」这类第二份事实。
       * 加一档（win4）或改权重，判据自己跟上；反过来**表写漏一格也会当场红**
       * （计数键不在表里 → Σcounts ≠ samples）。
       */
      slotOdds: (samples = 2000) => {
        const total = Math.max(1, Math.floor(samples));
        const counts: Record<string, number> = {};
        for (const key of SLOT_OUTCOME_KEYS) counts[key] = 0;
        const symbols: Record<string, number> = {};
        const tier4SymbolsSeen: Record<string, number> = {};
        /**
         * `detailRoll` 走**独立的确定性 LCG**（不引入 `Math.random`：判据要可复现）。
         *
         * ⚠️ 不能两个 roll 都用 `i / total`：那样「中奖摇哪个符号」与分类完全相关，
         * 枚举一遍只会摇出同一个符号（实测：2000 次全是 boost，看起来像「符号表只有一项」）。
         * 分类比例要精确 → `roll` 等距枚举；符号分布要真实 → `detailRoll` 伪随机。
         */
        let seed = 0x2545f491;
        const nextDetail = () => {
          seed = (seed * 1103515245 + 12345) & 0x7fffffff;
          return seed / 0x80000000;
        };
        for (let i = 0; i < total; i += 1) {
          const outcome = rollSlotOutcome(i / total, nextDetail());
          counts[outcomeWeightKey(outcome)] += 1;
          if (outcome.kind === 'win') {
            symbols[outcome.symbol] = (symbols[outcome.symbol] ?? 0) + 1;
            if (outcome.tier === 4) {
              tier4SymbolsSeen[outcome.symbol] = (tier4SymbolsSeen[outcome.symbol] ?? 0) + 1;
            }
          }
        }
        return {
          samples: total,
          counts,
          symbols,
          weights: { ...SLOT_OUTCOME_WEIGHTS },
          totalWeight: outcomeTotalWeight(),
          /** 符号池大小由引擎给：判据断「无死项」时读它，不写 5。 */
          symbolCount: SLOT_SYMBOL_WEIGHTS.length,
          /** 四同池成员与**枚举里真的摇到过的符号**：判据据此核「池里没有死项、池外没人混进来」。 */
          tier4Symbols: [...SLOT_TIER4_SYMBOLS],
          tier4SymbolsSeen,
        };
      },
      /**
       * 停格画面的枚举：给定结果，`reelFacesFor` 沿 `detailRoll` 轴扫一遍。
       * 判据用它核「win/fine 四连、miss 两两不同」，不在测试里重写这段规则。
       */
      reelFaces: (kind: string, symbol?: string, tier?: SlotTier) => {
        const outcome: SlotOutcome =
          kind === 'fine'
            ? { kind: 'fine' }
            : kind === 'miss'
              ? { kind: 'miss' }
              : { kind: 'win', symbol: (symbol ?? 'boost') as SlotSymbol, tier: tier ?? 3 };
        const out: string[][] = [];
        for (let i = 0; i < 25; i += 1) out.push(reelFacesFor(outcome, i / 25));
        return out;
      },
    };
  }

  /** 调试用：列出指定点附近的碰撞体实际世界位置。 */
  private probeColliders(x: number, y: number, z: number): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    const radius = 0.6;
    this.physics.world.colliders.forEach((collider) => {
      const t = collider.translation();
      const dx = t.x - x;
      const dy = t.y - y;
      const dz = t.z - z;
      if (Math.hypot(dx, dy, dz) > radius) return;
      const r = collider.rotation();
      const shape = collider.shape as unknown as {
        type: number;
        halfExtents?: () => unknown;
        halfHeight?: number;
        radius?: number;
      };
      out.push({
        handle: collider.handle,
        isSensor: collider.isSensor(),
        t: [round3(t.x), round3(t.y), round3(t.z)],
        q: [round3(r.x), round3(r.y), round3(r.z), round3(r.w)],
        shapeType: shape.type,
        half: typeof shape.halfExtents === 'function' ? shape.halfExtents() : null,
        // 圆柱（钉子）：halfHeight 是沿自身 y 轴的半长，配合 q 的旋转可还原世界长度。
        cylinder:
          typeof shape.halfHeight === 'number'
            ? { halfHeight: shape.halfHeight, radius: shape.radius ?? null }
            : null,
      });
    });
    return out;
  }

  /**
   * 调试/试玩用：采样活跃币的位置与速度。
   *
   * `slot` 是对象池里的固定槽位号——`forEachActive` 会跳过停用的币，
   * 数组下标会被压缩，只有槽位号才能跨帧稳定标识同一枚币。
   */
  private sampleCoins(): Array<{
    slot: number;
    kind: string;
    x: number;
    y: number;
    z: number;
    vz: number;
    speed: number;
    /**
     * 币面法线（圆柱轴）与竖直方向的夹角，单位度。0 = 平躺。
     *
     * 验证脚本判「穿模」时要靠它：两枚币心在竖直方向只差几毫米、横向又只差几厘米，
     * **平躺**的两枚是真的挤穿了，而**倾斜**的那枚是搭在邻居的币边上——
     * 后者是真实币堆的正常形态，只看坐标会把它们混为一谈。
     */
    tiltDeg: number;
    /**
     * 物理体是否处于「睡眠」状态。
     *
     * 睡眠会**冻结穿透修正**：Rapier 只对活跃体做位置修正，一旦在互相嵌入的
     * 状态下睡着，穿透就永久留在那里（速度是 0，所以「静止」断言照样通过）。
     * 诊断穿模必须能区分「静止的合法姿态」与「睡着了冻住的穿透」。
     */
    sleeping: boolean;
    playerDropped: boolean;
    preset: boolean;
  }> {
    const out: Array<{
      slot: number;
      kind: string;
      x: number;
      y: number;
      z: number;
      vz: number;
      speed: number;
      tiltDeg: number;
      sleeping: boolean;
      playerDropped: boolean;
      preset: boolean;
    }> = [];
    this.coins.coins.forEach((coin, slot) => {
      if (!coin.active) return;
      const p = coin.position;
      const r = coin.body.rotation();
      // 把局部 +Y 用四元数转到世界系，再与 (0,1,0) 取夹角。
      const upY = 1 - 2 * (r.x * r.x + r.z * r.z);
      const tiltDeg = (Math.acos(Math.min(1, Math.max(-1, upY))) * 180) / Math.PI;
      out.push({
        slot,
        kind: coin.kind,
        x: round3(p.x),
        y: round3(p.y),
        z: round3(p.z),
        vz: round3(coin.body.linvel().z),
        // 合速度：静置断言要的是「真的不动了」，只看 vz 会漏掉横向漂移。
        speed: round3(coin.speed()),
        tiltDeg: round1(tiltDeg),
        sleeping: coin.body.isSleeping(),
        playerDropped: coin.playerDropped,
        preset: coin.preset,
      });
    });
    return out;
  }

  /**
   * 把外部传进来的字符串窄化为 `SelectorKey`。
   *
   * 控制台钩子的参数是普通字符串（从 `page.evaluate` 传进来），而 `AudioSystem` 的
   * 调试接口要的是字面量并集。这里做一次**显式校验**而不是直接 `as SelectorKey`：
   * 强转会让拼错的槽位名悄悄写进一个不存在的键，排查起来很费劲。
   */
  private requireSelectorKey(value: string): SelectorKey {
    if (!(value in SELECTORS)) {
      throw new Error(
        `未知的音效槽位「${value}」。可用槽位：${Object.keys(SELECTORS).join(', ')}`,
      );
    }
    return value as SelectorKey;
  }

  /**
   * 把 `tuning` 里的一切落到实际系统上。调试面板与验证脚本的 `setTuning` 共用这一条路径，
   * 免得出现「面板改了但某个子系统没跟上」的半生效状态。
   */
  private applyTuning(): void {
    this.renderer.toneMappingExposure = this.tuning.exposure;
    this.audio.setMuted(this.tuning.muted);
    this.pusher.travel = this.tuning.pusherTravel;
    // 相位时长与加力比例是**每帧现读**的实例字段，写进去就当场生效
    // （与 `travel` 的「按行程锁存」不同，见 `Pusher.durations` 的注释）。
    this.pusher.durations = {
      extend: this.tuning.pusherExtendSec,
      holdFront: this.tuning.pusherHoldFrontSec,
      retract: this.tuning.pusherRetractSec,
      holdBack: this.tuning.pusherHoldBackSec,
    };
    this.pusher.boostTravelBonus = this.tuning.boostTravelBonus;
    this.physics.applyTuning({
      gravity: this.tuning.gravity,
      solverIterations: this.tuning.solverIterations,
      erp: this.tuning.erp,
      predictionDistance: this.tuning.predictionDistance,
    });
    // 每枚币的额外迭代次数：这是**币自己的属性**（走 RigidBody 而不是世界参数），
    // 所以要在币池上逐个施加。默认 0——见 `Coin` 构造函数的注释。
    const extraIterations = Math.max(0, Math.round(this.tuning.coinSolverIterations));
    for (const coin of this.coins.coins) {
      coin.body.setAdditionalSolverIterations(extraIterations);
    }
    this.applyCoinPhysics();
    this.fitCamera();
  }

  /**
   * 把 `tuning` 里的硬币物理参数写进运行时注册表，并在**真的变了**的时候逐枚施加。
   *
   * ## 为什么写注册表而不是直接写币
   *
   * `coinPhysics` 是唯一真源：`Coin` 的构造与 `applyCollider` 读它、`fixedUpdate` 的
   * 速度护栏读它、`coinGeometry()` 钩子也读它。调参表只是它的 UI 镜像。
   * 只写币不写注册表的话，**之后新生成的币仍按旧值建**（推币机每局都在发新币，
   * 这个漏洞必然被踩到）。
   *
   * ## 为什么要做变化检测
   *
   * 逐枚施加是 700 次 rapier setter。`applyTuning` 会被面板的每个滑块拖动触发
   * （有时每帧一次），而其中只有一小部分与硬币物理有关。不做检测的话，
   * 拖「曝光」滑块也会顺带遍历 700 枚币。
   */
  private applyCoinPhysics(): void {
    Object.assign(coinPhysics, {
      friction: this.tuning.coinFriction,
      restitution: this.tuning.coinRestitution,
      density: this.tuning.coinDensity,
      linearDamping: this.tuning.coinLinearDamping,
      angularDamping: this.tuning.coinAngularDamping,
      maxSpeed: this.tuning.coinMaxSpeed,
      maxUpwardSpeed: this.tuning.coinMaxUpwardSpeed,
    });

    // 只有「写进刚体」的那几项需要逐枚施加；maxSpeed / maxUpwardSpeed 是每子步现读的。
    const fingerprint = [
      this.tuning.coinFriction,
      this.tuning.coinRestitution,
      this.tuning.coinDensity,
      this.tuning.coinLinearDamping,
      this.tuning.coinAngularDamping,
    ].join('|');
    if (fingerprint === this.appliedCoinPhysics) return;
    this.appliedCoinPhysics = fingerprint;
    for (const coin of this.coins.coins) {
      coin.applyPhysics();
    }
  }

  /** 竖直向下打一条射线，报告第一个命中的碰撞体（诊断币堆穿模用）。 */
  private castDown(
    x: number,
    y: number,
    z: number,
  ): { distance: number; hitY: number; shapeType: number; isSensor: boolean } | null {
    const ray = new RAPIER.Ray({ x, y, z }, { x: 0, y: -1, z: 0 });
    const hit = this.physics.world.castRay(ray, 5, true);
    if (!hit) return null;
    const collider = hit.collider;
    const t = collider.translation();
    const shape = collider.shape as unknown as { type: number };
    return {
      distance: round3(hit.toi),
      hitY: round3(t.y),
      shapeType: shape.type,
      isSensor: collider.isSensor(),
    };
  }

  /**
   * 渲染侧的真实位置：地板网格顶面、推板顶面、最低几枚币的网格中心。
   *
   * 存在的理由：物理读数说「币沉在地板下方」，画面却说「币好好地摆在地板上」时，
   * 必须有一条能把**渲染**与**物理**放在同一把尺子上量的通路，否则只能靠猜。
   */
  private probeMeshes(): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    const box = new THREE.Box3();
    const record = (label: string, object: THREE.Object3D) => {
      if (!object.visible) return;
      box.setFromObject(object);
      out.push({
        label,
        min: [round3(box.min.x), round3(box.min.y), round3(box.min.z)],
        max: [round3(box.max.x), round3(box.max.y), round3(box.max.z)],
        worldY: round3(object.getWorldPosition(new THREE.Vector3()).y),
      });
    };

    this.tableGroup?.traverse((child) => {
      const role = (child.userData as { role?: string }).role;
      if (role === 'floor' && (child as THREE.Mesh).isMesh) record('floor', child);
      if (role === 'pusherTop' && (child as THREE.Mesh).isMesh) record('pusherTop', child);
    });

    // 最低的三枚活跃币：渲染位置与物理位置一起报
    const active = this.coins.coins
      .map((coin, slot) => ({ coin, slot }))
      .filter((entry) => entry.coin.active)
      .map((entry) => ({ ...entry, y: entry.coin.body.translation().y }))
      .sort((a, b) => a.y - b.y)
      .slice(0, 3);
    for (const entry of active) {
      // P3 起币走 InstancedMesh：没有逐枚的 Object3D 可量，渲染位置从实例矩阵读回，
      // 包围盒用币半径近似——探针要的是「渲染与物理对在同一把尺子上」，不是精确 AABB。
      const p = entry.coin.renderPosition();
      if (!p) continue;
      const r = COIN.radius;
      out.push({
        label: `coin#${entry.slot}(物理y=${round3(entry.y)})`,
        min: [round3(p.x - r), round3(p.y - r), round3(p.z - r)],
        max: [round3(p.x + r), round3(p.y + r), round3(p.z + r)],
        worldY: round3(p.y),
      });
    }
    return out;
  }

  /**
   * 从接触流形读真实穿透深度（负距离 = 穿透）。
   *
   * 返回两组数：币与币之间、以及币与**静态机台**（地板/护栏/推板）之间的最深穿透。
   * 两者要分开看：币躺在地板上时本来就有毫米级穿透（Rapier 的 `allowedLinearError`
   * 默认就是 1 毫米），而那属于正常工作区间；币与币之间嵌进半个币厚才是缺陷。
   */
  private penetrationReport(limitMillimeters: number): {
    coinContacts: number;
    staticContacts: number;
    coinDeepest: number;
    staticDeepest: number;
    overLimit: number;
    worst: Array<{ depth: number; pair: string; at: [number, number, number] }>;
  } {
    const world = this.physics.world;
    const limit = limitMillimeters / 1000;
    const seen = new Set<string>();
    const worst: Array<{ depth: number; pair: string; at: [number, number, number] }> = [];
    let coinContacts = 0;
    let staticContacts = 0;
    let coinDeepest = 0;
    let staticDeepest = 0;
    let overLimit = 0;

    this.coins.coins.forEach((coin, slot) => {
      if (!coin.active) return;
      const own = coin.body.collider(0);
      world.contactPairsWith(own, (other) => {
        // 同一对接触会被两边各报一次，按句柄排序去重。
        const key = own.handle < other.handle ? `${own.handle}:${other.handle}` : `${other.handle}:${own.handle}`;
        if (seen.has(key)) return;
        seen.add(key);

        // 币是圆柱，机台是 cuboid，用形状类型区分（不需要额外的分组标记）。
        const otherShape = other.shape as unknown as { type: number };
        const isCoinPair = otherShape.type !== 1;

        world.contactPair(own, other, (manifold) => {
          for (let i = 0; i < manifold.numContacts(); i += 1) {
            const distance = manifold.contactDist(i);
            if (distance >= 0) continue;
            const depth = -distance;
            if (isCoinPair) {
              coinContacts += 1;
              coinDeepest = Math.max(coinDeepest, depth);
            } else {
              staticContacts += 1;
              staticDeepest = Math.max(staticDeepest, depth);
            }
            if (depth > limit) overLimit += 1;
            worst.push({
              depth: round3(depth),
              pair: isCoinPair ? `coin#${slot} ↔ coin` : `coin#${slot} ↔ 机台`,
              at: [round3(coin.position.x), round3(coin.position.y), round3(coin.position.z)],
            });
          }
        });
      });
    });

    worst.sort((a, b) => b.depth - a.depth);
    return {
      coinContacts,
      staticContacts,
      coinDeepest: round3(coinDeepest),
      staticDeepest: round3(staticDeepest),
      overLimit,
      worst: worst.slice(0, 5),
    };
  }

  private applyTestState(name: string): string {
    switch (name) {
      case 'ready':
        this.startRun();
        return name;
      case 'playing':
        this.startRun();
        this.run.beginPlay();
        this.pusher.start();
        return name;
      case 'drain':
        // 收尾场景：把筹码清零触发沉降。满盘沉降会回吐筹码 → 本局继续，
        // 所以这个状态同时也是「停板窗口」的入口（扫板的开放条件）。
        this.startRun();
        this.run.beginPlay();
        this.run.spendChips(this.run.chips);
        this.run.enterRuinSettle();
        this.pusher.start();
        return name;
      case 'ruin':
        // 破产弹窗场景：筹码清零、沉降收尾、弹嘲讽窗。
        this.startRun();
        this.run.beginPlay();
        this.run.spendChips(this.run.chips);
        this.run.enterRuinSettle();
        this.showRuin();
        return name;
      case 'settled':
        this.startRun();
        this.run.finish();
        this.showEndlessSummary();
        return name;
      default:
        throw new Error(`未知测试状态: ${name}`);
    }
  }

  private publishDiagnostics(): void {
    const info = this.renderer.info;
    const snapshot = this.run.snapshot();
    const canvas = this.renderer.domElement;
    window.__THREE_GAME_DIAGNOSTICS__ = {
      frame: this.frame,
      elapsed: this.elapsed,
      phase: snapshot.phase,
      // S4 合并账户后的恒等式：`balance = initial + earned + begged + loaned − spent`
      chips: snapshot.chips,
      initial: snapshot.initial,
      earned: snapshot.earned,
      begged: snapshot.begged,
      loaned: snapshot.loaned,
      spent: snapshot.spent,
      /** 本局被分流抵债的累计额（S2）。不进恒等式，与 `fines` 同族，见 `RunState.repaid`。 */
      repaid: snapshot.repaid,
      /** ★ 恒等式的唯一真源（`economy.ledgerBalances`）——诊断快照与 `ledger()` 钩子共用这一个函数。 */
      balanced: ledgerBalances(this.run.ledger),
      /** 可花余额（扣掉跪来的那一份）——脏钱约束在合并之后唯一的执行点。 */
      spendable: this.save.spendable,
      balance: this.save.balance,
      bestCombo: snapshot.bestCombo,
      /** XIXI 四槽亮灭（跨局持续；点亮/集齐事件在 telemetry.xixiEvents）。 */
      xixi: [...this.xixi],
      /**
       * 本局被老虎机罚掉的筹码（P10 的胡萝卜四连）。
       *
       * 它是**独立的对账口径**：`fines` 不进恒等式（已含在 `spent` 里），
       * 所以判据要同时看「`fines` 涨了多少」与「`spent ≥ fines`」两件事。
       */
      fines: this.run.fines,
      boostCharges: snapshot.boostCharges,
      settleReason: snapshot.settleReason,
      /** 收尾阶段推板是否已停板（扫板的开放条件）。 */
      plateStopped: snapshot.plateStopped,
      activeCoins: this.coins.activeCount(),
      /**
       * 本局累计越线结算枚数（`settledCoins`，开局归零）。
       * 和 `activeCoins` 配成一条**守恒式**才判得了「币有没有凭空消失」：
       * 只比两个时刻的 `activeCoins` 是把「推板照常结算」也算成了丢币（实测假红过 330→323）。
       */
      settledCoins: this.settledCoins,
      anomalies: this.anomalyCount,
      /**
       * 掉进币床前侧角下水道的币数（P10 的「汇」，见 `DRAIN`）。
       *
       * ★ **必须与 `anomalies` 分开读**：两者都让盘面少一枚币，但一个是设计好的
       * 合法损失、一个是缺陷。混在一起就再也分不清「洞开得太大」和
       * 「求解器又把币甩出机柜了」。逐枚现场在 `telemetry().drainEvents`。
       */
      drained: this.drainCount,
      /**
       * 币床上的活跃币数与自动补币的触发次数（P10 ⑦）。
       *
       * ★ `bedCoins` 是**上一轮盘点的值**（每 `REFILL.checkEvery` 秒刷一次），
       * 不是当帧值。判据要先等一个盘点周期再读，否则会把补币前的旧读数当成「没生效」。
       *
       * ★ 它**不能**用 `activeCoins` 代替：后者含正在下落的、演出排队没落的、
       * 上层台面的币，盘面掏空时它仍是三位数（见 `CoinPool.countBed()`）。
       */
      bedCoins: this.bedCoins,
      refills: this.refillCount,
      /**
       * 此刻停在**推板顶面**（台面输送带）上的活跃币数。
       *
       * 这条读数是「补货的币到没到币床」的**现场**：闸门从背板吐币，币先落在顶面、
       * 被输送带送过前缘才掉进币床。若输送不带它们走，这 7 枚就会**停在顶面**
       * ——`activeCoins` 照涨 7，`bedCoins` 一动不动。只有顶面枚数能区分
       * 「还在路上」与「卡住了」。
       *
       * 与输送共用 `isOnDeck` 一份判据（不写第二份），所以它不受降动效影响。
       */
      deckCoins: this.countDeckCoins(),
      /** 异常币飞出时的坐标与速度（`anomalies > 0` 时用它定位，最多 12 条）。 */
      anomalySamples: this.anomalySamples,
      /**
       * 速度护栏的计数与峰值（见 `COIN.maxSpeed`）。
       *
       * **这是「求解器还在不在造能量」的直接读数**：围板补上之后 `anomalies` 恒为 0
       * 是必然的（币根本出不去），所以它不再是有效判据；`spikeClamps` 才是。
       */
      spikeClamps: this.spikeClamps,
      peakSpikeSpeed: round3(this.peakSpikeSpeed),
      peakPostClampUpward: round3(this.peakPostClampUpward),
      // 钉阵：网格是显示长度，碰撞体是物理长度，两者刻意不同（只改显示不改物理）。
      pegs: {
        count: this.pegs.count,
        colliderHalfLength: this.pegs.colliderHalfLength,
        visualHalfLength: this.pegs.visualHalfLength,
      },
      input: {
        lane: round3(this.lastIntent?.lane ?? 0),
        laneX: round3(this.lastIntent?.laneX ?? 0),
        mode: this.lastIntent?.mode ?? 'auto',
        manualHoldLeft: round3(this.lastIntent?.manualHoldLeft ?? 0),
      },
      motion: {
        reduced: this.motion.reduced,
        source: this.motion.source,
      },
      /*
       * 音频子系统摘要。
       *
       * `loadedSamples === 0` 是最有用的一个读数：它说明**全部事件都在走合成音兜底**
       * （旧 Safari 不支持 Ogg Vorbis，或素材没取到）。没有这个字段的话，
       * 「音效没变」和「音效加载失败」在脚本层面完全无法区分。
       */
      audio: this.audio.debug,
      // 机关：剩余次数与币预算余量（后装填会撞预算上限）。
      mechanisms: {
        ...this.mechanismSnapshot(),
        coinsRemaining: this.coins.remaining,
        // P7：停板窗口的宽度与「一个推板循环」的长度。
        // 判据要拿它们算「窗口 ≥ 2 个循环」，而不是在脚本里手抄 4.8 这个数。
        restHold: RULES.restHold,
        // 从推板读而不是读 `PUSHER_PERIOD` 常量：相位时长可调，常量会陈旧。
        // `scripts/verify-game.mjs` 正是从这里推导推进率基线。
        pusherPeriod: this.pusher.period,
      },
      // 投放演出：两态判据读这个——registered 时币尚未动，completed 时币已到位。
      shows: { busy: this.shows.busy, queued: this.shows.queued, active: this.shows.activeId },
      // 加注档位：`mul` 是越线返值倍率（押 5 枚 = ×4，押越大单位期望越低）。
      bet: {
        index: this.betIndex,
        chips: ENDLESS.bets[this.betIndex].chips,
        mul: ENDLESS.bets[this.betIndex].mul,
      },
      // 热区：亮条位置（无尽恒开）。
      hotZone: {
        active: this.config.hotZone,
        x: round3(this.hotZoneX),
        halfWidth: TABLE.hotZone.halfWidth,
      },
      // 本局：筹码、存活投数、筹码峰值、破产弹窗状态。
      endless: {
        active: true,
        begs: this.begsThisRun,
        totalBegs: this.save.begCount(),
        drops: snapshot.drops,
        chipsPeak: snapshot.chipsPeak,
        bestEarned: this.save.snapshot.bestEarned,
        ruinVisible: this.hud.ruinVisible,
        // 大赏币注入间隔。测试读这里而不是写死数字：P8 重新标定时
        // 硬编码的 15/30 会让断言变成假失败，而它其实只是配置。
        bountyEveryDrops: ENDLESS.bountyEveryDrops,
        /**
         * 一个**标准注额**（`ENDLESS.buyIn`）。S4 合并账户之后它不再是「每局买入」——
         * 一局的入场额就是全部余额 —— 它现在只有两个读者：贷款额的基准，
         * 以及 `economy` 批用来把局长口径对齐到旧标定（脚本里不抄第二份常量，同一个理由）。
         */
        referenceStake: ENDLESS.buyIn,
        // 本局已注入的大赏币枚数（注入率断言的分子）。
        bounties: snapshot.bounties,
      },
      pusher: {
        offset: this.pusher.offset,
        phase: this.pusher.currentPhase,
        running: this.pusher.running,
        /** 演出期「停在回收位」的闸门是否合上（判据要能分清「没在推」与「被演出按住」）。 */
        parked: this.pusher.isParked,
        cycles: this.pusher.cyclesCompleted,
        frontFaceZ: this.pusher.frontFaceZ,
      },
      physics: {
        bodies: this.physics.bodyCount,
        colliders: this.physics.colliderCount,
        substeps: this.physics.substeps,
        // 诊断里带上当前物理旋钮：穿模/节奏的每一条实测记录都必须能对应到一组参数上，
        // 否则「这次跑为什么不一样」永远查不出来。
        tuning: {
          ...this.physics.tuning,
          coinSolverIterations: this.tuning.coinSolverIterations,
          // 下面两块一律读**实际生效值**（注册表 / 推板实例字段），不读调参表：
          // 调参表只是 UI 的镜像，真正参与求解的是这两处。
          coin: {
            density: coinPhysics.density,
            friction: coinPhysics.friction,
            restitution: coinPhysics.restitution,
            linearDamping: coinPhysics.linearDamping,
            angularDamping: coinPhysics.angularDamping,
            maxSpeed: coinPhysics.maxSpeed,
            maxUpwardSpeed: coinPhysics.maxUpwardSpeed,
            upwardBleedTau: coinPhysics.upwardBleedTau,
          },
          pusher: {
            travel: this.pusher.travel,
            extendSec: this.pusher.durations.extend,
            holdFrontSec: this.pusher.durations.holdFront,
            retractSec: this.pusher.durations.retract,
            holdBackSec: this.pusher.durations.holdBack,
            boostTravelBonus: this.pusher.boostTravelBonus,
            period: this.pusher.period,
          },
        },
      },
      performance: {
        fps: round3(this.governor.fps),
        tier: this.governor.current.tier,
        /** 画质锁是否合上（10-01）。`tier` 相同而 `locked` 不同是两种完全不同的状态。 */
        locked: this.governor.isFrozen,
        // 像素分辨率（V1）：取代了旧的 maxDpr。`upscale` 是整数倍率，
        // `internalHeight` 是实际内部渲染高度（CSS 像素）。
        pixelTargetHeight: this.tuning.pixelTargetHeight,
        pixelated: this.pixelScale.pixelated,
        upscale: this.pixelScale.upscale,
        internalHeight: this.pixelScale.internalHeight,
        shadows: this.governor.current.shadows,
      },
      collection: {
        balance: this.save.balance,
        coinSkin: this.save.snapshot.selectedCoinSkin,
        cabinetSkin: this.save.snapshot.selectedCabinetSkin,
        coinSkins: this.save.snapshot.coinSkins.length,
        cabinetSkins: this.save.snapshot.cabinetSkins.length,
      },
      /**
       * 贷款 / 欠款（S2）。`repaid` 是**本局**被分流抵债的累计额（`RunState.repaid`，
       * 不进三账本恒等式），所以「gross 产出」= `earned + repaid` —— economy 的稳态判据
       * 读的就是 `repaid / (earned + repaid)` 这个分流率。
       */
      debt: {
        debt: this.save.debt,
        ceiling: this.save.debtCeiling,
        loanedTotal: this.save.loanedTotal,
        repaidThisRun: this.run.repaid,
      },
      reel: this.reelDiagnostics(),
      renderer: {
        // 同 `materialReport()`：两遍出画之后 `info` 只剩最后一遍，这里要的是整帧的数。
        calls: this.frameDrawCalls,
        triangles: this.frameTriangles,
        geometries: info.memory.geometries,
        textures: info.memory.textures,
        /**
         * 描边的**当前生效值**（不是出厂值、不是调参表的镜像）。
         *
         * 立硬判据的前提是「判据读得到被审的那个数」：强度现在由 `tuning` 驱动
         *（面板与测试都能改），如果快照里只有物理那几项，判据就只能自己抄一份默认值 ——
         * 那就是第二份真源，改默认的人不会记得改它（与 `detailEnabled` 同一条理由）。
         */
        outline: {
          scale: this.tuning.outlineScale,
          ...this.finalPass.outlineThresholds,
        },
        /**
         * 暗部分级的**当前生效值**：grade 走 tuning（面板/测试都能改，恒等门读的就是它），
         * tint/range 是常量所以直接报——它们没有被第二份可改的副本，不构成第二真源。
         */
        shadow: {
          grade: this.tuning.shadowGrade,
          tint: FINAL_PASS_SHADOW_TINT,
          range: FINAL_PASS_SHADOW_RANGE,
        },
      },
      canvas: {
        clientWidth: canvas.clientWidth,
        clientHeight: canvas.clientHeight,
        width: canvas.width,
        height: canvas.height,
        /** 真实 DPR（设备像素 / CSS 像素）。**只作诊断**，不再参与分辨率计算。 */
        dpr: window.devicePixelRatio || 1,
        /** backing store 与 CSS 尺寸的整数比（= `pixelScale.upscale`）。 */
        upscale: this.pixelScale.upscale,
      },
    };
  }

  /**
   * 背板老虎机（P10）：4 个滚筒窗的读数 + **图标在画布上的后备像素边长**。
   *
   * 「图标糊不糊」在截图上只能反推（是窗口太小？贴图被缩放？倍率档位不对？），
   * 读出来就是一组数。`iconBackPixels` 的设计目标是 **32**（32×32 图标 1:1）：
   *   0.34 m 窗 × 191 CSS px/m ÷ upscale 2 ≈ 32.5
   * 默认档 upscale 1 时同一个数是 66.7（图标被放大两倍多，非 1:1），所以
   * 判据写「≥ 24」而不是「=== 32」——降档时 `upscale` 变大会把它压小，
   * 那是画质分档的正常行为，不是缺陷。
   *
   * 抽成方法而不是写在 `publishDiagnostics` 里的 IIFE：**诊断与测试钩子必须是
   * 同一个读数**，两份写法迟早在改参数时对不上。
   */
  private reelDiagnostics(): ThreeGameDiagnostics['reel'] {
    const report = this.slotMachine.reelWindowReport();
    const window = this.backPixelSize(report.windowSize, 0, report.windowY, report.windowZ);
    return {
      ...report,
      /** 图标边长（**后备缓冲像素**，当前像素倍率下）。 */
      iconBackPixels: round3(window),
      /** 同上但按 **CSS 像素**：档位无关的「窗口角尺寸选得对不对」读数。 */
      iconCssPixels: round3(window * this.pixelScale.upscale),
      /**
       * 四格占用的世界宽度（含缝）。用来核对它没超出机台宽度——
       * 从报告里的 pitch 与 size 反解，不在诊断里重写一份几何公式。
       */
      rowWidth: round3(
        report.windowSize * report.count +
          (report.count - 1) * (report.windowPitch - report.windowSize),
      ),
    };
  }

  private getElement(selector: string): HTMLElement {
    const element = document.querySelector<HTMLElement>(selector);
    if (!element) throw new Error(`缺少元素: ${selector}`);
    return element;
  }  }

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * 按 `userData.part` 选出对应的 Arcane 贴图工厂（S19：判据从 `role` 改成 `part`）。
 *
 * 返回 `null` 表示该件不需要换贴图 ⇒ 跳过（保持原 `map`）。
 *
 * - `scoreLine` → `createArcaneScoreLineTexture`
 * - `hotZone` → `createArcaneHotZoneTexture`
 * - `hoodValance` → `createArcaneMarqueeTexture`（招牌画布）
 * - `hoodRoof` → `createArcaneRoofSeamTexture`（R2-T1-5：顶板自己一份构图。原先它与檐板
 *   共用一份 `trim` 材质 ⇒ 只能共用一张贴图，后写的覆盖先写的；拆成两份实例才分开）
 * - `backPanel` → `createArcaneBackPanelTexture`（R2-T1-5：原先**没有**贴图）
 *
 * ★ 我原本预计这一条会 +1 program（`panel` 建场时不带 map ⇒ 挂上后多出 `USE_MAP`
 * 这个 define ⇒ 新 program 键）。**实测没有**：programs 25 → 25、draw call 46 → 46。
 * 预测与预算冲突时以读数为准，别照着预测去放宽或收紧判据。
 * - `sideWall.tall.L` / `.R` → `createArcaneLampHousingTexture`（S25 / R1-M3 的内凹灯饰。
 *   两件共用 `panelArt` 那一份材质 ⇒ 也只真的建一张；**侧板高段能单独挂图**靠的就是
 *   那份从 `panel` 拆出来的独立实例，见 `TableBuilder.cabinetMaterials()`）
 *
 * ★ S21：招牌 `marquee` 这一件被删除了，但**这条通路一个字都不用改** ——
 * `hoodValance`（檐板）本来就在上面那一支里，删掉 `marquee` 之后它自然成为
 * 招牌画布的唯一承载者（用户批注 ①②）。
 *
 * ## ★ 为什么必须从 `role` 改成 `part`（S19）
 *
 * S18 按 `role` 判，但**全仓库没有任何网格挂 `scoreLine` / `hotZone` 这两个 role**
 * （得分线与热区亮条只有材质，没有 role），于是那两条分支是**死代码**：
 * 切肤之后得分线与热区仍然挂着建场时写死的 `'viArcane'` / `'firelight'`，
 * 永远不跟着 `marqueePalette` 走 —— 不报错、不崩溃，只是颜色不再变。
 * 而 `role === 'trim'` 又同时命中招牌 / 顶沿 / 前立面压条三件用途不同的件。
 *
 * 一个字段干两件事，就必然在某个维度上少一个词。补上 `part` 之后，
 * `role` 回到纯粹的「色带」语义。见 `game/cabinetShape.ts` 的 `CabinetPart`。
 */
/**
 * 柜身烘焙贴图总开关（用户批注：柜身只要纯色）。
 *
 * 关的是**柜身四件**：檐板 `hoodValance`、顶板 `hoodRoof`、背板 `backPanel`、
 * 侧板灯饰 `sideWall.tall.L/R` —— 只留色带 `color`，不再挂 `map` / `emissiveMap`。
 * 台面标记（得分线 / 热区）、筹码币面、老虎机滚筒与招牌 LED 屏都不在此列，不受影响。
 * 留成常量而不是删掉那几行：那些构图是 R1/R2 做出来的，要对比时改一个词即可。
 */
const CABINET_BODY_MAPS = false;

function pickCabinetMap(
  part: string | undefined,
  palette: ArcanePaletteKey,
): { map: THREE.Texture; glow: boolean } | null {
  // `glow` = 这张贴图还要走 `emissiveMap`。判据放在这里（而不是 `applyCabinetMapTextures`
  // 里再 `if (part === …)` 一次），是为了「哪件挂哪张图 / 要不要自发光」始终只有一个出处。
  // 用户批注：机柜（含台面标记）一律纯色 ⇒ 这里直接不给任何烘焙贴图。
  // 下面的分支保留但**当前全部不可达**，为的是「想回看对比时改一个词」；
  // 恢复时注意 `glow: true` 那几件（顶板 / 侧板灯饰）还要连 `emissive` 三件套一起回来。
  // ⚠️ 得分线与热区高亮条也在这条路上被关掉 = **玩法提示消失**（热区是「该往哪推」的信号）。
  //    若只要柜身平、台面标记留着，把下面第一条分支挪回 `scoreLine` / `hotZone` 之后即可。
  if (!CABINET_BODY_MAPS) return null;
  if (part === 'scoreLine') return { map: createArcaneScoreLineTexture(palette), glow: false };
  if (part === 'hotZone') return { map: createArcaneHotZoneTexture(palette), glow: false };
  // 檐板＝招牌画布（S21）。顶板 R2-T1-5 起走自己那份构图。
  if (part === 'hoodValance') return { map: createArcaneMarqueeTexture(palette), glow: false };
  // 顶板 R2-T1-5 起走自己那份构图。原先 `glow: false` 的理由是「它吃 trim 色带，
  // 加 emissive 会像檐板那样被刷成过曝白」——那条推理对**招牌**成立（它本来就是亮色带），
  // 对顶板不成立：顶板在演奏相机下是一大片几乎平行于视线的暗面，`color × map` 乘出来的
  // 就是「没有内容」，板缝与铆钉只有在自发光通道才活得下来（同 `sideWall.tall` 的结论）。
  // 过曝风险由构图自己挡住：`paintRoofSeamCanvas` 的底是 `ink`、底噪用 `deep`，
  // 亮部只剩板缝高光线与铆钉，整面不会糊成白。
  if (part === 'hoodRoof') return { map: createArcaneRoofSeamTexture(palette), glow: true };
  // 背板：可见的只有币堆上沿那一条，构图把信息量全放在顶部拱线（见 painters 的注释）。
  if (part === 'backPanel') return { map: createArcaneBackPanelTexture(palette), glow: false };
  // 侧板高段＝内凹灯饰（S25 / R1-M3 的贴图近似版）。两件共用 `panelArt` 一份材质，
  // 走 `touched` 去重 ⇒ 只建一张。左右两件**必须**给同一个 key：它们是同一份材质，
  // 若这里按 `side` 分叉就会变成「后建的那张覆盖前一张」的静默抖动。
  //
  // ★ 只有这一件要 `glow: true`：侧墙走 `panel` 色带（深色），而 `MeshToonMaterial` 是
  //   `color × map` —— 深色带会把贴图里任何近白像素一起压暗，实测灯管在游玩视角只剩
  //   一坨暗斑。贴图不能靠 `map` 变亮（乘法不会放大），所以亮条改走 `emissiveMap`。
  if (part === 'sideWall.tall.L' || part === 'sideWall.tall.R') {
    return { map: createArcaneLampHousingTexture(palette), glow: true };
  }
  return null;
}

/** 角度只留一位小数：诊断里要的是「平躺 / 搭着 / 立起」三档，不是精确姿态。 */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
