import * as THREE from 'three';

/**
 * 通道复用的渲染目标（G1，走参考效果的**地基**）。
 *
 * ## 为什么非要一块渲染目标
 *
 * 参考（abeto《Messenger》）那套观感的三件事里，「物体之间必然有线」和「手绘断线」
 * 都发生在**屏幕空间**：后处理要同时拿到颜色、面 ID、深度。而我们的 canvas 是
 * `alpha: false`（`core/Renderer.ts:8`）——**根本没有 alpha 通道可写**。
 * 所以「把面 ID 塞进 `gl_FragColor.a`」这条路的前置不是 shader 技巧，是
 * **让场景先渲染进一块带 alpha 的 RT**。这就是本文件。
 *
 * ## 两个附件的分工
 *
 * - **附件 0**：颜色（线性，**没有**经过色调映射 —— 见 `FinalPass.ts` 为什么必须这样）
 *   + `a` = 面 ID。
 * - **附件 1（`gInfo`）**：`r` = 线性视深、`g/b` 预留给法线、`a` = 该像素的线宽权重。
 *
 * ★ 附件 1 用 `HalfFloatType` 而不是默认的 8 位：深度走 8 位时，
 * 在 `GBUFFER_DEPTH_SCALE = 20` 米这一档上一个台阶就是 8 厘米，
 * 描边要比较的是**相邻像素**的深度差，量化台阶比信号还大 ⇒ 阈值怎么调都是噪声。
 * 两张附件的格式是**各自**的（`textures[1].type`），所以只有 4 字节 → 8 字节的那份
 * 带宽涨在信息通道上，颜色那张仍是 8 位。
 *
 * ## MRT 的代价账（与「加 define」的区别）
 *
 * 多写一个输出**不新增程序变体**：defines 一字不差，只是片元多一个 out。
 * 真正会翻倍的是「要不要写 gInfo」做成 `#ifdef WRITE_GINFO` —— 那才是加变体，禁止。
 *
 * ⚠️ 但**引入 RT 本身**会换掉场景材质的 cache key：`WebGLPrograms.js:173-182` 在
 * `currentRenderTarget !== null` 时把 `toneMapping` 打成 `NoToneMapping`、
 * `:209` 把 `outputColorSpace` 打成工作色域，两条都进缓存键。
 * 只要场景**全部**走这一条路，程序数不变（整体平移）；
 * 一旦有第二遍把同一批材质画到 canvas 上，那批配置就变成两份程序。
 * `perf` 的 programs 判据就是钉这一条的。
 */

/** 附件 1.r 的归一化分母（米）。取远大于机台深度（约 3 米）的值，留出余量。 */
export const GBUFFER_DEPTH_SCALE = 20;

/** MSAA 采样数。参考用 4；`antialias: true` 那条路走不到 RT 上，所以在这里给。 */
const SAMPLES = 4;

export class GBuffer {
  readonly target: THREE.WebGLRenderTarget;

  constructor(width: number, height: number) {
    this.target = new THREE.WebGLRenderTarget(width, height, {
      count: 2,
      samples: SAMPLES,
      depthBuffer: true,
      // 屏幕后处理要的是**逐像素精确**取回，任何过滤都是在制造不存在的中间值。
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
    });
    this.target.texture.name = 'gbuffer.color';
    // 颜色附件**保持默认的 `NoColorSpace`**（= 线性存储），这里刻意不做 sRGB 标记。
    //
    // 试过改成 `SRGBColorSpace`（为了救暗部的 8 位量化），结果更糟：three 的
    // `WebGLBackground` 会先把 `scene.background` 从工作色域转换到**当前渲染目标**的色域，
    // 而格式的 SRGB8_ALPHA8 又让驱动在写入时再编码一次 ⇒ 背景被**编码两遍**。
    // 保持 NoColorSpace 时那条转换是恒等的，驱动也不编码 ⇒ 背景的往返路径与
    // 「直接画到 canvas」逐字一致（前提是最后一遍**不给背景做色调映射**，见 `FinalPass`）。
    this.target.textures[1].type = THREE.HalfFloatType;
    this.target.textures[1].name = 'gbuffer.info';
  }

  /** 颜色附件（含面 ID 的 alpha）。 */
  get color(): THREE.Texture {
    return this.target.textures[0];
  }

  /** 信息附件（深度 / 预留法线 / 线宽权重）。 */
  get info(): THREE.Texture {
    return this.target.textures[1];
  }

  /**
   * 跟随内部分辨率改尺寸。
   *
   * 尺寸必须是**内部**渲染尺寸（`pixelScale.internalWidth/Height`）而不是 CSS 尺寸：
   * `PixelScale` 用 `setPixelRatio(1/upscale)` 把 backing store 缩小，
   * RT 与它不一致的话最后一遍就得做一次非整数缩放 —— 那是「像素风」档下最扎眼的糊。
   */
  resize(width: number, height: number): void {
    if (this.target.width === width && this.target.height === height) return;
    this.target.setSize(width, height);
  }

  dispose(): void {
    this.target.dispose();
  }
}
