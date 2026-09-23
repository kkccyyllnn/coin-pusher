/**
 * 动效偏好。
 *
 * 之前有两套割裂的实现：CSS 的 `@media (prefers-reduced-motion: reduce)`
 * 与 `Game.reducedMotion`（只挡镜头抖动与边缘闪光），两者互不联动。
 * 这里统一成一个信号：**系统媒体查询是默认值，测试钩子可以覆盖**，
 * 结果写到 `<html data-motion="reduced|full">`，CSS 与 JS 读的是同一个值。
 *
 * 注意：降级只作用于**表现**（镜头抖动、飞字、边缘闪光、弹跳动画），
 * 不作用于物理。推板推进与台面输送照常跑——否则「降动效」会变成改玩法。
 */
export type MotionSource = 'system' | 'test' | 'none';

export class MotionPrefs {
  private readonly media: MediaQueryList | null;
  private override: boolean | null = null;
  private readonly listeners = new Set<(reduced: boolean) => void>();

  constructor() {
    this.media =
      typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-reduced-motion: reduce)')
        : null;
    this.media?.addEventListener?.('change', () => this.apply());
    this.apply();
  }

  get reduced(): boolean {
    return this.override ?? this.media?.matches ?? false;
  }

  get source(): MotionSource {
    if (this.override !== null) return 'test';
    if (this.media) return 'system';
    return 'none';
  }

  /** 测试钩子用；传 null 恢复跟随系统。 */
  setOverride(value: boolean | null): void {
    this.override = value;
    this.apply();
  }

  onChange(listener: (reduced: boolean) => void): void {
    this.listeners.add(listener);
    listener(this.reduced);
  }

  private apply(): void {
    const reduced = this.reduced;
    document.documentElement.dataset.motion = reduced ? 'reduced' : 'full';
    for (const listener of this.listeners) listener(reduced);
  }
}
