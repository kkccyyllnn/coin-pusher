import * as THREE from 'three';
import { type CoinKind } from '../game/kinds';
import { kindSpec } from '../game/kinds';
import { COIN_SKINS, type CoinSkin, type Motif } from '../game/cosmetics';
import { MODEL_TONES, coinModelPalette, isCoinModelKind, type CoinModelKind } from '../entities/coinModels';
import { makeToonMaterial } from '../render/ToonMaterial';

/**
 * 程序化生成**像素化**币面贴图（V4）。
 *
 * ## 尺寸是怎么定的（这里改过一次口径，理由值得留档）
 *
 * 计划里写的是「48px 有字形 / 16px 无字形」，出发点是「字形要够大才不粘笔画」。
 * 但落地时先算了**屏幕占用**：480p 内部渲染下视野约 1.9 米跨 640 像素 → **337 像素/米**，
 * 一枚币直径 0.12 米 → 币在屏幕上只有约 **40 像素**。
 * 也就是说 **48px 的贴图比它显示出来的还大**：texel 与像素接近 1:1，
 * 放大倍率 ≈ 1 → **根本看不出像素化**，而且 Nearest 采样在这个比例下会闪。
 *
 * 所以真正要满足的是「贴图明显小于屏幕占用」，而不是一个绝对像素数。最终取：
 * - **有字形 32px**：32/40 ≈ 0.8 → 约 1.25 倍放大，方块可见；
 *   同时把字形比例从 `size*0.24` 抬到 **0.50**（→ 16px 字），中文笔画才不粘。
 * - **无字形 16px**：16/40 = 0.4 → **2.5 倍放大**，颗粒感最明显。
 *   普通铜币占满盘 318 枚里的 276 枚，像素风的第一印象就是它给的。
 *
 * 两者都是 **2 的幂**：这样 `generateMipmaps` 在任何驱动上都安全
 * （WebGL1 对 NPOT 直接拒绝生成 mipmap）。
 *
 * ## 为什么必须开 mipmap
 *
 * 币在 480p 下只有约 40 像素、而且**一直在转**。纯 `NearestFilter`（无 mipmap）
 * 在缩小采样时会整片闪烁——那才是真正的「脏」。所以：
 * `magFilter = NearestFilter`（放大要方块）+ `minFilter = NearestMipmapNearestFilter`
 * （缩小走 mipmap，不闪）+ `generateMipmaps = true` + `anisotropy = 1`（各向异性会糊掉方块）。
 *
 * ## 逐像素画，不用 `ctx.arc` / 抗锯齿
 *
 * 16×16 上 `ctx.arc` 画出来的圆环会被抗锯齿糊成灰边；字形也会带灰边。
 * 这里全部走 `ImageData` 逐像素判定 + 字形掩码**阈值化**，
 * 保证每个 texel 只有调色板里的确定颜色，放大后是干净的方块。
 *
 * **币面不许印面值。** 返值是「基数 × 热度 × 热区 × 加注 × 闸门概率」，
 * 铜币还有 82% 的概率一分不返——任何数字印在币面上都是骗人的。
 * 这里只印**身份符号**：花纹「桃」、返币「＋」、大赏「赏」、钻石「钻」、宝箱「箱」。
 * 字形取自 `KINDS[kind].glyph`（单一真源），换字只改那一处。
 */

/** 有字形时的纹素边长（2 的幂）。 */
const GLYPH_TEXELS = 32;
/** 无字形（普通铜币）时的纹素边长（2 的幂）。 */
const PLAIN_TEXELS = 16;
/** 字形占贴图边长的比例。0.50 → 32px 贴图上是 16px 字，中文笔画刚好不粘。 */
const GLYPH_RATIO = 0.5;
/** 字形掩码的阈值：把字体抗锯齿的灰边压成硬边。0.55 ≈ 140/255。 */
const GLYPH_ALPHA_CUTOFF = 140;

let globalCoinTexelScale = 1;

/** 设置币面纹素分辨率倍率（1x = 16/32px, 2x = 32/64px, 4x = 64/128px）。 */
export function setCoinTexelScale(scale: number): void {
  globalCoinTexelScale = Math.max(1, Math.min(8, Math.round(scale)));
}

export function getCoinTexelScale(): number {
  return globalCoinTexelScale;
}

/** 该币种用多大的币面贴图。判据与调试都读它，不要在各处重算。 */
export function coinTexels(kind: CoinKind, scale: number = globalCoinTexelScale): number {
  const base = kindSpec(kind).glyph ? GLYPH_TEXELS : PLAIN_TEXELS;
  return base * scale;
}

