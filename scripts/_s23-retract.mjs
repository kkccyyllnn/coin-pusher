#!/usr/bin/env node
/**
 * S23 取证：`PUSHER_CYCLE.retract` 0.45 → 0.9 的**物理后果**，在改常量之前先量。
 *
 * 为什么要先量：项目自己的 S13 结论是「行程对称 ⇒ 摩擦净输送精确为 0」
 * （库仑摩擦 + 对称 smoothstep 都满足时间反演对称），而 `retract = 0.9` 正好
 * 与 `extend = 0.9` 对称。如果结论成立，台面（推板顶面）就**不再喂料**，
 * 单枚币净前进归零 → 币床只出不进 → 机器憋死。
 *
 * `pusherRetractSec` 是**每帧现读**的运行时可调项（`Game.applyTuning`），
 * 所以这里不动 `src/**`，只通过测试钩子改相位时长，跑同一套投币序列对比。
 *
 * 用法：node scripts/_s23-retract.mjs           # 默认 0.45 与 0.9
 *      RETRACT=0.45,0.6,0.9 node scripts/_s23-retract.mjs
 *      DROPS=24 REPS=1 node scripts/_s23-retract.mjs
 */

import { chromium } from 'playwright';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:5188';
const RETRACTS = (process.env.RETRACT ?? '0.45,0.9').split(',').map(Number);
const DROPS = Number(process.env.DROPS ?? 24);
const REPS = Number(process.env.REPS ?? 1);
const SEED = Number(process.env.SEED ?? 20260921);

const readState = (page) => page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__);
const readCoins = (page) =>
  page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.coins?.() ?? []).catch(() => []);
const readTable = (page) =>
  page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.table?.() ?? null).catch(() => null);
const readTelemetry = (page) =>
  page
    .evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.telemetry?.())
    .catch(() => null)
    .then((value) => value ?? { scoreEvents: [], fallOffEvents: [], cycles: [] });

async function waitFor(page, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await readState(page);
    if (predicate(last)) return last;
    await page.waitForTimeout(250);
  }
  return null;
}

async function dropUntilAccepted(page, lane, budgetMs = 6000) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const accepted = await page
      .evaluate((value) => window.__THREE_GAME_TEST_HOOKS__?.drop?.(value) ?? false, lane)
      .catch(() => false);
    if (accepted) return true;
    await page.waitForTimeout(70);
  }
  return false;
}

async function startRun(page) {
  await page.evaluate((seed) => window.__THREE_GAME_TEST_HOOKS__?.seed?.(seed), SEED);
  await page.evaluate(() => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__;
    const wallet = hooks?.run?.()?.wallet ?? 0;
    if (wallet < 200) hooks?.refillWallet?.(200 - wallet);
  });
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setState?.('ready'));
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.enableTelemetry?.());
}

/** 与 `verify-game.mjs` 的 `playRun` 同构：每个循环投一枚。 */
async function playRun(page, drops) {
  const pickLanes = [-0.6, -0.2, 0.2, 0.6];
  await dropUntilAccepted(page, pickLanes[0]);
  let lastCycle = (await readState(page))?.pusher.cycles ?? 0;
  for (let index = 1; index < drops; index += 1) {
    const state = await readState(page);
    if (state?.phase === 'settled' || state?.endless?.ruinVisible === true) break;
    if (state?.phase !== 'drainOut') {
      const advanced = await waitFor(
        page,
        (current) => (current?.pusher?.cycles ?? 0) > lastCycle,
        20_000,
      );
      if (!advanced) break;
      lastCycle = advanced.pusher.cycles;
    }
    await dropUntilAccepted(page, pickLanes[index % pickLanes.length]);
  }
}

function coinsPerCycle(cycles) {
  const perCycle = [];
  let previous = 0;
  for (const sample of cycles) {
    perCycle.push(sample.coins - previous);
    previous = sample.coins;
  }
  const total = perCycle.reduce((sum, value) => sum + value, 0);
  const average = perCycle.length ? total / perCycle.length : 0;
  let gap = 0;
  let longestGap = 0;
  let started = false;
  for (const value of perCycle) {
    if (!started) {
      if (value <= 0) continue;
      started = true;
      gap = 0;
      continue;
    }
    if (value <= 0) {
      gap += 1;
      longestGap = Math.max(longestGap, gap);
    } else {
      gap = 0;
    }
  }
  return { total, average, longestGap, cycles: cycles.length };
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await context.newPage();
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 10, null, {
  timeout: 20_000,
});

