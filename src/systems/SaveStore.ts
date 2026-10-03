import { ENDLESS } from '../game/constants';
import { spendableOf } from '../game/economy';
import { COIN_SKINS, CABINET_SKINS } from '../game/cosmetics';

/** 一局的历史记录（排行榜三列：赚进 / 存活投数 / 跪求次数）。 */
export type RunRecord = { earned: number; drops: number; begs: number };

export type SaveData = {
  /**
   * 唯一的余额（S4 合并账户）。旧名 `wallet`，v5 及以前是「钱包」，与局内筹码分属两个口袋。
   *
   * ★ 合并之后**没有「买入」与「回存」这两个动作了** —— 玩家眼里只剩这一个数，
   * 投币扣它、越线进它、贷款进它、买图鉴也花它。
   * 原来靠「两个口袋之间的转账」表达的那条防刷钱约束换了载体，见 `beggedTotal`。
   */
  balance: number;
  /**
   * 终身累计跪求额 —— **必须落盘**，这是个安全约束不是统计量。
   *
   * 🔴 为什么不能像旧的 `RunState.begged` 那样按局/按段清零：
   *   旧模型里脏钱活在「本局筹码」这个口袋里，刷新或收工就把它带走了，洗不成永久进度；
   *   合并之后**只有一条账户**，跪来的 25 就是余额里的 25。
   *   若这个标记不落盘，「跪求 → 刷新页面 ⇒ 标记归零」就能把脏钱洗成可买图鉴的干净钱 ——
   *   正是这条约束自诞生起要防的那个循环（旧注释原话：「破产 → 跪求 → 立刻收工就是无限刷筹码」）。
   *
   * 效果是**一次性永久折减**而不是锁死：`可花 = balance − beggedTotal`，
   * 之后赚进的都会重新把可花额度顶上去（见 `economy.spendableOf` 的代入验算）。
   */
  beggedTotal: number;
  /**
   * 当前欠款（S2 贷款子系统）。**跨局持久化**——「欠着继续玩」是本功能的全部意义，
   * 刷新就把债清掉的话，贷款等于白送筹码。
   *
   * ⚠️ **不从 `totalBegs` 折算**：跪求次数与欠款是两件事，历史跪再多也不构成欠债。
   * 上限见 `ENDLESS.debtCapLoans`，实际进额一律走 `loan()` / `chargeFine()`。
   */
  debt: number;
  /**
   * 终身累计借入。与 `debt` 的区别是**只增不减**（还掉不会把它退回去），
   * 所以它是对账口径：`debt ≤ loanedTotal` 必须恒成立，
   * 而 `loanedTotal − debt` = 已经还掉的那一截。
   */
  loanedTotal: number;
  /** 已解锁的币纹与机柜配色 id。 */
  coinSkins: string[];
  cabinetSkins: string[];
  /** 当前选用的外观。 */
  selectedCoinSkin: string;
  selectedCabinetSkin: string;
  /** 历史单局最高「赚进筹码」。 */
  bestEarned: number;
  /** 终身累计跪求次数（排行榜的第二列）。 */
  totalBegs: number;
  /** 最近几局的记录，用于本地排行榜三列展示。 */
  runs: RunRecord[];
  /** XIXI 四槽亮灭（P5）：跨局、跨会话持续的收集进度。 */
  xixi: boolean[];
};

const STORAGE_KEY = 'coin-pusher:save:v6';
/** 老版本的键：只在迁移时读一次，不删（便于回滚）。 */
const LEGACY_V5_KEY = 'coin-pusher:save:v5';
const LEGACY_V4_KEY = 'coin-pusher:save:v4';
const LEGACY_V3_KEY = 'coin-pusher:save:v3';
const LEGACY_V2_KEY = 'coin-pusher:save:v2';
const LEGACY_V1_KEY = 'coin-pusher:save:v1';

const DEFAULT_COIN_SKIN = COIN_SKINS[0].id;
const DEFAULT_CABINET_SKIN = CABINET_SKINS[0].id;

