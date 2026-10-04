/**
 * 数值小工具的唯一真源。
 *
 * 起因：`clamp` 在 `Game.ts` / `core/InputController.ts` / `render/PixelScale.ts` /
 * `systems/Mechanisms.ts` 里各有一份**逐字相同**的副本（四处都是
 * `Math.min(max, Math.max(min, value))`）。四份副本本身不会算错，会出事的是"以后只改一处"。
 *
 * ⚠️ 反过来，仓库里那两个 `clamp01` **不是**同一个函数，别顺手合并：
 *   · `render/RampLut.ts` 的是 `min(1, max(0, v))`；
 *   · `game/xixi.ts` 的多一条 `Number.isFinite` 守卫（NaN ⇒ 0）。
 *   合并任意一侧都会静默改掉另一侧的边界行为。
 */

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 三位小数：诊断与报告里的"看得懂的长度"都用它（避免 0.30000000000000004 这种读数）。 */
export function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** 一位小数。 */
export function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
