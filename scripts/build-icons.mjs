/**
 * 从 `src/game/iconAtlas.data.ts` 里的图集 base64 生成 `src/game/icons.ts`。
 *
 *   node scripts/build-icons.mjs            # 生成
 *   node scripts/build-icons.mjs --check    # 只校验，不写文件（收口时用）
 *
 * ## 为什么要在构建期把 PNG 解码成像素数组，而不是运行时挂一张贴图
 *
 * 项目里**没有任何资源加载器**：币面纹样、机柜细节、色带 LUT 全是同步生成的
 * （见 `src/utils/coinTexture.ts`、`src/render/RampLut.ts`）。挂一张 PNG 意味着
 * 引入异步加载 + 首帧空窗 + 一条新的失败路径，而收益只是省掉 6 KB 的常量。
 *
 * 所以这里把「像素真源」编译进代码：每个图标 = 一张 ≤16 色调色板 + 1024 个索引。
 * 运行时的 `iconTexture.ts` 只负责把索引涂到 canvas 上，仍然同步、无 loader。
 *
 * ## 为什么调色板要按「首见顺序」而不是排序
 *
 * 排序会让每次重跑产生不同的索引串 → diff 噪声。首见顺序（行优先扫描）是确定的，
 * 同一张图集永远产出同一份 `icons.ts`，可以进版本库并对 diff 做人工审查。
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_PATH = resolve(ROOT, 'src/game/iconAtlas.data.ts');
const OUT_PATH = resolve(ROOT, 'src/game/icons.ts');

/**
 * 图集格的逻辑名，**顺序 = 图集里从左到右的实际顺序**。
 *
 * ★ **这一行是「名字 → 像素」的唯一映射，写错就是一次零报错的静默错位。**
 *
 * 踩过：第一版照抄了 `pixel-cube-v3.html` 里那段 legend 的列举顺序
 * （`+Y` 叉 · `+Z` 桃子 · `+X` 胡萝卜 · `-Z` 钻石 · `-X` 宝箱 · `-Y` 黄瓜），
 * 于是写成 `['cross','peach','carrot','diamond','chest','cucumber']`。
 * 但**图集里格子的排列顺序与 legend 的列举顺序不是一回事**（legend 说的是
 * 立方体六个面，图集是贴图集，面序 ≠ 集序）。结果：
 *   ① 所有计数判据全绿（6 格 / 32×32 / 12 色都对）；
 *   ② 老虎机摇出「桃」却画出宝箱，「黄瓜」画出钻石——
 *      只有把像素画出来（`scripts/dump-atlas.mjs`）才看得出来。
 *
 * 所以下面 `EXPECTED_BACKGROUND` 把每格的**底色**钉死成常量：
 * 改顺序、换图集都会立刻在这里报错，而不是等到画面上。
 *
 * 名字刻意用**图形本身**（cross / peach / carrot / …）而不是玩法符号
 * （boost / tower / …）：图形与符号的对应关系是玩法决策（P10 §10.1 的映射表），
 * 会随拍板变；图形叫什么不会变。两件事分开放，改映射不用重命名资产。
 */
const ICON_IDS = ['carrot', 'chest', 'cross', 'cucumber', 'peach', 'diamond'];

/**
 * 每格的**底色**（左上角像素，sRGB 十六进制）——图集的指纹。
 *
 * 这不是「第二份真源」，是**对资产的断言**：它记的是「这张图集长什么样」，
 * 用来在构建期拦住「名字与像素错位」这种静默错位。图集真的换了就更新这里，
 * 更新时必须先看一眼 `shots/atlas-raw.png`。
 */
const EXPECTED_BACKGROUND = {
  carrot: '#e46218', // 橙
  chest: '#b47a26', // 棕金
  cross: '#c4b39f', // 浅灰米
  cucumber: '#5db045', // 绿
  peach: '#fce2b5', // 奶黄
  diamond: '#08458a', // 深蓝
};

/** 调色板上限。索引用一位十六进制，所以 16 是硬上限，不是偏好。 */
const PALETTE_MAX = 16;

// ── PNG 解码（只支持 8bit / colorType 2 / 非隔行——图集就长这样，多余的分支是负担） ──

