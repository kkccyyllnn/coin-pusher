/**
 * 像素分辨率基建（V1）。
 *
 * ## 两个正交旋钮（V2 解耦）
 *
 * - **`targetHeight` / `upscaleOverride` → 内部分辨率**（`upscale` = CSS 尺寸 ÷ 整数倍率）。
 * - **`pixelated` → 放大方式**（最近邻 or 平滑），只管 CSS 的 `image-rendering`，
 *   **不再**顺带把倍率钉成 1。
 *
 * 早期版本让 `pixelated` 一个布尔同时管这两件事：关掉像素化 = 倍率强制 1。
 * 默认改成「原生分辨率 + 不平滑」之后那个耦合会变成负资产——画质分档靠
 * `targetHeight` 降内部分辨率，若 `pixelated=false` 就把倍率吞回 1，
 * 高配默认档下**降档不再省任何东西**，而面板和分档日志还显示它在生效。
 * 那正是本模块最忌讳的「名义开关」（见下方 `minUpscale` 的实测教训）。
 *
 * ## 为什么倍率必须是整数
 *
 * `image-rendering: pixelated` 做的是最近邻放大。若放大倍率不是整数，一个 texel
 * 会时而占 1 个 CSS 像素、时而占 2 个——画面出现**粗细不均的条纹**，正是要避免的「脏」。
 * 所以内部尺寸必须取「CSS 尺寸 ÷ 整数」。
 *
 * 由此得到一个反直觉的结论：**目标高度不能硬写 480**。在 1280×720 视口上
 * `floor(720 / 480) = 1`，倍率 1 等于不降分辨率。所以 `targetHeight` 的语义是
 * 「**期望的内部高度上限**」，实际值由整数倍率决定。
 *
 * ## 默认档为什么是「原生」
 *
 * `PIXEL_SCALE_DEFAULTS.pixelated = false` + `targetHeight = 720` ⇒ 常规视口上倍率 1、
 * 平滑采样，即**原生分辨率**。想要块状像素观感走 `?pixel=2`（显式倍率 + 自动开最近邻）
 * 或调参面板的「像素化」开关。
 *
 * ## 与画质分档的关系
 *
 * `PerformanceGovernor` 通过**调低 `targetHeight`** 来降档：倍率变大 = 采样点更稀 = 更省。
 * 默认（不平滑）时降档表现为**轻微模糊**；开了最近邻才是「更方块」。
 * 原来的 `maxDpr` 语义被取代：DPR 不再参与分辨率计算（见 `pixelRatio`）。
 */
import { clamp } from '../utils/numeric';

export type PixelScaleSettings = {
  /** 期望的内部渲染高度上限（CSS 像素）。实际内部高度 = CSS 高 ÷ 整数倍率。 */
  targetHeight: number;
  /**
   * 倍率下限。默认档取 **1**（= 不降分辨率 = 原生）。
   *
   * 这个数曾经是 2，用来兜住一个实测踩过的坑：`targetHeight = 360` 在 Playwright 的
   * iPhone 13（视口 390×**664**）上算出 `floor(664/360) = 1`——倍率 1 等于不降分辨率，
   * 「像素化」变成了名义上的开关，画面与改造前**一模一样**。
   * 那是「默认就要块状」时代的判据。默认改成原生之后，倍率 1 是**期望行为**而不是缺陷，
   * 下限留着只做数值兜底。真要强制块状观感用 `?pixel=N`（走 `upscaleOverride`，
   * 永远照字面生效，不被整数化吞掉）。
   */
  minUpscale: number;
  /** 倍率上限，防止超大视口把画面压成马赛克。 */
  maxUpscale: number;
  /**
   * 放大方式：true = 最近邻（块状像素），false = 平滑（浏览器默认）。
   *
   * **只改采样方式，不改内部分辨率**——分辨率是 `targetHeight` / `upscaleOverride` 的事。
   */
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
 * 默认档：**原生分辨率 + 平滑采样**。`targetHeight = 720` 在 720 高的视口上给出倍率 1；
 * 更高的屏幕按整数台阶降（1440 → ×2 → 内部 720），既是分辨率上限也是性能兜底。
 * `maxUpscale = 4` 兜住 4K，免得内部高度掉到 100 多像素。
 * 想要像素风用 `?pixel=2`（同时把最近邻打开）。
 */
export const PIXEL_SCALE_DEFAULTS: PixelScaleSettings = {
  targetHeight: 720,
  minUpscale: 1,
  maxUpscale: 4,
  pixelated: false,
  upscaleOverride: null,
};

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
  // 倍率只看分辨率旋钮；`pixelated` 不参与（它管的是这倍率怎么放大回 CSS 尺寸）。
  const upscale =
    settings.upscaleOverride !== null
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
 * 把最近邻开关写到 `:root[data-pixel]`，由 CSS 决定 `image-rendering`。
 *
 * 刻意走 CSS class 而不是内联 style：开发开关与测试覆盖走同一条路径，
 * 而且 `visual.spec.ts` 的 `sampleCanvas` 只截 `#game-canvas`，不受影响。
 */
export function applyPixelated(pixelated: boolean): void {
  document.documentElement.dataset.pixel = pixelated ? 'on' : 'off';
}

/**
 * 解析 `?pixel=` 覆盖。数字当作**显式倍率**，并且**顺带打开最近邻**
 * （`?pixel=2` 的意图是「给我看像素风」，只降分辨率而不换采样方式是半条路径）：
 *
 * - `off` → 原生 + 平滑（= 默认档，写出来只是为了 A/B 对照时一眼可见）
 * - `1` → 原生 + 最近邻（1:1，两者视觉等价）
 * - `2` / `3` / `4` → 半像素 / 三分之一 / 四分之一，并开最近邻
 */
export function readPixelOverride(search: string): Partial<PixelScaleSettings> {
  const value = new URLSearchParams(search).get('pixel');
  if (value === null) return {};
  if (value === 'off') return { pixelated: false, upscaleOverride: 1 };
  const upscale = Number(value);
  if (Number.isFinite(upscale) && upscale >= 1) {
    return { pixelated: true, upscaleOverride: Math.round(upscale) };
  }
  return {};
}
