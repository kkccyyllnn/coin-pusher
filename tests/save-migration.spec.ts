import { expect, test, type Page } from '@playwright/test';

/**
 * 存档迁移契约（v3 / v2 / v1 → v4 → v5）。
 *
 * v4 新增 XIXI 四槽集章进度（跨局持续）；v3 摘掉了战役六关与图鉴券，改用**筹码钱包**
 * 做唯一进度货币。老玩家的已购外观、券余额、最高分与跪求次数都必须原样带过来——
 * 迁移出错等于把玩家的进度删了。
 *
 * ★ v5 新增 `debt` / `loanedTotal`（S2 贷款）。这两个字段的老存档值**只能是 0**，
 * 而且**绝不从 `totalBegs` 折算**：跪求次数与欠债是两件事，折一下就等于
 * 给老玩家凭空发一笔免息的贷款额度（可以直接花到上限）。
 *
 * 用例通过 `addInitScript` 在页面脚本之前写入旧键，模拟「老玩家第一次打开新版」。
 */

const CURRENT_KEY = 'coin-pusher:save:v6';
/** v5 与 v6 只差字段名 `wallet`→`balance` 与新增 `beggedTotal`（金额不动）。 */
const V5_KEY = 'coin-pusher:save:v5';
/** v4 与 v5 同构（只差 debt / loanedTotal）：走 `parse()` 的补默认值路径，不是 `migrate()`。 */
const V4_KEY = 'coin-pusher:save:v4';
const V3_KEY = 'coin-pusher:save:v3';
const V2_KEY = 'coin-pusher:save:v2';
const V1_KEY = 'coin-pusher:save:v1';

/** 起始钱包：与 `ENDLESS.walletStart` 一致，迁移折算都叠在它上面。 */
const WALLET_START = 200;
/** 券与分数的折算汇率：与 `SaveStore` 里的 TICKET_TO_CHIPS / SCORE_TO_CHIPS 一致。 */
const TICKET_TO_CHIPS = 5;
const SCORE_TO_CHIPS = 10;
/**
 * 开局买入（`ENDLESS.buyIn`）。
 *
 * 页面加载时 `Game` 会立刻开一局，开局那一次买入是**从钱包扣走**的
 * （局内筹码由它而来）。所以「打开页面后的钱包」= 迁移结果 − 20，
 * 断言必须带上这一笔，否则测的是「迁移后没人开始玩」的假想状态。
 */

/** v2 存档：战役进度字段（levels / stars / cleared）已经没有任何消费者，应当被丢弃。 */
const LEGACY_V2_SAVE = {
  tickets: 7,
  coinSkins: ['copper', 'celadon'],
  cabinetSkins: ['classic', 'amber'],
  selectedCoinSkin: 'celadon',
  selectedCabinetSkin: 'amber',
  endlessBest: 1234,
  endlessBegs: 5,
  endlessRuns: [
    { score: 1234, drops: 61, begs: 2 },
    { score: 700, drops: 40, begs: 3 },
  ],
  // 以下字段在 v2 里存在，v3 已无对应实现。
  cleared: [1, 2, 3],
  bestStars: { '1': 3, '2': 2 },
  allClearedAwarded: true,
  selectedLevel: 3,
};

/** 迁移算出来的钱包：起始钱包 + 券折算 + 最高分折算。 */
const MIGRATED_WALLET =
  WALLET_START + LEGACY_V2_SAVE.tickets * TICKET_TO_CHIPS + Math.round(LEGACY_V2_SAVE.endlessBest / SCORE_TO_CHIPS);
/** 迁移结果再扣掉开局买入，就是玩家打开页面后看到的余额。 */
const BALANCE_AFTER_LOAD = MIGRATED_WALLET;

async function seedLegacy(page: Page, key: string, value: unknown): Promise<void> {
  await page.addInitScript(
    ({ storageKey, payload }) => {
      window.localStorage.setItem(storageKey, typeof payload === 'string' ? payload : JSON.stringify(payload));
    },
    { storageKey: key, payload: value },
  );
}