function decodePng(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG');
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  const bitDepth = buffer[24];
  const colorType = buffer[25];
  const interlace = buffer[28];
  if (bitDepth !== 8) throw new Error(`只支持 8bit，实际 ${bitDepth}`);
  if (colorType !== 2) throw new Error(`只支持 colorType 2 (RGB)，实际 ${colorType}`);
  if (interlace !== 0) throw new Error('不支持隔行 PNG');

  const idat = [];
  for (let pos = 8; pos < buffer.length; ) {
    const length = buffer.readUInt32BE(pos);
    const type = buffer.toString('ascii', pos + 4, pos + 8);
    const data = buffer.subarray(pos + 8, pos + 8 + length);
    if (type === 'IDAT') idat.push(data);
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
      switch (filter) {
        case 0: break;
        case 1: line[i] = (line[i] + a) & 0xff; break;
        case 2: line[i] = (line[i] + b) & 0xff; break;
        case 3: line[i] = (line[i] + ((a + b) >> 1)) & 0xff; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          line[i] = (line[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
          break;
        }
        default: throw new Error(`未知 filter ${filter} @ 行 ${y}`);
      }
    }
    line.copy(out, y * stride);
    prev = line;
  }
  return { width, height, pixels: out };
}

// ── 切格 + 建调色板 ──

function sliceTiles(png) {
  const { width, height, pixels } = png;
  if (height % 32 !== 0) throw new Error(`图集高 ${height} 不是 32 的倍数`);
  const tileSize = height;
  const tileCount = width / tileSize;
  if (!Number.isInteger(tileCount)) throw new Error(`图集宽 ${width} 不是 ${tileSize} 的倍数`);
  if (tileCount !== ICON_IDS.length) {
    throw new Error(`图集有 ${tileCount} 格，但 ICON_IDS 声明了 ${ICON_IDS.length} 个`);
  }

  return ICON_IDS.map((id, index) => {
    const palette = [];
    const lookup = new Map();
    const indices = [];
    for (let y = 0; y < tileSize; y += 1) {
      for (let x = 0; x < tileSize; x += 1) {
        const offset = (y * width + index * tileSize + x) * 3;
        const key = (pixels[offset] << 16) | (pixels[offset + 1] << 8) | pixels[offset + 2];
        let slot = lookup.get(key);
        if (slot === undefined) {
          slot = palette.length;
          if (slot >= PALETTE_MAX) {
            throw new Error(`${id}: 调色板超过 ${PALETTE_MAX} 色（索引是一位十六进制）`);
          }
          palette.push(key);
          lookup.set(key, slot);
        }
        indices.push(slot);
      }
    }
    // ★ 底色核对：`palette[0]` 就是左上角像素（调色板按行优先首见顺序建立），
    //   也就是这格的底色。名字与像素错位时，这里会立刻报出来——
    //   否则要等到把老虎机摇出来、肉眼发现「桃画成了宝箱」才发现。
    const background = `#${palette[0].toString(16).padStart(6, '0')}`;
    const expected = EXPECTED_BACKGROUND[id];
    if (background !== expected) {
      throw new Error(
        `第 ${index} 格（${id}）的底色是 ${background}，期望 ${expected}。\n` +
          `说明 ICON_IDS 的顺序与图集实际的格子排列对不上——` +
          `先跑 \`node scripts/dump-atlas.mjs\` 看一眼 shots/atlas-raw.png，` +
          `把 ICON_IDS 调成图集里从左到右的真实顺序（同时更新 EXPECTED_BACKGROUND）。`,
      );
    }

    return {
      id,
      size: tileSize,
      palette: palette.map((key) => `#${key.toString(16).padStart(6, '0')}`),
      pixels: indices.map((slot) => slot.toString(16)).join(''),
    };
  });
}

// ── 输出 ──

function chunk(text, size = 128) {
  const parts = [];
  for (let i = 0; i < text.length; i += size) parts.push(text.slice(i, i + size));
  // ★ 结尾必须是 **逗号**：这是对象字面量里的属性值，不是语句。
  //   第一版写成 `;`，tsc 报 `TS1005 ',' expected`（每一块的最后一行都报）。
  return parts.map((part, i) => `    '${part}'${i === parts.length - 1 ? ',' : ' +'}`).join('\n');
}

