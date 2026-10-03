import type { CoinKind } from '../game/constants';

export type ScoreEvent = {
  kind: CoinKind;
  /** 本枚币入账的筹码（已含热度、热区与加注倍率）。 */
  value: number;
  /** 结算瞬间币中心的 z——必须已经越过结算线。 */
  z: number;
  /** 连落计数。 */
  combo: number;
  /** 结算前后的局内筹码余额，用于核对返值是否同帧到账。 */
  chipsBefore: number;
  chipsAfter: number;
  /** 距离上一次结算的时间（秒）。 */
  sincePrevious: number;
  /** 是否在热区里越线（返值翻倍）。 */
  hot: boolean;
};

export type FallOffEvent = {
  /** 离开上层台面瞬间币的 z。 */
  z: number;
  /** 同一时刻推币面的 z。 */
  frontFaceZ: number;
  /** 同一时刻推板行程。 */
  offset: number;
  phase: string;
  /** 离台的是玩家投入的币还是预置床币（`accept` ④ 按它分流样本；#49）。 */
  source: 'player' | 'bed';
};

/**
 * 排水事件（P10）：一枚币掉进币床前侧角的下水道（见 `DRAIN`）。
 *
 * 为什么要单独记一条而不是只留一个计数：排水是**经济上的汇**，
 * 它的强度必须能拆开看——「掉了多少枚」要能对应到「从哪一侧掉的、什么币种、
 * 当时推板在哪」。只留计数的话，S11 标定时只能整体加减，
 * 分不清是洞口位置不对还是宽度不对。
 */
export type DrainEvent = {
  /** 洞的哪一侧（−1 左 / +1 右）。 */
  side: -1 | 1;
  kind: string;
  x: number;
  z: number;
  y: number;
  /** 同一时刻的推板行程（用来判断「是推板把它推进去的」还是别的原因）。 */
  offset: number;
  t: number;
};

export type DrainStats = {
  reason: string | null;
  startedAt: number | null;
  earnedAtStart: number;
  settledAt: number | null;
  earnedAtSettle: number;
};

/** 选位采样点：用来验证自动选位是匀速的。 */
export type LaneSample = {
  /** 采样时刻（游戏内 elapsed，秒）。 */
  t: number;
  /** 落点的世界 x。 */
  x: number;
  mode: string;
};

/** 选位模式切换事件：用来验证手动接管与恢复都不跳变。 */
export type LaneEvent = {
  t: number;
  x: number;
  mode: string;
  /** enter = 进入手动接管；resume = 回到自动选位。 */
  event: 'enter' | 'resume';
};

/**
 * 投放演出事件（P4 ShowDirector）。
 *
 * 演出化之后机关/奖励有了**过程时间**，判据必须是两态的：
 * registered（已登记、币尚未动）→ completed（币已到位）。
 * refused 也要记——「预算打满后拒绝」是验收路径，不是噪音。
 */
export type ShowEvent = {
  id: string;
  phase: 'registered' | 'completed' | 'refused';
  /** 请求的枚数（降级前）。 */
  requested: number;
  /** 承诺交付的枚数（降级后）。 */
  promised: number;
  /** 实际 spawn 成功的枚数（completed 时才有意义）。 */
  spawned: number;
  /** 预算不足被降级交付。 */
  downgraded: boolean;
  reason?: string;
  t: number;
};

/**
 * XIXI 集章与背板老虎机事件（P5）。
 *
 * 判据靠事件而不是定时采样：lit（某槽点亮）、completed（四槽集齐、老虎机触发）、
 * spin（摇出符号）、reward（奖励落地——加力入账或演出登记）。
 */
export type XixiEvent = {
  phase: 'lit' | 'completed' | 'spin' | 'reward';
  /** lit：点亮的槽位号。 */
  slot?: number;
  /**
   * spin / reward：结果分类（P10 的三分类）。
   *
   * `win` = 四连同号（发奖）、`fine` = 四连胡萝卜（扣筹码）、`miss` = 杂牌（不奖不罚）。
   * 判据靠它区分三种结果，而不是靠「有没有 symbol」反推——
   * 后者在将来加第四种结果时会静默失效。
   */
  outcome?: 'win' | 'fine' | 'miss';
  /** spin / reward：摇出的符号（只有 `win` 有）。 */
  symbol?: string;
  /** spin / reward：四个滚筒停格的图标（`miss` 时四个互不相同）。 */
  faces?: string[];
  /** reward：加力是否入账（存满拒收时为 false）；演出奖励则为承诺枚数。 */
  granted?: boolean;
  delivered?: number;
  /** reward（`fine`）：**实扣**的筹码数（扣到 0 为止，所以可能小于罚款面值）。 */
  fined?: number;
  /**
   * S5a 四同分档：`3` = 常规中奖，`4` = 大奖。只有 `win` 带它。
   * 判据靠它核「四同真的走了另一条分支」——不看这个字段的话，
   * 「大奖演成三同」在画面上完全看不出来（灯色一样、符号一样）。
   */
  tier?: 3 | 4;
  /**
   * reward（`fine`）：罚不掉而**转成欠款**的那一截（S5b）。
   * 与 `fined` 分开记才对得了账：`fined + debtAdded` 在欠款到顶时会小于罚款面值，
   * 而那正是「上限是承重结构」这件事唯一能被看见的时刻。
   */
  debtAdded?: number;
  t: number;
};

