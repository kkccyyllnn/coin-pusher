import { ENDLESS, RULES } from '../game/constants';
import { cashOutOf, type Ledger } from '../game/economy';
import type { EndlessConfig } from '../game/endless';

export type RunPhase = 'ready' | 'playing' | 'drainOut' | 'settled';

/** 收尾原因。战役的目标分/循环预算已摘除，只剩「筹码耗尽」一条。 */
export type SettleReason = 'exhausted';

export type RunSnapshot = {
  phase: RunPhase;
  /** 局内筹码余额。 */
  chips: number;
  /** 本局买入的筹码（从钱包扣走的那部分）。 */
  buyIn: number;
  /** 本局靠越线赚进的筹码。 */
  earned: number;
  /** 本局跪求拿到的筹码（脏钱，不可回存）。 */
  begged: number;
  /** 本局消耗掉的筹码（投币、加注、机关）。 */
  spent: number;
  /** 局内筹码峰值。 */
  chipsPeak: number;
  boostCharges: number;
  boostUsesLeft: number;
  boostEnabled: boolean;
  combo: number;
  bestCombo: number;
  plateStopped: boolean;
  settleReason: SettleReason | null;
  /** 累计投出多少枚（存活投数，破产弹窗要报这个）。 */
  drops: number;
  /**
   * 本局注入过多少枚大赏币。
   *
   * 单独计数而不是去盘面上数：大赏币注入后可能很快被推走，
   * 「盘面上有几枚」是瞬时快照，测出来的东西随推板相位漂。
   * 计数才能断言**注入率**本身（`bounties === floor(drops / bountyEveryDrops)`）。
   */
  bounties: number;
};

export type ComboResult = {
  combo: number;
  comboStarted: boolean;
  bestCombo: number;
};

export type GainResult = {
  /** 实际入账的筹码（0 表示这次没中）。 */
  gained: number;
  /** 入账把本局从收尾拉了回来。 */
  resumed: boolean;
};

/**
 * 一局的状态机与账本。只持有规则数据，不碰物理也不碰渲染。
 *
 * 准备 → 进行中 → 筹码耗尽收尾（沉降）→ 二选一：
 *   · 沉降走完时手里有筹码 → 回到进行中（盘面把筹码还回来了）；
 *   · 一枚都没回来 → 破产弹窗（跪求续命 / 保留尊严收工）。
 *
 * v3 起只有无尽这一种玩法，**没有分数**：越线返筹码，收工时按
 * `chips − begged` 回存钱包。破产不是失败状态，是这个模式的核心产出。
 *
 * 三账本恒等式：`chips = buyIn + earned + begged − spent`。
 * 任何新的筹码进出都必须走 gainChips / spendChips / grantBeg 之一，
 * 直接改 `chips` 会让账对不上——`economy.ledgerBalances` 就是拿来验这条的。
 */
export class RunState {
  phase: RunPhase = 'ready';
  /** 局内筹码余额。 */
  chips: number;
  /** 本局买入的筹码。 */
  readonly buyIn: number;
  /** 本局越线赚进的筹码。 */
  earned = 0;
  /** 本局跪求拿到的筹码（脏钱，不可回存）。 */
  begged = 0;
  /** 本局消耗掉的筹码。 */
  spent = 0;
  /** 局内筹码峰值。 */
  chipsPeak: number;
  boostCharges = 0;
  boostUsesLeft = RULES.boostUseCap;
  combo = 0;
  bestCombo = 0;
  settleReason: SettleReason | null = null;
  /** 收尾阶段推板是否已经停板。 */
  plateStopped = false;
  /** 累计投出多少枚（存活投数）。 */
  drops = 0;
  /** 本局注入过多少枚大赏币（注入率断言的依据）。 */
  bounties = 0;

  private lastScoreAt = -Infinity;
  private cyclesSinceSettle = 0;
  private elapsed = 0;
  /** 是否还有币没落到台面上（收尾时先等在途币落地再数推板周期）。 */
  private inFlight = false;