function render(tiles) {
  const blocks = tiles
    .map(
      (tile) => `  ${tile.id}: {
    id: '${tile.id}',
    w: ${tile.size},
    h: ${tile.size},
    palette: [
${tile.palette.map((hex) => `      '${hex}',`).join('\n')}
    ],
    pixels:
${chunk(tile.pixels)}
  },`,
    )
    .join('\n');

  return `/**
 * 像素图标真源（P10）—— **本文件由 \`scripts/build-icons.mjs\` 生成，不要手改。**
 *
 * 每个图标 = 一张 ≤${PALETTE_MAX} 色调色板 + ${tiles[0].size}×${tiles[0].size} 个调色板索引（一位十六进制/像素，
 * 行优先）。运行时的 \`src/render/iconTexture.ts\` 只负责把索引涂进 canvas——
 * 与币面纹样（\`src/utils/coinTexture.ts\`）同一种做法：**同步生成，没有资源加载器**。
 *
 * 为什么要这么绕（而不是运行时挂一张 PNG）：项目里没有任何异步加载路径，
 * 挂图会引入首帧空窗与一条新的失败分支，而省下的只有几 KB。
 *
 * 重新生成：\`node scripts/build-icons.mjs\`
 */

/** 图标逻辑名，**顺序 = 图集里从左到右的顺序**（不是玩法符号的顺序）。 */
export const ICON_IDS = [${ICON_IDS.map((id) => `'${id}'`).join(', ')}] as const;

export type IconId = (typeof ICON_IDS)[number];

export type PixelIcon = {
  readonly id: IconId;
  readonly w: number;
  readonly h: number;
  /** sRGB 十六进制调色板。 */
  readonly palette: readonly string[];
  /** 逐像素调色板索引，长度 = w × h，一位十六进制/像素，行优先。 */
  readonly pixels: string;
};

/**
 * 判据用的期望值。
 *
 * 存在的理由（纪律 2「判据不写第二份公式」）：验证脚本要断言
 * 「6 格 / 32×32 / 每格 ≤${PALETTE_MAX} 色」，那三个数必须**从这里读**，
 * 不能在脚本里再抄一遍——否则改图集时脚本会继续拿旧数字断言，变成假绿。
 */
export const ICON_EXPECTED = {
  count: ${ICON_IDS.length},
  size: ${tiles[0].size},
  paletteMax: ${PALETTE_MAX},
} as const;

export const PIXEL_ICONS: Record<IconId, PixelIcon> = {
${blocks}
};
`;
}

// ── 主流程 ──

const dataSource = readFileSync(DATA_PATH, 'utf8');
const match = dataSource.match(/ICON_ATLAS_BASE64\s*=\s*([\s\S]*?);/);
if (!match) throw new Error(`在 ${DATA_PATH} 里找不到 ICON_ATLAS_BASE64`);
// ★ 折行后的字面量是若干 `'…' +` 片段。**必须按引号取片段再拼接**，
//   不能「把所有非 base64 字符滤掉」——base64 字母表本身含 `+` 与 `/`，
//   滤 `+` 会把数据静默截断（实测：zlib 报 "unexpected end of file"）。
const pieces = match[1].match(/'[^']*'/g);
if (!pieces) throw new Error('base64 字面量格式不对：期望一串单引号片段');
const base64 = pieces.map((piece) => piece.slice(1, -1)).join('');
if (base64.length % 4 !== 0) throw new Error(`base64 长度 ${base64.length} 不是 4 的倍数`);
const png = decodePng(Buffer.from(base64, 'base64'));
const tiles = sliceTiles(png);
const output = render(tiles);

const checkOnly = process.argv.includes('--check');
if (checkOnly) {
  if (!existsSync(OUT_PATH)) throw new Error(`${OUT_PATH} 不存在，先跑一次生成`);
  if (readFileSync(OUT_PATH, 'utf8') !== output) {
    throw new Error('src/game/icons.ts 与图集不一致——跑 `node scripts/build-icons.mjs` 重新生成');
  }
  console.log('icons.ts 与图集一致');
} else {
  writeFileSync(OUT_PATH, output);
  console.log(`wrote src/game/icons.ts（${output.length} 字符）`);
}

console.log(
  `图集 ${png.width}×${png.height} → ${tiles.length} 格，每格 ${tiles[0].size}×${tiles[0].size}：` +
    tiles.map((t) => ` ${t.id}=${t.palette.length}色`).join(''),
);
