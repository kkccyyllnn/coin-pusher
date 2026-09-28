import * as THREE from 'three';
import { ICON_EXPECTED, ICON_IDS, PIXEL_ICONS, type IconId } from '../game/icons';

/**
 * 像素图标的贴图生成（P10）—— 对标 `src/utils/coinTexture.ts` 的写法。
 *
 * ## 与币面贴图的共同纪律
 *
 * 1. **同步生成、无资源加载器。** 项目里没有任何异步加载路径，挂一张 PNG 会引入
 *    首帧空窗与一条新的失败分支（见 `scripts/build-icons.mjs` 的推导）。
 * 2. **逐纹素写 `ImageData`，不用 `ctx.arc` / 抗锯齿。** 每个纹素只能是调色板里的
 *    确定颜色，放大后才是干净的方块。
 * 3. **★ 颜色直取十六进制字节，绝不过 `THREE.Color`。** 开了 `ColorManagement` 之后
 *    `new THREE.Color('#f97019')` 存的是**线性值**，再 ×255 当 sRGB 字节写进 canvas
 *    会**暗两次**（MEMORY 记过两次同款事故）。canvas 的 `ImageData` 要的就是 sRGB 字节。
 *
 * ## 为什么图标不做缩放
 *
 * 源图是 32×32，滚筒窗的世界尺寸刻意做成「32 后备像素」——**1:1**。
 * 非整数缩放（32 → 24）会让像素画出现宽窄不一的像素行，是像素风最刺眼的缺陷。
 * 需要改大小就改窗口的**世界尺寸**（见 `SlotMachine.REEL_WINDOW`），不要缩放贴图。
 */

/** 一个图标在贴图里的纹素边长（= 源图尺寸）。 */
export const ICON_TEXELS = ICON_EXPECTED.size;

/**
 * 滚筒环带贴图尺寸：**竖排** 6 格。
 *
 * 竖排而不是横排，是因为贴图是**绕着圆柱周向**铺的——不，是因为滚筒窗用的是
 * 「贴图纵向滚动」：`repeat.y = 1/格数` 让窗口一次只看到一格，
 * 动 `offset.y` 就是滚动。横排的话要动 `offset.x`，与「从上往下滚」的直觉相反。
 */
export function reelStripSize(tiles: number = ICON_EXPECTED.count): { width: number; height: number } {
  return { width: ICON_TEXELS, height: ICON_TEXELS * tiles };
}

/**
 * 停在第 `index` 格时该写的 `texture.offset.y`。
 *
 * ★ 方向推导（这里错一次就要靠截图来回试，所以写清楚）：
 * `CanvasTexture` 默认 `flipY = true` → **画布顶行对应 v = 1**。
 * 环带把第 0 格画在画布最上方，于是第 `index` 格占据
 * `v ∈ [1 - (index+1)/tiles, 1 - index/tiles]`。
 * 窗口宽度是 `repeat.y = 1/tiles`，取 `offset.y = 1 - (index+1)/tiles = (tiles-1-index)/tiles`
 * 正好框住它。
 */
export function reelOffsetFor(index: number, tiles: number = ICON_EXPECTED.count): number {
  return (tiles - 1 - index) / tiles;
}

/** 十六进制 → sRGB 字节三元组。**不过 `THREE.Color`**（见文件头纪律 3）。 */
function parseHex(hex: string): [number, number, number] {
  const value = hex.replace('#', '');
  return [
    parseInt(value.slice(0, 2), 16),
    parseInt(value.slice(2, 4), 16),
    parseInt(value.slice(4, 6), 16),
  ];
}

/** 图标左上角的颜色 —— 它自带纯色底，这个颜色就是「徽章底色」。 */
export function iconBackground(id: IconId): [number, number, number] {
  const icon = PIXEL_ICONS[id];
  return parseHex(icon.palette[parseInt(icon.pixels[0], 16)]);
}

/**
 * 把一个图标画进 `ImageData` 的指定矩形，**最近邻缩放**。
 *
 * `shade` 是逐像素的亮度系数（1 = 原色）。滚筒用它烘「上下暗、中间亮」的弧度感；
 * 徽章不用（给 `undefined`）。
 */
function paintIcon(
  image: ImageData,
  id: IconId,
  originX: number,
  originY: number,
  targetW: number,
  targetH: number,
  shade?: (nx: number, ny: number) => number,
): void {
  const icon = PIXEL_ICONS[id];
  const palette = icon.palette.map(parseHex);

  for (let y = 0; y < targetH; y += 1) {
    // 目标像素 → 源像素（取源像素中心，避免整体偏移半格）
    const sy = Math.min(icon.h - 1, Math.floor(((y + 0.5) / targetH) * icon.h));
    for (let x = 0; x < targetW; x += 1) {
      const sx = Math.min(icon.w - 1, Math.floor(((x + 0.5) / targetW) * icon.w));
      const color = palette[parseInt(icon.pixels[sy * icon.w + sx], 16)];
      if (!color) throw new Error(`图标 ${id} 的索引越界 @ (${sx}, ${sy})`);
      const k = shade ? shade((x + 0.5) / targetW, (y + 0.5) / targetH) : 1;
      const offset = ((originY + y) * image.width + originX + x) * 4;
      image.data[offset + 0] = Math.min(255, Math.round(color[0] * k));
      image.data[offset + 1] = Math.min(255, Math.round(color[1] * k));
      image.data[offset + 2] = Math.min(255, Math.round(color[2] * k));
      image.data[offset + 3] = 255;
    }
  }
}