async function readSave(page: Page) {
  return page.evaluate((key) => window.localStorage.getItem(key), CURRENT_KEY);
}

async function collection(page: Page) {
  return page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.collection?.());
}

async function waitForBoot(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 5);
}

test.describe('存档迁移', () => {
  test('v2 存档：外观原样迁移，券与最高分折成筹码，战役字段被丢弃', async ({ page }) => {
    await seedLegacy(page, V2_KEY, LEGACY_V2_SAVE);
    await waitForBoot(page);

    const save = await collection(page);
    // 券不再是货币，但它的价值按汇率进了钱包，老玩家不至于白攒。
    expect(save?.balance).toBe(BALANCE_AFTER_LOAD);
    expect(save?.coinSkins).toEqual(['copper', 'celadon']);
    expect(save?.cabinetSkins).toEqual(['classic', 'amber']);
    expect(save?.selectedCoinSkin).toBe('celadon');
    expect(save?.selectedCabinetSkin).toBe('amber');

    // 迁移结果立刻落盘到 v3，且战役字段与旧字段都不再出现。
    const raw = await readSave(page);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw ?? '{}') as Record<string, unknown>;
    expect(parsed.balance).toBe(BALANCE_AFTER_LOAD);
    expect(parsed.bestEarned).toBe(Math.round(LEGACY_V2_SAVE.endlessBest / SCORE_TO_CHIPS));
    expect(parsed.totalBegs).toBe(5);
    // 排行榜的分数列换算成「赚进筹码」。
    expect(parsed.runs).toEqual([
      { earned: 123, drops: 61, begs: 2 },
      { earned: 70, drops: 40, begs: 3 },
    ]);
    for (const gone of [
      'cleared',
      'bestStars',
      'allClearedAwarded',
      'selectedLevel',
      'tickets',
      'endlessBest',
      'endlessBegs',
      'endlessRuns',
    ]) {
      expect(parsed[gone], `v3 存档不应再有 ${gone}`).toBeUndefined();
    }
  });

  /**
   * v4 存档（S2 之前最后一版）：有 xixi，**没有** debt / loanedTotal。
   * 字段刻意写全，这样「迁移有没有把老东西弄丢」才是可证的。
   */
  const LEGACY_V4_SAVE = {
    balance: 137,
    coinSkins: ['copper', 'celadon'],
    cabinetSkins: ['classic'],
    selectedCoinSkin: 'celadon',
    selectedCabinetSkin: 'classic',
    bestEarned: 64,
    totalBegs: 3,
    runs: [{ earned: 64, drops: 51, begs: 3 }],
    xixi: [true, false, true, false],
  };

  test('v4 → v6：欠款初值必须是 0，且绝不从 totalBegs 折算；其余字段原样带过来', async ({ page }) => {
    await seedLegacy(page, V4_KEY, LEGACY_V4_SAVE);
    await waitForBoot(page);

    const raw = await readSave(page);
    expect(raw, '迁移结果要落进当前键').not.toBeNull();
    const parsed = JSON.parse(raw ?? '{}') as Record<string, unknown>;

    // ★ 这条是本用例的正文：`totalBegs` 是 3，如果谁哪天手滑把它当欠款折进来，
    // 玩家一升级就白背 3 筹码的债（或者反过来白拿 3 筹码的额度）。
    expect(parsed.debt, '老存档没有贷款概念 ⇒ 欠款只能是 0').toBe(0);
    expect(parsed.loanedTotal, '没借过 ⇒ 累计借入也是 0，不能跟 debt 一样靠默认值混过去').toBe(0);

    // 老字段一个都不能丢。★ S4：加载时不再有买入扣款 ⇒ 期望就是原值。
    expect(parsed.balance).toBe(LEGACY_V4_SAVE.balance);
    expect(parsed.coinSkins).toEqual(LEGACY_V4_SAVE.coinSkins);
    expect(parsed.selectedCoinSkin).toBe('celadon');
    expect(parsed.bestEarned).toBe(64);
    expect(parsed.totalBegs).toBe(3);
    expect(parsed.runs).toEqual(LEGACY_V4_SAVE.runs);
    expect(parsed.xixi).toEqual(LEGACY_V4_SAVE.xixi);

    // 引擎侧读到的也必须是 0 欠款（HUD 那一行应该整条隐掉）。
    const debt = await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.debt?.());
    expect(debt?.debt).toBe(0);
    expect(debt?.ceiling).toBeGreaterThan(0);
  });

  test('欠着钱的人不许靠刷新白拿起始余额（`parse()` 的守卫带 debt 分支）', async ({ page }) => {
    /*
     * `parse()` 里那条「钱包被扣空、又没有历史局、也没跪求过 ⇒ 重置成起始钱包」的
     * 自动救济（防频繁刷新把新局弄死），从 S2 起多一个条件：**还欠着债就不许重置**。
     * 少了这个分支，玩家贷了款、把钱花空，只要刷一次页面就既清掉「见底」状态、
     * 又白拿 200 起始余额 —— 那等于用一次刷新换一笔无息额度。
     *
     * 这条 fixture 刻意造出「wallet 0 + runs 空 + totalBegs 0 + debt 40」，
     * 正好是守卫三个旧条件全满足、只有新条件拦住它的那一格。
     */
    await seedLegacy(page, CURRENT_KEY, {
      wallet: 0,
      debt: 40,
      loanedTotal: 40,
      coinSkins: ['copper'],
      cabinetSkins: ['classic'],
      selectedCoinSkin: 'copper',
      selectedCabinetSkin: 'classic',
      bestEarned: 10,
      totalBegs: 0,
      runs: [],
      xixi: [false, false, false, false],
    });
    await waitForBoot(page);

    const state = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__);
    expect(state?.balance, '欠着债 ⇒ 守卫不许把钱包重置成起始余额').toBe(0);
    const debt = await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.debt?.());
    expect(debt?.debt, '欠款本身要原样留着，不能顺手被清').toBe(40);
    expect(debt?.loanedTotal).toBe(40);
  });

  test('刚跪求过、那一局还没记进历史的人，也不许靠刷新白拿起始余额（S4 的 beggedTotal 分支）', async ({ page }) => {
    /*
     * 上面那条守的是 S2 的 `debt === 0`；这一条守 S4 合并账户之后**新增**的那一格。
     *
     * 为什么单独一格：`totalBegs` 是 `recordRun()` 里累加的**历史跪求次数**，
     * 而 `beggedTotal` 是 `creditBalance(…, 'begged')` **当场**累加的金额。
     * 于是存在一个真实的状态：跪来的钱已经进了余额、但那一局还没有被记录
     * ⇒ `totalBegs === 0` 而 `beggedTotal > 0`。
     * 旧守卫只看 `totalBegs`，在这个状态刷一次页面就会把余额摆回起始值
     * ⇒ 「跪求 → 刷新」变成一台无限造筹码的机器（合并账户之前不会，
     *   因为跪来的钱活在「桌上」口袋，刷新本来就没了）。
     *
     * fixture 刻意造的就是这一格：`debt 0`（让上面那条拦住的路径不成立）、
     * `totalBegs 0`（旧条件全满足）、`beggedTotal 40`（只有新条件能拦）。
     */
    await seedLegacy(page, CURRENT_KEY, {
      wallet: 0,
      debt: 0,
      loanedTotal: 0,
      beggedTotal: 40,
      coinSkins: ['copper'],
      cabinetSkins: ['classic'],
      selectedCoinSkin: 'copper',
      selectedCabinetSkin: 'classic',
      bestEarned: 10,
      totalBegs: 0,
      runs: [],
      xixi: [false, false, false, false],
    });
    await waitForBoot(page);

    const state = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__);
    expect(state?.balance, '刚跪求过 ⇒ 守卫不许把余额重置成起始值').toBe(0);
    // ⚠️ 这里**不能**断 `ledger().totals.begged === 40`：`accountTotals` 是**本次会话**的累加表
    //   （只在 `creditBalance` / `debitBalance` / `setWallet` 里动），加载存档不会把它回填，
    //   所以刚迁移进来的那份 `beggedTotal` 在 `totals.begged` 里读到的是 0。
    //   这两个累加器各有各的用途（一个给守卫、一个给守恒式），不是同一份公式的抄本，
    //   但**别把它们当同一个数读**。
  });

  test('正对照：把 beggedTotal 拿掉，同一格子里守卫就该放行自动救济（证上一条不是"永远不重置"）', async ({
    page,
  }) => {
    /*
     * 没有这条对照，上面那条其实是**假绿**的安全感：
     * 如果哪天重置逻辑整个坏掉（比如加载分支不再走这一段），
     * 「不许重置」的两条都会绿，而玩家其实早就拿不到起始余额了。
     * ⇒ 断言只写 `> 0` 不写死 200：具体起始值由默认存档给，写死就是造第二份真源。
     */
    await seedLegacy(page, CURRENT_KEY, {
      wallet: 0,
      debt: 0,
      loanedTotal: 0,
      beggedTotal: 0,
      coinSkins: ['copper'],
      cabinetSkins: ['classic'],
      selectedCoinSkin: 'copper',
      selectedCabinetSkin: 'classic',
      bestEarned: 10,
      totalBegs: 0,
      runs: [],
      xixi: [false, false, false, false],
    });
    await waitForBoot(page);

    const state = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__);
    expect(state?.balance, '五个条件全满足 ⇒ 自动救济必须发生').toBeGreaterThan(0);
  });

  test('迁移后的外观、钱包与最高赚进真的进入游戏状态', async ({ page }) => {
    await seedLegacy(page, V2_KEY, LEGACY_V2_SAVE);
    await waitForBoot(page);

    const diagnostics = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__);
    expect(diagnostics?.collection.coinSkin).toBe('celadon');
    expect(diagnostics?.collection.cabinetSkin).toBe('amber');
    // 钱包与最高赚进都要带进 HUD，否则玩家的积累看起来被清零了。
    expect(diagnostics?.balance).toBe(BALANCE_AFTER_LOAD);
    expect(diagnostics?.endless.bestEarned).toBe(123);
    await expect(page.locator('#credits-value')).toHaveText(String(BALANCE_AFTER_LOAD));
    await expect(page.locator('#best-value')).toHaveText('123');
  });

  test('只有 v1 存档时同样能迁移', async ({ page }) => {
    await seedLegacy(page, V1_KEY, { tickets: 3, coinSkins: ['copper', 'silver'] });
    await waitForBoot(page);

    const save = await collection(page);
    expect(save?.balance).toBe(WALLET_START + 3 * TICKET_TO_CHIPS);
    expect(save?.coinSkins).toEqual(['copper', 'silver']);
    expect(await readSave(page)).not.toBeNull();
  });

  test('v4 已存在时忽略 v3 / v2（新存档优先）', async ({ page }) => {
    // v4 里混进旧字段（tickets / endlessBest）时必须被忽略，而不是当钱包用。
    await seedLegacy(page, CURRENT_KEY, { tickets: 99, coinSkins: ['copper'], endlessBest: 42 });
    await seedLegacy(page, V3_KEY, { wallet: 888, coinSkins: ['silver'] });
    await seedLegacy(page, V2_KEY, LEGACY_V2_SAVE);
    await waitForBoot(page);

    const save = await collection(page);
    expect(save?.balance).toBe(WALLET_START);
    expect(save?.coinSkins).toEqual(['copper']);
    const diagnostics = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__);
    expect(diagnostics?.endless.bestEarned).toBe(0);
    expect(diagnostics?.balance).toBe(WALLET_START);
  });

  test('v3 存档原样迁移到 v4：字段逐项保留，xixi 默认全灭', async ({ page }) => {
    // v3 与 v4 同构（只差 xixi）：每个字段都必须 1:1 带过来——绝对数断言，不断增量。
    const v3Save = {
      wallet: 333,
      coinSkins: ['silver', 'celadon'],
      cabinetSkins: ['amber'],
      selectedCoinSkin: 'silver',
      selectedCabinetSkin: 'amber',
      bestEarned: 45,
      totalBegs: 2,
      runs: [{ earned: 12, drops: 30, begs: 1 }],
    };
    await seedLegacy(page, V3_KEY, v3Save);
    await waitForBoot(page);

    const save = await collection(page);
    expect(save?.balance).toBe(v3Save.wallet);
    expect(save?.coinSkins).toEqual(['silver', 'celadon']);
    expect(save?.selectedCoinSkin).toBe('silver');

    const parsed = JSON.parse((await readSave(page)) ?? '{}') as Record<string, unknown>;
    expect(parsed.balance).toBe(v3Save.wallet);
    expect(parsed.cabinetSkins).toEqual(['amber']);
    expect(parsed.selectedCabinetSkin).toBe('amber');
    expect(parsed.bestEarned).toBe(45);
    expect(parsed.totalBegs).toBe(2);
    expect(parsed.runs).toEqual([{ earned: 12, drops: 30, begs: 1 }]);
    expect(parsed.xixi).toEqual([false, false, false, false]);
    // 旧键只读不删（便于回滚）。
    expect(await page.evaluate((key) => window.localStorage.getItem(key), V3_KEY)).not.toBeNull();
  });

  test('老存档字段缺失时用默认值补齐，不写入 undefined', async ({ page }) => {
    /*
     * ★ S4：这条用例原先种在 `CURRENT_KEY` 上（那时 v4 就是当前版本）。
     * 种当前键有个陷阱：`SaveStore` 只在 **migrated 时**才回写，
     * 所以种当前键 ⇒ 补好的默认值**永远不会落盘**，读回来的还是那份残缺 JSON，
     * `parsed.bestEarned` 会是 `undefined` —— 红得很像"补齐逻辑坏了"，其实是**根本没走回写**。
     * 现在改成种 `V5_KEY`（上一版），既走迁移回写、又顺带验了
     * `wallet` → `balance` 这个改名真的把老键名读进来了。
     */
    await seedLegacy(page, V5_KEY, { wallet: 77 });
    await waitForBoot(page);

    const save = await collection(page);
    expect(save?.balance).toBe(77);
    const parsed = JSON.parse((await readSave(page)) ?? '{}') as Record<string, unknown>;
    // 老键名 `wallet` 的值要出现在新键 `balance` 上，且**不能有两个键**（那就成了两个口袋）。
    expect(parsed.balance).toBe(77);
    expect(parsed.wallet, '迁移后不应再留旧键名').toBeUndefined();
    expect(parsed.bestEarned).toBe(0);
    expect(parsed.totalBegs).toBe(0);
    // ★ S4 新增：老存档没有 `beggedTotal` ⇒ 补 0，且必须**显式写出 0**而不是留 undefined。
    expect(parsed.beggedTotal).toBe(0);
    expect(parsed.runs).toEqual([]);
    expect(parsed.xixi).toEqual([false, false, false, false]);
    expect(Object.values(parsed).every((value) => value !== undefined)).toBe(true);
  });

  test('v2 存档损坏时回落到默认存档且不崩', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await seedLegacy(page, V2_KEY, '{ 这不是 JSON');
    await waitForBoot(page);

    const save = await collection(page);
    expect(save?.balance).toBe(WALLET_START);
    expect(save?.coinSkins).toEqual(['copper']);
    expect(save?.selectedCoinSkin).toBe('copper');
    expect(errors).toEqual([]);
  });

  test('老存档里没有无尽字段时用默认值补齐，不写入 undefined', async ({ page }) => {
    await seedLegacy(page, V2_KEY, { tickets: 1, coinSkins: ['copper', 'obsidian'] });
    await waitForBoot(page);

    const parsed = JSON.parse((await readSave(page)) ?? '{}') as Record<string, unknown>;
    expect(parsed.balance).toBe(WALLET_START + TICKET_TO_CHIPS);
    expect(parsed.bestEarned).toBe(0);
    expect(parsed.totalBegs).toBe(0);
    expect(parsed.runs).toEqual([]);
    expect(Object.values(parsed).every((value) => value !== undefined)).toBe(true);
  });
});
