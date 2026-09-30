import GUI from 'lil-gui';
import * as THREE from 'three';
import * as RAPIER from '@dimforge/rapier3d-compat';
import { COIN, PHYSICS, PUSHER_CYCLE, RULES, TABLE } from '../game/constants';
import { COIN_PHYSICS_DEFAULTS, resetCoinPhysics } from '../game/coinPhysics';
import { COIN_SCALE, COIN_SCALE_STEPS, setCoinScale, type CoinScale } from '../game/coinScale';
import { CAMERA_FIT, cameraRig, placeCameraRig, syncCameraRigAngles, toDeg, toRad } from '../render/cameraRig';
import { PIXEL_SCALE_DEFAULTS } from '../render/PixelScale';
import { AUDIO_EVENTS, auditionEvent } from './audioCatalog';
import { GAIN_MAX, GAIN_MIN, type AudioSystem, type SelectorKey } from './AudioSystem';

export type GameTuning = {
  /** 台面输送速度（米/秒）。 */
  conveyorSpeed: number;
  /** 推板单程行程（米）。**按行程锁存**：在回撤/驻留期间改，下一次前推才生效。 */
  pusherTravel: number;
  /** 投币冷却（秒）。 */
  dropCooldown: number;
  /** 重力加速度（负值，米/秒²）。 */
  gravity: number;
  /** 接触求解器迭代次数。 */
  solverIterations: number;
  /** 位置修正比（ERP）。 */
  erp: number;
  /**
   * 预测接触距离（米）。落币「蹦一下」的开关——见 `PHYSICS.predictionDistance` 的实测记录。
   * 它是**全局**窄相参数，改它同时改推板与币的接触生成距离，所以带 `WARN`。
   */
  predictionDistance: number;
  /** 每枚币额外追加的求解器迭代次数。 */
  coinSolverIterations: number;
  cameraFov: number;
  exposure: number;
  /**
   * 屏幕空间描边强度（G2）。0 = **逐字恒等**（这条不是「效果弱」，是判据：
   * 关掉必须与开之前逐像素全等，见 `glsl/outline.glsl.ts`）。
   *
   * 放在 `tuning` 而不是只留一个常量，是因为 A/B 需要**同一帧内**只换这一个变量：
   * 改源码 + 重载会让币堆/滚筒全部重新演化，两次截图的差就分不清是描边还是动画
   *（G0 判 rim 断线时就是这么被污染过一次，最后靠 `setState('ready')` + 暂停才量准）。
   */
  outlineScale: number;
  /** 内部分辨率的目标高度上限（见 `render/PixelScale.ts`）。调低 = 倍率更大 = 更省。 */
  pixelTargetHeight: number;
  /** 放大方式：true = 最近邻（块状像素），false = 平滑。**不影响内部分辨率**。 */
  pixelated: boolean;
  /** 币面贴图倍率（1x = 16/32px, 2x = 32/64px, 4x = 64/128px）。 */
  coinTexelScale: number;
  showColliders: boolean;
  muted: boolean;
  /**
   * 镜头是否交还给 `fitCamera()` 自动取景。
   *
   * ★ S22 起它是**机位所有权**的开关：面板上任何一次手动动机位（角度 / 距离 /
   * 相机坐标 / 观察点）都会把它翻成 `false`，之后改 FOV 或改窗口尺寸都不会再把
   * 机位弹回默认视角。「回到默认取景」按钮把它翻回 `true`。
   */
  cameraAutoFit: boolean;

  // ── 推板相位时长（秒）────────────────────────────────────────────────
  // 与 `pusherTravel` 不同：这四项是**每帧现读**，改完当场生效。
  // ⚠️ 调到小于已累计的相位时间会立刻触发相位翻转（上限一帧 4 个相位）。
  /** 前推进程时长。调长 = 推得慢。 */
  pusherExtendSec: number;
  /** 推到底后的驻留时长。 */
  pusherHoldFrontSec: number;
  /** 回撤时长。调短 = 回推更快（峰值速度 ≈ 行程 × 1.5 ÷ 时长）。 */
  pusherRetractSec: number;
  /** 退到底后的驻留时长。 */
  pusherHoldBackSec: number;
  /** 加力追加的行程比例（0.2 = 追加 20%）。乘的是整趟往返，不只是前推段。 */
  boostTravelBonus: number;

  // ── 硬币物理（运行时逐枚施加）────────────────────────────────────────
  // ⚠️ 以下三项是**推进率的输入**，改完必须重跑 `scripts/verify-game.mjs` 的
  //    `pace` / `economy`，否则「每循环推进多少枚」的基线会失真。
  /** 币侧摩擦。⚠️ Rapier 用 Average 合并，币↔台面实际值 = (币 + 台面)/2，单改只有一半效果。 */
  coinFriction: number;
  /** 币侧弹性。⚠️ 非零会累积微抖动（项目刻意归零）。 */
  coinRestitution: number;
  /** 密度 → 质量（质量 = πr²·2h·ρ）。⚠️ 改动会漂移所有「定值冲量」机构。 */
  coinDensity: number;
  /** 线性阻尼：吃自由滑行段的残余滑动。 */
  coinLinearDamping: number;
  /** 角阻尼：低值会让币原地打转。 */
  coinAngularDamping: number;
  /** 速度护栏（米/秒）。正常玩法碰不到，碰到说明求解器造了能量。 */
  coinMaxSpeed: number;
  /** 上抛护栏（米/秒）。⚠️ 与侧向围板 `GLASS_TOP` 配套，放开会飞越围板。 */
  coinMaxUpwardSpeed: number;
};

