/**
 * 边缘光 / 菲涅尔（S16）—— **零程序代价的视觉丰富化通道**。
 *
 * 从 `render/ToonMaterial.ts` 拆出来（R2-T2），字符串内容与拆分前逐字一致。
 *
 * ## 为什么只能这么做（不能给单个材质加 define）
 *
 * 想给钻石 / 宝箱单独加效果，直觉是「加一个 `SD_RIM` define，只有那两个材质打开」。
 * **那条路走不通**：新增一个 define 分支 = 新增程序变体 = 已编译程序数 +1。
 *
 * 而 `onBeforeCompile` 注入的 GLSL **对程序缓存键完全不可见**
 * （`customProgramCacheKey` 被 `ToonMaterial.ts` 的 `CACHE_KEY` 盖成常量），
 * 所以「对**所有** toon 材质注入同一段 GLSL，再用**每材质** uniform 控强度」
 * 是唯一一条既不加程序、又不加 draw call 的路。
 *
 * ★ 这里成立的依据是 three 的一个实现细节（`three.module.js:18153`）：
 * `acquireProgram` 命中全局 `programsMap` 时只是 `++usedTimes` 返回旧 program，
 * **但 `materialProperties.uniforms = parameters.uniforms` 照常执行** ——
 * 也就是 **program 共享、uniforms 逐材质**。所以同 defines 的材质可以各有各的 rim 强度。
 *
 * ## 代价（诚实记账）
 *
 * 机柜、护栏、币床这些**不需要**边缘光的件也会带上这段代码，只是强度设 0。
 * 换来的是：程序数一个不涨、draw call 一个不涨、色带数一个不涨。
 *
 * ## 注入点与可用量
 *
 * - 声明挂在 `<common>` 之后（只声明**自己的** uniform，不碰 `vObjPos` /
 *   `vObjNormal` / `uDetailScale` —— 那是 `detail.glsl.ts` 的条件声明，重复声明会编译失败）。
 * - 运算挂在 `<normal_fragment_maps>` 之后。此时：
 *   - `normal` 已由 `<normal_fragment_begin>` 声明，是**视空间**法线；
 *   - `vViewPosition` 由 `<lights_toon_pars_fragment>` 无条件声明（=`-mvPosition`，
 *     从片元指向相机，也是视空间）。所以 `dot(normal, normalize(vViewPosition))` 就是 NdotV。
 * - `sdRimFres` 是**模块级变量**（不是块内局部）：`RIM_EMISSIVE_APPLY` 注入点
 *   （`<emissivemap_fragment>`）在它之后，要接着读它。
 *
 * ## 为什么加在 `diffuseColor` 上（而不是 `outgoingLight`）
 *
 * `diffuseColor` 是**光照之前**的 albedo，色带是**乘**在它上面的。加在这里的效果是
 * 「边缘那些面的 albedo 被抬高 → 色带把其中一部分顶到更亮的一档」——
 * 于是低多面体的**硬切面**会自然分块（钻石尤其明显：逐面法线 ⇒ 逐面 NdotV 恒定 ⇒
 * 每个切面拿到一个**常量**的菲涅尔值，天然就是「切面高光」）。
 * 加在 `outgoingLight` 上则是无视色带的平滑泛光，会破坏三渲二的硬边调性。
 *
 * ## 第二个用途：把**平铺的自发光**收进边缘（S16 实测补的）
 *
 * 第一版只做了上面那一条，截出来一看钻石是**一团发光的白球** —— 根因是
 * `emissive` 是**与法线无关的平铺加色**，强度一高就把逐面差异整个淹没。
 * 所以再加 `RIM_EMISSIVE_APPLY`：`totalEmissiveRadiance *= mix(uRimEmissiveFloor, 1.0, sdRimFres)`。
 * 效果是**边缘的切面亮、正对镜头的切面通透** —— 恰好就是「宝石」的观感，
 * 而且 `uRimEmissiveFloor = 1` 时对既有材质是恒等变换。
 */
export const RIM_DECL = /* glsl */ `
uniform vec3 uRimColor;
uniform vec3 uRimColorHigh;
uniform float uRimStrength;
uniform float uRimPower;
uniform float uRimEmissiveFloor;
uniform float uMatcapStrength;
float sdRimFres;
float sdRimUp;
`;

export const RIM_APPLY = /* glsl */ `
	{
		vec3 sdRimView = normalize( vViewPosition );
		sdRimFres = pow( 1.0 - saturate( dot( normal, sdRimView ) ), uRimPower );
		// 双色 rim（R2-T1-1）：下缘暖、上缘冷 —— Arcane 的霓虹是**从下往上打**的，
		// 单一 rim 色会把这件事抹平。分界线取视空间法线的 y：机位基本固定（俯视台面），
		// 所以视空间的「上」与世界的「上」在这里够用了。
		sdRimUp = saturate( normal.y * 0.5 + 0.5 );
		diffuseColor.rgb += mix( uRimColor, uRimColorHigh, sdRimUp ) * ( sdRimFres * uRimStrength );
		// matcap-lite（R2-T1-2）：**不新增采样**，直接查已经在用的色带 LUT，
		// 拿菲涅尔当横坐标。于是「金属边缘高光」是**量化过的色带档**而不是连续泛光，
		// 三渲二的硬边调性不被破坏 —— 这正是不用真 matcap 贴图的理由（那要 +1 纹理 +1 program）。
		// 包在 USE_GRADIENTMAP 里：gradientMap 这个 uniform 本身就只在该 define 打开时声明。
		#ifdef USE_GRADIENTMAP
			diffuseColor.rgb += texture2D( gradientMap, vec2( sdRimFres, 0.5 ) ).rgb * uMatcapStrength;
		#endif
	}
`;

export const RIM_EMISSIVE_APPLY = /* glsl */ `
	totalEmissiveRadiance *= mix( uRimEmissiveFloor, 1.0, sdRimFres );
`;