/**
 * 老存档里的图鉴券折算成筹码的汇率。
 *
 * 券在 v2 是「通关奖励」，在 v3 已经不存在发券渠道，所以一次性按 5 筹码回收，
 * 让老玩家的积累不至于凭空消失。
 */
const TICKET_TO_CHIPS = 5;
/** 老存档里的分数折算成筹码的除数（10 分 ≈ 1 筹码，与旧面值同量级）。 */
const SCORE_TO_CHIPS = 10;

function defaultSave(): SaveData {
  return {
    balance: ENDLESS.walletStart,
    beggedTotal: 0,
    debt: 0,
    loanedTotal: 0,
    coinSkins: [DEFAULT_COIN_SKIN],
    cabinetSkins: [DEFAULT_CABINET_SKIN],
    selectedCoinSkin: DEFAULT_COIN_SKIN,
    selectedCabinetSkin: DEFAULT_CABINET_SKIN,
    bestEarned: 0,
    totalBegs: 0,
    runs: [],
    xixi: [false, false, false, false],
  };
}

/** v2 存档形状（战役六关 + 图鉴券 + 分数制无尽），只在迁移时出现。 */
type LegacySave = {
  tickets?: number;
  coinSkins?: string[];
  cabinetSkins?: string[];
  selectedCoinSkin?: string;
  selectedCabinetSkin?: string;
  endlessBest?: number;
  endlessBegs?: number;
  endlessRuns?: Array<{ score?: number; drops?: number; begs?: number }>;
};

/**
 * 余额的**全部合法去路**（`SaveStore.totals` 的形状）。
 * 四个进账来源 = `creditBalance` 的 `source`，两个出账用途 = `debitBalance` 的 `kind`。
 * 全局守恒式（验证批 ②）按这六个桶算，所以**新增一种进出账必须同时加一个桶**，
 * 否则那一笔在算式里是隐形的。
 */
export type AccountTotals = {
  earned: number;
  begged: number;
  loaned: number;
  refill: number;
  spend: number;
  skin: number;
};

/**
 * 本地进度：筹码钱包、无尽排行榜、图鉴外观。
 *
 * v3 起**没有分数也没有图鉴券**：筹码就是唯一的进度货币。
 * 玩家在 v2 里已经买到手的外观、券余额与最高分都会在迁移时折成筹码，
 * 不会因为改版被清零。
 */
export class SaveStore {
  private data: SaveData;
  /**
   * 终身累计进出账（S4 合并账户之后 ② 那条全局守恒式的账本）。
   *
   * 存在的理由是「**每个局级账本都会在 `startRun` 被重新快照**」：`RunState.initial`
   * 取的是开局那一刻的余额，所以上一局结束时**没被任何一局账本记到**的那笔余额变动
   * （旧模型里 ② 报的「差 26」就是它），在局级恒等式里永远看不见 —— 它被下一局的
   * `initial` 悄悄吸收了。要抓住它，必须有一份**不按局清零**的账。
   *
   * 六个桶分别是余额的**全部**合法去路（`creditBalance` 四种来源 + `debitBalance` 两种用途），
   * 所以「余额只走这两扇门」这条不变量的检验式就是
   * `Δbalance == Δ(earned+begged+loaned+refill) − Δ(spend+skin)`。
   * 谁绕过这两扇门直接写 `data.balance`，这一条当场红。
   *
   * ⚠️ **不落盘、`clear()` 也不清零**（与旧的 `refilledTotal` 同规格），判据用的是它的增量。
   */
  private readonly totals: AccountTotals = {
    earned: 0,
    begged: 0,
    loaned: 0,
    refill: 0,
    spend: 0,
    skin: 0,
  };

  constructor() {
    const { data, migrated } = this.read();
    this.data = data;
    // 迁移结果立刻落盘到 v3；v2 的键不删，便于回滚。
    if (migrated) this.write();
  }

  get snapshot(): SaveData {
    return this.data;
  }

