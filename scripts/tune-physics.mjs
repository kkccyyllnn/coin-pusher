#!/usr/bin/env node
/**
 * 单变量物理调参探针。
 *
 * 为什么需要它：`physics` 模式只报「通过 / 不通过」，看不出**整堆币的姿态**。
 * 而满盘下真正会出事的是整盘级的量（币堆沉进地板、层间距被压扁），
 * 不是某一对币的重叠。这个探针把四个数一次报出来：
 *
 * | 量 | 应为 | 说明 |
 * | --- | --- | --- |
 * | 沉入地板的枚数 | 0 | 币心低于「地板顶面 + 币半厚 − 2mm」即为沉 |
 * | 平均币心高度 | 0.01 | 单层静置时币心恰好在 0.010 |
 * | 同格层间距 | 0.0212 | `LAYER_STEP`；被压小 = 币堆被压扁 |
 * | 接触穿透深度 | ≤ 2mm | 从接触流形读，与币的姿态无关 |
 *
 * 用法（先 `npm run dev`）：
 *   node scripts/tune-physics.mjs                                  基线
 *   TUNE='{"erp":0.5}' node scripts/tune-physics.mjs               改一个旋钮
 *   PLAY=1 TUNE='{"erp":0.8}' node scripts/tune-physics.mjs        额外跑到第 10 个推板循环，
 *                                                                  再停推板量静止态的穿透
 *
 * 纪律：**一次只改一个变量**。历史上踩过的坑是「同时调迭代次数与 erp」，
 * 结果无法判断是谁在起作用——实测证明瓶颈在刚度（`erp`），迭代次数单独调几乎没用。
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:5188';
const TUNE = process.env.TUNE ? JSON.parse(process.env.TUNE) : {};
const PLAY = process.env.PLAY === '1';
/** 地板顶面（`TABLE.floorY`）与单层静置时的币心高度（币半厚）。 */
const FLOOR_TOP = 0;
const REST_Y = 0.01;
/** 层高：币厚 + 一点余量，与 `layout.LAYER_STEP` 同式。 */
const LAYER_STEP = 0.01 * 2 + 0.0012;
/** 判定「沉入地板」的容差（毫米级接触穿透是正常的）。 */
const SINK_TOLERANCE = 0.002;

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await context.newPage();
page.on('pageerror', (error) => console.log('PAGEERROR', error.message));
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 10, null, {
  timeout: 20000,
});

const coins = () => page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.coins?.() ?? []);
const state = () => page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__);
const penetration = () =>
  page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.penetrationReport?.(4) ?? null);

function summarize(list) {
  const bed = list.filter((coin) => coin.y < 0.15);
  const sunk = bed.filter((coin) => coin.y < FLOOR_TOP + REST_Y - SINK_TOLERANCE).length;
  const meanY = bed.reduce((sum, coin) => sum + coin.y, 0) / Math.max(1, bed.length);
  const cells = new Map();
  for (const coin of bed) {
    const key = `${coin.x.toFixed(2)}|${coin.z.toFixed(2)}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(coin.y);
  }
  const gaps = [];
  for (const ys of cells.values()) {
    if (ys.length < 2) continue;
    ys.sort((a, b) => a - b);
    for (let i = 1; i < ys.length; i += 1) gaps.push(ys[i] - ys[i - 1]);
  }
  return {
    bed: bed.length,
    sunk,
    meanY,
    minY: Math.min(...bed.map((coin) => coin.y)),
    meanGap: gaps.length ? gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length : 0,
    sleeping: list.filter((coin) => coin.sleeping).length,
    total: list.length,
  };
}

const report = (label, summary, pen) => {
  console.log(
    `${label}：币床 ${summary.bed} 枚，沉入地板 ${summary.sunk} 枚（应 0）；` +
      `平均币心 ${summary.meanY.toFixed(4)}（应 ${REST_Y}），最低 ${summary.minY.toFixed(4)}；` +
      `同格层间距 ${summary.meanGap.toFixed(4)}（应 ${LAYER_STEP.toFixed(4)}）；睡眠 ${summary.sleeping}/${summary.total}`,
  );
  if (pen) {
    console.log(
      `  穿透：币↔币最深 ${(pen.coinDeepest * 1000).toFixed(1)}mm（${pen.coinContacts} 处接触），` +
        `币↔机台最深 ${(pen.staticDeepest * 1000).toFixed(1)}mm，超 4mm 的 ${pen.overLimit} 处`,
    );
    for (const item of pen.worst) {
      console.log(`    最深 ${(item.depth * 1000).toFixed(1)}mm  ${item.pair}  位置 ${item.at.join(', ')}`);
    }
  }
};

await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.clearSave?.());
await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.seed?.(20260921));
await page.evaluate((patch) => window.__THREE_GAME_TEST_HOOKS__?.setTuning?.(patch), TUNE);
await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setState?.('ready'));
await page.waitForTimeout(2500);

const applied = (await state())?.physics?.tuning;
console.log(
  `旋钮：重力 ${applied?.gravity}｜全局迭代 ${applied?.solverIterations}｜ERP ${applied?.erp}｜币额外迭代 ${applied?.coinSolverIterations}`,
);
report('静置 2.5s', summarize(await coins()), await penetration());

if (PLAY) {
  for (let i = 0; i < 60; i += 1) {
    if (await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.drop?.(0) ?? false)) break;
    await page.waitForTimeout(70);
  }
  const target = ((await state())?.pusher?.cycles ?? 0) + 10;
  for (let i = 0; i < 400; i += 1) {
    if (((await state())?.pusher?.cycles ?? 0) >= target) break;
    await page.waitForTimeout(250);
  }
  // 停推板再量：推板挤压中的瞬态不是判据，稳定下来的才是。
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setPusherRunning?.(false));
  let quiet = 0;
  for (let i = 0; i < 40 && quiet < 2; i += 1) {
    await page.waitForTimeout(500);
    const fastest = (await coins()).reduce((max, coin) => Math.max(max, coin.speed ?? 0), 0);
    quiet = fastest < 0.08 ? quiet + 1 : 0;
  }
  report('10 循环后静止', summarize(await coins()), await penetration());
}

await browser.close();
