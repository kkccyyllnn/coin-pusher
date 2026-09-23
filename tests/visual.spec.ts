import { expect, test, type Page } from '@playwright/test';
import { PNG } from 'pngjs';

type CanvasSample = {
  ok: boolean;
  reason: string;
  variance?: number;
  colorBuckets?: number;
};

async function sampleCanvas(page: Page): Promise<CanvasSample> {
  const canvas = page.locator('#game-canvas');
  const box = await canvas.boundingBox();
  if (!box || box.width < 32 || box.height < 32) {
    return { ok: false, reason: 'canvas-too-small' };
  }

  const buffer = await canvas.screenshot();
  const png = PNG.sync.read(buffer);
  let min = 255;
  let max = 0;
  let alphaPixels = 0;
  const buckets = new Set<string>();
  const stride = Math.max(1, Math.floor((png.width * png.height) / 4096));

  for (let pixel = 0; pixel < png.width * png.height; pixel += stride) {
    const offset = pixel * 4;
    const r = png.data[offset];
    const g = png.data[offset + 1];
    const b = png.data[offset + 2];
    const a = png.data[offset + 3];
    min = Math.min(min, r, g, b);
    max = Math.max(max, r, g, b);
    if (a > 0) alphaPixels += 1;
    buckets.add(`${r >> 4},${g >> 4},${b >> 4},${a >> 6}`);
  }

  const variance = max - min;
  return {
    ok: alphaPixels > 256 && (variance > 8 || buckets.size > 3),
    reason: 'sampled',
    variance,
    colorBuckets: buckets.size,
  };
}

async function diagnostics(page: Page) {
  return page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__);
}

async function table(page: Page) {
  return page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.table?.() ?? null);
}

async function waitForFrame(page: Page, minFrame: number): Promise<void> {
  await page.waitForFunction((min) => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > min, minFrame);
}

/**
 * 等「接下来的若干帧」——诊断快照是上一帧发布的，动作后立刻读会读到旧状态。
 *
 * 不要用 `waitForFrame(page, 5)` 代替：帧号是累计的，页面早就过了 5，
 * 那个调用会立刻返回，读到的还是动作之前的快照。
 */
async function waitFrames(page: Page, count = 3): Promise<void> {
  const base = (await diagnostics(page))?.frame ?? 0;
  await page.waitForFunction(
    ({ from, span }) => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > from + span,
    { from: base, span: count },
  );
}

