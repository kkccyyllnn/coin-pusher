/**
 * 硬币物理参数的**运行时可变注册表**。
 *
 * ## 为什么需要它
 *
 * `COIN.*`（`constants.ts`）是 `as const` 模块常量，写在 `Coin` 的构造与
 * `applyCollider` 里。要让调试面板能实时改摩擦/弹性/密度/阻尼，就必须有一个
 * 构造期与运行时**读同一处**的地方——否则会出现「拖了滑块，但下一枚币仍按常量建」
 * 这种半生效状态。
 *
 * ## 为什么是模块级可变单例（而不是往 Coin 注入）
 *
 * `Coin` 的构造签名是 `(world, render)`，而 `CoinPool` 在构造时就一次性建满
 * `COIN.budget`（700）个币对象。要注入就得把 `Game → CoinPool → Coin` 三层签名
 * 全部改掉。这个注册表只要 10 行、零管道成本。
 *
 * **代价是引入了一个模块级可变状态**——这是刻意的取舍，不是疏漏：
 * 它只服务调试用途，且 `resetCoinPhysics()` 能一键回到出厂值。
 *
 * ## 与 `coinScale` 的区别
 *
 * 币**尺寸**（半径/厚度）不走这里——它同时决定质量、碰撞半径与全部布局步距，
 * 无法热切换，只能改 URL 后重载（见 `coinScale.ts`）。这里是**尺寸之外**的
 * 那批可以逐枚 `setXxx()` 生效的参数。
 */

import { COIN } from './constants';

/** 可运行时调整的硬币物理参数。 */
export type CoinPhysicsKey =
  | 'density'
  | 'friction'
  | 'restitution'
  | 'linearDamping'
  | 'angularDamping'
  | 'maxSpeed'
  | 'maxUpwardSpeed';

/**
 * 出厂默认值 —— **一律取自 `COIN.*`**。
 *
 * 这条不是形式主义：只要默认值等于现有常量，改动前后**默认行为完全一致**，
 * 现有的 48 个测试与 `scripts/verify-game.mjs` 的 `pace` / `economy` 基线才不会被扰动。
 */
export const COIN_PHYSICS_DEFAULTS: Readonly<Record<CoinPhysicsKey, number>> = {
  density: COIN.density,
  friction: COIN.friction,
  restitution: COIN.restitution,
  linearDamping: COIN.linearDamping,
  angularDamping: COIN.angularDamping,
  maxSpeed: COIN.maxSpeed,
  maxUpwardSpeed: COIN.maxUpwardSpeed,
};

/**
 * 当前生效值。`Coin` 的构造与 `applyCollider` 读它，`Game.applyTuning` 写它。
 *
 * ⚠️ `friction` 只有**一半**效果：Rapier 默认使用 **Average** 合并规则，
 * 币↔台面的实际摩擦是 `(coin.friction + 台面摩擦) / 2`，台面值在
 * `TableBuilder.ts` 的 `floorFriction`（0.45）。单改币侧改不动一半。
 *
 * ⚠️ `maxUpwardSpeed` 与侧向围板 `GLASS_TOP` 是**配套**的：放太开会飞越围板、
 * 触发 `anomalies`。
 */
export const coinPhysics: Record<CoinPhysicsKey, number> = { ...COIN_PHYSICS_DEFAULTS };

/** 恢复到出厂默认值。调试面板的「恢复全部物理默认值」按钮会调它。 */
export function resetCoinPhysics(): void {
  Object.assign(coinPhysics, COIN_PHYSICS_DEFAULTS);
}
