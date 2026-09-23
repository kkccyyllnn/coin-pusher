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
  boostCharges: number;
  settleReason: string | null;
  /** 收尾阶段推板是否已停板（扫板/转轮的开放条件）。 */
  plateStopped: boolean;
  activeCoins: number;
  anomalies: number;
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
  /** 机关：剩余次数与币预算余量。 */
  mechanisms: {
    sweeper: number;
    grapple: number;
    reload: number;
    wheel: number;
    coinsRemaining: number;
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
    /** 当前物理旋钮（重力 / 求解器迭代 / ERP / 币额外迭代），用来给实测记录标注参数组。 */
    tuning: {
      gravity: number;
      solverIterations: number;
      erp: number;
      coinSolverIterations: number;
    };
  };
  performance: {
    fps: number;
    tier: string;
    maxDpr: number;
    shadows: boolean;
  };
  collection: {
    wallet: number;
    coinSkin: string;
    cabinetSkin: string;
    coinSkins: number;
    cabinetSkins: number;
  };
  renderer: {
    calls: number;
    triangles: number;
    geometries: number;
    textures: number;
  };
  canvas: {
    clientWidth: number;
    clientHeight: number;
    width: number;
    height: number;
    dpr: number;
  };
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
  setQuality?(tier: string): { tier: string; maxDpr: number; shadows: boolean };
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
  setTuning?(patch: Record<string, number>): Record<string, unknown>;
  /** 调试用：只设定选位、不投币（视为一次手动接管）。 */
  setLane?(lane: number): { lane: number; laneX: number };
  /** 机关：直接触发，返回是否生效。 */
  sweep?(): boolean;
  grapple?(laneX: number): boolean;
  reload?(): boolean;
  spinWheel?(): boolean;
  /** 无尽模式：切换加注档位。 */
  cycleBet?(): boolean;
  mechanisms?(): { sweeper: number; grapple: number; reload: number; wheel: number };
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
  run?(): {
    begs: number;
    totalBegs: number;
    best: number;
    wallet: number;
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
  }): { chips: number; gated: boolean };
  /** 调试用：读取无尽台面配置摘要。 */
  table?(): {
    name: string;
    coins: number;
    value: number;
    bronze: number;
    pattern: number;
    payout: number;
  };
  /** 图鉴与外观：读取当前钱包与选用外观。 */
  collection?(): {
    wallet: number;
    coinSkins: string[];
    cabinetSkins: string[];
    selectedCoinSkin: string;
    selectedCabinetSkin: string;
  };
  /** 图鉴与外观：清空存档（仅测试用）。 */
  clearSave?(): { wallet: number };
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
    /** XIXI 集章与老虎机事件（P5）：lit / completed / spin / reward。 */
    xixiEvents: Array<{
      phase: 'lit' | 'completed' | 'spin' | 'reward';
      slot?: number;
      symbol?: string;
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
  /** 直接摇一次背板老虎机（可指定符号验证奖励路径）；正在转时返回 null。 */
  xixiSpin?(symbol?: string): { symbol: string } | null;
}

interface Window {
  __THREE_GAME_DIAGNOSTICS__?: ThreeGameDiagnostics;
  __THREE_GAME_TEST_HOOKS__?: ThreeGameTestHooks;
}
