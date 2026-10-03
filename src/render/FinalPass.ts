import * as THREE from 'three';
import { BLEND_GLSL, BLEND_SCREEN } from './glsl/blend.glsl';
import { OUTLINE_APPLY, OUTLINE_GLSL } from './glsl/outline.glsl';

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
 * 面 ID 的梯度阈值（G3-b：**实测值，不再是占位**）。
 *
 * 实测过程见 `Game.gbufferReport()`。两维半浮点 ID 的「相邻且不同」最小可分差
 * 远大于下面这个数，所以阈值与噪声之间留了足够余量（判据要离噪声远，不是离读数近）。
 */
export const FINAL_PASS_ID_THRESHOLD = 0.004;
/** 深度梯度阈值（以「视深 / `GBUFFER_DEPTH_SCALE`」为单位；0.005 ≈ 10 厘米）。 */
export const FINAL_PASS_DEPTH_THRESHOLD = 0.005;
/** 掠射放宽系数：面越侧对镜头，深度门槛抬得越高（越不画线）。 */
export const FINAL_PASS_DEPTH_GRAZING = 0.02;

/**
 * V9 · 冷阴影分级的三个量（10-01，**由实测决定，不是看图调的**）。
 *
 * 现读依据（`/tmp/grade-read.mjs` + `/tmp/grade-delta.mjs` 打在冻结默认机位上）：
 * 出厂画面上**暗部是偏暖的** —— 阴影带（sRGB 相对亮度 < 0.18 的绘制像素，占 39 %）
 * 的 `R − B = +6.2`。而「色温偏暖」这句抱怨要动的就是它。
 *
 * ★ 算子选 **滤色（screen）**，正片叠底是被实测否掉的：
 *   同一个权重下 multiply 把被作用像素的 `R−B` 推动 7.6（方向对），
 *   但那些像素的亮度掉了 **35 %**（0.102 → 0.066）—— 这与 V9 的另一半「亮币床」正面对撞。
 *   screen 是加性的：同一批像素 `R−B` 从 +1.8 推到 −20.3，亮度反而抬起来。
 *   0.12 档的全画面读数：阴影带 `R−B` **+6.2 → −7.6**、币床区亮度 **0.3278 → 0.3451（+5.3 %）**、
 *   中间带 `R−B` 54.9 → 47.5（被抬起来的暗像素并入中间带所致，不是把铜币调冷），
 *   被改变的像素占全画面 11.2 %。
 * ★ 为什么在最后一遍做，而不是改 `artDirection` 的色带：两条都试过，都不对症 ——
 *   抬 `coin` 中段 → 币床区亮度只涨 **0.5 %**（币面大多落在第 3 段与第 0 段），
 *   抬 `cabinet` 中段 → 阴影带反而**更暖**（+6.2 → +7.1）。
 * ★ 为什么**不去动中间带**：中间带 `R − B = +54.9` 的暖是铜币自己的暖，
 *   `artDirection` 里写着实测教训「色带明显偏冷会把暖 albedo 的铜币去饱和成暗红」。
 *   所以这个分级的权重函数必须在中间调归零，而不是做成全局色温。
 *
 * **口径**：作用点是**色调映射之后、色彩空间编码之前**的线性值，
 * 所以 `range` 是线性亮度（sRGB 0.18 ≈ 线性 0.027，取 0.06 让过渡柔和一点）。
 * `blend.glsl.ts` 顶部那条「算子作用在线性域、比 Photoshop 狠」的口径差在这里成立。
 */
export const FINAL_PASS_SHADOW_TINT = '#4f6ea8';
/** 线性亮度到 `range` 时权重衰减到 0（`smoothstep` 的上端）。 */
export const FINAL_PASS_SHADOW_RANGE = 0.06;
/**
 * 分级强度。`0` 在**数学上**是恒等（screen 加 0 加不了任何东西），
 * ⚠️ 但「关掉逐字节等于出厂」这一条**没有验成**：同一份代码、同机位、同冻结状态
 * 连采两次本身就差 2793 个像素（0.3 %）⇒ 跨页面加载不可比（本项目老规矩），
 * 要证它得给这条分级加**运行时旋钮**做同会话换臂。⇒ 记为接手项，不要引用成已验。
 */
