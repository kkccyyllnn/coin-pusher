import { TABLE, type CoinKind } from './constants';
import { ICON_IDS, type IconId } from './icons';

/**
 * XIXI 四槽集章（P5，替换三路集章）+ 背板老虎机的**规则真源**（P10）。
 *
 * 槽位：X · I · X · I 四段，覆盖 `drop.halfLane = 0.68` 的落点区间，每段 0.34 米。
 * **点亮 = 币落到币床那一刻的 x**（拍板项 #2：物理落点，不是投币口位置）——
 * 玩家靠投币口 + 时机去「瞄准」，收集线有技巧空间，不是无脑打卡。
 *
 * 这张表是纯函数，判据枚举调用它收成集合，不在测试里手写分段（纪律 2）。
 */

export type XixiSlot = 0 | 1 | 2 | 3;

export const XIXI_SLOTS = 4;
export const XIXI_GLYPHS = ['X', 'I', 'X', 'I'] as const;

/**
 * 四段的几何（**唯一真源**）。
 *
 * 分段这件事同时被两处需要：① 这里的 `xixiSlot()` 判落点归哪一槽；
 * ② 推板前缘的标牌（`Pusher.buildXixiLanes`）要按同样的分段摆四块板。
 *
 * ★ 以前两边各写一份 `halfLane / 2`——这正是 S7 排水口那个坑的同款形态
 * （几何位置在代码里写了两份，改一处不改另一处，两边各自自洽、画面静默错位）。
 * 现在从 `TABLE.drop.halfLane` 派生一次，两边都读它。
 */
export const XIXI_SEGMENT = {
  /** 落点区间半宽（±halfLane）。 */
  halfLane: TABLE.drop.halfLane,
  /** 单段宽度 = 半宽的一半；四段合计 = 2 × halfLane。 */
  width: TABLE.drop.halfLane / 2,
  /** 四段中心 x，按 `xixiSlot` 的分段推出（段 i 覆盖 [-halfLane + i·w, -halfLane + (i+1)·w)）。 */
  centers: [0, 1, 2, 3].map((slot) => -TABLE.drop.halfLane + (TABLE.drop.halfLane / 2) * (slot + 0.5)),
} as const;

/**
 * 落点 x → 槽位号。分段（边界归属与规划原文一致）：
 *   [-0.68,-0.34) = X₁(0)   [-0.34,0) = I₁(1)   [0,0.34) = X₂(2)   [0.34,0.68] = I₂(3)
 * 界外（|x| > halfLane）返回 -1——理论上落点不会越界（投币口有 clamp），显式兜底。
 */
export function xixiSlot(x: number): XixiSlot | -1 {
  const half = XIXI_SEGMENT.halfLane;
  const seg = XIXI_SEGMENT.width;
  if (x < -half || x > half) return -1;
  if (x < -seg) return 0;
  if (x < 0) return 1;
  if (x < seg) return 2;
  return 3;
}

// ── 符号表 ────────────────────────────────────────────────────────────────

/**
 * 老虎机的 5 个奖励符号。
 *
 * **符号的五个面在这里一次配齐**（P10 起）：汉字字形（HUD 文案）、可读名（文案）、
 * 像素图标（滚筒 / 标牌）、识别色（结果灯条）、注入币种（奖励交付）。
 * 以前这些散在 `xixi.ts` 与 `SlotMachine.ts` 两处，加一个符号要改两个文件——
 * 那正是「新增币种要动 5 处」的同款病，趁这次收掉。
 */
export type SlotSymbol = 'tower' | 'fountain' | 'boost' | 'diamond' | 'chest';

export const SLOT_SYMBOLS: readonly SlotSymbol[] = ['boost', 'tower', 'fountain', 'diamond', 'chest'];

/** 汉字字形（HUD 文案用；滚筒上画的是像素图标，不是汉字）。 */
export const SLOT_SYMBOL_GLYPHS: Record<SlotSymbol, string> = {
  tower: '塔',
  fountain: '泉',
  boost: '力',
  diamond: '钻',
  chest: '箱',
};

/** 中奖文案用的奖励名（滚筒符号之外的玩家可读说法）。 */
export const SLOT_SYMBOL_LABELS: Record<SlotSymbol, string> = {
  tower: '圆柱币塔',
  fountain: '喷泉',
  boost: '加力',
  diamond: '钻石筹码',
  chest: '宝箱',
};

