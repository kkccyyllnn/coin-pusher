import * as THREE from 'three';
import { RAMP_PALETTES, type RampId } from '../game/artDirection';
import { rampLutFor } from './RampLut';
import {
  SURFACE_DETAIL_APPLY,
  SURFACE_DETAIL_ASSIGN_NORMAL,
  SURFACE_DETAIL_ASSIGN_POSITION,
  SURFACE_DETAIL_BODY,
  SURFACE_DETAIL_FRAGMENT_DECL,
  SURFACE_DETAIL_VERTEX_VARYINGS,
} from './glsl/detail.glsl';

/**
 * 三渲二材质工厂（V2）。
 *
 * ## 为什么用 `onBeforeCompile` 补 `MeshToonMaterial`，而不是裸写 `ShaderMaterial`
 *
 * `MeshToonMaterial` 免费帮你处理了阴影贴图、多光源、fog、色彩空间、色调映射、
 * 顶点变形与实例化。裸写 `ShaderMaterial` 要把 `#include <shadowmap_pars_fragment>`
 * 那一整套重新接回去，工作量大好几倍，而且每次 three 升级都要跟着修。
 *
 * 这里插**两件事**：
 * 1. 把色带的读法从标量改成 RGB（见下面的 `COLOR_RAMP_CHUNK`）—— **无条件**。
 * 2. 边缘光 / 菲涅尔（S16，见 `RIM_DECL`）—— 也是**无条件**注入，强度由每材质
 *    uniform 控制（默认 0）。无条件是为了不新增 define ⇒ 不新增程序变体。
 *
 * 程序化表面细节（V3）仍然只在实际用到时才注入，见 `onBeforeCompile`。
 *
 * ## 纪律
 *
 * 1. **禁止在任何地方裸 `new THREE.MeshToonMaterial(...)`** —— 漏掉补丁的材质会
 *    静默退回灰阶色带（阴影只能变暗、不换色相），而这种「差一点」很难在截图里一眼看出。
 *    一律走 `makeToonMaterial()`。
 * 2. **禁止 `clone()` 本工厂产出的材质。** `Material.copy()` 只复制一份白名单里的属性，
 *    `onBeforeCompile` 不在其中——它是我们挂上去的 own property，克隆后会被原型上的
 *    空实现盖回去，**补丁静默丢失**（零报错，只有暗部不再换色相）。
 *    需要多份同款就多调一次工厂：材质很便宜，编译好的程序由
 *    `customProgramCacheKey` 共享，不会多编译。
 */

/**
 * 替换 `gradientmap_pars_fragment` 的内联版本。
 *
 * 与 stock 的差异只有两处：
 * 1. `coord.y` 从 `0.0` 改成 `0.5`——纹理只有 1 行，0.5 才是那一行的中心；
 *    0.0 落在纹素边界上，部分驱动会串到相邻档。
 * 2. 返回值从 `vec3( texture2D(...).r )` 改成 `texture2D(...).rgb`——**这是彩色色带的核心**。
 *    stock 的标量读法下最终颜色 = `albedo × 标量 × lightColor`，阴影**只能变暗**；
 *    取 RGB 之后色带自带色相，暗部才能整体推到冷色（三渲二的标准做法）。
 */
