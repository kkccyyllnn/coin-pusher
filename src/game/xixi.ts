import { TABLE } from './constants';

/**
 * XIXI 四槽集章（P5，替换三路集章）。
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
 * 落点 x → 槽位号。分段（边界归属与规划原文一致）：
 *   [-0.68,-0.34) = X₁(0)   [-0.34,0) = I₁(1)   [0,0.34) = X₂(2)   [0.34,0.68] = I₂(3)
 * 界外（|x| > halfLane）返回 -1——理论上落点不会越界（投币口有 clamp），显式兜底。
 */
export function xixiSlot(x: number): XixiSlot | -1 {
  const half = TABLE.drop.halfLane;
  const seg = half / 2;
  if (x < -half || x > half) return -1;
  if (x < -seg) return 0;
  if (x < 0) return 1;
  if (x < seg) return 2;
  return 3;
}

/**
 * 背板老虎机的符号。P5 的奖励池只有「投放演出 + 加力」：
 * 钻 / 箱等 P6 道具就位后再扩充符号表（PLAN-v4 §2：允许奖励表分两步落地）。
 */
export type SlotSymbol = 'tower' | 'fountain' | 'boost';

export const SLOT_SYMBOL_GLYPHS: Record<SlotSymbol, string> = {
  tower: '塔',
  fountain: '泉',
  boost: '力',
};

/**
 * 奖励权重（**草案**，P8 标定——拍板项 #3）。
 * 滚筒是「先定结果、再演停格」：街机老虎机的标准做法，三连之外的组合不存在。
 *
 * 为什么加力占大头（而不是三种均分）：**只有加力是不往盘面加质量的奖励**。
 * 实测（PLAN-v4 §5.7）：把金币奖权重归零后节奏机器人 3/3 全绿；放回 15/15
 * （1 枚/场 ≈ 0.027 枚/投）就会偶发**点火**（盘面变肥 → 排水盘回收率 > 1 → 局不终局）。
 * 所以金币奖压到「稀有头奖」（各 5%），加力做常规奖；具体比例由 P8 在
 * 基础经济带上缓冲之后再放开。
 */
export const SLOT_WEIGHTS: ReadonlyArray<{ symbol: SlotSymbol; weight: number }> = [
  { symbol: 'tower', weight: 5 },
  { symbol: 'fountain', weight: 5 },
  { symbol: 'boost', weight: 90 },
];

/**
 * 每投允许的免费币预算（枚/投）——**这是被实测钉出来的红线**，不是拍脑袋。
 *
 * 推导：排水后的盘面回收率就到 ~0.85 筹码/投（见 economy 模式里那段「第 2 局回收率更高」的
 * 注释），庄家优势只剩 ~0.15；而每个免费币经越线约换回 1.3 筹码。
 * 所以免费币超过 ~0.11 枚/投就会把回收率顶过 1 → 局不终局（点火）。
 * 留一倍余量取 **0.04**：XIXI 约 11 投集齐一次 × (15%+15%) 权重 × 1 枚 ≈ 0.027 枚/投。
 *
 * 加力的权重给到 70% 正是因为它**不往盘面加质量**（只加推板冲程）——
 * 稀有的大额金币奖 + 常见的即时加力，是这个预算下唯一站得住的组合。
 */
export const FAUCET_BUDGET_PER_DROP = 0.04;

/** 摇一个符号。roll ∈ [0,1)，走游戏 RNG（可复现）。 */
export function rollSlotSymbol(roll: number): SlotSymbol {
  const total = SLOT_WEIGHTS.reduce((sum, entry) => sum + entry.weight, 0);
  let accumulated = 0;
  for (const entry of SLOT_WEIGHTS) {
    accumulated += entry.weight;
    if (roll < (accumulated / total)) return entry.symbol;
  }
  return SLOT_WEIGHTS[SLOT_WEIGHTS.length - 1].symbol;
}