/**
 * 符号 → 像素图标（**P10 的映射表，用户指定**）。
 *
 * 图标名用图形本身（`cross` / `cucumber` / `peach` …）而不是符号名，
 * 因为「哪个图形对应哪个奖励」是玩法决策、会随拍板变；图形叫什么不会变。
 * 这条映射就是两层之间唯一的桥，改对应关系只改这里。
 */
export const SLOT_SYMBOL_ICONS: Record<SlotSymbol, IconId> = {
  boost: 'cross', // 叉 → 力
  fountain: 'cucumber', // 黄瓜 → 泉
  tower: 'peach', // 桃 → 塔
  diamond: 'diamond', // 钻石 → 钻
  chest: 'chest', // 宝箱 → 箱
};

/**
 * 结果灯条的识别色。
 *
 * 钻 / 箱取 `KINDS.diamond.glow` / `KINDS.chest.glow` 的值——让滚筒的灯色
 * 与币面自发光是**同一套识别色**（玩家认的是颜色，不是名字）。
 */
export const SLOT_SYMBOL_COLORS: Record<SlotSymbol, string> = {
  tower: '#3fd2c0',
  fountain: '#d8b25c',
  boost: '#ff7043',
  diamond: '#8fe3ff',
  chest: '#ffb347',
};

/** 符号 → 注入币种。未列出的符号（塔 / 泉 / 加力）走演出默认的铜币。 */
export const SLOT_SYMBOL_KIND: Partial<Record<SlotSymbol, CoinKind>> = {
  // 钻 / 箱本身就是币种：奖励交付的是**这种币**，玩家还得把它推过得分线才算兑现
  // （决策 9：结算只由币是否越线决定）。塔 / 泉 / 加力不是币种，走默认铜币。
  diamond: 'diamond',
  chest: 'chest',
};

/** 惩罚符号的图标（胡萝卜）与灯色。 */
export const SLOT_FINE_ICON: IconId = 'carrot';
export const SLOT_FINE_COLOR = '#ff4d4d';
/** 杂牌（未中奖）的灯色：刻意是**低饱和的灰**，与中奖的饱和色一眼分得开。 */
export const SLOT_MISS_COLOR = '#5b6472';

// ── 滚筒停格 ──────────────────────────────────────────────────────────────

/**
 * 环带上图标的排列顺序 = 图集从左到右的顺序。
 *
 * 停格位置由它决定（`reelStripIndex`），所以**改图集顺序会改变停格动画的观感**，
 * 但不改变任何概率——概率只由下面的结果表决定。
 */
export const REEL_STRIP: readonly IconId[] = ICON_IDS;

export function reelStripIndex(icon: IconId): number {
  const index = REEL_STRIP.indexOf(icon);
  if (index < 0) throw new Error(`图标 ${icon} 不在环带里`);
  return index;
}

// ── 结果表（P10） ────────────────────────────────────────────────────────

/**
 * 一次摇奖的结果。
 *
 * ## 三分类 → 四分段（S5a）
 *
 * 用户拍板过的是**三分类**（中奖 / 胡萝卜惩罚 / 杂牌），S5a 没有推翻它，
 * 只是把「中奖」那一格在 **`roll` 轴上再切一刀**分成 3 同与 4 同（路线 A）：
 * 老虎机仍然**精确吃 2 个 rng 值**（一次定分类、一次定内部细节），
 * 所以逐事件对账、既有夹具与所有历史经济数据全部保持可比。
 * 代价 = 4 同的图案由 `detailRoll` 在**四同池**里摇，池子比五符号小（见 `SLOT_TIER4_SYMBOLS`）。
 *
 * - `win3` 中奖三同：现在的奖励档（加力 / 演出，规模照旧）。
 * - `win4` **四同大奖**：改变命运的那一摇，每个符号有自己的演出（见 `SlotMachine` 的奖励表）。
 * - `fine` 胡萝卜四连：扣到 0 为止，扣不掉的转欠款（S5b）。
 * - `miss` 杂牌：四格两两不同，不奖不罚。
 *
 * ## ★ 为什么权重是 43.5 / 1.5 / 15 / 40 而不是草稿建议的 20 / 1.5 / 3 / 65
 *
 * 计划里那组「起步建议」把中奖率从 45 % 砍到 21.5 %、胡萝卜从 15 % 砍到 3.4 %，
 * 但它自己写在同一页上的**效果**是「+0.09~0.13 筹码/投，×1 回收 0.741 → ≈0.83（不点火）」
 * —— 那个数只算了「新增一档大奖」，**没有算把原有中奖率砍掉一半半**。
 * 两头一对质就露馅：照抄那组数会把回收率**往下**推，而用户 09-30 点的是「大奖与惩罚**加强**」。
 * ⇒ 这里只动一件事：从中奖率里切出 1.5 % 给 4 同（稀有度按建议），
 *   中奖总量与胡萝卜频率**一个都不动**，于是
 *   ① 效果与计划写的那个期望一致；② S6 重标只需在这张表上做一次微调，不必整表重标。
 *   ⚠️ 稀有度换算：4 同 = 1.5 % 的摇奖，而摇奖约 0.046 次/投 ⇒ **约每 1 450 投一次**
 *   （典型局 74 投 ⇒ 平均 20 局才见一次）。这是「望不到头」的原意，不是 bug。
 */
