import type { Coin } from '../entities/Coin';
import type { CoinPool } from '../entities/CoinPool';
import { COIN, TABLE } from '../game/constants';
import { COIN_SCALE } from '../game/coinScale';

/**
 * 机关 id（P7 起只剩三个）。
 *
 * **`wheel`（风险转轮）已在 P7 删除**（决策 8）：它的定位是「明码标价的方差选择」，
 * 而 XIXI 背板老虎机（P5）已经把这件事故做得更好——同样是「用方差换机会」，
 * 老虎机有集章前置、有背板实体、有演出，转轮只是一个按钮。
 * 两个机制并存只会稀释彼此，所以转轮并入老虎机，`MechanismId` / HUD 按钮 /
 * `spin()` / `WHEEL_TABLE` / 验证用例一并清除。
 */
export type MechanismId = 'sweeper' | 'grapple' | 'reload';

export type MechanismResult = {
  ok: boolean;
  /** 不满足条件时的原因，用于 HUD 提示。 */
  reason?: string;
  /** 受影响的币数。 */
  affected?: number;
};

/** 每局的机关次数（后装填不限次数，受额度限制）。 */
export const MECHANISM_USES: Record<Exclude<MechanismId, 'reload'>, number> = {
  sweeper: 1,
  grapple: 2,
};

/** 机关成本（单位：筹码）。 */
export const MECHANISM_COST = {
  sweeper: 0,
  grapple: 2,
  reload: 1,
} as const;

/** 抓斗的作用区半边长（0.3 × 0.3 米）。 */
const GRAPPLE_HALF = 0.15;
/** 抓斗把币放到「得分线前 0.2 米」。 */
const GRAPPLE_TARGET_Z = TABLE.scoreLineZ - 0.2;
/** 扫板只作用于贴着得分线的这一段。 */
const SWEEP_ZONE = 0.15;
/**
 * 扫板给币的冲量（N·s）。
 *
 * ★ S13 起**必须乘 `COIN_SCALE³`**：冲量是定值，而币的质量是 `πr²·2h·ρ`——
 * 半径与半厚各乘 k 就是 **k³**。不补这一项的话，×1.2 时每枚币的质量涨到 1.73 倍
 * 而冲量不变，扫板的效果只剩 58%（`Δv = J / m`），玩家会感觉「这个机关变废了」。
 * 而这条改动**不会有任何报错**，只是手感悄悄漂移——正是最该写成派生的一类。
 *
 * 原尺寸下：币的质量约 0.18 kg，0.12 N·s 约等于 0.67 m/s。
 */
const SWEEP_IMPULSE = 0.12 * COIN_SCALE ** 3;

/**
 * 三个机关。
 *
 * 移植判据只有一条：**它是否制造新的玩家决策**。所以：
 *   · 扫板把收尾从「等」变成「主动收割」；
 *   · 抓斗是全游戏唯一能主动改变盘面几何的操作（把花纹筹码从够不到的深处搬到前沿）；
 *   · 后装填把额度的**时间价值**引进来（现在花 1 枚，两三个循环后才产出）。
 *
 * 所有机关都只施加物理作用力或位置，结算仍然只由「币是否越过得分线」决定——
 * 没有一个机关会直接加分。
 */
export class Mechanisms {
  private uses: Record<Exclude<MechanismId, 'reload'>, number> = { ...MECHANISM_USES };

  constructor(private readonly coins: CoinPool) {}

  reset(): void {
    this.uses = { ...MECHANISM_USES };
  }

  usesLeft(id: MechanismId): number {
    if (id === 'reload') return Number.POSITIVE_INFINITY;
    return this.uses[id];
  }

  /** 只读巡检用：把活跃币里满足条件的挑出来（回调返回 true 会 despawn，所以这里返回 false）。 */
  private collect(predicate: (coin: Coin) => boolean): Coin[] {
    const picked: Coin[] = [];
    this.coins.forEachActive((coin) => {
      if (predicate(coin)) picked.push(coin);
      return false;
    });
    return picked;
  }

  /**
   * 扫板：把贴着得分线犹豫的币向前送一把。
   *
   * 只给冲量，不直接改 z——推不推得过去仍由物理决定，可能被别的币挡住。
   */
  sweep(): MechanismResult {
    if (this.uses.sweeper <= 0) return { ok: false, reason: '本局扫板已用完' };
    const targets = this.collect((coin) => coin.position.z >= TABLE.scoreLineZ - SWEEP_ZONE);
    this.uses.sweeper -= 1;
    for (const coin of targets) {
      coin.body.applyImpulse({ x: 0, y: 0, z: SWEEP_IMPULSE }, true);
    }
    return { ok: true, affected: targets.length };
  }

  /**
   * 抓斗：把选位标记附近 0.3×0.3 米区域内的币整堆搬到前沿。
   *
   * 搬运风险由物理承担：抬到高处再落，落点会散、可能撞开别的币——
   * 不写任何保护逻辑，物理是唯一裁判。
   */
  grapple(centerX: number): MechanismResult {
    if (this.uses.grapple <= 0) return { ok: false, reason: '本局抓斗已用完' };
    const targets = this.collect(
      (coin) =>
        Math.abs(coin.position.x - centerX) <= GRAPPLE_HALF &&
        Math.abs(coin.position.z - TABLE.pusherFrontZAtRest) <= 0.6,
    );
    if (targets.length === 0) return { ok: false, reason: '这个位置没有可抓的币' };

    this.uses.grapple -= 1;
    targets.forEach((coin, index) => {
      // 横向摊开，避免整堆落在同一个点上互相穿透。间距随币径走（原尺寸 0.055 / 0.06 米），
      // 否则 ×1.2 时 0.055 的间距还不到币径的一半，几枚币会叠在同一个位置反复解穿透。
      const spread = (index % 5) - 2;
      const x = clamp(centerX + spread * 0.055 * COIN_SCALE, -TABLE.drop.halfLane, TABLE.drop.halfLane);
      const z = GRAPPLE_TARGET_Z - Math.floor(index / 5) * 0.06 * COIN_SCALE;
      coin.body.setTranslation({ x, y: TABLE.pusherTopY + 0.28, z }, true);
      coin.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      coin.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    });
    return { ok: true, affected: targets.length };
  }

  /**
   * 后装填：往盘面后区注入一小叠币。
   *
   * 把「额度」从「立即的落点赌注」变成「延迟的累积投资」——这是额度的
   * 时间价值第一次出现在游戏里。预算不够时明确拒绝，不静默吞掉额度。
   */
  reload(count = 3): MechanismResult {
    if (this.coins.remaining < count) {
      return { ok: false, reason: `盘面已满，装不下 ${count} 枚` };
    }
    let placed = 0;
    for (let index = 0; index < count; index += 1) {
      const coin = this.coins.acquire();
      if (!coin) break;
      const x = -0.3 + index * 0.3;
      coin.spawn(
        'bronze',
        x,
        TABLE.pusherTopY + 0.34 + index * 0.05,
        0.42 + (index % 2) * 0.08,
        index * 0.7,
        false,
      );
      placed += 1;
    }
    return { ok: placed > 0, affected: placed, reason: placed > 0 ? undefined : '盘面已满' };
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 供测试与 HUD 引用的常量（避免测试里写魔法数）。 */
export const MECHANISM_CONSTANTS = {
  grappleHalf: GRAPPLE_HALF,
  sweepZone: SWEEP_ZONE,
  sweepImpulse: SWEEP_IMPULSE,
  coinBudget: COIN.budget,
} as const;
