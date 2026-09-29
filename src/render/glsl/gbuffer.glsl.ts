import * as THREE from 'three';
import { HASH3_GLSL } from './noise.glsl';

/**
 * 通道复用的 GLSL（G1-b）：面 ID 进 alpha、`gInfo` 进第二附件。
 *
 * 前置与代价见 `render/GBuffer.ts`。这里只管「往哪写、写什么」。
 *
 * ## ★ 面 ID 取的是**物体中心**，不是片元世界坐标
 *
 * 参考原文是 `fract((vCentr.x + vCentr.y + vCentr.z) * 3.424)` —— `vCentr` 是
 * **物体中心**，所以一件物体 = 一个 ID，边界只出现在「两件东西相邻」的地方。
 * 笔记里那份迁移代码写成了 `vWorldPos`（逐片元），照抄会得到**每个像素都不一样**的 ID，
 * Sobel 一看全是梯度 ⇒ 整屏噪点描边。这里按原文语义实现。
 *
 * ## ★ ID 必须在**顶点**着色器算完，片元只插值
 *
 * 反过来做（片元里 `hash(中心)`）会踩一个零报错的坑：中心作为 varying 传下来时，
 * 相邻像素之间会有 1 ULP 级别的插值误差，而 `fract`-hash 对输入**不连续** ——
 * 1 ULP 能把结果甩到 [0,1) 的任何位置。于是同一件物体的表面自己就成了「到处是边界」。
 * 在顶点算成 float 之后，三个顶点值相同 ⇒ 插值结果最多差 1 ULP ⇒ 远低于任何阈值。
 *
 * ## 实例化的粒度是「每个实例一个 ID」
 *
 * 中心取的是 `modelMatrix × instanceMatrix` 的平移列，所以钉阵里每一根钉子各自有 ID
 * （它们之间本来就该有线）。没有实例的件退化成 `modelMatrix` 的平移列。
 */

/**
 * 顶点着色器要传给片元的面 ID。
 *
 * ★ 为什么是 **vec2 而不是一个 float**（G3-a 的实测逼出来的）：
 * 单通道 ID 存进 8 位 alpha 之后只有 256 个桶，而币床上有约 300 枚币 ——
 * 生日悖论下**必然**撞桶，撞上的两枚币之间永远不会有线（实测：本帧只出现
 * 233 个不同桶，且「相邻且不同」的 ID 最小差只有 1/255，按 0.02 的阈值
 * 有 13% 的物件交界像素被直接漏掉）。
 * 两个独立哈希写进**半浮点**附件之后，可分度从 256 抬到约 1024×1024，
 * 撞桶概率掉到可以忽略；代价是描边那里多一次通道比较，不是多一次采样。
 */
export const GBUFFER_VERTEX_DECL = [
  /* glsl */ `
varying vec2 vSurfaceId;
`,
  HASH3_GLSL,
].join('\n');

/**
 * 挂在 `<project_vertex>` **之后**：那里 `instanceMatrix` 与 `modelMatrix` 都在作用域内，
 * 而且不需要 `mvPosition`（我们只要平移列）。
 */
export const GBUFFER_VERTEX_ASSIGN = /* glsl */ `
	{
		vec4 sdCenter = vec4( 0.0, 0.0, 0.0, 1.0 );
		#ifdef USE_INSTANCING
			sdCenter = instanceMatrix * sdCenter;
		#endif
		sdCenter = modelMatrix * sdCenter;
		// 乘无理倍率再 hash：中心都是「整厘米级」的小数，直接喂给 hash 会让相邻物体的
		// hash 输入只差最后一两位。两个分量取**不同的**倍率（4.7 / 7.31），
		// 于是它们是两次近似独立的抽样 —— 撞桶要两维同时撞上。
		vSurfaceId = vec2(
			sdHash13( sdCenter.xyz * 4.7 ),
			sdHash13( sdCenter.xyz * 7.31 )
		);
	}
`;

/**
 * 片元侧声明。**不设 `material.glslVersion`**：r184 把所有非 raw 材质都按
 * `#version 300 es` 编译，并自动插 `layout(location = 0) out ... pc_fragColor`
 * 与 `#define gl_FragColor pc_fragColor`（`WebGLProgram.js:801-828`）。
 * 所以这里补一个 location=1 的输出就行；真去设 GLSL3 反而会让那些自动声明消失，
 * three 自带 chunk 里的 `gl_FragColor` 全炸。
 */
