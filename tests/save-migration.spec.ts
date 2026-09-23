import { expect, test, type Page } from '@playwright/test';

/**
 * 存档迁移契约（v3 / v2 / v1 → v4）。
 *
 * v4 新增 XIXI 四槽集章进度（跨局持续）；v3 摘掉了战役六关与图鉴券，改用**筹码钱包**
 * 做唯一进度货币。老玩家的已购外观、券余额、最高分与跪求次数都必须原样带过来——
 * 迁移出错等于把玩家的进度删了。
 *
 * 用例通过 `addInitScript` 在页面脚本之前写入旧键，模拟「老玩家第一次打开新版」。
 */

const CURRENT_KEY = 'coin-pusher:save:v4';
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
const BUY_IN = 20;

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
const MIGRATED_WALLET_AFTER_BUY_IN = MIGRATED_WALLET - BUY_IN;

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
    expect(save?.wallet).toBe(MIGRATED_WALLET_AFTER_BUY_IN);
    expect(save?.coinSkins).toEqual(['copper', 'celadon']);
    expect(save?.cabinetSkins).toEqual(['classic', 'amber']);
    expect(save?.selectedCoinSkin).toBe('celadon');
    expect(save?.selectedCabinetSkin).toBe('amber');

    // 迁移结果立刻落盘到 v3，且战役字段与旧字段都不再出现。
    const raw = await readSave(page);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw ?? '{}') as Record<string, unknown>;
    expect(parsed.wallet).toBe(MIGRATED_WALLET_AFTER_BUY_IN);
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

  test('迁移后的外观、钱包与最高赚进真的进入游戏状态', async ({ page }) => {
    await seedLegacy(page, V2_KEY, LEGACY_V2_SAVE);
    await waitForBoot(page);

    const diagnostics = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__);
    expect(diagnostics?.collection.coinSkin).toBe('celadon');
    expect(diagnostics?.collection.cabinetSkin).toBe('amber');
    // 钱包与最高赚进都要带进 HUD，否则玩家的积累看起来被清零了。
    expect(diagnostics?.wallet).toBe(MIGRATED_WALLET_AFTER_BUY_IN);
    expect(diagnostics?.endless.bestEarned).toBe(123);
    await expect(page.locator('#wallet-value')).toHaveText(String(MIGRATED_WALLET_AFTER_BUY_IN));
    await expect(page.locator('#best-value')).toHaveText('123');
  });

  test('只有 v1 存档时同样能迁移', async ({ page }) => {
    await seedLegacy(page, V1_KEY, { tickets: 3, coinSkins: ['copper', 'silver'] });
    await waitForBoot(page);

    const save = await collection(page);
    expect(save?.wallet).toBe(WALLET_START + 3 * TICKET_TO_CHIPS - BUY_IN);
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
    expect(save?.wallet).toBe(WALLET_START - BUY_IN);
    expect(save?.coinSkins).toEqual(['copper']);
    const diagnostics = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__);
    expect(diagnostics?.endless.bestEarned).toBe(0);
    expect(diagnostics?.wallet).toBe(WALLET_START - BUY_IN);
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
    expect(save?.wallet).toBe(v3Save.wallet - BUY_IN);
    expect(save?.coinSkins).toEqual(['silver', 'celadon']);
    expect(save?.selectedCoinSkin).toBe('silver');

    const parsed = JSON.parse((await readSave(page)) ?? '{}') as Record<string, unknown>;
    expect(parsed.wallet).toBe(v3Save.wallet - BUY_IN);
    expect(parsed.cabinetSkins).toEqual(['amber']);
    expect(parsed.selectedCabinetSkin).toBe('amber');
    expect(parsed.bestEarned).toBe(45);
    expect(parsed.totalBegs).toBe(2);
    expect(parsed.runs).toEqual([{ earned: 12, drops: 30, begs: 1 }]);
    expect(parsed.xixi).toEqual([false, false, false, false]);
    // 旧键只读不删（便于回滚）。
    expect(await page.evaluate((key) => window.localStorage.getItem(key), V3_KEY)).not.toBeNull();
  });

  test('v4 存档字段缺失时用默认值补齐，不写入 undefined', async ({ page }) => {
    await seedLegacy(page, CURRENT_KEY, { wallet: 77 });
    await waitForBoot(page);

    const save = await collection(page);
    expect(save?.wallet).toBe(77 - BUY_IN);
    const parsed = JSON.parse((await readSave(page)) ?? '{}') as Record<string, unknown>;
    expect(parsed.bestEarned).toBe(0);
    expect(parsed.totalBegs).toBe(0);
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
    expect(save?.wallet).toBe(WALLET_START - BUY_IN);
    expect(save?.coinSkins).toEqual(['copper']);
    expect(save?.selectedCoinSkin).toBe('copper');
    expect(errors).toEqual([]);
  });

  test('老存档里没有无尽字段时用默认值补齐，不写入 undefined', async ({ page }) => {
    await seedLegacy(page, V2_KEY, { tickets: 1, coinSkins: ['copper', 'obsidian'] });
    await waitForBoot(page);

    const parsed = JSON.parse((await readSave(page)) ?? '{}') as Record<string, unknown>;
    expect(parsed.wallet).toBe(WALLET_START + TICKET_TO_CHIPS - BUY_IN);
    expect(parsed.bestEarned).toBe(0);
    expect(parsed.totalBegs).toBe(0);
    expect(parsed.runs).toEqual([]);
    expect(Object.values(parsed).every((value) => value !== undefined)).toBe(true);
  });
});
