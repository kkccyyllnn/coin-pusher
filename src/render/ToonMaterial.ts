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
// GLSL 片段一律放 `render/glsl/`（R2-T2）：注入点集合 = 那个目录的文件清单。
// 内联在这个文件里时，「到底注入了哪几段」只能靠人肉读 diff 对上程序指纹。
import { COLOR_RAMP_CHUNK } from './glsl/colorRamp.glsl';
import { RIM_APPLY, RIM_DECL, RIM_EMISSIVE_APPLY } from './glsl/rim.glsl';

/**
 * 三渲二材质工厂（V2）。
 *
 * ## 为什么用 `onBeforeCompile` 补 `MeshToonMaterial`，而不是裸写 `ShaderMaterial`
 *
 * `MeshToonMaterial` 免费帮你处理了阴影贴图、多光源、fog、色彩空间、色调映射、
 * 顶点变形与实例化。裸写 `ShaderMaterial` 要把 `#include <shadowmap_pars_fragment>`
 * 那一整套重新接回去，工作量大好几倍，而且每次 three 升级都要跟着修。
 *
 * 这里插**三件事**：
 * 1. 把色带的读法从标量改成 RGB，并给它一条**背面色带**（见下面的 `COLOR_RAMP_CHUNK`）—— **无条件**。
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

export type ToonMaterialParams = {
  /** 基色（albedo）。色带是**乘**在它上面的，所以这里仍要填真实的材质颜色。 */
  color: THREE.ColorRepresentation;
  /** 色带调色板 id（见 `artDirection.RAMP_PALETTES`）。 */
  ramp: RampId;
  /**
   * **背面**色带（R2-T1-3）。默认跟随 `ramp` —— 也就是「没填 = 正背面同一条」，
   * 对既有材质是恒等变换。
   *
   * 只对 `side` 含 `DoubleSide` 的件有视觉效果：闭合单面网格上背面早已被剔除，
   * `gl_FrontFacing` 恒真，两条色带永远走同一条。真正吃到它的是
   * **半透明双面件**（落币导槽）——从外面同时看得见近壁与远壁，
   * 同色带时两面糊成一张纸，分开后才读得出「一条槽」的厚度。
   */
  rampBack?: RampId;
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
  /**
   * 切线空间法线图（R2-T1 最后一项）。
   *
   * ⚠️ **这是本工厂唯一一个会多编译一份程序的参数**：设了它就点亮
   * `USE_NORMALMAP_TANGENTSPACE`，与其余「加 uniform 不加 define」的扩参不同。
   * 所以它单独成一次提交，判据只看程序数（24 → 25 可接受，涨到 ≥ 29 整块撤掉）。
   *
   * 只对**已经挂 `map`** 的面给：切线帧要 UV，无 map 的件挂它会同时引入两个新变量。
   */
  normalMap?: THREE.Texture | null;
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
  /**
   * 双色 rim 的**上缘**色（R2-T1-1）。下缘用 `rimColor`，两者按视空间法线的 y 混合。
   *
   * 默认**跟随 `rimColor`** —— 也就是「没填 = 单色 rim」，对既有材质是恒等变换。
   * 填了两个色才出现「下暖上冷」：Arcane 的霓虹是从下往上打的，单色 rim 会抹平这件事。
   */
  rimColorHigh?: THREE.ColorRepresentation;
  /**
   * matcap-lite 强度（R2-T1-2）：拿菲涅尔当横坐标查**现有的**色带 LUT 当边缘高光。
   *
   * 默认 0 ⇒ 这段等于没写。用真 matcap 贴图要 +1 纹理 +1 program，而量化过的色带档
   * 反而更符合三渲二的硬边调性。
   */
  matcapStrength?: number;
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
  if (params.normalMap) material.normalMap = params.normalMap;
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
  // R2-T1：新增的两个**默认恒等**（上缘色跟随下缘色、matcap 强度 0），
  // 所以对既有材质零视觉变化 —— 与 rim 本身同一套纪律：GLSL 无条件注入，
  // 生效与否完全由逐材质 uniform 表达（加 define 就是加程序变体）。
  const rimColorHighUniform = {
    value: new THREE.Color(params.rimColorHigh ?? params.rimColor ?? '#000000'),
  };
  const matcapStrengthUniform = { value: params.matcapStrength ?? 0 };
  // R2-T1-3：背面色带。**未填 = 复用正面那张 LUT**，于是 `gl_FrontFacing` 的两个分支
  // 采到同一个采样器对象、同一个值 —— 恒等变换，且 `rampLutCount()` 不会多出一条。
  const gradientBackUniform = {
    value: rampLutFor(
      params.rampBack ?? params.ramp,
      RAMP_PALETTES[params.rampBack ?? params.ramp],
    ),
  };

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
    shader.uniforms.uRimColorHigh = rimColorHighUniform;
    shader.uniforms.uMatcapStrength = matcapStrengthUniform;
    shader.uniforms.uGradientBack = gradientBackUniform;

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
