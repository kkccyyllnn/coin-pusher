import * as THREE from 'three';

/**
 * 最后一遍出画（G1-c）。
 *
 * ## 为什么这一遍**必须**自己补色调映射与色彩空间编码
 *
 * three 只在「渲染目标是 null（canvas）」时才做这两件事：
 * `WebGLPrograms.js:173-182` 在 `currentRenderTarget !== null` 时把 `toneMapping`
 * 打成 `NoToneMapping`，`:209` 把 `outputColorSpace` 打成工作色域（线性）。
 * 于是场景渲染进 `GBuffer` 之后，那张纹理里装的是**线性、未映射**的颜色 ——
 * `Renderer.ts:11-13` 那三行（ACESFilmic / exposure 1.05 / sRGB）的语义
 * 现在整个搬到了这里。**搬错就是全画面亮度平移**，而它在截图里长得和
 * 「有人调了曝光」一模一样，所以这一遍是 G1 唯一的真风险。
 *
 * 好消息是这两步不用自己实现：非 raw 材质的片元前缀里，three 会按当前参数
 * 自动插 `tonemapping_pars_fragment` + `toneMapping()` 与
 * `colorspace_pars_fragment` + `linearToOutputTexel()`（`WebGLProgram.js:771-779`）。
 * 所以这里直接 `#include <tonemapping_fragment>` / `<colorspace_fragment>` 就行，
 * **不抄一份 ACES 常数**（抄了就是第二份真源，改 `Renderer.ts` 时必然漏改这里）。
 *
 * ## `toneMappingExposure` 为什么自己塞进 uniforms
 *
 * 内建那条上传路径是 `WebGLRenderer.js:2701`，只在 `refreshMaterial` 时执行。
 * 我们每帧都在「场景的一堆材质」之后才画这一遍 ⇒ 实际上每帧都会 refresh，
 * 但那是**依赖绘制顺序**的巧合。显式放进 `material.uniforms` 之后，
 * 它走的是「逐帧上传材质 uniform」那条常规路，调曝光滑杆立刻生效，不看顺序脸色。
 *
 * ## 调试视图
 *
 * `?view=depth` / `?view=id` 直接把附件 1 的深度、附件 0 的面 ID 画成灰度。
 * 这不是便利贴，是**判据前置**：参考笔记 §8 第三条的教训是
 * 「只抄描边不抄通道复用，会得到一个只有深度描边、物体之间没线的四不像，
 * 然后第一反应是参数没调好」。先看数据到没到，再谈阈值。
 */

/** 出画模式。0 = 正常；其余是把某个通道直接摊成灰度。 */
export const FINAL_VIEW_SCENE = 0;
export const FINAL_VIEW_DEPTH = 1;
export const FINAL_VIEW_ID = 2;

/**
 * 解析 `?view=` 的通道视图（形状照 `PixelScale.readPixelOverride`：
 * 显式、可逆、写出来就一眼看得懂在比什么）。
 *
 * - `?view=depth` → 附件 1 的深度（看「几何到底交没交出去」）
 * - `?view=id` → 附件 0 的 alpha（看面 ID 的分布；应当是**逐块均匀**的灰，
 *   如果整屏是噪点，说明 ID 用了逐片元坐标而不是物体中心 —— 那是最常见的抄错）
 *
 * ★ 参数名刻意用 `view` 而不是 `debug`：`DebugTools.ts:166` 判的是
 * `searchParams.has('debug')`，任何值都会把 lil-gui 面板打开 —— 用 `?debug=id`
 * 截图会被面板挡住半张图，看起来像「通道没数据」而其实是「数据被 UI 盖住了」。
 *
 * 其他值（包括 `?view` 裸写）一律回到正常出画：这个参数只服务 G1/G2 的观测，
 * 不该变成一个「打开就会看到奇怪东西」的开关。
 */
export function readFinalView(search: string): number {
  const value = new URLSearchParams(search).get('view');
  if (value === 'depth') return FINAL_VIEW_DEPTH;
  if (value === 'id') return FINAL_VIEW_ID;
  return FINAL_VIEW_SCENE;
}

export class FinalPass {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.Camera();
  private readonly material: THREE.ShaderMaterial;

