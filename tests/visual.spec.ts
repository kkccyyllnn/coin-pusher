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

/**
 * 两张同尺寸 PNG 的差异摘要：像素数 + 包围盒。
 *
 * 为什么不用 `Buffer.compare(a,b) === 0` 直接断言：失败信息只会给一个 `1`，
 * 而「差在哪」决定了这是动画没冻住、画质降档、还是合成器抖动 —— 三种病因的修法完全不同。
 */
function diffSummary(a: PNG, b: PNG): string {
  if (a.width !== b.width || a.height !== b.height) {
    return `尺寸不同 ${a.width}x${a.height} vs ${b.width}x${b.height}（多半是内部分辨率变了）`;
  }
  let count = 0;
  let minX = a.width;
  let minY = a.height;
  let maxX = -1;
  let maxY = -1;
  for (let pixel = 0; pixel < a.width * a.height; pixel++) {
    const offset = pixel * 4;
    if (
      a.data[offset] !== b.data[offset] ||
      a.data[offset + 1] !== b.data[offset + 1] ||
      a.data[offset + 2] !== b.data[offset + 2]
    ) {
      count++;
      const x = pixel % a.width;
      const y = (pixel / a.width) | 0;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  return count === 0
    ? '无差异'
    : `差异 ${count} 像素，包围盒 x[${minX}..${maxX}] y[${minY}..${maxY}]（画布 ${a.width}x${a.height}）`;
}

/**
 * 以 `ref` 为基线，统计「被压暗 > 8」的像素占比与这些像素上的平均压暗量。
 *
 * 8 是刻意选的：三个通道合计 8（≈每通道 2.7）在 8 位图上是明显的抖动级，
 * 只有真正的压暗才会稳定越过它。
 */
function darkenStats(ref: PNG, shot: PNG) {
  const lum = (data: Uint8Array, o: number) =>
    0.2126 * data[o] + 0.7152 * data[o + 1] + 0.0722 * data[o + 2];
  let covered = 0;
  let sum = 0;
  let brightened = 0;
  const total = ref.width * ref.height;
  for (let pixel = 0; pixel < total; pixel++) {
    const offset = pixel * 4;
    const drop = lum(ref.data, offset) - lum(shot.data, offset);
    if (drop > 8) {
      covered++;
      sum += drop;
    } else if (-drop > 8) {
      brightened++;
    }
  }
  return { coverage: covered / total, meanDrop: covered ? sum / covered : 0, brightened };
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

    const beforeRestart = await diagnostics(page);
    await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.startRun?.());
    await waitFrames(page, 3);
    const state = await diagnostics(page);
    expect(state?.earned).toBe(0);
    /*
     * ★ S4 合并账户：这两行原来断的是「重开后的筹码 = 最初的入场额」（都等于 `initialChips`），
     *   因为旧模型每次 `startRun` 都从钱包扣 20 买入 ⇒ 重开必然把桌上重置成入场额。
     *   合并之后**重开不花一分钱** ⇒ 余额延续上一段的值（实测比 `initialChips` 多几枚，
     *   就是那 30 帧里盘面越线的净返值）。⇒ 这不是回归，是这条用例的**指称物变了**。
     *
     * 新的断法比旧的更硬，也更贴近 S4 想保证的事：
     *   `initial === chips`（新段的基准就等于账户余额，没有任何"入场费"抬高或压低它）
     *   + `spent / earned / loaned` 全归零（新段的账是干净的）。
     * 和重开前那一刻比而不是和 `initialChips` 比：中间仍有帧会结算越线，
     * 拿 `initialChips` 当基准就把一个时间差写成了常数（`spent === 1` 那段注释是同一个教训）。
     */
    expect(state?.chips).toBe(beforeRestart?.chips);
    expect(state?.initial).toBe(beforeRestart?.chips);
    expect(state?.spent).toBe(0);
    expect(state?.loaned).toBe(0);
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

  test('描边：关掉逐像素全等、开着数得出边缘（G2 的恒等性判据）', async ({ page }) => {
    // ★ 只在 desktop-chrome 上跑。理由不是「移动视口不重要」，是**这条判据的形式**
    // 在 mobile-safari 项目上站不住：同一冻结帧连拍两次，实测差 55529 个像素
    //（包围盒横贯币床，y[383..1446]），而我用 `devices['iPhone 13']` 的完整描述符
    //（含 isMobile/hasTouch/DPR 3）单独复现时，chromium 与 webkit 都是**逐字节 0 差**。
    // ⇒ 差异出在 playwright×webkit 的画布取回路径上，与描边无关。
    // 把恒等判据放宽成「比例阈值」也能过，但那样它就再也抓不到 G1 那类
    // 「整幅微微变暗」了 —— 宁可只在能证的地方证。
    // 待办：谁定位到 webkit 那条抖动（怀疑是 preserveDrawingBuffer:false 下的
    // 合成器重采样），就把这个 skip 摘掉。
    // ★ 10-01 定性结案：**这条 skip 是判据形式的固有约束，不是待修的缺陷。**
    // 「逐像素全等」要成立，前提是同一帧能被确定性取回；上面已经量出取回路径本身
    // 在 playwright×webkit 下会差 55529 个像素，而我们的代码没有那个变量。
    // 放宽成比例阈值能过，但就抓不到 G1 那类「整幅微微变暗」——所以恒等版只留在
    // 能证的 desktop-chrome。**webkit 上的覆盖没有丢**：同文件后面那条分布判据
    // （「把抖动量本身测进来当基准，再要求信号至少是它的 20 倍」）在两个 project
    // 都跑，它才是跨浏览器的描边判据。⇒ 摘 skip 的唯一条件是「webkit 取回变确定」，
    // 而那要改的是 playwright，不是这里。
    test.skip(
      test.info().project.name !== 'desktop-chrome',
      '逐字节恒等判据依赖帧缓冲可确定性取回；webkit 上不可（见注释）',
    );
    await page.goto('/');
    // 冻结：不冻结的话两次截图之间币堆会继续演化，量到的差就分不清是描边还是动画。
    // （G0 判 rim 断线时就是这么被自动演示的盘面污染过一次。）
    await page.evaluate(async () => {
      const hooks = window.__THREE_GAME_TEST_HOOKS__;
      await hooks?.setReducedMotion?.(true);
      hooks?.setState?.('ready');
      await hooks?.setPausedForScreenshot?.(true);
      // 显式归零，**不依赖出厂默认**：默认值以后会随判图调整（G2 现在就是 0.35），
      // 依赖它的话这条判据会在某天早上突然变成「off 帧里本来就有线」。
      hooks?.setTuning?.({ outlineScale: 0 });
      // ★ 钉住画质档：`PerformanceGovernor` 会在连续低帧窗口后降档，而降档 =
      //   改 `pixelTargetHeight` = **改内部分辨率** ⇒ 两张图不可能逐字节相同。
      hooks?.setQuality?.('high');
    });
    // 多等几帧再取基线：开局有若干**节流/倒计时**的东西还在落定（招牌 LED 最多
    // 125 ms 重画一次，见 `render/marqueeScreen.ts`；`startRun` 扣买入会让账本再变一次）。
    await waitFrames(page, 30);

    const shot = async () => PNG.sync.read(await page.locator('#game-canvas').screenshot());
    const off = await shot();
    const offAgain = await shot();
    // 先证明「冻结 + 同一设置」真的是确定性的，否则后面两条比较都没有意义。
    expect(Buffer.compare(off.data, offAgain.data), diffSummary(off, offAgain)).toBe(0);

    await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setTuning?.({ outlineScale: 0.35 }));
    await waitFrames(page, 3);
    const on = await shot();

    // 描边是**压暗**，所以两个方向分开数：变暗的像素必须成群（有线），
    // 变亮的必须几乎没有（有的话说明 mask 串到了别的地方）。
    let darker = 0;
    let brighter = 0;
    for (let pixel = 0; pixel < off.width * off.height; pixel++) {
      const offset = pixel * 4;
      const a =
        0.2126 * off.data[offset] + 0.7152 * off.data[offset + 1] + 0.0722 * off.data[offset + 2];
      const b =
        0.2126 * on.data[offset] + 0.7152 * on.data[offset + 1] + 0.0722 * on.data[offset + 2];
      if (a - b > 8) darker++;
      else if (b - a > 8) brighter++;
    }
    const total = off.width * off.height;
    expect(darker / total, '描边开着应当至少描出 1% 的像素').toBeGreaterThan(0.01);
    expect(brighter / total, '描边只该压暗，不该提亮').toBeLessThan(0.001);

    // ★ 恒等性（这条才是主判据）：关掉之后必须与开之前**逐字节全等**。
    // 它是逐事件恒等式而不是分布统计，所以能钉住「效果没接到但画面看着差不多」，
    // 也能钉住色彩管线被顺手改动 —— G1 那种「整幅微微变暗」在这里会直接红。
    await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setTuning?.({ outlineScale: 0 }));
    await waitFrames(page, 3);
    const offAfter = await shot();
    expect(Buffer.compare(off.data, offAfter.data), 'outlineScale 归零必须逐像素回到基线').toBe(0);
  });

  /**
   * ★ 描边强度的**硬判据**（把「0.35 是看图定的」这件事变成可失败的检查）。
   *
   * ## 为什么不能只断言「强度 == 0.35」
   *
   * 那是把审美写死成常量：谁都不会去改它，但它也**永远不会**因为效果真的坏了而红。
   * 强度真正对应的两件事是可测的：
   *
   * - **覆盖率**（有多少像素被描上线）—— 机制是否在工作。ID / 深度通道任一失效，
   *   它会塌向 0；阈值设得太松或噪声进来了，它会涨向两位数。
   * - **线深**（那些像素平均被压暗多少）—— 看不看得见、有没有把画面压死。
   *
   * ## 带是**量出来**的，不是拍的
   *
   * 同一冻结状态、同一固定机位，三次独立页面加载：桌面覆盖率 7.19 / 7.20 / 7.20 %、
   * 线深 28.3 / 28.3 / 28.4 ⇒ 重复性约 0.01 个百分点，带不是被噪声限制的。
   *
   * ★ 但**只有线深是视口无关的量**：移动 390×664 上线深 28.0（与桌面 28.3 同），
   *   覆盖率却是 13.75 %（桌面 7.20 %）—— 线宽按 CSS 像素恒定，窄视口里同样的线
   *   自然占更高比例。所以硬带只立在线深上（12 ~ 45），覆盖率只立下界；
   *   「描到噪声」那类失效交给 perf 里直接读附件的两条判据，不在这里重复。
   *
   * ## 噪声底**在同一测试里现测**
   *
   * 「判据要离噪声远」不能只写在注释里：先拍两张 `outlineScale = 0` 的帧算出噪声底，
   * 再要求信号至少是它的 20 倍。webkit 的画布取回会抖（见上一条测试为什么只跑 desktop），
   * 这里不靠 skip 回避，而是把抖动量本身测进来当基准。
   */
  test('暗部分级：amount=0 逐字节回到起点、开着量得出成片变化（#60 的恒等门 + 调试通道）', async ({ page }) => {
    // 与描边那条恒等判据同一个约束：逐字节比较只在 `desktop-chrome` 上做
    //（webkit 的画布取回路径本身会抖，见上面 G2 那条的结案注释）。
    test.skip(
      test.info().project.name !== 'desktop-chrome',
      '逐字节恒等判据依赖帧缓冲可确定性取回；webkit 上不可（与描边那条同因）',
    );
    await page.goto('/');
    await page.evaluate(async () => {
      const hooks = window.__THREE_GAME_TEST_HOOKS__;
      hooks?.seed?.(20260921);
      hooks?.setState?.('ready');
      await hooks?.setReducedMotion?.(true);
      hooks?.setQuality?.('high');
    });
    // 静置到币堆落定再冻结：庚案之后沉降仍会持续一会儿，不静置量到的是动画不是分级。
    await page.waitForTimeout(6000);
    await page.evaluate(async () => {
      const hooks = window.__THREE_GAME_TEST_HOOKS__;
      await hooks?.setPausedForScreenshot?.(true);
      // ★ 显式归零，**不依赖出厂默认**（默认档以后会随判图调整，依赖它等于把判据寄在别人的值上）。
      hooks?.setTuning?.({ shadowGrade: 0 });
    });
    await waitFrames(page, 30);

    const shot = async () => PNG.sync.read(await page.locator('#game-canvas').screenshot());
    const zero = await shot();
    const zeroAgain = await shot();
    // 先证明「冻结 + 同一设置」确实可确定性取回，否则后面所有比较都没有意义。
    expect(Buffer.compare(zero.data, zeroAgain.data), diffSummary(zero, zeroAgain)).toBe(0);

    const changedAgainst = async (other: { data: Uint8Array; width: number; height: number }) => {
      let changed = 0;
      for (let pixel = 0; pixel < zero.width * zero.height; pixel++) {
        const offset = pixel * 4;
        const d =
          Math.abs(zero.data[offset] - other.data[offset]) +
          Math.abs(zero.data[offset + 1] - other.data[offset + 1]) +
          Math.abs(zero.data[offset + 2] - other.data[offset + 2]);
        if (d > 4) changed++;
      }
      return changed;
    };

    await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setTuning?.({ shadowGrade: 0.12 }));
    await waitFrames(page, 3);
    const graded = await shot();
    const gradedChanged = await changedAgainst(graded);
    const gradedRatio = gradedChanged / (zero.width * zero.height);
    console.log(
      `[暗部分级] 0 → 0.12：有变化的像素 ${gradedChanged} 个（${(gradedRatio * 100).toFixed(2)}% 全画面）`,
    );
    // 分级是**滤色**（screen），所以这里不断言方向（变亮是设计），只断言"它真的作用到大片像素"。
    expect(gradedRatio, '分级开着必须有成片作用；接近 0 说明旋钮或权重接错了线').toBeGreaterThan(0.01);

    // ★ 恒等门：回到 amount=0 必须与起点**逐字节相同** —— `screen(base, 0)` 在 IEEE 上是恒等，
    //   所以任何残差都意味着实现坏了（这条就是 #60 欠的那个"留调试通道 + 能证明关掉即原样"）。
    await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setTuning?.({ shadowGrade: 0 }));
    await waitFrames(page, 3);
    const backToZero = await shot();
    expect(
      Buffer.compare(zero.data, backToZero.data),
      `回到 amount=0 后与起点仍有差：${diffSummary(zero, backToZero)}`,
    ).toBe(0);
  });

  test('描边强度落在硬带内：覆盖率与线深都量化可查，且随强度单调', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(async () => {
      const hooks = window.__THREE_GAME_TEST_HOOKS__;
      await hooks?.setReducedMotion?.(true);
      hooks?.setState?.('ready');
      hooks?.setQuality?.('high');
    });
    // 机位由测试自己钉死，**不用 autoFit**：否则窗口大小与取景时序会改变覆盖率，
    // 判据就变成了在测相机而不是在测描边。
    await page.evaluate(() =>
      window.__THREE_GAME_TEST_HOOKS__?.setCameraRig?.({
        autoFit: false,
        distance: 1.7,
        yawDeg: 10,
        pitchDeg: 18,
        targetX: 0,
        targetY: 0.45,
        targetZ: 0.5,
      }),
    );
    await page.waitForTimeout(1400);
    await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setPausedForScreenshot?.(true));
    await page.waitForTimeout(300);

    const shot = async () => PNG.sync.read(await page.locator('#game-canvas').screenshot());
    const at = async (scale: number) => {
      await page.evaluate((v) => window.__THREE_GAME_TEST_HOOKS__?.setTuning?.({ outlineScale: v }), scale);
      await page.waitForTimeout(320);
      return shot();
    };

    // 出厂默认从**诊断快照**读，不在测试里抄第二份：抄了之后改默认值的人不会记得改这里，
    // 判据就会去审一个已经不存在的强度。
    const shipped = (await diagnostics(page))?.renderer?.outline?.scale ?? -1;
    expect(shipped, '诊断快照要交出描边强度').toBeGreaterThanOrEqual(0);

    const zero = await at(0);
    const noiseFloor = darkenStats(zero, await at(0)).coverage;
    const def = await at(shipped);
    const stats = darkenStats(zero, def);

    console.log(
      `  [描边强度] 默认 ${shipped}：覆盖率 ${(stats.coverage * 100).toFixed(2)}%、` +
        `线深 ${stats.meanDrop.toFixed(1)}；同设置连拍的噪声底 ${(noiseFloor * 100).toFixed(4)}%`,
    );

    // ① 信号必须远离噪声：覆盖率至少是「同设置连拍」抖动的 20 倍。
    expect(stats.coverage, '覆盖率必须远大于同设置连拍的噪声底').toBeGreaterThan(
      Math.max(0.001, noiseFloor * 20),
    );
    // ② 机制在工作：一条线都没描出来就是通道塌了。
    expect(stats.coverage, '覆盖率低于 3% ⇒ 通道像在失效').toBeGreaterThanOrEqual(0.03);
    // ★ 这里**刻意不设覆盖率上界**，是量出来的结论而不是偷懒：同一份描边代码，
    //   桌面 1280×720 实测 7.20 %、移动 390×664 实测 13.75 % —— 线宽按 CSS 像素恒定
    //  （见 `glsl/outline.glsl.ts` 那条 ★），视口越窄，同样长的线占的像素比例就越高。
    //   所以上界测的是取景，不是对错。「描到噪声」那类失效由 perf 的
    //   `belowThreshold` / `idBlindButDepthSees` 两条直接读附件的判据负责，不在这里重复。
    // ③ 线深是**视口无关**的那一半（实测 28.3 与 28.0），所以硬带立在这里：
    //   低于 12 基本看不见，高于 45 整幅开始糊成一团。
    expect(stats.meanDrop, '线深低于 12 就基本看不见').toBeGreaterThanOrEqual(12);
    expect(stats.meanDrop, '线深高于 45 画面开始糊成一团').toBeLessThanOrEqual(45);
    // ④ 强度真的是在驱动这条线：单调，且没有中途饱和/被夹住。
    const low = darkenStats(zero, await at(0.15)).meanDrop;
    const high = darkenStats(zero, await at(0.7)).meanDrop;
    expect(low, '0.15 档应当明显弱于默认档').toBeLessThan(stats.meanDrop);
    expect(high, '0.7 档应当明显强于默认档').toBeGreaterThan(stats.meanDrop);
    // ⑤ 描边只该压暗：不该出现成片的提亮（那是 mask 串到别处去了）。
    expect(
      stats.brightened / (def.width * def.height),
      '不应出现成片提亮',
    ).toBeLessThan(0.001);
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

  test('触底 → 贷款续玩（本局延续、不重开）→ 收工 → 再来一局：整条闭环复位', async ({ page }) => {
    await page.goto('/');
    await waitForFrame(page, 5);

    const spec = await table(page);
    await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setState?.('ruin'));

    // ★ S3 去局感：非总结态的标题是「续玩报价」而不是「破产」——触底是岔口，不是终点。
    //   这里**刻意按文案断言**：这条用例的职责之一就是「叙事不许悄悄退回旧版」。
    //   （DOM id 仍叫 `#ruin-*`，那是刻意不改名——`endless.ruinVisible` 与一片判据挂在上面。）
    await expect(page.locator('#ruin-panel')).toBeVisible();
    await expect(page.locator('#ruin-title')).toHaveText('续玩报价');
    // 三个真选择都在位，且**贷款排在跪求之前**——DOM 顺序就是玩家看到的按钮顺序。
    await expect(page.locator('#loan-button')).toBeVisible();
    await expect(page.locator('#beg-button')).toBeVisible();
    // 数字全部是筹码口径，不能再出现「分数」。
    await expect(page.locator('#ruin-stats')).toContainText('本局赚进');
    await expect(page.locator('#ruin-stats')).not.toContainText('分数');

    /*
     * ★ S3 的新正文：断言的是**什么都没被重置**。走真实按钮点击而不是钩子——
     *   钩子只证明函数对，按钮才证明玩家能用的那条路对
     *   （`bindRuinActions` 的第三个回调、以及「到顶就藏按钮」的 gating 都挂在这条上）。
     *
     * ⚠️ 判别量的形状是**变异测出来才改对的**，两段弯路都留在原地，免得下次重踩：
     *   ① 第一版比「枚数相等」⇒ 变异（贷款路径里塞一句 `startRun()`）时**照样过**，
     *      因为重开会摆回同一套预置布局，枚数当然相同。比数量只证明「没少」，不证明「没重置」。
     *   ② 改比「逐枚位置指纹」⇒ 推演后发现**这个场景里它也证明不了**：
     *      破产态的盘面本来就是初始布局，重开摆回去还是同一套，指纹相同。
     *      （而且贷款会把推板重新开起来，位置还会随帧动 ⇒ 那条断言甚至会假红。）
     *   ⇒ 真正无时序依赖、又能区分「续玩」与「重开」的是**本局账目不被清零**：
     *      `spent` 由破产前的 `spendChips` 造成（×1.1 档实测 20），`startRun()` 会把它归零，
     *      而贷款续玩必须让它原样留着。`phase` 是同向的第二道（重开⇒'ready'，续玩⇒'playing'）。
     */
    const beforeLoan = await diagnostics(page);
    await page.locator('#loan-button').click();
    await waitFrames(page, 3);
    const afterLoan = await diagnostics(page);

    await expect(page.locator('#ruin-panel')).toBeHidden();
    // 本局没被重开，而是从沉降里被拉回来。
    expect(afterLoan?.phase).toBe('playing');
    // ★ 判别量：账目延续（重开会把 spent/earned/begged 全部清零）。
    expect(afterLoan?.spent).toBe(beforeLoan?.spent);
    expect(afterLoan?.earned).toBe(beforeLoan?.earned);
    expect(afterLoan?.begged).toBe(beforeLoan?.begged);
    expect(afterLoan?.activeCoins).toBe(beforeLoan?.activeCoins);
    /*
     * 贷来的钱记进 `loaned`，余额同时 +20。
     * ★ S4 之前这里断的是「`buyIn` 与 `chips` 同时加同一个数」；合并账户之后没有买入可言，
     *   贷款就是一笔**单独的进账项** ⇒ 恒等式右边多了 `loaned` 一项，
     *   而 `initial`（本段开始时的余额）**必须一动不动** —— 两件事一起断才封住
     *   「把贷款记成初始余额」这种会把整段基准偷偷抬高的写法。
     */
    expect(afterLoan?.loaned).toBe((beforeLoan?.loaned ?? 0) + 20);
    expect(afterLoan?.initial).toBe(beforeLoan?.initial);
    expect(afterLoan?.chips).toBe((beforeLoan?.chips ?? 0) + 20);
    expect(afterLoan?.chips).toBeGreaterThan(0);
    // S0a 之后账平与否由**引擎自己判**；欠款那行小字必须真的出现在 HUD 上。
    expect(afterLoan?.balanced).toBe(true);
    await expect(page.locator('#debt-line')).toBeVisible();
    await expect(page.locator('#debt-note')).toContainText('欠款 20 / 100');

    // ── 再触底 → 收工 → 总结卡片 ──
    await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setState?.('ruin'));
    await page.locator('#quit-button').click();
    await expect(page.locator('#ruin-panel')).toBeVisible();
    await expect(page.locator('#ruin-title')).toHaveText('本局结束');
    await expect(page.locator('#beg-button')).toBeHidden();
    // 总结卡片上**不该有贷款按钮**：本局已经结束，借钱没有对象。
    // 刻意用 toBeHidden 而不是不检查——「藏掉而不是留着可点」是这条的设计决定。
    await expect(page.locator('#loan-button')).toBeHidden();
    await expect(page.locator('#ruin-stats')).toContainText('余额');

    /*
     * ── 再来一局 ──
     * ★ S4 合并账户改变了这一段的正确答案，而且改得对：
     *   旧模型里「再来一局」总得到一个干净新局，因为钱包与桌上筹码是两只口袋，
     *   而 `setState('ruin')` 这个夹具只能抽干「桌上」那一只 ⇒ 钱包还剩得多，
     *   重开必然买到 20 筹码。合并之后只剩一只账户，夹具抽干的就是**全部余额** ⇒
     *   重开时余额 0 ⇒ `startRun` 的「开局即见底」分支立刻再次弹出报价面板。
     *   这正是「触底不是终点」应有的样子：没钱就当场被问「要不要贷一笔」，
     *   而不是白送一局新局（旧行为其实是个漏洞：抽干桌子不影响那只富着的钱包）。
     * ⇒ 所以这里断的是**面板重新可见、贷款按钮可点、盘面一个子都没少**，
     *   而不是旧版的「面板收起 + 余额 < 200」（后者现在恒真到没有信息量）。
     */
    await page.locator('#quit-button').click();
    await waitFrames(page, 3);
    await expect(page.locator('#ruin-panel')).toBeVisible();
    await expect(page.locator('#ruin-title')).toHaveText('续玩报价');
    await expect(page.locator('#loan-button')).toBeVisible();

    const broke = await diagnostics(page);
    expect(broke?.balance).toBe(0);
    expect(broke?.chips).toBe(0);
    // 「开局即见底」走的是既有沉降分支：`beginPlay()` + `enterRuinSettle()` ⇒ 阶段是 `drainOut`
    // 而不是 `ready`（旧模型里这一步几乎不会触发，因为钱包总在另一只口袋里剩着）。
    expect(broke?.phase).toBe('drainOut');
    expect(broke?.pusher.running).toBe(false);
    // 报价/贷款这条路径不重开盘面（S3 定的那条恒等式），见底也不例外。
    expect(broke?.activeCoins).toBe(spec?.coins);
    expect(broke?.endless.ruinVisible).toBe(true);
    // 余额归零这一段账本仍然平（恒等式不因余额为 0 而失效）。
    expect(broke?.balanced).toBe(true);
  });
});
