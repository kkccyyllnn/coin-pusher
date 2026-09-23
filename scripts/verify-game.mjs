#!/usr/bin/env node
/**
 * 独立试玩验证脚本（v3：游戏只有无尽这一种玩法）。
 *
 * 不经过 Playwright 测试运行器，因此不产生 test-results 产物，
 * 适合在受限环境里做「真物理能不能推过线」的验证。
 *
 * 用法：先 `npm run dev`，然后 `node scripts/verify-game.mjs [模式]`
 *   probe      满盘预置稳定性 + 单枚币完整路径（默认）
 *   layout     无尽台面配置摘要（含币池预算余量告警）
 *   physics    满盘静置 10 秒 / 推板 10 循环节拍 / 上层留存
 *   endless    无尽核心：开局态 / 大赏币 / 热度倍率 / 破产 / 跪求 / 收工 / 热区 / 加注
 *   economy    三账本恒等式 / 钱包守恒 / 跪求不可回存 / 单位期望与庄家优势
 *   xixi       XIXI 集章与背板老虎机（P5 起替换三路集章）
 *   mechanisms 四个机关：扫板 / 抓斗 / 后装填 / 风险转轮
 *   sweep      推板行程参数扫描（默认两端 0.8/1.16，可用 SWEEP=0.8,1.0,1.16 分批覆盖）
 *   lane       自动选位匀速性、手动接管与轻点投币
 *   pace       逐循环推进节奏（行程选型的判据）
 *   show       投放演出：三装置真币交付 / 两态事件 / 预算降级与拒绝
 *   accept     验收清单自动化部分
 *   perf       帧率与画质分档
 *   shots      截图
 *   all        probe + endless + xixi
 */

import { chromium } from 'playwright';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:5188';
const MODE = process.argv[2] ?? 'probe';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
}

async function openGame(browser) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 10, null, {
    timeout: 20_000,
  });
  return { page, context, errors };
}

const readState = (page) => page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__);
const readTable = (page) =>
  page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.table?.() ?? null).catch(() => null);
const readCoins = (page) =>
  page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.coins?.() ?? []).catch(() => []);
/**
 * 读「接触流形里的真实穿透深度」。
 *
 * 这是**引擎自己算出来的**穿透量，与币的姿态无关，所以不会像「同层横向距离」
 * 那种几何启发式那样把「斜币倚靠邻居」误判成穿模。
 */
const readPenetration = (page, limitMillimeters = 4) =>
  page
    .evaluate(
      (limit) => window.__THREE_GAME_TEST_HOOKS__?.penetrationReport?.(limit) ?? null,
      limitMillimeters,
    )
    .catch(() => null);

const readTelemetry = (page) =>
  page
    .evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.telemetry?.())
    .catch(() => null)
    .then(
      (value) =>
        value ?? {
          scoreEvents: [],
          fallOffEvents: [],
          laneSamples: [],
          laneEvents: [],
          cycles: [],
          drain: { reason: null, startedAt: null, earnedAtStart: 0, settledAt: null, earnedAtSettle: 0 },
        },
    );

/**
 * 长时试玩里页面偶尔会被 Vite 整页刷新（HMR 或渲染上下文丢失），
 * 此时 evaluate 会抛「Execution context was destroyed」。
 * 这类瞬时错误不应该让整轮验证中断。
 */
function isNavigationError(error) {
  return String(error).includes('Execution context was destroyed');
}

/** 跑一组检查；抛异常时记一条失败而不是中断整轮。 */
async function guarded(label, fn) {
  try {
    await fn();
  } catch (error) {
    check(label, false, `运行异常：${String(error).split('\n')[0]}`);
  }
}

/** 诊断快照在上一帧发布，动作后立刻读会落后一帧。 */
async function readStateFresh(page) {
  await page.waitForTimeout(140);
  return readState(page);
}

async function playerCoin(page) {
  const all = await readCoins(page);
  return all.find((coin) => coin.playerDropped) ?? null;
}

/**
 * 开一局新的。state 取 ready / playing / drain / ruin / settled。
 * 每次都重新打开遥测：开发服务器整页刷新会重建 Game 实例，
 * 只在一开始打开一次的话，刷新之后遥测就静默关闭了。
 */
async function startRun(page, state = 'ready') {
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.seed?.(20260921));
  await page.evaluate((name) => window.__THREE_GAME_TEST_HOOKS__?.setState?.(name), state);
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.enableTelemetry?.());
}

/** 冷却期间投币会被拒绝，这里重试到被接受为止。 */
async function dropUntilAccepted(page, lane, budgetMs = 6000) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    try {
      const accepted = await page.evaluate(
        (value) => window.__THREE_GAME_TEST_HOOKS__?.drop?.(value) ?? false,
        lane,
      );
      if (accepted) return true;
    } catch (error) {
      if (!isNavigationError(error)) throw error;
    }
    await page.waitForTimeout(70);
  }
  return false;
}

/**
 * 冷启动兜底：等钩子就绪，再把**首投**重试到被接受为止。
 *
 * 刚打开页面时钩子可能还没就绪，一次投币预算错过就是「整局 0 投」——
 * 下游会把它读成「经济不终局」/「0 次入账」这类**不可能值**，
 * 连带把 wallet 守恒、结算线完整性几条判据一起拖红（实测偶发数次）。
 * 所有「开一局就立刻投第一枚」的地方都走这里，别再各写各的。
 */
async function primeFirstDrop(page, lane) {
  try {
    await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 5);
  } catch {
    // 页面还没起来时等不到 frame——交给下面的重试兜。
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await dropUntilAccepted(page, lane, 8000)) return true;
  }
  return false;
}

async function waitFor(page, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = await readState(page);
    } catch (error) {
      if (!isNavigationError(error)) throw error;
      await page.waitForTimeout(500);
      continue;
    }
    if (predicate(last)) return last;
    await page.waitForTimeout(250);
  }
  return null;
}

/**
 * 等遥测条件成立。与 `waitFor` 同构，只是读的是遥测而不是诊断快照。
 *
 * 用途：等一个**只有模拟内部才知道**的时刻（例如「这一轮收尾走完」），
 * 那种时刻在诊断快照里没有对应字段，而外部采样又可能正好错过。
 */
async function waitForTelemetry(page, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await readTelemetry(page);
    if (predicate(last)) return last;
    await page.waitForTimeout(250);
  }
  return last;
}

/**
 * 等到本局结束。
 *
 * 无尽只有一条收尾入口：筹码耗尽。收尾走完时有两条分支——
 * 盘面一枚筹码都没回吐 → 破产弹窗（`endless.ruinVisible`）；
 * 回吐了筹码（本局继续）则**不会**在这里等到结束——那种情况请用
 * `waitForTelemetry` 等「这一轮收尾走完」，不要等本局结束。
 *
 * 收尾时若还持有加力，游戏会停下来等玩家选择（规划要求「加力不能被吞」），
 * 机器人选择把加力用掉——这也验证了这条规则确实可被正常解决。
 */
async function waitForRunEnd(page, timeoutMs = 150_000) {
  const deadline = Date.now() + timeoutMs;
  let boostResolved = 0;
  while (Date.now() < deadline) {
    let state;
    try {
      state = await readState(page);
    } catch (error) {
      if (!isNavigationError(error)) throw error;
      await page.waitForTimeout(500);
      continue;
    }
    if (state?.endless?.ruinVisible === true) return { state, boostResolved, end: 'ruin' };
    if (state?.phase === 'settled') return { state, boostResolved, end: 'settled' };
    if (state?.phase === 'drainOut' && (state?.boostCharges ?? 0) > 0) {
      const used = await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.boost?.() ?? false);
      if (used) boostResolved += 1;
    }
    await page.waitForTimeout(400);
  }
  return { state: await readState(page), boostResolved, end: 'timeout' };
}

/**
 * 完整玩一局。paced=true 时每投一枚等推板走完一个循环——
 * 这是玩家自然节奏：推板 2.4 秒一个循环。
 * 连点投币会让币堆来不及压实，测出来的不是真实推进效率。
 *
 * **循环条件是「本局的终态」，不是投币枚数。** 负期望但很接近 1 时
 * （每枚筹码回收约 0.8），投完 N 枚之后手里还有剩，局根本不会结束——
 * 用固定枚数当条件的话，`waitForRunEnd` 会一直等到超时。
 * `drops` 只是防死循环的上限；`waitEnd: false` 用于只需要一段推进数据的模式
 * （sweep / pace），它们不关心收尾。
 */
async function playRun(page, { drops = 240, lanes, waitEnd = true } = {}) {
  await startRun(page, 'playing');
  const pickLanes = lanes ?? [-0.85, -0.45, 0, 0.45, 0.85];

  // 冷启动兜底：首投必须**真的被接受**（见 `primeFirstDrop` 的说明）。
  await primeFirstDrop(page, pickLanes[0]);
  let lastCycle = (await readState(page))?.pusher.cycles ?? 0;
  for (let index = 1; index < drops; index += 1) {
    const state = await readState(page);
    if (state?.endless?.ruinVisible === true || state?.phase === 'settled') break;
    if (state?.phase !== 'drainOut') {
      const advanced = await waitFor(page, (current) => (current?.pusher?.cycles ?? 0) > lastCycle, 20_000);
      if (!advanced) break;
      lastCycle = advanced.pusher.cycles;
    }
    const accepted = await dropUntilAccepted(page, pickLanes[index % pickLanes.length]);
    if (!accepted) await page.waitForTimeout(300);
  }

  if (!waitEnd) return { ...(await readState(page)), end: 'cap' };
  const { state, boostResolved, end } = await waitForRunEnd(page);
  return { ...state, boostResolved, end };
}

/**
 * 允许的入账筹码集合 —— **由引擎自己枚举出来，脚本里不抄第二份公式**。
 *
 * v3 没有分数，入账就是筹码，口径是
 * `基数 × 热度倍率 ×（热区 2 倍）× 加注倍率`，**取整只在最后一步做一次**
 * （见 `src/game/economy.ts` 的 `crossingReturn`）。
 *
 * 这里原来是手写展开的（热度档 × 加注档 × 热区 2），踩过两次坑：
 * 1. 热区里也必须允许 0——闸门在倍率之前，没过闸门的铜币仍然返 0；
 * 2. 「铜币 1 × 热度 1.5 × 热区 2」返的是 `round(3) = 3`，**不是**「先 round 成 2 再 ×2 = 4」。
 *    手写展开写的正是后者，于是**同时**漏掉合法的 3、又放进不可能出现的 4——报过假失败。
 *
 * 根因不是「漏了一档」，而是**脚本里存在第二份公式**：改了一边忘了另一边，
 * 测试会一直绿着骗人（`Game.ts` 暴露 `crossingReturn` 时写下的同一条理由）。
 * 所以改成枚举调用引擎：把返回值收成集合，引擎改取整方式或倍率表，集合自动跟着变。
 *
 * `roll = 0` 必过铜币的闸门（`bronzePayoutChance > 0`），拿到的是该组合的上界值；
 * 「过了闸门但没中」的 0 另加，两侧都收齐。
 */
async function readAllowedGains(hooks) {
  return hooks(() => {
    const api = window.__THREE_GAME_TEST_HOOKS__;
    const tiers = api.betTiers();
    const gains = new Set([0]);
    const hotGains = new Set([0]);
    const call = (kind, combo, hot, betMul) =>
      api.crossingReturn({ kind, combo, hot, betMul, roll: 0 }).chips;
    // 固定值币种（返币 / 大赏）也从引擎取，不写死 3 / 8。
    const fixed = [call('payout', 1, false, 1), call('bounty', 1, false, 1)];
    for (const value of fixed) gains.add(value);
    // combo 0..15 覆盖热度表的全部档位（3 / 5 / 8 三段），再多也停在顶档。
    for (let combo = 0; combo <= 15; combo += 1) {
      for (const kind of ['bronze', 'pattern']) {
        for (const tier of tiers) {
          for (const hot of [false, true]) {
            (hot ? hotGains : gains).add(call(kind, combo, hot, tier.mul));
          }
        }
      }
    }
    for (const value of hotGains) gains.add(value);
    const asc = (a, b) => a - b;
    return { gains: [...gains].sort(asc), hotGains: [...hotGains].sort(asc), fixed };
  });
}

/**
 * 三账本恒等式：`chips === buyIn + earned + begged − spent`。
 * 任何一条收尾路径、任何一帧都不能破——这是 P1 的核心验收。
 */
function ledgerOk(state) {
  if (!state) return false;
  return (
    state.chips === (state.buyIn ?? 0) + (state.earned ?? 0) + (state.begged ?? 0) - (state.spent ?? 0)
  );
}

function ledgerText(state) {
  return (
    `筹码 ${state?.chips} = 买入 ${state?.buyIn} + 赚进 ${state?.earned} + ` +
    `跪求 ${state?.begged} − 消耗 ${state?.spent}`
  );
}

/** 逐循环推下枚数：遥测里的 coins 是累计越线枚数，不受热度倍率污染。 */
function coinsPerCycle(cycles) {  const perCycle = [];
  let previous = 0;
  for (const sample of cycles) {
    perCycle.push(sample.coins - previous);
    previous = sample.coins;
  }
  const total = perCycle.reduce((sum, value) => sum + value, 0);
  const average = perCycle.length ? total / perCycle.length : 0;
  const maxCycle = perCycle.length ? Math.max(...perCycle) : 0;
  let gap = 0;
  let longestGap = 0;
  // 开头的空循环是**爬坡**，不是断档：满盘 + 短行程时，币堆要先压实几轮，
  // 前沿的币才会走到得分线上。把爬坡算进「最长空档」会让它逼近 8 个循环的上限，
  // 而那与「盘面憋死」（开始出币之后又断掉）根本不是一回事。
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
  return { perCycle, total, average, maxCycle, longestGap };
}

async function runProbe(page) {
  console.log('\n── 模式：probe（满盘稳定性 + 单枚币路径） ──');
  await startRun(page, 'ready');

  await page.waitForTimeout(6000);
  const idle = await readState(page);
  const table = await readTable(page);
  check('满盘空转 6 秒不自发返值', idle?.earned === 0, `earned=${idle?.earned}`);
  check('满盘空转 6 秒账本平', ledgerOk(idle), ledgerText(idle));
  check(
    '满盘空转 6 秒无币掉出机柜',
    idle?.activeCoins === table?.coins,
    `activeCoins=${idle?.activeCoins}/${table?.coins}`,
  );
  check('满盘空转 6 秒无异常', idle?.anomalies === 0, `anomalies=${idle?.anomalies}`);
  check('满盘空转 6 秒推板保持静止', idle?.pusher.running === false);
  // 速度护栏（见 `COIN.maxSpeed`）在**纯静置**期间一次都不该触发：推板静止、币床静止，
  // 没有任何机构能造出超过「自由落体 + 小反弹」的速度。触发了就说明求解器
  // 在这个静止的币堆里已经开始互相推挤、凭空造能量。
  check(
    '满盘空转 6 秒没有触发过速度护栏',
    (idle?.spikeClamps ?? -1) === 0,
    `压速 ${idle?.spikeClamps} 次，峰值 ${idle?.peakSpikeSpeed} 米/秒`,
  );

  const accepted = await dropUntilAccepted(page, 0);
  check('首次投币被接受', accepted === true);

  const timeline = [];
  for (let step = 0; step < 30; step += 1) {
    await page.waitForTimeout(400);
    const coin = await playerCoin(page);
    const state = await readState(page);
    timeline.push({ t: ((step + 1) * 0.4).toFixed(1), coin, offset: state?.pusher.offset });
    if (!coin) break;
  }

  console.log('  时间    x       y       z       vz      推板');
  for (const row of timeline) {
    if (!row.coin) {
      console.log(`  ${row.t}s  已越过得分线并被结算`);
      break;
    }
    const { x, y, z, vz } = row.coin;
    console.log(
      `  ${row.t}s  ${x.toFixed(3)}  ${y.toFixed(3)}  ${z.toFixed(3)}  ${vz.toFixed(3)}  ${Number(row.offset).toFixed(3)}`,
    );
  }

  const lowest = timeline.reduce((min, row) => (row.coin ? Math.min(min, row.coin.y) : min), 9);
  const maxZ = timeline.reduce((max, row) => (row.coin ? Math.max(max, row.coin.z) : max), -9);
  check('单枚币落到币床（y < 0.1）', lowest < 0.1, `min y=${lowest.toFixed(3)}`);
  check('单枚币被台面输送到推板前缘之外（z > 0）', maxZ > 0, `max z=${maxZ.toFixed(3)}`);

  /*
   * 推板跑起来之后的能量注入。
   *
   * 补上侧向围板（`TableBuilder` 的 `GLASS_TOP`）之后，**`anomalies` 恒为 0 是必然的**
   * ——币在物理上出不去机柜。所以「有没有币飞出去」不再是一条有效判据，它变成恒真式。
   * 有效的是：**求解器还在不在造能量**。
   *
   * `peakSpikeSpeed` 记的是速度护栏**压之前**的速率，也就是求解器实际造出来的那个值。
   * 只要它不超过这台机器自身物理上能达到的最大速度（从落币口自由落到托盘
   * ≈ 6.3 米/秒，见 `COIN.maxSpeed`），就说明注入的能量没有超出物理可能；
   * 一旦冒出 12、15 这种数，即使币被围板挡住、`anomalies` 依旧为 0，这条也会红。
   */
  const afterPusher = await readState(page);
  check(
    '推板走一轮后没有超出物理上限的能量注入',
    (afterPusher?.peakSpikeSpeed ?? 99) <= 6.3,
    `压速 ${afterPusher?.spikeClamps} 次，峰值 ${afterPusher?.peakSpikeSpeed} 米/秒（自由落体上限 6.3）`,
  );
  return timeline;
}

