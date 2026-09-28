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
 * 一次摇奖的结果。**三分类**（用户拍板）：
 * - `win`  45%：四个滚筒停在同一奖励符号上（四连），按下面的符号权重分。
 * - `fine` 15%：四个滚筒停在胡萝卜上，**扣本局筹码**。
 * - `miss` 40%：四个滚筒各不相同（杂牌），不奖不罚。
 *
 * ## 为什么不是「中奖/不中奖」两分类
 *
 * 原话里「总中奖概率 45%」与「滚筒更随机一点」是两条要求：只做两分类的话，
 * 55% 的那一半要么全是胡萝卜（每次非奖即罚，太狠），要么四个滚筒永远同号
 * （画面完全不随机）。三分类让 40% 的杂牌承担「随机」、15% 的胡萝卜承担「惩罚」，
 * 两条要求同时成立，而且**三种结果在画面上各自一眼可辨**。
 */
export type SlotOutcome =
  | { kind: 'win'; symbol: SlotSymbol }
  | { kind: 'fine' }
  | { kind: 'miss' };

export const SLOT_OUTCOME_WEIGHTS = { win: 45, fine: 15, miss: 40 } as const;

/** 摇奖结果的纯函数入口（判据枚举它，不在测试里手写分段）。 */
export function outcomeTotalWeight(): number {
  return SLOT_OUTCOME_WEIGHTS.win + SLOT_OUTCOME_WEIGHTS.fine + SLOT_OUTCOME_WEIGHTS.miss;
}

/**
 * 中奖符号的权重（S11 第 1 轮放大后的值）。
 *
 * ## 为什么「力」占大头，而不是五个符号均分
 *
 * 免费币预算是硬红线（见下面的 `FAUCET_BUDGET_PER_DROP`）：**只有加力与钻石
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
 * 把中奖率**乘了两次**，于是水量被低估约 2.2 倍（记 0.068 枚/投，实际约 0.15）。
 * 这个低估直接导致 S10 给「加力存满」加了个 3 枚的兜底演出时，
 * 没人预料到它本身就是一条可观的源（+0.78 枚/摇奖）。
 *
 * 现档（力 26 / 钻 7 / 塔 20 / 泉 11 / 箱 6，合计 70）：
 *   塔 0.45×20/70×16 = 2.057 · 泉 0.45×11/70×10 = 0.707 · 箱 0.45×6/70×8 = 0.309
 *   → **3.073 枚/摇奖**。
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
 * 摇一次奖：先定**结果分类**，再定分类内部的细节。
 *
 * 街机老虎机的标准做法——**先定结果、再演停格**。`roll` 决定分类，
 * `detailRoll` 决定「中奖摇哪个符号」或「杂牌停哪四格」（两者互斥，所以一个够用）。
 */
export function rollSlotOutcome(roll: number, detailRoll: number): SlotOutcome {
  const total = outcomeTotalWeight();
  const value = clamp01(roll) * total;
  if (value < SLOT_OUTCOME_WEIGHTS.win) {
    return { kind: 'win', symbol: rollWinSymbol(detailRoll) };
  }
  if (value < SLOT_OUTCOME_WEIGHTS.win + SLOT_OUTCOME_WEIGHTS.fine) {
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
 * ⚠️ **P10 起现档水量已经高于这条线**（见 `SLOT_SYMBOL_WEIGHTS` 的推导：约 0.068 枚/投）。
 * 红线本身没有失效，是**新增了汇**（`DRAIN` 的两侧排水槽 + 得分线两端下水道）来买回余量。
 * 所以这条常量现在的正确用法是「**源与汇的净差**要落在这条线以下」，
 * 而不是「源单独不许超线」——判据仍然是 `economy` 的回收率 < 1 与「局必须终局」。
 */
export const FAUCET_BUDGET_PER_DROP = 0.04;