  constructor() {
    // 一个覆盖裁剪空间的大三角形，而不是一块四边形：
    // 少一个顶点、少一次对角线拆分，而且不需要正交相机 —— 顶点着色器压根不看矩阵。
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3),
    );
    this.material = new THREE.ShaderMaterial({
      name: 'finalPass',
      uniforms: {
        tScene: { value: null as THREE.Texture | null },
        tInfo: { value: null as THREE.Texture | null },
        uView: { value: FINAL_VIEW_SCENE },
        toneMappingExposure: { value: 1 },
      },
      vertexShader: /* glsl */ `
varying vec2 vUv;
void main() {
	// 裁剪空间 [-1,1] → 纹理 [0,1]。三角形超出屏幕的那部分被裁掉，
	// 留在屏内的采样恰好是 1:1（RT 与 backing store 同尺寸，见 GBuffer.resize）。
	vUv = position.xy * 0.5 + 0.5;
	gl_Position = vec4( position.xy, 0.0, 1.0 );
}
`,
      fragmentShader: /* glsl */ `
uniform sampler2D tScene;
uniform sampler2D tInfo;
uniform float uView;
varying vec2 vUv;
void main() {
	vec4 scene = texture2D( tScene, vUv );
	// 调试视图**故意**不走色调映射与编码：要看的是附件里的原始数值，
	// 套上 ACES 之后 0.5 和 0.6 的差别会被压平，反而看不出通道是不是空的。
	if ( uView > 1.5 ) {
		gl_FragColor = vec4( vec3( scene.a ), 1.0 );
		return;
	}
	if ( uView > 0.5 ) {
		gl_FragColor = vec4( vec3( texture2D( tInfo, vUv ).r ), 1.0 );
		return;
	}
	// ★ 背景**不参与色调映射** —— 这是 G1 踩出来的，不是设计偏好。
	//
	// ⚠️ 本段注释里**不能出现反引号**：它在 JS 模板字符串内部，一个反引号就截断整个模块
	//   （本项目已为此踩过五次，而且报错行号指不到真正的原因）。
	//
	// 以前直接画 canvas：scene.background 由 glClear 写进帧缓冲，**不经过任何着色器**，
	// 所以它从来不被 ACES 压。改成先渲染进 RT 之后，背景像素也变成了「最后一遍的一个采样」，
	// 于是被映射了一遍 —— 实测同机位同冻结画面：91% 的像素变化、
	// 最暗一档从 6.8% 涨到 38.8%、均值 71.5 → 66.3，看起来完全就是「有人把曝光调暗了」。
	//
	// 判据用附件 0 的 alpha：不透明的 toon 片元会把它写成面 ID，而 ID 被刻意压在 0.9 以下
	//（见 gbuffer.glsl.ts 里那句乘 0.9），glClear 出来的背景 alpha 恒为 1
	// ⇒ 「a < 0.99」= 这一像素被画过。选它而不是选「附件 1 被清成 0」，
	// 是因为后者要绕开 three 自己的 clear（gl.clear 一次清掉**所有**颜色附件），
	// 为了一个哨兵去改清除语义不值。
	//
	// MSAA 的 resolve 会让几何边缘拿到 0.9x 与 1 之间的插值 ⇒ 边缘**部分**映射，
	// 这正好是想要的抗锯齿行为，不是缺陷。
	float drawn = 1.0 - step( 0.99, scene.a );
	vec3 mapped = scene.rgb;
	// 不写 include tonemapping_fragment 那个 chunk：它无条件映射整个 gl_FragColor，
	// 而这里要的是「按像素决定映不映」。函数本身是 three 前缀白给的
	//（WebGLProgram.js:771-773），所以 ACES 曲线与曝光仍然只有一个出处。
	#if defined( TONE_MAPPING )
		mapped = mix( scene.rgb, toneMapping( scene.rgb ), drawn );
	#endif
	gl_FragColor = vec4( mapped, 1.0 );
	#include <colorspace_fragment>
}
`,
      depthTest: false,
      depthWrite: false,
    });
    this.scene.add(new THREE.Mesh(geometry, this.material));
  }

  /**
   * 画一遍。
   *
   * @param exposure 与 `renderer.toneMappingExposure` **同一个值**：
   *   色调映射搬到这里来了，所以曝光也得由这里交给 shader。两处不同步就是
   *   「面板上拖滑杆没反应」，所以由调用方每次现给（不在本类里存副本）。
   */
  render(
    renderer: THREE.WebGLRenderer,
    color: THREE.Texture,
    info: THREE.Texture,
    exposure: number,
    view: number,
  ): void {
    renderer.setRenderTarget(null);
    this.material.uniforms.tScene.value = color;
    this.material.uniforms.tInfo.value = info;
    this.material.uniforms.uView.value = view;
    this.material.uniforms.toneMappingExposure.value = exposure;
    renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.material.dispose();
    for (const child of this.scene.children) {
      const mesh = child as THREE.Mesh;
      mesh.geometry.dispose();
    }
  }
}