const COLOR_RAMP_CHUNK = /* glsl */ `
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

/**
 * 边缘光 / 菲涅尔（S16）—— **零程序代价的视觉丰富化通道**。
 *
 * ## 为什么只能这么做
 *
 * 想给钻石 / 宝箱单独加效果，直觉是「加一个 `SD_RIM` define，只有那两个材质打开」。
 * **那条路走不通**：`perf` 的判据是 `已编译程序数 ≤ 20`，而现在**正好 20（顶格）**。
 * 新增一个 define 分支 = 新增程序变体 = 21 → 红。
 *
 * 而 `onBeforeCompile` 注入的 GLSL **对程序缓存键完全不可见**
 * （`customProgramCacheKey` 被 `CACHE_KEY` 盖成常量，见下），
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
 * - 声明挂在 `<common>` 之后（只声明**自己的** 3 个 uniform，不碰 `vObjPos` /
 *   `vObjNormal` / `uDetailScale` —— 那是 `detail.glsl.ts` 的条件声明，重复声明会编译失败）。
 * - 运算挂在 `<normal_fragment_maps>` 之后。此时：
 *   - `normal` 已由 `<normal_fragment_begin>` 声明，是**视空间**法线；
 *   - `vViewPosition` 由 `<lights_toon_pars_fragment>` 无条件声明（=`-mvPosition`，
 *     从片元指向相机，也是视空间）。所以 `dot(normal, normalize(vViewPosition))` 就是 NdotV。
 *
 * ## 为什么加在 `diffuseColor` 上（而不是 `outgoingLight`）
 *
 * `diffuseColor` 是**光照之前**的 albedo，色带是**乘**在它上面的。加在这里的效果是
 * 「边缘那些面的 albedo 被抬高 → 色带把其中一部分顶到更亮的一档」——
 * 于是低多面体的**硬切面**会自然分块（钻石尤其明显：逐面法线 ⇒ 逐面 NdotV 恒定 ⇒
 * 每个切面拿到一个**常量**的菲涅尔值，天然就是「切面高光」）。
 * 加在 `outgoingLight` 上则是无视色带的平滑泛光，会破坏三渲二的硬边调性。
 *
 * ## ★ 第二个用途：把**平铺的自发光**收进边缘（S16 实测补的）
 *
 * 第一版只做了上面那一条，截出来一看钻石是**一团发光的白球** —— 根因是
 * `emissive` 是**与法线无关的平铺加色**，强度一高就把逐面差异整个淹没：
 * 自发光项在所有面上完全一样，切面越多反而越平。
 *
 * 所以再加一条：`totalEmissiveRadiance *= mix( uRimEmissiveFloor, 1.0, sdRimFres )`
 * （挂在 `<emissivemap_fragment>` 之后）。效果是**边缘的切面亮、正对镜头的切面通透**——
 * 这恰好就是「宝石」的观感，而且 `uRimEmissiveFloor = 1` 时对既有材质是恒等变换。
 *
 * 注意注入点必须在 `<normal_fragment_maps>` **之后**（`normal` 在那里才定义），
 * 而 `<emissivemap_fragment>` 又在它之后 —— 两处注入的先后关系是 three 的固定顺序，
 * 不是我们排的。
 */
const RIM_DECL = /* glsl */ `
uniform vec3 uRimColor;
uniform float uRimStrength;
uniform float uRimPower;
uniform float uRimEmissiveFloor;
float sdRimFres;
`;

const RIM_APPLY = /* glsl */ `
	{
		vec3 sdRimView = normalize( vViewPosition );
		sdRimFres = pow( 1.0 - saturate( dot( normal, sdRimView ) ), uRimPower );
		diffuseColor.rgb += uRimColor * ( sdRimFres * uRimStrength );
	}
`;

const RIM_EMISSIVE_APPLY = /* glsl */ `
	totalEmissiveRadiance *= mix( uRimEmissiveFloor, 1.0, sdRimFres );
`;

export type ToonMaterialParams = {
  /** 基色（albedo）。色带是**乘**在它上面的，所以这里仍要填真实的材质颜色。 */
  color: THREE.ColorRepresentation;
  /** 色带调色板 id（见 `artDirection.RAMP_PALETTES`）。 */
  ramp: RampId;
  /**
   * 程序化表面细节的种类（见 `artDirection.DETAIL_KINDS`）。
   * 0 = 无细节（省掉整段 shader）。用 `defines` 做**编译期**选择，不进 uniform。
   */
  detailKind?: SurfaceDetailKind;
  /** 细节的空间频率（每米多少个纹样单元）。0 或未给 = 不启用。 */
  detailScale?: number;
  /** 自发光（得分线 / 热区 / 大赏币的识别色）。 */
  emissive?: THREE.ColorRepresentation;
  emissiveIntensity?: number;
  map?: THREE.Texture | null;
  /**
   * 自发光贴图。
   *
   * 用途是**「自己会亮的显示面」**：滚筒窗上的像素图标、XIXI 标牌上的徽章。
   * 只用 `map` + `emissive: 纯色` 的话，自发光是**平铺**在整面上的——
   * 它会把图标最暗的描边一起提亮，对比度被吃掉，看起来像蒙了一层雾。
   * 走 `emissiveMap` 则是**按图标自己的颜色发光**：亮的地方亮、暗的地方仍然暗，
   * 而且背板一旦进暗部（色带掉到最低档）图标也不会跟着黑掉。
   */
  emissiveMap?: THREE.Texture | null;
  transparent?: boolean;
  opacity?: number;
  side?: THREE.Side;
  /**
   * 边缘光（菲涅尔）的颜色。默认 `#000000`，配合 `rimStrength = 0` 就是「没有这段效果」。
   *
   * 见 `RIM_DECL` 的注释：这是 S16 给钻石 / 宝箱加的「切面高光 + 金属边缘」通道。
   */
  rimColor?: THREE.ColorRepresentation;
  /** 边缘光强度。**默认 0** —— 除钻石 / 宝箱之外的所有材质都该拿默认值，画面零变化。 */
  rimStrength?: number;
  /**
   * 菲涅尔的幂。越大边缘越窄（越像「一圈亮边」），越小越像整体泛光。
   * 钻石取 2.2（切面各自成块）、宝箱取 3.4（只勾轮廓）。
   */
  rimPower?: number;
  /**
   * 自发光在**正对镜头**的面上的保留比例（`1` = 不衰减，即恒等变换）。
   *
   * 自发光是与法线无关的平铺加色，强度一高就把低多面体的切面差异整个抹平。
   * 取 0.2~0.3 之后，`emissive` 只出现在掠射面上 —— 宝石的「边缘发亮、中心通透」。
   * 默认 `1`：对既有材质零影响。
   */
  rimEmissiveFloor?: number;
  /** 调试用标签，**不进程序缓存键**（进键会让每个材质编译一份程序）。 */
  name?: string;
};

