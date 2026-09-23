import { ENDLESS, type CoinKind } from './constants';

/**
 * 经济纯函数：越线返值、加注倍率、钱包结算。
 *
 * 这个模块**不持有状态、不碰物理、不碰渲染**——所有随机数由调用方传进来，
 * 所以同一组输入永远得到同一个结果，账本恒等式可以在测试里逐笔核对。
 *
 * v3 的定位：**没有分数，只有筹码**。筹码既是局内的投币资源，
 * 也是局外图鉴的购买力，所以「返值」这一个概念同时承担了计分与经济的职责。
 */

/** 加注档位：`chips` 是每投消耗，`mul` 是越线返值的倍率。 */
export type BetTier = { chips: number; mul: number; label: string };

export const BET_TIERS: readonly BetTier[] = ENDLESS.bets;

export function betTier(index: number): BetTier {
  return BET_TIERS[Math.min(Math.max(index, 0), BET_TIERS.length - 1)];
}

/** 热度倍率：连落越多返值越高。 */
export function heatMultiplier(combo: number): number {
  const tier = ENDLESS.heat.find((entry) => combo >= entry.combo);
  return tier ? tier.multiplier : 1;
}

/** 热区倍率：币在亮条范围内越线。 */
export const HOT_ZONE_MUL = 2;

export type CrossingInput = {
  kind: CoinKind;
  /** 该枚币越线时的连落数。 */
  combo: number;
  /** 是否在热区内越线。 */
  hot: boolean;
  /** 这枚币投出时的加注倍率（押 5 枚 = 4）。 */
  betMul: number;
  /** 概率返值的随机数，取值 [0, 1)。由调用方用游戏 RNG 生成，保证可复现。 */
  roll: number;
};

export type CrossingResult = {
  /** 本次越线返还的筹码。0 表示这次没中（只有铜币会这样）。 */
  chips: number;
  /** 是否过了概率闸门（只有铜币走这条路，用于给玩家「灰字 +0」的诚实反馈）。 */
  gated: boolean;
};

/**
 * 一枚币越过得分线时返还多少筹码。
 *
 * 两条规则刻意不同：
 * - **返币与大赏币是固定值**，不吃任何倍率。它们是「稀有兑现」，
 *   一旦被热度/热区/加注放大，返币就会变成比铜币更划算的刷筹码通道，
 *   负期望立刻失效。
 * - **铜币与花纹走倍率**，但铜币额外过一道概率闸门：纯守恒经济下长跑期望会趋近 0，
 *   「每枚必返 1」等于没有庄家优势，所以改成「按概率返」。
 *
 * 取整放在最后一步：倍率是 1.5 这种小数，中途取整会把误差累积成系统性偏差。
 * 代价是取整本身会轻微抬高期望，所以 `bronzePayoutChance` 的标定必须用
 * **模拟**（P8 的蒙特卡洛）而不是闭式解，这里不做代数反推。
 */
export function crossingReturn({ kind, combo, hot, betMul, roll }: CrossingInput): CrossingResult {
  if (kind === 'payout') return { chips: ENDLESS.payoutChips, gated: false };
  if (kind === 'bounty') return { chips: ENDLESS.bountyChips, gated: false };
  // P6 会在这里加 diamond（固定 25 筹码）与 chest（0 筹码，改由 ShowDirector 派发投放演出）。

  const heat = heatMultiplier(combo);
  const zone = hot ? HOT_ZONE_MUL : 1;
  const base = kind === 'pattern' ? ENDLESS.patternChips : 1;

  if (kind === 'bronze' && roll >= ENDLESS.bronzePayoutChance) return { chips: 0, gated: true };

  return { chips: Math.round(base * heat * zone * betMul), gated: kind === 'bronze' };
}

/**
 * 收工可回存钱包的筹码。
 *
 * 跪求拿到的筹码（`dirtyChips`）可以继续玩，但**不能回存**——
 * 否则「破产 → 跪求 → 立刻收工」就是无限刷筹码的循环。
 * 手里筹码低于赊账额时回存 0。
 */
export function cashOutOf(chips: number, dirtyChips: number): number {
  return Math.max(0, chips - dirtyChips);
}

/**
 * 一局的三账本。
 *
 * 恒等式：`chips = buyIn + earned + begged − spent`。
 * 任何一笔筹码的进出都必须落在其中一项上，否则账就对不上——
 * 这条式子是 P1 的核心验收，也是后面加机关/道具时最容易写漏的地方。
 */
export type Ledger = {
  buyIn: number;
  earned: number;
  begged: number;
  spent: number;
  chips: number;
};

/** 账本是否平：差额为 0 才算平（筹码是整数，不允许有容差）。 */
export function ledgerBalances(ledger: Ledger): boolean {
  return ledger.chips === ledger.buyIn + ledger.earned + ledger.begged - ledger.spent;
}

export function ledgerDelta(ledger: Ledger): number {
  return ledger.chips - (ledger.buyIn + ledger.earned + ledger.begged - ledger.spent);
}
