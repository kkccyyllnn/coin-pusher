/**
 * 屏幕空间描边（G2 建通道，G3 接满三条判据）。
 *
 * ## 三条判据各管什么
 *
 * | 判据 | 读哪儿 | 抓到的边 | 抓不到的边 |
 * |---|---|---|---|
 * | 面 ID | 附件 1 的 `g/b` | 任意两个**不同物件**相接处（哪怕共面、同色、同深度） | 两个物件撞进同一个 ID（G3-a 已量化过：单通道 8 位会撞，两维半浮点几乎不撞） |
 * | 深度 | 附件 1 的 `r` | 前后遮挡（同一物件自己折过去的棱也算） | 共面相邻（两枚并排的币深度一样） |
 * | 掠射放宽 | 由深度用 `dFdx/dFdy` 现算面法线 | —— | —— （它是**门槛调制**：掠射面本来就看不清，就不给它画线） |
 *
 * 两条判据是**或**的关系：ID 管「不同物件」，深度管「不同深度」。
 * 只抄一条都会得到四不像 —— 只有 ID 会在共面处完美、在跨深度的同物件棱上什么都没有；
 * 只有深度则在两枚并排的币之间完全失效（这正是参考笔记 §8 第三条说的「拆开抄」）。
 *
 * ## 刻意**没做**的一条：距离淡出
 *
 * 参考给 ID 线做了 `idMinScale`（远处/小面把线淡掉）。他需要它的原因是 8 位 ID 在远处
 * 只剩几个量化台阶，噪声比信号大。我们这边实测过了（`Game.gbufferReport()`）：
 * 两维半浮点 ID 的漏检数是 0 / 5 / 0（三个机位，各约 5~7 万条交界），
 * **没有噪声可淡** —— 加淡出只会白白抹掉真实信息。所以这条不做，理由留在这里，
 * 将来若把 ID 通道降回 8 位要回头看。
 *
 * ## ★ 步长的分母用 **CSS 尺寸**，不用 RT 尺寸
 *
 * 参考写的是 `resolution.y / 1300`。我们有 `PixelScale` 的**整数倍率档**
 *（`?pixel=2` 或画质降档都会把内部尺寸缩小），拿 RT 尺寸当分母的话，
 * 同一个物件在切档的瞬间线宽会跳一倍 —— 而它在截图里长得和「有人把描边调粗了」一模一样。
 * 换算很直接：一个 RT texel 覆盖 `upscale` 个 CSS 像素，所以
 * **要在屏幕上恒定 1 CSS 像素宽，UV 步长就是 `1 / CSS 尺寸`**，与倍率无关。
 */

/** 挂在片元 `<common>` 之后；`vUv` 与 `tScene` / `tInfo` 由 `FinalPass` 提供。 */
export const OUTLINE_GLSL = /* glsl */ `
uniform float uOutlineScale;
uniform vec2 uOutlineStep;
uniform float uIdThreshold;
uniform float uDepthThreshold;
uniform float uDepthGrazing;

// 五点十字（不是 3×3）：中心差分只要上下左右，而这一遍是全帧率敏感的。
// 一次采样取回整条 gInfo（深度 + 两维 ID + 权重），三条判据共用同一批取样。
float sdOutlineMask( sampler2D info, vec2 uv ) {
	vec4 c = texture2D( info, uv );
	vec4 l = texture2D( info, uv - vec2( uOutlineStep.x, 0.0 ) );
	vec4 r = texture2D( info, uv + vec2( uOutlineStep.x, 0.0 ) );
	vec4 d = texture2D( info, uv - vec2( 0.0, uOutlineStep.y ) );
	vec4 u = texture2D( info, uv + vec2( 0.0, uOutlineStep.y ) );

	// ── 判据一：面 ID ──
	// 两维取 max 再相加：任一维分开就算分开。撞桶要两维同时撞上，概率是单通道的平方分之一。
	float idGap = max( abs( r.g - l.g ), abs( u.g - d.g ) )
		+ max( abs( r.b - l.b ), abs( u.b - d.b ) );
	float idEdge = step( uIdThreshold, idGap );

	// ── 判据二：深度（被掠射门槛调制）──
	float depthGap = max( abs( r.r - l.r ), abs( u.r - d.r ) );
	// 面法线**从深度现算**，不额外存：全场景是平面多面体，
	// 深度的屏幕空间导数叉乘出来的就是那个面的法线 —— 存一份顶点法线
	// 要每材质多一个 varying，而这里一分钱不花。
	vec3 sdPosR = vec3( uv.x, uv.y, r.r );
	vec3 sdPosD = vec3( uv.x, uv.y, d.r );
	vec3 sdNormal = normalize( cross( dFdx( sdPosR ), dFdy( sdPosD ) ) );
	// 掠射面（|n.z| → 0）本来就看不清 ⇒ 抬高它的深度门槛，让它少画线。
	// 参考那一行是 depthRange.z + 1.0 - centerNormal.z，这里等价写成 base + k·(1-|n.z|)。
	float depthLimit = uDepthThreshold + uDepthGrazing * ( 1.0 - abs( sdNormal.z ) );
	float depthEdge = step( depthLimit, depthGap );

	// ── 半透明抑制 ──
	// 附件 1 的权重：不透明件写 1、半透明件写 0（见 gbuffer.glsl.ts 的 GBUFFER_WRITE）。
	// 落币导槽那类双面半透明件会把深度盖在币前面，不抑制的话描边会**浮在币上**。
	// 这里按中心像素的权重把整条线关掉；边缘像素因为 MSAA resolve 拿到部分覆盖，
	// 会留一点淡线 —— 那是可接受的近似，不是漏网。
	float opaque = step( 0.5, c.a );

	return opaque * max( idEdge, depthEdge );
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
	float sdOutline = sdOutlineMask( tInfo, vUv ) * uOutlineScale;
	gl_FragColor.rgb *= 1.0 - sdOutline;
`;
