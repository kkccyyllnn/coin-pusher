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

import type { CoinEffectId } from './effects';

export type CoinKindId = 'bronze' | 'pattern' | 'payout' | 'bounty' | 'diamond' | 'chest' | 'debt';
/** 兼容旧名（`CoinKind` 在 constants 里一直是 `keyof typeof COIN_KIND`）。 */
export type CoinKind = CoinKindId;

/**
 * 返值规则：三选一，`crossingReturn` 按 `mode` 分派（**不写第二份公式**）。
 *
 * - `multiplied`：基数 × 热度 × 热区 × 加注；`gated` 为真时先过概率闸门（铜币、花纹）。
 * - `fixed`：越线返固定筹码，**不吃任何倍率**——防「用热度/加注刷固定值」的通道。
 * - `effect`：**返 0 筹码**，改由 `CoinEffects.dispatchCoin` 结算挂在币上的效果。
 *   S16 起这条一度空转（宝箱改成固定 50），10-07 的 Stage 2 由**催债币**重新启用它 ——
 *   所以它不是"预留的死分支"了，有真用户、也有真判据（见 `verify-game.mjs` 的 Stage 2 那组门）。
 *   ⚠️ `effect` 的名字从 `show: 'chest'` 改成 `effect: CoinEffectId`：
 *   原先演出名被硬编码在类型里，等于"币种能干什么"写在类型表外面一处。
 */
