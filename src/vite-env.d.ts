/// <reference types="vite/client" />

interface ThreeGameDiagnostics {
  frame: number;
  elapsed: number;
  phase: string;
  /**
   * 三账本 + 钱包。恒等式 `chips === buyIn + earned + begged − spent`
   * 必须在每一帧都成立——这是 P1 的核心验收，也是后面加机关/道具时最易写漏的地方。
   */
  chips: number;
  buyIn: number;
  earned: number;
  begged: number;
  spent: number;
  /** 此刻收工能回存钱包的筹码（已扣掉不可回存的跪求筹码）。 */
  cashOut: number;
  /** 钱包余额（跨局持久化，图鉴的购买力）。 */
  wallet: number;
  bestCombo: number;
  /** XIXI 四槽亮灭（跨局持续；点亮/集齐/摇奖/奖励事件在 telemetry.xixiEvents）。 */
  xixi: boolean[];
  /**
   * 本局被老虎机罚掉的筹码（胡萝卜四连，P10）。
   * **不进三账本恒等式**（已含在 `spent` 里）——判据要同时看它与 `spent ≥ fines`。
   */
  fines: number;
  boostCharges: number;
  settleReason: string | null;
  /** 收尾阶段推板是否已停板（扫板的开放条件）。 */
  plateStopped: boolean;
  activeCoins: number;
  /**
   * 本局累计越线结算枚数。与 `activeCoins` 配成守恒式用（见 `Game.settledCoins`）：
   * 「两个时刻的活跃币变少」本身不是丢币，期间推板照常在结算。
   */
  settledCoins: number;
  anomalies: number;
  /**
   * 掉进币床前侧角下水道的币数（P10 的「汇」）。
   * **与 `anomalies` 分开读**：前者是设计好的合法损失，后者是缺陷。
   */
  drained: number;
  /**
   * 币床上的活跃币数（P10 ⑦ 自动补币的判定口径）。
   *
   * ★ 它是**上一轮盘点的值**（每 `REFILL.checkEvery` 秒刷一次），不是当帧值；
   * ★ 它**不等于** `activeCoins`——后者含正在下落的、演出排队没落的、上层台面的币。
   *   补币判据必须读这个，读 `activeCoins` 会得到一个永不触发的静默失效。
   */
  bedCoins: number;
  /** 本局已触发的自动补货次数（P10 ⑦）。 */
  refills: number;
  /**
   * 此刻停在推板顶面（台面输送带）上的活跃币数。
   *
   * 它是「补货的币到没到币床」的现场：闸门吐的币先落在顶面，被输送带送过前缘才进币床。
   * 输送不带它们走的话，`activeCoins` 照涨而 `bedCoins` 一动不动——
   * 只有这个读数能区分「还在路上」与「卡在顶面」。
   */
  deckCoins: number;
  /**
   * 异常币飞出机柜时的**帧号、坐标与速度三分量**（`anomalies > 0` 时用它定位，最多 12 条）。
   * 只给速率是不够的：`vy` 主导说明是「被币堆弹飞」，`vx`/`vz` 主导才是「滑出边界」。
   */
  anomalySamples: Array<{
    frame: number;
    kind: string;
    x: number;
    y: number;
    z: number;
    vx: number;
    vy: number;
    vz: number;
    speed: number;
  }>;
  /**
   * 速度护栏被触发的次数与峰值速率（见 `COIN.maxSpeed`）。
   * **围板补上之后 `anomalies` 必然恒为 0，所以「求解器还在不在造能量」只能看这两个数。**
   */
  spikeClamps: number;
  peakSpikeSpeed: number;
  /**
   * 护栏压**之后**剩下的向上速度峰值（R4-P3「只减不增」的直接观测量）。
   * ⚠️ 它与 `peakSpikeSpeed` 不是同一个量的前后：那条是截断前**总速率**，
   * 这条是截断后**向上分量**。泄流律只逼近阈值、不越过，所以本值**允许大于阈值**，
   * 有效的上界是「≤ 截断前总速率」。
   */
  peakPostClampUpward: number;
  /** 钉阵：网格长度是显示值，碰撞体长度是物理值，两者刻意不同。 */
  pegs: {
    count: number;
    colliderHalfLength: number;
    visualHalfLength: number;
  };
  /** 选位状态：自动往返 / 手动接管。 */
  input: {
    lane: number;
    laneX: number;
    mode: string;
    manualHoldLeft: number;
  };
  /** 动效偏好：系统媒体查询或测试覆盖。 */
  motion: {
    reduced: boolean;
    source: string;
  };
  /**
   * 音频子系统摘要。
   *
   * `loadedSamples === 0` 是最有用的一个读数：说明**全部事件都在走合成音兜底**
   * （旧 Safari 不支持 Ogg Vorbis，或素材没取到）。没有它，「音效没变」与
   * 「音效根本没加载」在脚本层面无法区分。
   */
  audio: {
    muted: boolean;
    contextState: AudioContextState | 'none';
    loadedSamples: number;
    activeVoices: number;
    voiceCap: number;
    /** 已被上传文件临时挂载的槽位键。 */
    mounted: string[];
  };
  /** 机关：剩余次数与币预算余量。 */
  mechanisms: {
    sweeper: number;
    grapple: number;
    reload: number;
    coinsRemaining: number;
    /** P7：停板后的静止判定窗口（秒）。 */
    restHold: number;
    /** 一个完整推板循环的时长（秒）。判据用它算「窗口 ≥ 2 个循环」。 */
    pusherPeriod: number;
  };
  /** 投放演出状态：busy = 有演出在跑或在排（两态判据的中间态读这个）。 */
  shows: { busy: boolean; queued: number; active: string | null };
  /** 加注档位：`chips` 是每投消耗，`mul` 是越线返值倍率。 */
  bet: {
    index: number;
    chips: number;
    mul: number;
  };
  /** 热区：亮条当前位置与宽度（无尽恒开）。 */
  hotZone: {
    active: boolean;
    x: number;
    halfWidth: number;
  };
  /** 本局：筹码、存活投数、破产弹窗状态。 */
  endless: {
    active: boolean;
    begs: number;
    totalBegs: number;
    drops: number;
    chipsPeak: number;
    bestEarned: number;
    ruinVisible: boolean;
    /** 大赏币注入间隔（每多少投 1 枚）。测试读它，避免写死数字。 */
    bountyEveryDrops: number;
    /** 本局已注入的大赏币枚数（注入率断言的分子）。 */
    bounties: number;
  };
  pusher: {
    offset: number;
    phase: string;
    running: boolean;
    cycles: number;
    frontFaceZ: number;
  };
  physics: {
    bodies: number;
    colliders: number;
    substeps: number;
    /**
     * 当前物理旋钮，用来给实测记录标注参数组。
     *
     * `coin` / `pusher` 两块读的是**实际生效值**（`coinPhysics` 注册表与推板实例字段），
     * 不是调参表的镜像——调参表只是 UI，真正参与求解的是这两处。
     */
    tuning: {
      gravity: number;
      solverIterations: number;
      erp: number;
      coinSolverIterations: number;
      coin: {
        density: number;
        friction: number;
        restitution: number;
        linearDamping: number;
        angularDamping: number;
        maxSpeed: number;
        maxUpwardSpeed: number;
        /**
         * 上抛泄流时间常数（秒）。A/B 用它标注参数组：
         * `post ≤ 阈值` 这条判据**只在 τ→极小（硬截断）时成立**，
         * 读数不带走 τ 就没法复现（见 `Coin.clampSpeed`）。
         */
        upwardBleedTau: number;
      };
      pusher: {
        /** 单程行程（米）。 */
        travel: number;
        extendSec: number;
        holdFrontSec: number;
        retractSec: number;
        holdBackSec: number;
        boostTravelBonus: number;
        /** 一个完整往复周期的时长（秒）= 四段之和。 */
        period: number;
      };
    };
  };
  performance: {
    fps: number;
    tier: string;
    /** 内部分辨率的目标高度上限。调低 = 倍率更大 = 更省。 */
    pixelTargetHeight: number;
    /** 最近邻开关（`?pixel=N` 开、`off` 关；默认关 = 平滑）。 */
    pixelated: boolean;
    /** 整数放大倍率：backing store 与 CSS 尺寸之比。1 = 原生。 */
    upscale: number;
    /** 实际内部渲染高度（CSS 像素）。 */
    internalHeight: number;
    shadows: boolean;
  };
  collection: {
    wallet: number;
    coinSkin: string;
    cabinetSkin: string;
    coinSkins: number;
    cabinetSkins: number;
  };
  /**
   * 背板老虎机（P10）：4 个滚筒窗的读数。
   *
   * `iconBackPixels` 是「图标在画布上占几个后备像素」——像素画 1:1 的判据，
   * 目标 32（0.34 m 窗 × 191 CSS px/m ÷ upscale 2）；默认档 upscale 1 → 66.7，
   * 即图标被平滑放大到两倍多，判据写的是「≥ 24」而不是「=== 32」。
   */
  reel: {
    count: number;
    windowSize: number;
    windowY: number;
    windowZ: number;
    windowPitch: number;
    iconTexels: number;
    stripTiles: number;
    targetIndex: number[];
    faces: string[];
    lampIntensity: number;
    spinning: boolean;
    iconBackPixels: number;
    iconCssPixels: number;
    rowWidth: number;
  };
  renderer: {
    calls: number;
    triangles: number;
    geometries: number;
    textures: number;
    /** 描边的当前生效值（强度 + 两条阈值）。判据读的就是这一份。 */
    outline: { scale: number; id: number; depth: number; grazing: number };
  };
  canvas: {
    clientWidth: number;
    clientHeight: number;
    width: number;
    height: number;
    /** 真实 DPR。只作诊断，不参与分辨率计算（V1 起）。 */
    dpr: number;
    /** 整数放大倍率，与 `performance.upscale` 同值。 */
    upscale: number;
  };
}