export function createDefaultTuning(): GameTuning {
  return {
    conveyorSpeed: TABLE.conveyor.speed,
    pusherTravel: TABLE.pusherTravel,
    dropCooldown: 0.45,
    gravity: PHYSICS.gravity,
    solverIterations: PHYSICS.solverIterations,
    erp: PHYSICS.erp,
    predictionDistance: PHYSICS.predictionDistance,
    coinSolverIterations: COIN.additionalSolverIterations,
    cameraFov: 42,
    exposure: 1.06,
    // 描边默认开着（0.35）。这个数是**看图定的**，不是推出来的：同一冻结帧上
    // 0.35 压暗 5.4% 的像素（= 所有轮廓与物件交界），0.7 只多到 5.8% 但每条线
    // 深一倍 —— 币堆那么密，再粗就开始糊成一团。判完 G3 的深度/法线通道之后要回看。
    // ⚠️ 出厂值非 0 ⇒ `visual.spec` 那条恒等判据**显式**把 outlineScale 设成 0 再取基线，
    //   不能依赖这个默认值。
    outlineScale: 0.35,
    pixelTargetHeight: PIXEL_SCALE_DEFAULTS.targetHeight,
    pixelated: PIXEL_SCALE_DEFAULTS.pixelated,
    coinTexelScale: 2,
    showColliders: false,
    muted: false,
    cameraAutoFit: true,

    // 出厂值一律取自常量表 —— 这样「默认行为零变化」是可以被机械验证的。
    pusherExtendSec: PUSHER_CYCLE.extend,
    pusherHoldFrontSec: PUSHER_CYCLE.holdFront,
    pusherRetractSec: PUSHER_CYCLE.retract,
    pusherHoldBackSec: PUSHER_CYCLE.holdBack,
    boostTravelBonus: RULES.boostTravelBonus,

    coinFriction: COIN_PHYSICS_DEFAULTS.friction,
    coinRestitution: COIN_PHYSICS_DEFAULTS.restitution,
    coinDensity: COIN_PHYSICS_DEFAULTS.density,
    coinLinearDamping: COIN_PHYSICS_DEFAULTS.linearDamping,
    coinAngularDamping: COIN_PHYSICS_DEFAULTS.angularDamping,
    coinMaxSpeed: COIN_PHYSICS_DEFAULTS.maxSpeed,
    coinMaxUpwardSpeed: COIN_PHYSICS_DEFAULTS.maxUpwardSpeed,
  };
}

export type DebugActions = {
  onRefillWallet?: () => void;
  onClearSave?: () => void;
  onCoinTexelChange?: () => void;
  /**
   * 摄影机机位被手动改过之后调一次。
   *
   * ★ 刻意**不走** `onChange`（= `applyTuning()`）：那条路会遍历 700 枚币去写
   * 额外的求解器迭代，而拖一次机位滑块会产生几十次回调。
   * 机位改动只影响相机本身，所以走一条只摆相机的窄路径。
   */
  onCameraChange?: () => void;
};

/** 上传音频的大小上限。超过就拒绝——解码一个几十兆的文件会卡住主线程。 */
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/** ⚠ 标记：加在物理旋钮名上，提示「改完必须重跑验证基线」。 */
const WARN = ' ⚠';

/**
 * 调试面板与碰撞体可视化。只有带 ?debug 参数时才创建 GUI。
 *
 * ## 面板结构
 *
 * 原先 16 个控件是平铺的，加上音效与物理参数后会超过 35 个，所以按用途分组：
 * 「推板与台面 / 物理·世界 / 物理·硬币 / 镜头与画面 / 调试显示 / 音效」。
 */
