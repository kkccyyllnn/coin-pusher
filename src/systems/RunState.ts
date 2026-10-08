import { ENDLESS, RULES } from '../game/constants';
import {
  TICKET_COMBO_TIER,
  TICKET_EVERY_CROSSINGS,
  TICKET_INTERVAL_FLOOR,
  waveTarget,
  type TicketSource,
} from '../game/waves';
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
  /**
   * 票券与波次（1b）。**不进三账本恒等式**，所以这里是四个读数而不是 Ledger 的一项：
   * 判据吃的是 `tickets === ticketEarned − ticketSpent` 与分源对账。
   */
  tickets: number;
  ticketEarned: number;
  ticketSpent: number;
  crossings: number;
  wave: number;
  waveTickets: number;
  waveTarget: number;
  pendingDraft: boolean;
  draftsTaken: number;
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

  /* ── 票券与波次（1b）────────────────────────────────────────────────────────
   *
   * 第二条计数，**刻意不进三账本恒等式**：`balance = initial + earned + begged + loaned − spent`
   * 一个字不改（加一个新桶要同步 `Ledger` / `ledgerBalances` / 所有断言点，
   * 那是账本契约变更，与"加一种货币"是两件事 —— 罚款当年就照这条走）。
   *
   * 为什么要有第二种货币：筹码是**会被罚光**的那个，构筑进度不能挂在它上面，
   * 否则一次胡萝卜四连就把玩家的成长抹掉（那正是"负 EV 硬约束"最难看的地方）。
   * 票券只在本局有效、不写跨局存档 ⇒ **跪求刷不出来**：
   * `spendableOf`（脏钱闸）管的是筹码买图鉴，与票券正交，这里不需要新闸门。
   *
   * ⚠️ 与 `SaveStore` 里 legacy v5 的 `tickets` **无关** —— 那是旧的高币分货币，
   *   迁移时按 `TICKET_TO_CHIPS` 换成余额就消失。新计数器只活在这一局。
   */
  tickets = 0;
  /** 累计挣到（只增）。恒等判据吃 `tickets === ticketEarned − ticketSpent`。 */
  ticketEarned = 0;
  /** 累计花掉（只增）—— 三选一是唯一的汇，没有它这条恒等式就是 `tickets === ticketEarned` 的废话。 */
  ticketSpent = 0;
  /** 分源计数：判据要按源对账（注入率那条纪律），不是只对总数。 */
  ticketBySource: Record<TicketSource, number> = { crossing: 0, combo: 0, jackpot: 0, effect: 0 };
  /** 本波之内挣到的票券（进下一波时归零）。 */
  waveTickets = 0;
  /** 当前波次（1 起）。 */
  wave = 1;
  /** 本局累计越线枚数（票券大源的分母；与 `drops` 不同轴，别混用）。 */
  crossings = 0;
  /**
   * 每一张"越线源"票券发出那一刻的 `{at: 当时的本局越线数, every: 当时生效的间隔}`。
   *
   * 存在的理由：判据要能**逐事件**核"这张券是该发的"，而不是拿 `floor(C/every)` 去猜一个界 ——
   * 「票孔」会在局中把间隔改小，界怎么推都差一个边角（10-07 就有一局落在我推的界外，
   * 而我把那个推导证不出来）。记下来之后判据只问一句：`at % every === 0` 且条数 == `ticketBySource.crossing`。
   */
  crossingTicketLog: { at: number; every: number }[] = [];
  /**
   * 本局的发券间隔（枚/张），初值 = `TICKET_EVERY_CROSSINGS`，「票孔」候选能把它减到
   * `TICKET_INTERVAL_FLOOR`。**只在本局有效** ⇒ 强化不会跨局累积（那才是真正的通胀源）。
   */
  ticketEvery = TICKET_EVERY_CROSSINGS;
  /**
   * 本局内**实际**被「票孔」减掉的总枚数（`tightenTicketInterval` 累加）。
   * 存在的理由只有一个：让"本局的窗口起点"能被算出来，而不是靠脚本猜采样时刻 ——
   * 判据原本在局与局之间读 `ticketEvery` 当"开局值"，而 `endRun()` 第一次收工并不建新的
   * `RunState`（`Game.ts:2203/2207`），于是它量到的是上一局的末值（实测 12→10 / 10→8 的假红）。
   */
  ticketEveryTightened = 0;
  /** 本局的发券间隔**起点**（= 末值 + 本局减掉的总和）⇒ 由引擎盖章，脚本不再猜时刻。 */
  get ticketEveryStart(): number {
    return this.ticketEvery + this.ticketEveryTightened;
  }
  /** 攒够了但还没领：波间三选一的待办标记。 */
  pendingDraft = false;
  /** 本局领过几张候选（`ticketSpent === DRAFT_COST × draftsTaken` 的对账口径）。 */
  draftsTaken = 0;
  /** 本串连落是否已经领过到档那张（每串只发一次，不然 5 连以上每枚都发）。 */
  private comboTierPaid = false;

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
   * 一次罚款的**完整结算**：实扣 + 把 shortfall 交给账户层的 debt 门。
   *
   * 为什么要在这里合成（而不是让调用方各写两步）：这条组合原先有**三份抄本**
   * ——`SlotMachine.applyReward`、`Game` 里那条 dep、`testHooks.applyFine`。
   * 谁改一步忘了另两步，表现是"罚了款而账不动"那类静默错。
   * debt 的 clamp 仍然只在 `SaveStore.chargeFine` 那一道门里发生（本函数不碰上限逻辑）。
   *
   * ⚠️ 1a 之后 `shortfall` 在正常玩法里恒为 0（比例上限 40 %，见 `xixi.ts` 的结构后果那段），
   *   所以这个返回值里的 `debtAdded` 也恒 0 —— 但**催债币也走这里**，
   *   两条出账共用一条唯一扣减口，恒等式才只有一处要盯。
   */
  settleFine(amount: number): { applied: number; shortfall: number; debtAdded: number } {
    const { applied, shortfall } = this.fineChips(amount);
    const debtAdded = this.save.chargeFine(shortfall);
    return { applied, shortfall, debtAdded };
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
   * 一枚币越线 —— 票券的两个**盘面源**都在这一个入口里判（每 N 枚发一张、连落到档发一张）。
   *
   * 为什么由调用方把 `combo` 传进来而不是这里自己读：连落数在 `nextCombo()` 里算，
   * 而那个函数**必须在算返值之前**调用（热度倍率挂在它上面）。
   * 在票券这边再算一遍连落就是"同一个动作两个口袋各记一遍"，S4 刚清掉那种。
   *
   * ⚠️ `crossings % N === 0` 用的是**本局累计**越线数，不是"本波"——
   *   波次归零时把源计数器一起归零会让注入率判据的分母变成会跳动的数（对账对不上）。
   */
  noteCrossing(combo: number): void {
    this.crossings += 1;
    if (this.crossings % this.ticketEvery === 0) {
      this.crossingTicketLog.push({ at: this.crossings, every: this.ticketEvery });
      this.earnTicket('crossing', 1);
    }
    // 到档那张只在"恰好踩到档"那一刻发，且每串一次：`combo` 从 1 开始单调爬，
    // 所以 `=== TICKET_COMBO_TIER` 天然只命中一次；新串开始（回到 1）才重新允许领。
    if (combo === TICKET_COMBO_TIER && !this.comboTierPaid) {
      this.comboTierPaid = true;
      this.earnTicket('combo', 1);
    }
    if (combo <= 1) this.comboTierPaid = false;
  }

  /**
   * 发票券。四个源（越线 / 连落 / 四同 / 效果币）都走这一个口子，
   * 这样"票券从哪里来的"永远是可对账的，而不是散在几处 `+= 1`。
   */
  earnTicket(source: TicketSource, amount: number): void {
    const n = Math.max(0, Math.floor(amount));
    if (n === 0) return;
    this.tickets += n;
    this.ticketEarned += n;
    this.waveTickets += n;
    this.ticketBySource[source] += n;
    if (this.waveTickets >= waveTarget(this.wave)) this.pendingDraft = true;
  }

  /**
   * 花票券（三选一是唯一的汇）。
   *
   * **全有或全无**，与 `SaveStore.debitBalance` 同语义 —— 部分成交会让
   * `tickets === earned − spent` 之外的第三种状态出现（"欠一张票券"），而那不是设计。
   */
  spendTickets(amount: number): boolean {
    const n = Math.max(0, Math.floor(amount));
    if (n > this.tickets) return false;
    if (n === 0) return true;
    this.tickets -= n;
    this.ticketSpent += n;
    return true;
  }

  /**
   * 领完这张候选 ⇒ 进下一波。返回新的波次号。
   *
   * 归零的是**本波计数**（`waveTickets`），不是余额 `tickets`：
   * 攒过头的部分要能带进下一波，否则"多挣一张"变成惩罚。
   */
  advanceWave(): number {
    this.wave += 1;
    this.waveTickets = 0;
    this.pendingDraft = false;
    this.draftsTaken += 1;
    return this.wave;
  }

  /**
   * 「票孔」：把发券间隔减 `step` 枚，夹在 `TICKET_INTERVAL_FLOOR` 上。
   * 返回**实际**减掉的枚数（已经到下限就是 0）—— 与 `grantUses` 同一口径：
   * 空操作要能被看见，不然文案会写成"生效了"。
   */
  tightenTicketInterval(step: number): number {
    const wanted = Math.max(0, Math.floor(step));
    const next = Math.max(TICKET_INTERVAL_FLOOR, this.ticketEvery - wanted);
    const applied = this.ticketEvery - next;
    this.ticketEvery = next;
    this.ticketEveryTightened += applied;
    return applied;
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
      tickets: this.tickets,
      ticketEarned: this.ticketEarned,
      ticketSpent: this.ticketSpent,
      crossings: this.crossings,
      wave: this.wave,
      waveTickets: this.waveTickets,
      waveTarget: waveTarget(this.wave),
      pendingDraft: this.pendingDraft,
      draftsTaken: this.draftsTaken,
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