/**
 * 每个推板循环结束时的累计赚进筹码与累计越线枚数。
 *
 * 相邻两点的枚数差 = 这一个循环推下几枚。**不要用筹码差除以面值**：
 * 热度倍率、热区与加注倍率都会放大入账筹码，差值已经不是枚数了。
 * 用来验证「别一下推光」（单循环枚数上限）与「盘面不憋死」（连续空循环上限）。
 */
export type CycleSample = {
  /** 第几个循环（从 1 开始）。 */
  cycle: number;
  /** 该循环结束时的累计赚进筹码。 */
  earned: number;
  /** 该循环结束时的累计越线枚数（不受任何倍率影响）。 */
  coins: number;
};

/**
 * 试玩遥测。
 *
 * 关键因果必须在模拟内部记录，而不是靠外部按帧采样——采样间隔会漏掉
 * 「币越线当帧就被移除」这类瞬时事件。默认关闭，只有测试钩子打开时才累积。
 */
export class Telemetry {
  private enabled = false;
  private readonly scoreEvents: ScoreEvent[] = [];
  private readonly fallOffEvents: FallOffEvent[] = [];
  private readonly drainEvents: DrainEvent[] = [];
  private readonly laneSamples: LaneSample[] = [];
  private readonly laneEvents: LaneEvent[] = [];
  private readonly cycles: CycleSample[] = [];
  private readonly showEvents: ShowEvent[] = [];
  private readonly xixiEvents: XixiEvent[] = [];
  private lastScoreAt: number | null = null;
  private drain: DrainStats = {
    reason: null,
    startedAt: null,
    earnedAtStart: 0,
    settledAt: null,
    earnedAtSettle: 0,
  };

  get active(): boolean {
    return this.enabled;
  }

  enable(): void {
    this.enabled = true;
  }

  reset(): void {
    this.scoreEvents.length = 0;
    this.fallOffEvents.length = 0;
    this.drainEvents.length = 0;
    this.laneSamples.length = 0;
    this.laneEvents.length = 0;
    this.cycles.length = 0;
    this.showEvents.length = 0;
    this.xixiEvents.length = 0;
    this.lastScoreAt = null;
    this.drain = { reason: null, startedAt: null, earnedAtStart: 0, settledAt: null, earnedAtSettle: 0 };
  }

  recordLaneSample(t: number, x: number, mode: string): void {
    if (!this.enabled) return;
    this.laneSamples.push({ t, x, mode });
  }

  recordLaneEvent(t: number, x: number, mode: string, event: 'enter' | 'resume'): void {
    if (!this.enabled) return;
    this.laneEvents.push({ t, x, mode, event });
  }

  recordCycle(cycle: number, earned: number, coins: number): void {
    if (!this.enabled) return;
    this.cycles.push({ cycle, earned, coins });
  }

  recordScore(event: Omit<ScoreEvent, 'sincePrevious'>, elapsed: number): void {
    if (!this.enabled) return;
    const sincePrevious = this.lastScoreAt === null ? -1 : elapsed - this.lastScoreAt;
    this.lastScoreAt = elapsed;
    this.scoreEvents.push({ ...event, sincePrevious });
  }

  recordFallOff(event: FallOffEvent): void {
    if (!this.enabled) return;
    this.fallOffEvents.push(event);
  }

  recordDrain(event: DrainEvent): void {
    if (!this.enabled) return;
    this.drainEvents.push(event);
  }

  recordShow(event: ShowEvent): void {
    if (!this.enabled) return;
    this.showEvents.push(event);
  }

  recordXixi(event: XixiEvent): void {
    if (!this.enabled) return;
    this.xixiEvents.push(event);
  }

  /**
   * 开始一轮收尾。
   *
   * **每次都覆盖**，不做「已有记录就跳过」的判断：一轮收尾结束后记录要留着给断言读，
   * 而下一轮收尾必须能重新开一条。是否重复调用由 Game 侧的一次性标志控制。
   */
  recordDrainStart(reason: string, elapsed: number, earned: number): void {
    if (!this.enabled) return;
    this.drain = {
      reason,
      startedAt: elapsed,
      earnedAtStart: earned,
      settledAt: null,
      earnedAtSettle: 0,
    };
  }

  /** 一轮收尾走完（无论随后是本局继续还是破产弹窗）。 */
  recordSettle(elapsed: number, earned: number): void {
    if (!this.enabled) return;
    this.drain.settledAt = elapsed;
    this.drain.earnedAtSettle = earned;
  }

  summary(): {
    scoreEvents: ScoreEvent[];
    fallOffEvents: FallOffEvent[];
    /** 掉进下水道的币（P10）：经济上「汇」的直接读数。 */
    drainEvents: DrainEvent[];
    laneSamples: LaneSample[];
    laneEvents: LaneEvent[];
    cycles: CycleSample[];
    showEvents: ShowEvent[];
    xixiEvents: XixiEvent[];
    drain: DrainStats;
  } {
    return {
      scoreEvents: [...this.scoreEvents],
      fallOffEvents: [...this.fallOffEvents],
      drainEvents: [...this.drainEvents],
      laneSamples: [...this.laneSamples],
      laneEvents: [...this.laneEvents],
      cycles: [...this.cycles],
      showEvents: [...this.showEvents],
      xixiEvents: [...this.xixiEvents],
      drain: { ...this.drain },
    };
  }
}