/** 2×2 有序抖动矩阵。有序（而不是随机）是刻意的：随机噪声在 16×16 上会显得脏。 */
const BAYER2 = [0, 2, 3, 1];

/**
 * 字形掩码：只取「这个像素是不是字的笔画」，颜色留给主循环按调色板填。
 * 单独画在离屏画布上是为了能**阈值化**——直接在成品上叠字没法区分字与底。
 */
function glyphMask(size: number, glyph: string): Uint8Array {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建字形掩码上下文。');

  ctx.fillStyle = '#ffffff';
  ctx.font = `600 ${Math.round(size * GLYPH_RATIO)}px Georgia, serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(glyph, size / 2, size / 2);

  const data = ctx.getImageData(0, 0, size, size).data;
  const mask = new Uint8Array(size * size);
  for (let i = 0; i < mask.length; i += 1) {
    mask[i] = data[i * 4 + 3] > GLYPH_ALPHA_CUTOFF ? 1 : 0;
  }
  return mask;
}

/**
 * 十六进制颜色 → **sRGB 字节**。
 *
 * ⚠️ **不要走 `THREE.Color`。** 开了 `ColorManagement`（默认）之后
 * `new THREE.Color('#c8802f')` 存的是**线性空间**的值；把它 ×255 当成 sRGB 字节
 * 写进 canvas，采样时 three 又会转一次 → **暗两次**。
 * 实测铜币底面从应有的 `#c8802f` 掉到 `#6f2905`，整枚币从「棕铜」变成「暗红」。
 *
 * 直接按字节切分就没有这个问题：canvas 的 `ImageData` 要的就是 sRGB 字节。
 */
function parseHex(hex: string): [number, number, number] {
  const value = hex.replace('#', '');
  return [
    parseInt(value.slice(0, 2), 16),
    parseInt(value.slice(2, 4), 16),
    parseInt(value.slice(4, 6), 16),
  ];
}

/**
 * 纹样掩码：逐纹素判定「这一点是不是纹样的笔画」。
 *
 * ## 为什么纹样留在 canvas 里，而不是按原计划迁进 shader
 *
 * 原计划的理由是「UV 要量化到纹理格才能与 canvas 粒度对齐」。
 * 但换个做法——**把纹样也画进同一张低分辨率 canvas**——对齐是**构造上成立**的：
 * 两者本来就是同一张纹理的同一批纹素，不存在两套采样率需要对齐的问题。
 * 而搬进 shader 会多出一整套 `SD_MOTIF_KIND` 变体（程序数 × 4~5），
 * 还要处理 `vUv` 依赖 `USE_UV`、端面/侧面区分等边角。
 * 收益只是「分辨率无关」，而我们**恰恰不要**分辨率无关——要的就是跟贴图一起像素化。
 *
 * 坐标统一在 [-1, 1] 的圆内（`nx = (x+0.5-half)/half`），与 UV 的内接圆一致。
 * 容差取 **0.62 个纹素**：小于 0.5 会漏掉整条线（线落在两个纹素之间），
 * 大于 0.8 会把相邻笔画粘起来。
 */
function motifMask(motif: Motif, size: number): Uint8Array {
  const mask = new Uint8Array(size * size);
  const half = size / 2;
  const tol = (0.62 * 2) / size; // 归一化坐标下一个纹素的宽度 = 2/size

  // 环的条数随贴图尺寸走：16px 上放 3 条环会挤成实心圆盘。
  const rings = size >= 32 ? [0.44, 0.62, 0.8] : [0.45, 0.72];
  const hexes = size >= 32 ? [0.42, 0.68] : [0.45, 0.74];
  const petals = 8;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const nx = (x + 0.5 - half) / half;
      const ny = (y + 0.5 - half) / half;
      const r = Math.sqrt(nx * nx + ny * ny);
      let on = false;

      switch (motif) {
        case 'rings':
          for (const radius of rings) {
            if (Math.abs(r - radius) < tol) on = true;
          }
          break;

        case 'hex': {
          // 正六边形距离场（平顶）：边界处 = 1。用它做「同心六边形环」。
          const hexD = Math.max(Math.abs(nx) * 0.8660254 + Math.abs(ny) * 0.5, Math.abs(ny));
          for (const radius of hexes) {
            if (Math.abs(hexD - radius) < tol) on = true;
          }
          break;
        }

        case 'waves':
          // 三条水平正弦：nx ∈ [-1,1] 走满两个周期，与原 canvas 版的观感一致。
          for (let row = -1; row <= 1; row += 1) {
            const yc = row * 0.26 + Math.sin(nx * Math.PI * 2) * 0.07;
            if (Math.abs(ny - yc) < tol) on = true;
          }
          break;

        case 'petals':
          // 八瓣：把点变换进每个椭圆的局部坐标系再做单位圆判定。
          for (let i = 0; i < petals; i += 1) {
            const angle = (i / petals) * Math.PI * 2;
            const cos = Math.cos(angle);
            const sin = Math.sin(angle);
            const px = nx - cos * 0.55;
            const py = ny - sin * 0.55;
            const u = px * cos + py * sin;
            const v = -px * sin + py * cos;
            if ((u / 0.15) * (u / 0.15) + (v / 0.08) * (v / 0.08) <= 1) on = true;
          }
          break;

        default:
          break;
      }

      if (on) mask[y * size + x] = 1;
    }
  }
  return mask;
}

