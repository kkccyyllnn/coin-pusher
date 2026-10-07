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
 * 把中奖率**乘了两次**，于是水量被系统性低估。
 *
 * ## ① 已结清：名义 = 实发（10-04 探针 `/tmp/reward-delivered-probe.mjs`）
 *
 * `SlotMachine.applyReward` 把 `result.promised` 记进 `reward.delivered`，所以「实发」只能从
 * 演出侧的 `completed` 事件取 `spawned`。压着盘面摇（activeCoins 382 / 480，两臂各 3 轮）
 * 累计 **Σpromised 246 = Σspawned 246，降级 0、拒收 0** ⇒ `delivered` 目前读到的就是实发数。
 * 这不是运气，是结构：`COIN.budget = 700`，而单次承诺的最大值是塔四同 40 枚 ⇒
 * `coins.remaining` 要掉到 40 以下才会降级，可达盘面（bed ~330 + 牌面 ~150）够不着。
 * ⚠️ **交付本身有判据在守，但守的不是这个字段名**：`xixi` 逐符号断
 *   `completed.spawned === 表上枚数`（钻石那条就在断"实发 1 枚真钻石币"），`show` 模式断 gate/塔的
 *   `spawned === promised`。这些抓得住"少发/发错币种"。
 *   而 `reward.delivered` 与最终 `spawned` 相等**没有任何断言**——它今天成立只是因为走不到降级线。
 *   更阴的一面：还有一排 `reward.delivered === spec.count` 的判据，而 spec 就是**承诺数**，
 *   所以将来收紧 budget 或放大某档造成降级时，**那排判据照样绿**，只有字段在悄悄说谎。
 *   ⇒ 要改 `delivered` 的语义（或改名 `promised`）就得连那排判据一起过一遍，别只改一处。
 *
 * ## 现档算式（S5a 之后必须分两档算，旧写法把四同漏了）
 *
 * 三同从**五个符号**按权重摇（力 26 / 塔 20 / 泉 11 / 钻 7 / 箱 6，合计 70），
 * 四同从**四个符号等权**摇（`SLOT_TIER4_SYMBOLS`＝力/塔/钻/箱，**泉没有第四档**）：
 *
 * | 符号 | 三同枚数 | 四同枚数 | 四同多给的东西 |
 * |---|---|---|---|
 * | 塔 | 16 | **40** | 唯一加码的一档（10 层巨塔） |
 * | 泉 | 10 | —（不在四同池） | 没有第四档 |
 * | 钻 | 1 | 1 | 只换蓝闪与更长的时间轴 |
 * | 箱 | 1 | 1 | 一圈**视觉币**（不进池、不进账） |
 * | 力 | +1 次加力（已满则改派 gate 3 枚） | 4 发加长行程 | 行程而不是币 |
 *
 *     E(三同) = (20×16 + 11×10 + 7×1 + 6×1)/70        = 6.329 枚/中奖
 *     E(四同) = (40 + 1 + 1 + 0)/4                    = 10.500 枚/中奖
 *     名义水量 = 0.435×6.329 + 0.015×10.500           = **2.911 枚/摇奖**
 *
 * ⇒ **旧注释那个「约 2.80」偏低了 ~4 %**，两处漏项都能指名：
 *   ① 少算了钻石项（0.45×7/70×1 = +0.045）；② 完全没算四同加码（0.015×(10.5−6.329) = +0.063）。
 *   按箱=8 枚的 3.073 也同时作废（`chest.count` 早先就是 8，S16 降到 1）。
 *
 * ## ② 仍未结清：加力存满的兜底是**多大一条源**
 *
 *     兜底水量 = P(三同且摇到力) × P(加力已满) × 3 = 0.1616 × 3 × P(已满) = **0.485 × P(已满) 枚/摇奖**
 *
 * 「从不花加力」的强制摇奖臂实测 P(已满)≈2/3（n=3，太薄，不给点值），上界就是 0.485。
 * 旧写法给的「+0.78 枚/摇奖」用的是 45 分母那版符号权重（0.45×26/45×3），随权重表一起过期。
 * ⇒ 这一项**要按真实打法测**（花 / 不花加力是玩家行为，不是引擎常数），别拿强制摇奖的数定档。
 *
 * ★ 这段是**全项目唯一的一份水量算式**（`ShowDirector.ts` 与 `FAUCET_BUDGET_PER_DROP` 那两处已降级成指向这里的指针）。
 *   要改成『每投』口径得乘摇/投频率，而摇/投是**分段实测**、段间差 2.56 倍：
 *     · 段1 = 0.01533 ⇒ 2.911 × 0.01533 = **0.0446 枚/投**；· 段2 = 0.00598 ⇒ **0.0174 枚/投**；
 *       红线 `FAUCET_BUDGET_PER_DROP = 0.04` ⇒ 名义区间 **[0.43, 1.12] × 红线，上段已经压线**。
 *   ② 那条源若按上界再叠 0.485，上段升到 **0.052**（1.3 × 红线）。
 *   ⇒ 结论只能写成**区间**，不能写成任何单点；放大任何一档之前先看这段。
 *   〔10-04 更正〕这一段原先点名"尚未测的两项"，其中 ①（实发枚数）**已结清**＝名义（见上面「① 已结清」），
 *   只剩 ②（P(加力已满)）要按真实打法测——accept 场景 0 样本，所以**别照任何点值定档**这句话仍然成立。
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
 * 三同的「差一格」该显示哪枚图标：取**环带上与目标相邻**的另一枚奖励图标。
 *
 * 相邻（而不是随便挑一枚）才是经典 near-miss：滚筒停在与四连只差一格的位置，
 * 玩家眼睛看到的是「差一点」，而不是「另一个东西」。
 * 胡萝卜要跳过——「差一格」不能长成惩罚的样子，那是另一种误读。
 * 两侧都是胡萝卜的情形在这里不存在（环带 6 格、胡萝卜只占 1 格），但仍然兜底成
 * 池内第一枚非自身、非胡萝卜的图标，免得将来加图标时踩空。
 */