  constructor(
    config: EndlessConfig,
    /** 本局从钱包买入的筹码。钱包不足时按余额全押，可以为 0。 */
    buyIn: number = config.credits,
  ) {
    this.buyIn = Math.max(0, buyIn);
    this.chips = this.buyIn;
    this.chipsPeak = this.buyIn;
  }

  get acceptingDrops(): boolean {
    return (this.phase === 'ready' || this.phase === 'playing') && this.chips > 0;
  }

  get canUseBoost(): boolean {
    return this.boostCharges > 0 && this.boostUsesLeft > 0;
  }

  get settling(): boolean {
    return this.phase === 'drainOut';
  }

  /** 收工可回存钱包的筹码（跪求来的那部分不可回存）。 */
  get cashOut(): number {
    return cashOutOf(this.chips, this.begged);
  }

  /** 三账本快照，用于核对恒等式。 */
  get ledger(): Ledger {
    return {
      buyIn: this.buyIn,
      earned: this.earned,
      begged: this.begged,
      spent: this.spent,
      chips: this.chips,
    };
  }

  /** 收尾阶段：在途币落地后还需走完的推板周期数。 */
  get settleCyclesRemaining(): number {
    return Math.max(0, RULES.drainSettleCycles - this.cyclesSinceSettle);
  }

  tick(delta: number): void {
    this.elapsed += delta;
  }

  get elapsedSeconds(): number {
    return this.elapsed;
  }

  /** 首次有效投币从「准备」进入「进行中」。 */
  beginPlay(): boolean {
    if (this.phase !== 'ready') return false;
    this.phase = 'playing';
    return true;
  }

  /**
   * 扣筹码。投币、加注、机关都走这里，**唯一的扣减入口**。
   * 返回 false 表示余额不足，调用方必须明确拒绝而不是静默吞掉。
   */
  spendChips(amount: number): boolean {
    if (amount <= 0) return true;
    if (this.chips < amount) return false;
    this.chips -= amount;
    this.spent += amount;
    return true;
  }

  /**
   * 越线入账。**唯一的入账入口**。
   *
   * 关键性质：它**不动沉降状态**。沉降期照样有币越线返值（满盘一波就能返十几枚），
   * 如果这些返值能立刻「起死回生」，沉降就永远走不完——`plateStopped` 到不了，
   * 收尾记录被反复清空，破产弹窗与跪求这两条路同时失效。
   * （实测：满盘进沉降约 1.2 秒就有一波 12 枚币越线。）
   *
   * 沉降的出路只有两条，都由 `Game.updateRunState` 与 `grantBeg` 决定：
   *   1. 沉降走完时手里**有筹码** → 本局继续；
   *   2. **跪求**（唯一救济）。
   */
  gainChips(amount: number): GainResult {
    if (amount <= 0) return { gained: 0, resumed: false };
    this.chips += amount;
    this.earned += amount;
    this.chipsPeak = Math.max(this.chipsPeak, this.chips);
    return { gained: amount, resumed: false };
  }

  /**
   * 跪求赏赐：进账但记进脏钱，且**不算赚进**——
   * 它不是「打出来的」筹码，所以不进排行榜、不可回存。
   *
   * 与 `gainChips` 的区别就在 `resumed`：**这是唯一能把本局从沉降里拉回来的入口**。
   */
  grantBeg(amount: number): GainResult {
    if (amount <= 0) return { gained: 0, resumed: false };
    this.chips += amount;
    this.begged += amount;
    this.chipsPeak = Math.max(this.chipsPeak, this.chips);
    return { gained: amount, resumed: this.revive() };
  }

  /**
   * 记一次投币。
   *
   * 与筹码消耗**分开计数**：机关也花筹码，但只有投币算「存活投数」，
   * 而存活投数是破产弹窗与排行榜的一列。
   */
  noteDrop(): void {
    this.drops += 1;
  }