export class DebugTools {
  private gui: GUI | null = null;
  private readonly colliderGroup = new THREE.Group();
  private colliderLines: THREE.LineSegments | null = null;
  private readonly enabled: boolean;
  /**
   * 摄影机分组的全部控件。
   *
   * 单独留一份引用是为了 `refreshCameraControllers()`：机位的真源在 `cameraRig`
   * （模块单例）而不在 `tuning`，引擎重算机位时 lil-gui 不会自动读回，
   * 必须由 `Game.fitCamera()` 主动喊一声。
   */
  private readonly cameraControllers: Array<{ updateDisplay(): unknown }> = [];
  /** 摄影机分组的实时状态行（显示当前机位，方便复现某张截图）。 */
  private cameraNote: HTMLDivElement | null = null;

  constructor(
    private readonly world: RAPIER.World,
    private readonly tuning: GameTuning,
    private readonly onChange: () => void,
    private readonly actions: DebugActions = {},
    /** 音频子系统。不传则跳过音效面板（构造签名保持向后兼容）。 */
    private readonly audio: AudioSystem | null = null,
  ) {
    this.enabled = new URLSearchParams(window.location.search).has('debug');
    if (!this.enabled) return;

    this.gui = new GUI({ title: '推币机调参' });

    /*
     * ★ 一处注册覆盖所有 folder。
     *
     * lil-gui 的 controller 触发 onChange 时会沿父链上抛到 root（`Controller._callOnChange`
     * → `parent._callOnChange` → `GUI._callOnChange`），所以这里注册一次就够了，
     * 不必给每个控件逐个挂 `.onChange()`——原先正是漏挂导致「拖重力/推板行程/曝光不生效」。
     *
     * ★ 守卫 `event.object === this.tuning` 是**必需**的，不是优化：
     * `FunctionController` 的 click 处理器也会调 `_callOnChange()`，所以每个「试听」
     * 「充值」「挂载」按钮的点击都会冒泡到这里。没有守卫，点一次按钮就跑一次
     * `applyTuning()`（含 `fitCamera()` 与 700 枚币的遍历）。
     */
    this.gui.onChange((event) => {
      if (event.object === this.tuning) this.onChange();
    });

    this.buildTableFolder();
    this.buildWorldPhysicsFolder();
    this.buildCoinPhysicsFolder();
    this.buildRenderFolder();
    this.buildCameraFolder();
    this.buildDebugFolder();
    this.buildActionButtons();
    if (this.audio) this.buildAudioFolders(this.audio);
  }

  // ── 面板构建 ───────────────────────────────────────────────────────────

  private buildTableFolder(): void {
    if (!this.gui) return;
    const folder = this.gui.addFolder('推板与台面');
    folder.add(this.tuning, 'conveyorSpeed', 0, 3, 0.05).name('台面输送速度');
    folder.add(this.tuning, 'pusherTravel', 0.3, 1.2, 0.01).name('推板行程（按行程锁存）');
    folder.add(this.tuning, 'dropCooldown', 0.1, 1.2, 0.05).name('投币冷却');

    /*
     * 相位时长与 `pusherTravel` 的生效语义**不同**：
     *   - `pusherTravel` 是**按行程锁存**的（只在进入 `extend` 那一帧读一次），
     *     所以在回撤/驻留期间改，要等下一次前推才生效。
     *   - 相位时长是**每帧现读**的，改完**当场生效**。
     * 面板上标注出来，免得调了没反应时误判成坏了。
     */
    folder.add(this.tuning, 'pusherExtendSec', 0.1, 3, 0.05).name('前推时长（秒·当场生效）');
    folder.add(this.tuning, 'pusherHoldFrontSec', 0, 2, 0.05).name('前驻留（秒）');
    folder.add(this.tuning, 'pusherRetractSec', 0.05, 3, 0.05).name('回撤时长（秒·调短=回推更快）');
    folder.add(this.tuning, 'pusherHoldBackSec', 0, 2, 0.05).name('后驻留（秒）');
    folder.add(this.tuning, 'boostTravelBonus', 0, 1, 0.05).name('加力追加行程比例');
  }