/** 细节种类。0 = 无；1 拉丝金属 / 2 木纹 / 3 接缝铆钉 / 4 毛毡。 */
export type SurfaceDetailKind = 0 | 1 | 2 | 3 | 4;

/**
 * 程序缓存键。
 *
 * 只有**一个**变体维度在这里编码不到：`detailKind` 走的是 `material.defines`，
 * 而 three 的 `getProgramCacheKey()` 本来就会把 `defines` 逐项拼进键里，
 * 所以 kind 的变体是自动区分的、不需要在这里重复。
 * 这个常量键存在的意义是「防止以后有人往 `onBeforeCompile` 里塞闭包捕获的运行时值」——
 * 那种写法会让默认键（`onBeforeCompile.toString()`）在闭包不同内容时也相同，
 * 于是所有材质错误地共享一份程序。
 */
const CACHE_KEY = 'toon-ramp-v1';

export function makeToonMaterial(params: ToonMaterialParams): THREE.MeshToonMaterial {
  const detailKind = params.detailKind ?? 0;
  const detailScale = params.detailScale ?? 0;
  const useDetail = detailKind !== 0 && detailScale > 0;

  const material = new THREE.MeshToonMaterial({
    color: new THREE.Color(params.color),
    gradientMap: rampLutFor(params.ramp, RAMP_PALETTES[params.ramp]),
  });

  if (params.map) material.map = params.map;
  // 不重设 colorSpace：用 CanvasTexture 自带的 SRGBColorSpace（pixelTexture 工厂已设）。
  // 这里关键的是 `channel`：三渲二的 map 默认走 0 通道，**每个非 0 channel 会触发一个新程序**。
  // 我们的贴图都是 0 通道，所以 `map` 不会引发新编译，与原方案一致。
  if (params.map && material.map) {
    (material.map as { channel?: number }).channel =
      (material.map as unknown as { channel?: number }).channel ?? 0;
  }
  if (params.emissiveMap) material.emissiveMap = params.emissiveMap;
  if (params.emissive !== undefined) {
    material.emissive = new THREE.Color(params.emissive);
    material.emissiveIntensity = params.emissiveIntensity ?? 1;
  }
  if (params.transparent !== undefined) material.transparent = params.transparent;
  if (params.opacity !== undefined) material.opacity = params.opacity;
  if (params.side !== undefined) material.side = params.side;
  if (params.name) material.name = params.name;

  // `SD_DETAIL_KIND` 恒定义（0 时 `#if` 会走到 `#else` 的 `return 1.0`）。
  // 恒定义是刻意的：条件定义会让 define 集合随材质变化，缓存键更难推理。
  material.defines = { SD_DETAIL_KIND: String(detailKind) };

  const detailScaleUniform = { value: detailScale };
  // ★ 每个材质**各自一份** uniform 对象（不是模块级共享常量）。
  //   program 是共享的，uniforms 是逐材质的 —— 见 `RIM_DECL` 的注释，
  //   依据是 `three.module.js:18153` 那句 `materialProperties.uniforms = parameters.uniforms`。
  const rimColorUniform = { value: new THREE.Color(params.rimColor ?? '#000000') };
  const rimStrengthUniform = { value: params.rimStrength ?? 0 };
  const rimPowerUniform = { value: params.rimPower ?? 3 };
  const rimEmissiveFloorUniform = { value: params.rimEmissiveFloor ?? 1 };

  // ★ 把强度**记在材质上**，供验证判据计数（`materialReport().rim`）。
  //
  // 为什么不读 uniform：uniform 对象挂在 `onBeforeCompile` 的闭包里，材质外部拿不到。
  // 而「rim 强度漏传 → `undefined` → uniform NaN → 整件变白/黑」是**零报错**的失效形态，
  // 只能靠计数钉住（与 `SD_DETAIL_KIND` 的四种纹样计数同一个道理）。
  material.userData.rimStrength = rimStrengthUniform.value;

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uDetailScale = detailScaleUniform;
    shader.uniforms.uRimColor = rimColorUniform;
    shader.uniforms.uRimStrength = rimStrengthUniform;
    shader.uniforms.uRimPower = rimPowerUniform;
    shader.uniforms.uRimEmissiveFloor = rimEmissiveFloorUniform;

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${SURFACE_DETAIL_VERTEX_VARYINGS}`)
      .replace(
        '#include <beginnormal_vertex>',
        `#include <beginnormal_vertex>\n${SURFACE_DETAIL_ASSIGN_NORMAL}`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>\n${SURFACE_DETAIL_ASSIGN_POSITION}`,
      );

    // 细节只在实际用到时才注入——kind 0 的材质连 varyings 都不需要，
    // 少两个 vec3 插值器（在移动端是实打实的寄存器）。
    //
    // ★ 声明与运算**各只 replace 一次**（S16 收口）。
    //   旧写法是两次独立的 `.replace('#include <common>', …)`（detail 一次、别的再一次）：
    //   两次插入会叠加，**嵌套顺序取决于调用顺序**。加第三个注入点时必然出事，
    //   所以趁加 rim 把它收成一次。
    const fragmentDecl = [
      RIM_DECL,
      useDetail ? SURFACE_DETAIL_FRAGMENT_DECL : '',
      useDetail ? SURFACE_DETAIL_BODY : '',
    ]
      .filter(Boolean)
      .join('\n');
    const fragmentApply = [useDetail ? SURFACE_DETAIL_APPLY : '', RIM_APPLY]
      .filter(Boolean)
      .join('\n');

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <gradientmap_pars_fragment>', COLOR_RAMP_CHUNK)
      .replace('#include <common>', `#include <common>\n${fragmentDecl}`)
      // ⚠️ 必须在 `<normal_fragment_maps>` **之后**：片元顺序是
      // `color_fragment → … → normal_fragment_begin → normal_fragment_maps → …`，
      // 在 `<color_fragment>` 时 `normal` 还没定义，注入会直接编译失败。
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>\n${fragmentApply}`,
      )
      // ★ 自发光收敛（S16）：必须在 `<emissivemap_fragment>` **之后** ——
      //   它用到上面算出来的 `sdRimFres`，而 `sdRimFres` 在 `<normal_fragment_maps>`
      //   那一处才被赋值。三处的先后是 three 的固定顺序，不是我们排的。
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>\n${RIM_EMISSIVE_APPLY}`,
      );
  };
  material.customProgramCacheKey = () => CACHE_KEY;

  return material;
}