/**
 * 币面贴图：底色 + 颗粒 + 纹样 + 滚边 + 字形，全部逐纹素画在**同一张**低分辨率 canvas 上。
 */
export function createCoinTexture(kind: CoinKind, skin: CoinSkin): THREE.CanvasTexture {
  // ★ 尺寸走 `coinTexels()`，**不在这里重算两档** ——
  // 分辨率倍率（`setCoinTexelScale`）必须只有一个消费点，否则加了旋钮会有地方不跟。
  const size = coinTexels(kind);
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建币面贴图上下文。');

  const palette = skin.palette[kind];
  const glyph = kindSpec(kind).glyph;
  const base = parseHex(palette.base);
  const dark = parseHex(palette.dark);
  const ink = parseHex(palette.ink);
  // 颗粒色：base 与 dark 之间约 38% 的一档，用作抖动的第二色。
  const mid: [number, number, number] = [
    Math.round(base[0] + (dark[0] - base[0]) * 0.38),
    Math.round(base[1] + (dark[1] - base[1]) * 0.38),
    Math.round(base[2] + (dark[2] - base[2]) * 0.38),
  ];

  const glyphs = glyph ? glyphMask(size, glyph) : null;
  const motif = motifMask(skin.motif, size);
  const image = ctx.createImageData(size, size);
  const half = size / 2;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const index = y * size + x;
      const offset = index * 4;
      // 采样点取纹素中心（+0.5）：这样圆形边界落在整像素之间，边缘对称。
      const dx = x + 0.5 - half;
      const dy = y + 0.5 - half;
      const nr = Math.sqrt(dx * dx + dy * dy) / half;

      let color: [number, number, number];
      if (nr > 1.0) {
        // ★ 圆外填 `dark`，**不能填透明**。
        //
        // 端面的 UV 是内接圆，圆外确实不会被端面采到——但**圆柱侧面不是**：
        // 侧面的 UV 铺满整张 0..1，四角也在里面。而材质是**不透明**的
        // （`transparent` 未开），alpha 会被直接忽略、只取 RGB。
        // 第一版把圆外留成 RGBA(0,0,0,0)，于是侧面把四角的**纯黑**采样进来，
        // 币从「棕铜」变成「暗红」（实测 `#705010` → `#501010`，绿通道塌掉）。
        color = dark;
      } else if (glyphs && glyphs[index]) {
        // 字形压在一切之上：字必须是最清楚的一层。
        color = ink;
      } else if (nr > 0.9) {
        // 外圈滚边
        color = dark;
      } else if (motif[index]) {
        // 纹样：用 dark 的 78% 强度，免得盖过字形。
        color = [
          Math.round(base[0] + (dark[0] - base[0]) * 0.78),
          Math.round(base[1] + (dark[1] - base[1]) * 0.78),
          Math.round(base[2] + (dark[2] - base[2]) * 0.78),
        ];
      } else {
        // 颗粒：有序抖动在 base 与 mid 之间选一色。
        // 外圈（nr > 0.72）抖得密一点，做出「币面中间平、边缘有压铸纹」的层次。
        const threshold = (BAYER2[(y % 2) * 2 + (x % 2)] + 0.5) / 4;
        color = threshold < (nr > 0.72 ? 0.34 : 0.22) ? mid : base;
      }

      image.data[offset + 0] = color[0];
      image.data[offset + 1] = color[1];
      image.data[offset + 2] = color[2];
      image.data[offset + 3] = 255;
    }
  }

  ctx.putImageData(image, 0, 0);
  return pixelTexture(canvas);
}