function nearMissDecoy(icon: IconId, detailRoll: number): IconId {
  const length = REEL_STRIP.length;
  const at = reelStripIndex(icon);
  const both = [REEL_STRIP[(at + 1) % length], REEL_STRIP[(at + length - 1) % length]].filter(
    (candidate) => candidate !== SLOT_FINE_ICON,
  );
  if (both.length === 0) return MISS_POOL.find((candidate) => candidate !== icon) ?? icon;
  // 两侧都合法时按 detailRoll 的另一位挑方向，让「每次差的不是同一格」看起来自然。
  // ⚠️ 只有一侧合法（另一侧是胡萝卜：箱、钻就是这样）时**只能用那一侧**——
  //   上一版无条件取 both[1]，箱/钻就摇出 undefined，滚筒上出现一个**空格子**（自己写的核对脚本抓的）。
  const useCounter = both.length === 2 && Math.floor(clamp01(detailRoll) * 16) % 2 === 1;
  return useCounter ? both[1] : both[0];
}

/**
 * 停格画面：四个滚筒各显示哪个图标。
 *
 * - `win` 四同（tier 4）：四个都是该符号的图标（**四连**）。
 * - `win` 三同（tier 3）：三格同 + 一格是**环带上相邻**的另一枚奖励图标（差一格）。
 * - `fine`：四个都是胡萝卜。
 * - `miss`：从**非胡萝卜**的 5 个里去掉一个（5 种）再旋转（5 种）= 25 种组合，
 *   且四格**两两不同**——「没凑齐」这件事必须在画面上自证，
 *   否则玩家会把杂牌误读成「差一点中奖」。
 *
 * ## ★ 为什么三同要画成「差一格」（10-05，用户拍板方向乙）
 *
 * 改之前 `win` 不分档都回四连 ⇒ **45 % 的三同与 1.5 % 的四同在滚筒上像素相同**，
 * 大奖因此没有"长相"：玩家摇到四同时看到的画面，和最常见的中奖一模一样。
 * 这条是实测出来的，不是推测——`xixi` 模式那条「停格画面自证：win/fine 四连」判据
 * 当时正把"所有 win 都是四连"当规格守着。
 *
 * ⇒ 画面诚实性按结果分三档：杂牌两两不同（它**不是**差一格）、三同差一格（它**真的**只差一格）、
 *   四同四连。奖池、权重、rng 消耗、每档发几枚**一个字都没动**（结果在 `rollSlotOutcome`
 *   里已经定了，这里只决定"怎么演"），所以经济读数全部保持可比。
 */
