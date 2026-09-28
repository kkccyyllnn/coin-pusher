import { FBM2_GLSL, HASH_GLSL, VALUE_NOISE_GLSL } from './noise.glsl';

/**
 * 程序化表面细节（V3）。
 *
 * ## 用 Triplanar + 物体空间，不用 UV
 *
 * 机柜全是 `BoxGeometry`，没有做 UV 展开。Triplanar 按法线权重把三个轴向的
 * 投影混起来，**不需要 UV**。用**物体空间**（而不是世界空间）有两条硬理由：
 *
 * 1. **木纹要跟着面板走。** 背板在 V6 要绕 X 倾斜 16.5°~18.9°；世界空间下木纹仍轴对齐，
 *    倾斜后看起来像「被斜切了一刀」。物体空间下木纹跟着面板转，才是「一块木板」。
 * 2. **币面纹样（V4）必须用物体空间**，统一之后两者共享同一套 triplanar 代码。
 *
 * `BoxGeometry(w,h,d)` 的局部坐标就在 `[-w/2,w/2]×…`，**局部单位就是米**（没有归一化到 ±1），
 * 而且全项目**机柜没有任何 `mesh.scale`**，所以物体空间与世界的尺度一致、不会 smear。
 * ⚠️ **新增机柜网格时不要用 `scale`**，否则纹样会被拉伸。
 *
 * ## 注入点：必须在 `<normal_fragment_maps>` **之后**
 *
 * 片元着色器的顺序是
 * `map_fragment → color_fragment → alphamap → alphatest → alphahash →
 *  normal_fragment_begin → normal_fragment_maps → emissivemap_fragment`。
 * 在 `<color_fragment>` 注入时 `normal` **还没定义**，会直接编译失败。
 * 这里只在 `<normal_fragment_maps>` 之后乘一次 `diffuseColor.rgb`。
 */

/** 顶点着色器要传给片元的物体空间量。 */
export const SURFACE_DETAIL_VERTEX_VARYINGS = /* glsl */ `
varying vec3 vObjPos;
varying vec3 vObjNormal;
`;

/**
 * 顶点着色器里取值。`objectNormal` 与 `position` 都是**几何体局部**坐标
 * （未乘 `instanceMatrix`）——这正是我们要的：纹样「画在物体自己的坐标系里」，
 * 所以钉阵的实例被旋转后，纹样跟着一起转，而不是在世界空间里被切一刀。
 *
 * 分成两段是因为它们要挂在**不同的 chunk 之后**：`objectNormal` 由
 * `<beginnormal_vertex>` 声明，`position` 是内建 attribute（任何位置都可用，
 * 但放在 `<begin_vertex>` 之后语义最清楚）。
 */
export const SURFACE_DETAIL_ASSIGN_NORMAL = /* glsl */ `
	vObjNormal = objectNormal;
`;

export const SURFACE_DETAIL_ASSIGN_POSITION = /* glsl */ `
	vObjPos = position;
`;

/** 片元着色器声明。 */
export const SURFACE_DETAIL_FRAGMENT_DECL = /* glsl */ `
varying vec3 vObjPos;
varying vec3 vObjNormal;
uniform float uDetailScale;
`;

/**
 * Triplanar 权重。
 *
 * 4 次幂是**实测的取舍**：1 次幂三面交叠会糊成一片（三个投影各占 1/3），
 * 8 次幂又会在轴切换处出现可见的硬缝。4 次幂在两者之间。
 */
const TRIPLANAR_GLSL = /* glsl */ `
vec3 sdTriplanarWeights( vec3 n ) {
	vec3 w = pow( abs( normalize( n ) ), vec3( 4.0 ) );
	return w / max( w.x + w.y + w.z, 1e-4 );
}
`;

/**
 * 单个投影面上的二维纹样。返回值是**乘在 albedo 上的系数**（围绕 1.0 波动）。
 *
 * 用 `#if SD_DETAIL_KIND` 做**编译期**选择而不是运行时 uniform 分支：
 * 每个变体各自编译一份干净的程序（分支全被裁掉），比把所有分支都编进去更省寄存器。
 * 代价是多几份程序，但 kind 只有 0~4 五种，远达不到「程序爆炸」的量级。
 *
 * ## ★ `fwidth` LOD 淡出是**必需**的，不是可选优化
 *
 * 第一版按「每厘米一条颗粒」定了频率，结果币床上出现大片**对角条纹**——
 * 那不是纹样，是**摩尔纹**：最高频那一层约 99 条/米，而 480p 下币床约 300 像素/米，
 * 一个纹样周期只落 3 个像素，采样不足 → 高频拍成低频的道条。
 *
 * 修法是两层配套：
 * 1. 这里用 `fwidth` 估计「一个像素跨过多少纹样单元」，超过阈值就淡回中性；
 * 2. 同时把各 `detailScale` 调低到「最细一层 ≥ 4 像素」。
 *
 * 只做 ① 会让远处细节整片消失（台阶很明显），只做 ② 换一个视口/分辨率又会复发。
 */