test.describe('币塔街机机台', () => {
  test('渲染出非空白的机台画面且无控制台报错', async ({ page }, testInfo) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => pageErrors.push(error.message));

    await page.goto('/');
    await expect(page.locator('#game-canvas')).toBeVisible();
    await waitForFrame(page, 10);

    const sample = await sampleCanvas(page);
    expect(sample, JSON.stringify(sample)).toMatchObject({ ok: true });

    const state = await diagnostics(page);
    const spec = await table(page);
    // v3 只有无尽一种玩法：开局就是满盘预置的 ready 态，推板停着等玩家投币。
    expect(state?.phase).toBe('ready');
    expect(state?.activeCoins).toBe(spec?.coins);
    expect(state?.pusher.running).toBe(false);

    await testInfo.attach(`${testInfo.project.name}-ready`, {
      body: await page.screenshot({ fullPage: true }),
      contentType: 'image/png',
    });

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });

  test('一次有效投币只扣 1 枚筹码，并启动推板', async ({ page }) => {
    await page.goto('/');
    await waitForFrame(page, 5);

    const before = await diagnostics(page);
    const accepted = await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.drop?.(0) ?? false);
    expect(accepted).toBe(true);

    await waitForFrame(page, (before?.frame ?? 0) + 5);
    const after = await diagnostics(page);
    expect(after?.chips).toBe((before?.chips ?? 0) - 1);
    expect(after?.spent).toBe((before?.spent ?? 0) + 1);
    expect(after?.activeCoins).toBe((before?.activeCoins ?? 0) + 1);
    expect(after?.phase).toBe('playing');
    expect(after?.pusher.running).toBe(true);
  });

  test('冷却中的输入不扣筹码', async ({ page }) => {
    await page.goto('/');
    await waitForFrame(page, 5);

    // 盘面枚数不写死：加密盘面后这个数字会变，用相对量验证。
    const before = await diagnostics(page);
    const first = await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.drop?.(0) ?? false);
    const second = await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.drop?.(0.5) ?? false);
    expect(first).toBe(true);
    expect(second).toBe(false);

    await waitForFrame(page, 20);
    const state = await diagnostics(page);
    expect(state?.chips).toBe((before?.chips ?? 0) - 1);
    expect(state?.activeCoins).toBe((before?.activeCoins ?? 0) + 1);
  });

  test('推板按 2.4 秒周期往复，并在前推后回到归位位置', async ({ page }) => {
    await page.goto('/');
    await waitForFrame(page, 5);
    // 行程**从运行时读**，不写死阈值：P2 满盘化把行程从 0.84 打到 0.30，
    // 写死 `> 0.3` 会在改动之后变成一条恒假的断言。
    const travel = await page.evaluate(() => {
      const tuning = window.__THREE_GAME_TEST_HOOKS__?.setTuning?.({});
      return Number((tuning as { pusherTravel?: number } | undefined)?.pusherTravel ?? 0.3);
    });
    await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.drop?.(0));

    await expect
      .poll(async () => (await diagnostics(page))?.pusher.offset ?? 0, { timeout: 8000 })
      .toBeGreaterThan(travel * 0.8);

    await expect
      .poll(async () => (await diagnostics(page))?.pusher.cycles ?? 0, { timeout: 12000 })
      .toBeGreaterThanOrEqual(1);
  });

  test('开局 XIXI 四槽全灭、加力未充能且按钮隐藏', async ({ page }) => {
    await page.goto('/');
    await waitForFrame(page, 5);
    await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setState?.('ready'));
    await waitFrames(page, 3);

    const state = await diagnostics(page);
    expect(state?.xixi).toEqual([false, false, false, false]);
    expect(state?.boostCharges).toBe(0);
    // 未充能时按钮是 hidden，不是 disabled——没充能不该占位置。
    await expect(page.locator('#boost-button')).toBeHidden();
  });

  test('满盘预置：实际生成枚数与配置一致，且含返币筹码', async ({ page }) => {
    await page.goto('/');
    await waitForFrame(page, 5);

    const spec = await table(page);
    expect(spec?.coins).toBeGreaterThan(0);
    expect(spec?.payout).toBeGreaterThan(0);
    expect(spec?.bronze).toBeGreaterThan(0);
    expect(spec?.value).toBeGreaterThan(0);

    const state = await diagnostics(page);
    expect(state?.activeCoins).toBe(spec?.coins);
    expect(state?.anomalies).toBe(0);
  });

  test('满盘预置静置 2.5 秒不塌陷、不误结算', async ({ page }) => {
    await page.goto('/');
    await waitForFrame(page, 5);
    await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setState?.('ready'));

    const spec = await table(page);
    await page.waitForTimeout(2500);
    const state = await diagnostics(page);
    // 币塔与币床必须站得住：枚数不掉、异常为零、一枚都没越线。
    expect(state?.activeCoins).toBe(spec?.coins);
    expect(state?.anomalies).toBe(0);
    expect(state?.earned).toBe(0);
  });

  test('重复开局是幂等的：枚数、赚进与推板都回到起点', async ({ page }) => {
    await page.goto('/');
    await waitForFrame(page, 5);

    const spec = await table(page);
    const initialChips = (await diagnostics(page))?.chips ?? 0;
    await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.drop?.(0));
    await waitFrames(page, 30);

    const mid = await diagnostics(page);
    expect(mid?.chips).toBe(initialChips - 1);
    expect(mid?.phase).toBe('playing');

    await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.startRun?.());
    await waitFrames(page, 3);
    const state = await diagnostics(page);
    expect(state?.earned).toBe(0);
    // 钱包够的话，重开一局的入场筹码和上一局一样（buyIn = min(20, 钱包)）。
    expect(state?.chips).toBe(initialChips);
    expect(state?.buyIn).toBe(initialChips);
    expect(state?.phase).toBe('ready');
    expect(state?.pusher.running).toBe(false);
    expect(state?.pusher.cycles).toBe(0);
    expect(state?.activeCoins).toBe(spec?.coins);
    expect(state?.xixi).toEqual([false, false, false, false]);
    expect(state?.boostCharges).toBe(0);
  });

  test('画质分档只改渲染参数，不改盘面与返值规则', async ({ page }) => {
    await page.goto('/');
    await waitForFrame(page, 5);

    const before = await diagnostics(page);
    const forced = await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setQuality?.('low'));
    expect(forced?.tier).toBe('low');

    await waitForFrame(page, (before?.frame ?? 0) + 10);
    const after = await diagnostics(page);
    expect(after?.performance.tier).toBe('low');
    expect(after?.performance.shadows).toBe(false);
    // 降画质不得改动盘面或可推币数量。
    expect(after?.activeCoins).toBe(before?.activeCoins);
    expect(after?.earned).toBe(0);
  });

  test('破产弹窗 → 收工 → 再来一局：整条闭环复位', async ({ page }) => {
    await page.goto('/');
    await waitForFrame(page, 5);

    const spec = await table(page);
    await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setState?.('ruin'));

    // 破产弹窗是核心产出，不是失败页；数字全部是筹码口径，不能再出现「分数」。
    await expect(page.locator('#ruin-panel')).toBeVisible();
    await expect(page.locator('#ruin-title')).toHaveText('破产');
    await expect(page.locator('#beg-button')).toBeVisible();
    await expect(page.locator('#ruin-stats')).toContainText('本局赚进');
    await expect(page.locator('#ruin-stats')).not.toContainText('分数');

    // 收工 → 总结卡片（同一张面板，换标题、隐藏跪求、显示回存）。
    await page.locator('#quit-button').click();
    await expect(page.locator('#ruin-panel')).toBeVisible();
    await expect(page.locator('#ruin-title')).toHaveText('本局结束');
    await expect(page.locator('#beg-button')).toBeHidden();
    await expect(page.locator('#ruin-stats')).toContainText('回存钱包');

    // 再来一局 → 面板收起、盘面与筹码复位。
    await page.locator('#quit-button').click();
    await expect(page.locator('#ruin-panel')).toBeHidden();
    await waitFrames(page, 3);

    const state = await diagnostics(page);
    expect(state?.earned).toBe(0);
    expect(state?.phase).toBe('ready');
    expect(state?.pusher.running).toBe(false);
    expect(state?.activeCoins).toBe(spec?.coins);
    expect(state?.endless.ruinVisible).toBe(false);
    // 破产那一局一枚都没赚回来，所以回存 0；钱包只剩两次买入扣掉的部分。
    expect(state?.wallet).toBeLessThan(200);
  });
});
