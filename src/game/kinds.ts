/**
 * 币种单一真源（P6）。
 *
 * 在 P6 之前，加一个币种要动 **8 处**：`COIN_KIND` / `COIN_BASE_CHIPS`（constants）、
 * `KIND_LOCKED` + `CoinPalette`（cosmetics）、`coinTexture` 的符号与自发光、
 * `CoinPool` 的材质表、`economy.crossingReturn` 的返值分支、`Game.settleCrossing`
 * 的音频/高潮分级、`AudioSystem` 的音高，以及 `ENDLESS.*Chips` 的数值。
 * 任何一处漏掉都是「币面与实际返值不一致」这类**骗人**的 bug（币上印赏、返 1 筹码）。
 *
 * 现在全部收在 `KINDS` 里：**新增一个币种只改这一个文件**——这是 P6 的验收纪律，
 * 也是 `verify-game.mjs` 里「虚拟币种只改一处」用例的依据。
 */

export type CoinKindId = 'bronze' | 'pattern' | 'payout' | 'bounty' | 'diamond' | 'chest';

/** 兼容旧名（`CoinKind` 在 constants 里一直是 `keyof typeof COIN_KIND`）。 */
export type CoinKind = CoinKindId;

/**
 * 返值规则：三选一，`crossingReturn` 按 `mode` 分派（**不写第二份公式**）。
 *
 * - `multiplied`：基数 × 热度 × 热区 × 加注；`gated` 为真时先过概率闸门（铜币、花纹）。
 * - `fixed`：越线返固定筹码，**不吃任何倍率**——防「用热度/加注刷固定值」的通道。
 * - `effect`：返 0 筹码，改由 ShowDirector 派发演出。
 *   ⚠️ **S16 起没有币种在用这个形态**（宝箱从 `effect` 改成了 `fixed` 50）。
 *   形态与分派（`Game.settleCrossing`、`economy.crossingReturn`）都**刻意保留**：
 *   删掉以后再加就要把三处一起重写，而它本身零成本。
 */
export type KindPayout =
  | { mode: 'multiplied'; base: number; gated: boolean; gateChance: number }
  | { mode: 'fixed'; chips: number }
  | { mode: 'effect'; show: 'chest' };

/**
 * 越线高潮的色调。**唯一真源**——`Hud.flashClimax` 与 `styles.css` 的
 * `#climax-flash.<tone>` 必须与此处一一对应，新增色调要**四处**一起改：
 *   ① 这里；② `styles.css` 的 `#climax-flash.<tone>` 规则；
 *   ③ `styles.css` 的 `@keyframes`；④ `Hud.flashClimax` 里 `classList.remove(...)` 的名单
 *   （漏了第 ④ 处，上一个色调会赖着不走 —— 零报错的静默错）。
 *
 * `white` 是连落 5 次（`FEEDBACK.comboClimax`）专用的白闪：它表达的是
 * **玩家连着把币推下去**这件事，与币种无关，所以刻意用一个不属于任何币种的中性色。
 */
export type ClimaxTone = 'gold' | 'green' | 'blue' | 'white';

export type CoinKindSpec = {
  id: CoinKindId;
  label: string;
  payout: KindPayout;
  /** 币面身份符号（空串 = 不印字，靠纹样识别）。**币面不许印面值**（见 coinTexture 注释）。 */
  glyph: string;
  /** 自发光：固定值币种靠它一眼认出（颜色之外的冗余识别）。null = 不发光。 */
  glow: { color: string; intensity: number } | null;
  /** 锁定配色（玩法保留色，不随皮肤变）；null = 跟随皮肤（只有普通铜币）。 */
  lockedPalette: { base: string; dark: string; ink: string } | null;
  /** 落袋音高（Hz）。 */
  audioHz: number;
  /** 越线高潮反馈（强度 0~1 + 色调）；null = 只有小声。 */
  climax: { strength: number; tone: ClimaxTone } | null;
};

