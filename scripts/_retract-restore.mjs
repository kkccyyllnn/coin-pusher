/*
 * 隔离实验（10-07，0b）：`setTuning({pusherRetractSec})` 写回出厂值为什么没生效。
 *
 * 现象：probe 的 ③ 正对照里，0.9 → 0.45 那一写**生效**（快照读到 0.45、净漂移 25.50 毫米/循环），
 * 紧接着 0.45 → 0.9 那一写**没生效**（快照仍是 0.45）。全仓只有 `Game.applyTuning`（Game.ts:2766）
 * 一处写 `Pusher.durations`，所以两写不该有差别。
 *
 * 这里把「调参表的值」与「快照里的实际生效值」分开打印，用来分辨三种成因：
 *   A 表没写进去（`Object.assign` 的目标不是同一个对象）
 *   B 表写进去了但 `applyTuning` 没把它落到实例字段
 *   C 落下去了，之后又被谁改回来（⇒ 打印间隔 1 秒的第二次读数）
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:5188';

const browser = await chromium.launch({ channel: 'chromium' });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (error) => console.error('[pageerror]', error.message));
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 10, null, {
  timeout: 20_000,
});

/** 快照里的**实际生效值**（`snapshot.ts` 读的是 `Pusher.durations`，不是调参表）。 */
const live = () =>
  page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.physics?.tuning?.pusher?.retractSec ?? null);

/** 写一格并立刻拿回 `setTuning` 的返回值（= 合并后的**调参表**）。 */
const write = (value) =>
  page.evaluate(
    (v) => window.__THREE_GAME_TEST_HOOKS__?.setTuning?.({ pusherRetractSec: v }) ?? null,
    value,
  );

const report = async (label, value) => {
  const table = await write(value);
  const immediately = await live();
  await page.waitForTimeout(1000);
  const afterOneSecond = await live();
  console.log(
    `${label}：写 ${value}\n` +
      `    调参表 pusherRetractSec = ${table?.pusherRetractSec}\n` +
      `    快照(立即) = ${immediately}   快照(1 秒后) = ${afterOneSecond}\n` +
      `    快照 period = ${
        (await page.evaluate(
          () => window.__THREE_GAME_DIAGNOSTICS__?.physics?.tuning?.pusher?.period ?? null,
        )) ?? null
      }   pusher.running = ${
        (await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.pusher?.running ?? null)) ?? null
      }`,
  );
};

console.log(`起始快照 retract = ${await live()}`);
await report('第 1 写（破对称）', 0.45);
await report('第 2 写（还原）', 0.9);
await report('第 3 写（再破一次，看是否可重复）', 0.45);
await report('第 4 写（再还原）', 0.9);
// 空 patch：只走一遍 assign + applyTuning，用来验「applyTuning 本身会不会用表里的值覆盖实例字段」。
const noop = await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setTuning?.({}) ?? null);
console.log(`空 patch 后：调参表 = ${noop?.pusherRetractSec}，快照 = ${await live()}`);

await browser.close();