export const GBUFFER_FRAGMENT_DECL = /* glsl */ `
layout(location = 1) out highp vec4 gInfo;
uniform float uDepthScale;
varying vec2 vSurfaceId;
`;

/**
 * 挂在替换 `<dithering_fragment>` 的位置 —— 它是 `meshtoon` 片元的**最后一个** include，
 * 因此一定在 `opaque_fragment`（会把 `a` 重新按 `diffuseColor.a` 写一遍）之后。
 *
 * 两条口径：
 *
 * 1. **只有不透明件把 ID 写进 alpha。** 半透明件的 alpha 是**混合权重**，
 *    抢走它等于把落币导槽变成随机透明度。`OPAQUE` 是 three 按
 *    `transparent === false && blending === NormalBlending && alphaToCoverage === false`
 *    自己打的 define（`WebGLPrograms.js:259`），**本来就进缓存键** ⇒
 *    这里 `#ifdef` 不多花一份程序（与「禁止 `#ifdef WRITE_GINFO`」不矛盾：
 *    那个是凭空新增变体维度，这个是搭已有的）。
 * 2. **半透明件的线宽权重给 0。** 它写进深度附件会把「挡在币前面的导槽远壁」当成表面，
 *    描边就会浮在币上 —— 与其到 G3 再想办法剔除，不如在这里就不让它参与。
 *
 * `vViewPosition` = `-mvPosition`（`meshtoon.glsl.js:42`），所以它的 `z` 就是**正的视深**。
 *
 * ## 通道的现在分工（G3-a 之后）
 *
 * - 附件 0 的 `a` = `vSurfaceId.x * 0.9`。乘 0.9 是**留出哨兵余量**：
 *   `fract` 的值域是 [0,1)，而最后一遍要靠「alpha 有没有被写过」把背景从色调映射里
 *   排除出去（背景由 `glClear` 填，清出来的 alpha 恒为 1）。留出 10% 之后这个判据
 *   是**确定成立**的，而不是「某个物体的 hash 恰好落在 0.99 附近就整件不映射」。
 * - 附件 1 = `(视深, ID.x, ID.y, 线宽权重)`。**半浮点**，所以 ID 在这里能拿到
 *   约 10 位精度 × 两维，而不是 alpha 那种 8 位一维（撞桶的根因，见上面 `GBUFFER_VERTEX_DECL`）。
 */
export const GBUFFER_WRITE = /* glsl */ `
	#ifdef OPAQUE
		gl_FragColor.a = vSurfaceId.x * 0.9;
		gInfo = vec4( vViewPosition.z / uDepthScale, vSurfaceId, 1.0 );
	#else
		gInfo = vec4( vViewPosition.z / uDepthScale, vSurfaceId, 0.0 );
	#endif
`;

/**
 * 只有第二输出声明、没有面 ID 那份 —— 给**不走 toon 工厂**的材质用。
 *
 * ⚠️ 不能直接复用 `GBUFFER_FRAGMENT_DECL`：它带 `varying float vSurfaceId`，
 * 而 ES 3.00 里「片元有 in、顶点没有对应 out」是**链接错误**。
 */
const GBUFFER_INFO_DECL = /* glsl */ `
layout(location = 1) out highp vec4 gInfo;
`;

/**
 * 给一个会被画进 `GBuffer` 的**非 toon** 材质补上 location=1 的输出。
 *
 * 为什么必须补：MRT 下「active draw buffers 有 2 个，而片元只写 1 个」不是警告，
 * 是每帧都刷的 WebGL 验证错误 ——
 * `glDrawElements: Active draw buffers with missing fragment shader outputs`，
 * 而 `tests/visual.spec.ts` 的「无控制台报错」判据会直接红（G1 就是这么抓到的）。
 *
 * 写全 0 是刻意的：这条通道对它没有信息（面 ID 要的是 toon 那套哈希），
 * 而「深度 0」在 G3 的语义里等价于「这里没有可描边的表面」——正是我们要的。
 */
export function attachGInfoFallback(material: THREE.Material): void {
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${GBUFFER_INFO_DECL}`)
      .replace('#include <dithering_fragment>', '#include <dithering_fragment>\n\tgInfo = vec4( 0.0 );');
  };
}