/**
 * 推板前缘 XIXI 标牌的读数（`Pusher.xixiLaneReport`）。
 *
 * 除了亮灭颜色，还带**徽章身份**（贴的哪个图标、几纹素）与**四段几何**
 * （单段尺寸、中心、总宽）。后两者是为了抓那些「截图上看不出来」的缺陷：
 * 段宽与 `xixiSlot()` 的分段脱钩、四段之间有缝/重叠、图标被横向拉扁。
 * 读数取的是**实际几何与实际贴图**，不是再抄一份常量。
 */
interface ThreeXixiLaneReport {
  count: number;
  colors: string[];
  lit: boolean[];
  /** 四段上画的徽章图标（身份读数）。 */
  badgeIcon: string;
  /** 徽章贴图的纹素尺寸。 */
  badgeTexels: { width: number; height: number };
  /** 单段的世界尺寸（来自几何包围盒）。 */
  segment: { width: number; height: number; depth: number };
  /** 四段中心 x（来自实例矩阵）。 */
  centers: number[];
  /** 徽章带的总宽 = 段宽 × 段数。 */
  totalWidth: number;
}

/**
 * 机柜一件的**实测**读数（`Game` 的 `cabinetReport` 钩子）。
 *
 * 与 `cabinetShape.ts` 的**解析**盒配对使用：判据把两边逐轴比对，
 * 谁的公式错了都当场失败。`normal` 是该件局部 +z（面法线）在世界里的方向，
 * 用来钉招牌朝向 —— S18 把倾角符号写反，招牌正面朝了地面，
 * 而那件事在「尺寸」上是完全合法的，只有法线能看见。
 */
