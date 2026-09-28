#!/usr/bin/env node
/**
 * 图集目视核对（临时诊断脚本，不属于验证链）。
 *
 * 存在的理由：`iconReport()` 只能证明「有 6 格、每格 32×32、调色板 ≤16 色」，
 * 证明不了**哪一格是哪张图**。切格顺序错位时所有计数都正常，
 * 只有把像素画出来才看得出来。所以这里把解码结果写成 PNG 供人眼比对：
 *
 *   shots/atlas-raw.png    图集原样（按像素排列，不做任何重排）
 *   shots/atlas-icons.png  按 ICON_IDS 顺序切出来的 6 格（代码**以为**的顺序）
 *
 * 两张图逐格一致 → 切格正确；不一致 → `ICON_IDS` 与图集实际顺序不符。
 *
 * 用法：`node scripts/dump-atlas.mjs`
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { inflateSync, deflateSync } from 'node:zlib';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCALE = 6;

// ── PNG 解码（与 build-icons.mjs 同源，只支持 8bit / colorType 2 / 非隔行）──
function decodePng(buffer) {
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (buffer[24] !== 8 || buffer[25] !== 2 || buffer[28] !== 0) throw new Error('图集格式不支持');
  const idat = [];
  for (let pos = 8; pos < buffer.length; ) {
    const length = buffer.readUInt32BE(pos);
    const type = buffer.toString('ascii', pos + 4, pos + 8);
    if (type === 'IDAT') idat.push(buffer.subarray(pos + 8, pos + 8 + length));
    else if (type === 'IEND') break;
    pos += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 3;
  const out = Buffer.alloc(width * height * 3);
  let prev = Buffer.alloc(stride);
  let cursor = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[cursor];
    cursor += 1;
    const line = Buffer.from(raw.subarray(cursor, cursor + stride));
    cursor += stride;
    for (let i = 0; i < stride; i += 1) {
      const a = i >= 3 ? line[i - 3] : 0;
      const b = prev[i];
      const c = i >= 3 ? prev[i - 3] : 0;
      if (filter === 1) line[i] = (line[i] + a) & 0xff;
      else if (filter === 2) line[i] = (line[i] + b) & 0xff;
      else if (filter === 3) line[i] = (line[i] + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        line[i] = (line[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
      }
    }
    line.copy(out, y * stride);
    prev = line;
  }
  return { width, height, pixels: out };
}

// ── 极简 PNG 编码（RGB8，filter 0）──
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}
function encodePng(width, height, rgb) {
  const raw = Buffer.alloc(height * (width * 3 + 1));
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 3 + 1)] = 0;
    rgb.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 把若干块（每块 w×h 的 RGB 缓冲）横向排布并放大 `SCALE` 倍。 */
function compose(blocks, gap = 2) {
  const bw = blocks[0].w;
  const bh = blocks[0].h;
  const width = (bw * blocks.length + gap * (blocks.length - 1)) * SCALE;
  const height = bh * SCALE;
  const out = Buffer.alloc(width * height * 3, 0x20);
  blocks.forEach((block, index) => {
    const originX = index * (bw + gap) * SCALE;
    for (let y = 0; y < bh; y += 1) {
      for (let x = 0; x < bw; x += 1) {
        const src = (y * bw + x) * 3;
        for (let dy = 0; dy < SCALE; dy += 1) {
          for (let dx = 0; dx < SCALE; dx += 1) {
            const dst = ((y * SCALE + dy) * width + originX + x * SCALE + dx) * 3;
            out[dst] = block.rgb[src];
            out[dst + 1] = block.rgb[src + 1];
            out[dst + 2] = block.rgb[src + 2];
          }
        }
      }
    }
  });
  return { width, height, rgb: out };
}

/** 从整图里裁一块。 */
function crop(png, originX, originY, w, h) {
  const rgb = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y += 1) {
    const from = ((originY + y) * png.width + originX) * 3;
    png.pixels.copy(rgb, y * w * 3, from, from + w * 3);
  }
  return { w, h, rgb };
}

// ── 主流程 ──
const source = readFileSync(resolve(ROOT, 'src/game/iconAtlas.data.ts'), 'utf8');
const match = source.match(/ICON_ATLAS_BASE64\s*=\s*([\s\S]*?);/);
const base64 = match[1]
  .match(/'[^']*'/g)
  .map((p) => p.slice(1, -1))
  .join('');
const png = decodePng(Buffer.from(base64, 'base64'));

// `icons.ts` 里声明的名字顺序（从生成物读，不在这里再抄一遍）。
const iconsSource = readFileSync(resolve(ROOT, 'src/game/icons.ts'), 'utf8');
const ids = iconsSource
  .match(/ICON_IDS = \[([^\]]*)\]/)[1]
  .match(/'[^']*'/g)
  .map((s) => s.slice(1, -1));

mkdirSync(resolve(ROOT, 'shots'), { recursive: true });

const tile = png.height; // 32
const raw = compose(
  Array.from({ length: png.width / tile }, (_, i) => crop(png, i * tile, 0, tile, tile)),
);
writeFileSync(resolve(ROOT, 'shots/atlas-raw.png'), encodePng(raw.width, raw.height, raw.rgb));

const named = compose(ids.map((_, i) => crop(png, i * tile, 0, tile, tile)));
writeFileSync(resolve(ROOT, 'shots/atlas-icons.png'), encodePng(named.width, named.height, named.rgb));

console.log(`图集 ${png.width}×${png.height}，切 ${ids.length} 格`);
console.log(`ICON_IDS 声明顺序（= 代码认为的从左到右）：${ids.join(' , ')}`);
// 每格底色（左上角像素）：`build-icons.mjs` 的 EXPECTED_BACKGROUND 直接照抄这里。
console.log('每格底色（图集从左到右）：');
for (let i = 0; i < png.width / tile; i += 1) {
  const at = i * tile * 3;
  const hex = `#${[0, 1, 2].map((k) => png.pixels[at + k].toString(16).padStart(2, '0')).join('')}`;
  console.log(`  第 ${i} 格：${hex}`);
}
console.log('已写 shots/atlas-raw.png（原样）与 shots/atlas-icons.png（按 ICON_IDS 切）');
