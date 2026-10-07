/**
 * 波间候选（构筑奖励）的**数据表**（Stage 2a 落点，按 0d 立规放进新文件）。
 *
 * ## 这张表为什么长这样（一处对计划的修正，理由写在下面）
 *
 * 计划 2a 原写的 act 名单是 `spawn | impulse | multMark | transform | show | ticket`。
 * 逐条对过账之后，本轮只收**不往筹码账里加东西**的那几类，原因有两条：
 *
 * 1. **水量红线没有余量**。现档老虎机每投给 ≈ 0.017~0.044 枚免费币，红线是
 *    `FAUCET_BUDGET_PER_DROP = 0.04`（口径见 `xixi.ts` 那段唯一算式：单点比较没意义，
 *    要按源与汇的净差成对验证）。`spawn`（往盘面加真币）与 `ticket`（再加一条发券源）
 *    都是**汇不动**的那一类 —— 现在加一档，economy 的「回收率 < 1」就先红一次。
 * 2. **`multMark`（越线返值 ×1.25）看着 water: 0，其实是最贵的一档**：
 *    它乘在**所有**越线返值上，等于把整台机器的产出抬 25 %，
 *    而 water 这个字段只数"注入几枚币"，根本量不到它。
 *    ⇒ 一个不进池、但进账的杠杆，比一枚不进账的视觉币危险得多。
 *
 * 所以下面三档全是**换一种货币**的奖励：加力发数、机关次数、发券间隔。
 * 它们都不碰 `balance` 恒等式，也都不往盘面放币，因此 `water` 恒为 0 是**真话**而不是装饰。
 * ⚠️ 池子目前只有三档，而 `waves.ts` 的 `DRAFT_CHOICES` 也是 3 ⇒ 现在"三选一"= 全摆出来
 *   （只洗顺序）。这不是 bug，但**面板不该按三张硬编码**，将来池子>3 时才抽得出差异。
 * 将来要加 `spawn` / `multMark` 档，必须先回这里改这段理由，并且过 economy 的池水门。
 *
 * 表是纯数据：判据逐键读它（`snapshot.ts` 把 `draftCost` / 间隔等原样吐给脚本），
 * 编排与 DOM 在 `systems/CoinEffects.ts`。
 */

/** 奖励落到哪种货币上 —— 注意没有 'chip' 这一档，那是上面第 1、2 条的理由。 */
export type EffectAct = 'boost' | 'mechanism' | 'ticketInterval';

export type EffectId = 'boostPack' | 'mechanicCharge' | 'ticketLens';

export type EffectSpec = {
  id: EffectId;
  /** 铭牌与 HUD 归因文案同源（Stage 2d：触发计数 === 归因计数）。 */
  label: string;
  /** 铭牌上印一个字（与"币面不许印面值"同一条纪律：符号表身份，不写数值）。 */
  glyph: string;
  /** 一句话说明它改什么 —— 面板按钮的副标题，也是判据能读的文案真源。 */
  note: string;
  act: EffectAct;
  /**
   * 每次触发注入盘面的免费币（枚）。**本轮四档全为 0**，见文件头。
   * 这一项是池水门的加数：`Σ water × 触发率 ≤ 红线余量`。
   */
  water: number;
  /** 载荷：按 `act` 各自解释，判据按键读。 */
  payload: {
    /** `boost`：加几发加力（受 `RULES.boostStoreCap` 上限，装不下的部分如实返回）。 */
    strokes?: number;
    /** `mechanism`：给哪个机关加一次（'random' = 从当前可用的里按 RNG 挑一个）。 */
    mechanism?: 'sweeper' | 'grapple' | 'reload' | 'random';
    /** `ticketInterval`：发券间隔减多少（下限见 `TICKET_INTERVAL_FLOOR`）。 */
    step?: number;
  };
};

export const EFFECT_SPECS: Record<EffectId, EffectSpec> = {
  boostPack: {
    id: 'boostPack',
    label: '加力包',
    glyph: '力',
    note: '立刻 +2 发加长行程（存得满才算数）',
    act: 'boost',
    water: 0,
    payload: { strokes: 2 },
  },
  mechanicCharge: {
    id: 'mechanicCharge',
    label: '机关充能',
    glyph: '机',
    note: '随机一个机关 +1 次使用',
    act: 'mechanism',
    water: 0,
    payload: { mechanism: 'random' },
  },
  ticketLens: {
    id: 'ticketLens',
    label: '票孔',
    glyph: '孔',
    note: '越线发券的间隔 −2 枚（有下限，不能变成每枚都发）',
    act: 'ticketInterval',
    water: 0,
    payload: { step: 2 },
  },
};

/** 抽卡池：顺序即名单，判据按它互证（不让"抽得到谁"依赖随机顺序）。 */
export const EFFECT_POOL: EffectId[] = ['boostPack', 'mechanicCharge', 'ticketLens'];

/** 全表水量合计（枚/触发）——池水门的被加数。本轮恒为 0，且门在守这个 0。 */
export function totalWater(): number {
  return EFFECT_POOL.reduce((sum, id) => sum + EFFECT_SPECS[id].water, 0);
}

/* ── 挂在**币**上的效果（Stage 2a 的正题）────────────────────────────────────── */

/**
 * 币种效果表：`kinds.ts` 的 `payout: { mode: 'effect'; effect }` 指向这里。
 *
 * 与上面那张 `EFFECT_SPECS`（波间奖励）分开的理由：**换的是两种东西**。
 * 波间奖励换的是"另一种货币"（加力 / 机关 / 间隔），不碰盘面；
 * 币种效果挂在**一枚真实的币**上，越线那一刻结算，所以要过两道审：
 *   ① 它往盘面加不加币（加 = 进 `water`，要过池水门）；
 *   ② 它动账本的哪一边（进账 / 出账 —— 出账走 `RunState.settleFine` 那一条唯一扣减口）。
 *
 * ⚠️ 这一档**刻意不是** `spawn`：`debtCoin` 不往盘面放币，它是把"某枚已经存在的币"
 *   标成催债币后由**深度**注入的汇。计划 2b 说的"新效果默认走不进池通道"在这条上成立。
 */
export type CoinEffectId = 'debtCoin';

export type CoinEffectSpec = {
  id: CoinEffectId;
  label: string;
  /** HUD 归因文案（Stage 2d：触发计数 === 归因计数）。 */
  note: string;
  trigger: 'onCross';
  act: 'fine';
  /** 每次触发注入盘面的免费币（枚）。`debtCoin` 是 0 —— 它是汇，不是源。 */
  water: number;
};

export const COIN_EFFECT_SPECS: Record<CoinEffectId, CoinEffectSpec> = {
  debtCoin: {
    id: 'debtCoin',
    label: '催债币',
    note: '越线不返筹码，反而按余额比例扣一笔（与胡萝卜四连同一张表）',
    trigger: 'onCross',
    act: 'fine',
    water: 0,
  },
};

/** 全币种效果的水量合计（池水门读它，不抄数字）。 */
export function totalCoinEffectWater(): number {
  return (Object.keys(COIN_EFFECT_SPECS) as CoinEffectId[]).reduce(
    (sum, id) => sum + COIN_EFFECT_SPECS[id].water,
    0,
  );
}
