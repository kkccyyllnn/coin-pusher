/**
 * Arcane 风贴图工厂（S18）。
 *
 * ## 为什么是 `CanvasTexture` 而不是 GLTF/PNG
 *
 * 用户原话：走 Arcane（《英雄联盟：双城之战》）的视觉美学 —
 * "喷墨、油彩手绘感、街头涂鸦、厚涂 (Heavy Impasto)"。
 * 真 Arcane 是逐帧手绘的油画，程序化生成只能近似（厚涂笔触 + 喷墨晕染 +
 * 霓虹描边 + 煤黑底，三层叠加），但走资产文件需要：
 *   ① 用户自己画（要他投入时间 + 风格磨合）
 *   ② 或者模型自己拍一张照片合成（噪声）；两条都不在范围
 *
 * CanvasTexture 一次性画在场内缓存，切换 palette 时重建一次 ≈ 30 ms / 1024×512，
 * 与 S16 共 CoinSpray 的同形态（同一帧里 spawn 的 36 枚视觉币才 5 ms），
 * 换肤成本可承受。
 *
 * ## 为什么不涨已编译程序数
 *
 * 贴图走 `MeshToonMaterial.map` 通道（`USE_MAP` + `mapUv` 通道本来就是 on 的），
 * 与现有所有 toon 材质**完全同 defines**，所以命中同一份 program——
 * `perf` 判据不需要为这件事让步。
 *
 * ## 采样设置
 *
 * 招牌面是玩家的视线焦点（远 / 中距离），`mag=Linear` / `min=LinearMipmap` 更平滑；
 * 得分线 / 热区离相机近、宽度极窄（0.008 / 0.014 米），用 `Nearest` 与该机「像素」
 * 美学一致。两种 filter 是分开的，**不要共用一个工厂**。
 *
 * ## ⚠️ 切肤时必须重建
 *
 * CanvasTexture 是 per-palette 烘的——`applyCabinetSkin` 需要拿 `material.userData`
 * 标记「这材质挂了 map」，并在换肤时**先 cache 旧贴图、再换 palette、新建贴图、
 * 把旧贴图 `dispose()`**。否则旧贴图停在场内被引用，再 `dispose` 会破坏 GPU 资源。
 */
import * as THREE from 'three';

/**
 * Arcane 风调色板 id 的**唯一真源**（S20 起）。
 *
 * ⚠️ 此前 `game/cosmetics.ts` 里另有一份同名同形的联合类型声明 —— 两处没有
 * 编译关联，加 key 时漏改一边**不报错**，只会让「皮肤表能引用的 key」与
 * 「真源里已有的 key」悄悄不一致。现在只在这里声明，`cosmetics.ts` 转发这一份。
 */
export type ArcanePaletteKey = 'jinxMagenta' | 'viArcane' | 'firelight' | 'cobaltArcane';

/**
 * 5 档上色，与现有 `MODEL_TONES` 槽数对齐——
 * `perf` 的色板纹素读回也是「每条正中采样」，顺势沿用。
 *
 * 槽位：`[亮, 辉, 主色, 深色, 煤黑底]` —— 同一份索引语义。
 *
 * ## 四套的配对关系（S20）
 *
 * `jinxMagenta` 与 `cobaltArcane` 是**互为反色的一对**：同一套涂鸦构图，
 * 一个「洋红主色 + 青辉光」，一个「电光蓝主色 + 玫红辉光」。机柜皮肤
 * 「霓虹玫红」用前者、「深海钴蓝」用后者，一眼能读出是同系列的两版。
 *
 * ⚠️ `viArcane` 主色 `#f35b04`（橙）、`firelight` 主色 `#ffb13d`（琥珀）都属
 * 「黄色调」—— 它们是给暖色皮肤留的，**不要再拿去配冷色皮肤**。
 * 去黄的配色方案见 `game/cosmetics.ts` 的 `CABINET_SKINS`。
 */
export const ARCANE_PALETTES: Record<ArcanePaletteKey, readonly [string, string, string, string, string]> = {
  jinxMagenta: ['#f7f5ff', '#22e6e9', '#ff36a6', '#a2125a', '#1a0d1f'],
  viArcane:    ['#f6e8d7', '#4cc9f0', '#f35b04', '#7b1b06', '#0c0a18'],
  firelight:   ['#fff3d6', '#ffb13d', '#e84a5f', '#5b1a1a', '#0a0805'],
  cobaltArcane: ['#e8f4ff', '#ff3d9e', '#2f9bff', '#10365e', '#070b16'],
};