/**
 * 像素风贴图的**统一采样设置**。
 *
 * 抽出来的理由（纪律：不写第二份）：`perf` 有一条判据逐币种核这四项
 * （`mag = nearest` / `min = mip-nearest` / `mipmaps = true` / `anisotropy = 1`）。
 * 币面贴图与模型色板图集**必须完全一致**，抄两份就会有一天只改到一份。
 *
 * - 放大要方块（`NearestFilter`）+ 缩小走 mipmap（币一直在转，纯 Nearest 会整片闪）。
 * - 各向异性会把方块糊成椭圆，像素风里必须关掉。
 */
function pixelTexture(canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestMipmapNearestFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 1;
  texture.needsUpdate = true;
  return texture;
}

/**
 * **低多面体模型币的色板图集**（S15）。
 *
 * ## 为什么是图集，不是 `vertexColors`
 *
 * 模型需要 5 档色调（亮/中/深/暗/墨），天然工具是顶点色。但 `perf` 的判据是
 * **已编译程序数 ≤ 20，而现在正好 20（顶格）**：`vertexColors` 会打开 three 的
 * `USE_COLOR` define，**必然多编译一份程序变体** → 21 → 红。
 *
 * 图集把「多色」塞进**既有的 define 集合**（`USE_MAP` + `USE_GRADIENTMAP` + `SD_DETAIL_KIND=0`）
 * 里 —— 程序数与 draw call 都是零增长。配合 `coinModels` 的逐面常量 UV
 * （面内三顶点 UV 相同 ⇒ 导数恒 0 ⇒ 永远采 mip 0），观感与顶点色**逐像素等价**。
 *
 * ## 版面
 *
 * `MODEL_TONES` 的顺序就是从左到右的条序，`toneUv()` 取每条正中。
 * ⚠️ **浅色必须排在左侧**：`perf` 有一条判据读贴图 1/4 处的亮度
 * （守「颜色被转两次」那个 bug），`u = 0.25` 落在第 2 条上 —— 它得是亮档。
 *
 * ## 尺寸
 *
 * 走 `coinTexels(kind)`，与币面贴图**同一个真源**（模型币种带字形 ⇒ 2 的幂）。
 * 于是「纹素尺寸 = 引擎自报期望值」那条判据不用为模型币种开口子。
 */