interface ThreeCabinetPartReport {
  /** 身份（`userData.part`）。刷哪张贴图、导出叫什么名字都由它决定。 */
  part: string;
  /** 色带（`userData.role`）。与 `part` **正交**；无 role 的件为 `null`。 */
  role: string | null;
  min: [number, number, number];
  max: [number, number, number];
  /** 局部 +z 在世界里的单位方向。 */
  normal: [number, number, number];
  /**
   * 该件材质实例名 / 其 `map` 的 uuid（无 map 为 `null`）。
   *
   * 「贴图到底挂在哪一件上」只有这一条观测通道：`cabinetMapCount()` 是全场总量，
   * 答不出「侧板挂了、背板没挂」——而后者正是 R1-M3 拆 `panelArt` 的全部意义。
   */
  material: string | null;
  map: string | null;
  /**
   * `emissiveMap` 的 uuid（null = 没挂）。
   *
   * 与 `map` 分开报，是因为「贴图挂上了」和「灯亮着」是两件事：侧墙走深色 `panel`
   * 色带，`MeshToonMaterial` 又是 `color × map`，只挂 `map` 的灯饰在游玩视角读作
   * 暗斑。判据要能分辨「只挂了 map」和「map + emissiveMap」。
   */
  glow: string | null;
}

/**
 * 摄影机机位读数（`src/render/cameraRig.ts` 的 `cameraRigReport()`）。
 *
 * ★ 位置与角度**不是两份数据**：`yawDeg / pitchDeg / distance` 是
 * `(position − target)` 的球坐标反解。判据要问的是「两条路解出来的东西对不对得上」，
 * 所以两边都必须交出来，缺一个就查不出「改坐标没同步角度」这类静默错。
 */
interface ThreeCameraRigReport {
  position: [number, number, number];
  target: [number, number, number];
  yawDeg: number;
  pitchDeg: number;
  distance: number;
}

/**
 * 机位改写指令。
 *
 * ★ 两条规则与调试面板的 setter **逐字同义**（两条路一旦分叉就会出现
 * 「面板绿、脚本红」那种没法解释的差异）：
 * 1. **手动字段胜出**：`autoFit: true` 先按取景框解一次，之后给出的坐标 / 角度盖在它上面。
 * 2. **出现任何一个手动字段（角度 / 相机坐标 / 观察点）就交出机位所有权**
 *    （`cameraAutoFit` 翻 false）。只给 `autoFit` 时不翻 ——
 *    否则「回到默认取景」（`{ autoFit: true }`）会把自己刚打开的开关关掉。
 */
interface ThreeCameraRigPatch {
  /** 是否交还给 `fitCamera()` 自动取景。`true` = 回到默认取景，`false` = 交出所有权。 */
  autoFit?: boolean;
  /** 方位角（度）。0 = 相机在观察点的 +z 侧（正对机台的游玩方向）。 */
  yawDeg?: number;
  /** 俯角（度）。正 = 相机在观察点上方。 */
  pitchDeg?: number;
  /** 到观察点的距离（米）。 */
  distance?: number;
  /** 相机世界坐标。给了它 = 观察点不动、朝向跟着变（角度被反解）。 */
  camX?: number;
  camY?: number;
  camZ?: number;
  /** 观察点世界坐标。给了它 = 相机不动、只有朝向变。 */
  targetX?: number;
  targetY?: number;
  targetZ?: number;
}

interface ThreeGameTestHooks {
  /** Re-seed the game RNG; all gameplay randomness must flow through it. */
  seed(value: number): void | Promise<void>;
  /** Acknowledge after setup/assets are ready; throw for unknown states. */
  setState(name: string): { state: string } | Promise<{ state: string }>;
  /** Stop simulation/state transitions immediately; keep rendering. */
  setPausedForScreenshot(paused: boolean): void | Promise<void>;
  /** Stabilize ambient/idle visuals without requiring an unpaused simulation tick. */
  setReducedMotion(enabled: boolean): void | Promise<void> | { reduced: boolean; source: string };
  /**
   * 只停/启推板，**不重置盘面**。
   *
   * 穿模判据必须量「币堆自己静止之后」的状态：推板正在挤压时币会顺着推币面爬上去、
   * 短暂彼此嵌入，那是推币机的正常形态；要判的是停下来还嵌着的那种。
   */
  setPusherRunning?(running: boolean): { running: boolean; cycles: number };
  /** Hide debug UI (lil-gui) before capturing. */
  hideDebugUi(hidden: boolean): void | Promise<void>;
  /** 推币机扩展：强制画质档位（high / medium / low），并冻结自动分档。 */
  setQuality?(tier: string): { tier: string; pixelTargetHeight: number; shadows: boolean };
  /**
   * 推币机扩展：像素分辨率（V1，V2 解耦）。`pixelated` 只切最近邻/平滑采样，
   * `upscale` 是显式内部分辨率倍率（`null` 取消、回到 `targetHeight` 推导）——两者正交。
   */
  setPixelScale?(patch: { targetHeight?: number; upscale?: number | null; pixelated?: boolean }): {
    upscale: number;
    pixelRatio: number;
    internalWidth: number;
    internalHeight: number;
    targetHeight: number;
    pixelated: boolean;
  };
  /** 推币机扩展：机器人试玩接口。lane 为 -1..1 的归一化选位。 */
  drop?(lane: number): boolean;
  /** 推币机扩展：使用一次已充能的加力。 */
  boost?(): boolean;
  /** 推币机扩展：读取当前局面快照。 */
  snapshot?(): unknown;
  /** 推币机扩展：采样活跃币的位置与速度，用于落点与推进断言。 */
  coins?(): Array<{
    /** 对象池槽位号，跨帧稳定标识同一枚币。 */
    slot: number;
    kind: string;
    x: number;
    y: number;
    z: number;
    vz: number;
    /** 合速度（米/秒）。静置断言用它，只看 vz 会漏掉横向漂移。 */
    speed: number;
    playerDropped: boolean;
    /**
     * 开局预置币（`Coin.preset`）。运行期注入的币（闸门/喷泉/塔/大赏）是 `false`。
     *
     * 与 `playerDropped` **不是一回事**：闸门吐的币既不是预置、也不是玩家投的。
     * 台面输送带按这个字段让路，所以「补货的币卡在推板顶面」这类缺陷
     * 要靠它来定位。
     */
    preset: boolean;
  }>;
  /** 调试用：列出指定点附近的碰撞体世界位置。 */
  probeColliders?(x: number, y: number, z: number): Array<Record<string, unknown>>;
  /**
   * 调试用：从某点竖直向下打一条射线，返回第一个命中的碰撞体。
   *
   * 排查币堆穿模时，币的坐标只能说明「沉下去了」，射线才能说明「沉进了什么」。
   */
  castDown?(
    x: number,
    y: number,
    z: number,
  ): { distance: number; hitY: number; shapeType: number; isSensor: boolean } | null;
  /** 调试用：报告地板网格、推板顶面与最低几枚币的网格世界包围盒（渲染侧）。 */
  probeMeshes?(): Array<Record<string, unknown>>;
  /**
   * 调试/验证用：从接触流形读真实穿透深度（单位米）。
   *
   * `coinDeepest` 是币与币之间最深的一处穿透，`staticDeepest` 是币与机台之间的。
   * 与姿态无关，所以不会把「斜币靠着邻居」误判成穿模。
   */
  penetrationReport?(limitMillimeters: number): {
    coinContacts: number;
    staticContacts: number;
    coinDeepest: number;
    staticDeepest: number;
    overLimit: number;
    worst: Array<{ depth: number; pair: string; at: [number, number, number] }>;
  };
  /** 调试用：实时改写调参项（推板行程、台面输送速度等）。 */
  /**
   * 实时改写调参项（调试面板共用同一条落盘路径）。
   *
   * 参数放宽到 `number | boolean`：原先只收 `number`，导致 `pixelated` / `muted` /
   * `showColliders` 这几个布尔项在脚本里设不了（`Object.assign` 运行时本来就支持）。
   */
  setTuning?(patch: Record<string, number | boolean>): Record<string, unknown>;
  /**
   * 直接写 `coinPhysics` 注册表（不经调参表、不上滑块）。
   * 拼错的键会抛错，不会静悄悄写进一个不存在的属性。
   */
  setCoinPhysics?(patch: Record<string, number>): Record<string, number>;