export type KindPayout =
  | { mode: 'multiplied'; base: number; gated: boolean; gateChance: number }
  | { mode: 'fixed'; chips: number }
  | { mode: 'effect'; effect: CoinEffectId };

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
 * 七种币（10-07 Stage 2 加了催债币）。**返值数值刻意放在这里**（而不是 `ENDLESS`）：
 * 「这个币种值多少」是币种自身的属性，数值与身份分家就是「5 处清单」的根源。
 * `ENDLESS` 只留模式级调参（买入、连落窗口、注入率等）。
 *
 * ## ★★ 返值表的标定史（前几轮都是「推进率变了 → 返值必须跟着变」；第 4 轮是反例）
 *
 * ⚠️ 通则不是「变了就要抬表」：**先问实测回收离打平有多远、右尾离上限有多近**。
 *    返值表整体缩放回收，改不了回收随局长增长的形状；当上限就在旁边时，
 *    抬表会把更多局推成「不靠破产收尾」——那是往错的方向走。
 *    第 4 轮的结论是表不动、改判据口径，且它的 ×1 回收 0.694 正落在第 2 轮
 *    预先登记的预测区间之内（见下面 `0.66（perDrop 1.70）~ 0.84（perDrop 2.15）`）。
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
 * 净输送从**精确 0** 变成 **26 毫米/循环**。这就是「币为什么推得动」的答案（⚠️ 该数属 **S13 破对称态**，
 * 且测于庚案 `predictionDistance 0.002 → 0.10` 之前；10-02 同种破对称实测 24.00、出厂态对称实测 −0.25 毫米/循环）。
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
 * ### 第 5 轮 · 庚案后推进率口径复核（10-02）——**返值表保持不变，本轮只改注释口径**
 *
 * 触发点：`constants.ts`（两处）、`ShowDirector.ts`、`verify-game.mjs` 里共 7 处抄着「26 毫米/循环」，
 * 其中被当作出厂态事实引用的那几处（推板拖行 ~7 秒、台面吞吐 1.57 枚/循环）与当期实测不符。
 *
 * 本轮实测（同一判据 `probe` 的『单枚币不被偷偷赋予净输送』）：
 *   · 出厂态（S23 已把 `PUSHER_CYCLE.retract` 改回 0.9 对称 + 庚案 `predictionDistance` 0.10）：
 *     **每循环净漂移 −0.25 毫米**（上限 2.32），11 项判据全过 —— 见 `/tmp/probe-postland.log`。
 *   · 人为破对称（`retract` 0.45，即 M2 变异）：**24.00 毫米/循环**，该条判据红 —— 见 `/tmp/mutation-evidence/M2.raw.log`。
 *   · S13 当时的记录 26 毫米/循环、`pace` 1.565~1.57 枚/循环：属**破对称 + 庚案前**，保留为历史读数，不再当出厂态用。
 *
 * 决策：**返值表继续不动**（第 4 轮的既定结论是「表不变、改判据口径」；本轮连判据也没改，只把口径写清）。
 * 若以后要按出厂态重新定标推进率，必须先在对称态拿满 `pace` 样本，而不是套用上面任何一个历史数。
 *
 *
 * 本轮改了推进率，所以按老规矩挂了 `ECON_RUNS=200` 的泵腿重标批（分段追加协议，
 * 协议版本 harness `67ce52e` 之后又加了 ⑤/⑥ 的新判据形态 ⇒ 段与段之间判据口径不同，
 * 但逐局行格式一致，池化比率/中位仍可比）。
 *
 * 池化 n=228 实测：**×1 每投回收 0.694**，落在第 2 轮**预先登记的预测区间 0.66~0.84 之内**；
 * 越线/投币 0.785，`E[单次越线筹码]`(实现口径) 0.939；局长 均值 63.3 / **中位 34**；
 * 触底(≤28 投) 60 局 = 26.3 %；timeout 14 局 = 6.1 %；逐种越线占比
 * **bronze 88.4 %** / payout 5.9 % / pattern 4.8 % / bounty 0.9 %。
 *
 * **结论：这张表一个数都不改。** 依据不是「偏移很小」，而是两条实测：
 *  1. ×1 回收 0.694 < 1 ⇒ 漂移为负 ⇒ 局**会**结束（④ 庄家优势判据守着这条）；
 *  2. 局长分布强右偏且右尾**已经贴到投币/仿真秒上限**（均值 63.3 而中位只有 34，
 *     timeout 已占 6.1 %）⇒ 返值表只能整体缩放回收，改不了回收随局长增长的形状，
 *     抬它等于把更多局推进「不结束」那一侧。
 *
 * ⚠️ 本轮一度想用「目标典型局 ⇒ 抬表 ×1.02~×1.07」来改这张表，并为此造过两套模型
 *   （确定性流量不动点、以及它的带负漂移高斯游走替代版）。**两套都被本批数据否证**：
 *   前者要求区间内存在稳定交点，实测 `r(L) − req(L)` 在 L=27…240 上全程为正，
 *   而 228 局里绝大多数仍以破产结束；后者模拟中位 72 / P(≤28)=7 %，实测 34 / 26.3 %。
 *   病因是每投增量并非对称噪声，而是「大量 −1 加上偶尔 +5/+25 的跳跃」
 *   （铜币占越线 88.4 % 却只以 0.09 的概率放行，钻石/宝箱是稀有大奖）。
 *   ⇒ **局长分布没有可用的闭式模型**；要改返值/赊账/分流中的任何一个，
 *     唯一可信的仪器是真实批上的 A/B 对照，而不是公式。
 *
 * ⇒ 本轮真正的产物是**判据口径**的改变（见 `scripts/verify-game.mjs` 的 ⑤/⑥ 注释）：
 *   ⑤ 从「任何一局 timeout 就红」改成「占比 ≤ 30 % 的率判据 + 账本那条原样保留」，
 *   「逃逸只在长尾」这类分布形状陈述**只打印不作判据**（实测最短的 timeout 局与中位只差 1 投）；
 *   ⑥ 把「设计目标 60~90 只看均值」改成均值 / 中位 / 触底占比 / timeout 占比四数一起读
 *   （#52 甲：60~90 的单位是「每 20 注额一段」而不是玩家的一局；批头会把这行单位打出来）
 *   —— 均值被长尾抬进带内而中位差一半，是本轮最容易读错的一件事。
 *
 * ★ 下一轮若要真的改「一局太短」这个观感，杠杆不在这张表里：
 *   要么改局长敏感性（那是另一次整批重标），要么让「局」这个概念本身消失（R6 6③ 去局感）
 *   —— 后者做完之后本节这些以「局长」为口径的读数会一起失去指称物。
 *
 * **改造推进率（推板行程 / 币床几何 / 币堆刚度）之后必须重标**：越线/投币是分子，
 * 而它又随局长变化，所以标定必须**解自洽平衡**，不能拿一个局长的读数当常数用。
 * ⚠️ 但「重标」不等于「改表」：第 4 轮把这条走完之后的结论恰恰是**返值不动**。
 *   先问「实测回收离打平有多远、右尾离上限有多近」，再决定要不要动那张表。
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
  debt: {
    id: 'debt',
    label: '催债币',
    // ★ Stage 2：`effect` 形态的第一个真用户 —— 越线**不返筹码**，反而按余额比例扣一笔
    //   （同一张 `fineRatio` 表，见 `xixi.ts`；扣减走 `RunState.settleFine` 那条唯一出口，
    //   所以三账本恒等式一个字不改）。它是**汇**不是源：不往盘面加币，`water` 为 0。
    //   深度到 `HAZARD_AFTER_DROPS` 之后按 `HAZARD_EVERY_DROPS` 注入，越深的局越凶。
    payout: { mode: 'effect', effect: 'debtCoin' },
    glyph: '债',
    // 红色是玩法里的"危险"色（与 `--danger` 同支），但它**不进 ClimaxTone**：
    // 那个枚举四处联动（styles.css 的规则 + keyframes + Hud 的 remove 名单），
    // 加一档要四处同改；催债币的"疼"由扣款文案与低音承载，不需要一次全屏闪。
    glow: { color: '#d0674a', intensity: 0.55 },
    lockedPalette: { base: '#7c3a2c', dark: '#38160f', ink: '#f2d9c8' },
    audioHz: 180,
    climax: null,
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
