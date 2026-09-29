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
 *
 * ## 相位维的约定（R2 之后、走参考材质效果的 G0-a）
 *
 * 「逐物体不同的随机外观」（断线、斑痕）一律走 `sdNoiseP(vec2, float phase)`，
 * **不在调用点各自凑**（`vec2(sdNoise(p + t))` 这类临时拼法会把「第三维是相位、不是时间」
 * 这条边界磨掉，下一个人就会拿它当时间用 —— 见上面那段 ⚠️）。
 * 全 3D 的 `sdNoise3(vec3)` **刻意没有加**：眼下每个用法都是「一张 z=常数的平面」，
 * 加它是把 hash 次数从 4 抬到 8 换一条没人走的路。真要动纹样时再补，补的时候
 * 必须沿 z 做插值（否则逐帧沸腾）。
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
 * 2D → 1D hash 的**三维**版本（同样无 `sin`，Dave Hoskins "Hash without Sine" 的 3D 形式）。
 *
 * 只被 `sdNoiseP` 用：第三维不是空间维度，是**逐材质相位**。
 */
export const HASH3_GLSL = /* glsl */ `
float sdHash13( vec3 p ) {
	p = fract( p * vec3( 0.1031, 0.1030, 0.0973 ) );
	p += dot( p, p.yzx + 33.33 );
	return fract( ( p.x + p.y ) * p.z );
}
`;

/**
 * **带逐物体相位的值噪声** —— 参考（abeto《Messenger》）那条
 * `step( sinenoise1( vec3( vUv * 2.0, vRand.x + vRand.w * 34.32 ) ), 0.35 )` 的等价物。
 *
 * ## 为什么是这个签名，而不是 `sdNoise3(vec3)`
 *
 * 我们要的每个用法都是「在**一个二维坐标**上取纹样，第三维是一个**常量**（这件物体自己的相位）」。
 * 那等于「在 3D 噪声里取一张 z=常数的平面」，所以按 `sdNoiseP(vec2, float)` 写下来
 * **只需要 4 次 hash**（一般 3D 值噪声要 8 次）。省下来的是每个片元的算术，
 * 而丢掉的能力是我们此刻一条都不用的：沿 z 插值。
 *
 * ## ⚠️ 相位**不能当时间用**
 *
 * `sdHash13` 对第三维是**不连续**的：phase 变一点点，四个角的随机值整个换一批。
 * 所以 `sdNoiseP(p, time)` 画出来的是**逐帧沸腾的白噪声**，不是「纹样在动」。
 * 真要动就得补真正的 3D 值噪声（沿 z 做 Hermite 插值，8 次 hash），
 * **不要**在这里凑——这是「噪声库只有 2D」那条已知缺口的准确边界。
 *
 * 相位加进 hash 的**值**而不是采样**坐标**：加进 `p.x/p.y` 只是把整张噪声平移，
 * 同一个 phase 平移同一个量 ⇒ 所有物件的断口**同相**，读起来像屏幕网格而不是
 * 每条边各自的手绘感。
 */
export const NOISE_PHASED_GLSL = /* glsl */ `
float sdNoiseP( vec2 x, float phase ) {
	vec2 p = floor( x );
	vec2 f = fract( x );
	f = f * f * ( 3.0 - 2.0 * f );
	vec3 q = vec3( p, phase );
	float a = sdHash13( q + vec3( 0.0, 0.0, 0.0 ) );
	float b = sdHash13( q + vec3( 1.0, 0.0, 0.0 ) );
	float c = sdHash13( q + vec3( 0.0, 1.0, 0.0 ) );
	float d = sdHash13( q + vec3( 1.0, 1.0, 0.0 ) );
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
