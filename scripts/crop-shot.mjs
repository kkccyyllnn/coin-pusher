#!/usr/bin/env node
/**
 * 截图放大镜：裁剪 + 最近邻放大一张 PNG。
 *
 * 用法：`node scripts/crop-shot.mjs <src> <out> <x> <y> <w> <h> [scale]`
 *
 * ## 为什么需要它
 *
 * 像素风的画面在 1080p 截图里，单个物件往往只有 **20~70 像素宽**（宝箱 360 mm 在
 * 台面 1.6 m 宽的画面里就那么大）。要判「切面读不读得出 / 边缘光有没有挂上 /
 * 宝箱的拱盖是不是一块平板」，只能放大到像素级看 —— 靠缩略图判等于没判。
 *
 * 不用 `sips`：它只能**居中**裁剪，而看点（宝箱、飞出去的币）从来不在画面正中。
 * 用 `pngjs`（项目已有的 devDependency），不新增依赖。
 *
 * 最近邻放大是刻意的：插值会把像素风的方块糊掉，反而看不清边界。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';

const [src, out, xArg, yArg, wArg, hArg, scaleArg] = process.argv.slice(2);
if (!src || !out) {
  console.error('用法：node scripts/crop-shot.mjs <src> <out> <x> <y> <w> <h> [scale]');
  process.exit(1);
}

const x0 = Number(xArg);
const y0 = Number(yArg);
const w = Number(wArg);
const h = Number(hArg);
const scale = Number(scaleArg ?? 3);

const source = PNG.sync.read(readFileSync(src));
const target = new PNG({ width: w * scale, height: h * scale });

for (let y = 0; y < h * scale; y += 1) {
  for (let x = 0; x < w * scale; x += 1) {
    // 越界坐标夹到边缘：看边缘处的物件时不必手算裁剪框。
    const sx = Math.min(source.width - 1, Math.max(0, x0 + Math.floor(x / scale)));
    const sy = Math.min(source.height - 1, Math.max(0, y0 + Math.floor(y / scale)));
    const from = (sy * source.width + sx) * 4;
    const to = (y * w * scale + x) * 4;
    target.data[to] = source.data[from];
    target.data[to + 1] = source.data[from + 1];
    target.data[to + 2] = source.data[from + 2];
    target.data[to + 3] = 255;
  }
}

writeFileSync(out, PNG.sync.write(target));
console.log(`已保存 ${out}（${w}×${h} 从 (${x0},${y0}) ×${scale}）`);