const DETAIL_KINDS_GLSL = /* glsl */ `
float sdDetail2D( vec2 uv ) {
	float detail;
#if SD_DETAIL_KIND == 1
	// 拉丝金属：沿 uv.x 方向的长条纹（uv.y 方向高频 = 各向异性），
	// 再叠一层低频让条纹疏密不均。
	//
	// 幅度刻意压到 ±10%：第一版是 ±22%，在护栏那种斜视角的大平面上
	// 读起来是「斜条纹」而不是「金属拉丝」——纹样要像材质，不能像图案。
	float fine = sdNoise( vec2( uv.x * 0.5, uv.y * 16.0 ) );
	float coarse = sdNoise( vec2( uv.x * 0.13, uv.y * 3.4 ) );
	float streak = fine * 0.65 + coarse * 0.35;
	detail = 0.90 + streak * 0.20;
#elif SD_DETAIL_KIND == 2
	// 木纹：年轮 = 被拉伸的噪声的等值线；窄段取深色细线，再叠高频木丝。
	float g = sdBand2( vec2( uv.x * 1.1, uv.y * 9.0 ) );
	float rings = fract( g * 4.0 + uv.y * 0.35 );
	float line = smoothstep( 0.0, 0.10, rings ) * smoothstep( 0.34, 0.16, rings );
	float grain = ( sdBand2( uv * 26.0 ) - 0.5 ) * 0.08;
	detail = mix( 0.84, 1.06, line ) + grain;
#elif SD_DETAIL_KIND == 3
	// 面板接缝 + 铆钉：格线距离场压暗，格点小圆提亮（中心更亮 = 球面感）。
	// 这一类幅度**保持较大**——接缝与铆钉是结构性特征，看不清就白做了。
	vec2 cell = fract( uv );
	vec2 toEdge = min( cell, 1.0 - cell );
	float seam = min( toEdge.x, toEdge.y );
	float seamMask = 1.0 - smoothstep( 0.0, 0.018, seam );
	vec2 node = cell - 0.5;
	float rivet = length( node );
	float rivetBody = 1.0 - smoothstep( 0.055, 0.085, rivet );
	float rivetHi = 1.0 - smoothstep( 0.0, 0.045, rivet );
	detail = 1.0 - seamMask * 0.40 + rivetBody * 0.16 + rivetHi * 0.10;
#elif SD_DETAIL_KIND == 4
	// 毛毡：低频色差 + 高频颗粒，整体很轻——币床不能抢币的注意力。
	float g = sdBand2( uv * 3.0 );
	float fine = sdBand2( uv * 11.0 );
	detail = 1.0 + ( g - 0.5 ) * 0.10 + ( fine - 0.5 ) * 0.06;
#else
	detail = 1.0;
#endif
	// 一个像素跨过的纹样单元数。> 0.30 开始欠采样，> 0.85 已经完全拍不出来。
	float fw = max( fwidth( uv.x ), fwidth( uv.y ) );
	float lod = 1.0 - smoothstep( 0.30, 0.85, fw );
	return mix( 1.0, detail, lod );
}
`;

/**
 * 完整细节函数体：噪声 + triplanar 权重 + 四种纹样 + 三轴混合。
 *
 * 轴配对：法线沿 z → 投影面是 `xy`（权重 `w.z`）；沿 x → `yz`（`w.x`）；沿 y → `xz`（`w.y`）。
 */
export const SURFACE_DETAIL_BODY = [
  HASH_GLSL,
  VALUE_NOISE_GLSL,
  FBM2_GLSL,
  TRIPLANAR_GLSL,
  DETAIL_KINDS_GLSL,
  /* glsl */ `
float sdSurfaceDetail( vec3 p, vec3 n ) {
	vec3 w = sdTriplanarWeights( n );
	return sdDetail2D( p.xy ) * w.z
		+ sdDetail2D( p.yz ) * w.x
		+ sdDetail2D( p.xz ) * w.y;
}
`,
].join('\n');

/**
 * 乘到 `diffuseColor` 上。
 *
 * 只改 `.rgb`，**不碰 `.a`** —— 透明件（导槽 / 热区）的 alpha 有自己的来路。
 */
export const SURFACE_DETAIL_APPLY = /* glsl */ `
	diffuseColor.rgb *= sdSurfaceDetail( vObjPos * uDetailScale, vObjNormal );
`;