/**
 * 滚筒弧度感：**按格为周期**的纵向明暗。
 *
 * ★ 为什么可以烘进贴图（而不是另加一块渐变几何）：
 * 窗口高度 = 一格的纹素高度（`repeat.y = 1/格数`），所以**渐变周期与窗口周期相同**——
 * 无论 `offset.y` 滚到哪，窗口里看到的明暗分布都是同一副「中间亮、上下暗」。
 * 滚动时它不会跟着图标跑（看起来是固定的筒壁明暗），静止时每格都居中透亮。
 * 换任何别的周期都会让暗带随图标滚动，那就露馅了。
 */
function drumShade(_nx: number, ny: number): number {
  const d = Math.abs(ny - 0.5) * 2; // 0 = 格中，1 = 格边
  return 1 - 0.34 * d * d;
}

/**
 * 滚筒环带贴图：把 `order` 里的图标**从上到下**竖排在一条 32×192 的贴图上。
 *
 * 采样设置与币面贴图一致：放大要方块（`NearestFilter`），缩小走 mipmap
 * （`?pixel=3/4` 下窗口会小于 32 像素，纯 Nearest 会整片闪）。
 */
export function createReelStripTexture(
  order: readonly IconId[] = ICON_IDS,
): THREE.CanvasTexture {
  const { width, height } = reelStripSize(order.length);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建滚筒环带贴图上下文。');

  const image = ctx.createImageData(width, height);
  order.forEach((id, index) => {
    paintIcon(image, id, 0, index * ICON_TEXELS, ICON_TEXELS, ICON_TEXELS, drumShade);
  });
  ctx.putImageData(image, 0, 0);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestMipmapNearestFilter;
  texture.generateMipmaps = true;
  // 各向异性会把方块糊成椭圆，像素风里必须关掉（同币面贴图）。
  texture.anisotropy = 1;
  // 一次只看到一格：`repeat.y` 与滚动用的 `offset.y` 都建立在这一点上。
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(1, 1 / order.length);
  texture.offset.set(0, reelOffsetFor(0, order.length));
  texture.needsUpdate = true;
  return texture;
}

/**
 * XIXI 标牌徽章的**图标纹素边长**：32 的一半。
 *
 * 为什么不直接按 32 生成：段高 0.14 米在 1280×720 下只占约 16 后备像素
 * （推板前立面处约 113 后备像素/米，见 `Pusher` 的推导），
 * 按 32 生成再让 GPU 缩到 16 是**非整数**缩放，像素画会出现宽窄不一的像素行。
 * 先在贴图里做一次**整数**减半（32 → 16），GPU 那一步就变成 1:1。
 */
export const XIXI_BADGE_ICON_TEXELS = 16;

/**
 * 徽章贴图的纹素尺寸：图标那一档固定为 `XIXI_BADGE_ICON_TEXELS`，
 * 横向按条子的**世界比例**补足（图标居中、两侧是底色）。
 *
 * 这样贴图与条子**同比例**，`BoxGeometry` 上贴图不会被拉扁；
 * 反过来若固定成方形贴图贴到宽条上，叉会被横向拉长成 2.4:1。
 */
export function xixiBadgeSize(
  worldWidth: number,
  worldHeight: number,
): { width: number; height: number } {
  const height = XIXI_BADGE_ICON_TEXELS;
  return { width: Math.max(height, Math.round((height * worldWidth) / worldHeight)), height };
}

/**
 * 徽章贴图：把图标**等比**画进任意纹素尺寸的画布，四周补徽章底色。
 *
 * 用途是 XIXI 标牌——那四段是宽条，若把 32×32 的图标直接铺上去
 * 会被横向拉成 2.33:1。所以贴图尺寸按条的比例生成（见 `xixiBadgeSize`），
 * 图标只按**高度**等比缩放并居中，两侧补底色：图标本身不失真，
 * 条子仍然是一整块连续徽章。
 */
export function createBadgeTexture(id: IconId, width: number, height: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建徽章贴图上下文。');

  const background = iconBackground(id);
  const image = ctx.createImageData(width, height);
  for (let i = 0; i < width * height; i += 1) {
    image.data[i * 4 + 0] = background[0];
    image.data[i * 4 + 1] = background[1];
    image.data[i * 4 + 2] = background[2];
    image.data[i * 4 + 3] = 255;
  }

  // 等比：图标边长取条高与条宽的较小者，居中。
  const side = Math.min(width, height);
  paintIcon(image, id, Math.round((width - side) / 2), Math.round((height - side) / 2), side, side);
  ctx.putImageData(image, 0, 0);

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
 * 判据读数（**判据读它，不读截图**）。
 *
 * 「图标是不是从图集来的」「调色板有没有超 16 色」这类缺陷在截图上只表现为
 * 「颜色有点脏」，肉眼反推要来回试很多轮；读出来就是一组可枚举的数。
 */
export function iconReport(): {
  ids: readonly IconId[];
  size: number;
  paletteMax: number;
  paletteSizes: number[];
  /**
   * 每格的**底色**（sRGB 十六进制）——**名字 → 像素的身份读数**。
   *
   * 这是唯一能抓住「切格顺序错位」的读数：那种缺陷下所有计数（6 格 / 32×32 / 12 色）
   * 全都正常，只有底色会暴露「叫 carrot 的那一格其实是宝箱」。
   * 判据按**色相族**比对（橙 / 绿 / 蓝 / 奶黄…），不写死十六进制——
   * 写死就变成了第二份真源，换个图集还要改测试。
   */
  backgrounds: string[];
  strip: { width: number; height: number };
} {
  return {
    ids: ICON_IDS,
    size: ICON_EXPECTED.size,
    paletteMax: ICON_EXPECTED.paletteMax,
    paletteSizes: ICON_IDS.map((id) => PIXEL_ICONS[id].palette.length),
    backgrounds: ICON_IDS.map((id) => {
      const [r, g, b] = iconBackground(id);
      return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
    }),
    strip: reelStripSize(),
  };
}