export type SlotTier = 3 | 4;

export type SlotOutcome =
  | { kind: 'win'; symbol: SlotSymbol; tier: SlotTier }
  | { kind: 'fine' }
  | { kind: 'miss' };

/**
 * 结果权重表。**是权重不是百分数**（`outcomeTotalWeight()` 归一化），
 * 所以加一档不用凑 100；判据读的是这张表本身（`slotOdds` 钩子把它吐出去）。
 */
export const SLOT_OUTCOME_WEIGHTS = { win3: 43.5, win4: 1.5, fine: 15, miss: 40 } as const;

/** 权重表的全部键（判据按它开计数桶 —— 加一档时测试不用改第二处）。 */
export const SLOT_OUTCOME_KEYS = Object.keys(SLOT_OUTCOME_WEIGHTS) as (keyof typeof SLOT_OUTCOME_WEIGHTS)[];

/** 对权重求和：`Object.values` 一次算完，**加一档不需要在这里补一项**（S5a 的教训写在上面）。 */
export function outcomeTotalWeight(): number {
  return Object.values(SLOT_OUTCOME_WEIGHTS).reduce((sum, weight) => sum + weight, 0);
}

/**
 * 一个结果落在权重表的哪一格。**判据用它给枚举计数归桶**，
 * 这样「分段」这件事在代码里只有一份（这里），测试不会写出第二份分段逻辑。
 */
export function outcomeWeightKey(outcome: SlotOutcome): string {
  if (outcome.kind !== 'win') return outcome.kind;
  return outcome.tier === 4 ? 'win4' : 'win3';
}

