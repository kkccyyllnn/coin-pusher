/**
 * 屏幕空间描边（G2）—— 先只吃**面 ID** 那一条通道。
 *
 * ## 为什么这一步能白拿「物体之间必有线」
 *
 * 附件 0 的 alpha 里装的是**逐物体常量**的面 ID（见 `gbuffer.glsl.ts`）。
 * 于是一件物体内部的梯度**恒为 0**，只有两种地方非零：
 * ① 它的轮廓（ID 与背景的 1.0 相接）；② 它与另一件物体相接的地方（两个 ID 相接）。
 * 这正是参考那条「不需要给任何物体注册 ID，加新物件也不用改材质」的机制。
 *
 * ## ★ 步长用 **CSS 尺寸**，不用 RT 尺寸
 *
 * 参考写的是 `resolution.y / 1300`。我们有 `PixelScale` 的**整数倍率档**
 *（`render/PixelScale.ts`：`?pixel=2` 或画质降档都会把内部尺寸缩小），
 * 拿 RT 尺寸当分母的话，同一个物件在切档的瞬间线宽会跳一倍 —— 而它在截图里
 * 长得和「有人把描边调粗了」一模一样。
 *
 * 换算很直接：一个 RT texel 覆盖 `upscale` 个 CSS 像素，所以
 * **要在屏幕上恒定 1 CSS 像素宽，UV 步长就是 `1 / CSS 尺寸`**，与倍率无关。
 *
 * ## 阈值此刻是**占位**
 *
 * `uOutlineThreshold` 现在是写死的经验值。参考笔记 §6 第 4 条至今标着 `待验证`：
 * ID 是 `fract()` 出来的连续标量，量化到 8 位之后「两个相邻物体的最小可分差」
 * 要**先测后定**（本项目的场景尺度与他的树/叶子完全不同）。那条测量是 G3 的活。
 */

/** 挂在片元 `<common>` 之后；`vUv` 由 `FinalPass` 自己声明。 */
export const OUTLINE_GLSL = /* glsl */ `
uniform float uOutlineScale;
uniform vec2 uOutlineStep;
uniform float uOutlineThreshold;

// 五点十字（不是 3×3）：中心差分只需要上下左右，
// 而 5 次采样在 1280×720 下比 9 次便宜近一倍 —— 这一遍是全帧率敏感的。
float sdOutlineMask( sampler2D tex, vec2 uv ) {
	float c = texture2D( tex, uv ).a;
	float l = texture2D( tex, uv - vec2( uOutlineStep.x, 0.0 ) ).a;
	float r = texture2D( tex, uv + vec2( uOutlineStep.x, 0.0 ) ).a;
	float d = texture2D( tex, uv - vec2( 0.0, uOutlineStep.y ) ).a;
	float u = texture2D( tex, uv + vec2( 0.0, uOutlineStep.y ) ).a;
	// 取 max 而不是 sqrt(gx*gx+gy*gy)：判据要的是「有没有边界」，
	// 不是梯度模长的物理意义，省一次开方。
	float g = max( abs( r - l ), abs( u - d ) );
	// step 而不是 smoothstep：硬边界是这套风格的底线（该硬的地方不糊）。
	// 抗锯齿由 MSAA 的 resolve 提供 —— 边缘像素的 ID 本来就是混合值，
	// 会落在阈值附近形成一圈过渡，不需要在这里再糊一次。
	return step( uOutlineThreshold, g );
}
`;

/**
 * 作用在**色调映射与色彩空间编码之后**（最后一行），理由：
 * 描边是「画在最终图像上的一条线」，不是场景里的一个表面。
 * 若在映射之前乘，ACES 的趾部会把线压掉大半，强度就得跟着曲线反推 —— 那是自找的第二份真源。
 *
 * `uOutlineScale = 0` 时乘数恒为 1.0 ⇒ **逐字恒等**，
 * 这就是 G2/G3 的主判据（关掉效果必须与开效果之前逐像素全等）。
 */
export const OUTLINE_APPLY = /* glsl */ `
	float sdOutline = sdOutlineMask( tScene, vUv ) * uOutlineScale;
	gl_FragColor.rgb *= 1.0 - sdOutline;
`;