/**
 * 六种币。**返值数值刻意放在这里**（而不是 `ENDLESS`）：
 * 「这个币种值多少」是币种自身的属性，数值与身份分家就是「5 处清单」的根源。
 * `ENDLESS` 只留模式级调参（买入、连落窗口、注入率等）。
 *
 * ## ★★ 返值表的标定史（每一次都是「推进率变了 → 返值必须跟着变」）
 *
 * 核心恒等式（`economy` 模式 ④ 量就是它）：
 *
 * ```
 *   每投 1 枚筹码的期望回收 = 越线/投币 × 单次越线期望 ÷ 本档成本
 * ```
 *
 * **`越线/投币` 是机器属性、不是玩家属性**，所以返值表的每一次重标都由它驱动。
 *
 * ### 第 1 轮 · `bronze.payout.gateChance = 0.18`（原样迁自 `ENDLESS.bronzePayoutChance`）
 *
 * 1. 修好 `PHYSICS.erp` 之后币堆变硬、推力传得更直接，**越线/投币从 1.156 涨到 1.440**，
 *    ×1 档每枚筹码回收从 0.743 涨到 **0.968**——几乎不亏不赚，一局能拖到 238 投还不破产。
 * 2. 第一次反解取 0.12，**过冲了**（×1 回收只剩 0.441、单局 39 投）。错在把「越线/投币」
 *    当成常数——**它自己依赖局长**：局越短 → 盘面垫底的库存还没推出来 → 越线比越低 →
 *    回收越低 → 局更短，是个自我强化的循环。
 * 3. 据此解自洽平衡（模型 `perDrop ≈ 0.564 + 0.168·ln L`，拟合 L=39/98/238）得到 **0.18**。
 * 4. 实测五局（chance 0.18）：投币 53/56/74/71/48，越线/投币 1.15/1.02/1.37/1.10/1.04，
 *    ×1 回收 0.479/0.456/0.798/0.566/—，均值 ≈ 60 投、回收 ≈ 0.57。
 *    **方差比均值更值得记住**：局长 48~74、回收 0.46~0.80 → 一局一局试测不准，
 *    定案必须靠 `ECON_RUNS=200`；任何「每局都必须落在 X~Y」的断言都是掷骰子。
 *
 * ### 第 2 轮 · S13 §5 重标（`0.18 → 0.09`，花纹从「必返」改「半数返」）
 *
 * S13 §1 把推板改成**不对称行程**（`PUSHER_CYCLE.retract 0.9 → 0.45`）之后，
 * 净输送从**精确 0** 变成 **26 毫米/循环**。这就是「币为什么推得动」的答案，
 * 但它同时把返值表的输入整个换掉了：
 *
 * | 量 | S11 定案 | S13 实测 | 变化 |
 * |---|---|---|---|
 * | 越线/投币 | 1.328 | **1.70 ~ 2.15** | +28% ~ +62% |
 * | 单次越线期望 | 0.523 | **0.733** | +40% |
 * | **×1 每投回收** | **0.694** | **1.25 ~ 1.37** | **+80% ~ +97%** |
 *
 * 实测读数（`_tmp-econ-timeline`，150 投）：赚进 165 / 消耗 162，筹码 19 → 23
 * ——**几乎精确打平**，所以局永远不会结束（`economy` ⑤ 红：timeout/剩 124 筹码）。
 *
 * 两个乘数各涨一截，所以「只压铜币闸门」**不够**：单次越线期望里
 * 非铜币那部分（花纹 10.2% + 返币 3.9% + 大赏 0.8%）已经占了 53%，
 * 闸门压到 **0** 时 ×1 回收仍有 **0.83**（perDrop 2.15）——
 * 而铜币占越线 85%，把它的闸门压到 0.02 等于废掉这台机器唯一的主水龙头。
 * ⇒ 按用户拍板走「**返值表整体重标**」，每一枚币都少返一半、但都还在返。
 *
 * #### 三条被实测否掉的错路（别再试）
 *
 * 1. **收窄 `ENDLESS.comboWindow`（1.5 → 0.8）无效**：`E[heat]` 只从 1.759 掉到 1.694（−3.7%）。
 *    因为**越线间隔中位数是 0.067 秒**、均值 1.130 秒 —— 连落是在「一波齐落」**内部**
 *    形成的，与窗口无关。热度回路是**脉冲式**的，不是跨脉冲积累的。
 * 2. **`REFILL` 补币不是来源**：整局 `refills = 0`（床存量 275 → 205，从未跌到阈值 180）。
 * 3. **降 `retract` 单独不够**：净输送与币床线密度是乘的关系
 *    （`perDrop ≈ 净前进 × 币床线密度`，`0.026 × (11/0.145) ≈ 2` 枚/循环），
 *    而完全退回对称行程时 ×1 回收仍 ≈ 0.8~1.0 —— 返值侧无论如何都要动。
 *
 * #### 本轮的取值
 *
 * | 币种 | 旧 | 新 | 说明 |
 * |---|---|---|---|
 * | 铜币闸门 | 0.18 | **0.09** | 主水龙头，占越线 85% |
 * | 花纹 | `gated: false`（必返） | **`gated: true, gateChance: 0.5`** | 占单次越线期望 27%，闸门管不到它，只能自己加闸门 |
 * | 返币 | 3 | **2** | 固定值，不吃倍率 |
 * | 大赏 | 8 | **5** | 固定值，不吃倍率 |
 * | 钻石 | 25 | **25（不动）** | 它是老虎机的大奖，**稀有度**才是它的设计，不是数值 |
 *
 * 预期 ×1 回收 0.66（perDrop 1.70）~ 0.84（perDrop 2.15），都 < 1 且留有余量。
 *
 * ⚠️ **花纹加闸门会引出一个必须一起修的缺陷**：`crossingFeedback()` 原先只看
 * `kindClimax`、不看筹码，于是「被闸门拦下的花纹」会**返 0 却闪金色高潮**（假高潮）。
 * 所以 `crossingReturn` 新增 `blocked` 字段、`crossingFeedback` 用它压掉**币种**高潮
 * （连落白闪**不受影响** —— 那是玩家自己连推出来的，与这枚币返没返钱无关）。
 *
 * **改造推进率（推板行程 / 币床几何 / 币堆刚度）之后必须重标**：越线/投币是分子，
 * 而它又随局长变化，所以标定必须**解自洽平衡**，不能拿一个局长的读数当常数用。
 */