/**
 * 中奖符号的权重（S11 第 1 轮放大后的值）。
 *
 * ## 为什么「力」占大头，而不是五个符号均分
 *
 * 免费币预算是硬红线（见下面的 `FAUCET_BUDGET_PER_DROP`）：**只有「加力」不往盘面加质量**（它给的是行程，不是币）。
 * ⚠️ 旧写法把「钻石」也算进"不加质量"，那是脱钩：`SHOW_SPECS.diamond.count = 1`，
 *   钻石是**一枚真币**（固定 25 筹码面值，见 `ShowDirector.ts` 的 diamond 注释），要玩家把它推过得分线才兑现 ⇒ 它进水量账。
 *   塔 / 泉 / 箱 / 钻 每发一枚都直接抬高回收率，差别只在规模（塔 16→40、泉 10、钻 1、箱 1 + 一圈**视觉币**）。
 * 不往盘面加质量**，塔 / 泉 / 箱 每发一枚都直接抬高回收率。
 * 45% 的中奖率 × 均分 × 阵型规模（塔 16 枚）会算出约 **3 枚/投**的水量——
 * 是红线的 **75 倍**，盘面会瞬间肥到局不终局（§5.7 的「点火」）。
 *
 * ## 水量算式的口径（★ 这里以前算错过一次）
 *
 * `rollWinSymbol()` 是在**符号权重内部**归一化的（合计 = 45/54），
 * 而 `rollSlotOutcome()` 已经把 45% 的中奖率抽过了。所以
 *
 *     每摇奖期望水量 = Σ P(符号) × 枚数 = Σ (中奖率 × 权重/权重合计) × 枚数
 *
 * 展开就是 `0.45 × (6/45) × 16` —— **`0.45` 与分母 `45` 恰好约掉**，
 * 结果等于 `0.06 × 16`。以前的注释写成 `0.45 × (0.06 × 16 + …)`，
 * 把中奖率**乘了两次**，于是水量被系统性低估。⚠️ 这里原先补的一句「实际约 0.15 枚/投」**同样没有真源**：
 *   本文件下方那份唯一算式（箱按 `count = 1`）乘上分段摇/投 0.00598~0.01533，得到的是 **0.017~0.043 枚/投**，
 *   0.15 要成立得假设一个高得多的频率或每摇水量 ⇒ 已作废为「待测」，等 ① `delivered`（实发枚数）与 ② `granted===false`
 *   占比两数到手再定档。**定档前不要引用 0.068 也不要引用 0.15。**
 * 这个低估直接导致 S10 给「加力存满」加了个 3 枚的兜底演出时，
 * 没人预料到它本身就是一条可观的源（+0.78 枚/摇奖）。
 *
 * 现档（符号权重取自本文件 `SLOT_SYMBOL_WEIGHTS`＝力 26/钻 7/塔 20/泉 11/箱 6，合计 70；
 *   枚数取自 `SHOW_SPECS`：塔 16、泉 10、**箱 1**（`chest.count` 早先是 8，`kinds.ts` 第 268 行记的『8 → 1』就是它）：
 *   塔 0.45×20/70×16 = 2.057 · 泉 0.45×11/70×10 = 0.707 · 箱 0.45×6/70×**1** = **0.039**
 *   → **约 2.80 枚/摇奖**（旧写法按箱 8 枚算成 3.073，把这条源高估了 ~10 %）。
 *
 * ★ 这段是**全项目唯一的一份水量算式**（`ShowDirector.ts` 与 `FAUCET_BUDGET_PER_DROP` 那两处已降级成指向这里的指针）。
 *   要改成『每投』口径得乘摇/投频率，而摇/投是**分段实测**、段间差 2.56 倍：
 *     · 段1 = 0.01533 ⇒ ≈ 0.043 枚/投；· 段2 = 0.00598 ⇒ ≈ 0.017 枚/投；红线 `FAUCET_BUDGET_PER_DROP = 0.04`。
 *   ⇒ 结论只能写成**区间 [0.42, 1.07] × 红线**（跨线），不能写成任何单点；再加力存满兜底（gate 3 枚，另一条源）会把它推得更高。
 *   ⚠️ 尚未测的两项会让区间收窄或改向：① `xixiEvents.reward.delivered`（实发枚数，名义只是上界）
 *     ② `granted === false` 的占比（定兜底频率）。accept 场景当前 0 样本 ⇒ 补齐前**别照任何点值定档**。
 *
 * ## 逐轮实测（`ECON_RUNS=6`，见 PLAN-v4 §10.7 的 S11 表）
 *
 * | 轮 | 水量 | ×1 回收 | 各局投币 | 均值 | 极差 |
 * |---|---|---|---|---|---|
 * | 初值 | 1.52 | 0.608 / 0.625 | 34/42/58/42/58/54 | 48.0 | 24~58 |
 * | 物理改动前 | 2.012 | 0.688 / 0.708 | 35/60/34/154/47/39 | 61.5 | 34~154 |
 * | 物理改动前（同档另一样本） | 2.012 | 0.579 | 34/36/75/69/39/16 | 44.8 | **16~75** |
 * | 试档 | 2.340 | 0.731 / 0.913 | 51/145/171/48/39/236 | 115.0 | 39~236 |
 * | **物理改动后（基准）** | 2.012 | **0.533** | 34/38/38/35/52/49 | 41.0 | **35~52** |
 * | 本轮 | 3.073 | 待测 | — | — | — |
 *
 * ## ★★ 关键发现一：6 局样本分辨不了档位
 *
 * 同一组常量（水量 2.34）的两次采样给出 **0.731 与 0.913**；
 * 更高水量的 2.569 档两次都是 0.781 / 0.789 —— **读数与水量不单调**，
 * 说明噪声（±0.1）盖过了档位差异。规划自己写过「定案必须靠 `ECON_RUNS=200`」。
 * **用 6 局去追 ±0.03 的目标值是自欺。**
 *
 * ## ★★ 关键发现二：噪声的**来源**是币的物理，不是水源
 *
 * 用户的手感反馈（「硬币物理太灵敏、弹性过强」）指对了地方。
 * 把 `COIN.friction` 0.3→0.5、台面 0.32→0.45、阻尼抬起来之后：
 *
 *   `pace` 推进率 **1.565 → 1.087 枚/循环**（−30%）
 *   单局长度极差 **16~216 → 35~52**（186 投 → **17 投**）
 *
 * 低摩擦下币床在推板行程里**整体打滑**（推过去滑、退回来又滑回去），
 * 所以「同一个行程真正送过得分线的枚数」方差极大 —— 那才是雪球局与塌陷局的成因。
 * **水源只是把噪声放大，不是噪声源。** 修物理比调水源根本得多。
 *
 * ⚠️ 代价是出货变少：同水量下 ×1 回收从 0.688 掉到 0.533，均值 61.5 → 41.0。
 * 所以物理改动之后**必须把水源补回来**（本轮就是在做这件事）。
 *
 * 这仍然高于红线 0.04（按「源与汇的净差」口径）——**余量是靠 P10 新增的流失口买回来的**
 * （两侧排水槽 + 得分线两端下水道）。源与汇必须成对验证：单看任何一边都会误判。
 * 放大这些权重之前，先读 `DRAIN` 与 `economy` 模式的实测读数。
 */