async function runLayout(page) {
  console.log('\n── 模式：layout（无尽台面配置摘要） ──');
  const table = await readTable(page);
  const state = await readStateFresh(page);

  console.log('  名称                 预置  价值  普通  花纹  返币  热区');
  console.log(
    `  ${String(table?.name).padEnd(18)}  ${String(table?.coins).padStart(4)}  ` +
      `${String(table?.value).padStart(4)}  ${String(table?.bronze).padStart(4)}  ` +
      `${String(table?.pattern).padStart(4)}  ${String(table?.payout).padStart(4)}  ` +
      `${(state?.hotZone?.active ? '是' : '否').padStart(4)}`,
  );

  check('台面配置齐全', (table?.coins ?? 0) > 0 && (table?.value ?? 0) > 0, `${table?.coins} 枚`);
  // P2 满盘化：预置枚数必须落在设计区间里。低于下限是「没铺满」，
  // 高于上限是「铺过头了」——两者都会让 `assertLayoutValid` 之外的观感目标失守。
  check(
    '满盘预置枚数在设计区间内（280~320）',
    (table?.coins ?? 0) >= 280 && (table?.coins ?? 0) <= 320,
    `${table?.coins} 枚`,
  );
  check('盘面含返币筹码（无尽的核心返还通道）', (table?.payout ?? 0) > 0, `${table?.payout} 枚`);
  check('热区已开启（XIXI 为常驻机制，无开关）', state?.hotZone?.active === true);
  check(
    '实际生成枚数与配置一致',
    state?.activeCoins === table?.coins && state?.anomalies === 0,
    `activeCoins=${state?.activeCoins}/${table?.coins}，异常 ${state?.anomalies}`,
  );

  // 币池预算是硬上限，而且池满时 acquire() 是静默返回 null 的。
  // P2 的满盘化（300~400 枚）必须先抬高 COIN.budget，否则盘面根本铺不满。
  const remaining = state?.mechanisms?.coinsRemaining ?? 0;
  const budget = (state?.activeCoins ?? 0) + remaining;
  console.log(`  币池：活跃 ${state?.activeCoins} + 余量 ${remaining} = 预算 ${budget}`);
  if ((table?.coins ?? 0) > budget) {
    console.log(
      `  ⚠ 盘面枚数 ${table?.coins} 超过币池预算 ${budget}：满盘化之前必须抬高 COIN.budget。`,
    );
  }
  check('币池余量非负且预算能装下整盘', remaining >= 0 && budget >= (table?.coins ?? 0), `预算 ${budget}`);
  return table;
}

/** 静置判据的速度阈值，与 `RULES.restSpeed` 一致。 */
const RULES_REST_SPEED = 0.08;
/** 上层（推板顶面）币的判定高度。币床最高叠到 y≈0.10，上层币静止在 y≈0.21，0.15 是干净的分界。 */
const DECK_Y = 0.15;

/**
 * 互相穿插的币的对数（**同层**横向重叠）。
 *
 * `anomalies` 只统计「掉出机柜」的币，**不统计币堆内部互相挤进去**——而满盘下
 * 后者才是穿模的主形态。所以这里单独量：同层（高度差 < 币厚）且横向距离
 * < 币径 × 0.9 的一对，就是一对被挤穿的币。
 *
 * 为什么看**横向**距离：叠起来的币心在 y 上只差 `LAYER_STEP` = 0.021 米，
 * 用三维距离算会把一摞正常的币全判成穿插。
 */
function overlappingPairs(coins) {
  // 同层的判据是**半个币厚**（0.01 米），不是整个币厚：
  // 求解器允许接触点有一点穿透（默认量级毫米），叠起来的币心会被压到 0.016~0.021 米，
  // 用整个币厚（0.02）当门槛会把**正常的叠放**全判成穿插（第一版就报了 211 对，全是误判）。
  // 同一层的币心高度基本一致（都落在同一个台面上），Δy 接近 0。
  const sameLayerLimit = 0.01;
  const squashed = 0.12 * 0.9;
  let count = 0;
  let closest = Infinity;
  let worst = null;
  for (let i = 0; i < coins.length; i += 1) {
    for (let j = i + 1; j < coins.length; j += 1) {
      const a = coins[i];
      const b = coins[j];
      if (Math.abs(a.y - b.y) >= sameLayerLimit) continue;
      const distance = Math.hypot(a.x - b.x, a.z - b.z);
      if (distance < closest) {
        closest = distance;
        worst = { a, b, distance };
      }
      if (distance < squashed) count += 1;
    }
  }
  return { count, closest, worst };
}

/**
 * 物理模式：满盘下的四条结构信号。
 *
 * ① **静置 10 秒全静止** —— 预置坐标如果互相穿插、或者上层币落进了「台面输送」
 *    的高度带，开局就会自己炸开/自己散架。这条是盘面自检（`assertLayoutValid`）
 *    的运行时对照：自检查配置，这条查物理。
 * ② **推板节拍跟得上实时** —— 300 枚盘面下推板跑 10 个循环，墙钟时间不超理论值 5%。
 *    满盘化最直接的性能风险就是物理跟不上：`PhysicsWorld` 会丢积压的累加器，
 *    表现为推板变慢、周期被拉长。
 * ③ **上层留存** —— 10 个循环后上层还剩多少。台面输送如果不对预置币设闸门，
 *    上层会在 1 秒内被整片冲下前缘（离前缘只有 0.12 米、输送 0.85 m/s）。
 * ④ **静止态不穿模** —— 停推板、等币堆自己静止，再量同层横向重叠的对数。
 *    必须量静止态：推板挤压中的瞬时嵌入是正常形态，量它等于让断言赌运气。
 * ⑤ **币堆坐在台面上** —— 币心不得低于「地板顶面 + 币半厚」。
 *    这条专门照「整堆沉进地板」这种整盘级缺陷：软接触（`erp` 太小）会让
 *    318 枚币把地板压穿、然后一起睡着，而 ①②③④ 全都照不出来。
 */
async function runPhysics(page) {
  console.log('\n── 模式：physics（满盘静置 / 推板节拍 / 上层留存 / 币堆穿插） ──');
  const hooks = (fn, ...args) => page.evaluate(fn, ...args);
  const deckOf = (coins) => coins.filter((coin) => coin.y > DECK_Y).length;

  await hooks(() => window.__THREE_GAME_TEST_HOOKS__?.clearSave?.());
  const table = await readTable(page);
  const preset = table?.coins ?? 0;

  // ── ① 静置 10 秒 ──
  await startRun(page, 'ready');
  const idleCoins = await readCoins(page);
  const deckStart = deckOf(idleCoins);
  await page.waitForTimeout(10_000);
  const idleAfter = await readStateFresh(page);
  const idleFastest = (await readCoins(page)).reduce((max, coin) => Math.max(max, coin.speed ?? 0), 0);
  check(
    '① 静置 10 秒：不结算、不丢币、无异常、推板不动',
    idleAfter?.earned === 0 &&
      idleAfter?.activeCoins === preset &&
      idleAfter?.anomalies === 0 &&
      idleAfter?.pusher?.running === false,
    `赚进 ${idleAfter?.earned}，币 ${idleAfter?.activeCoins}/${preset}，` +
      `异常 ${idleAfter?.anomalies}，推板 ${idleAfter?.pusher?.running ? '在动' : '静止'}`,
  );
  check(
    `① 静置 10 秒：全部币静止（合速度 < ${RULES_REST_SPEED} m/s）`,
    idleFastest < RULES_REST_SPEED,
    `最快 ${idleFastest.toFixed(3)} m/s`,
  );

  // ── ② 推板 10 个循环的节拍 ──
  const before = await readStateFresh(page);
  const cyclesBefore = before?.pusher?.cycles ?? 0;
  const wallStart = Date.now();
  // 首投必须真的进去：投不进去推板根本不会起，「0 个循环」会读成节拍崩了。
  await primeFirstDrop(page, 0);
  const cycled = await waitFor(page, (state) => (state?.pusher?.cycles ?? 0) >= cyclesBefore + 10, 90_000);
  const wallSeconds = (Date.now() - wallStart) / 1000;
  const advanced = (cycled?.pusher?.cycles ?? 0) - cyclesBefore;
  // 一个循环 = PUSHER_CYCLE 四段之和 = 2.4 秒。
  const theory = advanced * 2.4;
  check(
    `② 推板 ${advanced} 个循环跟得上实时（墙钟 ≤ 理论值 × 1.05）`,
    advanced >= 10 && wallSeconds <= theory * 1.05,
    `墙钟 ${wallSeconds.toFixed(1)} 秒 / 理论 ${theory.toFixed(1)} 秒`,
  );

  // ── ③ 盘面不倾泻 + 上层留存 + 币堆不互相穿插 ──
  const after = await readStateFresh(page);
  const coinsAfter = await readCoins(page);
  const deckAfter = deckOf(coinsAfter);
  check(
    '② 推板不把盘面一次推光（枚数 ≥ 预置 75%）',
    (after?.activeCoins ?? 0) >= preset * 0.75,
    `币 ${after?.activeCoins}/${preset}`,
  );
  check(
    '③ 上层留存 ≥ 85%（台面输送只作用于玩家投下的币）',
    deckStart > 0 && deckAfter >= deckStart * 0.85,
    `上层 ${deckStart} → ${deckAfter} 枚`,
  );
  // 装载时的对照数：预置坐标是手工排的，理论上不该有穿插；它用来区分
  // 「穿插是物理跑出来的」还是「排布本来就挤在一起」。
  const overlapAtLoad = overlappingPairs(idleCoins);
  // 推板还在挤压时的瞬时对数：**只作信息，不作判据**。
  // 币会顺着推币面爬上去、彼此短暂嵌入，几秒后又自己解开——那是推币机的正常形态。
  // 拿这一瞬间当判据会让同一条盘面两次跑出相反结论（实测 0 对与 3 对都出现过），
  // 违反「断言不要建在偶然上」。
  const overlapMidMotion = overlappingPairs(coinsAfter);

  // ── ④ 停推板 → 等币堆静止 → 量**稳定下来**的穿模 ──
  // 判据必须落在确定性状态上：同样是「静止」，推板挤压中的静止与停下来的静止
  // 是两回事，只有后者能反复复现。
  await hooks(() => window.__THREE_GAME_TEST_HOOKS__?.setPusherRunning?.(false));
  let quiet = 0;
  for (let i = 0; i < 40 && quiet < 2; i += 1) {
    await page.waitForTimeout(500);
    const fastest = (await readCoins(page)).reduce((max, coin) => Math.max(max, coin.speed ?? 0), 0);
    quiet = fastest < RULES_REST_SPEED ? quiet + 1 : 0;
  }
  const settled = await readCoins(page);
  const overlapSettled = overlappingPairs(settled);
  // ④ 的真正判据走**引擎的接触穿透深度**（见下面的注释）。
  // 几何启发式只当信息：它会误报——实测有「平躺币 + 46° 斜币、币心相距 79 毫米」
  // 这种完全合法的倚靠（斜币的边缘搭在平币面上），启发式一律判成穿模。
  const penetration = await readPenetration(page, 4);
  const COIN_COIN_LIMIT = 0.01;
  const COIN_STATIC_LIMIT = 0.004;
  check(
    '④ 币堆静止后没有互相穿插的币（引擎接触穿透判据）',
    penetration !== null &&
      penetration.coinDeepest <= COIN_COIN_LIMIT &&
      penetration.staticDeepest <= COIN_STATIC_LIMIT,
    `币↔币最深 ${((penetration?.coinDeepest ?? 0) * 1000).toFixed(1)} 毫米` +
      `（上限 ${COIN_COIN_LIMIT * 1000}，共 ${penetration?.coinContacts ?? 0} 处接触），` +
      `币↔机台最深 ${((penetration?.staticDeepest ?? 0) * 1000).toFixed(1)} 毫米` +
      `（上限 ${COIN_STATIC_LIMIT * 1000}）；` +
      `几何同层重叠 ${overlapSettled.count} 对（仅记录）`,
  );

  // ── ⑤ 币堆必须**坐在台面上** ──
  // 这条是 2026-09-22 复核发现的整盘缺陷的判据：`PHYSICS.erp` 太软（Rapier 默认 0.2）时，
  // 318 枚币的重量压得位置修正打不过载荷，**整堆沉进地板**并就此睡着——
  // 而 ①②③④ 全都照过：币确实「静止」、也确实「没互相穿插」，因为它们是一起沉下去的。
  // 只有「币心不得低于地板顶面 + 币半厚」这一条能照出来。
  const bedCoins = settled.filter((coin) => coin.y < DECK_Y);
  const bedLowest = bedCoins.reduce((min, coin) => Math.min(min, coin.y), Infinity);
  const FLAT_REST_Y = 0.01 - 0.002;
  const sunkCount = bedCoins.filter((coin) => coin.y < FLAT_REST_Y).length;
  check(
    '⑤ 币床的币坐在台面上（没有整堆沉进地板）',
    bedCoins.length > 0 && sunkCount === 0,
    `币床 ${bedCoins.length} 枚，沉入地板 ${sunkCount} 枚，` +
      `最低币心 ${bedLowest.toFixed(4)} 米（下限 ${FLAT_REST_Y}）`,
  );

  return {
    preset,
    deckStart,
    deckAfter,
    overlapMidMotion: overlapMidMotion.count,
    overlapSettled: overlapSettled.count,
    sunkCount,
  };
}