const geo = await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.coinGeometry?.() ?? null);
console.log(
  `[info] 币档位 ×${geo?.scale}：直径 ${(geo.diameter * 1000).toFixed(1)} mm、` +
    `半径 ${(geo.radius * 1000).toFixed(1)} mm、层高 ${(geo.layerStep * 1000).toFixed(2)} mm`,
);

const table = await readTable(page);
console.log(`[info] 盘面 ${table?.coins} 枚（容量 ${table?.capacity}）`);

const rows = [];
for (const retract of RETRACTS) {
  for (let rep = 0; rep < REPS; rep += 1) {
    await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.clearSave?.());
    await startRun(page);
    await page.evaluate(
      (value) => window.__THREE_GAME_TEST_HOOKS__?.setTuning?.({ pusherRetractSec: value }),
      retract,
    );
    const tuning = await page.evaluate(
      () => window.__THREE_GAME_TEST_HOOKS__?.setTuning?.({})?.physics?.tuning?.pusher ?? null,
    );

    const before = await readState(page);
    // 台面（推板顶面）上的枚数：走引擎自己的 isOnDeckAt，不写第二份公式。
    const deckAt = async () => {
      const coins = await readCoins(page);
      if (!coins.length) return 0;
      const flags = await page.evaluate((points) => {
        const fn = window.__THREE_GAME_TEST_HOOKS__?.isOnDeckAt;
        return points.map((p) => (fn ? fn(p[0], p[1], p[2]) : false));
      }, coins.map((coin) => [coin.x, coin.y, coin.z]));
      return flags.filter(Boolean).length;
    };
    const deckStart = await deckAt();

    await playRun(page, DROPS);

    const telemetry = await readTelemetry(page);
    const pace = coinsPerCycle(telemetry.cycles ?? []);
    const after = await readState(page);
    const deckEnd = await deckAt();
    const tail = (telemetry.cycles ?? []).slice(-12).map((sample, index, all) => {
      if (index === 0) return null;
      return sample.coins - all[index - 1].coins;
    });
    rows.push({
      retract,
      rep: rep + 1,
      period: tuning?.period?.toFixed(2) ?? '?',
      cycles: pace.cycles,
      total: pace.total,
      average: pace.average,
      longestGap: pace.longestGap,
      earned: after?.earned ?? 0,
      coinsStart: before?.activeCoins ?? 0,
      coinsEnd: after?.activeCoins ?? 0,
      deckStart,
      deckEnd,
      anomalies: after?.anomalies ?? 0,
      tail: tail.filter((value) => value !== null).join(','),
    });
    console.log(
      `  回撤 ${retract.toFixed(2)}s · 第 ${rep + 1} 遍：周期 ${rows.at(-1).period}s，循环 ${pace.cycles}，` +
        `越线 ${pace.total} 枚，均值 ${pace.average.toFixed(3)} 枚/循环，最长空档 ${pace.longestGap}`,
    );
    console.log(
      `      币 ${rows.at(-1).coinsStart} → ${rows.at(-1).coinsEnd}，台面 ${deckStart} → ${deckEnd}，` +
        `入账 ${rows.at(-1).earned}，异常 ${rows.at(-1).anomalies}`,
    );
    console.log(`      末 12 个循环逐循环越线：${rows.at(-1).tail}`);
  }
}

console.log('\n── 汇总 ──');
console.log('回撤(s)  周期(s)  循环  越线  枚/循环  最长空档  币 始→终      台面 始→终  入账');
for (const row of rows) {
  console.log(
    `  ${row.retract.toFixed(2)}   ${String(row.period).padStart(5)}  ${String(row.cycles).padStart(4)}  ` +
      `${String(row.total).padStart(4)}  ${row.average.toFixed(3).padStart(7)}  ` +
      `${String(row.longestGap).padStart(8)}  ${String(row.coinsStart).padStart(4)} → ${String(row.coinsEnd).padStart(4)}  ` +
      `${String(row.deckStart).padStart(4)} → ${String(row.deckEnd).padStart(4)}  ${String(row.earned).padStart(4)}`,
  );
}

await browser.close();