export const SLOT_SYMBOL_WEIGHTS: ReadonlyArray<{ symbol: SlotSymbol; weight: number }> = [
  { symbol: 'boost', weight: 26 },
  { symbol: 'diamond', weight: 7 },
  { symbol: 'tower', weight: 20 },
  { symbol: 'fountain', weight: 11 },
  { symbol: 'chest', weight: 6 },
];

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * 摇一个中奖符号。`roll ∈ [0,1)`，走游戏 RNG（可复现）。
 */
export function rollWinSymbol(roll: number): SlotSymbol {
  const total = SLOT_SYMBOL_WEIGHTS.reduce((sum, entry) => sum + entry.weight, 0);
  let accumulated = 0;
  for (const entry of SLOT_SYMBOL_WEIGHTS) {
    accumulated += entry.weight;
    if (clamp01(roll) * total < accumulated) return entry.symbol;
  }
  return SLOT_SYMBOL_WEIGHTS[SLOT_SYMBOL_WEIGHTS.length - 1].symbol;
}

/**
 * 有「四同大奖演出」的符号池（S5a）。
 *
 * ★ **泉不在池里**，这不是漏写：计划的四同表只给了力/塔/钻/箱四个效果，
 *   泉没有第四档的画法。若让泉也进池，它摇到四同时只能回落去演三同那一档 ——
 *   那正是本项目最讨厌的「承诺了但没发生」的形状（`miss` 落进 `win` 分支同一类错）。
 *   所以 4 同从这四个里摇，泉只有 3 同。
 */
export const SLOT_TIER4_SYMBOLS: readonly SlotSymbol[] = ['boost', 'tower', 'diamond', 'chest'];

/** 四同池内**等权**（不加第三张表）：稀有度由 `win4` 那一档整体控制，符号内部不再分层。 */
export function rollWinTier4Symbol(roll: number): SlotSymbol {
  const index = Math.floor(clamp01(roll) * SLOT_TIER4_SYMBOLS.length);
  return SLOT_TIER4_SYMBOLS[Math.min(SLOT_TIER4_SYMBOLS.length - 1, index)];
}

/**
 * 摇一次奖：先定**结果分类**，再定分类内部的细节。
 *
 * 街机老虎机的标准做法——**先定结果、再演停格**。`roll` 决定落在权重表的哪一格，
 * `detailRoll` 决定「中奖摇哪个符号」或「杂牌停哪四格」（两者互斥，所以一个够用）。
 *
 * ★ S5a 把中奖格在 `roll` 轴上切成 3同/4同两段（路线 A）⇒ **rng 消耗次数一个字没改**，
 *   同一种子跑出来的序列与切档之前逐摇可比；变的只是每段占多宽。
 */