  private buildWorldPhysicsFolder(): void {
    if (!this.gui) return;
    const folder = this.gui.addFolder('物理·世界');
    folder.add(this.tuning, 'gravity', -20, -4, 0.5).name('重力');
    // 不需要逐个挂 `.onChange`：root 上的 `gui.onChange` + 对象守卫已覆盖全部控件。
    folder.add(this.tuning, 'solverIterations', 2, 16, 1).name('求解器迭代' + WARN);
    folder.add(this.tuning, 'erp', 0.05, 0.9, 0.05).name('位置修正 ERP' + WARN);
    // 步长 0.002 是刻意选的：Rapier 默认 0.002 与本项目采用的 0.10 都落在格点上，
    // 这条滑杆因此可以直接做「落币蹦不蹦」的同会话 A/B 换臂。
    folder.add(this.tuning, 'predictionDistance', 0, 0.15, 0.002).name('预测接触距离' + WARN);
    folder.add(this.tuning, 'coinSolverIterations', 0, 4, 1).name('币额外迭代' + WARN);
    this.appendNote(
      folder,
      '⚠ ERP 调低会让整堆币沉进地板（0.2 时 318 枚里 299 枚币心在地板下）；' +
        '币额外迭代设成 1 会让整堆沉 24~34mm 后睡着。改完请重跑 pace / economy。' +
        '⚠ 预测接触距离调回 Rapier 默认 0.002 会让落币随机蹦起（实测中位 2mm 但 max 333mm）；' +
        '0.10 以上跳起归零。它是全局窄相参数，改完同样要重跑 pace。',
    );
  }

  private buildCoinPhysicsFolder(): void {
    if (!this.gui) return;
    const folder = this.gui.addFolder('物理·硬币');
    folder.add(this.tuning, 'coinFriction', 0, 1.5, 0.01).name('摩擦' + WARN);
    folder.add(this.tuning, 'coinRestitution', 0, 0.5, 0.01).name('弹性' + WARN);
    folder.add(this.tuning, 'coinDensity', 100, 3000, 10).name('密度→质量' + WARN);
    folder.add(this.tuning, 'coinLinearDamping', 0, 1, 0.01).name('线性阻尼');
    folder.add(this.tuning, 'coinAngularDamping', 0, 1.5, 0.01).name('角阻尼');
    folder.add(this.tuning, 'coinMaxSpeed', 2, 20, 0.5).name('最大速度护栏');
    folder.add(this.tuning, 'coinMaxUpwardSpeed', 0.5, 10, 0.5).name('上抛护栏' + WARN);
    this.appendNote(
      folder,
      '⚠ 摩擦 / 弹性 / 密度是推进率的输入，改完必须重跑 pace / economy。' +
        '摩擦用 Average 合并，币↔台面实际值 = (币 + 台面 0.45) / 2，单改只有一半效果。' +
        '弹性非零会累积微抖动；上抛护栏与侧向围板是配套的，放开会飞越围板。',
    );
  }

  private buildRenderFolder(): void {
    if (!this.gui) return;
    const folder = this.gui.addFolder('镜头与画面');
    folder.add(this.tuning, 'cameraFov', 24, 70, 1).name('镜头 FOV');
    folder.add(this.tuning, 'exposure', 0.6, 1.8, 0.01).name('曝光');
    folder.add(this.tuning, 'outlineScale', 0, 1, 0.05).name('描边强度（G2）');
    folder.add(this.tuning, 'pixelTargetHeight', 120, 720, 20).name('像素目标高度');
    folder.add(this.tuning, 'pixelated').name('像素化');
    folder
      .add(this.tuning, 'coinTexelScale', [1, 2, 4])
      .name('币面贴图倍率')
      .onChange(() => this.actions.onCoinTexelChange?.());
    /*
     * 币尺寸档位（S13）。**注意它不是普通的实时旋钮**：币径同时决定质量（k³）、
     * collider 半径与全部布局步距，没有廉价的热切换路径。所以这里只是
     * 「选中即写 URL 参数 + 重载整页」，与手改 `?coin=1.1` 走同一条路
     * （见 `coinScale.ts`）。`scale === 1` 时会把参数删掉，URL 保持干净。
     */
    folder
      .add({ coinScale: COIN_SCALE }, 'coinScale', [...COIN_SCALE_STEPS])
      .name('币尺寸倍率（重载）')
      .onChange((value: number) => setCoinScale(value as CoinScale));
  }

  private buildDebugFolder(): void {
    if (!this.gui) return;
    const folder = this.gui.addFolder('调试显示');
    folder.add(this.tuning, 'showColliders').name('显示碰撞体');
    folder.add(this.tuning, 'muted').name('静音');
  }

