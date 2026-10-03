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
  // 原名「单枚币走完…的完整路径」问的是一个当前物理下**不可能在测试窗口内成立**的问题：
  // S23 恢复对称行程 ⇒ 台面摩擦净输送精确 0（`constants.ts:406`），S1a 实测满盘后排币
  // 150 循环只走 32 毫米 ⇒ 单枚币离台要四位数循环。换成问这条用例真正关心、
  // 且与库存量无关的事：**台面有没有在结算**。
  test('台面在结算：投币后本局必须有币越线（床不出币 = 整局停摆）', async ({ page }) => {
    await boot(page, 'playing');
    expect(await dropUntilAccepted(page, 0)).toBe(true);

    // 1) 落到台面：离开钉阵高度
    await expect
      .poll(async () => (await playerCoin(page))?.y ?? 9, { timeout: 8000, intervals: [120] })
      .toBeLessThan(0.42);

    // 2) 台面必须在结算：读 `settledCoins`（本局累计越线结算枚数，`Game.ts:4160`）。
    //
    // ★ 为什么换对象：原先两条断言问的是「这一枚币自己能不能走 1.2 米掉到低台」。
    //    现在推板是对称行程 ⇒ 台面净输送 0，单枚玩家币离台要四位数循环（S1a），
    //    任何测试窗口都够不着。⚠️ 原注释里「净前进 **26 毫米/循环**」是 **S13 破对称**期的读数，
    //    而「180 秒 = 实测 72 秒 × 2.5」整段期限推导就挂在那一个数上 ⇒ 依据失效、期限也失效；
    //    所以正确的修法**不是**把窗口拉长（那是把同一个错误问题问得更久）。
    //
    // ★ 为什么是 `settledCoins` 而不是 `drained`：`drained` 数的是币床前侧角**下水道**吃掉的币
    //    （P10 的「汇」，`Game.ts:4169`）——一块只进不出的盘也能让 `drained` 涨，
    //    那证明不了「在返值」。本条关切是「台面不出币 = 整局停摆」⇒ 要读的就是结算计数。
    //
    // ⚠️ 代价：这条**不再能抓「单枚币卡住」**。那一维由 `pace`（0.3~3.0 枚/循环）与
    //    `probe` 的对称守卫（每循环 |净漂移| <= 层高/10）守，别在这里重复一个抓不到的判据。
    const settledStart = (await diagnostics(page))?.settledCoins ?? -1;
    await expect
      .poll(async () => (await diagnostics(page))?.settledCoins ?? -2, { timeout: 180_000, intervals: [400] })
      .toBeGreaterThan(settledStart);
  });

  test('投光筹码后必须产生真实越线返值，并走完收尾（破产弹窗或结算）', async ({ page }) => {
    await boot(page, 'playing');
    /*
     * ★ S4 合并账户：必须先把账户确定性地摆小，否则这条用例会跑成「一局打不完」。
     *   旧模型里机器人只要投光「桌上」那 20 枚就见底（钱包是另一只口袋，不参与桌上的收支）；
     *   合并之后越线返值直接进**同一个账户** ⇒ 净流出速率没变，但要归零的基数大了 10 倍，
     *   实测 6 分钟期限被打爆（40~112 投的旧分布整体右移）。
     *   这不是回归，是「两只口袋合一」的必然后果 —— 也正是 S6 那唯一一次重标必须做的事。
     *   所以这里用 `setWallet` 把账户摆成 30 再重开一段：要验的东西
     *   （「投光之后有真实越线返值，并且走完收尾」）一个字都没改，
     *   只是不再依赖一只本来就很大的账户。
     *   ⚠️ 顺序：`setWallet` 之后再 `setState('playing')`，否则 `initial` 记的还是旧余额。
     */
    await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setWallet?.(30));
    await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setState?.('playing'));

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
    /*
     * ★ S4 合并账户：这一行原来无条件断「推板已停」。改成**按终态分支判**是有原因的：
     *   旧模型里机器人这一局只会经由「破产窗」结束（桌上筹码归零 → 沉降 → 弹窗，弹窗顺手 stop 推板）；
     *   合并账户之后本测试的夹具余额被摆成 30，收尾有可能直接走 `settled` 分支
     *   而不停在破产窗，而 `settled` 那条路**不要求推板停**（推板还转着等下一局）。
     *   ⇒ 无条件的「推板必须停」从此成了一条会随机翻红的断言（红的原因不是缺陷，是终态分支不同）。
     *   所以只保留真正有信息量的那半句：**只要弹了破产窗，推板必须已经停住**
     *   ——那才是「收尾真的结束了」的证据；没弹窗的情形由上面的 `settleReason==='exhausted'` 管。
     */
    if (final?.endless?.ruinVisible === true) {
      expect(final?.pusher.running).toBe(false);
    }
    // 收尾以「盘面没把筹码还回来」收场 → 弹破产窗，手里基本没筹码。
    //
    // **不能要求筹码恰好为 0**：收尾走完、破产窗弹出之后，仍可能有一枚在途币越线返值——
    // 那是被**记进账本**的迟到返值（`gainChips` 不复活，所以本局停在破产窗），不是漏记。
    // 满盘之后收尾期越线更频繁，这条从「偶尔」变成了常态（实测出现过「破产窗 + 剩 1 筹码」）。
    expect(final?.chips ?? -1).toBeGreaterThanOrEqual(0);
    expect(final?.chips ?? -1).toBeLessThan(final?.initial ?? 0);
    // 三账本恒等式：任何一条收尾路径上都不能漏记。
    // ★ 读**引擎自己的判断**（`ledger().balanced` ← `economy.ledgerBalances`），
    // 不再在这里手抄算式 —— 这条 spec 从此验的是「引擎认为账平不平」，
    // 而不是「我抄的那份式子与 src 是否恰好一致」。
    // 缺字段会直接红（`undefined !== true`），这正是我们要的失效形态，不是假绿。
    expect(final?.balanced).toBe(true);
    await expect(page.locator('#ruin-panel')).toBeVisible();
  });

  test(
    '投币能点亮 XIXI 槽位（物理落点登记）',
    async ({ page }, testInfo) => {
      // 单条用例的窗按实测抬到 13 分钟。⚠️ 不能写成 `test(title, { timeout }, fn)`：
      // 这个 Playwright 版本的 `TestDetails` 里没有 `timeout`，tsc 直接 TS2353 ⇒ 用 testInfo.setTimeout。
      testInfo.setTimeout(780_000);
      await boot(page, 'playing');

      /* 夹具：把币床掏薄（`clearBedTo` 是既有钩子，S1a 两臂探针就用它）。
       * 为什么必须掏：10-02 同树实测 —— 满盘时投下的玩家币**冻结在 z≈−0.75 达 200 循环**
       * （`/tmp/front-reach.out`），因为推板前缘的活动带只有 [−0.16, +0.20]，结构上碰不到床后面的币，
       * 只能等前面的床排空（200 循环排掉 46 枚）。那是"排队速度"，属于**批**要量的东西；
       * 本条要验的是**登记链**（币掉到 `registerY` 以下 → 槽亮），所以把排队这一层从夹具里剥掉，
       * 而不是把断言改松。掏薄后实测：第 **158** 个循环两枚币跨过 0.13，同一刻点亮 2 槽
       * （`/tmp/xixi-ttp.out`）。 */
      await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.clearBedTo?.(0));

      const lanes = [-0.9, 0, 0.9, -0.9, 0, 0.9, -0.5, 0.5, -0.9, 0, 0.9, 0];
      for (let index = 0; index < 12; index += 1) {
        await dropUntilAccepted(page, lanes[index % lanes.length]);
      }

      // 点亮或集齐：集齐会把四槽清空重计 ⇒ 把 **completed 事件**也算进来。
      //
      // ⚠️ 这条修的是**假绿**：原先用 `boostCharges > 0 || shows.busy` 当「集齐了」的代理，
      //    而 `shows.busy` 在**任何**演出期间都为真（闸门补币、币塔、喷泉都算）⇒
      //    一枚槽都没点亮时这条也会绿，等于没在测 XIXI。
      //    现在读事件本身。`telemetry()` 钩子是既有的（`Game.ts:3495`；harness 的
      //    `verify-game.mjs:224` 用的就是它；类型见 `vite-env.d.ts:923` 与 `:969`，
      //    `XixiEvent.phase` 里有 `'completed'`）⇒ **不是新造字段，也不新增测试面**。
      //
      // ★★ 2026-10-02 改的是**窗**，不是断言强度。原先「90 秒内 poll」看着像超时参数，
      //   其实等于要求"币必须在 90 秒内走完整个台面"，而实测走完要 **158 个推板循环**（≈420 秒，
      //   `/tmp/xixi-ttp.out`：`t+421s 循环=158 最低y=0.010 点亮=2`）。两个 project 稳定红、
      //   `Received: 0`（`/tmp/post-land-bot-playtest.log`）量的是这个窗，不是登记链断了 ——
      //   同一棵树的 200 局批里摇奖 241 次、48 局集齐过，而摇奖只能由四槽集齐触发。
      //   ⇒ 现在**按推板循环等**（周期会随机器变，按秒等是在赌负载），到窗再判一次；
      //     断言仍是「至少亮一个槽、或集齐过」，一个字没松。
      const LANDING_CYCLES = 200; // = 实测 158 + 一档余量；它是**上限**，不是必等时长
      const cyclesAtStart = (await diagnostics(page))?.pusher?.cycles ?? 0;
      // 三个来源一起看：当前槽位 + lit 事件 + completed 事件（集齐会把槽位清空 ⇒ 只看数组会漏）。
      // poll 一满足就返回 ⇒ 亮得早就少跑几十秒；超窗仍为 0 则返回 -1，立刻红在**登记**这条上，
      // 不会拖到别处（10-03 实测过一次红在末尾的「逃逸币」守卫上，那是另一件事，见计划里的 #77）。
      await expect
        .poll(
          async () => {
            const state = await diagnostics(page);
            const events = await page.evaluate(
              () => window.__THREE_GAME_TEST_HOOKS__?.telemetry?.()?.xixiEvents ?? [],
            );
            const evidence =
              (state?.xixi ?? []).filter(Boolean).length +
              events.filter((event) => event.phase === 'lit').length +
              (events.some((event) => event.phase === 'completed') ? 4 : 0);
            const waited = (state?.pusher?.cycles ?? 0) - cyclesAtStart;
            return evidence > 0 ? evidence : waited >= LANDING_CYCLES ? -1 : 0;
          },
          {
            timeout: 720_000, // 200 循环 × 实测 ~2.55 秒/循环 ≈ 510 秒，再留负载余量
            intervals: [2000],
            message: `等满 ${LANDING_CYCLES} 个推板循环仍没有任何 lit / completed 事件（不是超时，是窗内真的没亮）`,
          },
        )
        .toBeGreaterThan(0);

      expectNoAnomalies(await diagnostics(page));
    },
  );

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