export function rollSlotOutcome(roll: number, detailRoll: number): SlotOutcome {
  const { win3, win4, fine } = SLOT_OUTCOME_WEIGHTS;
  const value = clamp01(roll) * outcomeTotalWeight();
  if (value < win3) {
    return { kind: 'win', tier: 3, symbol: rollWinSymbol(detailRoll) };
  }
  if (value < win3 + win4) {
    return { kind: 'win', tier: 4, symbol: rollWinTier4Symbol(detailRoll) };
  }
  if (value < win3 + win4 + fine) {
    return { kind: 'fine' };
  }
  return { kind: 'miss' };
}

/** 非惩罚图标的池子（杂牌从这里抽，避免与「胡萝卜四连」混淆）。 */
const MISS_POOL: readonly IconId[] = ICON_IDS.filter((id) => id !== SLOT_FINE_ICON);

/**
 * 停格画面：四个滚筒各显示哪个图标。
 *
 * - `win`：四个都是该符号的图标（**四连**）。
 * - `fine`：四个都是胡萝卜。
 * - `miss`：从**非胡萝卜**的 5 个里去掉一个（5 种）再旋转（5 种）= 25 种组合，
 *   且四格**两两不同**——「没凑齐」这件事必须在画面上自证，
 *   否则玩家会把杂牌误读成「差一点中奖」。
 */
export function reelFacesFor(outcome: SlotOutcome, detailRoll: number): IconId[] {
  if (outcome.kind === 'win') {
    const icon = SLOT_SYMBOL_ICONS[outcome.symbol];
    return [icon, icon, icon, icon];
  }
  if (outcome.kind === 'fine') {
    return [SLOT_FINE_ICON, SLOT_FINE_ICON, SLOT_FINE_ICON, SLOT_FINE_ICON];
  }

  const slots = MISS_POOL.length * MISS_POOL.length; // 5 × 5 = 25
  const n = Math.min(slots - 1, Math.floor(clamp01(detailRoll) * slots));
  const skip = n % MISS_POOL.length;
  const rotation = Math.floor(n / MISS_POOL.length);
  const picked = MISS_POOL.filter((_, index) => index !== skip);
  return picked.map((_, index) => picked[(index + rotation) % picked.length]);
}

/**
 * 惩罚：摇出胡萝卜四连时**扣本局筹码**的固定值（用户拍板：扣本局余额，不扣钱包）。
 *
 * - **不吃任何倍率**（不加注 / 不热度 / 不热区），与 payout / bounty 同规则。
 * - 扣到 0 为止：归零后由既有的沉降分支接管（`RunState.enterRuinSettle`），
 *   **不新开破产路径**。
 * - 走 `RunState.spendChips`（唯一的扣减入口），所以三账本恒等式一个字不改。
 *
 * 取 6 的推导：XIXI 约 11 投集齐一次，每次摇奖 15% 是惩罚 →
 * 约 **0.014 次/投**，一局 50~80 投约 **0.7~1.1 次**。6 枚 ≈ 一次买入（20 枚）的 30%，
 * 一次就疼、但不至于直接判死。**这个数随 §10.5 的标定一起复测。**
 */
export const SLOT_PENALTY_CHIPS = 6;

/**
 * 每投允许的免费币预算（枚/投）——**这是被实测钉出来的红线**，不是拍脑袋。
 *
 * 推导：排水后的盘面回收率就到 ~0.85 筹码/投（见 economy 模式里那段「第 2 局回收率更高」的
 * 注释），庄家优势只剩 ~0.15；而每个免费币经越线约换回 1.3 筹码。
 * 所以免费币超过 ~0.11 枚/投就会把回收率顶过 1 → 局不终局（点火）。
 * 留一倍余量取 **0.04**。
 *
 * ⚠️ **P10 起现档水量已经在红线量级上**（口径见本文件 `SLOT_SYMBOL_WEIGHTS` 那段唯一算式：
 *   按分段摇/投得 ≈ 0.017~0.043 枚/投，红线 0.04 落在区间内 ⇒ **单点比较没有意义**，要按源与汇的净差成对验证）。
 * 红线本身没有失效，是**新增了汇**（`DRAIN` 的两侧排水槽 + 得分线两端下水道）来买回余量。
 * 所以这条常量现在的正确用法是「**源与汇的净差**要落在这条线以下」，
 * 而不是「源单独不许超线」——判据仍然是 `economy` 的回收率 < 1 与「局必须终局」。
 */
export const FAUCET_BUDGET_PER_DROP = 0.04;