/**
 * 受光材质的联合类型。
 *
 * `Game.flash()`（自发光闪烁）这类工具同时作用于 toon 与标准材质，
 * 两者都有 `emissive` / `emissiveIntensity`，所以联合类型就能覆盖。
 * 币在 V4 之前仍是标准材质，所以这个联合短期内不会收敛成单一类型。
 */
export type LitMaterial = THREE.MeshToonMaterial | THREE.MeshStandardMaterial;

/**
 * 读回某个材质上的边缘光强度（S16）。
 *
 * 存在的理由与 `isLitMaterial` 同构：**这是一条「只能靠计数发现的静默缺陷」**。
 * `rimStrength` 漏传不会报错，只会得到一个 NaN uniform，表现是「某个部件整块
 * 变白或变黑」——那在截图里像「光照调过了」，很难反推到材质参数上。
 *
 * 所以 `makeToonMaterial` 把生效值记进 `material.userData.rimStrength`，
 * `Game.materialReport()` 统计非零个数，判据断言「只有钻石、宝箱两份」。
 */
export function rimStrengthOf(material: THREE.Material): number {
  const value = material.userData?.rimStrength;
  return typeof value === 'number' ? value : 0;
}

/**
 * 材质是否是受光材质（有 `color` / `emissive` 的那一类）。
 *
 * 存在的理由：`applyCabinetSkin` 原来判的是 `instanceof THREE.MeshStandardMaterial`，
 * 换成 toon 之后**换肤会静默失效**——遍历照跑、零报错、颜色一点都不变。
 * 返回类型写成 type predicate，调用处才能拿到 `.color` 的类型收窄。
 */
export function isLitMaterial(material: THREE.Material): material is LitMaterial {
  return (
    material instanceof THREE.MeshToonMaterial || material instanceof THREE.MeshStandardMaterial
  );
}