async function runEndless(page) {
  console.log('\n── 模式：endless（xixi 大王大赏） ──');
  const hooks = (fn, ...args) => page.evaluate(fn, ...args);

  await hooks(() => window.__THREE_GAME_TEST_HOOKS__?.clearSave?.());

  // 允许值集合与固定值币种都由**引擎枚举**（见 `readAllowedGains` 的说明）。
  // 必须放在 `clearSave` 之后：它会整页刷新，之前的页面上下文已经没了。
  const allowed = await readAllowedGains(hooks);
  const ALLOWED_GAINS = new Set(allowed.gains);
  const ALLOWED_HOT_GAINS = new Set(allowed.hotGains);
  const FIXED_VALUES = allowed.fixed;
  check(
    '允许值集合由引擎枚举（不是脚本里手写展开的第二份公式）',
    allowed.gains.length >= 5 && allowed.hotGains.length >= 5,
    `非热区 ${allowed.gains.join('/')}；热区 ${allowed.hotGains.join('/')}；固定值 ${FIXED_VALUES.join('/')}`,
  );

  // 固定值币种必须**不吃任何倍率**——否则返币/大赏会成为比铜币更划算的刷筹码通道，
  // 「期望为负」立刻失效。这条以前只有 `crossingReturn` 的注释在说，没有判据。
  const fixedIgnoreMul = await hooks((fixed) => {
    const api = window.__THREE_GAME_TEST_HOOKS__;
    const kinds = ['payout', 'bounty'];
    return fixed.every((value, index) =>
      [false, true].every((hot) =>
        [1, 2, 4].every((betMul) =>
          [0, 3, 8, 15].every(
            (combo) =>
              api.crossingReturn({ kind: kinds[index], combo, hot, betMul, roll: 0 }).chips === value,
          ),
        ),
      ),
    );
  }, FIXED_VALUES);
  check(
    '固定值币种不吃任何倍率（返币/大赏与连落、热区、加注都无关）',
    fixedIgnoreMul,
    `固定值 ${FIXED_VALUES.join('/')} 筹码，已按 2 币种 × 2 热区 × 3 档加注 × 4 段连落逐组重算`,
  );

  await startRun(page, 'ready');
  const start = await readStateFresh(page);
  const table = await readTable(page);
  const walletStart = (await hooks(() => window.__THREE_GAME_TEST_HOOKS__?.run?.()))?.wallet ?? 0;
  check(
    '开局即满盘：筹码 = 从钱包买入的额度、无目标分、无星级',
    start?.chips === start?.buyIn &&
      start?.buyIn === Math.min(20, walletStart) &&
      start?.phase === 'ready' &&
      start?.activeCoins === table?.coins &&
      start?.pusher.running === false,
    `买入 ${start?.buyIn} 筹码（钱包 ${walletStart}），盘面 ${start?.activeCoins} 枚，阶段 ${start?.phase}`,
  );
  check('开局账本平', ledgerOk(start), ledgerText(start));

  // 热身：投满一轮不重复的落点，让后面几条断言有越线事件可读。
  // 这里**不再**顺便数大赏币——大赏币的注入间隔是配置（`bountyEveryDrops`），
  // 而买一局只有 20 枚筹码，投到注入阈值之前本局可能已经破产，
  // 「盘面上此刻有几枚」既测不准注入率、又随推板相位漂。
  // 注入率改在本局投数足够之后用计数器精确核对（见下面「大赏币注入率」）。
  for (let index = 0; index < 15; index += 1) {
    await dropUntilAccepted(page, [-0.7, -0.35, 0, 0.35, 0.7][index % 5]);
  }
  await page.waitForTimeout(400);

  // 热度倍率：连落时入账筹码高于基础值，且必为「基础值 × 倍率」。
  await waitFor(page, (state) => (state?.earned ?? 0) > 0, 60_000);
  const { scoreEvents } = await readTelemetry(page);
  const bronzeValues = scoreEvents.filter((event) => event.kind === 'bronze').map((event) => event.value);
  const boosted = bronzeValues.filter((value) => value > 1).length;
  const bestCombo = (await readState(page))?.bestCombo ?? 0;
  check(
    '热度倍率只放大筹码：入账 = 基础值 1 × 热度 1.5/2/3（热区再翻倍）',
    bronzeValues.every((value) => ALLOWED_GAINS.has(value)) && (bestCombo < 3 || boosted > 0),
    `铜币入账 ${[...new Set(bronzeValues)].join('/') || '无'}，最高连落 ${bestCombo}，` +
      `其中被放大的 ${boosted} 次`,
  );

  // 破产：筹码见底 + 盘面沉降完 → 嘲讽弹窗。
  // 设计目标是「一条命 60~90 投」，所以按推板节奏投（不是连点），投到破产为止。
  // `cap` 只是**防死循环的上限**，必须按这一局的真实起点算（见下面第 2 局的说明）。
  const playUntilRuin = async (cap = 160) => {
    let drops = 0;
    let reason = '达到上限';
    let lastCycle = -1;
    for (let index = 0; index < cap; index += 1) {
      const state = await readState(page);
      // 破产要连 settleReason 一起成立：面板可能比状态机早一帧亮起，
      // 那一帧读到的是 settleReason=null（下游「破产是筹码耗尽收尾」会假红）。
      if (state?.endless?.ruinVisible && state?.settleReason === 'exhausted') {
        reason = '破产';
        break;
      }
      if (state?.phase === 'settled') {
        reason = '已结算';
        break;
      }
      // 按节奏：等推板走完一个循环再投。收尾期间推板已经停了，就只等冷却。
      if (state?.phase !== 'drainOut') {
        const advanced = await waitFor(page, (current) => (current?.pusher?.cycles ?? 0) > lastCycle, 8_000);
        if (advanced) lastCycle = advanced.pusher.cycles;
      }
      const accepted = await dropUntilAccepted(page, [-0.7, -0.35, 0, 0.35, 0.7][index % 5], 5000);
      if (accepted) drops += 1;
      else await page.waitForTimeout(400);
    }
    const { state } = await waitForRunEnd(page, 120_000);
    return { drops, reason, state };
  };

  const first = await playUntilRuin();
  // 判据**不能要求筹码恰好为 0**：破产窗弹出后，仍可能有在途币越线返值——
  // 那是被账本记录的迟到返值（`gainChips` 不复活，本局停在破产窗），不是漏记。
  // 与 `bot-playtest` 的同款说明同源；XIXI 演出让收尾期在途币更多，这条从「偶尔」变常态。
  check(
    '筹码归零并沉降完 → 破产弹窗',
    first.state?.endless?.ruinVisible === true &&
      (first.state?.chips ?? -1) >= 0 &&
      (first.state?.chips ?? 0) < (first.state?.buyIn ?? 0),
    `投出 ${first.drops} 枚后${first.reason}，筹码 ${first.state?.chips}（买入 ${first.state?.buyIn}）`,
  );
  check('破产是筹码耗尽收尾（唯一收尾原因）', first.state?.settleReason === 'exhausted');
  check('破产时账本平', ledgerOk(first.state), ledgerText(first.state));

  // 跪求：递减赏赐、只给筹码、盘面保留、**且不可回存**。
  //
  // 「赏赐不记 earned」不能写成「窗口里 earned 一动不动」：破产窗弹出后盘面
  // 仍有在途币，越线是合法账本事件（XIXI 时代这类迟到越线变成常态）。
  // 正确口径：**earned 的增量必须恰好等于窗口内 scoreEvents 的合计**——
  // 多出来的部分才是「赏赐被错记成赚进」。
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.enableTelemetry?.());
  const eventsBeforeBeg = (await readTelemetry(page))?.scoreEvents?.length ?? 0;
  const beforeBeg = await readStateFresh(page);
  const begged = await hooks(() => window.__THREE_GAME_TEST_HOOKS__?.beg?.() ?? false);
  const afterBeg = await readStateFresh(page);
  const { scoreEvents: eventsAfterBeg } = await readTelemetry(page);
  const crossingsInWindow = eventsAfterBeg
    .slice(eventsBeforeBeg)
    .reduce((sum, event) => sum + event.value, 0);
  const runState = await hooks(() => window.__THREE_GAME_TEST_HOOKS__?.run?.());
  check(
    '跪求 xixi 大王：领递减赏赐，只给筹码且盘面保留',
    begged === true &&
      (afterBeg?.chips ?? 0) > 0 &&
      afterBeg?.earned === (beforeBeg?.earned ?? 0) + crossingsInWindow &&
      (afterBeg?.begged ?? 0) > (beforeBeg?.begged ?? 0) &&
      runState?.begs === 1,
    `筹码 ${beforeBeg?.chips}→${afterBeg?.chips}，` +
      `赚进 ${beforeBeg?.earned}→${afterBeg?.earned}（窗口内越线 ${crossingsInWindow}），` +
      `跪求累计 ${beforeBeg?.begged}→${afterBeg?.begged}，` +
      `币 ${beforeBeg?.activeCoins}→${afterBeg?.activeCoins}`,
  );
  check('跪求后账本平（赏赐记进 begged 而不是 earned）', ledgerOk(afterBeg), ledgerText(afterBeg));

  // ── 跪求把局拉回来了 ──
  //
  // **这里只断言「拉回来了」，不再断言「必须再破产一次」。**
  //
  // 原来是「再玩到破产为止」。它的隐含前提是「第 2 局的回收率与第 1 局差不多」，而实测不成立：
  // 跪求给 30 筹码（1.5 个买入额），而且是**在保留下来的盘面上继续打**——
  // 第 1 局已经把那盘币排水过一轮，而**排水后的盘面越线/投币比更高**
  // （币都挤在得分线附近，推板一个行程能扫下好几枚），于是第 2 局回收率更高、局更长。
  //
  // 实测：第 1 局 49 投就断（回收 0.59，正好在设计带内），第 2 局投到 **160 枚还活着**
  // （回收 ≥ 0.82，期望局长 `30 ÷ (1 − 0.82) ≈ 167` 投）——原来的 160 上限刚好卡在它下面。
  //
  // 那是**经济问题（回收率随盘面排水爬升），不是这条断言该测的东西**；
  // 而且它一失败会把后面「收工 / 再开新局」一起拖红（见下面那段的说明）。
  // 所以改成有界探针：按推板节奏投满 20 枚（不等本局收尾），
  // 证明跪求之后**局真的继续跑**——推板在走、币投得出去、账本仍然平，而不是死锁在破产窗上。
  let probeDrops = 0;
  let probeLastCycle = -1;
  let probeGuard = 0;
  while (probeDrops < 20 && probeGuard < 40) {
    probeGuard += 1;
    const state = await readState(page);
    if (state?.endless?.ruinVisible === true || state?.phase === 'settled') break;
    if (state?.phase !== 'drainOut') {
      const advanced = await waitFor(
        page,
        (current) => (current?.pusher?.cycles ?? 0) > probeLastCycle,
        8_000,
      );
      if (advanced) probeLastCycle = advanced.pusher.cycles;
    }
    const accepted = await dropUntilAccepted(page, [-0.7, -0.35, 0, 0.35, 0.7][probeDrops % 5], 5000);
    if (accepted) probeDrops += 1;
    else await page.waitForTimeout(400);
  }
  const afterProbe = await readStateFresh(page);
  check(
    '跪求后局被拉回：推板继续、能继续投币、账本仍平',
    probeDrops === 20 && afterProbe?.endless?.ruinVisible !== true && ledgerOk(afterProbe),
    `又投出 ${probeDrops}/20 枚（本局累计 ${afterProbe?.endless?.drops} 枚），` +
      `筹码 ${afterProbe?.chips}，账本 ${ledgerText(afterProbe)}`,
  );

  // 大赏币注入率：**本局累计注入枚数 === floor(累计投数 / 注入间隔)**。
  // 间隔从诊断读，不写死——P8 会重新标定它，写死 15/30 只会制造假失败。
  // 放在这里是因为此时本局投数已经足够长，前提（drops ≥ 间隔）成立且可报出来。
  const bountyEvery = afterProbe?.endless?.bountyEveryDrops ?? 0;
  const bountiesInjected = afterProbe?.endless?.bounties ?? -1;
  const dropsTotal = afterProbe?.endless?.drops ?? 0;
  check(
    `大赏币按注入率注入（每 ${bountyEvery} 投 1 枚）`,
    bountyEvery > 0 &&
      bountiesInjected >= 1 &&
      bountiesInjected === Math.floor(dropsTotal / bountyEvery),
    `本局投 ${dropsTotal} 枚 → 应注入 ${Math.floor(dropsTotal / bountyEvery)} 枚，实际 ${bountiesInjected} 枚`,
  );

  // ── 收工 / 总结页 / 再开新局 ──
  //
  // 这三条测的是**总结页的状态机**，与「破产是怎么来的」无关。
  // `endRun()` 的前置条件是「破产弹窗可见」或「已在总结页」，否则**直接 return（空操作）**。
  // 所以只要上面那局没破产，这三条会**连环红**：报出来的现象是「总结页坏了、盘面没复位」，
  // 而真正的原因在上面那条。那是级联误报——测的是 A，报的却是 B（§6.7 的老教训）。
  //
  // 用 `forceRuin()` 把破产弹窗**确定性地**构造出来，把这三条与上面解耦。
  // **不能用 `setState('ruin')`**：它会先 `startRun()` 重开一局，
  // 把 `earned` / `begsThisRun` 清零——而总结页要显示的正是这两个值
  // （实测踩过：跪求过一次之后用 `setState('ruin')` 搭场景，总结页报「累计跪求 0」，
  // 于是「保留尊严收工」这条判据自己把自己搞红了）。
  if ((await readStateFresh(page))?.endless?.ruinVisible !== true) {
    await hooks(() => window.__THREE_GAME_TEST_HOOKS__?.forceRuin?.());
    await page.waitForTimeout(400);
  }

  const walletBeforeCashOut = (await hooks(() => window.__THREE_GAME_TEST_HOOKS__?.run?.()))?.wallet ?? 0;
  const ledgerBeforeCashOut = await hooks(() => window.__THREE_GAME_TEST_HOOKS__?.ledger?.());
  // 成绩单记录的是**收工那一刻**的赚进，之后盘面在途币仍可能迟到越线（账本照记），
  // 实时 `earned` 会继续涨——所以基准要取收工前，而不是拿收工后的实时值去比
  // （XIXI 演出让收尾期在途币更多，这条从「偶尔」变常态）。
  const earnedBeforeCashOut = (await readStateFresh(page))?.earned ?? 0;
  await hooks(() => window.__THREE_GAME_TEST_HOOKS__?.quitRun?.());
  await page.waitForTimeout(400);
  const summary = await readStateFresh(page);
  check(
    '保留尊严收工：记录赚进与跪求次数，弹总结卡片',
    (summary?.endless?.bestEarned ?? 0) >= earnedBeforeCashOut &&
      (summary?.endless?.totalBegs ?? 0) >= 1 &&
      summary?.endless?.ruinVisible === true,
    `历史最高赚进 ${summary?.endless?.bestEarned}（收工时 ${earnedBeforeCashOut}），累计跪求 ${summary?.endless?.totalBegs}`,
  );
  // 钱包守恒：收工回存的额度必须**正好**是 cashOut，一分不多一分不少。
  const walletAfterCashOut = summary?.wallet ?? -1;
  check(
    '收工回存钱包：钱包增量 = cashOut（跪求来的脏钱不可回存）',
    walletAfterCashOut - walletBeforeCashOut === (ledgerBeforeCashOut?.cashOut ?? -1),
    `钱包 ${walletBeforeCashOut}→${walletAfterCashOut}，cashOut ${ledgerBeforeCashOut?.cashOut}`,
  );

  // 再来一局：面板收起、盘面与筹码复位。
  await hooks(() => window.__THREE_GAME_TEST_HOOKS__?.quitRun?.());

  // （临时诊断已撤）重开之后只看两个读数：刚摆完的、以及落定后的。
  const restartedEarly = await readStateFresh(page);
  await page.waitForTimeout(1_200);
  const restarted = await readStateFresh(page);

  // **开新局不得丢币。** 这一条以前只断言「盘面枚数 = 预置枚数」，丢币时才红；
  // 而丢币的真因（推板归位被实现成一帧倒扫，把背排币挤飞出机柜）只有顺着
  // `anomalies` 才看得出来。所以把「开局无异常」一并写进判据，
  // 并把异常币飞出时的坐标报出来（它们已被 `despawn`，事后查盘面是看不到的）。
  const restartAnomalies = restarted?.anomalySamples ?? [];
  check(
    '总结页再点一次即开新局：盘面与筹码复位（且开局不丢币）',
    restarted?.endless?.ruinVisible === false &&
      restarted?.chips === restarted?.buyIn &&
      restarted?.phase === 'ready' &&
      restarted?.earned === 0 &&
      restarted?.activeCoins === table?.coins &&
      (restarted?.anomalies ?? -1) === 0,
    `买入 ${restarted?.buyIn} 筹码（钱包 ${summary?.wallet}），盘面 ${restarted?.activeCoins} 枚，` +
      `阶段 ${restarted?.phase}（刚重开时 ${restartedEarly?.activeCoins} 枚，预置 ${table?.coins} 枚）；` +
      `开局异常 ${restarted?.anomalies} 次` +
      (restartAnomalies.length
        ? `，最早几枚 ${restartAnomalies
            .slice(0, 3)
            .map((coin) => `${coin.kind}(${coin.x},${coin.y},${coin.z}) v=${coin.speed}`)
            .join(' ')}`
        : ''),
  );
  check(
    '总结页再点一次即开新局：盘面与筹码复位',
    restarted?.endless?.ruinVisible === false &&
      restarted?.chips === restarted?.buyIn &&
      restarted?.phase === 'ready' &&
      restarted?.earned === 0 &&
      restarted?.activeCoins === table?.coins,
    `买入 ${restarted?.buyIn} 筹码（钱包 ${summary?.wallet}），盘面 ${restarted?.activeCoins} 枚，` +
      `阶段 ${restarted?.phase}（刚重开时 ${restartedEarly?.activeCoins} 枚，预置 ${table?.coins} 枚）`,
  );

  // ── 热区与加注 ──
  const hotOn = await readStateFresh(page);
  check(
    '热区：无尽恒开，半宽 0.15 米',
    hotOn?.hotZone?.active === true && hotOn?.hotZone?.halfWidth === 0.15,
    `active=${hotOn?.hotZone?.active}，半宽 ${hotOn?.hotZone?.halfWidth}`,
  );

  const betBefore = await readStateFresh(page);
  const cycled = await hooks(() => window.__THREE_GAME_TEST_HOOKS__?.cycleBet?.() ?? false);
  const betAfter = await readStateFresh(page);
  check(
    '加注：切档后按档位扣筹码，返值倍率跟着档位走',
    cycled === true && betAfter?.bet?.chips === 2 && betAfter?.bet?.mul === 2,
    `档位 ${betBefore?.bet?.index}→${betAfter?.bet?.index}，` +
      `${betAfter?.bet?.chips} 投 / ×${betAfter?.bet?.mul}`,
  );

  const beforeBetDrop = await readStateFresh(page);
  await dropUntilAccepted(page, 0);
  const afterBetDrop = await readStateFresh(page);
  check(
    '加注：一次投币按档位扣 2 枚筹码',
    afterBetDrop?.chips === beforeBetDrop.chips - 2 && ledgerOk(afterBetDrop),
    `筹码 ${beforeBetDrop.chips}→${afterBetDrop?.chips}`,
  );

  // 热区翻倍与加注倍率：入账必须是「基础值 × 热度 ×（热区 2 倍）× 加注倍率」。
  //
  // **这条必须自己把场景跑起来，不能只「等」。** 两个原因：
  //
  // · 热区只占盘面宽度的一小段（`0.3 ÷ 1.36 ≈ 22%`），命中本来就是低频事件，
  //   所以早先已经把它从「固定等 4 秒」改成了「等到出现为止」；
  // · 但「等」还隐含一个前提——**盘面此刻正在产出越线**。以前这条能过，
  //   是因为前面的流程*凑巧*留下了一个正在大量越线的局（正是那个级联把它掩盖了）；
  //   级联修掉之后，这里只剩「重开一局 + 投 1 枚」，实测 180 秒里**一次越线都没等到**。
  //
  // 所以：先把加注切回 ×1（手里 18 枚筹码要够投满一轮），再按推板节奏投币，
  // 投到**真的出现热区越线**为止（上限 18 枚；打满还没有就说明命中率远低于盘面占比，
  // 那是实现有问题，该红）。顺带把遥测重新打开——整页刷新会静默关掉它（见 `startRun`）。
  await hooks(() => window.__THREE_GAME_TEST_HOOKS__?.enableTelemetry?.());
  for (let guard = 0; guard < 3; guard += 1) {
    if ((await readStateFresh(page))?.bet?.mul === 1) break;
    await hooks(() => window.__THREE_GAME_TEST_HOOKS__?.cycleBet?.());
  }

  const isHot = (data) => (data?.scoreEvents ?? []).some((event) => event.hot);
  let hotTelemetry = await readTelemetry(page);
  let hotDrops = 0;
  let hotLastCycle = -1;
  while (!isHot(hotTelemetry) && hotDrops < 18) {
    const state = await readState(page);
    if (state?.endless?.ruinVisible === true || state?.phase === 'settled') break;
    if (state?.phase !== 'drainOut') {
      const advanced = await waitFor(
        page,
        (current) => (current?.pusher?.cycles ?? 0) > hotLastCycle,
        8_000,
      );
      if (advanced) hotLastCycle = advanced.pusher.cycles;
    }
    const accepted = await dropUntilAccepted(page, [0, 0.4, -0.4, 0.7, -0.7][hotDrops % 5], 5000);
    if (accepted) hotDrops += 1;
    else await page.waitForTimeout(400);
    hotTelemetry = await readTelemetry(page);
  }

  const hotEvents = hotTelemetry.scoreEvents.filter((event) => event.hot);
  const hotCycles = hotTelemetry.cycles ?? [];
  const hotCrossed = hotCycles.length ? hotCycles[hotCycles.length - 1].coins : 0;
  const hotPusherRunning = (await readState(page))?.pusher?.running === true ? '在跑' : '停着';
  const badValues = hotTelemetry.scoreEvents.filter((event) => !ALLOWED_GAINS.has(event.value));
  // 热区里必须**按币种**分开判：铜币/花纹吃 2 倍（但铜币仍可能被闸门拦成 0），
  // 返币 3 与大赏币 8 是**固定值、刻意不吃倍率**。
  //
  // **不能按「值等于 3 或 8」去认固定值币种**：加注 ×2 之后，
  // 一枚热区里的铜币是 1 × 热度 2 × 热区 2 × 加注 2 = **8**，与固定值撞车，
  // 于是它被当成「返币/大赏币却是铜币」而报假失败（实测撞到过一次）。
  // 币种是唯一真源，值只是它的像。
  const hotVariable = hotEvents.filter((event) => event.kind === 'bronze' || event.kind === 'pattern');
  const hotFixed = hotEvents.filter((event) => event.kind === 'payout' || event.kind === 'bounty');
  const hotOutOfRange = hotVariable.filter((event) => !ALLOWED_HOT_GAINS.has(event.value));
  const fixedNotOriginal = hotFixed.filter((event) => !FIXED_VALUES.includes(event.value));
  check(
    '热区：亮条内越线返值翻倍，且入账 = 基础值 × 倍率',
    hotEvents.length >= 1 &&
      badValues.length === 0 &&
      hotOutOfRange.length === 0 &&
      fixedNotOriginal.length === 0,
    `${hotEvents.length} 枚在热区内越线（可变值 ${hotVariable.length} / 固定值 ${hotFixed.length}），` +
      `入账 ${[...new Set(hotEvents.map((e) => e.value))].join('/')}，` +
      `越界值 ${badValues.length} 次，热区越界 ${hotOutOfRange.length} 次，` +
      `固定值币种被放大 ${fixedNotOriginal.length} 次` +
      `（本局为此投了 ${hotDrops} 枚、越线共 ${hotCrossed} 枚、推板 ${hotPusherRunning}）`,
  );
}