  /** 唯一余额（S4 合并账户，旧名 `wallet`）。 */
  get balance(): number {
    return this.data.balance;
  }

  /** 终身累计跪求额（防刷钱口径，必须落盘，理由见 `SaveData.beggedTotal`）。 */
  get beggedTotal(): number {
    return this.data.beggedTotal;
  }

  /**
   * 能拿去**买图鉴**的额度 = 余额扣掉跪来的那一份。
   * 恒等式与玩法都不看这个数，只有「把余额换成永久进度」这一步看 ——
   * 它站在旧模型里「不可回存」的**同一个位置**上。
   */
  get spendable(): number {
    return spendableOf(this.data.balance, this.data.beggedTotal);
  }

  /**
   * 唯一的进账入口（S4）。`source` 决定这笔钱算不算脏、以及要不要记进对账口径：
   * - `begged` ⇒ 同时加进 `beggedTotal`（脏钱，不能换成永久进度）；
   * - `refill` ⇒ 记进 `totals.refill`（脚本白给，守恒式要减掉它）；
   * - `earned` / `loaned` ⇒ 干净进账（旧的 `buyIn` 项本来就可回存，贷款同理）。
   * ★ 进账只有一个函数 ⇒「加余额」这件事在代码里只出现一次。
   *   原先是 `buyIn` 减、`depositWallet` 加、`refillWallet` 加、`loan` 加**四处各写一遍**
   *   `data.wallet ±=` —— 那正是本项目最忌讳的「同一件事有几个抄本」。
   */
  creditBalance(
    amount: number,
    source: 'earned' | 'begged' | 'loaned' | 'refill' = 'earned',
  ): number {
    const applied = Math.max(0, Math.round(amount));
    if (applied === 0) return 0;
    this.data.balance += applied;
    this.totals[source] += applied;
    if (source === 'begged') this.data.beggedTotal += applied;
    this.write();
    return applied;
  }

  /**
   * 唯一的扣减入口（S4）：**全有或全无**，余额不足返回 false 且**一分都不动**。
   *
   * 继承的是旧 `RunState.spendChips` 的语义 —— 调用方必须明确拒绝而不是静默吞掉筹码
   * （机关与加注那两条「条件不满足时明确拒绝」的判据就靠这条）。
   * ⚠️ 扣减**不动 `beggedTotal`**：旧模型里花掉脏钱也不会让脏钱变干净，这里保持同样的严苛度。
   *   余额可能低于 `beggedTotal` ⇒ 由 `spendableOf` 的 `max(0, …)` 夹住，不会出现负的可花额度。
   */
  debitBalance(amount: number, kind: 'spend' | 'skin' = 'spend'): boolean {
    const wanted = Math.round(amount);
    if (wanted <= 0) return true;
    if (this.data.balance < wanted) return false;
    this.data.balance -= wanted;
    this.totals[kind] += wanted;
    this.write();
    return true;
  }

  /**
   * 终身累计进出账的只读快照（验证批的全局守恒式用）。
   * 与 `refilled` 同源：那条是 `totals.refill` 的旧名字，留着一个读数而不是两个抄本。
   */
  get accountTotals(): AccountTotals {
    return { ...this.totals };
  }

  isSkinUnlocked(kind: 'coin' | 'cabinet', id: string): boolean {
    const list = kind === 'coin' ? this.data.coinSkins : this.data.cabinetSkins;
    return list.includes(id);
  }

  /**
   * ★ S4：`buyIn()` 与 `depositWallet()` **两条腿一起删除**，不是改名。
   * 旧流程是「钱包 −20 → 桌上 +20 → 玩 → 桌上 −脏 → 钱包 +回存」，
   * 合并之后只有「余额」这一个数，这些**转账**没有对象了。
   * 保留它们（哪怕做成空函数）就是留着第二套词汇，下一次改动会有人真的去调它们。
   */

