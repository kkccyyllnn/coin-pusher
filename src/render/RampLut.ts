import * as THREE from 'three';

/**
 * 彩色色带 LUT（V2）。
 *
 * ## 为什么不是直接用 three 的 `gradientMap`
 *
 * `MeshToonMaterial` 的 `gradientMap` 槽位引擎已经接好了，但 stock 的读法是
 * `vec3( texture2D( gradientMap, coord ).r )`——**只取红通道当标量**。
 * 于是最终颜色 = `albedo × 标量 × lightColor`：一个乘法，阴影**只能变暗**，
 * 无法把阴影的色相整体推向冷色。三渲二（ArcSys 系格斗游戏）的关键恰恰是
 * **色带自己带色相**——暗部偏冷、亮部偏暖，而不是同一个色相压暗。
 *
 * 所以 `ToonMaterial` 会把那个函数重写成 `texture2D(...).rgb`（见 `ToonMaterial.ts`），
 * 本文件负责把调色板烤成那张 1×N 的纹理。
 *
 * ## 两个必须遵守的细节
 *
 * 1. **值必须先转到线性空间再写字节**。渲染管线最后才做 sRGB 输出，
 *    纹理本身按 `NoColorSpace`（线性）解释。直接把 sRGB 字节写进去，
 *    经过 ACES + sRGB 输出会整体偏亮偏灰，色相也会跑。
 * 2. **`NearestFilter` + `generateMipmaps = false`**。色带要的是**硬台阶**
 *    （4 段就是 4 段），任何插值都会把台阶糊成渐变，三渲二就没了。
 */

export type RampBands = readonly [string, string, string, string];

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** 把 4 段 sRGB 色阶烤成一张 4×1 的线性空间 DataTexture。 */
export function makeRampLut(bands: RampBands): THREE.DataTexture {
  const count = bands.length;
  const data = new Uint8Array(count * 4);
  for (let index = 0; index < count; index += 1) {
    // ⚠️ **不要**再调 `.convertSRGBToLinear()`。
    //
    // 开了 `ColorManagement`（默认）之后，`new THREE.Color('#8c93a8')` **已经**是
    // 线性空间的值（`setStyle` 内部会 `colorSpaceToWorking` 转一次）。
    // 再调一次 `convertSRGBToLinear()` 就是**第二次**转换 —— 而且它是无条件执行的
    // （不是 ColorManagement 下的 no-op）。实测后果：色带最暗档
    // 从应有的 0.263 掉到 **0.0585（暗了 4.5 倍）**，整条色带被压死。
    // 这个 bug 当时被「把调色板整体抬亮」掩盖过去了，直到 V4 查币的颜色链路才挖出来。
    const color = new THREE.Color(bands[index]);
    data[index * 4 + 0] = Math.round(clamp01(color.r) * 255);
    data[index * 4 + 1] = Math.round(clamp01(color.g) * 255);
    data[index * 4 + 2] = Math.round(clamp01(color.b) * 255);
    data[index * 4 + 3] = 255;
  }

  const texture = new THREE.DataTexture(data, count, 1, THREE.RGBAFormat);
  texture.name = `ramp-${bands.join('-')}`;
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  // 线性空间：值已经手动转过，不要让三再当 sRGB 解一次。
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/**
 * 色带缓存：同一个调色板只烤一次。
 *
 * 材质是逐件创建的（机柜十来个网格、推板、老虎机、演出装置），
 * 没有缓存就会烤出几十张内容相同的纹理，白白吃掉纹理槽与显存。
 */
const cache = new Map<string, THREE.DataTexture>();

export function rampLutFor(id: string, bands: RampBands): THREE.DataTexture {
  const key = `${id}:${bands.join(',')}`;
  const existing = cache.get(key);
  if (existing) return existing;
  const texture = makeRampLut(bands);
  cache.set(key, texture);
  return texture;
}

/** 测试/调试用：已烤出的色带数量。 */
export function rampLutCount(): number {
  return cache.size;
}