/**
 * 三种笔触都从一个共同入口 `paintBrushes` 画。
 *
 * 详见 `paintThickBrush` / `paintSprayInk` / `paintNeonEdge`：
 * 厚涂 = 多层半透明 Bezier 笔触；
 * 喷墨 = 一堆 RadialGradient；
 * 霓虹 = 主轮廓 + alpha 0.3 外圈重复。
 *
 * ★ S25（R1-M3）加第四种 `lampHousing`：侧板上的**内凹灯位**。
 * 它是「贴图近似版」——Three 没有布尔运算，真凹陷要做围合几何（一圈细边 + 一块
 * 背光底板合并成一个 geometry，+1 draw call）。贴图版**零 draw call、零 program**
 * （同一份 `map` 通道），先看够不够，不够再上几何。
 */
type PaintKind = 'marquee' | 'scoreLine' | 'hotZone' | 'lampHousing';

function paintBase(ctx: CanvasRenderingContext2D, w: number, h: number, ink: string): void {
  /** 煤黑底——整张涂 ink（palette[4]），其它笔触在它上面覆盖。 */
  ctx.fillStyle = ink;
  ctx.fillRect(0, 0, w, h);
}

/**
 * 一堆 `RadialGradient` 圆点（半径 30~80 px、alpha 0.05~0.20）。
 *
 * 角点用伪随机分布，但**种子固定** ⇒ 同一 palette 多次画是同一张。
 */