  /**
   * 摄影机面板（S22）：角度 + 坐标。
   *
   * ## 为什么角度与坐标能同时给
   *
   * 它们**不是两份数据**。真源是 `cameraRig` 里的 `position` 与 `target` 两个点，
   * `yaw / pitch / distance` 由 `(position − target)` 反解得到（见 `render/cameraRig.ts`
   * 顶部的对照表）。所以四组控件只是同一份数据的四个视图：
   *
   * - 拖 yaw / pitch / 距离 ⇒ `placeCameraRig()` 反推 `position`（绕/沿观察点转、进退）
   * - 拖「相机坐标」      ⇒ `syncCameraRigAngles()` 反推角度（观察点不动，朝向跟着变）
   * - 拖「观察点」        ⇒ 相机不动、朝向改变
   *
   * 每条改完都回到同一个 `onCameraChange()`，所以**不存在「角度和坐标对不上」的中间态**。
   *
   * ## 三个必须写下来的坑
   *
   * 1. **这组控件绑的不是 `tuning`**，而是下面这个代理对象 —— 于是 `gui.onChange` 上
   *    那条 `event.object === this.tuning` 的守卫**不会**替它们调 `applyTuning()`
   *    （这是想要的：拖机位不该顺带遍历 700 枚币）。所以每条都要显式挂 `.onChange`。
   * 2. 代理对象用 `get` / `set` 存取器：`get` 每次都从 `cameraRig` 现读，
   *    所以「拖相机坐标把角度带偏了」会立刻反映到角度滑块上，不需要手动同步。
   * 3. **setter 里顺手把 `cameraAutoFit` 关掉**（并刷新那个复选框的显示）。
   *    一旦有人手动动机位就必须交出机位所有权 —— 否则下一次 `fitCamera()`
   *    （改 FOV、改窗口尺寸、切像素档位）会把机位弹回默认视角，看起来像「改了没用」。
   */
  private buildCameraFolder(): void {
    if (!this.gui) return;
    const folder = this.gui.addFolder('摄影机（角度 / 坐标）');

    const autoController = folder.add(this.tuning, 'cameraAutoFit').name('自动取景（fitCamera 解算）');
    this.cameraControllers.push(autoController);
    autoController.onChange(() => this.refreshCameraControllers());

    const takeOwnership = (): void => {
      if (!this.tuning.cameraAutoFit) return;
      this.tuning.cameraAutoFit = false;
      autoController.updateDisplay();
    };
    const apply = (): void => {
      this.actions.onCameraChange?.();
      this.refreshCameraControllers();
    };

    const view = {
      get yawDeg(): number {
        return toDeg(cameraRig.yaw);
      },
      set yawDeg(value: number) {
        takeOwnership();
        cameraRig.yaw = toRad(value);
        placeCameraRig();
      },
      get pitchDeg(): number {
        return toDeg(cameraRig.pitch);
      },
      set pitchDeg(value: number) {
        takeOwnership();
        // 夹到 ±89°：正好 ±90° 时水平分量归零，yaw 会退化（再转也看不出变化）。
        cameraRig.pitch = toRad(Math.max(-89, Math.min(89, value)));
        placeCameraRig();
      },
      get distance(): number {
        return cameraRig.distance;
      },
      set distance(value: number) {
        takeOwnership();
        cameraRig.distance = value;
        placeCameraRig();
      },
      get camX(): number {
        return cameraRig.position.x;
      },
      set camX(value: number) {
        takeOwnership();
        cameraRig.position.x = value;
        syncCameraRigAngles();
      },
      get camY(): number {
        return cameraRig.position.y;
      },
      set camY(value: number) {
        takeOwnership();
        cameraRig.position.y = value;
        syncCameraRigAngles();
      },
      get camZ(): number {
        return cameraRig.position.z;
      },
      set camZ(value: number) {
        takeOwnership();
        cameraRig.position.z = value;
        syncCameraRigAngles();
      },
      get targetX(): number {
        return cameraRig.target.x;
      },
      set targetX(value: number) {
        takeOwnership();
        cameraRig.target.x = value;
        syncCameraRigAngles();
      },
      get targetY(): number {
        return cameraRig.target.y;
      },
      set targetY(value: number) {
        takeOwnership();
        cameraRig.target.y = value;
        syncCameraRigAngles();
      },
      get targetZ(): number {
        return cameraRig.target.z;
      },
      set targetZ(value: number) {
        takeOwnership();
        cameraRig.target.z = value;
        syncCameraRigAngles();
      },
    };

    /**
     * 加一条数值控件。
     *
     * `decimals` 是**显示**精度：`NumberController.updateDisplay()` 不设它就直接
     * `String(value)` 打出来，于是一个由反解算出的角度会显示成 `31.7968000000001`。
     * 数值本身不受影响（拖拽仍按 `step` 取整）。
     */
    const add = (
      property: keyof typeof view,
      min: number,
      max: number,
      step: number,
      decimals: number,
      name: string,
    ) => {
      const controller = folder.add(view, property, min, max, step).name(name).decimals(decimals);
      controller.onChange(apply);
      this.cameraControllers.push(controller);
      return controller;
    };

    // 角度（绕观察点转）
    add('yawDeg', -180, 180, 1, 1, '方位角 yaw（度·0 = 正对机台）');
    add('pitchDeg', -89, 89, 1, 1, '俯角 pitch（度·正 = 在上方）');
    add('distance', 0.3, 12, 0.05, 2, '到观察点距离（米）');
    // 相机自己的世界坐标（观察点不动，朝向跟着变）
    add('camX', -12, 12, 0.05, 2, '相机坐标 x');
    add('camY', -12, 12, 0.05, 2, '相机坐标 y');
    add('camZ', -12, 12, 0.05, 2, '相机坐标 z');
    // 观察点（相机不动，只有朝向变）
    add('targetX', -4, 4, 0.01, 3, '观察点 x');
    add('targetY', -4, 4, 0.01, 3, '观察点 y');
    add('targetZ', -4, 4, 0.01, 3, '观察点 z');

    this.cameraNote = document.createElement('div');
    this.cameraNote.className = 'cp-debug-note';
    folder.$children.append(this.cameraNote);

    folder
      .add(
        {
          resetCamera: () => {
            this.tuning.cameraAutoFit = true;
            this.tuning.cameraFov = createDefaultTuning().cameraFov;
            // 走 `onChange`（= `applyTuning()`）：取景距离与 aspect 有关，只有 `Game` 知道。
            this.onChange();
            this.refreshCameraControllers();
          },
        },
        'resetCamera',
      )
      .name('回到默认取景');
    this.appendNote(
      folder,
      '拖任意一个控件都会关掉「自动取景」——改 FOV 或改窗口尺寸不会再夺回机位。' +
        `默认取景的观察点是 (0, ${CAMERA_FIT.centerY}, ${CAMERA_FIT.centerZ})、俯角 ` +
        `${toDeg(CAMERA_FIT.pitch).toFixed(0)}°。`,
    );
  }