  /**
   * 充值/补充余额（调试与验证脚本用）。
   *
   * `refilled` 是**单调递增的累计值、`clear()` 也不清零** —— 余额守恒算式
   * （S4 之后：`balance终 = balance起 + Σ充值 + Σ赚进 + Σ跪求 + Σ贷款 − Σ花费`）
   * 要用它的增量，中途被归零会让增量变负、算式凭空多出一笔。
   *
   * ★ 旧版这条式子里还有「− Σ买入 + Σ回存」两项 —— 那两个动作在 S4 里整个消失了，
   *   不是换个写法：合并成一条账户之后，「从钱包搬到桌上」这件事没有对应物了。
   */
  refillWallet(amount: number = 100): void {
    this.creditBalance(amount, 'refill');
  }

  /**
   * 累计充值额（不落盘，只在本次会话内累计）。
   * ★ S4 之后它就是 `totals.refill` 的旧名字 —— 留着是为了不把「充值」写成两个抄本。
   */
  get refilled(): number {
    return this.totals.refill;
  }

  // ── 贷款 / 欠款（S2）──────────────────────────────────────────────────────
  // 这一组与 `refillWallet` 是**同一族的账户层动作**：只碰钱包与账，
  // 不碰本局筹码、不碰 RNG、不碰盘面 —— 所以「贷款之后盘面一动不动」
  // 是一条逐事件恒等式，S3 就是靠它来验的。

  /** 一次贷款额 = 几个买入额。★ 由 `ENDLESS.buyIn` 推出去，这里不存绝对值。 */
  private get loanUnit(): number {
    return ENDLESS.buyIn * ENDLESS.loanStepsPerBuyIn;
  }

  /** 欠款上限。**别在外面重算这个式子** —— 上限换了地方就不叫上限。 */
  get debtCeiling(): number {
    return this.loanUnit * ENDLESS.debtCapLoans;
  }

  /** 当前欠款。 */
  get debt(): number {
    return this.data.debt;
  }

  /** 终身累计借入（只增不减）：`debt ≤ loanedTotal` 恒成立，差就是已还额。 */
  get loanedTotal(): number {
    return this.data.loanedTotal;
  }

  /**
   * 此刻能给的一笔贷款（**只读，不动账**）。HUD 与验证脚本都用它，别自己拼上限式。
   * `available=false` 时 HUD 应当**藏掉按钮**而不是让它可点——点了只会得到
   * 「什么都没发生」，那是本项目最讨厌的静默失败形状。
   */
  get loanOffer(): { amount: number; available: boolean; debt: number; ceiling: number } {
    const amount = Math.max(0, Math.min(this.loanUnit, this.debtCeiling - this.data.debt));
    return { amount, available: amount > 0, debt: this.data.debt, ceiling: this.debtCeiling };
  }

  /**
   * 贷一笔**直接进余额并接着打**（S3 去局感）。返回实际贷到的额，0 表示不给。
   *
   * ★ S4 合并账户之后，它与 `loan()` 的差别**只剩「额度从哪儿来」**：
   *   这条读 `loanOffer`（引擎给玩家的报价，到顶时是剩余额度），`loan()` 收调用方给的数
   *   （脚本与调试用）。旧注释里那条「刻意不经过钱包，否则钱包守恒看到一笔假账」
   *   的理由**随「买入」这个动作一起消失了** —— 现在只有一条账户，两种写法落的是同一个数。
   *   保留两个入口是为了让「游戏机制发的钱」和「脚本白给的钱」在调用点上就分得开
   *   （与 `refillWallet` / `loan` 的分法是同一套）。
   *
   * 两者都记 `debt` 与 `loanedTotal` ⇒ 欠款口径仍是一个真源。
   */
  loanToStake(): number {
    const { amount } = this.loanOffer;
    if (amount <= 0) return 0;
    // ★ S4 合并账户之后这条**必须真的把钱放进余额**：旧模型里贷来的钱记进 `buyIn`，
    //   于是它在「桌上」那个口袋里；合并之后没有那个口袋了，
    //   只加 `debt` 不加余额 = 玩家欠了钱却什么都没拿到。
    //   （这正是合并会强迫你重新检查每一个「两个口袋之间的转账」的例子。）
    this.creditBalance(amount, 'loaned');
    this.data.debt += amount;
    this.data.loanedTotal += amount;
    return amount;
  }