export const FINAL_PASS_SHADOW_AMOUNT = 0.12;

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
        // G2/G3 描边：0 = 逐字恒等（判据靠这个）。步长在 `render()` 里按 **CSS 尺寸**算。
        uOutlineScale: { value: 0 },
        uOutlineStep: { value: new THREE.Vector2(1 / 1280, 1 / 720) },
        uIdThreshold: { value: FINAL_PASS_ID_THRESHOLD },
        uDepthThreshold: { value: FINAL_PASS_DEPTH_THRESHOLD },
        uDepthGrazing: { value: FINAL_PASS_DEPTH_GRAZING },
        // V9 冷阴影。`THREE.Color` 在构造时就把 sRGB 十六进制转成工作色域（线性），
        // 与上面那段口径一致；强度单独成 uniform，是为了让「关掉 = 逐字恒等」可判。
        uShadowTint: { value: new THREE.Color(FINAL_PASS_SHADOW_TINT) },
        uShadowAmount: { value: FINAL_PASS_SHADOW_AMOUNT },
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
${OUTLINE_GLSL}
${BLEND_GLSL}
uniform vec3 uShadowTint;
uniform float uShadowAmount;
void main() {
	vec4 scene = texture2D( tScene, vUv );
	vec4 info = texture2D( tInfo, vUv );
	// 调试视图**故意**不走色调映射与编码：要看的是附件里的原始数值，
	// 套上 ACES 之后 0.5 和 0.6 的差别会被压平，反而看不出通道是不是空的。
	if ( uView > 1.5 ) {
		// 面 ID：两维各占一个通道，所以这里画出来的是**彩色**的。
		// 该看到的形态是「逐块纯色」——一件物体一个颜色；
		// 如果整屏是噪点，说明 ID 用了逐片元坐标而不是物体中心（最常见的抄错）；
		// 如果两件挨着的物体颜色**完全一样**，那就是撞桶（G3-a 量过的失效形态）。
		gl_FragColor = vec4( info.gb, 0.0, 1.0 );
		return;
	}
	if ( uView > 0.5 ) {
		gl_FragColor = vec4( vec3( info.r ), 1.0 );
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
	// V9 冷阴影：**只碰暗部**的分级，走 blend.glsl.ts 的滤色算子（这是它的第一个消费者）。
	// 为什么不是正片叠底：multiply 实测把被作用像素压暗 35 %，与「亮币床」那半句对撞。
	// 权重用线性亮度的 smoothstep，到 range 之上恒为 0 ⇒ 铜币自己的暖（中间带）不直接被动。
	// 与背景的关系：整条分级乘在 drawn 上，所以机台外那片**不被色调映射**的底也不会被它染。
	float shadowWeight = 1.0 - smoothstep( 0.0, ${FINAL_PASS_SHADOW_RANGE}, dot( mapped, vec3( 0.2126, 0.7152, 0.0722 ) ) );
	vec3 shadowBlend = mix( vec3( 0.0 ), uShadowTint, shadowWeight * uShadowAmount );
	vec3 shaded = sdBlend( ${BLEND_SCREEN}, mapped, shadowBlend );
	mapped = mix( mapped, shaded, drawn );
	gl_FragColor = vec4( mapped, 1.0 );
	#include <colorspace_fragment>
${OUTLINE_APPLY}
}
`,
      depthTest: false,
      depthWrite: false,
    });
    this.scene.add(new THREE.Mesh(geometry, this.material));
  }

  /**
   * 当前生效的三条阈值，交给 `gbufferReport()` 做实测对照。
   *
   * 单独交出去而不是让 harness 再写一遍常量：判据要能回答
   * 「**按现在这些阈值**会漏掉多少条边」，读的实际生效值必须是同一个。
   */
  get outlineThresholds(): { id: number; depth: number; grazing: number } {
    return {
      id: this.material.uniforms.uIdThreshold.value as number,
      depth: this.material.uniforms.uDepthThreshold.value as number,
      grazing: this.material.uniforms.uDepthGrazing.value as number,
    };
  }

  /**
   * 画一遍。
   *
   * @param exposure 与 `renderer.toneMappingExposure` **同一个值**：
   *   色调映射搬到这里来了，所以曝光也得由这里交给 shader。两处不同步就是
   *   「面板上拖滑杆没反应」，所以由调用方每次现给（不在本类里存副本）。
   * @param cssWidth/cssHeight 描边步长的分母。**必须是 CSS 尺寸而不是 RT 尺寸**：
   *   `PixelScale` 的整数倍率档会把内部尺寸缩小，用 RT 尺寸当分母的话
   *   切档瞬间线宽就跳一倍（见 `glsl/outline.glsl.ts` 那条 ★）。
   */
  render(
    renderer: THREE.WebGLRenderer,
    color: THREE.Texture,
    info: THREE.Texture,
    params: {
      exposure: number;
      view: number;
      outlineScale: number;
      shadowAmount: number;
      cssWidth: number;
      cssHeight: number;
    },
  ): void {
    renderer.setRenderTarget(null);
    this.material.uniforms.tScene.value = color;
    this.material.uniforms.tInfo.value = info;
    this.material.uniforms.uView.value = params.view;
    this.material.uniforms.toneMappingExposure.value = params.exposure;
    this.material.uniforms.uOutlineScale.value = params.outlineScale;
    // 真值每帧从 tuning 走，与 uOutlineScale 完全同构；构造里那个 value 只剩初值。
    this.material.uniforms.uShadowAmount.value = params.shadowAmount;
    const step = this.material.uniforms.uOutlineStep.value as THREE.Vector2;
    // CSS 尺寸取整到至少 1 像素：0 会把这个向量变成 Infinity，表现是整屏被描黑。
    step.set(1 / Math.max(1, params.cssWidth), 1 / Math.max(1, params.cssHeight));
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
