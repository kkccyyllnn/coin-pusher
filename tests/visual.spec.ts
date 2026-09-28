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

/**
 * **即时**读画布的真实尺寸（backing store 与 CSS 两套）。
 *
 * 与 `diagnostics()` 的区别只有一件事：诊断快照是**上一帧发布**的，
 * 而 `setPixelScale` 这类 hook 只 `render()`、不发布诊断。
 * 验证「分辨率改动是否落到画布上」必须走这里，否则比的是旧帧。
 */
async function canvasSize(page: Page) {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('#game-canvas');
    if (!canvas) return null;
    return {
      width: canvas.width,
      height: canvas.height,
      clientWidth: canvas.clientWidth,
      clientHeight: canvas.clientHeight,
    };
  });
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
    const before = await diagnostics(page);
    const initialChips = before?.chips ?? 0;
    await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.drop?.(0));
    await waitFrames(page, 30);

    const mid = await diagnostics(page);
    // ★ 「一次有效投币只扣 1 枚筹码」的正确读数是**消耗账本**（`spent`），不是 `chips`。
    //
    // `chips` 会被返值污染：投币之后的这 30 帧里只要有币越线结算，`chips` 就**不降反升**
    // （实测偶发 `initialChips−1` 变成 `initialChips+2`，与推板 1.8 枚/循环的节奏撞上就红）。
    // 那是**合法结算**，不是「扣多了/扣少了」——用 `chips` 直接比就是一条概率性判据。
    // 所以：扣减量读 `spent`；`chips` 用三账本恒等式把返值解释掉。
    expect((mid?.spent ?? 0) - (before?.spent ?? 0)).toBe(1);
    expect(mid?.chips).toBe(
      initialChips -
        1 +
        ((mid?.earned ?? 0) - (before?.earned ?? 0)) +
        ((mid?.begged ?? 0) - (before?.begged ?? 0)),
    );
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

  test('像素分辨率：默认原生，「倍率」与「最近邻」是两个正交旋钮（可逆）', async ({ page }) => {
    await page.goto('/');
    await waitFrames(page, 5);

    // 每个断言都带上现场读数：这套判据曾在 iPhone 13（视口 390×**664**）上红过，
    // 没有现场读数就得靠猜是哪个视口、哪个数字不对。
    const on = await diagnostics(page);
    const site =
      `upscale=${on?.performance.upscale} pixelated=${on?.performance.pixelated} ` +
      `backing=${on?.canvas.width}x${on?.canvas.height} css=${on?.canvas.clientWidth}x${on?.canvas.clientHeight} ` +
      `internalH=${on?.performance.internalHeight}`;

    // ① 默认档 = **原生分辨率 + 平滑采样**（`pixelated` 默认关、`targetHeight` 720）。
    //    这条钉住「默认不再是块状像素」这个决定本身：若有人把默认档改回 ×2，
    //    或让 `pixelated` 重新去管倍率，这里会红。
    expect(on?.performance.pixelated, site).toBe(false);
    expect(Number.isInteger(on?.performance.upscale), site).toBe(true);
    expect(on?.performance.upscale, site).toBe(1);
    expect(Math.abs((on?.canvas.width ?? 0) - (on?.canvas.clientWidth ?? 0)), site).toBeLessThanOrEqual(1);

    // ② 显式倍率 + 最近邻 → 像素风真的落地：backing = CSS ÷ 2，且画面非空白。
    //    `upscale` 是引擎算的，`canvas.width` 是画布实际被设成的值——两者必须一致。
    const pix = await page.evaluate(() =>
      window.__THREE_GAME_TEST_HOOKS__?.setPixelScale?.({ upscale: 2, pixelated: true }),
    );
    expect(pix?.pixelated, JSON.stringify(pix)).toBe(true);
    expect(pix?.upscale, JSON.stringify(pix)).toBe(2);
    expect(pix?.pixelRatio, JSON.stringify(pix)).toBeCloseTo(0.5, 10);
    // 引擎算的内部宽（`setPixelScale` 的即时返回）与画布**实际**被设成的宽高是两个来源，
    // 对得上才叫「倍率真的落到了画布上」。
    // ★ 这里**不能**读 `diagnostics(page)`：诊断快照是上一帧发布的，而 `setPixelScale`
    //   只 `render()`、不发布诊断 ⇒ 读回来的是改动之前的旧值（本条曾因此假红）。
    const pixCanvas = await canvasSize(page);
    expect(
      Math.abs((pixCanvas?.width ?? 0) - (pix?.internalWidth ?? 0)),
      `×2 时 引擎侧 ${JSON.stringify(pix)} / 画布侧 ${JSON.stringify(pixCanvas)}`,
    ).toBeLessThanOrEqual(1);
    await waitFrames(page, 3);
    expect((await sampleCanvas(page)).ok).toBe(true);

    // ③ **解耦不变量**：只关最近邻，倍率必须保持 ×2。
    //    这是本次改动唯一不能破的语义——旧版 `pixelated=false` 会把倍率吞回 1，
    //    于是「画质分档降分辨率」在默认档下静默失效（名义开关）。
    const smooth = await page.evaluate(() =>
      window.__THREE_GAME_TEST_HOOKS__?.setPixelScale?.({ pixelated: false }),
    );
    expect(smooth?.pixelated, JSON.stringify(smooth)).toBe(false);
    expect(smooth?.upscale, JSON.stringify(smooth)).toBe(2);

    // ④ 取消显式倍率 → 回到 `targetHeight` 推导；默认档（目标高 720 / 视口 720）给回原生。
    const back = await page.evaluate(() =>
      window.__THREE_GAME_TEST_HOOKS__?.setPixelScale?.({ upscale: null }),
    );
    expect(back?.upscale, JSON.stringify(back)).toBe(1);
    expect(back?.pixelRatio, JSON.stringify(back)).toBe(1);
    const backCanvas = await canvasSize(page);
    expect(
      Math.abs((backCanvas?.height ?? 0) - (backCanvas?.clientHeight ?? 0)),
      `取消覆盖后 引擎侧 ${JSON.stringify(back)} / 画布侧 ${JSON.stringify(backCanvas)}`,
    ).toBeLessThanOrEqual(1);
    await waitFrames(page, 3);
    expect((await sampleCanvas(page)).ok).toBe(true);

    // ⑤ 倍率上下界：`maxUpscale` 兜住荒谬的显式倍率（防超大视口压成马赛克），
    //    而 `minUpscale` 现在默认是 **1**——把目标高度设得比视口还高时倍率就是 1，
    //    这是「原生分辨率」的期望行为，不再是旧版要兜住的静默失效。
    const capped = await page.evaluate(() =>
      window.__THREE_GAME_TEST_HOOKS__?.setPixelScale?.({ upscale: 99 }),
    );
    expect(capped?.upscale, `upscale=99 时 ${JSON.stringify(capped)}`).toBeLessThanOrEqual(4);
    expect(capped?.upscale, `upscale=99 时 ${JSON.stringify(capped)}`).toBeGreaterThanOrEqual(1);
    const floored = await page.evaluate(() =>
      window.__THREE_GAME_TEST_HOOKS__?.setPixelScale?.({ targetHeight: 10000, upscale: null }),
    );
    expect(floored?.upscale, `targetHeight=10000 时 ${JSON.stringify(floored)}`).toBe(1);
  });

  test('换肤真的改变画面（toon 材质下不会静默失效）', async ({ page }) => {
    await page.goto('/');
    await waitFrames(page, 5);
    const before = await page.locator('#game-canvas').screenshot();

    // V2 把机柜材质换成 `MeshToonMaterial` 之后，`applyCabinetSkin` 里原来的
    // `instanceof THREE.MeshStandardMaterial` 判定会**静默跳过全部部件**：
    // 换肤函数照跑、零报错、返回成功，但颜色一点都不变。
    // 这种缺陷截图对比之外很难发现，所以这里逐字节比画面。
    const unlocked = await page.evaluate(() =>
      window.__THREE_GAME_TEST_HOOKS__?.unlockSkin?.('cabinet', 'amber', 20),
    );
    expect(unlocked?.unlocked).toBe(true);

    const picked = await page.evaluate(() =>
      window.__THREE_GAME_TEST_HOOKS__?.selectSkin?.('cabinet', 'amber'),
    );
    expect(picked?.cabinetSkin).toBe('amber');

    await waitFrames(page, 5);
    const after = await page.locator('#game-canvas').screenshot();
    expect(before.equals(after)).toBe(false);
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