export const KINDS: Record<CoinKindId, CoinKindSpec> = {
  bronze: {
    id: 'bronze',
    label: '普通铜币',
    // 全机唯一的主水龙头：过概率闸门（0.09 是 S13 §5 的标定值）。
    // ★ S23 第 3 轮重标：**基值 ×5**（机器推进率掉到 1/5，见上）。闸门概率**不动** ——
    //   推进率的变化是「乘在每一枚币身上」的，动闸门会让「铜币 vs 花纹」的相对价值跑掉。
    payout: { mode: 'multiplied', base: 5, gated: true, gateChance: 0.09 },
    glyph: '',
    glow: null,
    lockedPalette: null,
    audioHz: 460,
    climax: null,
  },
  pattern: {
    id: 'pattern',
    label: '花纹筹码',
    // ★ S13 §5 起**不再必返**：它占单次越线期望的 27%，而概率闸门管不到它
    // （闸门只对 `gated` 的币种生效），所以「返值表整体重标」只能靠给它自己加一道闸门。
    payout: { mode: 'multiplied', base: 1, gated: true, gateChance: 0.5 },
    glyph: '桃',
    glow: null,
    lockedPalette: { base: '#f4e6c8', dark: '#c9a86e', ink: '#8c3f6b' },
    audioHz: 700,
    // 被闸门拦下时 `blocked = true`，`crossingFeedback` 会压掉这个金色高潮。
    climax: { strength: 0.55, tone: 'gold' },
  },
  payout: {
    id: 'payout',
    label: '绿色返币筹码',
    payout: { mode: 'fixed', chips: 2 },
    glyph: '＋',
    glow: { color: '#3f9c5c', intensity: 0.12 },
    lockedPalette: { base: '#3f9c5c', dark: '#1f6b3a', ink: '#0f3d20' },
    audioHz: 620,
    climax: { strength: 0.75, tone: 'green' },
  },
  bounty: {
    id: 'bounty',
    label: '金色大赏币',
    payout: { mode: 'fixed', chips: 5 },
    glyph: '赏',
    glow: { color: '#ffd24a', intensity: 0.34 },
    lockedPalette: { base: '#ffd24a', dark: '#b9861f', ink: '#5c3a06' },
    audioHz: 460,
    climax: { strength: 1, tone: 'gold' },
  },
  diamond: {
    id: 'diamond',
    label: '钻石筹码',
    // P6 的「变现」侧：唯一的大额筹码出口（25），固定值不吃任何倍率。来源稀有（只走老虎机）。
    // ★ S13 §5 的返值表重标**刻意不动它**：钻石是老虎机的大奖，
    // 它的价值在「稀有感」而不是数值，把它一起砍半等于砍掉一个演出。
    payout: { mode: 'fixed', chips: 25 },
    glyph: '钻',
    glow: { color: '#8fe3ff', intensity: 0.42 },
    lockedPalette: { base: '#9fe8ff', dark: '#3d84a8', ink: '#123246' },
    audioHz: 880,
    climax: { strength: 1, tone: 'blue' },
  },
  chest: {
    id: 'chest',
    label: '宝箱硬币',
    // ★ S16：从 `mode: 'effect'`（越线返 0、改派一场演出）改成**固定 50 筹码**。
    //
    // 用户拍板：「老虎机摇到箱，派演出，给出宝箱。宝箱越线返 50 枚筹码」。
    // 三件事同时变了，必须一起读：
    //   ① 老虎机摇到「箱」→ `ShowDirector.request('chest', {kind:'chest'})`
    //      → `TowerShow` 顶出 **1 枚**巨型宝箱（`SHOW_SPECS.chest.count` 8 → 1）；
    //   ② 那一枚宝箱的**收益**从「派一场演出」改成「越线直接给 50 筹码」——
    //      它是全机最大的单笔（钻石 25 的两倍），因为它是稀有度最低的奖励符号
    //      （`SLOT_SYMBOL_WEIGHTS` 里箱的权重只有钻的一半）；
    //   ③ 「越线再派一场演出」这条链**断掉了**：`mode: 'effect'` 是它的唯一入口。
    //
    // 0 不再是硬值了（`fixed` 走 `settleCrossing` → `earned`，账本恒等式一字不改）。
    // ⚠️ 本条**只做了效果与功能**，返值 50 没有经过 `economy` 标定 —— 标定是下一轮的事。
    payout: { mode: 'fixed', chips: 50 },
    glyph: '箱',
    glow: { color: '#ffb347', intensity: 0.3 },
    lockedPalette: { base: '#c98a3a', dark: '#7a4c17', ink: '#3b220a' },
    audioHz: 520,
    climax: { strength: 1, tone: 'gold' },
  },
};