  /**
   * 贷一笔进钱包。返回**实际生效额**（到顶时为剩余额度，可能是 0）。
   *
   * 默认贷 `loanUnit`（= 一次买入额）。调用方要拿返回值记账，
   * **不能假设「请求额 == 到账额」**——到顶时它小于请求额，而 HUD 显示的必须是到账的那笔。
   */
  loan(amount?: number): number {
    const headroom = this.debtCeiling - this.data.debt;
    if (headroom <= 0) return 0;
    const applied = Math.max(0, Math.min(Math.round(amount ?? this.loanUnit), headroom));
    if (applied === 0) return 0;
    this.creditBalance(applied, 'loaned');
    this.data.debt += applied;
    this.data.loanedTotal += applied;
    return applied;
  }

  /**
   * 罚款扣不掉的那一截转成欠款（S5b 胡萝卜四连「扣光余额并转入 debt」）。
   *
   * 同样受 `debtCeiling` 约束；到顶之后多余的那一截**被免除**，
   * 所以这里返回的是**实际进债额**，免除额 = 请求额 − 返回值。
   * ⚠️ 上限是承重结构不是保险丝：零余额段里每次四连都会全额进债，
   * 没有上限 debt 就线性暴涨、系统没有稳态（见 `ENDLESS.debtCapLoans` 那段）。
   */
  chargeFine(shortfall: number): number {
    const headroom = this.debtCeiling - this.data.debt;
    if (headroom <= 0 || shortfall <= 0) return 0;
    const applied = Math.min(Math.max(0, Math.round(shortfall)), headroom);
    this.data.debt += applied;
    this.write();
    return applied;
  }

  /**
   * 用一笔产出抵债 —— 用户 09-28 拍板的**甲**规则：
   * 按 `debt : balance` 比例实时分流，抵掉的那一截由本函数返回，
   * 调用方把**剩下的**那一截给玩家（`gainChips(gross − repaid)`）。
   *
   * `balance` = 玩家此刻的全部持有：S4 之前是「钱包 + 本局筹码」两个口袋的和，
   * S4 合并账户之后就剩一个 `balance`。**这里刻意不直接读 `wallet`**，
   * 否则 S4 落地时会把这条比例式静悄悄改掉。
   *
   * ⚠️ 这条分流**不进三账本恒等式**：恒等式里的 `earned` 只记真正落到手里的那一截，
   * 抵债额另用 `RunState.repaid` 记 —— 与 `fines` 同族（对账口径，不是第六项）。
   * 依据是 `RunState.ts` 里那条既有惯例：新增筹码流出走唯一入口、不给恒等式加项。
   * 加了项就要同步 `Ledger` / `ledgerBalances` / 所有断言点，那正是 S0a 刚清掉的那类债。
   *
   * ⚠️ **甲规则的已知渐近行为**（先写明，别当 bug 报）：`balance > 0` 时分流比
   * `debt/(debt+balance)` 会随 debt 下降而变小 ⇒ 衰减是渐近的，小额会被 `round` 成 0 而停在低位；
   * 整数域上它靠「余额为 0 时比例是 1 ⇒ 全额抵债」收尾。稳态到底停在哪，
   * 由 S2 那轮 economy 短批实测 `repaid/(earned+repaid)` 落在哪个带上来定档。
   */
  repayFrom(earnings: number, balance: number): number {
    if (this.data.debt <= 0 || earnings <= 0) return 0;
    const share = this.data.debt / (this.data.debt + Math.max(0, balance));
    const applied = Math.min(this.data.debt, Math.round(earnings * share));
    if (applied <= 0) return 0;
    this.data.debt -= applied;
    this.write();
    return applied;
  }

