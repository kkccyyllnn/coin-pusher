#!/usr/bin/env node
/**
 * 排水口探查（临时诊断脚本，不属于验证链）。
 *
 * 存在的理由：`drained` 这个计数只说明「有币掉了」，说明不了**洞开得对不对**：
 * 洞开在错误的位置会表现为「币从看不见的地方消失」，而计数照涨。
 * 所以这里把三件事一起读出来：
 *   ① 逐枚现场（`drainEvents` 的 x / z / offset）—— 洞是不是在推板推进来的那一段接住的；
 *   ② `anomalies` 必须仍然是 0 —— 判定顺序对了，币永远来不及变成异常；
 *   ③ 一张盘面前沿的截图 —— 洞与得分线亮条的相对位置。
 *
 * 用法：先 `npm run dev`，然后 `node scripts/probe-drain.mjs [秒数]`
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:5188';
const SECONDS = Number(process.argv[2] ?? 45);
mkdirSync('shots', { recursive: true });

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

// 开局：playing（推板起跑）+ 打开遥测。
await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.refillWallet?.(400));
await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setState?.('playing'));
await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.enableTelemetry?.());

const read = () => page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__);
const telemetry = () =>
  page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.telemetry?.() ?? null);

const before = await read();
console.log(
  `起点：币 ${before.activeCoins}，drained ${before.drained}，anomalies ${before.anomalies}`,
);

// 持续投币：每 500ms 一枚，跑 SECONDS 秒。
//
// ★ **必须把本局吊住**：筹码见底 → 引擎正确地进沉降 → 推板停 → 洞再也接不到币，
//   于是测出来的排水率只有开局那一瞬。踩过：30s 与 40s 两次都恰好 15 枚，
//   看起来像「洞的位置不对」，其实是这一局在 1 秒内就破产了。
//   所以筹码低就跪求续命（跪求是唯一能把本局从沉降里拉回来的入口）。
const deadline = Date.now() + SECONDS * 1000;
let dropped = 0;
let begged = 0;
while (Date.now() < deadline) {
  const chips = (await read())?.chips ?? 0;
  if (chips < 10) {
    const ok = await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.beg?.() ?? false);
    if (ok) begged += 1;
  } else {
    const ok = await page.evaluate(
      (lane) => window.__THREE_GAME_TEST_HOOKS__?.drop?.(lane),
      ((dropped % 7) - 3) / 3,
    );
    if (ok) dropped += 1;
  }
  await page.waitForTimeout(500);
}
console.log(`续命跪求 ${begged} 次`);

const after = await read();
const t = await telemetry();
const events = t?.drainEvents ?? [];
console.log(
  `投出 ${dropped} 枚 → 币 ${before.activeCoins} → ${after.activeCoins}，` +
    `drained ${before.drained} → ${after.drained}，anomalies ${after.anomalies}`,
);
console.log(`越线结算 ${(t?.scoreEvents ?? []).length} 次，赚进 ${after.earned} 筹码`);
if (events.length > 0) {
  const xs = events.map((e) => e.x);
  const zs = events.map((e) => e.z);
  const offsets = events.map((e) => e.offset);
  const sides = { left: events.filter((e) => e.side < 0).length, right: events.filter((e) => e.side > 0).length };
  console.log(
    `排水现场：${events.length} 枚；` +
      `x ∈ [${Math.min(...xs).toFixed(3)}, ${Math.max(...xs).toFixed(3)}]，` +
      `z ∈ [${Math.min(...zs).toFixed(3)}, ${Math.max(...zs).toFixed(3)}]，` +
      `推板行程 ∈ [${Math.min(...offsets).toFixed(3)}, ${Math.max(...offsets).toFixed(3)}]；` +
      `左 ${sides.left} / 右 ${sides.right}`,
  );
  console.log('前 6 条：', JSON.stringify(events.slice(0, 6)));
  // 时间分布：开局那一瞬的「预置币掉下去」与「推板推下去的」必须分得开，
  // 否则会把一次性的开局损失当成持续排水率（踩过：30s/40s 都恰好 15 枚）。
  const buckets = new Map();
  for (const e of events) {
    const bucket = Math.floor(e.t / 5) * 5;
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
  }
  console.log(
    '按 5 秒分桶：',
    [...buckets.entries()].map(([t, n]) => `${t}~${t + 5}s:${n}`).join('  '),
  );
  const early = events.filter((e) => e.t < 2).length;
  console.log(`开局 2 秒内 ${early} 枚（预置币坐在洞口上），之后 ${events.length - early} 枚（推板推进去的）`);
} else {
  console.log('排水现场：0 条（洞没接住任何币 —— 要么位置不对，要么这一局没币走到那）');
}

if ((after.anomalySamples ?? []).length > 0) {
  console.log('异常现场（**必须是空的**：排水判定排在它前面）:');
  for (const s of after.anomalySamples) console.log('  ', JSON.stringify(s));
}

await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setPausedForScreenshot?.(true));
await page.locator('#game-canvas').screenshot({ path: 'shots/drain-front.png' });
// 币床前沿的特写：洞口与得分线亮条的相对位置只能在近处看清楚。
// 洞口在画面上的位置（按相机参数手算，省得来回试）：
//   世界 (±0.745, 0, 1.065) → CSS 像素 (865, 621) / (415, 621)，1280×720 视口。
await page.screenshot({
  path: 'shots/drain-closeup.png',
  clip: { x: 300, y: 470, width: 680, height: 200 },
});
console.log('已存 shots/drain-front.png 与 shots/drain-closeup.png');

await browser.close();
