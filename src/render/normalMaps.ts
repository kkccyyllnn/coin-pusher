import * as THREE from 'three';

/**
 * 程序化法线贴图（R2-T1 的最后一项，也是**唯一破例项**）。
 *
 * ## 为什么它是破例
 *
 * R2 的整条纪律是「同 program 内扩表达力」：加 uniform 不加 define ⇒ 不新增编译变体
 * （双色 rim、matcap-lite、背面色带都是这么做的）。法线贴图做不到 ——
 * 一旦 `material.normalMap` 非空，three 就点亮 `USE_NORMALMAP_TANGENTSPACE`，
 * **多一个 define ⇒ 多一份程序**。计划因此把它单独切成一次提交，
 * 并且预先写好放弃条件：程序数从 24 涨到 ≥ 29 就整块撤掉。
 *
 * ## 为什么还是值得试
 *
 * 前面几条扩参全都作用在**着色**上（色带、边缘、高光），没有一条能改**轮廓受光**：
 * 低多面体的面是纯平的，光照一过就是一整块同色，近看是「塑料贴片」。
 * 法线扰动是唯一能在不动几何的前提下让平面上出现真实的明暗起伏的手段。
 *
 * ## 三条实现约束
 *
 * 1. **只给已经有 `map` 的面用。** 切线空间法线要 UV 与切线帧；带 `map` 的材质
 *    `USE_MAP + mapUv` 本来就开着，UV 是现成的。给无 UV 约定的件挂它会引入新变量，
 *    而这一项本来就要盯的只有「程序数」一个读数。
 * 2. **`repeat` 与 `wrap` 由调用方设**，本工厂只负责画一张 `[-1,1]` 编码好的图。
 * 3. **模块级缓存**：材质是逐件建的，没有缓存就会烤出几十张同样的法线图
 *    （与 `RampLut.rampLutFor` 同一个理由）。
 */

export type SurfaceNormalKind = 'brushed' | 'hammered';

/** 画布边长。128 足够让「每条纹 4 px」这种密度落进可分辨区间，又只有 64 KB。 */
const SIZE = 128;

function hash(x: number, y: number, salt: number): number {
  // CPU 侧 float64，用 sin 没有精度问题（GLSL 那条「不要 sin-hash」的禁令针对的是
  // 移动端 mediump 片元精度，不适用于这里的一次性烘焙）。
  const s = Math.sin(x * 127.1 + y * 311.7 + salt * 74.7) * 43758.5453;
  return s - Math.floor(s);
}

/**
 * 高度场（0~1）。两种纹样都是**各向异性 + 低频起伏**的叠加：
 * `brushed` 沿 x 拉长的细纹（金属拉丝），`hammered` 是稀疏的浅凹（钣金锤痕）。
 */
function height(kind: SurfaceNormalKind, x: number, y: number): number {
  const u = x / SIZE;
  const v = y / SIZE;
  if (kind === 'brushed') {
    const streak = hash(Math.floor(u * SIZE), Math.floor(v * 8), 1);
    const wave = 0.5 + 0.5 * Math.sin(v * Math.PI * 2 * 3.0);
    return 0.5 + (streak - 0.5) * 0.7 + (wave - 0.5) * 0.12;
  }
  const cellX = u * 6.0;
  const cellY = v * 6.0;
  const cx = Math.floor(cellX);
  const cy = Math.floor(cellY);
  // 3×3 邻域里找最近的锤痕中心：每个凹坑是一个余弦碗。
  let best = 0;
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      const px = cx + dx + hash(cx + dx, cy + dy, 2);
      const py = cy + dy + hash(cx + dx, cy + dy, 3);
      const d = Math.hypot(cellX - px, cellY - py);
      best = Math.max(best, d < 0.42 ? Math.cos((d / 0.42) * Math.PI * 0.5) : 0);
    }
  }
  return 0.5 - best * 0.5 + (hash(cx, cy, 4) - 0.5) * 0.06;
}

const cache = new Map<SurfaceNormalKind, THREE.DataTexture>();

/**
 * 取某个纹样的切线空间法线图（同一种只烤一次）。
 *
 * 法线由高度场**中心差分**得到，再按 `STRENGTH` 缩放倾斜量 —— 直接用法线贴图
 * 而不是让 three 去解算高度，是因为 `MeshToonMaterial` 没有高度贴图通道。
 */
export function surfaceNormalMap(kind: SurfaceNormalKind): THREE.DataTexture {
  const existing = cache.get(kind);
  if (existing) return existing;

  // 倾斜强度：0.35 是「近看有起伏、远看不脏」的一档。再高一档平面上就出现噪点感。
  const strength = 0.35;
  const heights = new Float32Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      heights[y * SIZE + x] = height(kind, x, y);
    }
  }
  const at = (x: number, y: number): number =>
    heights[((y + SIZE) % SIZE) * SIZE + ((x + SIZE) % SIZE)];

  const data = new Uint8Array(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      // 未归一化的 (−dx, −dy, 1) 编码进 [0,1]。归一化留给采样端，这里只要方向对。
      const index = (y * SIZE + x) * 4;
      data[index] = Math.round((Math.max(-1, Math.min(1, -dx)) * 0.5 + 0.5) * 255);
      data[index + 1] = Math.round((Math.max(-1, Math.min(1, -dy)) * 0.5 + 0.5) * 255);
      data[index + 2] = 255;
      data[index + 3] = 255;
    }
  }

  const texture = new THREE.DataTexture(data, SIZE, SIZE, THREE.RGBAFormat);
  texture.name = `surface-normal-${kind}`;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  // 与色带同理：拉丝纹要硬边，线性过滤会把它糊成灰雾。
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  // 法线图是**向量**数据，绝不能按 sRGB 解（否则 Z 分量被 gamma 拉偏，光照整体歪）。
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;
  cache.set(kind, texture);
  return texture;
}

/** 调试用：已烤出的法线图数量。 */
export function surfaceNormalMapCount(): number {
  return cache.size;
}