  /**
   * 刷新摄影机控件的显示值与状态行。
   *
   * 由 `Game.fitCamera()` 在自动取景之后调用 —— 那时距离/角度被引擎重算过，
   * 而 lil-gui 只在**它自己**的改动上刷新显示，不主动读回。不刷新的话，
   * 改 FOV 会看到「距离」停在旧值上，看起来像坏了。
   *
   * ★ `updateDisplay()` 只写 DOM，不触发 `onChange`，所以这里没有回环风险。
   */
  refreshCameraControllers(): void {
    for (const controller of this.cameraControllers) controller.updateDisplay();
    if (!this.cameraNote) return;
    const f = (value: number, digits = 3): string => value.toFixed(digits);
    this.cameraNote.textContent =
      `相机 (${f(cameraRig.position.x)}, ${f(cameraRig.position.y)}, ${f(cameraRig.position.z)})` +
      ` · 看向 (${f(cameraRig.target.x)}, ${f(cameraRig.target.y)}, ${f(cameraRig.target.z)})` +
      ` · yaw ${f(toDeg(cameraRig.yaw), 1)}° pitch ${f(toDeg(cameraRig.pitch), 1)}°` +
      ` 距离 ${f(cameraRig.distance, 2)} m`;
  }

  private buildActionButtons(): void {
    if (!this.gui) return;
    const gui = this.gui;

    if (this.actions.onRefillWallet) {
      gui.add({ refill: () => this.actions.onRefillWallet?.() }, 'refill').name('钱包充值 +100');
    }
    if (this.actions.onClearSave) {
      gui.add({ clear: () => this.actions.onClearSave?.() }, 'clear').name('重置存档');
    }

    /*
     * 一键恢复全部物理旋钮。
     *
     * 调试时很容易连着改了七八个参数然后忘了自己改过什么——没有这个按钮就只能刷新页面，
     * 而刷新会连存档外的临时状态一起丢掉。它把调参表与运行时注册表**同时**复位，
     * 再走一次 `onChange`（= `applyTuning`）落盘，避免出现「表复位了但币还是旧参数」。
     */
    const defaults = createDefaultTuning();
    gui
      .add(
        {
          resetPhysics: () => {
            Object.assign(this.tuning, {
              gravity: defaults.gravity,
              solverIterations: defaults.solverIterations,
              erp: defaults.erp,
              predictionDistance: defaults.predictionDistance,
              coinSolverIterations: defaults.coinSolverIterations,
              conveyorSpeed: defaults.conveyorSpeed,
              pusherTravel: defaults.pusherTravel,
              pusherExtendSec: defaults.pusherExtendSec,
              pusherHoldFrontSec: defaults.pusherHoldFrontSec,
              pusherRetractSec: defaults.pusherRetractSec,
              pusherHoldBackSec: defaults.pusherHoldBackSec,
              boostTravelBonus: defaults.boostTravelBonus,
              coinFriction: defaults.coinFriction,
              coinRestitution: defaults.coinRestitution,
              coinDensity: defaults.coinDensity,
              coinLinearDamping: defaults.coinLinearDamping,
              coinAngularDamping: defaults.coinAngularDamping,
              coinMaxSpeed: defaults.coinMaxSpeed,
              coinMaxUpwardSpeed: defaults.coinMaxUpwardSpeed,
            });
            resetCoinPhysics();
            this.onChange();
            // 表里的值变了，但滑块显示还停在旧值——必须手动刷新一次。
            for (const controller of gui.controllersRecursive()) controller.updateDisplay();
          },
        },
        'resetPhysics',
      )
      .name('恢复全部物理默认值');
  }