export function reelFacesFor(outcome: SlotOutcome, detailRoll: number): IconId[] {
  if (outcome.kind === 'win') {
    const icon = SLOT_SYMBOL_ICONS[outcome.symbol];
    if (outcome.tier === 4) return [icon, icon, icon, icon];
    const faces: IconId[] = [icon, icon, icon, icon];
    faces[Math.min(3, Math.floor(clamp01(detailRoll) * 4))] = nearMissDecoy(icon, detailRoll);
    return faces;
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
 * 惩罚：摇出胡萝卜四连时**按余额比例**扣本局筹码（10-07 用户拍板：比例制，10%→40%）。
 *
 * ## 为什么从固定 6 枚改成比例
 *
 * 固定值在 S4 合并账户之后**失去了参照系**：合并之前 6 枚 ≈ 一次买入（20 枚）的 30%，
 * 读作「一次就疼」；合并之后余额就是全部身家（harness 的标准注额 200），6 枚只剩 **3%**
 * —— 同一笔罚款从"疼一下"退化成"没感觉"，而它承担的职责（把长期斜率拉回负）随之失效。
 * 比例制把参照系换成**玩家当下有多少**：一次四连扣掉余额的 10%~40%，
 * 一整局的期望扣款因此稳定在"四分之一身家"这个量级上，不随注额大小失真。
 *
 * ## ★ 一个必须点名的结构后果：`shortfall` 恒为 0（10-07 用户拍板 A）
 *
 * 上限是 40% ⇒ `amount ≤ 0.4 × 余额 < 余额` ⇒ `RunState.fineChips` 的 clamp **永远碰不到**
 * ⇒ 返回的 `shortfall` 恒为 0 ⇒ `SaveStore.chargeFine`（罚款转欠款那条腿，S5b 建的）
 * 在**正常玩法里不可达**，只剩"安全网"身份（比例上限万一被调到 > 100% 时才承重）。
 * 旧基线「罚金实扣 ≈ 名义 28%」正是被 0 余额 clamp 打出来的 ⇒ 比例制之后它作废，
 * 新事实是**实扣 ≡ 名义（100%）**、罚款产生的 debt ≡ 0。
 * 判据因此不再"构造一个低余额场景去等 shortfall"，而是：
 * ① 逐事件恒等 `applied === requested` 且 `debtAdded === 0`（这条就是"永不转债"的守卫）；
 * ② clamp / 欠款上限那套机器改由**合成输入**直接驱动（`testHooks.applyFine`），
 *   因为它已经不可能从玩法里到达 —— 留着不测等于把承重结构当死代码。
 *
 * ## 事件率（沿用旧推导，它没变）与量级
 *
 * XIXI 约 11 投集齐一次，每次摇奖 15% 是惩罚 → 约 **0.014 次/投**，一局 50~80 投约
 * **0.7~1.1 次** ⇒ 一整局的期望扣款 ≈ 1 次 × 中段比例（约 25%）≈ **余额的四分之一**。
 * 这个量级是**刻意的**（负 EV 降为软约束之后，长期斜率就靠这类事件拉回来），不是标定残差。
 *
 * - **不吃任何倍率**（不加注 / 不热度 / 不热区），与 payout / bounty 同规则。
 * - **一次罚款不可能把余额打到 0**（上限 40%）⇒ 它不直接判死，只是把沉降提前；
 *   归零仍然只由既有的沉降分支接管（`RunState.enterRuinSettle`），**不新开破产路径**。
 * - 走 `RunState.spendChips`（唯一的扣减入口），所以三账本恒等式一个字不改。
 */
export const FINE_RATIO_FLOOR = 0.1;
export const FINE_RATIO_CEIL = 0.4;

/**
 * 罚款深度：多少投把比例从下限拉满到上限。
 *
 * 取 90 = 实测局长中位数（S6 标定终稿：中位 93 投），也与设计目标「一条命 60~90 投」的
 * 上沿重合 ⇒ **打到底**的一局正好走完整条坡，中途破产的人停在坡上对应的位置。
 */
export const FINE_RAMP_DROPS = 90;

/**
 * 进度 → 罚款比例。`progress` 是**归一化**深度（0 = 开局、1 = 已到封顶深度，越界会被夹）。
 *
 * ★ 参数刻意是"进度"而不是"波次"或"投数"：进度怎么算由调用方决定，于是这张 10%→40% 的表
 * **永远只有一份**。1a 的调用方用投数（`drops / FINE_RAMP_DROPS`）；波次系统落地后改成波次
 * —— 换的是调用方那一行，不是这张表（否则又是"同一算式抄多处"）。
 */
export function fineRatio(progress: number): number {
  const t = clamp01(progress);
  return FINE_RATIO_FLOOR + (FINE_RATIO_CEIL - FINE_RATIO_FLOOR) * t;
}

/**
 * 罚款额（筹码）= 余额 × 当前比例，四舍五入到整数筹码。
 *
 * 负余额按 0 处理：欠着钱的人不该被罚出**负数**（那会变成入账）。
 * 余额为 0 时返回 0 ⇒ 结算那边会走「一分罚不出」的文案分支，而不是凭空造一笔欠款。
 */
export function fineAmount(balance: number, progress: number): number {
  return Math.round(Math.max(0, balance) * fineRatio(progress));
}

/** 一次罚款的报价：金额，**外加算它时用的两个输入**。 */
export type FineQuote = { amount: number; balance: number; progress: number };

/**
 * 余额 + 进度 → 一次罚款的报价。
 *
 * 为什么连输入一起返回：比例制之后金额是**算出来的**，判据要核的是
 * `amount === round(balance × fineRatio(progress))`；而余额在滚筒转的那 3~4 秒里还在动
 * （盘面照常越线结算，10-01 实测过「罚 6、筹码 169→208」）⇒ 场外永远读不到"那一刻"的余额。
 * 把输入随金额一起送进遥测，恒等式才能在**逐事件**口径上精确成立，
 * 不用退化成区间/容差判据（那是本项目"薄样本 + 容差"假绿的常见来源）。
 *
 * `balance` 记的是**真正参与计算的那个数**（负余额已被夹到 0），不是原始读数 ——
 * 否则 `amount === round(balance × ratio)` 在余额为负时会算不平。
 */
export function quoteFine(balance: number, progress: number): FineQuote {
  const usable = Math.max(0, balance);
  return { amount: fineAmount(usable, progress), balance: usable, progress };
}

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