/**
 * 经济模式：三账本 / 跪求不可回存 / 单位期望与净流出。
 *
 * 两条腿分工明确：
 *
 * · **真物理**（跑几局）验证账本恒等式与钱包守恒——这些只在真实越线时才被触发，
 *   纯函数测不出来。
 * · **纯函数蒙特卡洛**验证「庄家终赢」——200 局真物理要跑几个小时，而
 *   `crossingReturn` 不持有状态、随机数由调用方传入，所以把**实测的越线构成**
 *   喂给它做换档重算，得到的就是这台机真实的期望。
 *
 * 关键点：期望里的每一个输入都来自实测——越线构成（kind × combo × hot）来自
 * 真实遥测，越线/投币比来自真实计数。脚本里不出现任何「假设的概率分布」，
 * 否则测的是我脑子里的机器，不是这台机器。
 *
 * 用 ECON_RUNS 覆盖真物理局数（默认 2，每局最长 150 秒）。
 */
async function runEconomy(page) {
  console.log('\n── 模式：economy（三账本 / 单位期望 / 净流出） ──');
  const hooks = (fn, ...args) => page.evaluate(fn, ...args);
  const RUNS = Number(process.env.ECON_RUNS ?? 2);

  await hooks(() => window.__THREE_GAME_TEST_HOOKS__?.clearSave?.());
  const walletStart = (await hooks(() => window.__THREE_GAME_TEST_HOOKS__?.run?.()))?.wallet ?? 0;
  console.log(`  起始钱包 ${walletStart}，真物理 ${RUNS} 局`);

  // ── ① 真物理：账本恒等式 + 钱包守恒 + 越线构成采样 ──
  const runs = [];
  const crossingSamples = [];
  let totalCrossings = 0;
  let totalDrops = 0;
  let spentTotal = 0;
  let earnedTotal = 0;
  let buyInTotal = 0;
  let cashOutTotal = 0;

  for (let index = 0; index < RUNS; index += 1) {
    const final = await playRun(page);
    // 破产弹窗里本局还没结束，必须先收工才会回存——钱包守恒要按「完整一局」量。
    if (final?.end === 'ruin') {
      await hooks(() => window.__THREE_GAME_TEST_HOOKS__?.quitRun?.());
      await page.waitForTimeout(400);
    }
    const after = await readStateFresh(page);
    const ledger = await hooks(() => window.__THREE_GAME_TEST_HOOKS__?.ledger?.());
    const { scoreEvents, cycles } = await readTelemetry(page);
    const crossed = cycles.length ? cycles[cycles.length - 1].coins : 0;

    for (const event of scoreEvents) {
      crossingSamples.push({ kind: event.kind, combo: event.combo, hot: event.hot });
    }

    totalCrossings += crossed;
    totalDrops += final?.endless?.drops ?? 0;
    spentTotal += after?.spent ?? 0;
    earnedTotal += after?.earned ?? 0;
    buyInTotal += after?.buyIn ?? 0;
    cashOutTotal += ledger?.cashOut ?? 0;

    runs.push({
      end: final?.end,
      drops: final?.endless?.drops ?? 0,
      crossed,
      chips: after?.chips ?? 0,
      buyIn: after?.buyIn ?? 0,
      earned: after?.earned ?? 0,
      begged: after?.begged ?? 0,
      spent: after?.spent ?? 0,
      wallet: after?.wallet ?? 0,
      cashOut: ledger?.cashOut ?? 0,
      ledgerOk: ledgerOk(after),
    });
    console.log(
      `  第 ${index + 1} 局：投 ${runs[index].drops} 枚 → 越线 ${crossed} 枚，` +
        `买入 ${runs[index].buyIn} + 赚进 ${runs[index].earned} + 跪求 ${runs[index].begged} ` +
        `− 消耗 ${runs[index].spent} = ${runs[index].chips} 筹码，回存 ${runs[index].cashOut}，` +
        `钱包 ${runs[index].wallet}（${final?.end}）`,
    );
  }

  check(
    '① 每一局账本恒等式成立（误差 0）',
    runs.length === RUNS && runs.every((run) => run.ledgerOk),
    runs.map((run) => (run.ledgerOk ? '平' : `差 ${run.chips - (run.buyIn + run.earned + run.begged - run.spent)}`)).join('/'),
  );

  const walletExpected = walletStart - buyInTotal + cashOutTotal;
  const walletActual = runs.length ? runs[runs.length - 1].wallet : -1;
  // 超时局的本局**还没结束**，那笔筹码根本没回存（`quitRun` 只在破产分支被调用），
  // 所以 `ledger.cashOut` 在超时局上只是一个「如果现在收工能回存多少」的预测值。
  // 把预测值算进 Σ回存会让 ② 报出假失败（实测过一次：钱包 160，算式给出 163）。
  // 判据本身不变——只是不再把预测当入账。
  const cashOutCredited = runs
    .filter((run) => run.end !== 'timeout')
    .reduce((sum, run) => sum + run.cashOut, 0);
  check(
    '② 钱包守恒：wallet终 = wallet起 − Σ买入 + Σ（真正回存的）',
    walletActual === walletStart - buyInTotal + cashOutCredited,
    `钱包 ${walletActual}，应为 ${walletStart} − ${buyInTotal} + ${cashOutCredited} = ` +
      `${walletStart - buyInTotal + cashOutCredited}` +
      (cashOutTotal !== cashOutCredited
        ? `（另有 ${cashOutTotal - cashOutCredited} 是未结束局的预测回存，不计）`
        : '') +
      `｜原式口径应为 ${walletExpected}`,
  );

  // ── ② 跪求后回存 = 0：脏钱不能带走 ──
  // 用确定性场景而不是真物理：破产 → 跪求一次 → 立刻收工。
  // 真物理里「跪求后立刻收工」需要凑巧，这里直接构造，测的是规则本身。
  await hooks(() => window.__THREE_GAME_TEST_HOOKS__?.setState?.('ruin'));
  const ruinLedger = await hooks(() => window.__THREE_GAME_TEST_HOOKS__?.ledger?.());
  const begOk = await hooks(() => window.__THREE_GAME_TEST_HOOKS__?.beg?.() ?? false);
  const begLedger = await hooks(() => window.__THREE_GAME_TEST_HOOKS__?.ledger?.());
  const walletBeforeQuit = begLedger?.wallet ?? -1;
  await hooks(() => window.__THREE_GAME_TEST_HOOKS__?.quitRun?.());
  await page.waitForTimeout(400);
  const quitLedger = await hooks(() => window.__THREE_GAME_TEST_HOOKS__?.ledger?.());
  check(
    '③ 跪求的筹码记进 begged，收工回存为 0（脏钱不可回存）',
    begOk === true &&
      (begLedger?.begged ?? 0) > (ruinLedger?.begged ?? 0) &&
      begLedger?.cashOut === 0 &&
      quitLedger?.cashOut === 0 &&
      (quitLedger?.wallet ?? -1) === walletBeforeQuit,
    `跪求前 ${ruinLedger?.begged} → 跪求后 ${begLedger?.begged}，` +
      `回存 ${begLedger?.cashOut}，钱包 ${walletBeforeQuit}→${quitLedger?.wallet}`,
  );
  check('③ 跪求后账本仍平', ledgerOk(await readStateFresh(page)));

  // ── ③ 单位期望：把实测的越线构成喂给真实经济函数，逐档重算 ──
  const tiers = await hooks(() => window.__THREE_GAME_TEST_HOOKS__?.betTiers?.() ?? []);
  const expectations = await hooks(
    ({ samples, tierList, rolls }) => {
      const api = window.__THREE_GAME_TEST_HOOKS__;
      // xorshift32：确定性，同一组样本永远给出同一个期望值，断言不会自己飘。
      let seed = 20260922;
      const nextRoll = () => {
        seed ^= seed << 13;
        seed >>>= 0;
        seed ^= seed >>> 17;
        seed ^= seed << 5;
        seed >>>= 0;
        return seed / 4294967296;
      };
      return tierList.map((tier) => {
        let total = 0;
        for (const sample of samples) {
          for (let index = 0; index < rolls; index += 1) {
            total += api.crossingReturn({ ...sample, betMul: tier.mul, roll: nextRoll() }).chips;
          }
        }
        const count = samples.length * rolls;
        return { chips: tier.chips, mul: tier.mul, label: tier.label, perCrossing: count ? total / count : 0 };
      });
    },
    { samples: crossingSamples, tierList: tiers, rolls: 60 },
  );

  const perDrop = totalDrops > 0 ? totalCrossings / totalDrops : 0;
  const rows = expectations.map((tier) => ({
    ...tier,
    // 每投入 1 枚筹码的期望回收：越线/投币比 × 单次越线期望 ÷ 本档成本。
    unit: (perDrop * tier.perCrossing) / tier.chips,
  }));

  console.log(`  实测：越线 ${totalCrossings} 枚 / 投币 ${totalDrops} 枚 = ${perDrop.toFixed(3)} 枚/投`);
  for (const row of rows) {
    console.log(
      `  ${row.label}：单次越线期望 ${row.perCrossing.toFixed(3)} 筹码，` +
        `每枚筹码回收 ${row.unit.toFixed(3)}（成本 ${row.chips}）`,
    );
  }

  check(
    '④ 采样足够，期望不是靠空集合「通过」的',
    crossingSamples.length >= 20 && totalDrops >= 20,
    `${crossingSamples.length} 次越线事件，${totalDrops} 次投币`,
  );
  check(
    '④ 三档单位期望都 < 1（庄家优势：投 1 枚筹码平均回收不到 1 枚）',
    rows.length === tiers.length && rows.every((row) => row.unit < 1),
    rows.map((row) => `${row.label} ${row.unit.toFixed(3)}`).join('，'),
  );
  check(
    '④ 押越大单位期望越低（赌狗税：×4 档严格低于 ×1 档）',
    rows.length >= 3 && rows[rows.length - 1].unit < rows[0].unit,
    rows.map((row) => `${row.label} ${row.unit.toFixed(3)}`).join(' → '),
  );

  // 200 局净流出：这是规划里 P1 的验收条目。这里说清楚它的性质——
  // 「一局在筹码归零时结束」这条规则本身就让 `赚进 − 消耗 < 0` 恒成立，
  // 所以这个数字是**读数**不是独立判据；真正的判据是上面的 ④。
  // 它值得报出来，是因为一旦经济开始透支（单位期望 ≥ 1），局就永远不会结束，
  // 下面的 ⑤ 会立刻红——这才是这条验收真正在保护的东西。
  const earnedPerSpent = spentTotal > 0 ? earnedTotal / spentTotal : Number.POSITIVE_INFINITY;
  const netPerRun = (earnedTotal - spentTotal) / Math.max(1, runs.length);
  console.log(
    `  实测读数：赚进 ${earnedTotal} / 消耗 ${spentTotal} = ${earnedPerSpent.toFixed(3)}；` +
      `单局净流出 ${(-netPerRun).toFixed(1)} 筹码 → 200 局 ${(-netPerRun * 200).toFixed(0)} 筹码`,
  );
  check(
    '⑤ 每局都走到真实终态（经济若透支，局永远不会结束）',
    // 终态只要求「停下来了」+「手里基本没筹码」。**不能要求筹码恰好为 0**：
    // 收尾走完、破产窗弹出之后，仍可能有一枚在途币越线返值——那是被**记进账本**的
    // 迟到返值（见 `RunState.gainChips` 的说明），不是漏记。
    // 满盘之后收尾期越线更频繁，这条从「偶尔」变成了常态（实测出现过「破产窗 + 剩 1 筹码」）。
    runs.every(
      (run) =>
        run.end !== 'timeout' &&
        (run.end === 'settled' || (run.chips >= 0 && run.chips < (run.buyIn ?? 0))),
    ),
    runs.map((run) => `${run.end}/剩 ${run.chips} 筹码`).join('，'),
  );

  // 局的长度是经济标定的**可观察后果**：回收率太高一局会拖到十几分钟，
  // 太低则几投就破产。这条断言把「标定漂了」变成红灯，而不是靠人肉感觉。
  //
  // **判据是「标定没有整体漂掉」，不是「每局都落在设计目标 60~90 投内」。**
  // 单局方差实测很大：同一组常量（`bronzePayoutChance` 0.18）下量到
  // 48 / 53 / 56 / 71 / 74 投，越线/投币 1.02 ~ 1.37。要求每一局都进 60~90
  // 等于让断言赌运气（§6.7 的老教训），而且两局的小样本本来就定不了均值。
  // 所以：硬判据只守「不崩溃」的两端；设计目标改成看**均值**、且先作读数报出，
  // 均值的定案由 P8 用 `ECON_RUNS=200` 跑多局来做。
  const dropCounts = runs.map((run) => run.drops);
  const meanDrops = dropCounts.reduce((sum, count) => sum + count, 0) / Math.max(1, dropCounts.length);
  const DESIGN_LENGTH = [60, 90];
  const meanInDesign = meanDrops >= DESIGN_LENGTH[0] && meanDrops <= DESIGN_LENGTH[1];
  check(
    '⑥ 单局长度不崩溃（35~220 投；设计目标 60~90 只看均值）',
    dropCounts.every((count) => count >= 35 && count <= 220),
    `各局投币数 ${dropCounts.join('/')}，均值 ${meanDrops.toFixed(1)} 投` +
      `（设计目标 ${DESIGN_LENGTH[0]}~${DESIGN_LENGTH[1]}：${meanInDesign ? '均值在带内' : '均值在带外'}），` +
      `越线/投币 ${perDrop.toFixed(3)}`,
  );

  return runs;
}