  // ── 音效面板 ───────────────────────────────────────────────────────────

  private buildAudioFolders(audio: AudioSystem): void {
    if (!this.gui) return;
    const root = this.gui.addFolder('音效');
    root.close();

    // 试听与挂载共用一条状态行（放在「音效」根下，三个子面板都看得见）。
    const status = document.createElement('div');
    status.className = 'cp-audio-status';
    status.dataset.tone = 'info';
    status.textContent = '试听会绕过静音；上传的文件可挂到事件槽位';
    root.$children.append(status);
    const setStatus = (text: string, tone: 'info' | 'ok' | 'error' = 'info'): void => {
      status.textContent = text;
      status.dataset.tone = tone;
    };

    this.buildAudioAuditionFolder(root, audio, setStatus);
    this.buildAudioGainFolder(root, audio);
    this.buildAudioUploadFolder(root, audio, setStatus);
  }

  /** 每个游戏事件一个试听按钮。按钮名与顺序来自事件目录（唯一真源）。 */
  private buildAudioAuditionFolder(
    parent: GUI,
    audio: AudioSystem,
    setStatus: (text: string, tone?: 'info' | 'ok' | 'error') => void,
  ): void {
    const folder = parent.addFolder('试听');
    folder.close();
    const actions: Record<string, () => void> = {};
    for (const event of AUDIO_EVENTS) {
      actions[event.name] = () => {
        void auditionEvent(audio, event.name).then((result) => {
          if (result.played) {
            setStatus(`试听「${event.label}」→ ${result.source}`, 'ok');
            return;
          }
          // 失败只可能是音频上下文没跑起来（试听本身绕过静音）。
          setStatus(`未发声：音频上下文状态为 ${result.context}。先点一下游戏画面再试。`, 'error');
        });
      };
      folder.add(actions, event.name).name(event.label);
    }
  }

  /** 每个素材槽位一个实时音量滑块。改的是 `SELECTORS[key].gain`，发声当刻就生效。 */
  private buildAudioGainFolder(parent: GUI, audio: AudioSystem): void {
    const folder = parent.addFolder('音量');
    folder.close();
    const proxy: Record<string, number> = {};
    for (const info of audio.selectorInfos()) {
      proxy[info.key] = info.gain;
      folder
        .add(proxy, info.key, GAIN_MIN, GAIN_MAX, 0.01)
        .name(info.label)
        .onChange((value: number) => {
          audio.setGain(info.key, value);
        });
    }
  }