  /**
   * 直接把钱包设成某个值（验证脚本用）。
   *
   * 差额记进 `totals.refill`：这样无论调用方把余额改成多少，全局守恒式依然精确成立，
   * 不会因为「测试偷偷改了钱包」而报出假失败。
   */
  setWallet(amount: number): void {
    const next = Math.max(0, Math.round(amount));
    this.totals.refill += next - this.data.balance;
    this.data.balance = next;
    this.write();
  }

  /** 记录一局：最高赚进、排行榜与累计跪求次数。 */
  recordRun(earned: number, drops: number, begs: number): { best: number; totalBegs: number } {
    this.data.bestEarned = Math.max(this.data.bestEarned, earned);
    this.data.totalBegs += begs;
    this.data.runs.unshift({ earned, drops, begs });
    this.data.runs = this.data.runs.slice(0, 10);
    this.write();
    return { best: this.data.bestEarned, totalBegs: this.data.totalBegs };
  }

  /** 终身累计跪求次数。 */
  begCount(): number {
    return this.data.totalBegs;
  }

  /** 用余额解锁一个外观。返回 false 表示**可花额度**不够或已解锁。 */
  unlockSkin(kind: 'coin' | 'cabinet', id: string, cost: number): boolean {
    if (cost <= 0 || this.isSkinUnlocked(kind, id)) return false;
    // ★ 门槛读 `spendable` 而不是 `balance`：这是脏钱约束在合并账户之后**唯一还活着的载体**。
    //   旧模型里它靠「跪来的筹码不能回存钱包、而买图鉴只花钱包」间接达成；
    //   合并之后没有「回存」这一步了，若这里仍读余额，
    //   「跪求 → 直接买图鉴」就成了新的刷进度通道（正是那条约束自诞生就要防的事）。
    if (this.spendable < cost) return false;

    // ★ 走 `debitBalance` 而不是直接写 `data.balance`：出账只有那一扇门，
    //   直接写会让全局守恒式（验证批 ②）把这笔花掉的钱看成「凭空消失」。
    if (!this.debitBalance(cost, 'skin')) return false;
    if (kind === 'coin') this.data.coinSkins.push(id);
    else this.data.cabinetSkins.push(id);
    this.write();
    return true;
  }

  selectSkin(kind: 'coin' | 'cabinet', id: string): boolean {
    if (!this.isSkinUnlocked(kind, id)) return false;
    if (kind === 'coin') this.data.selectedCoinSkin = id;
    else this.data.selectedCabinetSkin = id;
    this.write();
    return true;
  }

  /**
   * 清档（验证脚本用）。
   *
   * ⚠️ 它把余额**重置**而没有记进 `totals` —— 也就是说它是一笔守恒式看不见的进出账。
   * 所以清档只能出现在**测量窗口之外**（验证批在批首 `clearSave()`，然后才取余额基准）。
   * 同理 `totals` 自己也不被这里清零：它的语义是「本次会话累计」，判据读的是增量。
   */
  clear(): SaveData {
    this.data = defaultSave();
    this.write();
    return this.data;
  }

