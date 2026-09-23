import { expect, test, type Page } from '@playwright/test';

// 真实物理推进需要较长的游戏时间：整局走完约 1~2 分钟。
test.setTimeout(300_000);

type CoinSample = {
  kind: string;
  x: number;
  y: number;
  z: number;
  vz: number;
  playerDropped: boolean;
};

async function diagnostics(page: Page) {
  return page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__);
}

async function coins(page: Page): Promise<CoinSample[]> {
  return page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.coins?.() ?? []);
}

async function playerCoin(page: Page): Promise<CoinSample | null> {
  const all = await coins(page);
  return all.find((coin) => coin.playerDropped) ?? null;
}

async function boot(page: Page, state: string): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 5);
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.seed?.(20260921));
  await page.evaluate((name) => window.__THREE_GAME_TEST_HOOKS__?.setState?.(name), state);
}

/** 冷却期间投币会被拒绝，这里重试到被接受为止。 */
async function dropUntilAccepted(page: Page, lane: number, budgetMs = 5000): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const accepted = await page.evaluate(
      (value) => window.__THREE_GAME_TEST_HOOKS__?.drop?.(value) ?? false,
      lane,
    );
    if (accepted) return true;
    await page.waitForTimeout(80);
  }
  return false;
}

type Diagnostics = Awaited<ReturnType<typeof diagnostics>>;

/**
 * 「无异常币」断言必须自带现场：再红时直接打出逃逸样本（位置+速度三分量），
 * 不用靠临时探针复现。（2026-09-22 mobile-safari 抓到一次无样本的红，频率约 1/20。）
 */
function expectNoAnomalies(state: Diagnostics): void {
  if ((state?.anomalies ?? 0) > 0) {
    console.log(`anomalySamples=${JSON.stringify(state?.anomalySamples)}`);
  }
  expect(state?.anomalies).toBe(0);
}