export function createCoinModelAtlas(kind: CoinModelKind): THREE.CanvasTexture {
  const size = coinTexels(kind);
  const tones = MODEL_TONES.map((tone) => parseHex(coinModelPalette(kind)[tone]));
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建模型色板图集上下文。');

  const image = ctx.createImageData(size, size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      // 条宽 = size / 条数（64 / 5 = 12.8，非整数也无所谓：采样点离边界 ≥ 2 格）。
      const index = Math.min(tones.length - 1, Math.floor((x / size) * tones.length));
      const [r, g, b] = tones[index];
      const offset = (y * size + x) * 4;
      image.data[offset + 0] = r;
      image.data[offset + 1] = g;
      image.data[offset + 2] = b;
      image.data[offset + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return pixelTexture(canvas);
}

/**
 * 币的全局 albedo 缩放（**V4 的必要补偿，不是随手调暗**）。
 *
 * 币的调色板（`COIN_SKINS[].palette`）是在 `MeshStandardMaterial` 时代定的，
 * 那时 `metalness ≈ 0.72` → 漫反射被 `(1 - metalness)` 衰减到约 **0.28**。
 * `MeshToonMaterial` **没有** `metalness`，同一个 albedo 会以约 3.5 倍亮度打出去：
 * 铜币的 R 通道直接过曝削顶、ACES 之后变成**刺眼的红**（实测第一版就是这样）。
 *
 * 所以这里用一个**全局 albedo 缩放**把丢失的那次衰减补回来——
 * 而不是去改调色板：调色板同时是图鉴色卡与玩法识别色，动它代价更大。
 * `#b8b8b8` 的线性值约 **0.47**，比旧的 `1 - metalness`（0.28）略高：
 * 色带本身也带走了一部分亮度（中段只有 0.72 左右），两者叠起来才落在旧观感附近。
 * 第一版取 `#9a9a9a`（0.32）**过暗了**，铜币被压成暗红。
 *
 * **这是「币整体偏亮/偏暗」时唯一该动的旋钮。**
 */
const COIN_ALBEDO_SCALE = '#b8b8b8';

/**
 * 币材质（V4 起走三渲二工厂）。
 *
 * `MeshToonMaterial` **没有** `metalness` / `roughness`，所以币的「金属感」
 * 改由**色带**表达（`CoinSkin.ramp`）——不同外观选不同色带，
 * 厚铜/银锭用硬色阶、青瓷用柔色阶、黑曜偏紫。
 * 存档只存外观 **id**（`coinSkins: string[]`），不存这两个数值，所以换掉没有迁移成本。
 *
 * ## S15：模型币种换成**色板图集**，其余一切不变
 *
 * `diamond` / `chest` 的贴图不再是「画着字形的圆形币面」，而是 5 档色调的色板图集
 * （见 `createCoinModelAtlas`）。**材质参数一个不改** —— 同一个 `map` 通道、
 * 同一份 `ramp`、同一份 `emissive`、同一个 `COIN_ALBEDO_SCALE`。
 * 于是模型币与普通币**共享同一份着色器程序**，`perf` 的程序数不涨。
 */
/**
 * 模型币种的**着色参数**（S16）。
 *
 * 只有钻石与宝箱在这里有值，其余币种走工厂默认（`rimStrength = 0`、`rimEmissiveFloor = 1`）
 * —— **「默认 = 恒等变换」是这套方案能成立的前提**：边缘光的 GLSL 是无条件注入给
 * **所有** toon 材质的（理由见 `ToonMaterial.RIM_DECL`），画面上的差别全部靠这几个 uniform。
 *
 * ## 数值取向（**全部由截图实测反推，不是拍的**）
 *
 * - **钻石**：冷色、低 power（1.5）⇒ 菲涅尔过渡宽，**每个切面整块**被提亮。
 *   配合「逐面法线」（每个切面 NdotV 恒定）就是天然的「切面高光」。
 *   强度给到 1.8，让朝向边缘的切面能顶到色带最亮的一档。
 * - **宝箱**：暖金色、较高 power（2.4）⇒ 过渡窄一些，主要勾轮廓与拱盖的转折。
 * - `emissiveScale` / `emissiveFloor`：**第一版漏了这两个，截出来钻石是一团发光的白球**。
 *   自发光是**与法线无关的平铺加色**，`kinds.ts` 里那两档强度（钻 0.42 / 箱 0.30）
 *   在模型只有 124 mm 时无伤大雅，放大到 216 mm 之后就把逐面差异整个淹没了。
 *   压到 0.40 / 0.45 倍、再让它在正对镜头的面上只剩 22% / 30%，
 *   就成了「边缘发亮、中心通透」——这才是宝石该有的样子。
 *
 * ⚠️ **不动 `kinds.ts` 的 `glow`**：那两个值同时被滚筒灯色（`xixi.ts`）消费，
 * 改它们会把老虎机的灯一起调暗。所以缩放在这里做，只影响币材质。
 */
const MODEL_SHADING: Partial<
  Record<
    CoinKind,
    {
      rimColor: string;
      rimStrength: number;
      rimPower: number;
      emissiveScale: number;
      emissiveFloor: number;
    }
  >
> = {
  diamond: {
    rimColor: '#bff4ff',
    rimStrength: 1.8,
    rimPower: 1.5,
    emissiveScale: 0.4,
    emissiveFloor: 0.22,
  },
  chest: {
    rimColor: '#ffcf7a',
    rimStrength: 1.1,
    rimPower: 2.4,
    emissiveScale: 0.45,
    emissiveFloor: 0.3,
  },
};

export function createCoinMaterial(kind: CoinKind, skin: CoinSkin): THREE.MeshToonMaterial {
  const map = isCoinModelKind(kind)
    ? createCoinModelAtlas(kind as CoinModelKind)
    : createCoinTexture(kind, skin);
  // 自发光（颜色 + 强度）来自 `kinds.ts`：固定值币种靠它一眼认出，
  // 「哪个币亮多少」是币种身份的一部分，不该散在这里的三元链里。
  const glow = kindSpec(kind).glow;
  const shading = MODEL_SHADING[kind];
  return makeToonMaterial({
    name: `coin-${kind}`,
    color: COIN_ALBEDO_SCALE,
    ramp: skin.ramp,
    map,
    emissive: glow?.color ?? '#000000',
    emissiveIntensity: (glow?.intensity ?? 0) * (shading?.emissiveScale ?? 1),
    rimColor: shading?.rimColor,
    rimStrength: shading?.rimStrength,
    rimPower: shading?.rimPower,
    rimEmissiveFloor: shading?.emissiveFloor,
  });
}

export function defaultCoinSkin(): CoinSkin {
  return COIN_SKINS[0];
}