  /**
   * 读取存档。v3 缺失时从 v2（或 v1）迁移：
   *
   * - 已购外观与选用外观原样保留；
   * - 券按 `TICKET_TO_CHIPS` 折成筹码，叠在起始钱包上；
   * - 历史最高分按 `SCORE_TO_CHIPS` 折成筹码，同样叠进钱包（一次性补偿）；
   * - 排行榜的分数列换算成「赚进筹码」，跪求次数沿用；
   * - 战役六关的进度字段直接丢弃。
   */
  private read(): { data: SaveData; migrated: boolean } {
    const base = defaultSave();
    try {
      const current = window.localStorage.getItem(STORAGE_KEY);
      if (current) return { data: this.parse(current, base), migrated: false };

      // v5 → v6：只差 `wallet` → `balance` 的**字段名**与新增的 `beggedTotal`（初值 0）。
      // ★ 金额本身一分都不折算 —— 任何"顺便重算一下余额"都是在动玩家的财产。
      //   两个键名 `parse()` 都接受，所以这条只是按当前格式解析。
      const legacyV5 = window.localStorage.getItem(LEGACY_V5_KEY);
      if (legacyV5) return { data: this.parse(legacyV5, base), migrated: true };

      // v4 与 v5 同构（只差 debt / loanedTotal 两个字段）：按当前格式解析，缺的补默认值 0。
      // ★ 老存档的 debt **初值就是 0，绝不从 `totalBegs` 折算** —— 跪求次数与欠债是两件事，
      // 历史跪得再多也不构成欠钱；折一下就等于给老玩家凭空发一笔「免费的额度」。
      const legacyV4 = window.localStorage.getItem(LEGACY_V4_KEY);
      if (legacyV4) return { data: this.parse(legacyV4, base), migrated: true };

      // v3 与 v4 同构（只差 xixi 字段）：按当前格式解析，缺的字段默认补齐。
      const legacyV3 = window.localStorage.getItem(LEGACY_V3_KEY);
      if (legacyV3) return { data: this.parse(legacyV3, base), migrated: true };

      const legacy =
        window.localStorage.getItem(LEGACY_V2_KEY) ?? window.localStorage.getItem(LEGACY_V1_KEY);
      if (!legacy) return { data: base, migrated: false };
      return { data: this.migrate(this.parseLegacy(legacy), base), migrated: true };
    } catch {
      return { data: base, migrated: false };
    }
  }

  private parseLegacy(raw: string): LegacySave {
    return JSON.parse(raw) as LegacySave;
  }

  /** v3 存档：字段缺失时用默认值补齐，不写入 undefined。 */
  private parse(raw: string, base: SaveData): SaveData {
    const parsed = JSON.parse(raw) as Partial<SaveData>;
    /*
     * v6 把 `wallet` 改名成 `balance`（同一条账户，名字跟着语义走）。
     * ⇒ 迁移就是**换个键名读同一个数**，这里两个名字都接受，v5/v6 的存档都能被 `parse()` 吃下。
     * ⚠️ 金额本身一分都不折算 —— 任何「顺便重算一下余额」都是玩家的财产变动。
     */
    const legacyWallet = (parsed as { wallet?: number }).wallet;
    let balance =
      typeof parsed.balance === 'number'
        ? parsed.balance
        : typeof legacyWallet === 'number'
          ? legacyWallet
          : base.balance;
    // 终身跪求额：v6 之前没有这个字段 ⇒ 老玩家记 0（他们过去的跪求**不会被追认为脏钱**，
    // 因为那些钱在旧模型里从来没有进入过钱包；补记反而是凭空扣他们一笔可花额度）。
    const beggedTotal =
      typeof parsed.beggedTotal === 'number' && parsed.beggedTotal > 0
        ? Math.round(parsed.beggedTotal)
        : 0;
    const runs = Array.isArray(parsed.runs) ? parsed.runs : base.runs;
    const totalBegs = typeof parsed.totalBegs === 'number' ? parsed.totalBegs : base.totalBegs;
    const debt = typeof parsed.debt === 'number' && parsed.debt > 0 ? Math.round(parsed.debt) : 0;
    // `loanedTotal` 至少要有 `debt` 那么大：老存档只有欠款、没有借入累计，
    // 直接取 0 会让「已还额 = loanedTotal − debt」凭空算出负数。
    const loanedTotal = Math.max(debt, typeof parsed.loanedTotal === 'number' ? Math.round(parsed.loanedTotal) : 0);
    // 如果无有效历史局且无跪求记录、但余额被扣空（如频繁刷新），自动重置成起始余额，防止新局坏死
    //
    // ★ 两条守卫各拦一种白拿：
    //   `debt === 0`（S2）：欠着钱的人不许靠刷新白拿起始余额；
    //   `beggedTotal === 0`（S4）：**刚跪求过、还没落进任何一局记录的人**也不许 ——
    //     旧模型里跪来的钱活在「桌上」口袋，刷新就没了，所以重置余额不亏不赚；
    //     合并之后余额里可能正含着那笔脏钱，此时重置等于让「跪求 → 刷新」变成免费拿 200 的循环。
    if (balance <= 0 && runs.length === 0 && totalBegs === 0 && debt === 0 && beggedTotal === 0) {
      balance = base.balance;
    }
    return {
      balance,
      beggedTotal,
      debt,
      loanedTotal,
      coinSkins:
        Array.isArray(parsed.coinSkins) && parsed.coinSkins.length > 0 ? parsed.coinSkins : base.coinSkins,
      cabinetSkins:
        Array.isArray(parsed.cabinetSkins) && parsed.cabinetSkins.length > 0
          ? parsed.cabinetSkins
          : base.cabinetSkins,
      selectedCoinSkin:
        typeof parsed.selectedCoinSkin === 'string' ? parsed.selectedCoinSkin : base.selectedCoinSkin,
      selectedCabinetSkin:
        typeof parsed.selectedCabinetSkin === 'string'
          ? parsed.selectedCabinetSkin
          : base.selectedCabinetSkin,
      bestEarned: typeof parsed.bestEarned === 'number' ? parsed.bestEarned : base.bestEarned,
      totalBegs,
      runs,
      // v3 存档没有 xixi 字段 → 默认全灭；有则原样沿用（四槽亮灭是持续进度）。
      xixi:
        Array.isArray(parsed.xixi) && parsed.xixi.length === 4
          ? parsed.xixi.map(Boolean)
          : [...base.xixi],
    };
  }

