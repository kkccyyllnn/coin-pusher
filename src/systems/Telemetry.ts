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
  /** spin / reward：摇出的符号。 */
  symbol?: string;
  /** reward：加力是否入账（存满拒收时为 false）；演出奖励则为承诺枚数。 */
  granted?: boolean;
  delivered?: number;
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
      laneSamples: [...this.laneSamples],
      laneEvents: [...this.laneEvents],
      cycles: [...this.cycles],
      showEvents: [...this.showEvents],
      xixiEvents: [...this.xixiEvents],
      drain: { ...this.drain },
    };
  }
}