/**
 * XIXI 集章 + 背板老虎机（P5，替换三路集章）。
 *
 * 判据（PLAN-v4 §5.6）：
 *   A 槽位映射由**枚举引擎的 xixiSlot 函数**收成集合（4 段 × 边界点逐一核对）；
 *   B 物理落点点亮：投币 → 币落床 → 槽亮；**在途（未落床）不登记**；
 *   C 集齐四槽 → 老虎机触发（遥测事件链 completed → spin）；
 *   D 奖励不走 gainChips：力力力只进 boostCharges，earned 不动；
 *   E 加力存满时奖励拒收可对账（granted=false，不加、不吞）。
 */
async function runXixi(page) {
  console.log('\n── 模式：xixi（XIXI 集章与背板老虎机） ──');
  // XIXI 进度跨局持续（存档背书）：先清档，断言从全灭开始。
  // 强制摇奖段用 ready（推板未起、盘面静止）——playing 下推板自动起跑，
  // 满盘自己就会 Cascading 出越线，earned=0 的前提不成立。
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.clearSave?.());
  await startRun(page, 'ready');

  // ── A：槽位映射枚举（边界点逐一核对，集合比对而不是重写公式） ──
  const samples = await page.evaluate(() => {
    const fn = window.__THREE_GAME_TEST_HOOKS__?.xixiSlot;
    if (!fn) return null;
    const xs = [-0.7, -0.68, -0.5, -0.34, -0.2, 0, 0.1, 0.34, 0.5, 0.68, 0.7];
    return xs.map((x) => [x, fn(x)]);
  });
  const expectMap = {
    '-0.7': -1, '-0.68': 0, '-0.5': 0, '-0.34': 1, '-0.2': 1,
    0: 2, 0.1: 2, 0.34: 3, 0.5: 3, 0.68: 3, 0.7: -1,
  };
  const mismatches = (samples ?? []).filter(([x, slot]) => expectMap[String(x)] !== slot);
  check(
    '槽位映射枚举：4 段 × 边界点逐一核对',
    (samples ?? []).length === 11 && mismatches.length === 0,
    `样本 ${JSON.stringify(samples)}，不符 ${JSON.stringify(mismatches)}`,
  );

  // ── D/E：先做强制摇奖（此时一币未投，earned 必须一直是 0） ──
  const spinAndWaitReward = async (symbol) => {
    const before = ((await readTelemetry(page))?.xixiEvents ?? []).filter((e) => e.phase === 'reward').length;
    // 老虎机正在转时 spin 返回 null：上一场收尾前重试，不硬抢。
    let spun = null;
    const deadline = Date.now() + 5000;
    while (!spun && Date.now() < deadline) {
      spun = await page.evaluate((s) => window.__THREE_GAME_TEST_HOOKS__?.xixiSpin?.(s), symbol);
      if (!spun) await page.waitForTimeout(200);
    }
    if (!spun) return null;
    const telemetry = await waitForTelemetry(
      page,
      (t) => (t?.xixiEvents ?? []).filter((e) => e.phase === 'reward').length > before,
      12_000,
    );
    return (telemetry?.xixiEvents ?? []).filter((e) => e.phase === 'reward').at(-1) ?? null;
  };

  const boostReward = await spinAndWaitReward('boost');
  const afterBoost = await readStateFresh(page);
  check(
    '力力力：加力入账且 earned 不动（奖励不走 gainChips）',
    boostReward?.granted === true && afterBoost?.boostCharges === 1 && afterBoost?.earned === 0,
    `granted=${boostReward?.granted} boost=${afterBoost?.boostCharges} earned=${afterBoost?.earned}`,
  );

  const cappedReward = await spinAndWaitReward('boost');
  const afterCap = await readStateFresh(page);
  check(
    '加力存满时奖励拒收可对账（granted=false）',
    cappedReward?.granted === false && afterCap?.boostCharges === 1,
    `granted=${cappedReward?.granted} boost=${afterCap?.boostCharges}`,
  );

  const towerReward = await spinAndWaitReward('tower');
  const showEventsAfterTower = (await readTelemetry(page))?.showEvents ?? [];
  const towerRegistered = showEventsAfterTower.find((e) => e.id === 'tower' && e.phase === 'registered');
  check(
    '塔塔塔：ShowDirector 登记塔装置（承诺 1 枚）',
    towerReward?.granted === true && towerReward?.delivered === 1 && Boolean(towerRegistered),
    `granted=${towerReward?.granted} delivered=${towerReward?.delivered} 登记=${JSON.stringify(towerRegistered)}`,
  );
  // 「奖励不走 gainChips」由力力力判据钉死；塔交付带出的 Cascading 越线是合法结算，
  // 不是奖励入账——这里不再重复断言 earned。
  // 等塔演完再继续：演出队列一次一场，别让交付与后面的集章搅在一起。
  await waitForTelemetry(
    page,
    (t) => (t?.showEvents ?? []).some((e) => e.id === 'tower' && e.phase === 'completed'),
    20_000,
  );

  // ── B/C 换 playing：推板起跑，开始投币集章 ──
  await startRun(page, 'playing');

  // ── B：在途币不登记（未落床不点亮） ──
  const xixiBefore = JSON.stringify((await readStateFresh(page))?.xixi ?? []);
  const accepted = await dropUntilAccepted(page, -0.45);
  const inFlight = await readState(page);
  check(
    '在途币不登记（未落床不点亮）',
    accepted && JSON.stringify(inFlight?.xixi ?? []) === xixiBefore,
    `在途 xixi=${JSON.stringify(inFlight?.xixi)}（投出前 ${xixiBefore}）`,
  );

  // ── C：物理落点点亮并集齐（分散投币直到 completed 事件） ──
  const lanes = [-0.85, -0.45, 0, 0.45, 0.85, -0.6, 0.6, -0.2, 0.2, -0.7, 0.7, 0.3];
  let completedEvent = null;
  for (let round = 0; round < 5 && !completedEvent; round += 1) {
    for (const lane of lanes) {
      await dropUntilAccepted(page, lane, 4000);
      const telemetry = await readTelemetry(page);
      completedEvent = (telemetry?.xixiEvents ?? []).find((e) => e.phase === 'completed') ?? null;
      if (completedEvent) break;
      await page.waitForTimeout(500);
    }
  }
  check(
    '物理落点点亮并集齐四槽（completed 事件）',
    Boolean(completedEvent),
    `completed=${JSON.stringify(completedEvent)}，xixi=${JSON.stringify((await readStateFresh(page))?.xixi)}`,
  );

  const spinSeen = await waitForTelemetry(
    page,
    (t) => (t?.xixiEvents ?? []).some((e) => e.phase === 'spin'),
    15_000,
  );
  check(
    '集齐 → 老虎机触发（spin 事件，不靠定时采样）',
    Boolean(spinSeen?.xixiEvents?.some((e) => e.phase === 'spin')),
    `事件链 ${JSON.stringify((spinSeen?.xixiEvents ?? []).map((e) => e.phase))}`,
  );

  const finalState = await readStateFresh(page);
  check('XIXI 全程三账本恒等式成立', ledgerOk(finalState), ledgerText(finalState));
  check('XIXI 全程无异常', finalState?.anomalies === 0, `anomalies=${finalState?.anomalies}`);
}