  /**
   * 上传本地音频 → 解码试听 → 可挂到某个事件槽位。
   *
   * ★ 注入的 DOM **必须挂在 gui 的子树内**（这里是 `folder.$children`）：
   * `hideDebugUi` 走的是 `gui.hide()`，它只把 root `gui.domElement` 置 `display:none`。
   * 挂到 `document.body` 就隐藏不掉，会污染截图测试。
   */
  private buildAudioUploadFolder(
    parent: GUI,
    audio: AudioSystem,
    setStatus: (text: string, tone?: 'info' | 'ok' | 'error') => void,
  ): void {
    const folder = parent.addFolder('上传与挂载');

    // 只有「有素材的槽位」才能挂载——合成音事件（热区命中/排水/收工…）没有槽位可言。
    const slotOptions: Record<string, SelectorKey> = {};
    for (const info of audio.selectorInfos()) slotOptions[info.label] = info.key;
    const target: { slot: SelectorKey } = {
      slot: (audio.selectorInfos()[0]?.key ?? 'drop') as SelectorKey,
    };

    const row = document.createElement('div');
    row.className = 'cp-audio-upload';

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'audio/*,.mp3,.wav,.ogg,.m4a,.flac';
    fileInput.className = 'cp-audio-file';

    row.append(fileInput);
    folder.$children.append(row);

    /** 已解码、但尚未挂载的文件。 */
    let pending: { buffer: AudioBuffer; name: string } | null = null;

    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      if (file.size > MAX_UPLOAD_BYTES) {
        pending = null;
        setStatus(`文件过大（${(file.size / 1024 / 1024).toFixed(1)} MB），上限 20 MB`, 'error');
        return;
      }
      setStatus(`正在解码 ${file.name} ……`);
      void (async () => {
        try {
          const buffer = await audio.decodeFile(file);
          pending = { buffer, name: file.name };
          // 选文件的目的就是「听听看」，所以解码完自动试听一次。
          audio.auditionBuffer(buffer, file.name);
          setStatus(
            `已解码 ${file.name}（${buffer.duration.toFixed(2)}s · ${buffer.sampleRate}Hz）`,
            'ok',
          );
        } catch (error) {
          // 与预载的静默跳过不同：这里必须把失败明确讲出来。
          pending = null;
          setStatus(
            `解码失败：${error instanceof Error ? error.message : String(error)}`,
            'error',
          );
        }
      })();
    });

    folder.add(target, 'slot', slotOptions).name('目标槽位');

    const actions: Record<string, () => void> = {
      audition: () => {
        if (!pending) {
          setStatus('先选一个音频文件', 'error');
          return;
        }
        const result = audio.auditionBuffer(pending.buffer, pending.name);
        setStatus(
          result.played ? `试听 ${pending.name}` : `音频上下文状态为 ${result.context}，先点一下游戏画面`,
          result.played ? 'ok' : 'error',
        );
      },
      mount: () => {
        if (!pending) {
          setStatus('先选一个音频文件', 'error');
          return;
        }
        audio.overrideSelector(target.slot, pending.buffer, pending.name);
        const label = audio.selectorInfos().find((info) => info.key === target.slot)?.label ?? target.slot;
        setStatus(`已挂载到「${label}」：${pending.name}。该事件在游戏里现在就用它。`, 'ok');
      },
      clearOne: () => {
        const cleared = audio.clearOverride(target.slot);
        setStatus(cleared > 0 ? `已清除「${target.slot}」的挂载` : `「${target.slot}」本来就没有挂载`, cleared > 0 ? 'ok' : 'info');
      },
      clearAll: () => {
        const cleared = audio.clearOverride();
        setStatus(`已清除全部挂载（${cleared} 个槽位）`, cleared > 0 ? 'ok' : 'info');
      },
    };
    folder.add(actions, 'audition').name('试听上传的文件');
    folder.add(actions, 'mount').name('挂载到该槽位');
    folder.add(actions, 'clearOne').name('清除该槽位挂载');
    folder.add(actions, 'clearAll').name('清除全部挂载');
  }

  /** 往 folder 里插一行说明文字（lil-gui 没有文本控件，只能注入 DOM）。 */
  private appendNote(folder: GUI, text: string): void {
    const note = document.createElement('div');
    note.className = 'cp-debug-note';
    note.textContent = text;
    folder.$children.append(note);
  }

  // ── 每帧 ───────────────────────────────────────────────────────────────

  /** 需要每帧调用：同步碰撞体可视化。 */
  update(): void {
    if (!this.enabled) return;
    if (!this.tuning.showColliders) {
      if (this.colliderLines) this.colliderLines.visible = false;
      return;
    }

    const { vertices, colors } = this.world.debugRender();
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 4));

    if (this.colliderLines) {
      this.colliderGroup.remove(this.colliderLines);
      this.colliderLines.geometry.dispose();
      (this.colliderLines.material as THREE.Material).dispose();
    }
    this.colliderLines = new THREE.LineSegments(
      geometry,
      new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthTest: false }),
    );
    this.colliderLines.visible = true;
    this.colliderGroup.add(this.colliderLines);
  }

  get overlay(): THREE.Group {
    return this.colliderGroup;
  }

  setHidden(hidden: boolean): void {
    if (!this.gui) return;
    if (hidden) this.gui.hide();
    else this.gui.show();
  }

  get active(): boolean {
    return this.enabled;
  }

  dispose(): void {
    // `destroy()` 会连注入进 `$children` 的上传行与说明文字一起移除，无残留监听器。
    this.gui?.destroy();
    this.gui = null;
    if (this.colliderLines) {
      this.colliderLines.geometry.dispose();
      (this.colliderLines.material as THREE.Material).dispose();
      this.colliderLines = null;
    }
    this.colliderGroup.clear();
  }
}

export const COIN_RADIUS = COIN.radius;
