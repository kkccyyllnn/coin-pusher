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
 */
export const COLOR_RAMP_CHUNK = /* glsl */ `
#ifdef USE_GRADIENTMAP

	uniform sampler2D gradientMap;

#endif

vec3 getGradientIrradiance( vec3 normal, vec3 lightDirection ) {

	// dotNL will be from -1.0 to 1.0
	float dotNL = dot( normal, lightDirection );
	vec2 coord = vec2( dotNL * 0.5 + 0.5, 0.5 );

	#ifdef USE_GRADIENTMAP

		return texture2D( gradientMap, coord ).rgb;

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