function paintSprayInk(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  hue: string,
  rng: () => number,
  count: number,
): void {
  for (let i = 0; i < count; i += 1) {
    const cx = rng() * w;
    const cy = rng() * h;
    const r = 30 + rng() * 50;
    const alpha = 0.05 + rng() * 0.15;
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    grad.addColorStop(0, hue);
    grad.addColorStop(0.5, hue);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    // 全局 alpha：分层透明，叠多张不饱和。
    ctx.globalAlpha = alpha;
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

/**
 * 厚涂笔触 = 一条 Bezier 路径，**多层半透明 stroke 叠加**。
 *
 * 第 j 层在原角度 +5° 上偏转，几何上看到笔画是「再来一遍」的厚度。
 * 每层 alpha 0.20~0.28 ⇒ 6 层堆到 ≈ 1.0，正好把底色完全压住。
 */
function paintThickBrush(
  ctx: CanvasRenderingContext2D,
  path: Path2D | { build: (target: CanvasRenderingContext2D, angle: number) => void },
  hue: string,
  hueDeep: string,
  strokes: number,
): void {
  for (let j = 0; j < strokes; j += 1) {
    const alpha = 0.20 + (j / strokes) * 0.08;
    const width = 14 + j * 2;
    ctx.globalAlpha = alpha;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = j % 2 === 0 ? hue : hueDeep;
    if ('build' in path) {
      const target = new Path2D();
      const wrap = { stroke: () => target } as unknown as CanvasRenderingContext2D;
      path.build(wrap as never, j * 0.05);
      ctx.stroke(target);
    } else {
      ctx.stroke(path);
    }
  }
  ctx.globalAlpha = 1;
}

/**
 * 霓虹描边：主轮廓 alpha 1，外圈（大一号的笔画）alpha 0.3 重复 → 描边处有
 * 高对比边缘，远处也能读出来。
 */
function paintNeonEdge(
  ctx: CanvasRenderingContext2D,
  path: Path2D,
  hue: string,
  glow: string,
  mainWidth: number,
  glowWidth: number,
): void {
  ctx.globalAlpha = 0.3;
  ctx.lineWidth = glowWidth;
  ctx.strokeStyle = glow;
  ctx.stroke(path);
  ctx.globalAlpha = 1;
  ctx.lineWidth = mainWidth;
  ctx.strokeStyle = hue;
  ctx.stroke(path);
}

/**
 * 一个可重复的种子化伪随机。
 *
 * 输入是 palette + kind，让同一 (palette, kind) 一定画同一张。
 * 输出 [0, 1)。
 *
 * 用一个简单的 LCG —— 不需要加密学强度，这里只是"看起来别太均匀"。
 */
function makeRng(palette: ArcanePaletteKey, kind: PaintKind, salt: number): () => number {
  let state = ((palette.charCodeAt(0) * 31 + palette.charCodeAt(2)) ^ (kind.charCodeAt(0) * 37 + salt)) >>> 0;
  if (state === 0) state = 1;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/**
 * 招牌面板画布（1024×512）。
 *
 * 视觉构图：
 * 1. 煤黑底铺满。
 * 2. 喷墨：12 个圆点，分布在画面 ±90% 范围内。
 * 3. 厚涂笔触：4 块主色块，模拟「Jinx 字样 + 鱼骨 + 火苗」的 Arcane 风符号。
 * 4. 霓虹描边：每块主色块的轮廓。
 */
function paintMarqueeCanvas(
  ctx: CanvasRenderingContext2D,
  palette: readonly [string, string, string, string, string],
  key: ArcanePaletteKey,
): void {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  const [light, glow, hue, deep, ink] = palette;
  const rng = makeRng(key, 'marquee', 1);

  paintBase(ctx, w, h, ink);

  // 喷墨：12 个圆点（深 / 浅两套，互不重合，让画面感是两层墨）
  paintSprayInk(ctx, w, h, hue, rng, 8);
  paintSprayInk(ctx, w, h, deep, rng, 6);

  // 厚涂色块路径——4 个手绘式 Arcane 风符号
  // (1) 主字形「JINX」：中央一长横 + 一个钩，模拟血涂鸦。
  const mainLetter = new Path2D();
  mainLetter.moveTo(w * 0.18, h * 0.62);
  mainLetter.quadraticCurveTo(w * 0.34, h * 0.62, w * 0.42, h * 0.5);
  mainLetter.quadraticCurveTo(w * 0.46, h * 0.46, w * 0.50, h * 0.5);
  mainLetter.quadraticCurveTo(w * 0.54, h * 0.54, w * 0.50, h * 0.6);
  mainLetter.lineTo(w * 0.46, h * 0.62);
  paintThickBrush(ctx, mainLetter, hue, deep, 6);

  // (2) 鱼骨线条（左上）：斜对角不规则段。
  const fishBone = new Path2D();
  fishBone.moveTo(w * 0.05, h * 0.25);
  fishBone.lineTo(w * 0.32, h * 0.18);
  for (let i = 0; i < 5; i += 1) {
    fishBone.moveTo(w * (0.08 + i * 0.05), h * (0.25 - i * 0.012));
    fishBone.lineTo(w * (0.05 + i * 0.05), h * (0.18 - i * 0.012));
  }
  paintThickBrush(ctx, fishBone, hue, deep, 5);

  // (3) 火苗轮廓（右下）：三角 + 半圆，模拟 Arcane 的喷枪叠涂。
  const flames = new Path2D();
  flames.moveTo(w * 0.78, h * 0.4);
  flames.bezierCurveTo(w * 0.95, h * 0.45, w * 0.98, h * 0.65, w * 0.92, h * 0.85);
  flames.bezierCurveTo(w * 0.86, h * 0.95, w * 0.78, h * 0.93, w * 0.74, h * 0.85);
  flames.bezierCurveTo(w * 0.7, h * 0.7, w * 0.72, h * 0.5, w * 0.78, h * 0.4);
  paintThickBrush(ctx, flames, hue, deep, 6);

  // (4) 中央重笔：粗长方形 + 主字形，模拟喷枪溅出的色块。
  const bulk = new Path2D();
  bulk.rect(w * 0.58, h * 0.45, w * 0.3, h * 0.18);
  paintThickBrush(ctx, bulk, hue, deep, 7);

  // 霓虹描边：让所有主色块外圈加一圈高对比辉光（远距离也能读出来）。
  paintNeonEdge(ctx, mainLetter, light, glow, 6, 18);
  paintNeonEdge(ctx, flames, light, glow, 5, 14);
  paintNeonEdge(ctx, bulk, light, glow, 4, 12);
}

/**
 * 得分线条画布（细条形 1024×32）。
 *
 * 横贯式笔触 + 中段霓虹——得分线现在是 1.32 米 × 0.008 米 × 0.03 米，
 * 画面上是横着一条亮线，宽度 0.008 米在 ×1.2 档下约 5 个像素厚，
 * 太厚的厚涂笔触会糊，所以这里**只用喷墨 + 霓虹描边两道**。
 */
function paintScoreLineCanvas(
  ctx: CanvasRenderingContext2D,
  palette: readonly [string, string, string, string, string],
  key: ArcanePaletteKey,
): void {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  const [, , hue, deep, ink] = palette;
  const rng = makeRng(key, 'scoreLine', 2);

  paintBase(ctx, w, h, ink);
  paintSprayInk(ctx, w, h, hue, rng, 18);

  // 霓虹横纹：2~3 道主色斜线，模拟断裂的霓虹管。
  for (let i = 0; i < 3; i += 1) {
    const y = h * 0.25 + i * h * 0.25;
    const path = new Path2D();
    path.moveTo(0, y);
    path.bezierCurveTo(w * 0.25, y + h * 0.3, w * 0.55, y - h * 0.2, w, y + (i - 1) * h * 0.2);
    paintNeonEdge(ctx, path, hue, deep, 3, 9);
  }
}

/**
 * 热区条画布（与得分线同形，但颜色不同——hotZone 走 firelight / 红）。
 *
 * 因为得分线和热区都用 `accent` 色带 + 自发光，效果接近，
 * 这里的判据让两者**必须**色调不一致，否则换肤看起来是同一块。
 */
function paintHotZoneCanvas(
  ctx: CanvasRenderingContext2D,
  palette: readonly [string, string, string, string, string],
  key: ArcanePaletteKey,
): void {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  const [, , hue, deep, ink] = palette;
  const rng = makeRng(key, 'hotZone', 3);

  paintBase(ctx, w, h, ink);
  paintSprayInk(ctx, w, h, hue, rng, 14);

  // 霓虹横纹：短促、密集（热区识别色 = 警惕）
  for (let i = 0; i < 6; i += 1) {
    const y = (i + 0.5) * (h / 6);
    const path = new Path2D();
    path.moveTo(w * 0.05, y);
    path.lineTo(w * 0.95, y + (i % 2 === 0 ? h * 0.1 : -h * 0.1));
    paintNeonEdge(ctx, path, hue, deep, 3, 9);
  }
}

/**
 * 圆角矩形路径。
 *
 * 不直接用 `ctx.roundRect`：那是较新的 API，而 `cabinetTex` 判据要跑在 WebKit 上
 * （Playwright 的 `mobile-safari` 项目）。`Path2D` 是这里所有笔触的公共形状语言，
 * `paintNeonEdge` / `paintThickBrush` 都吃它。
 */
function roundRectPath(x: number, y: number, w: number, h: number, r: number): Path2D {
  const path = new Path2D();
  const radius = Math.min(r, w / 2, h / 2);
  path.moveTo(x + radius, y);
  path.lineTo(x + w - radius, y);
  path.quadraticCurveTo(x + w, y, x + w, y + radius);
  path.lineTo(x + w, y + h - radius);
  path.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  path.lineTo(x + radius, y + h);
  path.quadraticCurveTo(x, y + h, x, y + h - radius);
  path.lineTo(x, y + radius);
  path.quadraticCurveTo(x, y, x + radius, y);
  path.closePath();
  return path;
}

/**
 * 侧板灯饰画布（512×608，R1-M3 的「内凹灯位」贴图近似版）。
 *
 * ## 三层假出凹陷（Three 没有布尔运算）
 *
 * 1. **井壁**：整块 `deep`（调色板第 4 档）外框 —— 凹陷的暗边。
 * 2. **内腔**：`deep → ink` 的垂直渐变，上缘受光、越深越暗 ⇒ 读作「凹进去」。
 * 3. **灯管**：内腔中线一条 `light` 实心条，背后先铺一层 `glow` 径向光晕；
 *    最后给内腔轮廓走 `paintNeonEdge`（高对比边缘，斜视角也读得出「这里有灯」）。
 *
 * ## 构图为什么铺满整张画布
 *
 * 侧墙的 UV 由剖面归一化而来（见 `TableBuilder.cabinetPrismMesh`），但 `ExtrudeGeometry`
 * 的默认 UV 生成器会**自己挑轴**，「哪一条带被玩家看到」不是能稳定推出的量。
 * 实测把灯位压在画布上半时，游玩视角看到的是下半的涂鸦底色 —— 灯位整块看不见。
 * 所以灯位均匀铺满全高：任何可见切片上都有灯。
 */
function paintLampHousingCanvas(
  ctx: CanvasRenderingContext2D,
  palette: readonly [string, string, string, string, string],
  key: ArcanePaletteKey,
): void {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  const [light, glow, hue, deep, ink] = palette;
  const rng = makeRng(key, 'lampHousing', 4);

  paintBase(ctx, w, h, ink);
  paintSprayInk(ctx, w, h, deep, rng, 8);

  /**
   * 灯位**铺满整张画布**，不压在任何「可见带」里。
   *
   * 这里刻意不留「只画上半截」那种优化：端面 UV 的 v 到底对应剖面的 y 还是 z，
   * 取决于 `ExtrudeGeometry` 走的是 `generateTopUV` 还是 `generateSideWallUV`
   * （它按相邻顶点的 Δx/Δy 大小**自己选轴**）。实测把构图压在画布顶部 42%，
   * 游玩视角看到的仍是画布**下半**的涂鸦 —— 也就是选错了带，灯饰整块被平均成一坨暗斑。
   * 与其再猜一次带，不如让**任何**可见切片上都至少有一条灯管：代价是灯位从 2 个变 3 个、
   * 每格略小，换来的是这条构图不再依赖一个我没验证过的 UV 假设。
   */
  const wells = 3;
  const wellH = h * 0.15;
  const gap = (h - wellH * wells) / (wells + 1);
  const side = w * 0.16;
  const wellW = w - side * 2;

  // 井间涂鸦：Arcane 的街头感靠几道斜笔撑，但**不抢灯饰**——只用主色 / 深色两档，
  // 而且画在灯位**之前**（灯管压在上面），否则灯位铺满全画布后每道笔都会夹在灯缝里。
  for (let i = 0; i < 4; i += 1) {
    const y = h * (0.12 + i * 0.22);
    const tag = new Path2D();
    tag.moveTo(w * (0.1 + rng() * 0.1), y);
    tag.quadraticCurveTo(w * 0.5, y - h * 0.05, w * (0.62 + rng() * 0.26), y + h * 0.02);
    paintThickBrush(ctx, tag, i % 2 === 0 ? hue : deep, ink, 4);
  }

  for (let i = 0; i < wells; i += 1) {
    const y = gap * (i + 1) + wellH * i;
    // ① 井壁
    ctx.fillStyle = deep;
    ctx.fill(roundRectPath(side, y, wellW, wellH, wellH * 0.28));
    // ② 内腔（渐变 = 深度）
    const inset = wellH * 0.2;
    const cavity = roundRectPath(
      side + inset,
      y + inset,
      wellW - inset * 2,
      wellH - inset * 2,
      wellH * 0.2,
    );
    const depth = ctx.createLinearGradient(0, y, 0, y + wellH);
    depth.addColorStop(0, deep);
    depth.addColorStop(1, ink);
    ctx.fillStyle = depth;
    ctx.fill(cavity);
    // ③ 光晕 + 灯管
    const cx = side + wellW / 2;
    const cy = y + wellH / 2;
    const halo = ctx.createRadialGradient(cx, cy, 0, cx, cy, wellW * 0.42);
    halo.addColorStop(0, glow);
    halo.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.globalAlpha = 0.75;
    ctx.fillStyle = halo;
    ctx.fill(cavity);
    ctx.globalAlpha = 1;
    // 灯管**必须画得粗**（0.3 倍井高，不是「真实灯管」的比例）：侧墙是斜着看的，
    // 一个 minification 层级就把细线整个平均掉了 —— 实测细管版本在游玩视角只剩
    // 一坨暗斑，「灯饰」这件事完全读不出来。粗一点 + 高 alpha 才活得过 mipmap。
    const tubeH = wellH * 0.3;
    ctx.fillStyle = light;
    ctx.fill(
      roundRectPath(
        side + inset * 2,
        cy - tubeH / 2,
        wellW - inset * 4,
        tubeH,
        tubeH / 2,
      ),
    );
    // ④ 霓虹描边：内腔轮廓
    paintNeonEdge(ctx, cavity, light, glow, 3, 12);
  }
}

/**
 * 侧板灯饰贴图（512×608）。
 *
 * 高宽比按**侧墙内表面的实际跨度**挑：z 跨度 ≈ 1.60 米、y 跨度 ≈ 1.90 米 ⇒ 0.84:1。
 * 取 512×608（0.842）而不是 512×512，否则三个灯位会被垂直压扁 16%。
 * ⚠️ 这条比例只在 `cabinetPrismMesh` 把剖面 UV 归一化到 0..1 之后成立。
 *
 * filter 与招牌同档（`Linear` + mipmap）：侧板是斜着看的大面，方块感来自得分线那种
 * 极窄条，不来自这里。
 */
export function createArcaneLampHousingTexture(
  paletteKey: ArcanePaletteKey,
  width = 512,
  height = 608,
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建机柜灯饰贴图上下文。');
  paintLampHousingCanvas(ctx, ARCANE_PALETTES[paletteKey], paletteKey);
  const texture = makeTexture(canvas, THREE.LinearFilter, THREE.LinearMipmapLinearFilter);
  // 侧墙是**斜着看**的大面：一个纹素覆盖的屏幕面积在横向被压得很扁，各向异性过滤
  // 是同时保住两个方向采样密度的唯一手段（three 会按 `getMaxAnisotropy()` 夹住，
  // 写高了不会坏）。招牌不需要它——檐板基本正对相机。
  texture.anisotropy = 8;
  return texture;
}

/**
 * 给 `CanvasTexture` 设好采样 + 色彩空间 + 自动 mipmap。
 *
 * 与 `pixelTexture`（`coinTexture.ts`）的差别：
 * - 招牌走 `Linear`（玩家远看，要平滑）
 * - 得分线 / 热区走 `Nearest`（像素风、宽度极窄，方块感就是识别色）
 *
 * 三个工厂分别对应，不要共用。
 */
function makeTexture(
  canvas: HTMLCanvasElement,
  magFilter: THREE.MagnificationTextureFilter,
  minFilter: THREE.MinificationTextureFilter,
): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = magFilter;
  texture.minFilter = minFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 1;
  texture.needsUpdate = true;
  return texture;
}

/**
 * 招牌贴图（1024×512）。
 *
 * 默认尺寸按招牌实际尺寸（1.84 × 0.66 米 ≈ 2.8:1）+ toon 阴影对贴图拉伸的容忍挑 2:1。
 */
export function createArcaneMarqueeTexture(
  paletteKey: ArcanePaletteKey,
  width = 1024,
  height = 512,
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建机柜招牌贴图上下文。');
  paintMarqueeCanvas(ctx, ARCANE_PALETTES[paletteKey], paletteKey);
  return makeTexture(canvas, THREE.LinearFilter, THREE.LinearMipmapLinearFilter);
}

/** 得分线贴图（1024×32，距相机近、宽度极窄，走 Nearest 与像素美学一致）。 */
export function createArcaneScoreLineTexture(paletteKey: ArcanePaletteKey): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 32;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建机柜得分线贴图上下文。');
  paintScoreLineCanvas(ctx, ARCANE_PALETTES[paletteKey], paletteKey);
  return makeTexture(canvas, THREE.NearestFilter, THREE.NearestMipmapNearestFilter);
}

/** 热区条贴图（与得分线同形同 filter，palette 不同）。 */
export function createArcaneHotZoneTexture(paletteKey: ArcanePaletteKey): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 32;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建机柜热区贴图上下文。');
  paintHotZoneCanvas(ctx, ARCANE_PALETTES[paletteKey], paletteKey);
  return makeTexture(canvas, THREE.NearestFilter, THREE.NearestMipmapNearestFilter);
}

/**
 * 5 档调色板的常量数量，与 `MODEL_TONES.length` 对齐。
 *
 * `cabinet-tex` 判据据此检查「图集 5 档都落在预期槽」。
 */
export const ARCANE_PALETTE_SLOTS = 5 as const;
