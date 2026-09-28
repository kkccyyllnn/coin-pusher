/**
 * 噪声 GLSL 片段（V3）。
 *
 * ## 为什么是纯算术、不采样噪声贴图
 *
 * 三轴 × 2 octave = 6 次纹理采样，比 6 次算术 hash **更贵**（带宽 vs ALU），
 * 而且要多绑一张纹理、多一层 UV 处理。机台每个像素只跑 2~3 次 hash，
 * 在 480p 下机柜覆盖约 9 万像素 → 约 55 万次算术/帧，可忽略。
 *
 * ## 两个必须遵守的约束（都是移动端踩出来的）
 *
 * 1. **用 `fract`-based 整数 hash（Dave Hoskins），不要 `sin`-hash。**
 *    `fract(sin(dot(p, k)) * 43758.5453)` 在 `mediump` 精度下会出条纹，
 *    而 iOS 的片元默认精度在某些驱动上就是 `mediump`。
 * 2. **octave 上限 2。** 这是移动端预算的硬线；需要更细的观感就抬
 *    `detailScale`（空间频率），不要加 octave。
 */

/**
 * 无 `sin` 的 2D → 1D hash。
 *
 * 三步：`fract(p * 0.1031)` 打散 → 与自身旋转分量点乘再偏移 → 两个分量相乘。
 * 常数 0.1031 / 33.33 来自 Dave Hoskins 的 "Hash without Sine"，
 * 在 16 位与 32 位精度下都稳定。
 */
export const HASH_GLSL = /* glsl */ `
float sdHash12( vec2 p ) {
	vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
	p3 += dot( p3, p3.yzx + 33.33 );
	return fract( ( p3.x + p3.y ) * p3.z );
}
`;

/** 值噪声：格点随机值 + Hermite 平滑双线性插值。 */
export const VALUE_NOISE_GLSL = /* glsl */ `
float sdNoise( vec2 x ) {
	vec2 p = floor( x );
	vec2 f = fract( x );
	f = f * f * ( 3.0 - 2.0 * f );
	float a = sdHash12( p + vec2( 0.0, 0.0 ) );
	float b = sdHash12( p + vec2( 1.0, 0.0 ) );
	float c = sdHash12( p + vec2( 0.0, 1.0 ) );
	float d = sdHash12( p + vec2( 1.0, 1.0 ) );
	return mix( mix( a, b, f.x ), mix( c, d, f.x ), f.y );
}
`;

/**
 * 2 octave 的 fbm。第二层带一个**固定偏移**而不是旋转矩阵——
 * 偏移量不是整数格点倍数，已经足够打断轴对齐的自相似，还省一个 mat2 乘法。
 *
 * 归一化除以 0.75（= 0.5 + 0.25）让返回值落在 [0,1]。
 */
export const FBM2_GLSL = /* glsl */ `
float sdBand2( vec2 p ) {
	float f = 0.5 * sdNoise( p );
	f += 0.25 * sdNoise( p * 2.03 + vec2( 1.7, 9.2 ) );
	return f / 0.75;
}
`;
