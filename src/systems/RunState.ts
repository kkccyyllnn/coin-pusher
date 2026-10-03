import { ENDLESS, RULES } from '../game/constants';
import type { Ledger } from '../game/economy';
import type { SaveStore } from './SaveStore';

export type RunPhase = 'ready' | 'playing' | 'drainOut' | 'settled';

/** 收尾原因。战役的目标分/循环预算已摘除，只剩「筹码耗尽」一条。 */
export type SettleReason = 'exhausted';

export type RunSnapshot = {
  phase: RunPhase;
  /** 可花余额（S4 之后就是唯一账户的余额，`chips` 这个名字留给 HUD 与判据文案）。 */
  chips: number;
  /** 本段开始时的余额（占旧 `buyIn` 的位置，但**不是一笔扣款**）。 */
  initial: number;
  /** 本段靠越线赚进的余额。 */
  earned: number;
  /** 本段跪求拿到的余额（脏钱：不能换成图鉴）。 */
  begged: number;
  /** 本段贷到的余额。 */
  loaned: number;
  /** 本段花掉的余额（投币、加注、机关）。 */
  spent: number;
  /** 余额峰值。 */
  chipsPeak: number;
  /**
   * 本局被老虎机罚掉的筹码（P10 的胡萝卜四连）。
   * **不进恒等式**——已含在 `spent` 里；它是「罚款发生了没有、扣了多少」的对账口径。
   */
  fines: number;
  /**
   * 本局产出里被**分流去抵债**的那一截（S2 甲规则）。
   * **不进三账本恒等式**——它与 `fines` 同族：`earned` 只记真正到账的那一截，
   * 这里记的是「本来能到账但被拿去还债」的对账口径。
   * 所以 `earned + repaid` 才是「gross 产出」，HUD 与 economy 判据都按这个口径读。
   */
  repaid: number;
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
 * v3 起只有无尽这一种玩法，**没有分数**：越线返筹码。★ S4 合并账户之后收工**不动钱**
 * （旧写法是「按 `chips − begged` 回存钱包」），脏钱的载体搬到了「不能换成永久进度」上。
 * 破产不是失败状态，是这个模式的核心产出。
 *
 * 恒等式：`balance = initial + earned + begged + loaned − spent`（`chips` 就是 `balance` 的视图）。
 * 任何新的筹码进出都必须走 gainChips / spendChips / grantBeg 之一，
 * 直接改 `chips` 会让账对不上——`economy.ledgerBalances` 就是拿来验这条的。
 */
export class RunState {
  phase: RunPhase = 'ready';
  /**
   * 账户本体。★ S4 合并之后唯一的余额在这里，下面那个 `chips` 只是它的一个**视图**。
   *
   * 为什么要让 RunState 持有 SaveStore：合并之后「桌上的筹码」与「钱包」是同一个数，
   * 再在这里存一份 `chips` 字段就是**凭空造回第二个口袋** —— 而 S4 的全部目的就是
   * 让玩家眼里只有一个数。旧代码 `chips` 与 `buyIn` 两处都要手动同步的隐患，
   * 从结构上消失了（不是靠纪律，是靠没有第二个字段）。
   */
  private readonly save: SaveStore;
  /**
   * 局内可花余额 = `save.balance`。**是视图不是字段。**
   * 保留这个名字是因为它有 100+ 处读点、HUD 与判据文案都在用；
   * 语义已经从「本局筹码（另一只口袋）」变成「唯一余额」，
   * 改名是另一件事，而且会让判据文案一起漂 —— 不在本次合并里顺手做。
   */
  get chips(): number {
    return this.save.balance;
  }

  /**
   * 本段开始时的余额（占旧 `buyIn` 的位置，**但含义不同：它不是一笔扣款**）。
   * 恒等式 `balance = initial + earned + begged + loaned − spent` 的基准项。
   */
  readonly initial: number;
  /** 本段靠越线赚进的余额。 */
  earned = 0;
  /** 本段跪求拿到的余额。脏钱：不能换成图鉴，见 `SaveStore.spendable`。 */
  begged = 0;
  /** 本段贷到的余额（要还的钱，算干净 —— 旧模型里它记进 `buyIn`，本来就可回存）。 */
  loaned = 0;
  /** 本段花掉的余额（投币、加注、机关）。 */
  spent = 0;
  /**
   * 本局被老虎机罚掉的筹码（P10）。**不进三账本恒等式**——它已经包含在 `spent` 里。
   * 单独记一份是为了能对账「惩罚到底发生了没有、发生了几次、扣了多少」。
   */
  fines = 0;
  /**
   * 本局产出被分流抵债的累计额（S2）。**不进三账本恒等式**，理由与 `fines` 一样：
   * 加一项进恒等式就要同步 `Ledger` / `ledgerBalances` / 所有断言点
   * ——这条惯例是 `ledger()` 上方那段注释立的，罚款当年照它走，本次也照它走。
   */
  repaid = 0;
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

  /**
   * ★ S4 合并账户之后构造一局**不再从钱包扣钱** —— 所以第二个参数从
   * 「买入额 `buyIn`」变成「账户本身」。`config` 参数一并删掉：
   * 它在这个类里只被 `config.credits` 当默认买入额用过一次，而买入这个动作已经不存在了。
   */
  constructor(save: SaveStore) {
    this.save = save;
    this.initial = save.balance;
    this.chipsPeak = save.balance;
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

  /**
   * ★ S4：`cashOut` 这个 getter **连同「收工回存」这个动作一起删除**。
   * 旧模型里它是 `max(0, chips − begged)` —— 唯一一处「脏钱不能变成永久进度」的执行点。
   * 合并账户之后没有回存这一步了，那条约束搬到了 `SaveStore.spendable`
   * （买图鉴的门槛），等价性见 `economy.spendableOf` 的代入验算。
   */

  /**
   * 三账本快照，用于核对恒等式。★ S4：余额只有一个来源，这里读的就是账户本身。
   */
  get ledger(): Ledger {
    return {
      initial: this.initial,
      earned: this.earned,
      begged: this.begged,
      loaned: this.loaned,
      spent: this.spent,
      balance: this.save.balance,
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
  /**
   * 扣余额。**唯一的扣减入口**：投币、加注、机关都走这里。
   * 返回 false 表示余额不足，调用方必须明确拒绝而不是静默吞掉筹码。
   *
   * ★ S4 之后它只是 `SaveStore.debitBalance` 的一层薄封装（顺手把本段 `spent` 记上）——
   *   金额本体只有一个来源，不存在「改了 chips 忘了改 wallet」这种错。
   */
  spendChips(amount: number): boolean {
    if (amount <= 0) return true;
    if (!this.save.debitBalance(amount)) return false;
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
    this.save.creditBalance(amount, 'earned');
    this.earned += amount;
    this.chipsPeak = Math.max(this.chipsPeak, this.chips);
    return { gained: amount, resumed: false };
  }

  /**
   * 记一笔贷款进本段的账（S3 续玩 + S4 合并账户）。
   *
   * ★ 余额**已经由 `SaveStore.loanToStake()` 加过了**，这里只记对账项 `loaned`
   *   （恒等式右边的一项）。绝不能再往余额里加一遍 —— 那会变成凭空多钱；
   *   反过来只加余额不记这一项，`ledgerBalances` 当场就不平（S0a 之后那是**一处**判定）。
   *
   * 为什么记 `loaned` 而不是记 `earned`：借来的钱不是打出来的成绩，
   * 记进 `earned` 会污染排行榜与「本段赚进」；
   * 也不记 `begged`：那是脏钱标记，而贷款是要还的真钱，记成脏钱等于让它免还。
   */
  recordLoan(amount: number): void {
    if (amount <= 0) return;
    this.loaned += amount;
    this.chipsPeak = Math.max(this.chipsPeak, this.chips);
  }

  /**
   * 跪求赏赐：进账但记进脏钱，且**不算赚进**——
   * 它不是「打出来的」筹码，所以不进排行榜、也不能拿去换永久进度（`SaveStore.spendable`）。
   *
   * 与 `gainChips` 的区别就在 `resumed`：**这是唯一能把本局从沉降里拉回来的入口**。
   */
  grantBeg(amount: number): GainResult {
    if (amount <= 0) return { gained: 0, resumed: false };
    this.save.creditBalance(amount, 'begged');
    this.begged += amount;
    this.chipsPeak = Math.max(this.chipsPeak, this.chips);
    return { gained: amount, resumed: this.revive() };
  }

  /**
   * 老虎机惩罚（P10）：胡萝卜四连，扣到 0 为止，**扣不掉的那一截转成欠款**（S5b）。
   *
   * ## 为什么不新增账本项
   *
   * 恒等式 `balance = initial + earned + begged + loaned − spent` 是 `economy` 模式逐帧验的东西，
   * 加一个 `fined` 项就要同步改 `Ledger` / `ledgerBalances` / 所有断言点——
   * 那是**账本契约变更**，和「加一个惩罚」是两件事，混在一次改动里违反纪律 1。
   * 所以实扣的那一截走 `spendChips`（唯一扣减入口），`spent` 把它一起吸收；
   * 另用 `fines` 记**实扣额**（不进恒等式），断言靠 `fines` 与 `spent ≥ fines` 对账。
   * ★ 转出去的那一截也不进恒等式：`debt` 不是余额的进出，它是**未来产出的分流承诺**
   *   （还的时候从赚进里扣，那一步同样不改恒等式的形状）。
   *
   * ## 为什么这里只算数、不动 debt
   *
   * `debt` 的上限 clamp 与落盘都在 `SaveStore.chargeFine()`，那是账户层唯一写 debt 的门。
   * 本类要是在这里也加一笔，就成了「同一个动作两个口袋各记一遍」——那正是 S4 清掉的东西。
   * 所以本函数把 `{applied, shortfall}` **交给调用方去敲门**，自己一个 debt 都不碰。
   *
   * ⚠️ 旧写法在 `applied === 0` 时直接 `return 0`，shortfall 就此蒸发 ⇒ 零余额段里
   *   每次四连都**全额进债**，debt 线性暴涨到顶。上限因此是**承重结构而不是保险丝**
   *   （plan 6② 的原话），改完之后由 `chargeFine` 的 clamp 收尾。
   */
  fineChips(amount: number): { applied: number; shortfall: number } {
    const wanted = Math.max(0, Math.floor(amount));
    const applied = Math.min(wanted, this.chips);
    if (applied > 0) this.spendChips(applied);
    this.fines += applied;
    return { applied, shortfall: wanted - applied };
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
      initial: this.initial,
      earned: this.earned,
      begged: this.begged,
      loaned: this.loaned,
      spent: this.spent,
      chipsPeak: this.chipsPeak,
      fines: this.fines,
      repaid: this.repaid,
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
