#!/usr/bin/env node
/**
 * 机柜 → OBJ（给 Blender 改模 / 画贴图用）。
 *
 * ## 用法
 *
 * ```bash
 * npm run dev                                   # 另开一个终端
 * node scripts/export-cabinet-obj.mjs
 * ```
 *
 * ## 产物
 *
 * ```
 * artifacts/cabinet-obj/coin-pusher-cabinet.obj   整机（世界坐标，单位米）
 * artifacts/cabinet-obj/cabinet-parts.txt         件名 → 世界位置 / 包围盒尺寸
 * ```
 *
 * `cabinet-parts.txt` 不是附赠品：OBJ 里只有 `panel#0` 这种名字，光看名字认不出
 * 「哪块是背板」。对着那份表的位置与尺寸，在 Blender 里一眼就能定位。
 *
 * ## 为什么要连浏览器
 *
 * 机柜是**代码生成**的（`src/systems/TableBuilder.ts` 等），不是资产文件 ——
 * 仓库里没有任何 `.obj`。导出必须真的把那些构造函数跑一遍，而它们 import 了
 * `three` 的 bare specifier，只有 Vite 能解析（Node 侧还会撞上 `.ts` 扩展名解析）。
 * 所以走「起 dev server → Playwright 打开页面 → 在页面里 import 导出模块」这条路。
 *
 * ## 改完尺寸之后
 *
 * 改了 `TableBuilder` / `Pusher` / `constants` 里任何一个尺寸，**重新跑一遍本脚本**，
 * 再用 Blender 重新导入即可（OBJ 是快照，不会自己跟着代码变）。
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:5188';
const OUT = resolve(process.cwd(), 'artifacts/cabinet-obj');
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (error) => console.log('[pageerror]', error.message));
page.on('console', (message) => {
  if (message.type() === 'error') console.log('[console.error]', message.text());
});

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
// 等游戏真的跑起来：`RAPIER.init()` 与 three 的模块图都由首帧之前那一段建立，
// 早于这个点去 import 会拿到半初始化的模块。
await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 10, null, {
  timeout: 20_000,
});

const data = await page.evaluate(async () => {
  const mod = await import('/tools/cabinet-export.ts');
  return mod.buildCabinetObj();
});

/** 件名 → 位置 / 尺寸的对照表（固定列宽，便于人眼扫）。 */
function renderParts(result) {
  const pad = (value, width) => String(value).padStart(width);
  const lines = [
    'coin-pusher 机柜 —— 件名对照表',
    '世界坐标，单位米，y 朝上，+z 朝玩家',
    '',
    `${'件名'.padEnd(20)}${'材质'.padEnd(18)}${pad('三角面', 8)}${pad('实例', 6)}` +
      `${pad('中心 x', 10)}${pad('中心 y', 10)}${pad('中心 z', 10)}` +
      `${pad('宽', 9)}${pad('高', 9)}${pad('深', 9)}`,
    '─'.repeat(118),
  ];
  for (const part of result.parts) {
    lines.push(
      part.name.padEnd(20) +
        part.material.padEnd(18) +
        pad(part.triangles, 8) +
        pad(part.instances, 6) +
        pad(part.center[0], 10) +
        pad(part.center[1], 10) +
        pad(part.center[2], 10) +
        pad(part.size[0], 9) +
        pad(part.size[1], 9) +
        pad(part.size[2], 9),
    );
  }
  const { min, max } = result.bounds;
  lines.push(
    '─'.repeat(118),
    `整机包围盒：min (${min.join(', ')})  max (${max.join(', ')})`,
    `尺寸 ${(max[0] - min[0]).toFixed(3)} × ${(max[1] - min[1]).toFixed(3)} × ` +
      `${(max[2] - min[2]).toFixed(3)} 米（宽 × 高 × 深）`,
    `件数 ${result.parts.length}，三角形 ${result.triangles}（已按实例展开）`,
    '',
    '⚠️ 各件是「代码里的尺寸 + 世界变换」的快照。改了 TableBuilder / Pusher /',
    '   constants 里任何尺寸，都要重新跑一次本脚本再导入 Blender。',
    '⚠️ 演出装置（闸门 / 喷泉 / 溢流口）不在本表里：它们是演出期间临时建的。',
  );
  return lines.join('\n');
}

const objPath = resolve(OUT, 'coin-pusher-cabinet.obj');
const partsPath = resolve(OUT, 'cabinet-parts.txt');
writeFileSync(objPath, data.obj, 'utf8');
writeFileSync(partsPath, renderParts(data), 'utf8');

const { min, max } = data.bounds;
console.log(`已写 ${objPath}`);
console.log(`已写 ${partsPath}`);
console.log(
  `件数 ${data.parts.length}，三角形 ${data.triangles}，` +
    `整机 ${(max[0] - min[0]).toFixed(3)} × ${(max[1] - min[1]).toFixed(3)} × ` +
    `${(max[2] - min[2]).toFixed(3)} 米`,
);
console.log(
  `包围盒 min (${min.join(', ')}) → max (${max.join(', ')})；OBJ 体积 ${(data.obj.length / 1024).toFixed(0)} KB`,
);

await browser.close();