  private migrate(legacy: LegacySave, base: SaveData): SaveData {
    const tickets = typeof legacy.tickets === 'number' ? legacy.tickets : 0;
    const best = typeof legacy.endlessBest === 'number' ? legacy.endlessBest : 0;
    const legacyRuns = Array.isArray(legacy.endlessRuns) ? legacy.endlessRuns : [];

    return {
      balance: base.balance + tickets * TICKET_TO_CHIPS + Math.round(best / SCORE_TO_CHIPS),
      // v2/v1 没有贷款概念，也没有「跪求折成永久额度」这回事 ⇒ 两个都从 0 起。
      beggedTotal: 0,
      debt: 0,
      loanedTotal: 0,
      coinSkins:
        Array.isArray(legacy.coinSkins) && legacy.coinSkins.length > 0 ? legacy.coinSkins : base.coinSkins,
      cabinetSkins:
        Array.isArray(legacy.cabinetSkins) && legacy.cabinetSkins.length > 0
          ? legacy.cabinetSkins
          : base.cabinetSkins,
      selectedCoinSkin:
        typeof legacy.selectedCoinSkin === 'string' ? legacy.selectedCoinSkin : base.selectedCoinSkin,
      selectedCabinetSkin:
        typeof legacy.selectedCabinetSkin === 'string'
          ? legacy.selectedCabinetSkin
          : base.selectedCabinetSkin,
      bestEarned: Math.round(best / SCORE_TO_CHIPS),
      totalBegs: typeof legacy.endlessBegs === 'number' ? legacy.endlessBegs : 0,
      runs: legacyRuns.map((run) => ({
        earned: Math.round((typeof run.score === 'number' ? run.score : 0) / SCORE_TO_CHIPS),
        drops: typeof run.drops === 'number' ? run.drops : 0,
        begs: typeof run.begs === 'number' ? run.begs : 0,
      })),
      xixi: [...base.xixi],
    };
  }

  /** 写 XIXI 四槽状态：点亮与集齐清空都走这里，是 xixi 进存档的唯一入口。 */
  setXixi(slots: boolean[]): void {
    this.data.xixi = slots.map(Boolean);
    this.write();
  }

  private write(): void {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data));
    } catch {
      // 隐私模式下写入失败不影响本局游玩。
    }
  }
}