/** 截图：桌面与手机两种视窗，用于人工核对画面。 */
async function runShots(page, context) {
  const outDir = process.env.SHOT_DIR ?? 'shots';
  const fs = await import('node:fs/promises');
  await fs.mkdir(outDir, { recursive: true });

  const shots = [
    { name: 'endless-ready', state: 'ready' },
    { name: 'endless-ruin', state: 'ruin' },
  ];

  for (const shot of shots) {
    await startRun(page, shot.state);
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${outDir}/${shot.name}.png` });
    console.log(`  已保存 ${outDir}/${shot.name}.png`);
  }

  // 投币后的推板中段状态：能看到币在台面上和币床上。
  await startRun(page, 'playing');
  const lanes = [-0.85, -0.45, 0, 0.45, 0.85];
  await primeFirstDrop(page, lanes[0]);
  let lastCycle = (await readState(page))?.pusher.cycles ?? 0;
  for (let index = 1; index < 10; index += 1) {
    const advanced = await waitFor(page, (state) => (state?.pusher.cycles ?? 0) > lastCycle, 20_000);
    if (!advanced) break;
    lastCycle = advanced.pusher.cycles;
    await dropUntilAccepted(page, lanes[index % lanes.length]);
  }
  await page.screenshot({ path: `${outDir}/endless-playing.png` });
  console.log(`  已保存 ${outDir}/endless-playing.png`);

  // 图鉴面板：清档后用一个 0 成本解锁让面板里有已解锁项可看（截图专用，不写死定价）。
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.clearSave?.());
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.unlockSkin?.('coin', 'celadon', 0));
  await page.locator('#collection-button').click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${outDir}/collection-panel.png` });
  console.log(`  已保存 ${outDir}/collection-panel.png`);
  await page.locator('#collection-close').click();

  // 换装后的机台画面
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.selectSkin?.('coin', 'celadon'));
  await startRun(page, 'ready');
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${outDir}/skinned-endless.png` });
  console.log(`  已保存 ${outDir}/skinned-endless.png`);

  // 手机竖屏视窗
  const mobile = await context.browser().newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  const mobilePage = await mobile.newPage();
  await mobilePage.goto(BASE, { waitUntil: 'domcontentloaded' });
  await mobilePage.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 20, null, {
    timeout: 20_000,
  });
  await mobilePage.screenshot({ path: `${outDir}/mobile-390x844.png` });
  console.log(`  已保存 ${outDir}/mobile-390x844.png`);
  await mobile.close();

  check('截图已生成', true, outDir);
}

/**
 * 帧率与画质分档。
 *
 * 无头 Chromium 会顶在 60 FPS 上限，直接测不出余量；
 * 用 CDP 的 CPU 降速模拟低端设备，才能真正看出分档有没有用。
 */
async function runPerf(page, context) {
  console.log('\n── 模式：perf（帧率与画质分档，含 CPU 降速） ──');
  const client = await context.newCDPSession(page);

  await startRun(page, 'playing');
  const lanes = [-0.85, -0.45, 0, 0.45, 0.85];
  await primeFirstDrop(page, lanes[0]);
  let lastCycle = (await readState(page))?.pusher.cycles ?? 0;
  for (let index = 1; index < 14; index += 1) {
    const advanced = await waitFor(page, (state) => (state?.pusher.cycles ?? 0) > lastCycle, 20_000);
    if (!advanced) break;
    lastCycle = advanced.pusher.cycles;
    await dropUntilAccepted(page, lanes[index % lanes.length]);
  }

  // 测量期间冻结模拟：否则币会继续越线，盘面币数一直在变，测出来的不是同一负载。
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setPausedForScreenshot?.(true));

  const throttles = (process.env.THROTTLE ?? '1,4,6').split(',').map(Number);
  const rows = [];

  for (const rate of throttles) {
    await client.send('Emulation.setCPUThrottlingRate', { rate });
    for (const tier of ['high', 'medium', 'low']) {
      await page.evaluate((value) => window.__THREE_GAME_TEST_HOOKS__?.setQuality?.(value), tier);
      // 至少等两个采样窗口，帧率才稳定。
      await page.waitForTimeout(2600);
      const state = await readState(page);
      const row = {
        rate,
        tier,
        fps: state?.performance.fps ?? 0,
        dpr: state?.performance.maxDpr ?? 0,
        shadows: state?.performance.shadows ?? false,
        coins: state?.activeCoins ?? 0,
        calls: state?.renderer.calls ?? 0,
        triangles: state?.renderer.triangles ?? 0,
      };
      rows.push(row);
      console.log(
        `  CPU ×${String(rate).padStart(2)}  ${tier.padStart(6)} 档：${row.fps.toFixed(1)} FPS，` +
          `DPR ${row.dpr}，阴影 ${row.shadows ? '开' : '关'}，draw call ${row.calls}，三角形 ${row.triangles}`,
      );
    }
  }

  await client.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setPausedForScreenshot?.(false));

  const coinCounts = new Set(rows.map((row) => row.coins));
  check('画质分档不改盘面币数', coinCounts.size === 1, `币数集合 ${[...coinCounts].join('/')}`);

  const base = rows.find((row) => row.rate === 1 && row.tier === 'high');
  check('无降速时高档跑满（>50 FPS）', (base?.fps ?? 0) > 50, `fps=${base?.fps?.toFixed(1)}`);

  const worst = rows.reduce((min, row) => (row.fps < min.fps ? row : min), rows[0]);
  check(
    '最差组合仍在可玩区间（>25 FPS）',
    worst.fps > 25,
    `CPU ×${worst.rate} ${worst.tier} 档 ${worst.fps.toFixed(1)} FPS`,
  );

  // P3 渲染改造验收：币全部实例化之后 drawcall 必须有硬上限，
  // 防止以后谁把逐枚 Mesh 或别的逐实体绘制悄悄加回来（改前基线 365）。
  const maxCalls = Math.max(...rows.map((row) => row.calls));
  check(
    'draw call 硬上限（P3 实例化验收，< 50）',
    maxCalls > 0 && maxCalls < 50,
    `峰值 draw call ${maxCalls}`,
  );

  // 结论取决于瓶颈在哪：如果 CPU 降速 6 倍仍不掉帧，说明瓶颈不在 CPU，
  // 分档对这个内容规模是冗余的保险，真正的限制会在低端机的 GPU 填充率上。
  const maxRate = Math.max(...throttles);
  const throttledHigh = rows.find((row) => row.rate === maxRate && row.tier === 'high');
  const cpuBound = (throttledHigh?.fps ?? 0) < (base?.fps ?? 0) - 5;
  check(
    cpuBound ? 'CPU 降速后帧率下降，分档有意义' : 'CPU 降速 6 倍仍跑满，瓶颈不在 CPU',
    cpuBound ? (throttledHigh?.fps ?? 0) > 25 : (throttledHigh?.fps ?? 0) > 50,
    `CPU ×${maxRate} 高档 ${throttledHigh?.fps?.toFixed(1)} FPS（基准 ${base?.fps?.toFixed(1)}）`,
  );

  return rows;
}

/**
 * 投放演出（P4 ShowDirector）。
 *
 * 判据（PLAN-v4 §4.5）：
 *   A 三装置的币**全是真币**：注入前后活跃币数差 = 承诺数（即「逐枚可查」的操作化）；
 *   B 两态事件：registered（币尚未动）→ completed（币已到位、实发数可对账）；
 *   C 预算语义：余量不足 → 降级交付（按实有承诺）；彻底不够 → 明确拒绝（非静默）；
 *   D 演出期间三账本恒等式抽查成立。
 */
async function runShow(page) {
  console.log('\n── 模式：show（投放演出） ──');
  await startRun(page, 'ready');

  const completedCount = (events) => (events ?? []).filter((event) => event.phase === 'completed').length;
  const waitNextCompleted = async (before2) => {
    const telemetry = await waitForTelemetry(
      page,
      (t) => completedCount(t?.showEvents) > before2,
      20_000,
    );
    const events = telemetry?.showEvents ?? [];
    return events.filter((event) => event.phase === 'completed').at(-1) ?? null;
  };

  // ── A/B：币塔真币交付 + 两态事件 ──
  const before = await readStateFresh(page);
  // 注入的币只有两条去路：留在盘面（active）或合法越线结算（scoreEvents）。
  // 「逐枚可查」的正确算式是 活跃差 + 结算差 = 承诺数——只断活跃差会被
  // 满盘 Cascading 的合法结算坑成假红（实测塔/喷泉各带出 2 枚越线）。
  const scoreBefore = (await readTelemetry(page))?.scoreEvents?.length ?? 0;
  const result = await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.showRequest?.('tower'));
  check(
    '币塔请求被接受（默认 1 枚——免费币预算红线）',
    result?.ok === true && result?.promised === 1 && result?.downgraded === false,
    `返回 ${JSON.stringify(result)}`,
  );

  // 两态之「登记」：请求刚落、第一层币还没发（圆柱升起要 0.6 秒）——盘面币数必须没变。
  // 诊断快照逐帧发布，等一帧再读（readStateFresh），否则读到的是请求前的旧帧。
  const registeredState = await readStateFresh(page);
  check(
    '两态之「登记」：演出已登记、盘面币数尚未变',
    registeredState?.shows?.busy === true && registeredState?.activeCoins === before?.activeCoins,
    `busy=${registeredState?.shows?.busy}，币 ${registeredState?.activeCoins}（请求前 ${before?.activeCoins}）`,
  );

  const towerDone = await waitNextCompleted(0);
  const afterTower = await readStateFresh(page);
  const scoreDelta = ((await readTelemetry(page))?.scoreEvents?.length ?? 0) - scoreBefore;
  const activeDelta = (afterTower?.activeCoins ?? 0) - (before?.activeCoins ?? 0);
  check(
    '两态之「完成」：实发 = 承诺，活跃差 + 结算差 = 承诺数',
    towerDone?.spawned === 1 && activeDelta + scoreDelta === 1,
    `事件 spawned=${towerDone?.spawned}，活跃差 ${activeDelta} + 结算差 ${scoreDelta}（应 = 1）`,
  );

  // ── D：演出交付后账本恒等抽查 ──
  check('演出交付后三账本恒等式成立', ledgerOk(afterTower), ledgerText(afterTower));

  // ── A 覆盖三装置：喷泉与闸门同样全真币交付 ──
  for (const [id, expected, label] of [
    ['fountain', 1, '喷泉'],
    ['gate', 7, '闸门落币'],
  ]) {
    const pre = await readStateFresh(page);
    const telemetryBefore = await readTelemetry(page);
    const doneCount = completedCount(telemetryBefore?.showEvents);
    const scorePre = telemetryBefore?.scoreEvents?.length ?? 0;
    await page.evaluate((showId) => window.__THREE_GAME_TEST_HOOKS__?.showRequest?.(showId), id);
    const done = await waitNextCompleted(doneCount);
    const post = await readStateFresh(page);
    const scorePost = ((await readTelemetry(page))?.scoreEvents?.length ?? 0) - scorePre;
    const activePost = (post?.activeCoins ?? 0) - (pre?.activeCoins ?? 0);
    check(
      `${label}真币交付：实发 ${expected}，活跃差 + 结算差 = 承诺数`,
      done?.spawned === expected && activePost + scorePost === expected,
      `事件 spawned=${done?.spawned}，活跃差 ${activePost} + 结算差 ${scorePost}（应 = ${expected}）`,
    );
  }

  // ── C：预算语义。连续请求把池子压到「不够一整场」的边缘：
  //     沿途必须出现一次**降级**（余量够最低交付但不够全额），
  //     池底时必须是**明确拒绝**（有原因、有 refused 事件、币数不变）。
  //
  // 用**闸门**（count 7 / min 3）做这段：塔/泉的量级被免费币预算红线压到 1 枚之后
  // 已经没有降级窗口（count 必须 > min），而预算逻辑是全装置共用的；
  // 闸门不参与老虎机奖励表，拿它验降级不会污染经济。
  //
  // 落点必须确定：ready 状态没有 churn，填充是**纯步进算术**——只按整场（7 枚）榨，
  // 落点 = 起始余量 mod 7，余数 0/1/2 的局次会直接跨过 {3..6} 窗口（实测红过）。
  // 所以余量 ≤ 8 时改用 **2 枚步进**收尾：8→6、7→5 都落进窗口，不赌起始余量。
  let downgradedSeen = null;
  let refused = null;
  const spots = [-0.45, -0.15, 0.15, 0.45];
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const state = await readStateFresh(page);
    const remaining = state?.mechanisms?.coinsRemaining ?? 0;
    if (remaining < 3) {
      const coinsAtRefuse = state?.activeCoins ?? 0;
      refused = await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.showRequest?.('gate'));
      const afterRefuse = await readStateFresh(page);
      const events = (await readTelemetry(page))?.showEvents ?? [];
      const refusedEvent = events.findLast((event) => event.id === 'gate' && event.phase === 'refused');
      check(
        '预算打满后请求 = 明确拒绝（有原因、有事件、盘面不变）',
        refused?.ok === false &&
          typeof refused?.reason === 'string' &&
          refused.reason.length > 0 &&
          Boolean(refusedEvent) &&
          (afterRefuse?.activeCoins ?? 0) === coinsAtRefuse,
        `返回 ${JSON.stringify(refused)}，事件 ${JSON.stringify(refusedEvent)}`,
      );
      break;
    }
    // 余量 > 8 按整场（7 枚）榨；7~8 用 2 枚步进落进窗口；3~6 默认请求必然降级。
    // 探针式的小请求交付数 = 请求数，不产生 downgraded，不污染判据。
    const requestOpts = remaining > 8 || remaining <= 6 ? { x: spots[attempt % spots.length] } : { count: 2 };
    const doneCount = completedCount((await readTelemetry(page))?.showEvents);
    const response = await page.evaluate(
      (opts) => window.__THREE_GAME_TEST_HOOKS__?.showRequest?.('gate', opts),
      requestOpts,
    );
    if (response?.ok && response.downgraded && !downgradedSeen) {
      downgradedSeen = { promised: response.promised, remainingBefore: remaining };
    }
    await waitNextCompleted(doneCount);
  }
  check(
    '余量不足时降级交付（按实有承诺，不静默少发）',
    Boolean(downgradedSeen) && downgradedSeen.promised < 7 && downgradedSeen.promised >= 3,
    `降级记录 ${JSON.stringify(downgradedSeen)}`,
  );
  check('预算耗尽路径走完（拒绝已发生）', Boolean(refused), '见上一条判据');
}

/**
 * 验收清单里可自动化的部分。
 *
 * 编号沿用规划文档的清单；⑬（前三关不含返币）与 ⑯（目标进度条）随战役模式一起摘除，
 * 不再有对应实现，因此这里也不再检查。
 */
async function runAcceptance(page, context) {
  console.log('\n── 模式：accept（验收清单自动化部分） ──');

  // 打开遥测：关键因果由模拟内部记录，比外部按帧采样可靠。
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.enableTelemetry?.());

  // 0. 钉阵：显示长度砍到 1/3，碰撞体保持全长（只改显示，不改物理判定）
  const pegDiag = (await readStateFresh(page))?.pegs;
  const pegProbe = await page.evaluate(
    () => window.__THREE_GAME_TEST_HOOKS__?.probeColliders?.(0, 1.16, -0.72) ?? [],
  );
  const pegColliderHalves = [
    ...new Set(pegProbe.filter((entry) => entry.cylinder).map((entry) => entry.cylinder.halfHeight)),
  ];
  check(
    '⓪ 钉阵显示长度 = 碰撞体的 1/3，碰撞体仍是全长',
    pegDiag?.count === 22 &&
      Math.abs((pegDiag?.visualHalfLength ?? 0) - 0.05) < 1e-6 &&
      Math.abs((pegDiag?.colliderHalfLength ?? 0) - 0.15) < 1e-6 &&
      pegColliderHalves.length === 1 &&
      Math.abs(pegColliderHalves[0] - 0.15) < 1e-6,
    `钉子 ${pegDiag?.count} 根，网格半长 ${pegDiag?.visualHalfLength} 米，` +
      `碰撞体半长 ${pegColliderHalves.join('/')} 米`,
  );

  // 1. 玩家第一次进入即可找到筹码余量与投币按钮（目标分已随战役摘除）
  await startRun(page, 'ready');
  const hud = await page.evaluate(() => {
    const pick = (selector) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const box = element.getBoundingClientRect();
      return { text: element.textContent?.trim() ?? '', width: box.width, height: box.height };
    };
    return {
      credits: pick('#credits-value'),
      drop: pick('#drop-button'),
      bet: pick('#bet-button'),
    };
  });
  check(
    '① 首屏可见筹码余量/投币按钮/加注按钮',
    (hud.credits?.width ?? 0) > 0 && (hud.drop?.width ?? 0) > 0 && (hud.bet?.width ?? 0) > 0,
    `筹码 ${hud.credits?.text}，加注 ${hud.bet?.text}`,
  );

  // 2. 一次有效投币只减 1、只生成 1 枚；冷却中的输入不扣筹码
  const before = await readStateFresh(page);
  const first = await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.drop?.(0) ?? false);
  const second = await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.drop?.(0.5) ?? false);
  const after = await readStateFresh(page);
  check(
    '② 一次投币只减 1 枚筹码、只生成 1 枚；冷却中不扣筹码',
    first === true &&
      second === false &&
      after?.chips === before.chips - 1 &&
      after?.activeCoins === before.activeCoins + 1,
    `筹码 ${before.chips}→${after?.chips}，币 ${before.activeCoins}→${after?.activeCoins}`,
  );

  // 3. 左中右选位产生可观察的落点差异
  const laneXs = [];
  for (const lane of [-0.85, 0.85]) {
    await startRun(page, 'ready');
    await dropUntilAccepted(page, lane);
    await page.waitForTimeout(2200);
    const coin = await playerCoin(page);
    laneXs.push(coin?.x ?? 0);
  }
  check(
    '③ 左右选位产生可观察的落点差异',
    Math.abs(laneXs[0] - laneXs[1]) > 0.6,
    `左落点 x=${laneXs[0].toFixed(3)}，右落点 x=${laneXs[1].toFixed(3)}`,
  );

  // 5. 币的路径连续、可解释，没有瞬移
  await startRun(page, 'ready');
  await dropUntilAccepted(page, 0);
  let previous = null;
  let maxJump = 0;
  for (let step = 0; step < 40; step += 1) {
    await page.waitForTimeout(200);
    const coin = await playerCoin(page);
    if (!coin) break;
    if (previous) {
      maxJump = Math.max(maxJump, Math.hypot(coin.x - previous.x, coin.y - previous.y, coin.z - previous.z));
    }
    previous = coin;
  }
  check('⑤ 落币路径连续，无位置瞬移', maxJump < 0.6, `单次采样最大位移 ${maxJump.toFixed(3)} 米`);

  // 6. 预置币不充能（预置币不是玩家投的，没资格点亮 XIXI）
  //
  // 注意 XIXI 是**跨局持续**的收集进度（存档背书，accept 前面的步骤投过币），
  // 所以判据断的是「静置期间没有**新增**点亮」，不是「四槽全灭」。
  await startRun(page, 'ready');
  const xixiBeforeIdle = (await readStateFresh(page))?.xixi ?? [];
  await page.waitForTimeout(5000);
  const idle = await readState(page);
  check(
    '⑥ 预置币不点亮 XIXI（满盘空转期间没有新增点亮）',
    JSON.stringify(idle?.xixi ?? []) === JSON.stringify(xixiBeforeIdle) && (idle?.boostCharges ?? 0) === 0,
    `xixi ${JSON.stringify(xixiBeforeIdle)} → ${JSON.stringify(idle?.xixi)}`,
  );

  // 7. 没有充能时加力必须拒绝，而不是空转
  await startRun(page, 'ready');
  const boostIdle = await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.boost?.() ?? false);
  check('⑦ 无充能时加力不生效', boostIdle === false);

  // 11. 暂停不推进推板循环与耗时
  await startRun(page, 'playing');
  await dropUntilAccepted(page, 0);
  await waitFor(page, (state) => (state?.pusher.cycles ?? 0) >= 1, 20_000);
  const beforePause = await readState(page);
  await page.locator('#pause-button').click();
  await page.waitForTimeout(3200);
  const duringPause = await readState(page);
  await page.locator('#pause-button').click();
  check(
    '⑪ 暂停期间推板循环与耗时都不推进',
    duringPause?.pusher.cycles === beforePause?.pusher.cycles &&
      Math.abs((duringPause?.elapsed ?? 0) - (beforePause?.elapsed ?? 0)) < 0.2,
    `循环 ${beforePause?.pusher.cycles}→${duringPause?.pusher.cycles}，` +
      `耗时 ${beforePause?.elapsed?.toFixed(2)}→${duringPause?.elapsed?.toFixed(2)}`,
  );

  // 14. 手机视窗下操作区不被遮挡
  const mobile = await context.browser().newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  const mobilePage = await mobile.newPage();
  await mobilePage.goto(BASE, { waitUntil: 'domcontentloaded' });
  await mobilePage.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 20, null, {
    timeout: 20_000,
  });
  const layout = await mobilePage.evaluate(() => {
    const rect = (selector) => {
      const element = document.querySelector(selector);
      return element ? element.getBoundingClientRect().toJSON() : null;
    };
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      drop: rect('#drop-button'),
      boost: rect('#boost-button'),
      credits: rect('#resource-readout'),
      bet: rect('#bet-button'),
    };
  });
  const inside = (box) =>
    box !== null &&
    box.top >= 0 &&
    box.left >= 0 &&
    box.bottom <= layout.viewport.height + 1 &&
    box.right <= layout.viewport.width + 1;
  const visible = (box) => box !== null && box.width > 0 && box.height > 0;
  check(
    '⑭ 390×844 下投币/资源/加注都在视窗内，加力未充能时隐藏',
    inside(layout.drop) &&
      inside(layout.credits) &&
      inside(layout.bet) &&
      (!visible(layout.boost) || inside(layout.boost)),
    `视窗 ${layout.viewport.width}×${layout.viewport.height}，` +
      `加力${visible(layout.boost) ? '可见' : '隐藏（未充能）'}`,
  );
  await mobile.close();

  // 4. 不同推板时机有真实推进差异
  await guarded('④ 推板时机检查', () => runTimingCheck(page));

  // 8. 只有币真的越过前沿才计分
  await guarded('⑧ 计分完整性检查', () => runScoreIntegrityCheck(page));

  // 9. 返币筹码：分数与返币同帧到账
  await guarded('⑨ 返币筹码检查', () => runPayoutCheck(page));

  // 10. 最后一投后仍能拿到迟到得分
  await guarded('⑩ 迟到得分检查', () => runLateScoreCheck(page));
}

/**
 * ④ 不同推板时机有真实推进差异，不以隐藏评分制造差异。
 *
 * 直接验证物理因果：币离开上层台面的那一刻，位置必须贴合推板前缘
 * （z ≈ 推币面 z），而不是被传送到某个「应该落在这里」的点。
 * 同时要求多次投币确实发生在不同的推板位置，落点因此不同。
 */
async function runTimingCheck(page) {
  await startRun(page, 'playing');
  const lanes = [-0.8, -0.4, 0, 0.4, 0.8];
  await primeFirstDrop(page, lanes[0]);
  await waitFor(page, (state) => (state?.pusher.cycles ?? 0) >= 1, 25_000);

  for (let index = 1; index <= 5; index += 1) {
    await dropUntilAccepted(page, lanes[index % lanes.length]);
    await waitFor(page, (state) => (state?.pusher.cycles ?? 0) >= index + 1, 25_000);
  }

  const { fallOffEvents } = await readTelemetry(page);
  const gaps = fallOffEvents.map((event) => Math.abs(event.z - event.frontFaceZ));
  const worstGap = gaps.length > 0 ? Math.max(...gaps) : 99;
  const faces = fallOffEvents.map((event) => event.frontFaceZ);
  const spread = faces.length > 1 ? Math.max(...faces) - Math.min(...faces) : 0;

  check(
    '④ 币离开台面的位置贴合推板前缘（无隐藏落点）',
    fallOffEvents.length >= 2 && worstGap < 0.3,
    `${fallOffEvents.length} 次离台，最大偏差 ${worstGap.toFixed(3)} 米`,
  );
  check('④ 不同推板时机的落点确实不同', spread > 0.3, `推币面 z 跨度 ${spread.toFixed(3)} 米`);
}

/**
 * ⑧ 只有币真正越过前沿才返值。
 *
 * 遥测记录每一次入账的瞬时位置：只要每一次入账的 z 都越过了结算线，
 * 就等于证明「塔倒、悬边、堆叠都不返值」——那些情况根本没有入账事件。
 */
async function runScoreIntegrityCheck(page) {
  await startRun(page, 'playing');
  const table = await readTable(page);
  const lanes = [-0.85, -0.45, 0, 0.45, 0.85];
  await primeFirstDrop(page, lanes[0]);

  let towerCollapsed = false;
  let previousTower = 0;
  const initialTower = (await readCoins(page)).filter((coin) => coin.y > 0.04).length;

  for (let index = 1; index <= 34; index += 1) {
    await page.waitForTimeout(260);
    const state = await readState(page);
    const list = await readCoins(page);
    const towerNow = list.filter((coin) => coin.y > 0.04).length;
    if (previousTower > 0 && towerNow < previousTower) towerCollapsed = true;
    previousTower = towerNow;

    if (index % 4 === 0) await dropUntilAccepted(page, lanes[(index / 4) % lanes.length]);
    if (state?.endless?.ruinVisible === true || state?.phase === 'settled') break;
  }

  await waitForRunEnd(page, 150_000);
  const final = await readState(page);
  const { scoreEvents } = await readTelemetry(page);

  // round3 会把 1.1502 记成 1.15，判定留 5 毫米容差。
  const belowLine = scoreEvents.filter((event) => event.z < 1.145);
  const summed = scoreEvents.reduce((sum, event) => sum + event.value, 0);

  check(
    '⑧ 每次入账的币都真的越过了结算线',
    scoreEvents.length > 0 && belowLine.length === 0,
    `${scoreEvents.length} 次入账，未越线 ${belowLine.length} 次`,
  );
  check(
    '⑧ 入账逐枚可核对，且无币在远处消失',
    summed === (final?.earned ?? -1) && (final?.anomalies ?? 1) === 0,
    `逐枚合计 ${summed} 筹码，实际赚进 ${final?.earned} 筹码，异常 ${final?.anomalies}`,
  );
  check('⑧ 币塔在推板作用下确实会倒', towerCollapsed, `塔顶币数由 ${initialTower} 开始下降`);
  // 「塔倒本身不返值」等价于「没有任何入账事件来自未越线的币」——
  // 塔倒、悬边、堆叠都不会产生入账事件，所以上面两条断言已经覆盖。
  // 这里额外核对入账事件的枚数不超过盘面币总数，防止凭空入账。
  check(
    '⑧ 入账事件数不超过盘面币总数，无凭空入账',
    scoreEvents.length <= (table?.coins ?? 0) + 8 && summed === (final?.earned ?? -1),
    `${scoreEvents.length} 次入账事件（盘面 ${table?.coins} 枚 + 注入），逐枚合计 ${summed} 筹码`,
  );
  check('⑧ 整局结束时账本平', ledgerOk(final), ledgerText(final));
}

/**
 * ⑨ 绿色返币筹码：入账与返币同帧到账。
 *
 * v3 的返币不再有「每关上限 3 次」——它是无尽唯一的常规返还通道，
 * 所以这里只核对「同帧 + 固定返还 3 筹码」这一条契约。
 *
 * 返币是**固定值**，刻意不吃热度/热区/加注任何倍率：一旦被放大，
 * 它就会变成比铜币更划算的刷筹码通道，负期望立刻失效。
 */
async function runPayoutCheck(page) {
  const hooks = (fn, ...args) => page.evaluate(fn, ...args);
  // **先复位钱包**：accept 前面的检查每个都要 `startRun`（开局从钱包扣 20），
  // 跑到这里钱包已经见底 → `buyIn` 变 0 → 一枚币都投不出去 → 0 次越线 → 自然 0 次返币。
  // 这条曾经表现为「返币从来没发生过」，其实是**这条检查自己没币可投**。
  await hooks(() => window.__THREE_GAME_TEST_HOOKS__?.clearSave?.());

  // 返币只占盘面的 4%，而满盘之后一局只越线几十枚——一局里一枚返币都不露面是完全可能的。
  // 所以**跨局累计**，一旦观察到返币就立刻停（正常情况下第一局就够，布局里那 3 枚
  // 返币钉在最前沿一行，开局几轮就会掉出来）。
  const collected = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await playRun(page);
    collected.push(...(await readTelemetry(page)).scoreEvents);
    if (collected.some((event) => event.kind === 'payout')) break;
  }

  const payoutEvents = collected.filter((event) => event.kind === 'payout');
  const returns = payoutEvents.filter((event) => event.chipsAfter > event.chipsBefore).length;
  const badValue = payoutEvents.filter((event) => event.value !== 3).length;
  const badCredit = payoutEvents.filter(
    (event) => event.chipsAfter !== event.chipsBefore && event.chipsAfter !== event.chipsBefore + 3,
  ).length;

  check(
    '⑨ 绿色筹码固定返 3 筹码（不吃热度/热区/加注倍率）',
    payoutEvents.length > 0 && badValue === 0,
    `${payoutEvents.length} 枚绿色筹码越线，入账 ${[...new Set(payoutEvents.map((e) => e.value))].join('/')}，` +
      `越界值 ${badValue} 枚`,
  );
  check(
    '⑨ 返币与入账同帧到账（同一事件里筹码 +3）',
    badCredit === 0,
    `筹码变化异常 ${badCredit} 次`,
  );
  check(
    '⑨ 返币确实发生过（无尽唯一常规返还通道）',
    returns > 0,
    `实际返币 ${returns} 次`,
  );
}

/**
 * ⑩ 最后一投之后仍能拿到迟到返值，且未处理完不能判负。
 *
 * 场景用「满盘直接进收尾」（drain），并且**主动用扫板制造一次越线**：
 * 停板（扫板的开放条件）→ 扫板把贴线的币推过线 → 收尾期就有了真实返值。
 *
 * 为什么要主动制造：这条断言原来假设「满盘进收尾时，收尾的推板周期里必然有币越线」，
 * 但 P2 把行程从 0.84 缩到 0.30 之后这个假设不成立了——收尾的两个周期里可能一枚都不越线，
 * 于是「迟到返值」变成一条看运气的断言。**需要「某效果必然发生」时，场景必须让它必然发生。**
 *
 * 收尾必须先把在途币走完（drainSettleCycles 个推板周期），
 * 所以「进入收尾」与「结算完成」之间必然有一段真实时间。
 */
async function runLateScoreCheck(page) {
  const hooks = (fn, ...args) => page.evaluate(fn, ...args);
  await startRun(page, 'drain');

  const stopped = await waitFor(page, (state) => state?.plateStopped === true, 60_000);
  const swept =
    stopped?.plateStopped === true
      ? await hooks(() => window.__THREE_GAME_TEST_HOOKS__?.sweep?.() ?? false)
      : false;

  // 等这一轮收尾**走完**（结算记录落盘），而不是等本局结束：
  // 满盘进收尾时盘面会回吐筹码，本局通常会就此继续下去，根本不会结束。
  const settled = await waitForTelemetry(
    page,
    (data) => data?.drain?.startedAt !== null && data?.drain?.settledAt !== null,
    90_000,
  );
  const drain = settled?.drain ?? {
    reason: null,
    startedAt: null,
    settledAt: null,
    earnedAtStart: 0,
    earnedAtSettle: 0,
  };
  const duration = drain.settledAt !== null && drain.startedAt !== null ? drain.settledAt - drain.startedAt : 0;

  check('⑩ 收尾原因只有「筹码耗尽」一条', drain.reason === 'exhausted', `收尾原因「${drain.reason ?? '未知'}」`);
  check(
    '⑩ 进入收尾后仍能获得迟到返值',
    swept === true && drain.earnedAtSettle > drain.earnedAtStart,
    `扫板 ${swept ? '已用' : '没用上'}；收尾时 ${drain.earnedAtStart} 筹码 → 结算 ${drain.earnedAtSettle} 筹码`,
  );
  check('⑩ 收尾不是最后一投当帧立刻判负', duration > 2, `收尾持续 ${duration.toFixed(1)} 秒`);
  const lateFinal = await readState(page);
  check('⑩ 迟到返值全部记进账本', ledgerOk(lateFinal), ledgerText(lateFinal));

  // 17. 动效降级：CSS 与 JS 读同一个信号
  const motionState = await page.evaluate(() => {
    window.__THREE_GAME_TEST_HOOKS__?.setReducedMotion?.(true);
    return {
      attr: document.documentElement.dataset.motion,
      reduced: window.__THREE_GAME_DIAGNOSTICS__?.motion?.reduced,
      source: window.__THREE_GAME_DIAGNOSTICS__?.motion?.source,
    };
  });
  check(
    '⑰ 动效降级由同一信号驱动（html[data-motion]）',
    motionState.attr === 'reduced' && motionState.reduced === true,
    `data-motion=${motionState.attr}，来源 ${motionState.source}`,
  );

  // 已知割裂点（待 P8 处理）：reducedMotion 会跳过 fixedUpdate，
  // 也就是连推板推进与台面输送一起停了——这是「降动效」顺手改了物理。
  await startRun(page, 'ready');
  const cyclesBefore = (await readStateFresh(page))?.pusher.cycles ?? 0;
  await dropUntilAccepted(page, 0);
  const cyclesAfter = await waitFor(page, (state) => (state?.pusher.cycles ?? 0) > cyclesBefore, 20_000);
  console.log(
    `  ℹ 降动效下推板循环 ${cyclesBefore}→${cyclesAfter?.pusher.cycles ?? '无'}：` +
      '（P8 待修：降动效目前会跳过 fixedUpdate，等于改物理）',
  );
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setReducedMotion?.(false));
}

async function runSweep(page) {
  console.log('\n── 模式：sweep（推板行程扫描） ──');
  // 默认只扫两端：每档都要完整玩一局，四档连跑会超出这台环境的单条命令时限。
  // 要扫更多档位就用 SWEEP=0.8,1.0,1.16,1.3 分批跑。
  const travels = (process.env.SWEEP ?? '0.8,1.16').split(',').map(Number);
  const rows = [];

  for (const travel of travels) {
    await startRun(page, 'ready');
    await page.evaluate((value) => window.__THREE_GAME_TEST_HOOKS__?.setTuning?.({ pusherTravel: value }), travel);
    const final = await playRun(page, { drops: 24, waitEnd: false });
    const { cycles } = await readTelemetry(page);
    const pace = coinsPerCycle(cycles);
    rows.push({ travel, earned: final?.earned ?? 0, cycles: cycles.length, ...pace });
    console.log(
      `  行程 ${travel.toFixed(2)} 米：赚进 ${String(final?.earned).padStart(4)}，` +
        `循环 ${String(cycles.length).padStart(3)}，推下 ${String(pace.total).padStart(3)} 枚，` +
        `效率 ${pace.average.toFixed(3)} 枚/循环，最长空档 ${pace.longestGap}，异常 ${final?.anomalies}`,
    );
  }

  const best = rows.reduce((a, b) => (b.average > a.average ? b : a), rows[0]);
  console.log(`  最高推进效率：行程 ${best.travel}，${best.average.toFixed(3)} 枚/循环`);
  // 行程是整台机最关键的数值：太短推币面够不到币堆深处（憋死），
  // 太长会一次行程推光整堆（失去手感）。这里只做区间判据，具体选型看 pace 模式。
  const viable = rows.filter((row) => row.average >= 0.2 && row.average <= 8);
  check('至少一组行程推进效率在可玩区间', viable.length > 0, `可玩行程 ${viable.map((r) => r.travel).join('/') || '无'}`);
  return rows;
}

/**
 * 选位：自动匀速往返 / 手动接管 / 轻点投币。
 *
 * 速度曲线与模式切换都由模拟内部记录（遥测），不靠外部按帧采样——
 * 采样间隔会漏掉「切换当帧」这种瞬时事件。
 */
async function runLane(page) {
  console.log('\n── 模式：lane（自动选位 / 手动接管 / 轻点投币） ──');
  await startRun(page, 'ready');

  const HALF_LANE = 0.68;
  const AUTO_SPEED = 0.62;

  // ── 自动选位：匀速 + 三角波两端折返 ──
  await page.waitForTimeout(4200);
  const autoTelemetry = await readTelemetry(page);
  const samples = autoTelemetry.laneSamples.filter((sample) => sample.mode === 'auto');

  // 折返当帧的净位移会变小（走到端点再折回来），所以匀速只对「两端之外」的采样成立。
  const interiorSpeeds = [];
  const reversals = [];
  let previousDelta = 0;
  let maxStep = 0;
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1];
    const current = samples[index];
    const dt = current.t - previous.t;
    if (dt <= 0) continue;
    const delta = current.x - previous.x;
    const speed = Math.abs(delta) / dt;
    const boundary = Math.max(Math.abs(previous.x), Math.abs(current.x)) >= HALF_LANE - 0.04;
    if (!boundary) {
      interiorSpeeds.push(speed);
      maxStep = Math.max(maxStep, Math.abs(delta));
    }
    if (previousDelta !== 0 && delta !== 0 && Math.sign(delta) !== Math.sign(previousDelta)) {
      reversals.push(current.t);
    }
    if (delta !== 0) previousDelta = delta;
  }
  const speedError = interiorSpeeds.length
    ? Math.max(...interiorSpeeds.map((value) => Math.abs(value - AUTO_SPEED)))
    : Number.POSITIVE_INFINITY;
  check(
    '① 自动选位匀速 0.62 米/秒（两端之外）',
    interiorSpeeds.length > 30 && speedError < 0.02,
    `${interiorSpeeds.length} 段采样，最大偏差 ${speedError.toFixed(4)} 米/秒`,
  );

  const xs = samples.map((sample) => sample.x);
  const minX = xs.length ? Math.min(...xs) : 0;
  const maxX = xs.length ? Math.max(...xs) : 0;
  // 采样点不一定正好落在端点上，容差取「一个采样步长」。
  const reach = HALF_LANE - Math.max(maxStep, 0.01) - 0.002;
  check(
    '② 三角波覆盖左右两端且不越界',
    minX <= -reach && maxX >= reach && maxX <= HALF_LANE + 1e-6 && minX >= -HALF_LANE - 1e-6,
    `x ∈ [${minX.toFixed(3)}, ${maxX.toFixed(3)}]，端点 ${HALF_LANE}`,
  );

  // 折返只影响「含折返的那一帧」：若两端有停留，会出现连续多帧低速。
  const slowIndices = [];
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1];
    const current = samples[index];
    const dt = current.t - previous.t;
    if (dt <= 0) continue;
    if (Math.max(Math.abs(previous.x), Math.abs(current.x)) < HALF_LANE - 0.04) continue;
    if (Math.abs(current.x - previous.x) / dt < AUTO_SPEED * 0.3) slowIndices.push(index);
  }
  const adjacentSlow = slowIndices.some(
    (index, position) => position > 0 && index - slowIndices[position - 1] <= 1,
  );
  check(
    '③ 两端即时折返、无停留',
    reversals.length >= 2 && slowIndices.length <= reversals.length && !adjacentSlow,
    `折返 ${reversals.length} 次，折返帧 ${slowIndices.length} 个，无连续低速帧：${!adjacentSlow}`,
  );

  const halfTrip = reversals.length >= 2 ? reversals[1] - reversals[0] : Number.POSITIVE_INFINITY;
  const roundTrip = halfTrip * 2;
  check('④ 单趟往返 ≤ 6 秒', roundTrip <= 6, `往返 ${roundTrip.toFixed(2)} 秒（预期 4.4 秒）`);

  // ── 手动接管：进入不跳变，松手 2 秒后从当前位置恢复 ──
  const beforeTakeover = await readTelemetry(page);
  const lastAutoX =
    [...beforeTakeover.laneSamples].reverse().find((sample) => sample.mode === 'auto')?.x ?? 0;

  await page.keyboard.down('KeyD');
  await page.waitForTimeout(500);
  const duringHold = await readTelemetry(page);
  const enterEvent = duringHold.laneEvents.find((event) => event.event === 'enter');
  check(
    '⑤ 手动接管：自动选位立刻停下且不跳变',
    Boolean(enterEvent) && Math.abs((enterEvent?.x ?? 0) - lastAutoX) <= 0.06,
    `接管点 x=${enterEvent?.x?.toFixed(3) ?? '无'}，接管前自动采样 x=${lastAutoX.toFixed(3)}`,
  );

  await page.keyboard.up('KeyD');
  const lastManualX =
    [...(await readTelemetry(page)).laneSamples].reverse().find((sample) => sample.mode === 'manual')?.x ?? 0;
  await page.waitForTimeout(2600);
  const afterHold = await readTelemetry(page);
  const resumeEvent = afterHold.laneEvents.find((event) => event.event === 'resume');
  const holdSeconds = (resumeEvent?.t ?? 0) - (enterEvent?.t ?? 0);
  check(
    '⑥ 松手 2 秒后从当前位置恢复自动（不回中、不跳变）',
    Boolean(resumeEvent) &&
      holdSeconds >= 2 &&
      Math.abs((resumeEvent?.x ?? 0) - lastManualX) <= 0.06,
    `恢复点 x=${resumeEvent?.x?.toFixed(3) ?? '无'}，恢复前手动 x=${lastManualX.toFixed(3)}，` +
      `手动持续 ${holdSeconds.toFixed(2)} 秒`,
  );

  // ── 轻点投币：只触发投币，不选位 ──
  // 先把选位固定在右侧（x=0.5），再点机台左侧 20% 处。
  // 落点 x 不能作为判据——币落下时要穿过钉阵，会被钉子撞偏；
  // 判据是「轻点之后选位仍然停在 0.5」，而不是被点按位置改成 x≈-0.583。
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setLane?.(0.735));
  await page.waitForTimeout(160);
  const beforeTap = await readState(page);
  const canvasBox = await page.locator('#game-canvas').boundingBox();
  await page.mouse.click(canvasBox.x + canvasBox.width * 0.2, canvasBox.y + canvasBox.height * 0.35);
  await page.waitForTimeout(400);
  const afterTap = await readStateFresh(page);
  const impliedTapX = ((0.2 - 0.5) / 0.35) * HALF_LANE;
  check(
    '⑦ 轻点机台即可投币，且不改变选位',
    Math.abs((beforeTap?.input?.laneX ?? 99) - 0.5) <= 0.02 &&
      afterTap?.chips === beforeTap.chips - 1 &&
      afterTap?.activeCoins === beforeTap.activeCoins + 1 &&
      Math.abs((afterTap?.input?.laneX ?? 99) - 0.5) <= 0.02,
    `筹码 ${beforeTap.chips}→${afterTap?.chips}，币 ${beforeTap.activeCoins}→${afterTap?.activeCoins}，` +
      `选位 ${(beforeTap?.input?.laneX ?? 0).toFixed(3)}→${(afterTap?.input?.laneX ?? 0).toFixed(3)}` +
      `（轻点若被当成选位会是 ${impliedTapX.toFixed(3)}）`,
  );
}

/**
 * 推进节奏：逐循环推下几枚。
 *
 * 用遥测里的「累计越线枚数」而不是筹码差 ÷ 基础值——热度倍率、热区与加注倍率
 * 都会放大入账筹码，差值已经不是枚数了。
 *
 * 判据（**绝对**枚数/循环，不随盘面放大；P2 满盘化之后已经按 310 枚重新定标过）：
 *   A 平均 0.3~3.0 枚/循环——低于下限说明推币面够不到币堆（憋死），高于上限说明推太快；
 *   B 最长空档 ≤ 8 个循环——连续 8 个循环没有新币越线就是盘面断档；
 *   C 单循环 ≤ 盘面枚数 × 25%——真正的「一波推光」是一次行程清空大半盘面。
 *     上限必须跟着盘面走：盘面越大，同一个绝对枚数占比越小，
 *     用固定枚数会在满盘化之后变成一条无意义的红线。
 *
 * 为什么 A 是**绝对**区间而不是占比：回收率是按「每次投币的越线枚数」标定的
 * （`crossings / drops ≈ 1.25`），玩家一局买的筹码数不变，所以每循环推下几枚
 * 这个绝对量才是经济的输入。盘面翻四倍而推下枚数也翻四倍的话，期望立刻变成正的。
 *
 * 用 PACE=0.30,0.36 覆盖候选行程。**默认必须是出厂值**，
 * 否则这一模式会拿一个已经不用的行程去判「推进速度超标」——
 * 那是它自己的默认值写错了，不是机器坏了。
 */
async function runPace(page) {
  // 出厂行程**从运行时读**，不写死：写死的话，常量一改这一模式就会拿旧行程去判
  // 「推进速度超标」——那是它自己的默认值过期了，不是机器坏了。
  const tuning = await page.evaluate(
    () => window.__THREE_GAME_TEST_HOOKS__?.setTuning?.({}) ?? {},
  );
  const shipped = Number(tuning?.pusherTravel ?? 0.3);
  const travels = (process.env.PACE ?? String(shipped)).split(',').map(Number);
  const min = Number(process.env.PACE_MIN ?? 0.3);
  const max = Number(process.env.PACE_MAX ?? 3);
  const repeat = Number(process.env.PACE_REPEAT ?? 1);
  console.log('\n── 模式：pace（逐循环推进节奏） ──');

  const table = await readTable(page);
  const flushCap = Math.max(8, Math.round((table?.coins ?? 0) * 0.25));
  console.log(`  盘面 ${table?.coins} 枚，「一波推光」上限 ${flushCap} 枚/循环`);

  for (const travel of travels) {
    const runs = [];
    for (let attempt = 0; attempt < repeat; attempt += 1) {
      await startRun(page, 'ready');
      await page.evaluate(
        (value) => window.__THREE_GAME_TEST_HOOKS__?.setTuning?.({ pusherTravel: value }),
        travel,
      );
      const final = await playRun(page, { drops: 24, waitEnd: false });
      const { cycles } = await readTelemetry(page);
      const pace = coinsPerCycle(cycles);
      runs.push({ earned: final?.earned ?? 0, cycles: cycles.length, ...pace });
      console.log(
        `  行程 ${travel.toFixed(2)} 米 · 第 ${attempt + 1} 遍：赚进 ${String(runs[attempt].earned).padStart(4)}，` +
          `循环 ${cycles.length}，推下 ${pace.total} 枚，平均 ${pace.average.toFixed(3)} 枚/循环，` +
          `单循环最多 ${pace.maxCycle} 枚，最长空档 ${pace.longestGap} 个循环`,
      );
    }

    const mean = runs.reduce((sum, run) => sum + run.average, 0) / runs.length;
    const worstGap = Math.max(...runs.map((run) => run.longestGap));
    const worstCycle = Math.max(...runs.map((run) => run.maxCycle));
    console.log(
      `  行程 ${travel.toFixed(2)} 米 · 均值：${mean.toFixed(3)} 枚/循环，` +
        `最长空档 ${worstGap}，单循环最多 ${worstCycle} 枚`,
    );
    check(
      `行程 ${travel.toFixed(2)}：推进速度在 ${min}~${max} 枚/循环`,
      mean >= min && mean <= max,
      `均值 ${mean.toFixed(3)} 枚/循环（${runs.length} 遍）`,
    );
    check(`行程 ${travel.toFixed(2)}：盘面不憋死`, worstGap <= 8, `最长 ${worstGap} 个循环无币越线`);
    check(
      `行程 ${travel.toFixed(2)}：无「一波推光」`,
      worstCycle <= flushCap,
      `单循环最多 ${worstCycle} 枚（上限 ${flushCap} 枚 = 盘面 25%）`,
    );
  }
}

/**
 * 机关：扫板 / 抓斗 / 后装填 / 风险转轮。
 *
 * 判据：机关只施加物理作用，结算仍由「币是否越线」决定；
 * 每个机关都要有明确的可用条件与成本，条件不满足时明确拒绝而不是静默吞掉筹码。
 *
 * P7 会重做这四个机关（现在动画不明显、亮点不足），届时这一组判据要跟着改。
 */
async function runMechanisms(page) {
  console.log('\n── 模式：mechanisms（四个机关） ──');
  const hooks = (fn, ...args) => page.evaluate(fn, ...args);

  // ── 后装填：花 1 筹码注入 3 枚，币数 +3、筹码 −1 ──
  // 后区本来就有预置币，所以判据必须是「后区枚数的增量」，不是绝对枚数。
  await startRun(page, 'ready');
  const backZone = (coins) => coins.filter((coin) => !coin.playerDropped && coin.z > 0.3 && coin.z < 0.55).length;
  const beforeReload = await readStateFresh(page);
  const backBefore = backZone(await readCoins(page));
  const reloaded = await hooks(() => window.__THREE_GAME_TEST_HOOKS__?.reload?.() ?? false);
  const afterReload = await readStateFresh(page);
  const backAfter = backZone(await readCoins(page));
  check(
    '后装填：花 1 筹码注入 3 枚到盘面后区',
    reloaded === true &&
      afterReload?.chips === beforeReload.chips - 1 &&
      afterReload?.activeCoins === beforeReload.activeCoins + 3 &&
      backAfter - backBefore >= 3,
    `筹码 ${beforeReload.chips}→${afterReload?.chips}，` +
      `币 ${beforeReload.activeCoins}→${afterReload?.activeCoins}，后区 ${backBefore}→${backAfter} 枚`,
  );

  // ── 抓斗：花 2 筹码，把选位附近区域的币搬到前沿 ──
  await startRun(page, 'playing');
  await dropUntilAccepted(page, 0);
  const beforeGrapple = await readStateFresh(page);
  const grappled = await hooks(() => window.__THREE_GAME_TEST_HOOKS__?.grapple?.(0) ?? false);
  const afterGrapple = await readStateFresh(page);
  const frontCoins = (await readCoins(page)).filter((coin) => coin.z > 0.9);
  const usedGrapple = await hooks(() => window.__THREE_GAME_TEST_HOOKS__?.mechanisms?.());
  // 「花了 2 筹码」要看 `spent`（真实扣款），再看 `chips` 是否正好等于
  // 「−扣款 + 这一窗口内真实越线的返值」。
  // **不能直接断言 `chips === before − 2`**：抓斗把币搬到得分线前 0.2 米，
  // 搬运过程本身就可能把币推过线——那是真实返值，会让 chips 少减 1 或 2。
  // 币堆变硬之后越线更频繁，这个误报就从「偶尔」变成「常见」（实测撞到过 chips 19→18）。
  // 扫板那条判据早就改成同一口径了，抓斗这里补齐。
  const grappleSpend = (afterGrapple?.spent ?? 0) - (beforeGrapple?.spent ?? 0);
  const grappleGain = (afterGrapple?.earned ?? 0) - (beforeGrapple?.earned ?? 0);
  check(
    '抓斗：花 2 筹码把区域内币堆搬到前沿',
    grappled === true &&
      grappleSpend === 2 &&
      (afterGrapple?.chips ?? 0) === beforeGrapple.chips - 2 + grappleGain &&
      Number.isInteger(grappleGain) &&
      grappleGain >= 0 &&
      frontCoins.length >= 2 &&
      usedGrapple?.grapple === 1 &&
      ledgerOk(afterGrapple),
    `筹码 ${beforeGrapple.chips}→${afterGrapple?.chips}（扣款 ${grappleSpend}，` +
      `窗口内真实越线返值 +${grappleGain}），` +
      `前沿币 ${frontCoins.length} 枚，剩余次数 ${usedGrapple?.grapple}`,
  );

  // ── 扫板：收尾停板之后才开放 ──
  // 开放窗口很窄，所以带重试：停板后盘面静止 0.8 秒（`RULES.restHold`）收尾就走完，
  // 而满盘收尾会把筹码回吐给玩家、让本局继续下去——窗口一过 `plateStopped` 就翻回 false。
  // （P7 重做四机关时要顺手把这个窗口做宽，现在不到 1 秒，真人也来不及按。）
  const enterDrain = async () => {
    await hooks(() => window.__THREE_GAME_TEST_HOOKS__?.setState?.('drain'));
    return waitFor(page, (state) => state?.plateStopped === true, 30_000);
  };

  const draining = await enterDrain();
  check('筹码耗尽收尾能走到停板', draining?.plateStopped === true, `phase=${draining?.phase}`);

  let swept = false;
  let usedSweep = null;
  let beforeSweep = draining;
  let afterSweep = draining;
  for (let attempt = 0; attempt < 20 && swept !== true; attempt += 1) {
    if (attempt > 0) {
      const again = await enterDrain();
      if (again?.plateStopped !== true) break;
      beforeSweep = again;
    }
    swept = await hooks(() => window.__THREE_GAME_TEST_HOOKS__?.sweep?.() ?? false);
    afterSweep = await readStateFresh(page);
    usedSweep = await hooks(() => window.__THREE_GAME_TEST_HOOKS__?.mechanisms?.());
  }
  const sweepGain = (afterSweep?.earned ?? 0) - (beforeSweep?.earned ?? 0);
  check(
    '扫板：只给贴线的币施加冲量，不花筹码也不凭空返值',
    swept === true &&
      usedSweep?.sweeper === 0 &&
      // 「不花筹码」要看 spent，不能看 chips：扫板把币推过线是**会**返值的，
      // 那是真实越线。筹码的变化必须正好等于这笔返值，多一分就是凭空来的。
      afterSweep?.spent === beforeSweep.spent &&
      afterSweep?.chips === beforeSweep.chips + sweepGain &&
      Number.isInteger(sweepGain) &&
      sweepGain >= 0 &&
      ledgerOk(afterSweep),
    `扫板后赚进 +${sweepGain} 筹码（全部来自真实越线，扫板本身不扣筹码），剩余次数 ${usedSweep?.sweeper}`,
  );

  // 转轮的开放条件是「收尾 + 筹码 > 0」——那是「盘面把筹码还回来」的窗口。
  // 筹码为 0 的收尾里它必须明确拒绝，而不是把 0 筹码当成一次免费押注。
  // 用 `ruin` 状态构造：它确定是「收尾 + 筹码 0」，不依赖前面几步跑成什么样。
  await hooks(() => window.__THREE_GAME_TEST_HOOKS__?.setState?.('ruin'));
  const beforeWheel = await readStateFresh(page);
  const spun = await hooks(() => window.__THREE_GAME_TEST_HOOKS__?.spinWheel?.() ?? false);
  const afterWheel = await readStateFresh(page);
  const usedWheel = await hooks(() => window.__THREE_GAME_TEST_HOOKS__?.mechanisms?.());
  check(
    '风险转轮：筹码为 0 的收尾里明确拒绝，不消耗次数也不改盘面',
    spun === false &&
      beforeWheel?.chips === 0 &&
      beforeWheel?.phase === 'drainOut' &&
      usedWheel?.wheel === beforeWheel?.mechanisms?.wheel &&
      afterWheel?.activeCoins === beforeWheel?.activeCoins,
    `spinWheel → ${spun}，筹码 ${beforeWheel?.chips}（${beforeWheel?.phase}），` +
      `剩余次数 ${usedWheel?.wheel}，币 ${beforeWheel?.activeCoins}→${afterWheel?.activeCoins}`,
  );

  // ── 币池预算：硬上限，池满时 acquire() 静默返回 null ──
  await startRun(page, 'ready');
  let refusals = 0;
  for (let index = 0; index < 40; index += 1) {
    const ok = await hooks(() => window.__THREE_GAME_TEST_HOOKS__?.reload?.() ?? false);
    if (!ok) refusals += 1;
    const state = await readState(page);
    if (state?.phase !== 'ready' && state?.phase !== 'playing') break;
  }
  const budget = await readStateFresh(page);
  check(
    '币池预算：余量可读且不为负',
    (budget?.mechanisms?.coinsRemaining ?? -1) >= 0,
    `池余量 ${budget?.mechanisms?.coinsRemaining}，活跃 ${budget?.activeCoins}，拒绝 ${refusals} 次`,
  );
  const cap = (budget?.activeCoins ?? 0) + (budget?.mechanisms?.coinsRemaining ?? 0);
  const preset = (await readTable(page))?.coins ?? 0;
  // 判据**不能写死上限**：满盘化之后预置枚数会变，写死 150 会在 P2 之后变成一条
  // 恒假的断言（盘面 310 永远「超过 150」）。改成「装得下整盘 + 20% 注入余量」。
  check(
    '币池预算：装得下整盘并留出 20% 注入余量',
    cap >= preset * 1.2,
    `预算 ${cap}，预置 ${preset}（需 ≥ ${Math.round(preset * 1.2)}）`,
  );
}

async function main() {
  const browser = await chromium.launch({ channel: 'chromium' });
  const { page, context, errors } = await openGame(browser);

  try {
    if (MODE === 'probe' || MODE === 'all') await runProbe(page);
    if (MODE === 'endless' || MODE === 'all') await runEndless(page);
    if (MODE === 'economy') await runEconomy(page);
    if (MODE === 'xixi' || MODE === 'all') await runXixi(page);
    if (MODE === 'layout') await runLayout(page);
    if (MODE === 'physics') await runPhysics(page);
    if (MODE === 'perf') await runPerf(page, context);
    if (MODE === 'accept') await runAcceptance(page, context);
    if (MODE === 'shots') await runShots(page, context);
    if (MODE === 'sweep') await runSweep(page);
    if (MODE === 'lane') await runLane(page);
    if (MODE === 'pace') await runPace(page);
    if (MODE === 'mechanisms') await runMechanisms(page);
    if (MODE === 'show') await runShow(page);
    check('运行期无控制台/页面错误', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    await context.close();
    await browser.close();
  }

  const failed = results.filter((entry) => !entry.ok);
  console.log(`\n合计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
  process.exit(failed.length === 0 ? 0 : 1);
}

await main();
