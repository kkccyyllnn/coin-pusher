#!/usr/bin/env node
/**
 * XIXI 徽章取景（临时诊断脚本，不属于验证链）。
 *
 * 存在的理由：`xixiLaneReport()` 能证明「段宽 0.34、铺满 ±0.68、图标 16 纹素」，
 * 但证明不了**画面上到底长什么样**——叉有没有被横向拉扁、亮/灭两档能不能一眼分开、
 * 平铺的自发光有没有把「灭」的段洗亮，这些必须看一眼。
 *
 * 取景锚点复用 HUD 的 `#xixi-marks`：它的 `style.top` 就是推板前缘的屏幕 y
 * （`Game.updateMarksAnchor` 用同一个 `toScreen` 算出来的），所以不必再推一遍投影。
 * 标牌中心比它低 0.10 米（y 0.22 → 0.12），推板前立面处约 226 CSS px/米 → 低约 23 px。
 *
 * 用法：先 `npm run dev`，然后 `node scripts/shot-badge.mjs`
 * 产物：shots/badge-<状态>.png（整机 + 标牌特写各一张）
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:5188';
const OUT = 'shots';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await context.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (m) => {
  if (m.type() === 'error') console.log('[console.error]', m.text());
});

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 10, null, {
  timeout: 20_000,
});
await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setPausedForScreenshot?.(true));

const canvas = page.locator('#game-canvas');

/** 标牌在屏幕上的 y：HUD 锚点（推板前缘 y=0.22）往下挪 0.10 米。 */
async function badgeCenterY() {
  return page.evaluate(() => {
    const el = document.querySelector('#xixi-marks');
    const top = el ? parseFloat(getComputedStyle(el).top) : NaN;
    return Number.isFinite(top) ? top + 23 : 360;
  });
}

async function shot(name) {
  const centerY = await badgeCenterY();
  // HUD 那行 `XIXI 集章 n/4 …` 的 DOM 条正好压在标牌上（两者锚点同源），
  // 特写时先藏掉它，否则挡住的就是要看的东西。读数仍然从 3D 侧取。
  await page.evaluate(() => {
    const el = document.querySelector('#xixi-marks');
    if (el) el.style.visibility = 'hidden';
  });
  await page.waitForTimeout(150);
  await canvas.screenshot({ path: `${OUT}/badge-${name}.png` });
  // 特写走 **整页** 截图：`locator.screenshot({ clip })` 的 clip 不生效（实测仍是全尺寸），
  // 而 canvas 铺满视口，所以整页 + clip 与裁 canvas 等价。
  await page.screenshot({
    path: `${OUT}/badge-${name}-closeup.png`,
    // 标牌带 1.36 米宽 ≈ 308 CSS px、高 0.14 米 ≈ 32 CSS px，四周各留一倍余量。
    clip: { x: 640 - 260, y: Math.max(0, centerY - 46), width: 520, height: 92 },
  });
  await page.evaluate(() => {
    const el = document.querySelector('#xixi-marks');
    if (el) el.style.visibility = '';
  });
  const lanes = await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.xixiLanes?.());
  console.log(
    `已存 ${OUT}/badge-${name}.png（特写 y≈${Math.round(centerY)}）` +
      ` lit=${JSON.stringify(lanes?.lit)} colors=${JSON.stringify(lanes?.colors)}`,
  );
}

// ① 全灭：玩家还没投中任何一槽。
await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setXixi?.([false, false, false, false]));
await shot('dim');

// ② 全亮：四槽集齐（老虎机触发前的状态）。
await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setXixi?.([true, true, true, true]));
await shot('lit');

// ③ 交替亮：`X I X I` 里两段亮两段灭 —— 同一帧里两档同时出现，最容易看出对比度够不够。
await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setXixi?.([true, false, true, false]));
await shot('alt');

await browser.close();
