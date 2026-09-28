#!/usr/bin/env node
/**
 * 老虎机取景（临时诊断脚本，不属于验证链）。
 *
 * 存在的理由：`reelWindowReport()` 只能证明「窗口尺寸对、贴图尺寸对」，
 * 证明不了**画面上到底长什么样**——图标是不是上下颠倒、底色有没有串格、
 * 灯条亮没亮，这些必须看一眼。所以这里把背板裁出来存图。
 *
 * 用法：先 `npm run dev`，然后 `node scripts/shot-slot.mjs`
 * 产物：shots/slot-<阶段>.png
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

// 背板挂框在画面上的大致位置：从 `toScreen` 同款投影反推——但这里直接用全画布，
// 让人眼能看到上下文（机台整体），只在文件名上标阶段。
const canvas = page.locator('#game-canvas');

const shot = async (name) => {
  await page.waitForTimeout(150);
  await canvas.screenshot({ path: `${OUT}/slot-${name}.png` });
  // 截图当帧的读数一起打出来：图与数必须对得上，否则「看着像」会骗人。
  const now = await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.reelWindowReport?.());
  console.log(
    `已存 ${OUT}/slot-${name}.png  faces=${JSON.stringify(now?.faces)} target=${JSON.stringify(now?.targetIndex)} lamp=${now?.lampIntensity}`,
  );
};

await shot('idle');

// 逐结果各摇一次，在「停格之后、兑现之前」的窗口里抓图。
const cases = [
  ['win-tower', 'tower'],
  ['win-chest', 'chest'],
  ['fine', 'fine'],
  ['miss', 'miss'],
];
for (const [name, forced] of cases) {
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setPausedForScreenshot?.(false));
  const spun = await page.evaluate(
    (f) => window.__THREE_GAME_TEST_HOOKS__?.xixiSpin?.(f) ?? null,
    forced,
  );
  if (!spun) {
    console.log(`[跳过] ${name}：老虎机正忙`);
    continue;
  }
  // 停格全部完成（第 4 格 2.25s）之后、灯条点亮（2.6s）之后 → 抓 2.9s 那一帧。
  await page.waitForTimeout(2900);
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setPausedForScreenshot?.(true));
  await shot(name);
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setPausedForScreenshot?.(false));
  await page.waitForTimeout(1200);
}

const report = await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.reelWindowReport?.());
console.log('reelWindowReport:', JSON.stringify(report));
const diag = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.reel);
console.log('diagnostics.reel:', JSON.stringify(diag));

await browser.close();