  /**
   * 记一次大赏币注入。与 `noteDrop` 分开：投币是玩家行为，注入是机器的水龙头，
   * 两者只有「每 N 投一次」这个比例关系，混在一个计数器里就再也验不了。
   */
  noteBounty(): void {
    this.bounties += 1;
  }

  /**
   * 连落计数。必须在算返值**之前**调用：热度倍率挂在 combo 上。
   * 返回本枚币的连落数与是否新开一串。
   */
  nextCombo(now: number): ComboResult {
    const started = now - this.lastScoreAt > ENDLESS.comboWindow;
    this.combo = started ? 1 : this.combo + 1;
    this.lastScoreAt = now;
    this.bestCombo = Math.max(this.bestCombo, this.combo);
    return { combo: this.combo, comboStarted: started, bestCombo: this.bestCombo };
  }

  /** 沉降期间拿到返还 → 自动复活，继续赌。 */
  private revive(): boolean {
    if (this.phase !== 'drainOut') return false;
    this.phase = 'playing';
    this.plateStopped = false;
    this.cyclesSinceSettle = 0;
    this.settleReason = null;
    return true;
  }

  /** 筹码归零：进入沉降（盘面还有在途币，任何一枚返值都能复活）。 */
  enterRuinSettle(): void {
    this.enterSettle('exhausted');
  }

  /** 跪求赏赐到账：把收尾拉回进行中，盘面保留。 */
  reviveFromRuin(): void {
    this.revive();
  }

  /**
   * 加力入账。P5 起唯一来源是背板老虎机的「力力力」（三路集章已拆除）。
   * 存满（`RULES.boostStoreCap`）时拒收并返回 false——奖励被浪费要可对账，
   * 不能静默吞掉。
   */
  grantBoost(): boolean {
    if (this.boostCharges >= RULES.boostStoreCap) return false;
    this.boostCharges += 1;
    return true;
  }

  useBoost(): boolean {
    if (!this.canUseBoost) return false;
    this.boostCharges -= 1;
    this.boostUsesLeft -= 1;
    if (this.phase === 'drainOut') {
      this.cyclesSinceSettle = 0;
      this.plateStopped = false;
    }
    return true;
  }

  /** 推板走完一个循环。 */
  onCycleCompleted(): void {
    if (this.phase === 'drainOut' && !this.plateStopped && !this.inFlight) {
      this.cyclesSinceSettle += 1;
    }
  }

  setInFlight(value: boolean): void {
    this.inFlight = value;
  }

  /** 放弃持有的加力，用于收尾时明确结算。 */
  abandonBoost(): void {
    this.boostCharges = 0;
  }

  /** 收尾阶段推板是否可以停板（在途币已落地 + 走满收尾周期）。 */
  shouldStopPlate(): boolean {
    return this.phase === 'drainOut' && !this.plateStopped && this.settleCyclesRemaining === 0;
  }

  stopPlate(): void {
    this.plateStopped = true;
  }

  finish(): void {
    this.phase = 'settled';
  }

  snapshot(): RunSnapshot {
    return {
      phase: this.phase,
      chips: this.chips,
      buyIn: this.buyIn,
      earned: this.earned,
      begged: this.begged,
      spent: this.spent,
      chipsPeak: this.chipsPeak,
      boostCharges: this.boostCharges,
      boostUsesLeft: this.boostUsesLeft,
      boostEnabled: this.boostUsesLeft > 0,
      combo: this.combo,
      bestCombo: this.bestCombo,
      plateStopped: this.plateStopped,
      settleReason: this.settleReason,
      drops: this.drops,
      bounties: this.bounties,
    };
  }

  private enterSettle(reason: SettleReason): void {
    if (this.phase === 'drainOut' || this.phase === 'settled') return;
    this.phase = 'drainOut';
    this.settleReason = reason;
    this.cyclesSinceSettle = 0;
    this.plateStopped = false;
  }
}
