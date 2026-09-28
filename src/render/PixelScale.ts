/**
 * 像素分辨率基建（V1）。
 *
 * 目标：整幅画面按**固定内部高度**渲染，再由浏览器用最近邻放大到 CSS 尺寸，
 * 得到「半像素」的块状观感。
 *
 * ## 为什么旋钮是「目标高度 + 整数倍率」而不是直接写死一个分辨率
 *
 * `image-rendering: pixelated` 做的是最近邻放大。若放大倍率不是整数，一个 texel
 * 会时而占 1 个 CSS 像素、时而占 2 个——画面出现**粗细不均的条纹**，正是要避免的「脏」。
 * 所以内部尺寸必须取「CSS 尺寸 ÷ 整数」。
 *
 * 由此得到一个反直觉的结论：**目标高度不能硬写 480**。在 1280×720 视口上
 * `floor(720 / 480) = 1`，倍率 1 等于不降分辨率，像素化根本不会发生；要真的降到
 * 「半像素」只能取倍率 2 → 内部 360p。所以 `targetHeight` 的语义是
 * 「**期望的内部高度上限**」，实际值由整数倍率决定（360 在 720p 视口上恰好给出 2×）。
 *
 * ## 与画质分档的关系
 *
 * `PerformanceGovernor` 通过**调低 `targetHeight`** 来降档：倍率变大 = 像素更粗 = 更省。
 * 这与像素美学同向——降档不是「变糊」，而是「更方块」。
 * 原来的 `maxDpr` 语义被取代：DPR 不再参与分辨率计算（见 `pixelRatio`）。
 */

export type PixelScaleSettings = {
  /** 期望的内部渲染高度上限（CSS 像素）。实际内部高度 = CSS 高 ÷ 整数倍率。 */
  targetHeight: number;
  /**
   * 倍率下限。**必须 ≥ 2**，否则像素化在矮视口上会静默失效。
   *
   * 这条是实测踩出来的：`targetHeight = 360` 在 Playwright 的 iPhone 13
   * （视口 390×**664**）上算出 `floor(664/360) = 1`——倍率 1 等于不降分辨率，
   * 「像素化」变成了名义上的开关，画面与改造前**一模一样**。
   * 有了下限，矮视口至少也按 ×2 渲染（664 → 332）。
   */
  minUpscale: number;
  /** 倍率上限，防止超大视口把画面压成马赛克。 */
  maxUpscale: number;
  /** 是否启用最近邻放大（关掉 = 回到原生分辨率）。 */
  pixelated: boolean;
  /**
   * 显式倍率覆盖（`?pixel=2`）。非 null 时**跳过** `targetHeight` 推导。
   *
   * 为什么需要它：`targetHeight` 要经过整数化（`floor(CSS高 / targetHeight)`），
   * 视口不够高时会被吞掉——`?pixel=480` 在 844 高的手机上算出倍率 1，
   * 等于什么都没发生，很反直觉。显式倍率则永远照字面生效。
   */
  upscaleOverride: number | null;
};

export type PixelScale = {
  /** 整数放大倍率。1 = 不降分辨率（原生）。 */
  upscale: number;
  /** 交给 `renderer.setPixelRatio` 的值 = 1 / upscale。 */
  pixelRatio: number;
  /** 实际内部渲染宽高（CSS 像素）。 */
  internalWidth: number;
  internalHeight: number;
  targetHeight: number;
  pixelated: boolean;
};

/**
 * 默认档：720p 视口 → 倍率 2 → 内部 640×360（正好「半像素」）。
 * 矮视口（iPhone 13 的 664）靠 `minUpscale` 兜底，仍按 ×2 渲染 → 195×332。
 * `maxUpscale = 4` 是给 4K 视口的兜底，免得内部高度掉到 100 多像素。
 */
export const PIXEL_SCALE_DEFAULTS: PixelScaleSettings = {
  targetHeight: 360,
  minUpscale: 2,
  maxUpscale: 4,
  pixelated: true,
  upscaleOverride: null,
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 由 CSS 尺寸与设置解出内部渲染尺寸。纯函数，便于判据直接枚举调用。 */
export function resolvePixelScale(
  cssWidth: number,
  cssHeight: number,
  settings: PixelScaleSettings,
): PixelScale {
  const width = Math.max(1, Math.floor(cssWidth));
  const height = Math.max(1, Math.floor(cssHeight));
  const cap = Math.max(1, settings.maxUpscale);
  const floorScale = clamp(Math.round(settings.minUpscale), 1, cap);
  // 关掉像素化 = **回到原生分辨率**（A/B 对照的基准），而不是「低分辨率 + 平滑放大」。
  // 后者既不是像素风也不是原生画面，没有存在的理由。
  const upscale = !settings.pixelated
    ? 1
    : settings.upscaleOverride !== null
      ? clamp(Math.round(settings.upscaleOverride), 1, cap)
      : clamp(Math.floor(height / Math.max(1, settings.targetHeight)), floorScale, cap);
  return {
    upscale,
    pixelRatio: 1 / upscale,
    internalWidth: Math.max(1, Math.round(width / upscale)),
    internalHeight: Math.max(1, Math.round(height / upscale)),
    targetHeight: settings.targetHeight,
    pixelated: settings.pixelated,
  };
}

/**
 * 把像素化开关写到 `:root[data-pixel]`，由 CSS 决定 `image-rendering`。
 *
 * 刻意走 CSS class 而不是内联 style：开发开关与测试覆盖走同一条路径，
 * 而且 `visual.spec.ts` 的 `sampleCanvas` 只截 `#game-canvas`，不受影响。
 */
export function applyPixelated(pixelated: boolean): void {
  document.documentElement.dataset.pixel = pixelated ? 'on' : 'off';
}

/**
 * 解析 `?pixel=` 覆盖：`off` 关像素化，数字当作**显式倍率**
 * （`1` = 原生、`2` = 半像素、`3` = 三分之一），便于 A/B 与真机调试。
 */
export function readPixelOverride(search: string): Partial<PixelScaleSettings> {
  const value = new URLSearchParams(search).get('pixel');
  if (value === null) return {};
  if (value === 'off') return { pixelated: false };
  const upscale = Number(value);
  if (Number.isFinite(upscale) && upscale >= 1) return { upscaleOverride: upscale };
  return {};
}
