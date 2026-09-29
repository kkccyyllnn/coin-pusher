/**
 * Photoshop 混合模式算子库（G0-c，走参考效果的「二值化合成」那一层）。
 *
 * ## 为什么是「叠一层」而不是「加一个物理项」
 *
 * 参考（abeto《Messenger》）给材质加效果的做法不是往光照模型里添项，而是
 * **把结果当成 Photoshop 图层去叠**：暗部是 HSV 偏移、高光是 `linear dodge`、
 * 硬色块是 `hard mix`。这套表达力对「低多边形 + 高饱和」的风格特别对口 ——
 * 尤其 `hardMix`（把中间调直接推到纯黑/纯白）和 `linearDodge`（加色到饱和）。
 *
 * 我们**已有**的等价物是色带（`glsl/colorRamp.glsl.ts` + `RAMP_PALETTES`）：
 * 「暗部推到冷色」这件事它已经在做，**所以这里刻意不重做 HSV 那条**。
 * 缺的只是这些**合成算子**本身。
 *
 * ## 消费端是谁（此刻：还没有）
 *
 * 这一轮只进门库，**不接材质** —— 因为「演示一处」就必须给某个件改颜色，
 * 而用户这一轮的口径是「机柜只要纯色」。真正的消费者是 **G2 的描边合成**：
 * 描边线色与场景色的叠法（正片叠底 / 加色 / 硬混合）就是这里这几个算子，
 * 到那一步 `src/render/FinalPass.ts` 直接 import 本模块，不用另写一份。
 *
 * ## ★ 口径差：这些算子作用在**工作色域（线性）**的 albedo 上
 *
 * Photoshop 的混合模式定义在**感知均匀**的 sRGB 数值上；`diffuseColor.rgb` 是
 * three 转换过的工作色域（线性光）。同一个 `multiply` 在线性域上**压得更狠**
 * （0.5 × 0.5 在线性域回到 sRGB 是 0.22，在 sRGB 域是 0.25）。
 *
 * 这不是 bug，是**要知道的取值差**：调 opacity 时别拿 Photoshop 里的直觉当基准，
 * 线性域的 `multiply` 更接近「物理压暗」，而 `hardMix` 的黑白阈值 0.5 落在线性 0.5
 * （= sRGB 约 0.73）上 —— 也就是说硬混合的分割线比 PS 里**偏亮**。
 * 真要按感知口径对齐，就在算子里对 B/S 各做一次 sRGB 编解码（+成本），
 * 目前不值的判断依据：这套风格要的正是「硬、脏、过曝」，偏一点方向是对的。
 *
 * ## 模式编号
 *
 * 0..4 固定顺序，**加模式只在末尾加**（编号进 uniform，插中间会让既有取值静默换味）。
 */

/** 模式编号：`0` 正片叠底 … `4` 线性减淡（加色）。 */
export const BLEND_MULTIPLY = 0;
export const BLEND_SCREEN = 1;
export const BLEND_OVERLAY = 2;
export const BLEND_HARD_MIX = 3;
export const BLEND_LINEAR_DODGE = 4;

/**
 * 三个分量各自 `B <= 0.5` 的判定用 `step`，不用 `if`：
 * 混合模式本来就是**逐通道**二值的（PS 的 overlay 也是按通道分支），
 * `step` 写出来和定义逐字一致，还省一个分支。
 */
export const BLEND_GLSL = /* glsl */ `
vec3 sdBlendMultiply( vec3 base, vec3 blend ) {
	return base * blend;
}

vec3 sdBlendScreen( vec3 base, vec3 blend ) {
	return base + blend - base * blend;
}

vec3 sdBlendOverlay( vec3 base, vec3 blend ) {
	// overlay = 暗部正片叠底、亮部滤色，分割线在 base 的 0.5。
	vec3 dark = 2.0 * base * blend;
	vec3 light = 1.0 - 2.0 * ( 1.0 - base ) * ( 1.0 - blend );
	return mix( dark, light, step( 0.5, base ) );
}

vec3 sdBlendHardMix( vec3 base, vec3 blend ) {
	// 硬混合 = 强光取极端：blend > 1 - base 就纯白，否则纯黑。
	// 这是整套里最「风格」的一把刀：中间调整个消失，只剩色块。
	return step( 1.0 - base, blend );
}

vec3 sdBlendLinearDodge( vec3 base, vec3 blend ) {
	// 线性减淡 = 加色（截到 1.0）。给「自发光但不想加 emissive」用。
	return min( base + blend, vec3( 1.0 ) );
}

vec3 sdBlend( int mode, vec3 base, vec3 blend ) {
	if ( mode == 0 ) return sdBlendMultiply( base, blend );
	if ( mode == 1 ) return sdBlendScreen( base, blend );
	if ( mode == 2 ) return sdBlendOverlay( base, blend );
	if ( mode == 3 ) return sdBlendHardMix( base, blend );
	return sdBlendLinearDodge( base, blend );
}
`;
