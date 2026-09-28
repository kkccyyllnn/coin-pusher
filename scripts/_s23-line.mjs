#!/usr/bin/env node
/**
 * S23 校准：按**当前默认取景**渲染，并在画面上叠几条「世界 z 平面」的屏幕投影线，
 * 用来人工核对「上层台面末排筹码的后缘」到底落在屏幕的哪一行。
 *
 * 投影是自己算的（脚本里没有 three）：从 `cameraReport()` 取机位 + FOV + 画布尺寸，
 * 走标准 lookAt + 透视投影。**这不是第二份真源** —— 真源是引擎的 `toScreen`，
 * 这里只是没有钩子可用时的外部复算；判据（verify-game 的 camera 模式）仍以引擎为准。
 *
 * 用法：node scripts/_s23-line.mjs
 */
import { chromium } from 'playwright';

const W = Number(process.env.W ?? 1920);
const H = Number(process.env.H ?? 1296);
const OUT = process.env.OUT ?? '/tmp/s23-line.png';

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (a) => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** `CAMERA_FIT.verticalExtent`（真源 `src/render/cameraRig.ts`）。 */
const VERTICAL_EXTENT = 2.873242174891947;

/**
 * 取景距离 → FOV。`fitCameraDistance()` 取「宽度主导 / 高度主导」的较大者，
 * 1920×1296（宽高比 1.481）下高度主导，所以 `distance = verticalExtent / 2 / tan(fov/2)`。
 * 这里只是没有 fov 钩子时的反算；打印出来自检（应为 42°）。
 */
function fovFromDistance(distance) {
  return (2 * Math.atan(VERTICAL_EXTENT / (2 * distance)) * 180) / Math.PI;
}

function projector(cam, cw, ch) {
  const pos = cam.position;
  const target = cam.target;
  const f = norm(sub(target, pos));
  const r = norm(cross(f, [0, 1, 0]));
  const u = cross(r, f);
  const fov = fovFromDistance(cam.distance);
  const tanV = Math.tan((fov * Math.PI) / 360);
  const aspect = cw / ch;
  return (p) => {
    const d = sub(p, pos);
    const depth = dot(d, f);
    if (depth <= 0.001) return null;
    const ndcX = dot(d, r) / (depth * tanV * aspect);
    const ndcY = dot(d, u) / (depth * tanV);
    return { x: (ndcX * 0.5 + 0.5) * cw, y: (-ndcY * 0.5 + 0.5) * ch };
  };
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: W, height: H } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(process.env.BASE_URL ?? 'http://127.0.0.1:5188', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 10, null, {
  timeout: 20000,
});
await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__.hideDebugUi?.(true));
await page.evaluate(() => {
  const canvas = document.querySelector('canvas');
  for (const el of document.querySelectorAll('body *')) {
    if (el === canvas || el.contains(canvas)) continue;
    el.style.visibility = 'hidden';
  }
});
await page.waitForTimeout(1500);

const cam = await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__.cameraReport?.());
const size = await page.evaluate(() => {
  const c = document.querySelector('canvas');
  return { w: c.clientWidth, h: c.clientHeight, bsW: c.width, bsH: c.height };
});
const table = await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__.table?.());
const geo = await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__.coinGeometry?.());
const project = projector(cam, size.w, size.h);

// 三条 z 平面（画在「币坐在推板顶面」的高度上）
const y = 0.2;
const HALF_X = 0.8;
const LINES = [
  { z: -1.178, color: '#ff2d55', label: 'z=-1.178 背板内表面 = 末排后缘（红线）' },
  { z: -1.1, color: '#34c759', label: 'z=-1.1 DECK.zMin 名义' },
  { z: -0.28, color: '#ffd60a', label: 'z=-0.28 DECK.zMax' },
  { z: -0.16, color: '#0a84ff', label: 'z=-0.16 推板归位前缘' },
];

const drawn = LINES.map((line) => {
  const a = project([-HALF_X, y, line.z]);
  const b = project([HALF_X, y, line.z]);
  return { ...line, a, b };
}).filter((line) => line.a && line.b);

await page.evaluate((lines) => {
  const canvas = document.querySelector('canvas');
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:99999';
  for (const line of lines) {
    const el = document.createElement('div');
    el.style.cssText =
      `position:absolute;left:${line.a.x}px;top:${line.a.y}px;` +
      `width:${Math.hypot(line.b.x - line.a.x, line.b.y - line.a.y)}px;height:2px;` +
      `background:${line.color};transform-origin:0 0;` +
      `transform:rotate(${Math.atan2(line.b.y - line.a.y, line.b.x - line.a.x)}rad)`;
    host.appendChild(el);
    const tag = document.createElement('div');
    tag.textContent = line.label;
    tag.style.cssText =
      `position:absolute;left:${line.a.x + 8}px;top:${(line.a.y + line.b.y) / 2 - 9}px;` +
      `color:${line.color};font:600 15px/1 ui-monospace,monospace;text-shadow:0 1px 2px #000`;
    host.appendChild(tag);
  }
  canvas.parentElement.appendChild(host);
}, drawn);

console.log('[camera]', JSON.stringify(cam));
console.log('[camera] fov 反算', fovFromDistance(cam.distance).toFixed(4), '度');
console.log('[canvas]', JSON.stringify(size));
console.log('[table]', JSON.stringify({ backZ: table?.backZ, coins: table?.coins }));
console.log('[geo]', JSON.stringify(geo));
for (const line of drawn) {
  console.log(
    `  线 z=${line.z} → 屏幕 y ${line.a.y.toFixed(1)} / ${line.b.y.toFixed(1)}` +
      `（${((line.a.y / size.h) * 100).toFixed(2)}% 高）  x ${line.a.x.toFixed(1)}→${line.b.x.toFixed(1)}`,
  );
}
await page.screenshot({ path: OUT });
console.log('[out]', OUT);
console.log('[errors]', errors.length ? errors.join(' | ') : 'none');
await browser.close();
