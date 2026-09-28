/**
 * 币尺寸档位（S13）。
 *
 * ## 为什么是一个「会话常量」而不是运行时旋钮
 *
 * 币的尺寸同时决定三件事，而且**每一件都不是廉价可逆的**：
 *
 * 1. **质量** = πr²·2h·ρ —— 半径与厚度各乘 k，质量就乘 k³。所有「定值冲量」的机构
 *    （扫板的 `SWEEP_IMPULSE`、落点散布）都会跟着漂移，必须按 k³ 补偿。
 * 2. **碰撞半径** —— `Coin` 的 collider 在构造函数里定死（`Coin.ts:81`），
 *    而 `CoinPool` 的渲染几何只建一次（`CoinPool.ts:37`）。
 * 3. **全部布局步距** —— `layout.ts` 的 `MIN_STEP` 与每个区域的列数/行数都从它派生。
 *
 * 所以「热切换」没有廉价路径：改到一半的币池里会同时存在两种尺寸的币，
 * 布局自检也会拿着旧步距去验新币径。**切换 = 改 URL 参数 + 重载整页**，
 * 这是唯一不会留下「半生效状态」的做法。
 *
 * ## 用法
 *
 * ```
 *   （不写）          // ★ 默认 = ×1.2（2026-09-24 用户拍板选定）
 *   ?coin=1.1        // 回溯对照：等比例放大 10%
 *   ?coin=1          // 回溯对照：原尺寸
 * ```
 *
 * `?debug` 面板里的「币尺寸倍率」下拉直接写这个参数并重载，
 * 所以它和手改 URL 走的是同一条路径——**不存在「面板里改了但 URL 没变」的中间态**。
 *
 * ## 为什么档位是离散的三个值而不是连续滑块
 *
 * 每一个档位都必须在 `assertLayoutValid` 下**重新验过**（步距、抖动、塔高、盘面容量的
 * 组合是有限的几种）。连续滑块会产生无穷多种「没人验过」的配置，
 * 而那些配置出问题时的表现是**启动即抛错**或者更糟——**静默少摆几枚币**。
 */

/** 允许的档位。改这里要连同 `layout.ts` 的派生一起复核。 */
export const COIN_SCALE_STEPS = [1, 1.1, 1.2] as const;

export type CoinScale = (typeof COIN_SCALE_STEPS)[number];

/**
 * 默认档位。★ 2026-09-24 用户拍板**选 ×1.2**（预览三档后定的）。
 *
 * 所以「不带参数打开」就是 ×1.2 的机台，`?coin=1` / `?coin=1.1` 只是**回溯对照**用的。
 * 档位机制本身保留（不删）：S6 的铺满、S7 的重标定都可能要再横向看一眼，
 * 而重新搭一遍「尺寸可切换」比留着贵得多。派生逻辑（`fitCells` / `MIN_STEP` / 塔基保留区）
 * 与档位无关，两种做法下都一样。
 */
export const DEFAULT_COIN_SCALE: CoinScale = 1.2;

/** URL 参数名。 */
const PARAM = 'coin';

/**
 * 解析档位。**缺省与非法值都回落到 `DEFAULT_COIN_SCALE`**，不抛错——
 * 这是启动路径，为了一个 URL 拼写错误让整台机器打不开是不划算的。
 */
function parse(search: string): CoinScale {
  const raw = Number(new URLSearchParams(search).get(PARAM));
  return COIN_SCALE_STEPS.find((step) => Math.abs(step - raw) < 1e-6) ?? DEFAULT_COIN_SCALE;
}

/** 当前档位。**在模块加载时读一次**，此后不再变（要变就重载）。 */
export const COIN_SCALE: CoinScale =
  typeof window === 'undefined' ? DEFAULT_COIN_SCALE : parse(window.location.search);

/**
 * 切到另一个档位：写 URL 参数后**重载**。
 *
 * 等于默认档位时**删掉参数**而不是写 `coin=1.2`，这样「默认机台」的地址保持干净——
 * 分享出去的链接不会带着一个没意义的参数。
 */
export function setCoinScale(scale: CoinScale): void {
  const url = new URL(window.location.href);
  if (scale === DEFAULT_COIN_SCALE) url.searchParams.delete(PARAM);
  else url.searchParams.set(PARAM, String(scale));
  window.location.replace(url.toString());
}