  // ── 音频调试 ────────────────────────────────────────────────────────────
  // 这一组与调试面板的「音效」folder 共用同一张事件表（`audioCatalog.ts`），
  // 所以脚本能试听到与面板点击完全一致的东西。
  /** 列出全部可试听事件名。 */
  soundNames?(): string[];
  /**
   * 试听一个事件名。
   *
   * **绕过静音**（调试面板最忌讳点了没声音），也**不消耗节流窗口**（连点必须每次都响）。
   * 返回 `played: false` 只可能是音频上下文没跑起来——`context` 字段会说明状态。
   */
  sound?(name: string): Promise<{
    played: boolean;
    name: string;
    selector: string | null;
    /** `override` = 用了挂载的文件，`sample` = 用了预载素材，`synth` = 合成音兜底。 */
    source: 'override' | 'sample' | 'synth' | 'none';
    context: AudioContextState | 'none';
  }>;
  /** 无参 → 全局摘要（含全部事件清单）；带参 → 单事件详情。 */
  soundInfo?(name?: string):
    | {
        muted: boolean;
        contextState: AudioContextState | 'none';
        loadedSamples: number;
        activeVoices: number;
        voiceCap: number;
        mounted: string[];
        events: Array<{
          name: string;
          label: string;
          selector: string | null;
          mountable: boolean;
          mounted: boolean;
        }>;
      }
    | {
        name: string;
        label: string;
        selector: string | null;
        mountable: boolean;
        mounted: boolean;
        gain: number | null;
        throttleMs: number | null;
        samples: string[];
      }
    | null;
  /** 实时改某个素材槽位的音量（0..3）。改完发声当刻即生效。 */
  setSoundGain?(selector: string, value: number): { selector: string; gain: number };
  /** 清除槽位挂载。不传 `selector` 则清全部，返回清除的条数。 */
  clearSoundOverride?(selector?: string): { cleared: number };
  /**
   * 从 URL 取音频解码后挂到槽位。
   *
   * 这是 GUI 之外的能力，专供脚本化验证：不必真的去操作 `<input type=file>`，
   * 就能把「挂载 → 事件走 override 路径」这条链跑通。
   */
  overrideSoundFromUrl?(
    selector: string,
    url: string,
  ): Promise<{ ok: boolean; selector: string; name: string; duration: number }>;
  /** 调试用：只设定选位、不投币（视为一次手动接管）。 */
  setLane?(lane: number): { lane: number; laneX: number };
  /** 机关：直接触发，返回是否生效。 */
  sweep?(): boolean;
  grapple?(laneX: number): boolean;
  reload?(): boolean;
  /** 无尽模式：切换加注档位。 */
  cycleBet?(): boolean;
  mechanisms?(): { sweeper: number; grapple: number; reload: number };
  /**
   * 机关构件（R5）：横扫臂 / 抓斗爪的在场与**交付剖面**。
   *
   * 为什么必须有这条通道：「分批给冲量」与老写法「一次全给」在账本上**完全等价**
   * （总冲量、落点、越线全一样），任何计数型判据都读不出区别。只有交付**时刻**
   * （`firstHitAt`~`lastHitAt` 的跨度、抓斗 `deliveredAt` 晚于提升）能证明改造生效。
   * 时刻记在引擎自己的时间轴上（降动效只压墙钟、不压这条轴），所以判据不抖。
   */
  mechanismShow?(): {
    active: 'sweep' | 'grapple' | null;
    busy: boolean;
    mesh: { name: string; x: number; y: number; z: number; mounted: boolean } | null;
    last: {
      id: 'sweep' | 'grapple';
      targeted: number;
      delivered: number;
      skipped: number;
      firstHitAt: number;
      lastHitAt: number;
      deliveredAt: number;
    } | null;
  };
  /** 无尽模式：开局 / 跪求 / 收工。 */
  startRun?(): boolean;
  beg?(): boolean;
  quitRun?(): void;
  /**
   * 把当前这一局**就地**推到破产弹窗，不重开新局。
   *
   * `setState('ruin')` 会先 `startRun()`，于是本局的 `earned` / `begsThisRun` 被清零；
   * 要测「收工 → 总结页」这类**依赖本局累计值**的路径，就必须用这个钩子。
   */
  forceRuin?(): boolean;
  /**
   * 把币床掏空到只剩 `keep` 枚（P10 ⑦ 补币判据的状态构造器），返回实际删掉的枚数。
   *
   * 「台面见底」在真实玩法里要玩好几分钟才到得了，用它当验收入口会让判据变成慢测。
   * 删的顺序是**从最靠前（z 最大）开始**——与币床自然变薄同序。
   * 只 `despawn` 不碰账本：币不是筹码，恒等式不受影响。
   */
  clearBedTo?(keep?: number): number;
  run?(): {
    begs: number;
    totalBegs: number;
    best: number;
    wallet: number;
    /** 累计充值额（脚本主动补钱包的次数），钱包守恒算式要把它算进去。 */
    refilled: number;
    ruinVisible: boolean;
    summaryVisible: boolean;
  };
  /** 三账本 + 钱包快照，用于逐笔核对恒等式。 */
  ledger?(): {
    buyIn: number;
    earned: number;
    begged: number;
    spent: number;
    chips: number;
    cashOut: number;
    wallet: number;
    refilled: number;
  };
  /** 加注档位表（含返值倍率）。 */
  betTiers?(): Array<{ chips: number; mul: number; label: string }>;
  /** 经济纯函数：验证脚本用它做蒙特卡洛（不碰物理）。 */
  crossingReturn?(input: {
    kind: string;
    combo: number;
    hot: boolean;
    betMul: number;
    roll: number;
  }): { chips: number; gated: boolean; blocked: boolean };
  /** 调试用：读取无尽台面配置摘要。 */
  table?(): {
    name: string;
    coins: number;
    value: number;
    /** 按币种计数：P6 之后的通路口径（新增币种自动出现）。 */
    byKind: Record<string, number>;
    /** 币种清单（`kinds.ts` 的 `COIN_KINDS`）：判据用它核对 `byKind` 的键集。 */
    kinds: string[];
    /** 旧字段，保留给既有判据读；新判据一律走 `byKind`。 */
    bronze: number;
    pattern: number;
    payout: number;
    /** 上层台面（推板顶面）与币床的预置枚数。 */
    deck: number;
    bed: number;
    /**
     * 盘面容量：把稀疏铺去掉后这份配置能放多少枚。
     * 判据用它算「填充率」——满盘枚数随币尺寸档位变，填充率不变。
     */
    capacity: number;
  };
  /** 图鉴与外观：读取当前钱包与选用外观。 */
  /**
   * 推币机扩展（V2）：材质族统计 + 色带数 + 已编译程序数。
   * `toon` 数骤降说明有人绕过了 toon 工厂（裸建材质或 clone 掉了补丁）；
   * `programs` 是首帧编译爆炸的哨兵。
   */
  materialReport?(): Record<string, number>;
  /**
   * G3-a：回读通道附件 0 得到的**面 ID 可分差**实测。
   *
   * 键：`width` `height` `distinctIds` `minGap` `objectEdges` `silhouetteEdges`
   * `edgesBelowThreshold` `backgroundShare` `threshold` `readFailed`。
   * 描边阈值必须由它来定 —— 见方法注释里「判据要按可分差设计，不是按看起来有描边设计」。
   */
  gbufferReport?(): Record<string, number>;
  /**
   * 已编译程序的**指纹名单**（R2-T2）。
   *
   * `materialReport().programs` 只有一个总数 —— 从 20 涨到 29 判据都还绿，
   * 但「多出来的是哪一份程序」读不出来。这里按 cacheKey 的可读指纹分组给出，
   * `verify-game.mjs perf` 会把它整张打印出来。
   */
  programRoster?(): Array<{ fingerprint: string; variants: number }>;
  /**
   * 招牌显示屏实测读数（R3-U4）。屏不在 `cabinetReport()` 的 7 件里
   * （它不吃换肤与贴图分发，所以没有 `part`），只能靠这个通道观测。
   */
  marqueeReport?(): {
    width: number;
    height: number;
    /** 纹理纹素尺寸：与 `width/height` 的比值相等才是「没被拉伸」。 */
    textureWidth: number;
    textureHeight: number;
    world: [number, number, number];
    materialName: string;
    mapIsScreen: boolean;
    emissiveMapIsScreen: boolean;
    offsetX: number;
  } | null;
  /**
   * 推币机扩展（V4）：币面贴图的实际纹素与采样设置。
   * `center` 是贴图正中心（有字形时是字色），`quarter` 是 1/4 处（纹样/颗粒区）。
   */
  coinReport?(): Record<string, Record<string, unknown>>;
  /**
   * 推币机扩展（S19）：机柜外壳每件的**实测**包围盒与面法线。
   *
   * 这是「机柜长什么样」**第一次**成为可断言的东西。S18 之前，
   * 外壳尺寸只存在于 `buildCabinetShell()` 的局部 `const` 里 —— 没有任何判据能引用，
   * 于是那块朝反了的实心砖让 `perf` / `drawcall` / `programs` / `cabinetTex` / `models`
   * 全绿。读数取的是**场景里真实网格**（`Box3.setFromObject` + 世界矩阵），
   * 不是再抄一份常量：几何建错了但记的是漂亮数字，这里照样会暴露。
   */
  cabinetReport?(): ThreeCabinetPartReport[];
  /**
   * 推币机扩展（S22）：摄影机机位。`autoFit` 与 `cameraPeakOffset` 一并交出，
   * 因为「手动动机位」最容易踩坏的就是 S17 那条铁律（相机不得偏离基准位置）。
   */
  cameraReport?(): ThreeCameraRigReport & { autoFit: boolean; cameraPeakOffset: number };
  /**
   * 推币机扩展（S22）：改写机位（与调试面板的「摄影机」分组走同一条路径）。
   *
   * 返回值带上 `autoFit`：任何**手动字段**（角度 / 相机坐标 / 观察点）都会顺手把
   * 自动取景关掉（= 交出机位所有权），脚本要能一句话验到这件事。
   */
  setCameraRig?(patch: ThreeCameraRigPatch): ThreeCameraRigReport & { autoFit: boolean };
  /**
   * 推币机扩展（S24）：模型模式（`?model`）的测试钩子。
   *
   * 判据只走这几个 —— 它们内部走的是**与面板同一条路**
   *（写形状 → `onShapeChanged` → 重建整具外壳），不自己另造一具。
   * 两条路一旦分叉，就会出现「面板上能用、判据红」这种没法解释的差异。
   *
   * 非 `?model` 下 `modelModeEnabled()` 为 `false`，其余返回 `-1` / `null`。
   */
  modelModeEnabled?(): boolean;
  /** 当前形状与编译期默认值的差异条数（「导出改动」的内容量）。 */
  modelModeDiffCount?(): number;
  /** 当前选中件（`userData.part`），未选中为 null。 */
  modelModeSelected?(): string | null;
  /**
   * 按 `'wall.insetZ'` / `'hood.valanceInnerZ'` 这样的路径写一个数并重建。
   *
   * 返回 `void`：判据要验的是「场景里的几何跟没跟着变」，
   * 所以它必须自己去读 `cabinetReport()`，不能靠这里的返回值自证。
   */
  modelModeSet?(path: string, value: number): void;
  /** 走与「重置为默认造型」按钮同一条路。 */
  modelModeReset?(): void;
  /**
   * 选中一个外壳件。走的是与「点一下机柜件」**同一条** `select()`
   * （含高亮、边文件夹重建、参数分组自动展开）。
   *
   * 件名不在 `CABINET_SHELL_PARTS` 里时返回 `false`。
   */
  modelModeSelect?(part: string): boolean;
  /**
   * 当前挂着几条选中指示线：0 = 没选中，1 = 只有件轮廓，2 = 件轮廓 + 边高亮。
   *
   * ★ 高亮「有没有加上」只能靠计数：WebGL 忽略 `LineBasicMaterial.linewidth`，
   * 指示线永远是 1 像素，在截图上看不看得出来取决于构图，不能当判据。
   */
  modelModeOutlineCount?(): number;
  /**
   * 模型模式手里那具外壳**还在场景里**（`parent !== null`）。
   *
   * ★ 与 `modelModeOutlineCount()` 成对：那条只说「挂了几条线」，这一条说
   * 「那些线的宿主在不在渲染树里」。重建时多调一次 `rebuild()` 而没人 `attach()`
   * 返回值，宿主就变成游离节点 —— 计数照旧、画面全黑，只有这一条抓得住。
   * 非 `?model` 下为 `null`。
   */
  modelModeShellAttached?(): boolean | null;
  /**
   * 推币机扩展（S24）：外壳形状的**应用实例**读数。
   *
   * ## ★ 为什么必须有这个钩子
   *
   * `cabinet` 与 `model` 两个模式原先都靠
   * `page.evaluate(async () => await import('/src/game/cabinetShape.ts'))`
   * 去读真源。实测（2026-09-28）那拿到的是**另一个模块实例**：
   * 模型模式把 `hood.valanceInnerZ` 改成 0.3 之后，那边读到的
   * `cabinetShape()` 仍是 0.195、`isCabinetOverridden()` 仍是 false。
   *
   * 后果分两种，都是「判据骗人」：
   *   - 拿它验「覆盖层生效了吗」⇒ **恒 false**，永远绿；
   *   - 拿它验「解析盒 = 实测盒」⇒ 恒拿默认值去比，调参期间必红（假红）。
   *
   * 所以凡是要读**当前生效形状**的判据，一律走这个钩子。
   * 纯默认值的比对（`cabinet` 模式那几条）继续用 `import()` 也无妨 ——
   * 两个实例的 `CABINET` 是同一份编译期常量。
   */
  cabinetShapeReport?(): {
    /** 覆盖层是否在应用实例里生效（`?model` 之外恒 false）。 */
    overridden: boolean;
    /** 当前生效的形状（应用实例的那一份）。 */
    shape: Record<string, unknown>;
    parts: string[];
    boxes: Record<string, { min: [number, number, number]; max: [number, number, number] }>;
    outlines: { tall: Array<[number, number]>; low: Array<[number, number]> };
  };
  collection?(): {
    wallet: number;
    coinSkins: string[];
    cabinetSkins: string[];
    selectedCoinSkin: string;
    selectedCabinetSkin: string;
  };
  /** 图鉴与外观：清空存档（仅测试用）。 */
  clearSave?(): { wallet: number };
  /** 直接设定 XIXI 四槽亮灭（只改渲染状态，不碰存档与遥测）。 */
  setXixi?(slots: boolean[]): ThreeXixiLaneReport;
  /** 推板前缘 XIXI 标牌的实际状态与几何（判据按计数比对，不看截图）。 */
  xixiLanes?(): ThreeXixiLaneReport;
  /** 世界里的碰撞体总数（R4-4b 塔柱体的生命周期自证用，按需调、不进每帧 diagnostics）。 */
  countColliders?(): number;
  /** 演出窗口内越线的分类累计（R4-4b 的「汇」）：见 `Game.showWindowCrossings`。 */
  showWindow?(): { crossings: number; foreign: number };
  /** 往钱包补筹码（测试/调试）：反复 `startRun` 会把钱包掏空，用例前先补满。 */
  refillWallet?(amount?: number): { wallet: number; refilled: number };
  /** 把钱包设成指定值：用来确定性构造「钱包见底」场景。 */
  setWallet?(amount: number): { wallet: number; refilled: number };
  /** 图鉴与外观：解锁一个外观。 */
  unlockSkin?(kind: string, id: string, cost: number): { unlocked: boolean; wallet: number };
  /** 图鉴与外观：选用一个已解锁的外观。 */
  selectSkin?(
    kind: string,
    id: string,
  ): { selected: boolean; coinSkin: string; cabinetSkin: string };
  /** 试玩遥测：开启记录（默认关闭，避免影响正常游玩开销）。 */
  enableTelemetry?(): { enabled: boolean };
  /**
   * 试玩遥测汇总。关键因果由模拟内部记录，比外部按帧采样可靠——
   * 「币越线当帧就被移除」这类瞬时事件在采样间隔里会被漏掉。
   */
  telemetry?(): {
    scoreEvents: Array<{
      kind: string;
      /** 本枚币入账的筹码（已含热度、热区与加注倍率）。 */
      value: number;
      z: number;
      combo: number;
      chipsBefore: number;
      chipsAfter: number;
      sincePrevious: number;
      hot: boolean;
    }>;
    fallOffEvents: Array<{
      z: number;
      frontFaceZ: number;
      offset: number;
      phase: string;
    }>;
    /** 掉进下水道的币（P10）：经济上「汇」的直接读数。 */
    drainEvents: Array<{
      side: number;
      kind: string;
      x: number;
      z: number;
      y: number;
      offset: number;
      t: number;
    }>;
    /** 选位采样点：验证自动选位是否匀速。 */
    laneSamples: Array<{ t: number; x: number; mode: string }>;
    /** 选位模式切换：验证手动接管与恢复是否跳变。 */
    laneEvents: Array<{ t: number; x: number; mode: string; event: 'enter' | 'resume' }>;
    /** 每个推板循环结束时的累计赚进筹码与累计越线枚数：相邻枚数差 = 该循环推下几枚。 */
    cycles: Array<{ cycle: number; earned: number; coins: number }>;
    /** 投放演出事件（P4）：两态判据的数据源——registered（币未动）→ completed（币已到位）。 */
    showEvents: Array<{
      id: string;
      phase: 'registered' | 'completed' | 'refused';
      requested: number;
      promised: number;
      spawned: number;
      downgraded: boolean;
      reason?: string;
      t: number;
    }>;
    /** XIXI 集章与老虎机事件（P5；P10 起 spin/reward 带三分类结果）。 */
    xixiEvents: Array<{
      phase: 'lit' | 'completed' | 'spin' | 'reward';
      slot?: number;
      /** 中奖符号（仅 `win` 时有值）。 */
      symbol?: string;
      /** 三分类结果（P10）：win / fine / miss。 */
      outcome?: 'win' | 'fine' | 'miss';
      /** 四个滚筒的停格图标（画面自证：四连还是杂牌）。 */
      faces?: string[];
      /** 胡萝卜四连的实扣筹码（`fine` 才有）。 */
      fined?: number;
      granted?: boolean;
      delivered?: number;
      t: number;
    }>;
    drain: {
      reason: string | null;
      startedAt: number | null;
      earnedAtStart: number;
      settledAt: number | null;
      earnedAtSettle: number;
    };
  };
  /**
   * P4 投放演出统一入口。返回 { ok, promised, downgraded, reason? }；
   * 演出生命周期事件进 `telemetry().showEvents`。
   */
  showRequest?(id: string, opts?: { count?: number; kind?: string; x?: number }): {
    ok: boolean;
    id: string;
    promised: number;
    downgraded: boolean;
    reason?: string;
  };
  /** XIXI 槽位映射（引擎纯函数）：判据枚举调用它收成集合，不在测试里手写分段。 */
  xixiSlot?(x: number): number;
  /** 装置规模表：判据写「实发 = 承诺」时读它，不手抄枚数（改配置不该弄红测试）。 */
  showSpecs?(): Record<string, { count: number; min: number }>;
  /**
   * 纯视觉币通道的读数（S16）。`reset = true` 时顺带清零统计。
   *
   * `peakYOutside` 是这条通道存在意义的唯一硬证据：币在**机柜侧壁外沿之外**
   * 达到过的最高点。它 < `GLASS_TOP`（1.6）就说明币是穿过玻璃围板飞出去的。
   */
  sprayReport?(reset?: boolean): {
    active: number;
    capacity: number;
    visible: boolean;
    launched: number;
    peakYOutside: number;
    outsideX: number;
  };
  /** 视觉币材质与铜币材质的 defines 对比（证明共用同一份程序）。 */
  sprayMaterial?(): {
    spray: Record<string, unknown>;
    bronze: Record<string, unknown>;
    /** 两张贴图的 uuid：证明它们是**两个实例**（共享会在币池 dispose 时被误释放）。 */
    sprayMap: string | null;
    bronzeMap: string | null;
  };
  /**
   * S18：机柜挂 `map` 通道的材质数（招牌 + 得分线 + 热区 = 3）。
   *
   * 判据用它确认切肤重画链没漏件：剩 0 ⇒ 漏挂；剩 > 3 ⇒ 多挂（动 mesh.role 顺序）。
   */
  cabinetMapCount?(): number;
  /**
   * 「加力已存满」的兜底配置（P10 ⑨）：改派哪个装置、发几枚、存满上限。
   * 判据同样从引擎读——兜底规模是可调的平衡旋钮，抄进脚本就是第二份真源。
   */
  boostOverflowSpec?(): { show: string; count: number; cap: number };
  /**
   * 得分反馈分级（P10 ⑨）：阈值 + 三个材质的自发光基线/峰值。
   * 判据从引擎读，不在脚本里手抄 25 / 3 / 5。
   */
  feedbackSpec?(): {
    flyScoreBig: number;
    comboPulse: number;
    comboClimax: number;
    emissive: { scoreLineBase: number; scoreLinePeak: number; hotZoneBase: number; hotZonePeak: number };
  };
  /** 反馈分级的纯函数：判据枚举边界点核对分支，不重写公式。 */
  crossingFeedbackProbe?(input: {
    chips: number;
    combo: number;
    hot: boolean;
    kind?: string;
    /** 被概率闸门拦下（`crossingReturn().blocked`）：压掉币种高潮，连落白闪不受影响。 */
    blocked?: boolean;
  }): {
    flyTier: 'normal' | 'big';
    scoreLinePulse: boolean;
    hotFlash: boolean;
    climax: { strength: number; tone: string; reason: 'combo' | 'kind' } | null;
  };
  /** 反馈的实时状态：各档发生次数 + 三个材质的当前自发光（计数与画面同源）。 */
  feedbackReport?(): {
    counts: {
      flyNormal: number;
      flyBig: number;
      comboPulse: number;
      comboClimax: number;
      hotHit: number;
      drainFlash: number;
    };
    emissive: { scoreLine: number; hotZone: number; drainFlash: number };
    /**
     * 本局相机偏离基准位置的峰值（米）。
     *
     * S16 里相机上的两路运动（中币的镜头抖动、推板前推时的 2 毫米台面微震）
     * 都已按用户要求删除 ⇒ 相机完全静止，它应当恒为 **0**。
     * 判据靠它守住那两次删除 —— 相机运动在静止截图里完全看不出来，
     * 只能逐帧记账。
     */
    cameraPeakOffset: number;
  };
  /** 走一次真实飞字表现路径（坐标合成），返回分档与 HUD 上的持久读数。 */
  flyScoreProbe?(chips: number): { tier: string; datasetTier: string | null };
  /**
   * 自动补币的配置（P10 ⑦）：阈值 / 盘点周期 / 冷却 / 每次枚数 + 币池预算。
   * 判据从引擎读，不手抄——这些是可调旋钮，抄一份到测试里迟早对不上。
   */
  refillSpec?(): { bedThreshold: number; checkEvery: number; cooldown: number; count: number; budget: number };
  /**
   * 直接摇一次背板老虎机；正在转时返回 null。
   *
   * `forced` 接受奖励符号（= 中奖四连）或 `'fine'`（胡萝卜四连）/ `'miss'`（杂牌）。
   * 奖励路径必须能逐一指定验证——靠权重随机去赌「摇到塔」是测不稳的。
   */
  xixiSpin?(forced?: string): { kind: string; symbol?: string; faces: string[] } | null;
  /** 滚筒窗读数（P10 判据读它，不读截图）。 */
  reelWindowReport?(): ThreeGameDiagnostics['reel'];
  /** 像素图标图集的读数：来源、尺寸、每格调色板大小、**每格底色**。 */
  iconReport?(): {
    /** `readonly` 是刻意的：这是图集的身份清单，判据只读不改。 */
    ids: readonly string[];
    size: number;
    paletteMax: number;
    paletteSizes: number[];
    /** 每格底色（sRGB 十六进制）——名字 → 像素的身份读数，抓「切格顺序错位」。 */
    backgrounds: string[];
    strip: { width: number; height: number };
  };
  /**
   * 结果表的实测分布：把 `rollSlotOutcome` 在 `[0,1)` 上均匀枚举 `samples` 次。
   *
   * 判据**不写第二份权重公式**（纪律 2）：45/15/40 只存在于 `xixi.ts`，
   * 测试读的是引擎函数枚举出来的实际分布。
   */
  slotOdds?(samples?: number): {
    samples: number;
    counts: Record<'win' | 'fine' | 'miss', number>;
    symbols: Record<string, number>;
  };
  /**
   * 停格画面的枚举：给定结果，`reelFacesFor` 会给出四个滚筒各显示什么图标。
   * 判据用它核「win/fine 四连、miss 两两不同」，不在测试里重写这段规则。
   */
  reelFaces?(kind: string, symbol?: string): string[][];
  /**
   * 币的几何派生量（S13）：**验证脚本的唯一真源**。
   *
   * `?coin=1.1/1.2` 会同时改掉币径、厚度、质量、抖动、层高与全部布局步距，
   * 所以脚本**不准手抄**这些常量——抄一份在别的档位下就会**假绿**
   * （拿旧尺寸去量新币，怎么看都合格）。一律读这里。
   */
  coinGeometry?(): {
    scale: number;
    radius: number;
    halfThickness: number;
    diameter: number;
    layerStep: number;
    restY: number;
    maxJitter: number;
    minSpacing: number;
    minStep: number;
    mass: number;
    density: number;
    friction: number;
    /**
     * 弹性 / 线性阻尼 / 角阻尼 —— 与 `density` / `friction` 一样读**运行时注册表**
     * （`coinPhysics`），不是 `COIN.*` 常量。调试面板改过之后这里必须反映实际值，
     * 否则脚本会拿着陈旧数据判据假绿。
     */
    restitution: number;
    linearDamping: number;
    angularDamping: number;
    conveyor: { maxY: number; speed: number };
    pusherTopY: number;
    /**
     * 推板行程与推币面的 z 区间。`accept` ④ 的「落点确实不同」只能以行程为尺度：
     * `conveyor` 归零之后落点只出现在回撤的前半段，写死的绝对阈值会永远够不到。
     *
     * 读的是 `Pusher.travel`（运行时值），不是 `TABLE.pusherTravel` 常量。
     */
    pusherTravel: number;
    pusherFrontZ: { rest: number; extended: number };
    /** 落币口。判据定位落币走廊与钉阵（`accept` ⓪ 的探针点）必须读它，不要写死。 */
    drop: { y: number; z: number; halfLane: number };
    /** 速度护栏，读运行时注册表（调试面板可改）。 */
    maxSpeed: number;
    maxUpwardSpeed: number;
  };
  /**
   * 某个 `(x, z)` 是否落在币床前侧角的排水口里（含抖动余量）。
   *
   * `physics` ⑤ 判「币床的币坐在台面上」时必须排除排水口里的币 ——
   * 它们正被合法回收，落在洞沿上时币心当然在地板高度以下。
   * 口径来自引擎的 `insideDrain`（真源 `DRAIN_FOOTPRINT`），**不要在脚本里另抄一份**。
   */
  insideDrain?(x: number, z: number): boolean;
  /**
   * 某个世界坐标是否落在**上层台面的体积**里（与 `Game.isOnDeck` 同一份判据）。
   *
   * 验证脚本按「台面 / 币床」分桶统计时必须走这里，**不准用高度中点近似**：
   * S13 起币塔能盖到 9 层（塔顶 0.216），而高度中点 `deckY()` 是 0.177 ——
   * 近似会把塔上的币算进台面，读数看着正常，其实是假的。
   */
  isOnDeckAt?(x: number, y: number, z: number): boolean;
}

interface Window {
  __THREE_GAME_DIAGNOSTICS__?: ThreeGameDiagnostics;
  __THREE_GAME_TEST_HOOKS__?: ThreeGameTestHooks;
}