test.describe('机器人试玩', () => {
  test('单枚币走完「落钉 → 上台面 → 被输送到前唇 → 落到低台」的完整路径', async ({ page }) => {
    await boot(page, 'playing');
    expect(await dropUntilAccepted(page, 0)).toBe(true);

    // 1) 落到台面：离开钉阵高度
    await expect
      .poll(async () => (await playerCoin(page))?.y ?? 9, { timeout: 8000, intervals: [120] })
      .toBeLessThan(0.42);

    // 2) 被台面输送到前唇之外，并掉到低台
    await expect
      .poll(async () => (await playerCoin(page))?.z ?? -9, { timeout: 15_000, intervals: [200] })
      .toBeGreaterThan(0);
    await expect
      .poll(async () => (await playerCoin(page))?.y ?? 9, { timeout: 15_000, intervals: [200] })
      .toBeLessThan(0.1);
  });

  test('投光筹码后必须产生真实越线返值，并走完收尾（破产弹窗或结算）', async ({ page }) => {
    await boot(page, 'playing');

    const lanes = [-0.85, -0.45, 0, 0.45, 0.85];
    // 投到本局**真的结束**为止，而不是投固定枚数就停：
    // 筹码见底会进收尾，而满盘收尾常把筹码回吐给玩家（本局继续），
    // 固定枚数投完就停的话，机器人会在一局还没结束时就干等，直到超时。
    //
    // 期限 6 分钟：XIXI 老虎机的演出奖励让收尾期「回吐→复活」的循环更密
    // （实测整局 40~112 投 / 30~235 秒，最长样本离旧期限 240 秒只剩 5 秒）。
    // 期限只是上限——正常局 ~1 分钟就结束；若它被打爆，先查经济符号（期望是否为负），
    // 不要直接再加期限（2026-09-22 的教训：奖励水源曾把期望打成正，600 秒 1191 投）。
    const deadline = Date.now() + 360_000;
    let drops = 0;
    let ended = false;
    while (Date.now() < deadline) {
      const state = await diagnostics(page);
      // 结束的判定必须与下面的断言同一条前沿：破产窗可能比状态机**早一帧**亮起
      // （面板已弹出、run 还在收尾里），这时读到 settleReason 会是 null。
      // 所以「破产」要连 settleReason 一起成立，否则继续投——多投几枚代价很小，
      // 拿一帧的偏差当终态却会让断言假红（实测踩过一次）。
      const settled =
        state?.phase === 'settled' ||
        (state?.endless.ruinVisible === true && state?.settleReason === 'exhausted');
      if (settled) {
        ended = true;
        break;
      }
      const accepted = await dropUntilAccepted(page, lanes[drops % lanes.length], 3000);
      if (accepted) {
        drops += 1;
        continue;
      }
      // 投币被拒 = 筹码见底、正在收尾。等一会儿再看：要么回吐筹码继续，要么破产。
      await page.waitForTimeout(400);
    }
    expect(ended).toBe(true);
    expect(drops).toBeGreaterThan(0);

    // 关键断言：返值来自币真正越过前沿，而不是任何形式的假判定。
    await expect
      .poll(async () => (await diagnostics(page))?.earned ?? 0, { timeout: 120_000, intervals: [1000] })
      .toBeGreaterThan(0);

    const final = await diagnostics(page);
    expect(final?.settleReason).toBe('exhausted');
    expect(final?.earned ?? 0).toBeGreaterThan(0);
    expectNoAnomalies(final);
    expect(final?.pusher.running).toBe(false);
    // 收尾以「盘面没把筹码还回来」收场 → 弹破产窗，手里基本没筹码。
    //
    // **不能要求筹码恰好为 0**：收尾走完、破产窗弹出之后，仍可能有一枚在途币越线返值——
    // 那是被**记进账本**的迟到返值（`gainChips` 不复活，所以本局停在破产窗），不是漏记。
    // 满盘之后收尾期越线更频繁，这条从「偶尔」变成了常态（实测出现过「破产窗 + 剩 1 筹码」）。
    expect(final?.chips ?? -1).toBeGreaterThanOrEqual(0);
    expect(final?.chips ?? -1).toBeLessThan(final?.buyIn ?? 0);
    // 三账本恒等式：任何一条收尾路径上都不能漏记。
    expect(final?.chips).toBe(
      (final?.buyIn ?? 0) + (final?.earned ?? 0) + (final?.begged ?? 0) - (final?.spent ?? 0),
    );
    await expect(page.locator('#ruin-panel')).toBeVisible();
  });

  test('投币能点亮 XIXI 槽位（物理落点登记）', async ({ page }) => {
    await boot(page, 'playing');

    const lanes = [-0.9, 0, 0.9, -0.9, 0, 0.9, -0.5, 0.5, -0.9, 0, 0.9, 0];
    for (let index = 0; index < 12; index += 1) {
      await dropUntilAccepted(page, lanes[index % lanes.length]);
    }

    // 点亮或集齐（集齐后四槽清空重计，所以把 completed 事件也算进来）。
    await expect
      .poll(
        async () => {
          const state = await diagnostics(page);
          const lit = (state?.xixi ?? []).filter(Boolean).length;
          const completed = (state?.boostCharges ?? 0) > 0 || (state?.shows?.busy ?? false);
          return lit + (completed ? 4 : 0);
        },
        { timeout: 90_000, intervals: [1000] },
      )
      .toBeGreaterThan(0);

    const state = await diagnostics(page);
    expectNoAnomalies(state);
  });

  test('满盘预置的币塔在推板作用下保持可解释的倒塌与结算', async ({ page }) => {
    await boot(page, 'ready');

    const tableCoins = await coins(page);
    // 预置里有叠起的币柱：至少要有若干枚明显高于单层币床。
    const stacked = tableCoins.filter((coin) => coin.y > 0.04);
    expect(stacked.length).toBeGreaterThanOrEqual(4);

    for (let index = 0; index < 8; index += 1) {
      await dropUntilAccepted(page, index % 2 === 0 ? -0.5 : 0.5);
    }

    await expect
      .poll(async () => (await diagnostics(page))?.pusher.cycles ?? 0, { timeout: 60_000, intervals: [1000] })
      .toBeGreaterThanOrEqual(4);

    const state = await diagnostics(page);
    expectNoAnomalies(state);
  });
});