/** 全部币种（有序：渲染分组、材质表、遍历都按它来）。 */
export const COIN_KINDS = Object.keys(KINDS) as CoinKindId[];

/** 兼容旧名：`COIN_KIND[kind].label` 的消费者不用改。 */
export const COIN_KIND = Object.fromEntries(
  COIN_KINDS.map((id) => [id, { label: KINDS[id].label }]),
) as Record<CoinKindId, { label: string }>;

/** 固定值币种（不吃任何倍率）——判据按它分区，而不是手写 kind 名单。 */
export const FIXED_KINDS = COIN_KINDS.filter((id) => KINDS[id].payout.mode === 'fixed');

/**
 * 效果型币种（返 0 筹码，派发演出）。
 *
 * ⚠️ **S16 起是空数组**（宝箱改成 `fixed` 50 之后没有币种再用 `effect`）。
 * 保留它是因为 `Game` / `economy` 的分派分支也保留了 —— 见 `KindPayout` 的注释。
 */
export const EFFECT_KINDS = COIN_KINDS.filter((id) => KINDS[id].payout.mode === 'effect');

export function kindSpec(kind: CoinKindId): CoinKindSpec {
  return KINDS[kind];
}

/** 兼容旧名：各币种基础返值表（由 `KINDS` 派生，不再是第二份手写表）。 */
export const COIN_BASE_CHIPS = Object.fromEntries(
  COIN_KINDS.map((id) => [id, baseChips(id)]),
) as Record<CoinKindId, number>;

/** 币种基础返值（倍率型给基数，固定值给筹码，效果型给 0）——「币面该印什么」的唯一依据。 */
export function baseChips(kind: CoinKindId): number {
  const payout = KINDS[kind].payout;
  if (payout.mode === 'fixed') return payout.chips;
  if (payout.mode === 'multiplied') return payout.base;
  return 0;
}
