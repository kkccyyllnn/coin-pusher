/**
 * 彩色色带的读法补丁（替换 three 的 `<gradientmap_pars_fragment>`）。
 *
 * 从 `render/ToonMaterial.ts` 拆出来（R2-T2）：那个文件里内联 GLSL 时，
 * 「加了哪几段注入」只能靠人肉读 diff 知道；拆成模块后，注入点集合就是
 * 这个目录的文件清单，`verify-game.mjs perf` 打印程序指纹时能逐条对上号。
 *
 * 与 stock 的差异只有两处：
 * 1. `coord.y` 从 `0.0` 改成 `0.5` —— 纹理只有 1 行，0.5 才是那一行的中心；
 *    0.0 落在纹素边界上，部分驱动会串到相邻档。
 * 2. 返回值从 `vec3( texture2D(...).r )` 改成 `texture2D(...).rgb` ——
 *    **这是彩色色带的核心**。stock 的标量读法下最终颜色 =
 *    `albedo × 标量 × lightColor`，阴影**只能变暗**；取 RGB 之后色带自带色相，
 *    暗部才能整体推到冷色（三渲二的标准做法）。
 *
 * ## 正/背面双 ramp（R2-T1-3）
 *
 * `uGradientBack` 是**无条件**注入的第二张色带，正对镜头的面走 `gradientMap`，
 * 背对镜头的面走它 —— 又是「加 uniform 不加 define」那条纪律：加 define 就是加程序变体。
 *
 * ⚠️ **闭合单面网格上这段等于没写**：`FrontSide` 已经把背面剔掉，
 * 画面上不存在 `gl_FrontFacing == false` 的片元。它服务的是
 * **`DoubleSide` 的半透明件**（现在是落币导槽）：从外面看过去能同时看见近壁与远壁，
 * 两条色带相同时两面**糊成一张纸**，不同时才读出「一条槽」的厚度。
 *
 * 默认值与 `gradientMap` 是**同一张纹理**（见 `ToonMaterial.ts` 的 `rampBack ?? ramp`），
 * 所以对既有材质是恒等变换。
 */
export const COLOR_RAMP_CHUNK = /* glsl */ `
#ifdef USE_GRADIENTMAP

	uniform sampler2D gradientMap;

#endif

uniform sampler2D uGradientBack;

vec3 getGradientIrradiance( vec3 normal, vec3 lightDirection ) {

	// dotNL will be from -1.0 to 1.0
	float dotNL = dot( normal, lightDirection );
	vec2 coord = vec2( dotNL * 0.5 + 0.5, 0.5 );

	#ifdef USE_GRADIENTMAP

		// 背面换第二条色带。写成分支而不是无条件 mix：两张 LUT 内容通常相同，
		// 分支让驱动只在真的翻到背面时才多一次采样。
		// ⚠️ 这段注释里**不能出现反引号** —— 整段 GLSL 是一个 JS 模板字符串，
		//   一个反引号就会把模板提前终结，报错落在下一行且完全指不到真凶。
		return gl_FrontFacing
			? texture2D( gradientMap, coord ).rgb
			: texture2D( uGradientBack, coord ).rgb;

	#else

		// 兜底色也刻意偏冷：漏配 gradientMap 时不该突然跳回中性灰。
		vec2 fw = fwidth( coord ) * 0.5;
		return mix(
			vec3( 0.30, 0.36, 0.50 ),
			vec3( 1.00, 0.96, 0.86 ),
			smoothstep( 0.7 - fw.x, 0.7 + fw.x, coord.x )
		);

	#endif

}
`;
