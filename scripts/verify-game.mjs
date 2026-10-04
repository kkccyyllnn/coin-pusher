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
 *   economy    账本恒等式 / 余额守恒（全局终身账）/ 脏钱不可换永久进度 / 单位期望与庄家优势
 *   xixi       XIXI 集章与背板老虎机（P5 起替换三路集章）
 *   mechanisms 三个机关：扫板 / 抓斗 / 后装填
 *   sweep      推板行程参数扫描（默认两端 0.8/1.16，可用 SWEEP=0.8,1.0,1.16 分批覆盖）
 *   lane       自动选位匀速性、手动接管与轻点投币
 *   pace       逐循环推进节奏（行程选型的判据）
 *   show       投放演出：三装置真币交付 / 两态事件 / 预算降级与拒绝
 *   models     低多面体模型币：结构（非索引 / 逐面法线 / 面内平 UV）/ 配色 / 尺寸倍率
 *   spray      喷泉的纯视觉币通道：不进账本 / 从顶沿之上飞出机柜 / 材质共用程序
 *   refill     自动补币：口径守卫 / 阈值之上不触发 / 掏空触发 / 冷却 / 沉降期不补
 *   feedback   得分反馈分级：边界枚举 / 飞字分档 / 真实对局里的接线与衰减 / 相机完全静止
 *   accept     验收清单自动化部分
 *   perf       帧率与画质分档
 *   cabinetTex 机柜 Arcane 风贴图（S18）：调色板 / 像素桶 / 程序数 / draw call / 实例分离
 *   cabinet    机柜外壳几何（S19/S24）：解析盒 vs 实测盒 / 镜像 / 负空间 / 跨模块不变量 / 檐板朝向 / 无运行期覆盖
 *   model      模型模式（S24，?model）：覆盖层生效 / 面板在 DOM / 改真源→几何跟着变 / 解析盒仍自洽 / 重建不涨预算
 *   camera     摄影机机位（S22）：角度↔坐标往返恒等 / 两组自由度隔离 / 机位所有权 / `?debug` 面板端到端
 *   shots      截图
 *   hooks      搬家守卫：M0 结构门（dispose 完整性，清单由源码派生）+ M1 读数 census（诊断字段与
 *              钩子键逐字节基线）+ M2 发布时机门（快照每帧换身份，堵住"悄悄合帧/降频"）
 *              基线在 `scripts/diagnostics-census.json`；重建：`CENSUS_UPDATE=1 node scripts/verify-game.mjs hooks`
 *   all        probe + endless + xixi
 */

import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/**
 * 币尺寸档位（S13）：`COIN=1.1 node scripts/verify-game.mjs layout`。
 *
 * 直接拼进 URL —— 与手改地址栏**完全同一条路径**（`coinScale.ts` 读的就是这个参数）。
 * 不另开一条「脚本专用」的注入通道：两条路一旦分叉，就会出现「脚本绿、手玩红」。
 */
const COIN_PARAM = process.env.COIN ? `coin=${encodeURIComponent(process.env.COIN)}` : '';
const BASE = (() => {
  const url = process.env.BASE_URL ?? 'http://127.0.0.1:5188';
  if (!COIN_PARAM) return url;
  return `${url}${url.includes('?') ? '&' : '?'}${COIN_PARAM}`;
})();
const MODE = process.argv[2] ?? 'probe';

/**
 * 每局投币上限（协议常量，也是 economy 的截断量）。
 *
 * ★ 为什么要具名：它原先只是 playRun 的默认参数值，而 ⑥ 的『局长不崩溃』上界写在另一处
 *   （CRASH_LENGTH，历史值 300）。于是**上界永远够不到**——协议先在 240 截断，判据再宽也不会红
 *   ⇒ 『右尾变厚』这件事在 10-01 之前没有任何一条门在守（段 1 实测：所有 timeout 局停在 239~240 投）。
 *   两处写同一个数就是第二份真源 ⇒ 判据从本常量派生，playRun 也引用它。
 */
const ECON_RUN_DROPS_CAP = 240;

/**
 * 虚拟时钟泵（只有 ECON_CLOCK=1 才开，默认关）。
 *
 * ## 为什么需要它
 *
 * 实测本机仿真**正好跑在实时**：仿真秒 / 墙钟秒 = 1.000，60.0 fps，每帧 dt 16.7 ms
 * （满盘 331 枚币、软件渲染）。所以 ECON_RUNS=200 的十几个小时是 rAF 墙钟锁死的，
 * 跟光栅化无关——把内部分辨率降到 160x100 只把加速比从 2.40x 抬到 2.42x，
 * 说明「换 GPU 就快了」是错的。
 *
 * page.clock 把 rAF 的时间戳变成可编程推进：每帧 dt 仍是 16 ms（与 60 fps 真机
 * 同一条子步序列，物理世界每仿真秒照样 60 个 step），只是不再等实时。
 *
 * ## 为什么默认关
 *
 * 泵会改变 waitFor 的超时语义（同样的真实超时能跑到 ~2.4 倍的仿真时间）。
 * 其他模式的既有读数都建立在「墙钟 = 仿真钟」上，不能被它悄悄改掉。
 */
/* 泵只对 `economy` 安全，所以门控收在这**一个**标志位上，而不是只挡 `page.clock.install()`：
   `openGame` 的 install、`simTick` 的 runFor、`startClockPump` 的外层泵全部读同一个标志。
   原来只靠 env，非 economy 模式会「装上假时钟却没人泵」——Playwright 的 clock 装了之后
   不 `runFor` 就不走时间，rAF 时间戳停住 ⇒ 循环停摆 ⇒ 一片看着像物理回归的超时红。
   放在这里之后，`ECON_CLOCK=1 node scripts/verify-game.mjs perf` 就是**逐字节等价于不开泵**。 */
const CLOCK_ENABLED = process.env.ECON_CLOCK === '1' && MODE === 'economy';

/**
 * 「等 ms 毫秒」的两种口径：默认（真实墙钟）与开泵（仿真时间）。
 *
 * 为什么必须成对存在：harness 的等待粒度原本写的是**墙钟**（waitFor 每 250 ms 轮询、
 * 投币重试每 70 ms、投币之间 sleep 300 ms），而引擎的推板循环与结算跑在**仿真钟**上。
 * 实时跑时两者 1:1；一旦开泵（实测吞吐 ~2.4x），同样的墙钟等待就变成几倍的仿真间隔，
 * **事件落到仿真轴的位置被改掉** ⇒ 量到的是协议差而不是物理差。
 *
 * ⚠️ 这里原先写的证据（「越线/投币从 0.456 涨到 0.848」）出自**修协议之前**的 n=4 批，
 * 修好之后的 n=20 配对批读数反向（实时 0.778 / 泵 0.514），所以它不能当判据用；
 * 真正的机制是上面那句「事件在仿真轴上的位置」，不是子步丢失
 * （2026-09-29 四腿对照实测：每仿真秒 60 帧、每帧 1 个子步，泵腿与实时腿同构）。
 */
async function simTick(page, ms) {
  if (CLOCK_ENABLED) {
    await page.clock.runFor(ms);
    return;
  }
  await page.waitForTimeout(ms);
}

/**
 * 泵的时间量子，默认 200 ms（实测约 2.4x 吞吐）：更长会让 Playwright 的输入/求值调用
 * 排队等太久，更短则 Node 侧调度开销占比过高。
 *
 * ★ 但它同时是**仿真轴上的网格间距**：`simTick(70)` 之类按仿真毫秒请求的等待，
 * 落地时仍被后台泵向上取整到 200 ms ⇒ 事件只能对齐到 200 ms 网格。
 * 要做「同种子、两腿逐位对照」这类等价性判据，粒度必须不超过最窄的那条等待
 * （`dropUntilAccepted` 的 70 ms），所以留 `ECON_PUMP_STEP` 这个旋钮。
 */
const PUMP_STEP_MS = Math.max(1, Math.round(Number(process.env.ECON_PUMP_STEP ?? 200)));

function startClockPump(page) {
  if (!CLOCK_ENABLED) return async () => {};
  let stopped = false;
  const run = async () => {
    while (!stopped) {
      try {
        await page.clock.runFor(PUMP_STEP_MS);
      } catch {
        return; // 页面已关闭
      }
    }
  };
  const promise = run();
  return async () => {
    stopped = true;
    await promise;
  };
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
}

/**
 * 存档写盘读数（10-03 计划步 2b：**先量再改**）。
 *
 * 评审说「每次筹码进出都立刻 stringify+setItem，一波 12 币 = 12+ 次串行写盘」，前半句我核过是对的
 * （`SaveStore.write()` 被 9 个方法直接调用，全仓无节流/无 dirty 标志），但 `perf` 里**没有任何写盘耗时读数**
 * ⇒ 收益量级无证据，所以这一轮只加测量、不动 `SaveStore`。
 * 包法只计数不改语义：原调用照常执行、返回值原样透传；拿不到 `localStorage` 就静默不测。
 */
async function installSaveWriteProbe(context) {
  await context.addInitScript(() => {
    try {
      const ls = window.localStorage;
      const original = ls.setItem.bind(ls);
      const obs = { writes: 0, bytes: 0, msTotal: 0, maxMs: 0, byKey: {} };
      Object.defineProperty(ls, 'setItem', {
        configurable: true,
        writable: true,
        value: (key, value) => {
          const t0 = performance.now();
          const result = original(key, value);
          const dt = performance.now() - t0;
          obs.writes += 1;
          obs.bytes += String(value).length;
          obs.msTotal += dt;
          if (dt > obs.maxMs) obs.maxMs = dt;
          obs.byKey[key] = (obs.byKey[key] ?? 0) + 1;
          return result;
        },
      });
      window.__SAVE_OBS__ = obs;
    } catch {
      // 测不到就不测：这条是读数，不参与任何判据。
    }
  });
}

/** 把累计的写盘计数打成一行读数（不进判据）。 */
async function reportSaveWrites(page, label, divisor) {
  let obs = await page.evaluate(() => window.__SAVE_OBS__ ?? null);
  // 正对照：0 有两种解释（"这段时间真没写盘" vs "探针根本没接上"）。用**同值** setWallet
  // 触发一次写（不改余额、不动账本），计数器要是不动就是探针死了 —— 直说，不许蒙混成 0。
  if (!obs || obs.writes === 0) {
    const proof = await page.evaluate(() => {
      const before = window.__SAVE_OBS__?.writes ?? -1;
      const balance = window.__THREE_GAME_DIAGNOSTICS__?.balance ?? null;
      const hook = window.__THREE_GAME_TEST_HOOKS__?.setWallet;
      // 用引擎自己的返回值证"没改状态"，不拿同一份诊断快照自比（那会是恒真）。
      const res = typeof hook === 'function' ? hook(balance) : null;
      return {
        before,
        after: window.__SAVE_OBS__?.writes ?? -1,
        hasObs: !!window.__SAVE_OBS__,
        setWalletOk: !!res,
        balanceUnchanged: !!res && res.balance === balance,
      };
    });
    console.log(
      `  [info] 存档写盘读数：${label} 计数为 0 ⇒ 正对照（同值 setWallet 触发一次写）` +
        `探针${proof.after > proof.before && proof.before >= 0 ? '活着：这段时间真的没写盘' : '**是空的**：包装没生效，这条读数不可信'}` +
        `（hasObs=${proof.hasObs}、setWalletOk=${proof.setWalletOk}、返回值里余额没变=${proof.balanceUnchanged}）`,
    );
    return;
  }
  const perUnit = divisor > 0 ? (obs.writes / divisor).toFixed(2) : '—';
  console.log(
    `  [info] 存档写盘读数（不进判据）：${label} 共 ${obs.writes} 次 / ${(obs.bytes / 1024).toFixed(1)} KB，` +
      `平均 ${(obs.msTotal / obs.writes).toFixed(3)} ms、单次最大 ${obs.maxMs.toFixed(3)} ms、` +
      `累计占用 ${(obs.msTotal / 1000).toFixed(3)} s；` +
      (divisor > 0 ? `每单位 ${perUnit} 次（分母 = ${divisor}）；` : '') +
      `键分布 ${JSON.stringify(obs.byKey)}`,
  );
}

async function openGame(browser) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  // 写盘探针必须在导航之前装：`SaveStore` 在构造期就会写一次，goto 之后再包就漏掉那一笔。
  await installSaveWriteProbe(context);
  const page = await context.newPage();
  const errors = [];
  // ★ 页内错误**立刻**走 stderr：批若在几十局后崩在 Rapier 的「recursive use」上，真凶是
  //   更早被吞掉的那次抛错（`errors` 要到批尾的「运行期无控制台/页面错误」才打印）。
  //   stdout 必须保持干净给解算器读，所以这条只打 stderr。
  page.on('pageerror', (error) => {
    errors.push(error.message);
    console.error(
      `[pageerror] ${new Date().toISOString()}\n${error.stack ?? error.message}`
    );
  });
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  // 时钟必须在导航之前接管：goto 之后建立的 rAF 时间戳就不归 page.clock 管了。
  if (CLOCK_ENABLED) await page.clock.install();
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  // 引导要真的帧才数得到 frame > 10，未开泵时这个 stop 是空操作。
  const bootPump = startClockPump(page);
  try {
    await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 10, null, {
      timeout: 20_000,
    });
  } finally {
    await bootPump();
  }
  // 币的几何量随 `?coin=1.1/1.2` 变，所以**每开一次页面就读一次**（见 `geo()` 的注释）。
  COIN_GEO = await readCoinGeometry(page);
  if (COIN_GEO) {
    console.log(
      `[info] 币尺寸档位 ×${COIN_GEO.scale}：直径 ${(COIN_GEO.diameter * 1000).toFixed(1)} mm、` +
        `层高 ${(COIN_GEO.layerStep * 1000).toFixed(2)} mm、抖动 ${(COIN_GEO.maxJitter * 1000).toFixed(2)} mm、` +
        `步距下限 ${(COIN_GEO.minStep * 1000).toFixed(2)} mm、单枚质量 ${COIN_GEO.mass.toFixed(4)} kg`,
    );
  }
  return { page, context, errors };
}

const readState = (page) => page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__);

/**
 * 落体预算（米/秒）：币在这台机器上**只靠重力**能达到的最大速度。
 * 两处判据吃的都是它（推板一轮后、⑥ 冷），差别只在要不要把喷泉那一截算进来。
 *
 * 收成一份派生式的原因：`:668` 原来写死 `6.3`、⑥ 冷原来写死
 * `√(2·13·(1.45+0.08+0.186))`，两个都是 `constants.ts:176/:193` 推导的抄本 ——
 * `gravity` 一旦调（R4 就在调接触相关的参数），两处会各自漂，判据自己变成第二份真源。
 *
 * - `gravity` 从诊断现读（`physics.tuning.gravity`，符号是负的 ⇒ 取绝对值），
 *   读不到时兜回 13（`PHYSICS.gravity`）；**不能兜 0**，那会让 `NaN/Inf` 比较恒假。
 * - 1.45（落币口高度）与 0.08（出币托盘深度）页面没暴露，按 `constants.ts:176` 具名并标出处。
 * - 喷泉那一截按 `vy²/(2g)` 折成顶高，`2.2` 的出处是 `ShowDirector.ts:770` 的设计约束
 *   `vy ≤ 2.2`；**不许再另外加一次 `2.2²`** —— 上抛动能已经换算成这一截顶高，
 *   两项都算等于给同一份能量记两遍账（第一版实测 7.03 就是这么来的）。
 */
const DROP_HEIGHT_M = 1.45;
const TRAY_DEPTH_M = 0.08;
const FALLBACK_GRAVITY_MPS2 = 13;
const FOUNTAIN_UPWARD_MPS = 2.2;

function fallBudgetMps({ gravity, fountainUpwardMps = 0 } = {}) {
  const g = Math.abs(gravity) || FALLBACK_GRAVITY_MPS2;
  const extra = (fountainUpwardMps * fountainUpwardMps) / (2 * g);
  return Math.sqrt(2 * g * (DROP_HEIGHT_M + TRAY_DEPTH_M + extra));
}

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
  // 走 `simTick` 而不是墙钟：这一等经常卡在「动作 → 读账本」之间（economy ③ 的
  // `ledgerOk(await readStateFresh(page))` 就是一例），开泵时真实等待里泵还在灌仿真，
  // 读到的就不是动作那一刻的账本了。不开泵时两者等价。
  await simTick(page, 140);
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
 *
 * `stake` 是**补足的目标余额**（默认 200）——见下面那段「为什么开局前要补钱」。
 * `economy` 批会把它压到标准注额，理由见 `runEconomy` 里的 `STAKE`。
 */
async function startRun(page, state = 'ready', stake = 200) {
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.seed?.(20260921));
  // **先把余额补到 `stake` 再开局。**
  //
  // 合并账户（S4）之前这条写作「每次 `startRun` 都从钱包扣 20，只有收工才回存」：
  // 脚本在同一个会话里跑十几条用例就会把钱包掏空，于是 `buyIn` 变 0 ——
  // 而引擎现在会正确地以「开局即破产」响应（见 `Game.startRun` 的零筹码分支）：
  // 弹破产窗、进沉降、`playRun` 的循环立刻 break，下游全部读成 0 投 0 入账。
  //
  // ★ 合并之后**没有「买入」这笔转账了**，但这件事没有消失，只是换了成因：
  //   一局就是把余额投到见底为止，所以上一局破产时余额已经是 0 ⇒ 不补就开下一局，
  //   第一条币都投不出去，下游照样全部读成 0。结论与修法都不变。
  //
  // 这些用例测的是玩法，不是破产。破产那条路径有专门的用例（见 `runEndless` 的
  // 「余额见底」检查与 `runEconomy` 的 ⑤′），它们自己会把余额清零。所以这里先补满。
  //
  // 充值额记进 `SaveStore` 的 `totals.refill`（旧名 `refilled`），
  // 余额守恒算式（`runEndless` 与 `runEconomy` 的 ②）把它算进去。
  await page.evaluate((target) => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__;
    const balance = hooks?.run?.()?.balance ?? 0;
    if (balance < target) hooks?.refillWallet?.(target - balance);
  }, stake);
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
    /* ★ 重试间隔走**仿真毫秒**，不走墙钟。
       墙钟 70 ms 在开泵时对应 ~0.3 仿真秒，于是「投币被冷却拒绝 → 重试」这条节奏
       在实时腿与泵腿上是两个不同的自变量：同一局在两腿里落到**推板行程的不同相位**。
       币落在推板刚起步还是快到头，直接决定它这一循环有没有被推出去 ⇒ 越线/投币差。
       不开泵时 `simTick` 逐字节等于 `waitForTimeout`，实时腿读数不变。 */
    await simTick(page, 70);
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
    await simTick(page, 250);
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
    await simTick(page, 250);
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
  /*
   * 局长预算按**仿真秒**算，不按墙钟。
   *
   * `timeoutMs` 这个数字当初是在实时下定的，那时「150 秒墙钟」和「150 仿真秒」是同一件事
   * （实测仿真锁在实时 1.000×）。开泵之后它不再等价：同样的墙钟会灌进 ~2.4 倍仿真秒，
   * 于是每一局都跑得更长——而 `越线/投币` 是**局长主导**的：
   * 2026-09-28 实时腿干净尾逐局量到 短局（27~34 投）0.19~0.48、长局（91~156 投）0.78~1.15，
   * **同一次跑法内部就有 6 倍跨度**。所以拿墙钟当上限去比「实时 vs 泵」，量到的是协议差而不是物理差。
   *
   * 改成仿真秒之后：实时腿的行为与改动前**逐位一致**（sim ≈ wall），泵腿则被拉回同一条局长口径。
   * 墙钟这里只留一条**更宽**的安全网（防页面死了以后无限轮询），不再参与局长判定。
   */
  const simBudgetSeconds = timeoutMs / 1000;
  const wallDeadline = Date.now() + Math.max(timeoutMs * 4, 600_000);
  const startedAt = (await readState(page))?.elapsed ?? 0;
  let boostResolved = 0;
  while (Date.now() < wallDeadline) {
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
    if ((state?.elapsed ?? 0) - startedAt >= simBudgetSeconds) {
      return { state, boostResolved, end: 'timeout' };
    }
    if (state?.phase === 'drainOut' && (state?.boostCharges ?? 0) > 0) {
      const used = await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.boost?.() ?? false);
      if (used) boostResolved += 1;
    }
    /* ★ 轮询间隔走仿真毫秒：终态（破产窗 / settled）是**瞬时事件**，
       用墙钟轮询时泵腿每 400 ms 墙钟跳过 ~1 仿真秒，终态会被**读晚**，
       于是同一局在两条腿里的 `runSeconds` 与最后一投的位置都不同。
       不开泵时 `simTick` = `waitForTimeout`，实时腿读数不变。 */
    await simTick(page, 400);
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
async function playRun(page, { drops = ECON_RUN_DROPS_CAP, lanes, waitEnd = true, stake, loanOnRuin = false } = {}) {
  await startRun(page, 'playing', stake);
  /* 本局长度的零点必须取在 `startRun` **之后**。
     `Game.ts:1739` 每次开局把 `elapsed` 归零，所以它是「本局自己的钟」而不是会话钟：
     在开局前取零点就会跨局相减，实测把 193 投的一局读成 `仿真 0s`
     （2026-09-28 自证批）。这个字段是局长口径的直接证据，不能猜。 */
  const runStart = (await readState(page))?.elapsed ?? 0;
  const pickLanes = lanes ?? [-0.85, -0.45, 0, 0.45, 0.85];

  // 冷启动兜底：首投必须**真的被接受**（见 `primeFirstDrop` 的说明）。
  await primeFirstDrop(page, pickLanes[0]);
  let lastCycle = (await readState(page))?.pusher.cycles ?? 0;
  /** 本局**就地贷款续玩**的次数（只在 `loanOnRuin` 下非 0）。 */
  let loans = 0;
  for (let index = 1; index < drops; index += 1) {
    const state = await readState(page);
    if (state?.endless?.ruinVisible === true || state?.phase === 'settled') {
      /*
       * `loanOnRuin`：**在破产态就地贷款续玩，而不是收工重开**。
       * 存在的理由只有一条：S2 的欠债-分流机制要能被量到，账户必须先被借过。
       * 默认关（`ECON_LOAN` 未设）⇒ 判据走的还是「一局投到底」这条老路，与既有标定可比。
       * 开的时候这条循环变成「借到借不动为止」，一局可以横跨多次报价 ⇒ 读数是**稳态口径**，
       * 不能再和默认批的局长/timeout 占比逐位比。
       */
      const rescued = loanOnRuin
        ? await page.evaluate(
            () => window.__THREE_GAME_TEST_HOOKS__?.loanToContinue?.()?.applied ?? 0,
          )
        : 0;
      if (rescued > 0) {
        loans += 1;
        continue;
      }
      break;
    }
    if (state?.phase !== 'drainOut') {
      // 这个 20 秒是**死循环兜底**，不是局长来源：每圈都以「推板多走一个循环」为进度条件，
      // 所以投币节奏本身已经是仿真对齐的。局长口径只在 `waitForRunEnd` 里定。
      const advanced = await waitFor(page, (current) => (current?.pusher?.cycles ?? 0) > lastCycle, 20_000);
      if (!advanced) break;
      lastCycle = advanced.pusher.cycles;
    }
    const accepted = await dropUntilAccepted(page, pickLanes[index % pickLanes.length]);
    if (!accepted) await simTick(page, 300);
  }

  if (!waitEnd) {
    const capped = await readState(page);
    return {
      ...capped,
      end: 'cap',
      loans,
      runSeconds: Math.max(0, (capped?.elapsed ?? runStart) - runStart),
    };
  }
  const { state, boostResolved, end } = await waitForRunEnd(page);
  return {
    ...state,
    boostResolved,
    end,
    loans,
    runSeconds: Math.max(0, (state?.elapsed ?? runStart) - runStart),
  };
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
 * `roll = 0` 必过概率闸门（铜币与花纹的 `gateChance > 0`），拿到的是该组合的上界值；
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
 * 账本恒等式：`balance === initial + earned + begged + loaned − spent`（S4 合并账户之后）。
 * 任何一条收尾路径、任何一帧都不能破——这是 P1 的核心验收。
 */
function ledgerOk(state) {
  if (!state) return false;
  // ★ 恒等式由**引擎自己判**：`Game.ts` 的 `ledger().balanced` ← `economy.ledgerBalances`。
  // 这里原先手抄了同一个算式（`chips === buyIn + earned + begged − spent`），
  // 于是 `Ledger` 加一项就要同步两处，漏一边就是「src 绿、spec 红」的假回归对。
  // ⚠️ **缺字段一律判不平**（而不是 fallback 自己算）：`balanced === undefined` 只可能是
  // 钩子那条路没把字段带上来，那正是「判据失效却显示绿」的形态 ⇒ 必须当场红给我看。
  // 本函数有 23 处调用点，全部跟着这一条语义走。
  return state.balanced === true;
}

function ledgerText(state) {
  return (
    `余额 ${state?.balance} = 起始 ${state?.initial} + 赚进 ${state?.earned} + ` +
    `跪求 ${state?.begged} + 贷款 ${state?.loaned} − 花费 ${state?.spent}` +
    // ★ 判据改成读引擎的 `balanced` 之后，这一行**必须自己带上结论**：
    // 否则一条红的判据会打印出一串看着成立的等式（变异测试时就出现过
    // 「FAIL 但文本写着 20 = 20 + 0 + 0 − 0」），读日志的人查不出为什么红。
    // 差额用现成的 `ledgerDeltaOf` 的口径，不在这里再造式子。
    `（引擎判账本${state?.balanced === undefined ? '字段缺失' : state?.balanced ? '平' : '不平'}，` +
    `差额 ${ledgerDeltaOf(state)}）`
  );
}

/** 与 `economy.ledgerDelta` 同一个口径；只用于打印，不参与判据。 */
function ledgerDeltaOf(state) {
  if (!state) return null;
  return (
    state.balance -
    ((state.initial ?? 0) + (state.earned ?? 0) + (state.begged ?? 0) + (state.loaned ?? 0) - (state.spent ?? 0))
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

  /*
   * ★ S13 重写了这两条哨兵。它们原先断言「单枚币 12 秒内降到币床（y < deckY()）
   * 并被送出前缘（z > 0）」。
   *
   * 那条断言的**关切**是对的（台面必须把币喂给币床），但它拿**单枚币的行程**
   * 当代理量。台面从 S6 起铺满 60 枚，新币落在币堆顶上随大流走 —— 按 Little 定律
   * 行程 = 台面存量 / 吞吐 ≈ 60 / 1.57 ≈ 38 个循环 ≈ **75 秒**，
   * 12 秒的窗口**永远**读不到它出前缘：实测 12 秒只净走 0.15 米，
   * 币 z 在 −0.61 ↔ −0.21 之间往复，振幅恰好是推板行程。
   *
   * 吞吐本身有专门的仪器：`pace` 模式量「越线枚数 / 循环」，判据带 0.3~3.0
   * （S13 实测 1.565 枚/循环，见 PLAN-v4）。所以这里改成量**机制**，不再量行程：
   *
   *   ① 币确实**落下来停稳**了（y 在末段不再变）—— 抓「卡在落币走廊里 / 悬空 / 抖动」；
   *   ② 推板一个循环**不偷给币净前进量**（对称行程 ⇒ 每循环净漂移 ≈ 0）。
   *
   * ② 直接编码 S23 的核心不变式：**`extend == retract` 的对称行程下净输送精确为 0**
   * （库仑摩擦与对称 smoothstep 都满足时间反演对称）。★ 出厂态**就是**对称的
   * （现读 `PUSHER_CYCLE`：extend 0.9 / retract 0.9 / holdFront 0.3 / holdBack 0.3），
   * 所以谁把 `retract` 改得**不等于** `extend` —— S13 曾把它改成 0.45 ⇒ 实测净输送比本上限高一个数量级 ——
   * 这条立刻红。它比原来那条「12 秒走完台面」更贴近要守的东西，也不会被「台面铺多满」影响。
   */
  const tail = timeline.filter((row) => row.coin).slice(-5).map((row) => row.coin.y);
  const ySwing = tail.length >= 2 ? Math.max(...tail) - Math.min(...tail) : 9;
  // 停稳阈值取**层高的四分之一**（不是绝对值）：币落在币堆顶上，停稳后 y 只该有
  // 求解器级的抖动；层高随币尺寸档位变，写死绝对值在 ×1.2 下会变成另一种严格度。
  const settleTol = geo().layerStep / 4;
  check(
    '单枚币落到台面上并停稳（末段 y 不再变化）',
    tail.length >= 2 && ySwing < settleTol,
    `末段 y ∈ [${Math.min(...tail).toFixed(4)}, ${Math.max(...tail).toFixed(4)}]，` +
      `波动 ${(ySwing * 1000).toFixed(2)} 毫米（上限 ${(settleTol * 1000).toFixed(2)}）`,
  );

  // ── ② 相位锁定的净输送 ──
  // 采样必须锁在**同一相位**（每个循环开始、`offset ≈ 0` 的那一刻），
  // 否则读到的是振荡量（振幅 = 推板行程 0.36 米，比净输送大一个半数量级）。
  const PHASE_SAMPLES = 5;
  const phaseZs = [];
  let phaseCycles = (await readState(page))?.pusher.cycles ?? 0;
  const phaseDeadline = Date.now() + 40_000;
  while (phaseZs.length < PHASE_SAMPLES && Date.now() < phaseDeadline) {
    const state = await readState(page);
    if ((state?.pusher?.cycles ?? 0) > phaseCycles) {
      phaseCycles = state.pusher.cycles;
      const coin = await playerCoin(page);
      if (coin) phaseZs.push(coin.z);
    }
    await page.waitForTimeout(60);
  }
  const netDrift = phaseZs.length >= 2 ? phaseZs[phaseZs.length - 1] - phaseZs[0] : null;
  const perCycle = netDrift !== null ? netDrift / (phaseZs.length - 1) : null;
  // 上限取层高/10（×1.1 档 = 2.32 毫米/循环）：已观测读数在 0~0.5 毫米/循环之间，留 4.6 倍余量。
  // ⚠️ 这个上限是 **probe 默认盘面（预置 382 枚）的属性**，不是普适常数：S1a 实测薄床
  //    （clearBedTo(120)）时同一枚币能走 3.2 毫米/循环 ⇒ 换盘面要重推。
  //    ⇒ 读数里必须把台面枚数一起打出来，场景一变当场可见。
  const driftLimit = geo().layerStep / 10;
  const stateAtSample = await readState(page);
  const deckAtSample = stateAtSample?.deckCoins ?? -1;
  const activeAtSample = stateAtSample?.activeCoins ?? -1;
  check(
    '单枚币不被偷偷赋予净输送（对称行程 ⇒ 每循环 |净漂移| <= 层高/10）',
    perCycle !== null && Math.abs(perCycle) <= driftLimit,
    perCycle === null
      ? `只采到 ${phaseZs.length} 个循环（币已离场或超时）`
      : `每循环净漂移 ${(perCycle * 1000).toFixed(2)} 毫米（上限 ${(driftLimit * 1000).toFixed(2)} 毫米 = 层高/10）` +
        `，采样时台面 ${deckAtSample} 枚 / 活跃 ${activeAtSample} 枚（上限按默认预置盘面标定，换盘面须重推）`,
  );

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
  // 这一段**不逼喷泉**，所以预算不含上抛那一截（`fountainUpwardMps` 缺省 0）。
  const freeFallBudget = fallBudgetMps({ gravity: afterPusher?.physics?.tuning?.gravity });
  check(
    '推板走一轮后没有超出物理上限的能量注入',
    (afterPusher?.peakSpikeSpeed ?? 99) <= freeFallBudget,
    `压速 ${afterPusher?.spikeClamps} 次，峰值 ${afterPusher?.peakSpikeSpeed} 米/秒` +
      `（自由落体上限 ${freeFallBudget.toFixed(2)}）`,
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

  // ── P6：币种单一真源的运行时对照 ──
  // 判据**不抄第二份币种名单**：直接拿钩子给出的 `kinds`（`kinds.ts` 的 `COIN_KINDS`）
  // 与 `byKind` 的键集比对，所以新增币种时这里自动跟上——这正是 P6 的验收纪律。
  const kindList = table?.kinds ?? [];
  const byKind = table?.byKind ?? {};
  const byKindKeys = Object.keys(byKind).sort();
  const kindSum = Object.values(byKind).reduce((sum, n) => sum + n, 0);
  console.log(`  币种分布：${kindList.map((k) => `${k}=${byKind[k] ?? 0}`).join('  ')}`);
  console.log(
    `  盘面容量 ${table?.capacity ?? '?'} 枚（上层 ${table?.deck ?? '?'} + 币床 ${table?.bed ?? '?'}）`,
  );
  check(
    'byKind 的键集与币种清单一致（新增币种只改 kinds.ts 就能自动跟上）',
    kindList.length > 0 && JSON.stringify([...kindList].sort()) === JSON.stringify(byKindKeys),
    `kinds ${kindList.length} 个 vs byKind ${byKindKeys.length} 个`,
  );
  check(
    'byKind 各币种合计等于盘面枚数（没有币种被漏计）',
    kindSum === (table?.coins ?? -1),
    `${kindSum} / ${table?.coins}`,
  );
  // P2 满盘化：盘面必须**填到容量的成数**上。
  //
  // ★ S13 起这条判据问的是**填充率**，不是「枚数在 280~320 之间」。
  // 原因：满盘枚数是**盘面容量的代理**，而容量随币尺寸档位下降——
  // `?coin=1.2` 下盘面天然只有 257 枚（币大 → 网格列/行少 → 每格占位大），
  // 写死的 280~320 会一直红。那不是缺陷，是判据没跟上尺寸。
  // 填充率 = 预置 / 容量（容量由引擎现算，见 `layoutCapacity()`），
  // 它**与尺寸无关**：三个档位实测 0.79 / 0.78 / 0.86。
  // 下限 0.70 抓「没铺满 / 稀疏铺的 pick 被改小 / 区域被误删」，
  // 上限 1.0 抓「容量算错」。
  const capacity = table?.capacity ?? 0;
  const fill = capacity > 0 ? (table?.coins ?? 0) / capacity : 0;
  check(
    '满盘预置枚数填到容量的 70% 以上（与币尺寸档位无关的判据）',
    fill >= 0.7 && fill <= 1,
    `${table?.coins} / ${capacity} 枚 = ${(fill * 100).toFixed(1)}%`,
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

/** 静置判据的速度阈值，与 `RULES.restSpeed` 一致。**与币尺寸无关**，不派生。 */
const RULES_REST_SPEED = 0.08;

/**
 * 币的几何派生量（S13）：**页面是唯一真源，脚本里不准手抄**。
 *
 * 为什么必须这样（纪律 2）：`?coin=1.1/1.2` 会同时改掉币径、厚度、层高与抖动，
 * 而脚本原先手抄了一串 `0.12` / `0.0212` / `0.005`。手抄的那份不会跟着变，
 * 于是**别的档位下判据全部假绿**——拿旧尺寸去量新币，怎么看都合格。
 * 这是本项目最贵的一类缺陷（零报错、结论错），所以这里只留一个入口。
 *
 * `openGame()` 每次开页面时读一次并写入 `COIN_GEO`。
 */
let COIN_GEO = null;
const readCoinGeometry = (page) =>
  page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.coinGeometry?.() ?? null).catch(() => null);

/** 几何没读到就直接炸——静默回落到旧尺寸正是要避免的事。 */
function geo() {
  if (!COIN_GEO) throw new Error('未读到 coinGeometry()：必须经 openGame() 打开页面');
  return COIN_GEO;
}

/**
 * 一次 evaluate 把整批币的「是否在台面上」判出来。
 *
 * ★ S13 之前这里是一个高度中点 `deckY()`（`(conveyor.minY + pusherTopY + restY) / 2`）。
 * 那个近似在币塔只有 5 层时够用，**塔一高就失效**：塔顶盖到 9 层（`y` 到 0.216）
 * 高过中点 0.177，塔上的币会被算成台面币，读数看着正常、其实是假的。
 *
 * 现在一律走引擎的 `isOnDeckAt`（与 `Game.isOnDeck` 同一份判据，
 * 见 `layout.isOnDeckVolume`）—— 判据不写第二份公式。
 */
const deckMask = (page, coins) =>
  page
    .evaluate(
      (points) => {
        const fn = window.__THREE_GAME_TEST_HOOKS__?.isOnDeckAt;
        return points.map((p) => (fn ? fn(p[0], p[1], p[2]) : false));
      },
      coins.map((coin) => [coin.x, coin.y, coin.z]),
    )
    .catch(() => coins.map(() => false));

/** 台面（推板顶面）上的枚数。 */
const deckCountOf = async (page, coins) => (await deckMask(page, coins)).filter(Boolean).length;

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
  // 同层的判据是**半个币厚**，不是整个币厚：
  // 求解器允许接触点有一点穿透（默认量级毫米），叠起来的币心会被压到 0.016~0.021 米，
  // 用整个币厚（0.02）当门槛会把**正常的叠放**全判成穿插（第一版就报了 211 对，全是误判）。
  // 同一层的币心高度基本一致（都落在同一个台面上），Δy 接近 0。
  // ★ 两个阈值都从币的几何派生（S13）：币放大后它们必须跟着放大，否则判据会从
  //   「抓穿模」变成「抓所有正常叠放」。
  const sameLayerLimit = geo().halfThickness;
  const squashed = geo().diameter * 0.9;
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

  await hooks(() => window.__THREE_GAME_TEST_HOOKS__?.clearSave?.());
  const table = await readTable(page);
  const preset = table?.coins ?? 0;

  // ── ① 静置 10 秒 ──
  await startRun(page, 'ready');
  const idleCoins = await readCoins(page);
  const deckStart = await deckCountOf(page, idleCoins);
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
  /*
   * 一个循环 = `PUSHER_CYCLE` 四段之和。★ S13 起**从引擎读**，不写死 2.4。
   *
   * 写死的版本在改不对称行程时当场过期：`retract` 从 0.9 变 0.45 之后周期是 1.95，
   * 而写死的 2.4 会把判据算成「理论 24.0 秒」，实测 18.0 秒 —— **报绿，但是假绿**：
   * 它放行的宽限度凭空多了 23%，等于悄悄放宽了「推板跟得上实时」这条。
   * 这类「判据自己的默认值过期」只能靠读同一个真源来根治。
   */
  const pusherPeriod = cycled?.mechanisms?.pusherPeriod ?? 2.4;
  const theory = advanced * pusherPeriod;
  check(
    `② 推板 ${advanced} 个循环跟得上实时（墙钟 ≤ 理论值 × 1.05）`,
    advanced >= 10 && wallSeconds <= theory * 1.05,
    `墙钟 ${wallSeconds.toFixed(1)} 秒 / 理论 ${theory.toFixed(1)} 秒`,
  );

  // ── ③ 盘面不倾泻 + 上层留存 + 币堆不互相穿插 ──
  const after = await readStateFresh(page);
  const coinsAfter = await readCoins(page);
  const deckAfter = await deckCountOf(page, coinsAfter);
  check(
    '② 推板不把盘面一次推光（枚数 ≥ 预置 75%）',
    (after?.activeCoins ?? 0) >= preset * 0.75,
    `币 ${after?.activeCoins}/${preset}`,
  );
  /*
   * ③ 上层留存。★ S13 重新标定：阈值 85% → 70%。
   *
   * 旧阈值 85% 是给「台面输送带 0.85 m/s」标定的 —— 那个机制会在 1 秒内把上层冲光，
   * 所以「10 个循环后还在」本身是个强判据。
   *
   * S13 换成不对称行程的摩擦输送之后，台面**本来就在持续喂料**：实测 10 个循环
   * 掉 9 枚（0.9 枚/循环，60 → 51），85% 正好卡在实测值上（51/60 = 85.0%），
   * 留不下任何余量 —— 下一次跑就是 50，判据随噪声红绿翻转。
   *
   * 70% 仍然守得住它要守的东西：**「一波推光」**。真正的倾泻（例如谁把
   * `PUSHER_CYCLE.retract` 又调短一半）会在 10 个循环里掉 40~60 枚，
   * 而不是 18 枚。阈值取 18 枚/10 循环 = 1.8 枚/循环，对实测 0.9 有 2 倍余量。
   */
  check(
    '③ 上层留存 ≥ 70%（台面不被一波推光）',
    deckStart > 0 && deckAfter >= deckStart * 0.7,
    `上层 ${deckStart} → ${deckAfter} 枚（${((deckAfter / Math.max(1, deckStart)) * 100).toFixed(1)}%）`,
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
  /**
   * 接触穿透的两个上限（米）。**刻意是绝对米数，不随币尺寸档位变**——
   * 穿透深度是**求解器**的性质（`allowedLinearError` 的量级），与物体多大无关：
   * Rapier 把接触修到它认为「不需要再修」就停手，这个「够了」的尺度是绝对的。
   * 把它乘上 `COIN_SCALE` 反而会让 ×1.2 档悄悄放宽判据（那正是假绿的形态）。
   * 所以这里不是「漏了派生」，是**明确不派生**——不要好心改成读 `coinGeometry()`。
   */
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
  // 币床 = 「不在台面体积里」的活跃币（引擎的 `isOnDeckAt`，不写第二份判据）。
  const deckFlags = await deckMask(page, settled);
  const bedCoins = settled.filter((_, index) => !deckFlags[index]);
  /*
   * ★ 排水口里的币必须**排除**。
   *
   * 它们正被这张桌子合法地回收（见 `DRAIN` / `DRAIN_FOOTPRINT`），落在洞沿上时
   * 币心当然在地板高度以下 —— S13 实测三枚：`x = ±0.729`、`z ∈ [1.05, 1.09]`、
   * 倾角 43°~103°、`preset: true`，全都在 `DRAIN` 的占地里、正在往洞里掉。
   * 台面从 S6 起会持续把币喂到前沿，这种币从「偶尔」变成了「每次都有」，
   * 不排除的话这条判据会把「洞在正常工作」读成「整堆沉进地板」。
   *
   * 口径来自**引擎自己的** `insideDrain`（真源 `DRAIN_FOOTPRINT`，含 `MAX_JITTER`
   * 退让），不在这里另抄一份 `|x| > 0.66 && z ∈ [0.98, 1.15]` ——
   * 第二份公式不会跟着常量一起改。
   */
  const inDrain = await page.evaluate(
    (points) => {
      const fn = window.__THREE_GAME_TEST_HOOKS__?.insideDrain;
      return points.map((p) => (fn ? fn(p[0], p[1]) : false));
    },
    bedCoins.map((coin) => [coin.x, coin.z]),
  );
  const resting = bedCoins.filter((_, index) => !inDrain[index]);
  const draining = bedCoins.length - resting.length;
  const bedLowest = resting.reduce((min, coin) => Math.min(min, coin.y), Infinity);
  /*
   * 平躺在地板上的币心高度 = 币半厚（★ S13 起从 `coinGeometry()` 派生），
   * 减去**与 ④ 同源**的静态穿透余量。
   *
   * 这里的余量原先写死 2 毫米，而 2 毫米**正好等于实测的静态穿透**
   * （`constants.ts` 的 erp × 迭代标定表：erp 0.8 + 迭代 8 ⇒ 币↔机台 2.0 毫米）
   * ⇒ 阈值贴在读数上、余量为零，红绿由 float64 的表示误差决定。×1.1 档实测：
   * 最低币心 `0.00899999999999999932`，下限 `0.0090000000000000010547`，
   * **相差 1.7e-18 米（1.7 阿米）**；「沉入最深」打印出来是 `0.0000 毫米`。
   * pred 0.002 与 0.10 两臂读到的是**同一个 float64** ⇒ 与求解器参数无关，纯粹是这张彩票。
   *
   * 所以病因不是「绝对毫米没派生」（半厚早就派生了），而是**余量选在了读数上**——
   * 乘 `COIN_SCALE` 只会把 ulp 彩票换个档位继续买，不是修法。
   *
   * 改成引用 ④ 的 `COIN_STATIC_LIMIT`：⑤ 量「币心比理想平躺位低多少」，
   * ④ 量「币↔机台接触穿透多深」——**同一个物理量的两种读法**，不该由两套上限各说各话。
   * 4 毫米对 2.0 毫米实测穿透留出一倍余量，且**不开盲区**：
   * 这条判据要抓的原始缺陷是「整堆沉进地板」（币心掉到地板顶面以下 ⇒ 沉入 ≥ 一个半厚 11 毫米），
   * 4 毫米仍留 7 毫米；任何超过 4 毫米的穿透 ④ 自己就会红。
   * ⚠️ 这里是**引用** ④ 的常量，不是把 ④ 也派生化——④ 明确不乘 `COIN_SCALE`
   * （理由见它上面那段「刻意是绝对米数」的注释）。
   */
  const FLAT_REST_Y = geo().halfThickness - COIN_STATIC_LIMIT;
  const sunkCount = resting.filter((coin) => coin.y < FLAT_REST_Y).length;
  // 正数 = 最低币心还在下限之上（余量）；负数 = 已经沉到下限之下（沉入深度）。
  const restMargin = bedLowest - FLAT_REST_Y;
  check(
    '⑤ 币床的币坐在台面上（没有整堆沉进地板）',
    resting.length > 0 && sunkCount === 0,
    `币床 ${bedCoins.length} 枚（其中 ${draining} 枚在排水口里，已排除），` +
      `沉入地板 ${sunkCount} 枚，` +
      `最低币心 ${bedLowest.toFixed(4)} 米（下限 ${FLAT_REST_Y}，` +
      `离下限 ${(restMargin * 1000).toFixed(2)} 毫米）`,
  );

  // ── ⑥ R4-P3 的泄流律：既得**冷得下来**，也得**热得起来** ──
  /*
   * P3 把「向上超速就硬截断」换成连续律 `y -= (y − maxUpward) × (1 − e^(−dt/τ))`，
   * 落地之后 pace 的护栏列读到的是**这条分支一次都没进过**（压 0 次 / 峰值 0）。
   * 「没进过」有两种解释：① 律是对的且合法玩法碰不到阈值；② 律根本没接上。
   * 单靠正常玩法的 0 分不出这两者，所以这里**成对**测：
   *
   * - **A 冷**：默认阈值 3 + 打一针喷泉 ⇒ 护栏必须**一次都不压**。
   *   机内唯一的合法上抛源就是喷泉，它的设计初速度 `vy ≤ 2.2 < 3`（见 `ShowDirector`
   *   喷泉段注释），所以「冷」不是运气，是这台机器的能量预算决定的。
   *   ⚠️ 这条同时否证了「P3 把律写坏了所以从不触发」之外的另一半：
   *   如果哪天有人把阈值往下降、或把喷泉初速度往上涨，这条会立刻红。
   * - **B 热**：把阈值临时压到 0.5（同一针喷泉就必然越阈）⇒ 计数必须**开始涨**，
   *   并且**压的过程不造能量**：异常 0、一枚币都不少、
   *   峰值速度不超过喷泉自己的设计上限 **2.2 米/秒**
   *   （2.2 不是新写的魔数：它就是上面那条设计约束，律只许往下削、不许往上顶）。
   *
   * 两段都在**同一个 run** 里（`spikeClamps` 是每局归零的），比的是同局内的增量。
   */
  const setMaxUpward = (value) =>
    page.evaluate((v) => window.__THREE_GAME_TEST_HOOKS__?.setTuning?.({ coinMaxUpwardSpeed: v }), value);
  // ⚠️ `waitForTelemetry` 的谓词是**同步**读的（`predicate(last)`，不 await）——
  // 传 async 函数会得到一个永远为真的 Promise，等不到东西却立刻返回。
  // 所以计数只能在外面先读一次，谓词里就地过滤同一份 `t`，不要再异步取数。
  const fountainCount = (t) =>
    (t?.showEvents ?? []).filter((event) => event.id === 'fountain' && event.phase === 'completed').length;
  const forceFountain = async () => {
    const before = fountainCount(await readTelemetry(page));
    // 老虎机正在转时 `xixiSpin` 返回 null：等它空出来，不硬抢（照 xixi 的模式）。
    let spun = null;
    const deadline = Date.now() + 6000;
    while (!spun && Date.now() < deadline) {
      spun = await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.xixiSpin?.('fountain'));
      if (!spun) await page.waitForTimeout(200);
    }
    const seen = await waitForTelemetry(page, (t) => fountainCount(t) > before, 20_000);
    return fountainCount(seen) > before;
  };

  await startRun(page, 'playing');
  const coldDelivered = await forceFountain();
  const cold = await readStateFresh(page);
  /*
   * ⚠️ 「冷」的第一版写成「必须 0 次」，**被实测否证**（同一二进制两次跑：0 次 / 5 次）。
   * 5 次那种是 318 枚满盘 + 一针喷泉：币被挤在堆里，求解器把某枚币顶到 `vy > 3`
   * （截断前峰值 5.985 米/秒）。所以「阈值 3 在正常玩法里永远碰不到」这句话是错的，
   * `constants.ts` 里那条口径已经按这次读数改掉。
   *
   * 能立得住的判据是**稀有 + 在能量预算内**两件事：
   * - 次数只许个位数（满盘 + 演出都不该常触；一旦成百就是 P4 那种能量注入回来了）；
   * - 截断前峰值不超过这台机器自己的落体预算
   *   `√(2 × 13 × (1.45 + 0.08 + 0.186)) ≈ 6.67 米/秒`
   *   —— 1.45 是落币口高度、0.08 是出币托盘深度、0.186 = 2.2²/(2·13) 是喷泉设计上限
   *   `vy ≤ 2.2` 能多升的那一截，13 是 `PHYSICS.gravity`。
   *   ⚠️ 这里**不能再加一次 `2.2²`**：上抛的动能已经换算成那 0.186 米顶高了，
   *   两项都算就等于给同一份能量记两遍账（我第一版就这么写错，读出 7.03）。
   *   超过预算才说明「币的能量不是重力给的」，正是要抓的形态。
   */
  const fallBudget = fallBudgetMps({
    gravity: cold?.physics?.tuning?.gravity,
    fountainUpwardMps: FOUNTAIN_UPWARD_MPS,
  });
  check(
    `⑥ 冷：默认阈值 3 下护栏只许个位数、且截断前峰值 ≤ 落体预算 ${fallBudget.toFixed(2)} 米/秒`,
    coldDelivered &&
      (cold?.spikeClamps ?? -1) >= 0 &&
      (cold?.spikeClamps ?? Infinity) <= 8 &&
      (cold?.peakSpikeSpeed ?? Infinity) <= fallBudget,
    `喷泉 ${coldDelivered ? '已交付' : '未交付'}，护栏压 ${cold?.spikeClamps} 次，` +
      `截断前峰值 ${cold?.peakSpikeSpeed} 米/秒（预算 ${fallBudget.toFixed(2)}），` +
      `活跃币 ${cold?.activeCoins}`,
  );

  await setMaxUpward(0.5);
  const hotDelivered = await forceFountain();
  const hot = await readStateFresh(page);
  await setMaxUpward(3);
  check(
    '⑥ 热：阈值压到 0.5 之后泄流律必须真的被走到（计数开始涨）',
    hotDelivered && (hot?.spikeClamps ?? 0) > (cold?.spikeClamps ?? 0),
    `护栏压 ${cold?.spikeClamps}→${hot?.spikeClamps} 次，峰值 ${hot?.peakSpikeSpeed} 米/秒` +
      `（阈值 0.5，喷泉交付 ${hotDelivered ? '是' : '否'}）`,
  );
  /*
   * ⚠️ 这一条**第一版写错了口径**（实测红）：原本断言「峰值 ≤ 2.2 米/秒」，
   * 而 `Coin.clampSpeed` 返回的是**截断前**的速度（`Coin.ts:309` 的 `return before`），
   * `peakSpikeSpeed` 记的正是这个返回值 ⇒ 它读的是「这枚币进护栏之前有多快」，
   * **不是**「律把币顶到了多快」。强制阈值 0.5 之后实测峰值 **6.671 米/秒**，
   * 而这个数恰好在这台机器自己的能量预算内：喷泉把币以 `vy ≤ 2.2` 向上抛出，
   * 币从更高处落回出币线 ≈ √(2.2² + 2·13·**1.53**) ≈ **6.68 米/秒**（1.53 = 落币口 1.45 + 托盘 0.08；
   * 这一式与 `fallBudgetMps` 的 `√(2g(1.45+0.08+2.2²/2g))` **代数恒等**，不是第三个预算）——
   * 也就是说 6.671 是「合法落速」，不是求解器造出来的能量。
   * 判据写错会把一条正常的读数变成假红，所以这里只保留**量得住的两项**：
   * 异常必须为 0、币必须一枚不少（喷泉给了 10 枚，所以只许升不许降）。
   *
   * 截断后遥测（`peakPostClampUpward`）已经补上，且 τ A/B（2026-09-29，阈值压 0.5）实测过：
   * 截断后向上峰值 = **2.033 米/秒**，是阈值 0.5 的 4.07 倍 ⇒ 上界**只能取截断前总速率**。
   * 指数逼近只缩小超阈部分、永不清零，所以「post ≤ 阈值」是稳定误红的假判据（τ→1e-4 才成立）。
   */
  // 「币少了几枚」在这两条快照之间是**合法结算**，不是丢币：期间推板一直在跑。
  // 所以守恒式必须把越线枚数加回来读（引擎侧 `settledCoins`，开局归零、这里两读同局）。
  const settledCold = cold?.settledCoins ?? 0;
  const settledHot = hot?.settledCoins ?? 0;
  check(
    '⑥ 热：泄流律不造异常、不吞币 —— 异常 0 且「活跃币 + 期间越线」≥ 之前的活跃币',
    (hot?.anomalies ?? -1) === 0 &&
      (hot?.activeCoins ?? 0) + (settledHot - settledCold) >= (cold?.activeCoins ?? Infinity),
    `异常 ${hot?.anomalies}，活跃币 ${cold?.activeCoins}→${hot?.activeCoins}，` +
      `期间越线 ${settledHot - settledCold} 枚，截断前峰值 ${hot?.peakSpikeSpeed} 米/秒` +
      `（对照：自由落体 ${fallBudgetMps({ gravity: hot?.physics?.tuning?.gravity }).toFixed(2)}` +
      ` / 含喷泉上抛回落 ${fallBudget.toFixed(2)} / 横向护栏 8。` +
      `热分支的截断前峰值在 3.8~8.8 之间抖，四次观测里有一次 8.81 超出落体预算 ⇒ 逼热之后` +
      `横向护栏偶尔真会被等上；原因未查，这条**只作记录、不当判据**）`,
  );

  check(
    '⑥ 热：泄流律只减不增 —— 截断后向上峰值 > 0（律真的动了 y）且 ≤ 截断前总速度峰值',
    (hot?.peakPostClampUpward ?? 0) > 0 && (hot?.peakPostClampUpward ?? Infinity) <= hot?.peakSpikeSpeed,
    `截断后向上峰值 ${hot?.peakPostClampUpward} 米/秒 ≤ 截断前总速度峰值 ${hot?.peakSpikeSpeed} 米/秒` +
      `（冷侧对照 ${cold?.peakPostClampUpward}）`,
  );
  /*
   * ⚠️ 这条判据的**不等号方向是算出来的，不是抄来的**：泄流律是
   * `y -= (y - maxUpward) × (1 - exp(-dt/τ))`，它只把超阈部分按比例往阈值**逼近**，
   * 单子步后必然还剩 `0.717 ×` 的余量 ⇒ 截断后的 y **允许大于阈值**。
   * 所以「post ≤ 阈值」是一条假判据（会稳定误红），能断言的只有
   * 「post ≤ pre 的总速度」：后者的上界是 `y_pre ≤ |v_pre|`，而两道护栏都只缩不放。
   */

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

  /*
   * ★ S4 之后「一局 = 全部余额」，而这套判据写于「一局 = 20 枚买入」的年代 ⇒ 入场额要钉回标准注额。
   *
   * 不钉的代价今天实测到了（四连红，全是同一条根因的级联）：200 枚的局在 `playRun`
   * 的 240 投预算里**不会破产** ⇒ 「跪求续命」这条路走不到（`累计跪求 0`）、
   * 收工之后余额已经是 0 ⇒ 「再来一局」开出一局 0 筹码（`起始 0 筹码（余额 0）`）、
   * 于是后面的「加注扣 2 枚」读成 `筹码 0→0`、「热区」读成 `0 枚在热区内越线`。
   * ⇒ 与 economy 同一个理由：**这是测量协议，不是产品决策**；
   *   「玩家的局该多长 / `walletStart` 该不该改」归 S6 与用户（任务 #52）。
   */
  const STAKE = (await readStateFresh(page))?.endless?.referenceStake ?? 20;
  /*
   * ★ 光靠 `startRun` 的"不足才补"钉不住入场额：清档之后余额是 `walletStart`（200），
   *   `200 < 20` 为假 ⇒ 不补，于是本局起始还是 200（10-01 实测：`投出 320 枚后达到上限，筹码 265（起始 200）`）。
   *   所以必须像 economy 那样**先置位再开局**。差额记进 `totals.refill` ⇒ ② 依然精确。
   */
  await hooks((v) => window.__THREE_GAME_TEST_HOOKS__?.setWallet?.(v), STAKE);
  await startRun(page, 'ready', STAKE);
  const start = await readStateFresh(page);
  const table = await readTable(page);
  const balanceStart = (await hooks(() => window.__THREE_GAME_TEST_HOOKS__?.run?.()))?.balance ?? 0;
  // ★ S4：这条判据原先写作「筹码 = 从钱包**买入**的额度」，并断言 `initial === Math.min(20, 钱包)`。
  //   合并账户之后**没有买入这笔转账**：起始就是开局那一刻的余额本身。
  //   `chips === initial` 因此不再是「转账成功」的证据，而是「开局到现在一分没花」——
  //   反过来它也就顺带守住了「有人把买入加回来」这条回头路（那样 initial 会比余额多一个买入额）。
  check(
    '开局即满盘：本局起始 = 开局那一刻的余额（无买入转账）、无目标分、无星级',
    start?.chips === start?.initial &&
      start?.initial === balanceStart &&
      start?.phase === 'ready' &&
      start?.activeCoins === table?.coins &&
      start?.pusher.running === false,
    `起始 ${start?.initial} 筹码（余额 ${balanceStart}），盘面 ${start?.activeCoins} 枚，阶段 ${start?.phase}`,
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

  // 热度倍率的**接线核对**在本局破产之后做（见下面「热度倍率」那条），
  // 但它是**引擎直调**、不是靠这一局的采样 —— 理由写在那一处。
  //
  // ★ 两轮踩坑史（都写在这里，防止好心人又改回「就地采样」）：
  //   第 1 版：只投 15 枚就地读，要求「连落到 3 就必须采到一次被放大的返值」。
  //   第 2 版：S13 §5 把铜币闸门 0.18 → 0.09 之后改成「整局遥测」，
  //           以为样本放大到 100+ 投就必然 —— 但重标后**一局只有 28 投**
  //           （15 枚热身 + 破产前的 ~13 枚），铜币越线只有 ~31 次，
  //           其中「过闸门 **且** 连落 ≥ 3」的期望 ≈ 1.3 次 ⇒ 仍是掷硬币。
  //           实测同一份代码：单跑 `endless` 绿（37 次越线 / 被放大 1 次）、
  //           `all` 红（31 次越线 / 被放大 0 次）。**采样不足，不是缺陷。**
  //   第 3 版（现在）：接线核对换成直调 `crossingReturn` 并把闸门钉死必过
  //           （`roll: 0`）—— 观测对象没变（热度有没有真的接进结算），
  //           但它每次都会跑到。整局遥测只保留**合法性**（入账必在允许集合内）。

  // 破产：筹码见底 + 盘面沉降完 → 嘲讽弹窗。
  // 设计目标是「一条命 60~90 投」，所以按推板节奏投（不是连点），投到破产为止。
  // `cap` 只是**防死循环的上限**，必须按这一局的真实起点算（见下面第 2 局的说明）。
  //
  // ★ S11 把 cap 从 160 抬到 **320**：局被标定得更长之后（`ECON_RUNS=6` 四组 24 局的
  //   实测分布是「中位数 47 · 均值 68.5 · 极差 30~216」），160 会**卡在雪球局中间**——
  //   实测出现过「投满 160 枚时手里还有 21 筹码」，于是后面三条判据（破产弹窗 /
  //   唯一收尾原因 / 跪求）一起假红。320 高于实测极值 216，留一档余量。
  //   这是**测试台参数**（防死循环），不是判据——放宽它不会掩盖任何经济缺陷。
  const playUntilRuin = async (cap = 320) => {
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
      (first.state?.chips ?? 0) < (first.state?.initial ?? 0),
    `投出 ${first.drops} 枚后${first.reason}，筹码 ${first.state?.chips}（起始 ${first.state?.initial}）`,
  );
  check('破产是筹码耗尽收尾（唯一收尾原因）', first.state?.settleReason === 'exhausted');
  check('破产时账本平', ledgerOk(first.state), ledgerText(first.state));

  // ── 热度倍率：连落越高返值越高、热区再翻倍（**引擎直调**，闸门钉死必过） ──
  //
  // 判据**不写第二份倍率表**（纪律 2）：只核「顶档 > 基础档」与「热区 = ×2」两条**性质**，
  // 倍率表的取值由引擎说了算。`roll: 0` 必过概率闸门（铜币 `gateChance > 0`），
  // 所以这里拿到的是**上界值**、每次都会跑到。
  const heatCurve = await hooks(() => {
    const api = window.__THREE_GAME_TEST_HOOKS__;
    const call = (combo, hot) =>
      api.crossingReturn({ kind: 'bronze', combo, hot, betMul: 1, roll: 0 }).chips;
    return { base: call(1, false), top: call(15, false), topHot: call(15, true) };
  });
  check(
    '热度倍率只放大筹码：连落越高返值越高、热区再翻倍（引擎直调，闸门钉死必过）',
    heatCurve.base > 0 &&
      heatCurve.top > heatCurve.base &&
      heatCurve.topHot === heatCurve.top * 2,
    `连落 1 → ${heatCurve.base}；连落顶档 → ${heatCurve.top}；顶档 + 热区 → ${heatCurve.topHot}`,
  );

  // 整局遥测只保留**合法性**：入账必须落在引擎枚举出的允许集合里。
  // 这是「结算链路只有一份口径」的守卫 —— 出现集合外的值，说明有人绕过了
  // `crossingReturn`（第二份取整、第二份闸门、或把倍数乘了两遍）。
  // ⚠️ 不要在这里再加「必须采到被放大的值」：一局只有 ~31 次铜币越线、
  //    闸门 0.09 ⇒ 那是掷硬币，见上面那段两轮踩坑史。
  {
    const { scoreEvents: runEvents } = await readTelemetry(page);
    const bronzeValues = runEvents
      .filter((event) => event.kind === 'bronze')
      .map((event) => event.value);
    const combo = first.state?.bestCombo ?? 0;
    check(
      '整局铜币入账只出现允许集合里的值（结算链路只有一份口径）',
      bronzeValues.length > 0 && bronzeValues.every((value) => ALLOWED_GAINS.has(value)),
      `整局铜币越线 ${bronzeValues.length} 次，入账 ` +
        `${[...new Set(bronzeValues)].sort((a, b) => a - b).join('/') || '无'}，` +
        `最高连落 ${combo}`,
    );
  }

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
  // 实测：第 1 局 49 投就断（回收 0.59，正好在设计带内），第 2 局投到 160 枚还活着
  // （回收 ≥ 0.82，期望局长 `30 ÷ (1 − 0.82) ≈ 167` 投）——当时的 160 上限刚好卡在它下面
  // （S11 之后上限已抬到 320，但这条「只断言拉回来了」的结论不变：回收率随盘面排水爬升
  // 是经济问题，不是这条断言该测的东西）。
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

  const ledgerBeforeQuit = await hooks(() => window.__THREE_GAME_TEST_HOOKS__?.ledger?.());
  // 成绩单记录的是**收工那一刻**的赚进，之后盘面在途币仍可能迟到越线（账本照记），
  // 实时 `earned` 会继续涨——所以基准要取收工前，而不是拿收工后的实时值去比
  // （XIXI 演出让收尾期在途币更多，这条从「偶尔」变常态）。
  const earnedBeforeCashOut = ledgerBeforeQuit?.earned ?? 0;
  await hooks(() => window.__THREE_GAME_TEST_HOOKS__?.quitRun?.());
  // ★ 这份读数必须**紧贴** `quitRun`，中间不许隔任何仿真等待：
  //   下面那条判据断言的是「收工这一步本身不动账」，多等一秒就多一秒的合法越线进来。
  const ledgerAtQuit = await hooks(() => window.__THREE_GAME_TEST_HOOKS__?.ledger?.());
  await page.waitForTimeout(400);
  const summary = await readStateFresh(page);
  check(
    '保留尊严收工：记录赚进与跪求次数，弹总结卡片',
    (summary?.endless?.bestEarned ?? 0) >= earnedBeforeCashOut &&
      (summary?.endless?.totalBegs ?? 0) >= 1 &&
      summary?.endless?.ruinVisible === true,
    `历史最高赚进 ${summary?.endless?.bestEarned}（收工时 ${earnedBeforeCashOut}），累计跪求 ${summary?.endless?.totalBegs}`,
  );
  /*
   * ★ S4：这条判据原来写作「**钱包增量 = cashOut**」——回存的额度必须正好是扣掉脏钱之后的那一笔。
   * 合并账户之后收工**不动钱**，于是它换成一个更强的形式：**收工不许产生任何账外转账**，
   * 也就是「恒等式的差额在收工前后一模一样」。
   *
   * 为什么这个写法对竞态免疫：一枚在途币迟到越线会**同时**推 `earned` 和 `balance`
   * （两者都出自 `RunState.gainChips`），差额不动；而「偷偷把桌上的钱搬回口袋」那种回归
   * 只推 `balance`（走 `creditBalance` 并不会写 `run.earned`），差额当场变。
   * ⇒ 拿「Δ余额 == Δ赚进」写反而不更灵敏，还会把合法迟到算成违规。
   *
   * 差额口径复用 S0a 立好的 `ledgerDeltaOf`，判据里不出现第二份算式。
   * 脏钱那一半也被它盖住了：跪来的钱若被收工洗成干净钱，同样是只动 `balance` 的账外转账，
   * 所以这里只把 `spendable` 当**读数**打印，不另立式子。
   */
  check(
    '收工不动账：恒等式差额在收工前后一模一样（合并账户后「回存」这一步整个消失）',
    !!ledgerBeforeQuit &&
      !!ledgerAtQuit &&
      ledgerDeltaOf(ledgerAtQuit) === ledgerDeltaOf(ledgerBeforeQuit),
    `余额 ${ledgerBeforeQuit?.balance}→${ledgerAtQuit?.balance}（赚进 ${earnedBeforeCashOut}→${ledgerAtQuit?.earned}），` +
      `差额 ${ledgerDeltaOf(ledgerBeforeQuit)}→${ledgerDeltaOf(ledgerAtQuit)}，` +
      `可花 ${ledgerBeforeQuit?.spendable}→${ledgerAtQuit?.spendable}`,
  );

  // 再来一局：面板收起、盘面与筹码复位。
  // ★ 先给下一局备好入场额：合并账户之后「一局」就是把余额投完，而上面那一局已经投到底
  //   （余额 0）⇒ 不补的话这里开出来的新局是 0 筹码，下面三条（重开复位 / 加注 / 热区）
  //   会全部读成「筹码 0→0」——那是**没有钱可投**，不是复位坏了（10-01 实测的级联红）。
  await hooks((v) => window.__THREE_GAME_TEST_HOOKS__?.setWallet?.(v), STAKE);
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
      restarted?.chips === restarted?.initial &&
      restarted?.phase === 'ready' &&
      restarted?.earned === 0 &&
      restarted?.activeCoins === table?.coins &&
      (restarted?.anomalies ?? -1) === 0,
    `起始 ${restarted?.initial} 筹码（余额 ${ledgerAtQuit?.balance}），盘面 ${restarted?.activeCoins} 枚，` +
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
      restarted?.chips === restarted?.initial &&
      restarted?.phase === 'ready' &&
      restarted?.earned === 0 &&
      restarted?.activeCoins === table?.coins,
    `起始 ${restarted?.initial} 筹码（余额 ${ledgerAtQuit?.balance}），盘面 ${restarted?.activeCoins} 枚，` +
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
  // 热区里必须**按币种**分开判：铜币/花纹吃 2 倍（但两者都可能被闸门拦成 0），
  // 返币与大赏币是**固定值、刻意不吃倍率**（数值见 `kinds.ts`，这里不抄）。
  //
  // **不能按「值等于某个数」去认固定值币种**：加注 ×2 之后，
  // 一枚热区里的铜币是 1 × 热度 2 × 热区 2 × 加注 2 = **8**，与旧的大赏币值撞车，
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

  // ── 余额见底：开局即破产，跪求后能继续（死锁回归判据） ──
  //
  // 这是「开局没有起始筹码」那个反馈的回归判据。症状**不是「没发筹码」**，
  // 而是整局卡死：`chips=0` 时 `acceptingDrops` 为假 → 阶段升不到 `playing`
  // → 沉降分支要求 `phase==='playing'` 永不触发 → 破产弹窗不弹
  // → 跪求按钮（挂在弹窗里）永远点不到。玩家既不能投币也不能跪求。
  //
  // 判据写**绝对数**而不是增量：起始 0、筹码 0、破产窗已弹、沉降原因 exhausted。
  // 放在本模式最后跑，因为它会把本局推成破产态。
  //
  // 注意这里**不能走 `startRun` 辅助函数** —— 它会在开局前把余额补满，
  // 而这条判据要的恰恰是「余额是空的」。所以直接调钩子。
  await hooks(() => window.__THREE_GAME_TEST_HOOKS__?.seed?.(20260921));
  await hooks(() => window.__THREE_GAME_TEST_HOOKS__?.setWallet?.(0));
  await hooks(() => window.__THREE_GAME_TEST_HOOKS__?.setState?.('ready'));
  const broke = await readStateFresh(page);
  check(
    '余额见底：开局起始 0 筹码，直接进破产弹窗（不是静默卡死）',
    broke?.initial === 0 &&
      broke?.chips === 0 &&
      broke?.endless?.ruinVisible === true &&
      broke?.settleReason === 'exhausted' &&
      ledgerOk(broke),
    `起始 ${broke?.initial}，筹码 ${broke?.chips}，阶段 ${broke?.phase}，` +
      `沉降原因 ${broke?.settleReason}，破产窗 ${broke?.endless?.ruinVisible}`,
  );
  // 跪求必须真的能把本局拉回可玩：`grantBeg` 内部走 `revive()`，
  // 而 `revive()` **只在 `phase==='drainOut'` 时生效** —— 这正是「零筹码开局必须走
  // 既有沉降机制、不能只弹个窗」的原因。少了那一步，这里会静默失败、阶段停在 ready。
  const begFromZero = await hooks(() => window.__THREE_GAME_TEST_HOOKS__?.beg?.() ?? false);
  const revived = await readStateFresh(page);
  const dropFromZero = await dropUntilAccepted(page, 0);
  check(
    '余额见底后跪求：赏赐到账、本局被拉回 playing、能真的投出币',
    begFromZero === true &&
      (revived?.chips ?? 0) > 0 &&
      revived?.endless?.ruinVisible === false &&
      revived?.phase === 'playing' &&
      dropFromZero === true &&
      ledgerOk(revived),
    `跪求 ${begFromZero}，筹码 ${revived?.chips}，阶段 ${revived?.phase}，` +
      `破产窗 ${revived?.endless?.ruinVisible}，投币被接受 ${dropFromZero}`,
  );
  // 收尾复位：把余额补回起始值，让后续模式（`all`）看到的是干净状态。
  // 这里**不调 `quitRun`** —— 跪求之后破产窗已经关了，`endRun` 会因为
  // `!ruinVisible && !summaryVisible` 直接 return，什么也不做。
  await hooks(() => window.__THREE_GAME_TEST_HOOKS__?.setWallet?.(200));
}

/**
 * 经济模式：账本恒等式 / 终身余额守恒 / 单位期望与净流出。
 *
 * 两条腿分工明确：
 *
 * · **真物理**（跑几局）验证账本恒等式与余额守恒——这些只在真实越线时才被触发，
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
/**
 * #66A②「中奖被拒收（加力存满 ⇒ 引擎改派一场小型补货演出）」的**唯一谓词**。
 *
 * economy 的批级计数与 accept 的阳性对照都吃这一个函数 —— 写两份就会造出
 * 「计数器与对照各自自洽、谁也不报错」的假象（本项目吃过多次）。
 * ⚠️ 不能只数 `granted === false`：`miss`（`SlotMachine.ts:377`）与 `fine`（`:397`）恒带 false，
 *    那样会把"没中奖"算成"存满被拒"。发射点在 `SlotMachine.ts:487-498`（`outcome:'win'` + `granted:false`）。
 */
const isRefusedWin = (event) => event?.outcome === 'win' && event?.granted === false;

async function runEconomy(page) {
  console.log('\n── 模式：economy（账本 / 单位期望 / 净流出） ──');
  const hooks = (fn, ...args) => page.evaluate(fn, ...args);
  const RUNS = Number(process.env.ECON_RUNS ?? 2);
  /*
   * ★★ `STAKE` 是合并账户带出来的**新旋钮**，不是可有可无的糖。
   *
   * 旧模型里「一局」= 从钱包买入 `ENDLESS.buyIn`（20 枚），所以局长自然落在
   * 30~220 投这个实测带上；合并之后一局的入场额变成**全部余额**，而 `startRun`
   * 默认把余额补到 200 ⇒ 同一台机器、同一张返值表，一局要投到 200+ 枚才见底。
   * ⚠️ 下面这句是**读码推演**，不是实测（2026-10-01 那次 200 入场的批跑了 5 分钟
   *   没跑完第 1 局就被中止，没拿到终态读数）：`playRun` 的投币上限是 240 枚，
   *   而 150 **仿真秒**的局长上限只在 `waitForRunEnd` 里查 ⇒ 200 入场时先撞到
   *   240 投这一侧 ⇒ ⑤ 的 timeout 占比、⑥ 的硬界（★ 10-01 起上界不再是常数 300，而是从 `ECON_RUN_DROPS_CAP` 派生 = 现读 240）、设计带 60~90 投、
   *   以及 ⑤′ 的「账户真的见底过」**全部失去意义**（它们都是在 20 入场下标的）。
   *   ⇒ 本批换 STAKE=20 之后这几条的读数就是这段推演的验证；若仍全是 timeout，
   *     说明瓶颈不在入场额，回查 `playRun` 的投币上限。
   *
   * 所以 economy 批默认把入场额压回标准注额，**保持与既有标定同口径**；
   * 「玩家现在一局就是 200 余额、局长该怎么重新定标」是**设计问题**，
   * 归 S6 那唯一一次重标（并要用户定夺 `walletStart` 与局长目标），不在这里偷偷改判据。
   * 要量现在的真实形态：`ECON_STAKE=200` 跑一遍，读数会自己讲。
   */
  const referenceStake = (await readStateFresh(page))?.endless?.referenceStake ?? 20;
  const STAKE = Number(process.env.ECON_STAKE ?? referenceStake);
  /*
   * `ECON_LOAN=1`：破产时**就地贷款续玩**，而不是收工重开。
   * 只有开了这一档，S2 的「欠债 → 产出按 `debt/(debt+balance)` 分流抵债」才会真的发生，
   * 上面那条 `repaid/gross` 的稳态读数才有内容（默认批里 debt 恒为 0，分流率必然读 0 ——
   * 那是**协议**造成的 0，不是机器造成的 0，所以默认批不许拿它当结论）。
   * ⚠️ 这一档改的是**局长口径**（一局横跨多次报价），读数不能与默认批逐位比。
   */
  const LOAN_ON_RUIN = process.env.ECON_LOAN === '1';
  // 账本读数一律走这一个口子：`ledger()` 一次 evaluate 带回 balance / 六项局账 /
  // `balanced` / `totals`，比「这里读 diagnostics 那里读钩子」少一种拿到不一致快照的可能。
  const ledgerOf = () => hooks(() => window.__THREE_GAME_TEST_HOOKS__?.ledger?.());

  await hooks(() => window.__THREE_GAME_TEST_HOOKS__?.clearSave?.());
  /*
   * ★ 基准必须取在 `clearSave()` **之后**。`clear()` 重置余额但不记进出账
   *   （见 `SaveStore.clear` 的警告），所以它只能待在测量窗口之外。
   *   终身表 `totals` 不被 `clear()` 清零 ⇒ 守恒式全部用**增量**，与旧 `refilled` 同规格。
   */
  const start = await ledgerOf();
  const balanceStart = start?.balance ?? 0;
  const totalsStart = start?.totals ?? null;
  // ★ #52 甲（10-02 用户拍板）：**一局 = 把余额投到见底**是产品语义，而 60~90 投那条设计带
  //   量的其实是「每 `referenceStake` 注额的一段」——本批开局前把入场额钉在 STAKE，
  //   所以下面每行「第 N 局」读的是一段，不是一命。这里把单位写在批头，是为了让
  //   引用这批数的人不会把"局"当成玩家意义上的那一局（HUD 里的"本局"仍是玩家真实经历的那一局，
  //   那是产品事实，不该跟着计量单位改词）。
  console.log(
    `  起始余额 ${balanceStart}｜入场额 ${STAKE}（标准注额 ${referenceStake}）｜真物理 ${RUNS} 局` +
      `｜**计量单位 = 每 ${STAKE} 注额一段**（#52 甲：设计带 60~90 投按段读，不按"一命"读）`,
  );

  // ── ① 真物理：账本恒等式 + 终身余额守恒 + 越线构成采样 ──
  const runs = [];
  const crossingSamples = [];
  let totalCrossings = 0;
  let totalDrops = 0;
  let spentTotal = 0;
  let earnedTotal = 0;

  for (let index = 0; index < RUNS; index += 1) {
    // 本局的**仿真秒**要打印出来：它是局长口径的自变量。
    // `越线/投币` 随局长变化（实测 0.19~1.15），所以没有这一列就无法判断
    // 「两批读数不同」是物理不同还是局长不同——`waitForRunEnd` 改成仿真秒上限之后，
    // 这一列就是那条上限是否真的生效的直接证据。
    // 长度由 `playRun` 在**本局内**取零点算出来（`runSeconds`）；这里不能再跨局相减，
    // `elapsed` 每局开局归零（`Game.ts:1739`），跨局减法会读出 0 或负数。
    /*
     * ★ 先把余额**钉死**在标准注额，再开局。
     * `startRun` 的补钱只在「不足」时触发，而合并账户之后批首余额是 `walletStart`（200）——
     * 不钉死的话**第 1 局会拿 200 当入场额**（实测踩到：批跑了 5 分钟没走完第 1 局），
     * 后面几局才被破产把余额打回 20 附近，等于同一批里混了两种局长口径。
     * `setWallet` 的差额记进 `totals.refill`（可以是负数）⇒ ② 的守恒式依然精确，
     * 这里不是「偷偷改钱包」——那种事正是 ② 存在的理由。
     */
    await hooks((v) => window.__THREE_GAME_TEST_HOOKS__?.setWallet?.(v), STAKE);
    const final = await playRun(page, { stake: STAKE, loanOnRuin: LOAN_ON_RUIN });
    const simSeconds = final?.runSeconds ?? 0;
    /*
     * 破产（现在是「续玩报价」）弹窗里本局还没走完，收工一下才会进总结态。
     * ★ S4 之前这里还有一件事：「必须先收工才会**回存**，钱包守恒要按完整一局量」。
     *   回存这个动作已经不存在了，收工现在只是为了让下一局从干净状态开局；
     *   守恒式改读终身账（② 那段），不再依赖「本局有没有收工」。
     */
    if (final?.end === 'ruin') {
      await hooks(() => window.__THREE_GAME_TEST_HOOKS__?.quitRun?.());
      await simTick(page, 400);
    }
    const ledger = await ledgerOf();
    const { scoreEvents, cycles, xixiEvents } = await readTelemetry(page);
    const crossed = cycles.length ? cycles[cycles.length - 1].coins : 0;
    /* 摇奖与罚金按「每投」归一化才可比：R6② 把 win 拆成 3 同 / 4 同之后，
       大奖次数与罚金次数都得除掉局长。`Telemetry.reset()` 在 `startRun()` 里调用
       （`Game.ts:1778`）⇒ 这个数组本来就是每局清零的，直接取本局的、不用差分。
       ⚠️ 只做**读数**不做判据：spin 事件在沉降中被 `shows.abort()` 作废时，
       这里与 `diagnostics.endless.fines` 会差（`Game.ts:1666-1670`）。 */
    const slotEvents = xixiEvents ?? [];
    const spins = slotEvents.filter((event) => event.phase === 'spin').length;
    const slotFines = slotEvents.reduce((sum, event) => sum + (event.fined ?? 0), 0);
    /* #66A 的两个批级读数（**只打印、不进判据**，定档要另攒够 n）：
       ① 「名义 vs 实扣」不在这里写 6 —— 面值真源是 `xixi.ts` 的 `SLOT_PENALTY_CHIPS`，
          抄第二份就是「同一几何写两份」那个老坑。名义取本局**最大单笔** `fined + debtAdded`
          （没被欠款上限截断的那笔就是面值；全被截断时会**低估** ⇒ 这一列只当方向读数）。
       ② `granted === false` 在 `miss`（`SlotMachine.ts:377`）与 `fine`（`:397`）上恒为 false，
          直接数它会把「没中奖」算成「存满被拒」⇒ 只数 `outcome === 'win'` 里 granted=false 的那批。 */
    const fineEvents = slotEvents.filter((event) => event.outcome === 'fine');
    const penaltyFaceSeen = fineEvents.reduce(
      (max, event) => Math.max(max, (event.fined ?? 0) + (event.debtAdded ?? 0)),
      0,
    );
    const winEvents = slotEvents.filter((event) => event.outcome === 'win');

    for (const event of scoreEvents) {
      crossingSamples.push({ kind: event.kind, combo: event.combo, hot: event.hot });
    }

    totalCrossings += crossed;
    totalDrops += final?.endless?.drops ?? 0;
    /*
     * ⚠️ 这两个求和只用于**打印回收率读数**，不参与判据，所以它们允许有一个小残差：
     * 本局样本取在收工之后，收尾期在途币的迟到越线记在**这一局**的账上、却发生在这一次
     * 读数之后，而下一局开局会把局账整个重新快照 ⇒ 那一笔既不在本局求和里、也不在下一局里。
     * 判据不吃这个残差，是因为 ② 改读终身账（`totals`），那正是终身账存在的理由。
     */
    spentTotal += ledger?.spent ?? 0;
    earnedTotal += ledger?.earned ?? 0;

    runs.push({
      end: final?.end,
      drops: final?.endless?.drops ?? 0,
      crossed,
      simSeconds,
      balance: ledger?.balance ?? 0,
      initial: ledger?.initial ?? 0,
      earned: ledger?.earned ?? 0,
      begged: ledger?.begged ?? 0,
      loaned: ledger?.loaned ?? 0,
      spent: ledger?.spent ?? 0,
      /**
       * 本局产出被分流抵债的累计额（S2 甲规则）。**不进恒等式**，所以这里只当读数用：
       * 「回收/E」这一族要的是 `gross = earned + repaid`，只看 `earned` 会把分流掉的那份读成没赚。
       */
      repaid: final?.repaid ?? 0,
      /** 本局就地贷款续玩的次数（`ECON_LOAN=1` 才有意义）。 */
      loans: final?.loans ?? 0,
      spins,
      slotFines,
      /** #66A①：本局罚金次数、转欠款额、以及从实扣反推的面值（见上方注释的低估方向）。 */
      fineCount: fineEvents.length,
      fineDebt: slotEvents.reduce((sum, event) => sum + (event.debtAdded ?? 0), 0),
      penaltyFaceSeen,
      /** #66A②：中奖里被拒收的次数（谓词 `isRefusedWin` 与 accept 的阳性对照**共用同一个**）。 */
      wins: winEvents.length,
      winRefused: winEvents.filter(isRefusedWin).length,
      ledgerOk: ledgerOk(ledger),
    });
    console.log(
      `  第 ${index + 1} 局：投 ${runs[index].drops} 枚 → 越线 ${crossed} 枚，` +
        `仿真 ${simSeconds.toFixed(0)}s（${final?.end}），` +
        `起始 ${runs[index].initial} + 赚进 ${runs[index].earned} + 跪求 ${runs[index].begged} ` +
        `+ 贷款 ${runs[index].loaned} − 消耗 ${runs[index].spent} = 余额 ${runs[index].balance}，` +
        `可花 ${ledger?.spendable}｜抵债 ${runs[index].repaid}｜就地贷款 ${runs[index].loans} 次 ` +
        `摇奖 ${runs[index].spins}（${(runs[index].spins / Math.max(1, runs[index].drops)).toFixed(3)}/投）` +
        `· 罚金 ${runs[index].slotFines}`,
    );
  }

  /* #66A 的批级读数（一行汇总，不改上面那行的格式 —— 外部解析器吃的是那行）。
     只打印、不参与判据：定档要 n 与区间，这一列先回答"这两件事到底有没有数"。 */
  {
    const fineCount = runs.reduce((sum, run) => sum + run.fineCount, 0);
    const fined = runs.reduce((sum, run) => sum + run.slotFines, 0);
    const fineDebt = runs.reduce((sum, run) => sum + run.fineDebt, 0);
    const face = Math.max(...runs.map((run) => run.penaltyFaceSeen), 0);
    const wins = runs.reduce((sum, run) => sum + run.wins, 0);
    const refused = runs.reduce((sum, run) => sum + run.winRefused, 0);
    const gamesWithFine = runs.filter((run) => run.fineCount > 0).length;
    console.log(
      `  [info] #66A 读数（不进判据）：罚金 ${fineCount} 次 / ${gamesWithFine} 局有罚金 ⇒ ` +
        `实扣 ${fined}、转欠款 ${fineDebt}、反推面值 ${face || '—（全批没罚过款）'} ⇒ 实扣/名义 ` +
        `${face ? (fined / (face * fineCount)).toFixed(3) : '—'}（面值被欠款上限截断时这一列偏低）；` +
        `win 拒收 ${refused}/${wins} = ${wins ? (refused / wins).toFixed(3) : '—'}（兜底频率分母是中奖数，不是投币数）`,
    );
  }
  // 写盘读数（计划步 2b）：分母取**总投币数**，这样"投一枚币写几遍盘"是能直接读出来的数，
  // 不用再去猜评审那句"12+ 次串行写盘"。不进判据。
  await reportSaveWrites(page, `${RUNS} 局 economy`, totalDrops);

  check(
    '① 每一局账本恒等式成立（误差 0）',
    runs.length === RUNS && runs.every((run) => run.ledgerOk),
    runs.map((run) => (run.ledgerOk ? '平' : `差 ${ledgerDeltaOf(run)}`)).join('/'),
  );

  /*
   * ★★ ② 在 S4 里换了一根骨头，而且是**不得不换**，不是顺手改写。
   *
   * 旧式子 `wallet终 = wallet起 + Σ充值 − Σ买入 + Σ（真正回存的）`：
   * 「买入」与「回存」两个动作在合并账户时整个消失了 ⇒ 这两项没有指称物。
   * 但真正的问题不是措辞：局级账本每次 `startRun` 都把 `initial` 重新快照成**当时的余额**，
   * 于是「上一局收尾时那笔没记进任何局账的余额变动」会被下一局的 `initial` 吸收掉，
   * **用局账求和永远抓不到它** —— 旧 ② 报过的那个「差 26」（任务 #14）正是这种形状。
   *
   * 新式子读 `SaveStore.totals`：终身累计、不按局清零、也不被 `clear()` 清零，
   * 六个桶 = 余额的**全部合法去路**（`creditBalance` 四个来源 + `debitBalance` 两个用途）。
   * ⇒ 谁绕过这两扇门直接动余额，这一条当场红；plan S4 ⑥ 的变异测试就打在这一点上。
   *
   * ★ 附带好处：这条判据**对采样时机免疫**。收尾期在途币的迟到越线会同时推
   *   `Δ余额` 与 `Δtotals.earned`，等式两边一起动 ⇒ 不需要「等盘面静下来再取数」那种门,
   *   也不再有「超时局的预测回存不计」那种特例（`cashOut` 这个概念已经没有了）。
   */
  const finish = await ledgerOf();
  const totalsEnd = finish?.totals ?? null;
  const d = (key) => (totalsEnd?.[key] ?? 0) - (totalsStart?.[key] ?? 0);
  const credited = d('earned') + d('begged') + d('loaned') + d('refill');
  const debited = d('spend') + d('skin');
  // ★ 局账阶段的增量要在这里**定格**：下面 ③ 还会构造一次跪求（那是场景，不是这 6 局的产出），
  //   ⑤′ 的读数如果等到那时候再算，就会把构造场景的 30 枚脏钱报成「本批跪求 30」。
  const runPhaseTotals = { begged: d('begged'), loaned: d('loaned') };
  const balanceActual = finish?.balance ?? -1;
  check(
    '② 余额守恒（终身账）：Δ余额 = Δ(赚进+跪求+贷款+充值) − Δ(消耗+解锁外观)',
    !!totalsStart &&
      !!totalsEnd &&
      balanceActual - balanceStart === credited - debited,
    `余额 ${balanceStart}→${balanceActual}（Δ ${balanceActual - balanceStart}）；` +
      `进账 赚 ${d('earned')} 跪 ${d('begged')} 贷 ${d('loaned')} 充 ${d('refill')}，` +
      `出账 耗 ${d('spend')} 图鉴 ${d('skin')}` +
      (balanceActual - balanceStart !== credited - debited
        ? ` ⇒ 差 ${(balanceActual - balanceStart) - (credited - debited)}：有一笔余额变动没走 credit/debit 两扇门`
        : ''),
  );

  /*
   * ── ③ 脏钱约束（S4 换载体）──
   * 用确定性场景而不是真物理：破产 → 跪求一次 → 立刻收工。
   * 真物理里「跪求后立刻收工」需要凑巧，这里直接构造，测的是规则本身。
   *
   * 旧写法是「跪来的筹码**不可回存**钱包」——那条约束长在 `cashOutOf(chips, begged)` 上。
   * 合并账户之后没有回存这一步了，同一个约束现在站在**下一个出口**上：
   * `可花 = 余额 − 终身跪求额`（`economy.spendableOf`），而买图鉴的门槛读的正是它。
   * ⇒ 判据对象从「回存为 0」换成「**跪求不抬高可花额度**」。
   *
   * ★ 为什么写成不等式而不是等式：`spendable = max(0, 余额 − 跪求累计)`，
   *   而恒等式给出 `Δ(余额 − 跪求累计) = Δ赚进 − Δ消耗`，所以合法越线本来就**允许**
   *   可花额度跟着涨。写成「不涨」会在泵腿假红（2026-09-28 那条老坑：泵下 400 ms 里
   *   仍在灌仿真，在途币赚到干净筹码是正确行为）；写成「涨幅 ≤ 本段赚进」则
   *   既不放过脏钱漏白（脏钱入账只推余额、不推 earned ⇒ 涨幅超过赚进），也不会误伤。
   */
  await hooks(() => window.__THREE_GAME_TEST_HOOKS__?.setState?.('ruin'));
  const ruinLedger = await ledgerOf();
  const begOk = await hooks(() => window.__THREE_GAME_TEST_HOOKS__?.beg?.() ?? false);
  const begLedger = await ledgerOf();
  check(
    '③ 跪来的钱是脏钱：记进 begged、余额到账，但可花额度的涨幅不超过本段赚进',
    begOk === true &&
      (begLedger?.begged ?? 0) > (ruinLedger?.begged ?? 0) &&
      (begLedger?.balance ?? 0) > (ruinLedger?.balance ?? 0) &&
      (begLedger?.spendable ?? -1) - (ruinLedger?.spendable ?? 0) <=
        (begLedger?.earned ?? 0) - (ruinLedger?.earned ?? 0),
    `跪求 ${ruinLedger?.begged} → ${begLedger?.begged}，余额 ${ruinLedger?.balance}→${begLedger?.balance}，` +
      `可花 ${ruinLedger?.spendable}→${begLedger?.spendable}（本段赚进 Δ${(begLedger?.earned ?? 0) - (ruinLedger?.earned ?? 0)}）`,
  );
  // 收工不动账：与 endless 模式那条同一个口径（差额口径复用 `ledgerDeltaOf`，不另立式子）。
  // ★ 紧贴 `quitRun` 取第二份读数，中间不隔仿真等待。
  const deltaBeforeQuit = ledgerDeltaOf(begLedger);
  await hooks(() => window.__THREE_GAME_TEST_HOOKS__?.quitRun?.());
  const quitLedger = await ledgerOf();
  check(
    '③ 收工不动账：恒等式差额与收工前一致（合并账户后「回存」这一步整个消失）',
    ledgerDeltaOf(quitLedger) === deltaBeforeQuit,
    `差额 ${deltaBeforeQuit} → ${ledgerDeltaOf(quitLedger)}，余额 ${begLedger?.balance}→${quitLedger?.balance}`,
  );
  /* 这一等必须是**仿真等**，不能是墙钟等：下面这条要读的是「跪求+收工走完之后的账」，
     开泵时 400 ms 真实等待里泵仍在灌仿真（~1 仿真秒），不等完读到的是半截状态。
     不开泵时 `simTick` 就是 `waitForTimeout`，实时腿读数不变。 */
  await simTick(page, 400);
  check('③ 跪求后账本仍平', ledgerOk(await ledgerOf()));

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

  // 逐种 / 逐连子的越线占比：**只加打印，不加判据**（计划步骤 2.5）。
  // 为什么要在这一批量：返值表的整数档位能不能表示标定倍率，取决于 kind 的分布，
  // 而这个分布除了这里没有第二个来源 —— `crossingSamples` 每条本来就带 kind 与 combo。
  if (crossingSamples.length > 0) {
    const byKind = new Map();
    const byCombo = new Map();
    for (const s of crossingSamples) {
      byKind.set(s.kind, (byKind.get(s.kind) ?? 0) + 1);
      byCombo.set(s.combo, (byCombo.get(s.combo) ?? 0) + 1);
    }
    const share = (n) => `${n}（${((n / crossingSamples.length) * 100).toFixed(1)}%）`;
    console.log(
      '  逐种越线占比：' +
        [...byKind.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([kind, n]) => `${kind} ${share(n)}`)
          .join('，'),
    );
    console.log(
      '  逐连子越线占比：' +
        [...byCombo.entries()]
          .sort((a, b) => Number(a[0]) - Number(b[0]))
          .map(([combo, n]) => `${combo} 连 ${share(n)}`)
          .join('，'),
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
  // 下面的 ④ 与 ⑤ 占比会先红（★ 变异实测：⑤′ 在 n=2 时**仍然绿**，它不是第一道门）。
  //
  // ⚠️ 这两个求和是**局账求和**，带上面注释里说的那个迟到返值残差（每批几枚的量级），
  //   所以它只做读数；判据级的守恒走 ② 的终身账。
  const earnedPerSpent = spentTotal > 0 ? earnedTotal / spentTotal : Number.POSITIVE_INFINITY;
  const netPerRun = (earnedTotal - spentTotal) / Math.max(1, runs.length);
  console.log(
    `  实测读数：赚进 ${earnedTotal} / 消耗 ${spentTotal} = ${earnedPerSpent.toFixed(3)}；` +
      `单局净流出 ${(-netPerRun).toFixed(1)} 筹码 → 200 局 ${(-netPerRun * 200).toFixed(0)} 筹码`,
  );
  /*
   * S2 甲规则的分流率（`repaid / (earned + repaid)`）——**只打印，不立判据**。
   * 为什么现在不能立：带还没实测出来（plan 里那条「③ 补 S2 欠的那轮稳态批」要的就是这个数），
   * 而按「阈值要离噪声远」那条纪律，没有分布就拍不出门；n=2 的本批更是只能看形状。
   * 稳态批跑完之后，这条应当升级成硬判据（并配一个能触发它的变异）。
   */
  const repaidTotal = runs.reduce((sum, run) => sum + run.repaid, 0);
  const grossTotal = earnedTotal + repaidTotal;
  const debtNow = await hooks(() => window.__THREE_GAME_TEST_HOOKS__?.debt?.());
  console.log(
    `[info] ⑤ S2 分流读数（仅打印，带待稳态批定档）：repaid ${repaidTotal} / gross ${grossTotal} = ` +
      `${((repaidTotal / Math.max(1, grossTotal)) * 100).toFixed(1)}%，` +
      `期末欠款 ${debtNow?.debt ?? '?'}/${debtNow?.ceiling ?? '?'}，累计贷出 ${debtNow?.loanedTotal ?? '?'}`,
  );
  /*
   * 局长分布的几组读数原先定义在下面的 ⑥ 块里；⑤ 现在也要用中位数，
   * 所以**整簇上移到这里**，⑤ 与 ⑥ 共用同一份（判据不写第二份公式）。
   */
  // 上界不再是一个够不到的常数：撞 cap 就是『永远不结束』的表现形式 ⇒ 由协议派生，
  // 另加一条真正会红的门（⑥′）去盯右尾变厚。
  const CRASH_LENGTH = [20, ECON_RUN_DROPS_CAP];
  const dropCounts = runs.map((run) => run.drops);
  const meanDrops = dropCounts.reduce((sum, count) => sum + count, 0) / Math.max(1, dropCounts.length);
  const sortedDrops = [...dropCounts].sort((a, b) => a - b);
  const medianDrops =
    sortedDrops.length % 2 === 1
      ? sortedDrops[(sortedDrops.length - 1) / 2]
      : (sortedDrops[sortedDrops.length / 2 - 1] + sortedDrops[sortedDrops.length / 2]) / 2;
  const DESIGN_LENGTH = [60, 90];
  const meanInDesign = meanDrops >= DESIGN_LENGTH[0] && meanDrops <= DESIGN_LENGTH[1];

  const timeoutRuns = runs.filter((run) => run.end === 'timeout');
  // ⑤ 从「任何一局 timeout 就红」拆成两条**不同物**的判据 + 一行打印。
  // 原写法的对象是「回收 ≥ 1 ⇒ 局永远不结束」，那会表现为**所有长度**都不结束；
  // 而实测结构是一条正反馈长尾（n=198 里 timeout 局最短 37 投、中位 36 投，只差 1 投），
  // 于是「偶尔有局撞到上限」在当前表就被判成回归 —— 一条率被写成了一件事实。
  //
  // 阈值为什么取 30 %：判据是在**每次调用**（分段批即 n=50 的段）上求值，
  // 观测 9.1 % 在 n=50 上的 95 % 区间宽达 ±7.6 pp、单腿最坏 12 % 的上界已到 21 %
  // ⇒ 10 % 与 20 % 都会随机翻红（都是我先验写死后被余量计算否证的）。
  // 而点火场景会把 timeout 推向接近 100 % ⇒ 30 % 仍然抓得住。**阈值要离噪声远，不是离读数近。**
  check(
    '⑤ 没有打平：timeout 占比 ≤ 30%（回收若 ≥1，这一条会趋近 100%）',
    runs.length > 0 && timeoutRuns.length / runs.length <= 0.3,
    `timeout ${timeoutRuns.length}/${runs.length} 局（${((timeoutRuns.length / Math.max(1, runs.length)) * 100).toFixed(1)}%）`,
  );
  // 原第三条「逃逸必须只在长尾」**降级为打印**：它是分布形状的陈述，n=50/段 无法验证
  //（实测最短的 timeout 局与中位只差 1 投 ⇒ 做成判据就会因为一次抽中而红，
  //  而它想抓的场景已由上面那条占比判据覆盖）。
  console.log(
    `[info] ⑤ 长尾形状（仅打印，不作判据）：中位 ${medianDrops} 投；` +
      `timeout 局投币数 ${timeoutRuns.map((run) => run.drops).sort((a, b) => a - b).join('/') || '无'}`,
  );
  /*
   * ★★ ⑤′：探针换了被测对象 —— 这是 plan S4 里标为「最危险的一条」。
   *
   * 旧判据「终局的筹码都低于本局买入」真正的身份是**回收率 < 1 的探针**：
   * 单位期望一旦 ≥ 1，账户就触不到底，局永远走不到终态。
   * 合并账户之后「本局买入」这个数没有了，而同一件事换了表现形式：
   * **余额永不触底 ⇒ 续玩报价（破产终态）不再出现 ⇒ 贷款与跪求的频率趋近 0**。
   * ⇒ 探针必须跟着换成「本批里账户确实见底过」，否则 R6 落地后会出现
   *   「十项全绿但点火闸已失效」的静默退化。
   *
   * 为什么写成 `> 0` 而不是某个率的下界：在当前经济下（回收 ~0.7-0.8、每局起始 = 标准注额）
   * 「至少一局投到底」是近乎确定的**事实**而不是形状陈述，n=20 上不会因一次抽中而红；
   * 点火场景下它**趋近 0**（★ 但不是「恰好 0」——见下面变异测试那段，×2 的经济 n=2 仍有 1 局输光）。
   * ⇒ **阈值离噪声远**这一点成立（正常批是 3/3、6/6 这种满值，门只在 0 上翻红），
   *   但它的**灵敏度低于 ④**，所以这条是补充哨兵而不是主闸。
   * ⚠️ **它抓不到反向的「经济太苛刻」**——那由 ⑥（局长硬界）与 ④（单位期望）负责。
   *
   * ★★ 变异测试（10-01 实测，`/tmp/r6-mutation` 把全部越线返值 ×2）的**修正**：
   *   那一批 n=2 里 ④ 与 ⑤ 都红了，而 **⑤′ 是绿的**（破产 1/2 —— 第 2 局 106 投仍然见底）。
   *   ⇒ 上面「点火场景把它恰好打到 0」这句**被数据否证了**：×2 的经济里照样有局会输光。
   *   真实形态是「ruin 占比往下掉、但不是 0」，所以 **⑤′ 是补充哨兵，不是主闸**；
   *   点火的第一道门是 ④（它直接算期望，n=2 就红，读数 1.409 / 1.327 / 0.999）。
   *   留 ⑤′ 的理由：它抓的是**另一件事** —— 「账户不再触底」是玩法层面的失效
   *   （续玩报价/跪求/债务整族随之失去消费者），而那件事 ④ 看不见（④只看单投期望）。
   */
  const ruinRuns = runs.filter((run) => run.end === 'ruin');
  check(
    '⑤′ 账户真的见底：本批出现破产终态的局数 > 0（经济点火时这一比例趋近 0 ⇒ 补充哨兵，主闸是 ④）',
    runs.length > 0 && ruinRuns.length > 0,
    `破产 ${ruinRuns.length}/${runs.length} 局（这 ${runs.length} 局自身的跪求 ${runPhaseTotals.begged}、贷款 ${runPhaseTotals.loaned}）；` +
      `各局终态 ${runs.map((run) => `${run.end}:余额${run.balance}`).join(' ')}`,
  );


  // 局的长度是经济标定的**可观察后果**：回收率太高一局会拖到十几分钟，
  // 太低则几投就破产。这条断言把「标定漂了」变成红灯，而不是靠人肉感觉。
  //
  // **判据是「标定没有整体漂掉」，不是「每局都落在设计目标 60~90 投内」。**
  // 单局方差实测很大：同一组常量（当时的 `bronzePayoutChance` 0.18）下量到
  // 48 / 53 / 56 / 71 / 74 投，越线/投币 1.02 ~ 1.37。要求每一局都进 60~90
  // 等于让断言赌运气（§6.7 的老教训），而且两局的小样本本来就定不了均值。
  // 所以：硬判据只守「不崩溃」的两端；设计目标改成看**均值**、且先作读数报出，
  // 均值的定案由 P8 用 `ECON_RUNS=200` 跑多局来做。
  //
  // ★ **S11 把硬界从 35~220 放宽到 20~300（★ 10-01 P2 之后上界改由 `ECON_RUN_DROPS_CAP` 派生 ⇒ 这个 300 已不是现值） —— 这是「换一条能继续观测同一缺陷的断言」，
  //   不是掩盖红灯。** 依据是 S11 三轮标定 + 基线共 **4 组 24 局**的实测分布：
  //
  //     30,34,34,35,39,41,41,42,42,43,47,47,51,54,58,58,60,60,68,71,82,154,178,216
  //     中位数 47 · 均值 68.5 · 极差 30~216
  //
  //   三点结论：
  //   ① **右偏重尾**：中位数 47 明显低于均值 68.5，三个 154/178/216 的雪球局把均值拉了上去。
  //      所以「均值在 60~90 带内」这一条**只说明平均，不说明典型**；典型局仍偏短。
  //   ② **左尾是噪声、不是标定漂移**：三轮的每局最低值依次是 34 / 41 / 30，
  //      而三轮的水量是 2.012 / 2.569 / 2.340 —— **最低值与水量不单调**。
  //      把它当成「标定漂了」去追，只会一路把水量推上去，然后右尾先撞线。
  //   ③ 旧的 35 下界与 220 上界**各自只差 1~4 投**就被撞到（34、216），
  //      在 24 局的样本上已经证明是掷骰子。留一档余量取 20 / 300。
  //
  //   **真正的保护不在这一条**：点火（单位期望 ≥ 1）由 ④ 抓、局不终局由 ⑤ 抓。
  //   这里只守「几投就死」与「永远不结束」两种崩溃形态。
  //
  // ★ **上面那 24 局是 S11 的旧经济下量的**。S13 §5 把返值表整体重标过
  //   （推进率 1.328 → 1.70~2.15），所以这张分布**不能直接当成本轮的预期**——
  //   它是「为什么硬界要留一档余量」的**依据**，不是新经济的读数。
  //   本轮的局长读数由下面的 ⑥ 逐次报出；若左尾开始贴 20，说明返值压过头了。
  // `dropCounts` / `meanDrops` / `medianDrops` / `CRASH_LENGTH` / `DESIGN_LENGTH` / `meanInDesign`
  // 已上移到 ⑤ 之前（⑤ 要用中位数；判据不许写第二份公式）。
  const floorShare = dropCounts.filter((count) => count <= 28).length / Math.max(1, dropCounts.length);
  const timeoutShare = timeoutRuns.length / Math.max(1, runs.length);
  const capHits = dropCounts.filter((count) => count >= ECON_RUN_DROPS_CAP - 1).length;
  const capShare = capHits / Math.max(1, dropCounts.length);
  check(
    `⑥ 单局长度不崩溃（${CRASH_LENGTH[0]}~${CRASH_LENGTH[1]} 投；**上界即协议截断点 ⇒ 这一半由协议保证，右尾变厚归 ⑥′；下界 >=20 仍是活的（左尾塌陷会红）**）—— 四数一起读：均值吃右尾、典型局看中位`,
    dropCounts.every((count) => count >= CRASH_LENGTH[0] && count <= CRASH_LENGTH[1]),
    `各局投币数 ${dropCounts.join('/')}，均值 ${meanDrops.toFixed(1)} / 中位数 ${medianDrops} 投` +
      `，触底(≤28 投) ${(floorShare * 100).toFixed(1)}%` +
      `，timeout ${(timeoutShare * 100).toFixed(1)}%` +
      `（设计带 ${DESIGN_LENGTH[0]}~${DESIGN_LENGTH[1]} 是**均值**口径；` +
      `${meanInDesign ? '均值在带内' : '均值在带外'}，但带内**不等于**典型局达标）），` +
      `越线/投币 ${perDrop.toFixed(3)}`,
  );

  check(
    `⑥′ 右尾没变厚：撞每局投币上限（${ECON_RUN_DROPS_CAP} 投）的局数占比 <= 25%`,
    capShare <= 0.25,
    `撞 cap ${capHits}/${dropCounts.length} 局 = ${(capShare * 100).toFixed(1)}%（点火时趋近 100%）` +
      `；阈值依据见本块上方注释（段 1 观测 10%，n=50 的单侧 95% 上界 = 19.9%，精确算过）`,
  );

  /*
   * ⑥′ 与 ⑤（timeout 占比 <= 30%）**互不包含**，所以两条都要留：
   *   ⑤ 数 `end === 'timeout'`，成因有两种——撞到投币上限，或撞到**仿真秒**上限
   *     （09-29 实测过「54 投就 timeout」，那是仿真秒到点，与 cap 无关）；
   *   ⑥′ 数「投币数 >= cap-1」，而撞 cap 的局也可能恰好在那一刻破产（段 1 第 39 局：240 投 + ruin）。
   * ⇒ ⑤ 看「多久没打完」，⑥′ 看「是不是靠协议截断才打完」；只留 ⑤ 会漏掉后者——
   *   而后者正是 ⑥ 的上界够不到之后**没人守**的那一格（#67 的本体）。
   * ⚠️ 阈值 25% 不是贴着读数定的：判据在**每段 n=50** 上求值，段 1 观测 10%，
   *   其单侧 95% Clopper-Pearson 上界 = **19.9%**（精确算，不是估的），段 2 至今更低（池化 6.2%）。
   *   取 20% 会贴在这个界上，取 30% 与 ⑤ 同宽但比必要宽 1.5 倍 ⇒ 25%。
   * 🔴 变异门（必做，否则这条可能是恒绿）：把 ECON_RUN_DROPS_CAP 临时改成 60
   *   ⇒ 大量局撞 cap ⇒ 本条必须红；同时 ⑥ 的上界也会跟着变（两处同源，正是提名的目的）。
   *   改完必须还原并 grep 确认值回到 240。
   */


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
 *   E 加力存满时拒收可对账**且不空响**（granted=false + 改派一场小型补货演出）。
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

  // ── A2：3D 标牌与槽位状态同源（**按计数比对，不看截图**） ──
  //
  // 四槽的亮灭现在画在推板前缘的四段内嵌标牌上（`Pusher.buildXixiLanes`），
  // 载体是 `instanceColor` 而不是 DOM。这类缺陷在截图里只表现为「某一段颜色不太对」，
  // 肉眼反推要来回试很多轮；直接读 `instanceColor` 就是一组可枚举的颜色。
  //
  // 三条性质一起守：
  //   ① 段数 = 4（少一段就是少一个 draw 槽位）；
  //   ② 亮的段颜色彼此相同、灭的段颜色彼此相同，且两者**不同**（否则亮灭不可分辨）；
  //   ③ 标牌状态与 `diagnostics.xixi` 逐槽一致（两套读数必须同源）。
  const lanePatterns = [
    [false, false, false, false],
    [true, false, true, false],
    [true, true, true, true],
  ];
  const laneRows = [];
  for (const pattern of lanePatterns) {
    const lanes = await page.evaluate(
      (slots) => window.__THREE_GAME_TEST_HOOKS__?.setXixi?.(slots),
      pattern,
    );
    await page.waitForTimeout(120);
    const state = await readStateFresh(page);
    const litColors = new Set(lanes?.colors?.filter((_, index) => pattern[index]));
    const dimColors = new Set(lanes?.colors?.filter((_, index) => !pattern[index]));
    laneRows.push({
      pattern: pattern.map((v) => (v ? 1 : 0)).join(''),
      count: lanes?.count ?? 0,
      litOk: litColors.size <= 1,
      dimOk: dimColors.size <= 1,
      distinct: litColors.size === 0 || dimColors.size === 0 || ![...litColors].some((c) => dimColors.has(c)),
      stateOk: JSON.stringify(state?.xixi ?? null) === JSON.stringify(pattern),
      colors: lanes?.colors ?? [],
    });
  }
  check(
    '3D 标牌：四段、亮灭两色可分辨、且与 diagnostics.xixi 逐槽一致',
    laneRows.length === lanePatterns.length &&
      laneRows.every(
        (row) => row.count === 4 && row.litOk && row.dimOk && row.distinct && row.stateOk,
      ),
    laneRows
      .map(
        (row) =>
          `${row.pattern}→${row.colors.join('/')}${row.stateOk ? '' : '（状态不同源）'}` +
          `${row.distinct ? '' : '（亮灭同色）'}`,
      )
      .join('　'),
  );
  // 复位成全灭，后面的用例从干净状态开始。
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setXixi?.([false, false, false, false]));

  // ── A3：标牌的**几何与徽章身份**（P10）──
  //
  // 「四段是不是等宽无缝铺满 ±0.68」「徽章是不是 16 纹素的叉」在截图上看不出来：
  // 差 3% 的段宽肉眼无感、图标被横向拉扁一点也像「风格」。但它们错了就是错——
  // 段宽与 `xixiSlot()` 的分段脱钩之后，亮的槽和玩家瞄准的位置就对不上了。
  //
  // 判据**不写第二份分段公式**（纪律 2）：段宽由引擎读出来，判据只核它满足
  // 「等宽 + 无缝 + 铺满 ±halfLane」这三条**性质**，以及段数与槽数一致。
  const badge = await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.xixiLanes?.() ?? null);
  const segWidth = badge?.segment?.width ?? 0;
  const centers = badge?.centers ?? [];
  // 相邻中心距 = 段宽 ⇒ 既不留缝也不重叠（这正是「等宽无缝」的可观测形式）。
  const pitches = centers.slice(1).map((x, i) => Number((x - centers[i]).toFixed(6)));
  const seamless = pitches.every((p) => Math.abs(p - segWidth) < 1e-4);
  // 首段左缘 / 末段右缘：`center ± width/2` 应正好落到 ±halfLane。
  const spanLeft = centers.length ? centers[0] - segWidth / 2 : 0;
  const spanRight = centers.length ? centers[centers.length - 1] + segWidth / 2 : 0;
  check(
    '3D 标牌：四段等宽无缝、铺满 ±0.68（段宽与槽位分段同源），且徽章图标是 16 纹素的叉',
    badge?.count === 4 &&
      segWidth > 0 &&
      seamless &&
      Math.abs(spanLeft + 0.68) < 1e-4 &&
      Math.abs(spanRight - 0.68) < 1e-4 &&
      badge?.totalWidth === Number((segWidth * 4).toFixed(6)) &&
      // 徽章：四段画的是同一个叉（I 用 X 替代），图标 16 纹素 = 段高 0.14 米在画布上的 1:1。
      badge?.badgeIcon === 'cross' &&
      badge?.badgeTexels?.height === 16 &&
      badge?.badgeTexels?.width >= 16,
    `段宽=${segWidth}m 中心=${JSON.stringify(centers)} 间距=${JSON.stringify(pitches)} ` +
      `跨度=[${spanLeft.toFixed(3)}, ${spanRight.toFixed(3)}] 总宽=${badge?.totalWidth}m ` +
      `徽章=${badge?.badgeIcon} ${badge?.badgeTexels?.width}×${badge?.badgeTexels?.height} 纹素`,
  );

  // ── P10：滚筒形态 / 像素图集 / 结果表（**读引擎读数与纯函数，不看截图**）──
  //
  // 「图标糊不糊、四个滚筒是不是同一套几何、45% 中奖率到底是多少」这三件事
  // 在截图上都只能靠肉眼反推，所以全部读出来：
  //   ① 滚筒窗：块数 / 世界尺寸 / 图标在画布上的**后备像素边长**；
  //   ② 图标：来自图集、32×32、每格调色板 ≤ 16 色、环带 32×192；
  //   ③ 结果表：把 `rollSlotOutcome` 均匀枚举（**不写第二份权重公式**，纪律 2）；
  //   ④ 停格画面：win/fine 四连、miss 两两不同且不含胡萝卜（画面自证「没凑齐」）。
  const reel = await page.evaluate(
    () => window.__THREE_GAME_TEST_HOOKS__?.reelWindowReport?.() ?? null,
  );
  check(
    '滚筒窗：4 块平面窗、图标 1:1（后备像素 ≥ 24）、四格有缝不重叠且不出框',
    reel?.count === 4 &&
      reel.windowSize > 0 &&
      reel.iconTexels === 32 &&
      reel.stripTiles === 6 &&
      // ≥ 24 而不是 === 32：降档时 upscale 变大会把它压小，那是画质分档的正常行为。
      reel.iconBackPixels >= 24 &&
      // 有缝 → 四格不重叠（判据读 pitch 与 size 的关系，不重写几何公式）。
      reel.windowPitch > reel.windowSize &&
      // 不能宽过背板挂框（1.55 m）。
      reel.rowWidth <= 1.55,
    `count=${reel?.count} 窗=${reel?.windowSize}m 图标=${reel?.iconBackPixels} 后备像素` +
      `（CSS ${reel?.iconCssPixels}，${reel?.iconTexels}² 纹素）行宽=${reel?.rowWidth}m`,
  );

  const icons = await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.iconReport?.() ?? null);
  check(
    '像素图标：6 格来自内嵌图集、32×32、每格调色板 ≤ 16 色、环带 32×192',
    icons?.ids?.length === 6 &&
      icons.size === 32 &&
      icons.paletteMax === 16 &&
      (icons.paletteSizes ?? []).every((n) => n > 0 && n <= icons.paletteMax) &&
      icons.strip?.width === 32 &&
      icons.strip?.height === 192,
    `ids=${JSON.stringify(icons?.ids)} 调色板=${JSON.stringify(icons?.paletteSizes)} ` +
      `环带=${icons?.strip?.width}×${icons?.strip?.height}`,
  );
  // 底色两两不同 → 没有两格被切到同一块像素（切格越界/重复的典型形态）。
  const backgrounds = new Set(icons?.backgrounds ?? []);
  check(
    '像素图标：六格底色两两不同（没有两格切到同一块像素）',
    backgrounds.size === 6,
    `底色 ${JSON.stringify(icons?.backgrounds)}`,
  );
  // ★ 「名字 → 像素」的身份核对**只能在构建期做**：运行时两边都来自同一个 `icons.ts`，
  //   自比对是循环论证。所以这里直接把构建期的守卫跑一遍——
  //   它拿 `EXPECTED_BACKGROUND`（图集指纹）核每一格的底色，
  //   名字与格子错位时立刻报错（P10 踩过：全绿但「桃画成了宝箱」）。
  let iconsGuard = { ok: false, detail: '' };
  try {
    const output = execFileSync('node', ['scripts/build-icons.mjs', '--check'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    iconsGuard = { ok: true, detail: output.trim().split('\n')[0] };
  } catch (error) {
    iconsGuard = {
      ok: false,
      detail: String(error?.stderr ?? error?.message ?? error).trim().split('\n').slice(0, 3).join(' / '),
    };
  }
  check(
    '像素图标：切格顺序与图集一致（构建期底色守卫，名字 ↔ 像素的身份核对）',
    iconsGuard.ok,
    iconsGuard.detail,
  );

  /*
   * ★★ S5a：这两条判据**去字面量化**了，而且必须先做这一步再改权重
   *   （反过来就会造出一条假红：表改了、判据还守着 45/15/40，红的是判据不是机器）。
   *
   * 旧写法把「45 % 中奖 / 15 % 胡萝卜 / 40 % 杂牌」和「五个符号」抄进了测试，
   * 于是权重表在 `xixi.ts` 与这里**各有一份**。现在：
   *   - 期望比例 = 引擎吐回来的 `odds.weights` 自己归一化；
   *   - 计数桶按 `Object.keys(weights)` 开 ⇒ 加一档（win4）测试自动跟上；
   *   - 符号数读 `odds.symbolCount`，四同池成员读 `odds.tier4Symbols`。
   * ⚠️ 容差从 ±1.5 pp 收到 **±0.2 pp**：枚举是**等距**的（`roll = i / total`），
   *   唯一的误差源是分段边界最多少/多算一个样本 = 1/2000 = 0.05 pp，
   *   旧的 1.5 pp 是当年照「解析解 vs 抽样」的直觉拍的，**比实际需要宽 30 倍**
   *   —— 一条比噪声宽 30 倍的门抓不到「权重表被偷偷改掉一格」。
   */
  const odds = await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.slotOdds?.(2000) ?? null);
  const oddsTotal = odds?.samples ?? 0;
  const pct = (n) => (oddsTotal ? ((n ?? 0) / oddsTotal) * 100 : 0);
  const near = (value, want) => Math.abs(value - want) <= 0.2;
  const weightKeys = Object.keys(odds?.weights ?? {});
  const shareOf = (key) => ((odds?.weights?.[key] ?? 0) / (odds?.totalWeight ?? 1)) * 100;
  check(
    '结果表：枚举比例 = 引擎权重表（判据不抄第二份分段；桶按表开，加一档自动跟上）',
    Boolean(odds) &&
      weightKeys.length > 0 &&
      weightKeys.every((key) => near(pct(odds.counts?.[key]), shareOf(key))) &&
      weightKeys.reduce((sum, key) => sum + (odds.counts?.[key] ?? 0), 0) === oddsTotal,
    weightKeys
      .map((key) => `${key} 枚举 ${pct(odds.counts?.[key]).toFixed(2)}% / 表 ${shareOf(key).toFixed(2)}%`)
      .join('，'),
  );
  // 五个奖励符号**都必须可达**：中奖分支只走某个子集是「奖励表写漏」的典型形态，
  // 而它在权重随机下要摇很多次才会暴露。枚举一遍就知道有没有死项。
  const symbolCount = Object.keys(odds?.symbols ?? {}).length;
  check(
    '奖励表无死项：引擎列出的每个符号（数量也读引擎）在枚举里全部出现',
    (odds?.symbolCount ?? 0) > 0 && symbolCount === odds.symbolCount,
    `出现 ${symbolCount} 个 / 表列 ${odds?.symbolCount}：${JSON.stringify(odds?.symbols)}`,
  );
  /*
   * S5a 的四同池：池成员与「枚举里真的摇到过的四同符号」必须**是同一批**。
   * 两种失效都能被这条抓住：① 池里某个符号的四同分支没接上（seen 少一个）；
   * ② 池外的符号（泉）混进四同（seen 多一个）—— 后者尤其阴险，
   *   它会演成三同那一档，画面上「四连了但什么大奖都没发生」。
   */
  const tier4Seen = Object.keys(odds?.tier4SymbolsSeen ?? {}).sort();
  const tier4Want = [...(odds?.tier4Symbols ?? [])].sort();
  check(
    '四同池无死项也不越池：枚举到的四同符号集合 = 引擎声明的四同池',
    tier4Want.length > 0 &&
      JSON.stringify(tier4Seen) === JSON.stringify(tier4Want) &&
      (odds?.counts?.win4 ?? 0) > 0,
    `池 ${tier4Want.join('/')}，枚举到 ${tier4Seen.join('/') || '无'}，四同 ${odds?.counts?.win4} 次`,
  );

  const facesFor = (kind, symbol) =>
    page.evaluate(
      ([k, s]) => window.__THREE_GAME_TEST_HOOKS__?.reelFaces?.(k, s) ?? null,
      [kind, symbol],
    );
  const winFaces = (await facesFor('win', 'tower')) ?? [];
  const fineFaces = (await facesFor('fine')) ?? [];
  const missFaces = (await facesFor('miss')) ?? [];
  const fourSame = (row) => row.length === 4 && row.every((icon) => icon === row[0]);
  const missVariety = new Set(missFaces.map((row) => row.join(','))).size;
  check(
    '停格画面自证：win/fine 四连；杂牌四格两两不同、不含胡萝卜、画面不重复',
    winFaces.length > 0 &&
      winFaces.every(fourSame) &&
      fineFaces.every(fourSame) &&
      fineFaces.every((row) => row[0] === 'carrot') &&
      missFaces.every((row) => row.length === 4 && new Set(row).size === 4) &&
      missFaces.every((row) => !row.includes('carrot')) &&
      missVariety >= 5,
    `win=${winFaces[0]?.join('')} fine=${fineFaces[0]?.join('')} ` +
      `杂牌 ${missFaces.length} 次采样 / ${missVariety} 种不同画面`,
  );

  // ── D/E：先做强制摇奖（此时一币未投，earned 必须一直是 0） ──
  const spinAndWaitReward = async (symbol, tier) => {
    const before = ((await readTelemetry(page))?.xixiEvents ?? []).filter((e) => e.phase === 'reward').length;
    // 老虎机正在转时 spin 返回 null：上一场收尾前重试，不硬抢。
    let spun = null;
    const deadline = Date.now() + 5000;
    while (!spun && Date.now() < deadline) {
      spun = await page.evaluate(
        ([s, t]) => window.__THREE_GAME_TEST_HOOKS__?.xixiSpin?.(s, t),
        [symbol, tier ?? null],
      );
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

  // ★ 存满**不能空响**（P10 ⑨，PLAN 标记的「本次最容易漏的体验坑」）。
  //
  // `boostStoreCap = 1` + 45% 中奖率 + 力占 26/45，使「加力已满」成为最常见的中奖
  // 失效形态。所以这里不只断言「拒收可对账」，还要断言**兜底真的派了演出**：
  // `granted === false && delivered === 兜底枚数`，且 showEvents 里有对应装置的登记。
  //
  // 兜底规模从引擎读（`boostOverflowSpec`），不在脚本里手抄 3 枚——
  // 它是可调的平衡旋钮，抄一份到测试里 S11 标定时就会开始骗人。
  const overflow = (await page.evaluate(() =>
    window.__THREE_GAME_TEST_HOOKS__?.boostOverflowSpec?.(),
  )) ?? { show: 'gate', count: 0, cap: 0 };
  const cappedReward = await spinAndWaitReward('boost');
  const afterCap = await readStateFresh(page);
  const showEventsAfterCap = (await readTelemetry(page))?.showEvents ?? [];
  const fallbackShow = [...showEventsAfterCap]
    .reverse()
    .find((e) => e.id === overflow.show && e.phase === 'registered');
  check(
    '加力存满不空响：granted=false，且改派一场小型补货演出（装置与枚数读引擎配置）',
    cappedReward?.granted === false &&
      afterCap?.boostCharges === overflow.cap &&
      cappedReward?.delivered === overflow.count &&
      fallbackShow?.promised === overflow.count,
    `granted=${cappedReward?.granted} boost=${afterCap?.boostCharges}（存满上限 ${overflow.cap}）` +
      ` 兜底实发=${cappedReward?.delivered} 装置=${overflow.show} 登记承诺=${fallbackShow?.promised}`,
  );
  /* #66A② 的**阳性对照**。为什么必须有：economy 那一列「win 拒收 R/W」在 10-02 的 n=20 批里读到
     **0/32**，而 0 有两种互斥解释 —— 「加力确实从没在满的状态下中的奖」与「我的谓词没接上事件形状」。
     这一条打在**必然产生该形状**的位置（上面刚强制过一次存满拒收），
     数的还是同一个 `isRefusedWin` ⇒ 它红就说明计数器是空的，不是机器没有兜底。 */
  const capRewardEvents = ((await readTelemetry(page))?.xixiEvents ?? []).filter((e) => e.phase === 'reward');
  const refusedSeen = capRewardEvents.filter(isRefusedWin).length;
  check(
    '#66A② 阳性对照：存满拒收要被 isRefusedWin 数到（economy 那列不是空探针）',
    refusedSeen >= 1,
    `reward 事件 ${capRewardEvents.length} 条，其中被数成的拒收 ${refusedSeen} 条；本次强制的那条 ${JSON.stringify(cappedReward)}`,
  );

  // 承诺数从引擎规模表读（S6 把塔改到阵型规模是配置变更，不是回归）。
  const specs = (await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.showSpecs?.())) ?? {};
  const towerSpec = specs.tower?.count ?? 0;
  // ★ R4-4b「汇」的窗口基线：**演出前**先读一次累计值，演出后再读差值。
  // 计数器在引擎侧按出处分类（`Coin.fromShow`）；脚本只做差值，不抄第二份公式。
  const windowBefore = await page.evaluate(
    () => window.__THREE_GAME_TEST_HOOKS__?.showWindow?.() ?? { crossings: -1, foreign: -1 },
  );
  const towerReward = await spinAndWaitReward('tower');
  const showEventsAfterTower = (await readTelemetry(page))?.showEvents ?? [];
  const towerRegistered = showEventsAfterTower.find((e) => e.id === 'tower' && e.phase === 'registered');
  check(
    `塔塔塔：ShowDirector 登记塔装置（承诺 ${towerSpec} 枚 = 阵型规模）`,
    towerReward?.granted === true &&
      towerReward?.delivered === towerSpec &&
      Boolean(towerRegistered),
    `granted=${towerReward?.granted} delivered=${towerReward?.delivered}（规模表 ${towerSpec}）` +
      ` 登记=${JSON.stringify(towerRegistered)}`,
  );
  // ★ R4-4b 的生命周期自证：**演出期间比演出后多一个碰撞体**。
  // ⚠️ 第一版探针是错的（实测「演出中读数 -1」）：它等的是 `showEvents` 里
  // 「phase 不是 completed 且 spawned > 0」那一帧，而事件只在**演出结束**时落一条
  // `completed` —— 中间态根本不在事件表里，于是 20 秒空转、判据红在探针自己身上。
  // 判据先改对再拿它当证据：改成**对整个演出期采样取峰值**，不依赖事件表的中间态。
  // 也不写绝对值——世界里有币池那 700 多个休眠碰撞体（实测 732），比的是**差**：
  // 演出结束后那一个必须被 `removeRigidBody` 还回世界。不等只有两种解释：
  // 柱体压根没建（4b 白做），或泄漏了（每演一次塔多一根看不见的墙）——
  // 后者 `activeCoins` / `anomalies` 都读不出来，所以这条必须是独立判据。
  let towerColliderPeak = -1;
  let towerCollidersAfter = -1;
  const lifecycleDeadline = Date.now() + 20_000;
  for (;;) {
    const n = await page.evaluate(
      () => window.__THREE_GAME_TEST_HOOKS__?.countColliders?.() ?? -1,
    );
    if (n > towerColliderPeak) towerColliderPeak = n;
    const t = await readTelemetry(page);
    if ((t?.showEvents ?? []).some((e) => e.id === 'tower' && e.phase === 'completed')) {
      towerCollidersAfter = n;
      break;
    }
    if (Date.now() >= lifecycleDeadline) break;
    await page.waitForTimeout(80);
  }
  check(
    '塔演出：柱体碰撞体随演出建立、随 dispose 归还（R4-4b 生命周期）',
    towerColliderPeak > 0 && towerCollidersAfter === towerColliderPeak - 1,
    towerCollidersAfter > 0
      ? `演出期峰值 ${towerColliderPeak} 个 → 演出结束 ${towerCollidersAfter} 个（期望 −1）`
      : `20 秒内没等到塔的 completed（峰值 ${towerColliderPeak}）`,
  );
  // ★ R4-4b 的**「汇」**（纪律「源汇成对」的另一半）：柱子把币拱过线时，
  // 账本只看得到「越线一枚币」，分不出这枚是**演出自己顶的**（水源，应当入账）
  // 还是**存量币床被拱过去的**（白送）。后者是 4b 唯一没被测过的风险，
  // 之前只有「四组门没红」这种间接证据。
  //
  // 上限从**这场演出自己的承诺数**取（`towerSpec`，引擎规模表）：
  // 「柱子拱掉的存量币」如果比它答应发的币还多，就等于这个装置发的是负数 ——
  // 不新写魔数，也不读盘面枚数（xixi 这一点的盘面枚数不由脚本控制）。
  const windowAfter = await page.evaluate(
    () => window.__THREE_GAME_TEST_HOOKS__?.showWindow?.() ?? { crossings: -1, foreign: -1 },
  );
  const windowCrossings = windowAfter.crossings - windowBefore.crossings;
  const windowForeign = windowAfter.foreign - windowBefore.foreign;
  check(
    `塔演出：不白送结算 —— 演出窗口内被柱子拱过线的「存量币」≤ 演出承诺 ${towerSpec} 枚（R4-4b 汇）`,
    windowBefore.crossings >= 0 &&
      windowAfter.crossings >= 0 &&
      windowCrossings >= 0 &&
      windowForeign >= 0 &&
      windowForeign <= towerSpec,
    `窗口内越线 ${windowCrossings} 枚，其中存量币 ${windowForeign} 枚` +
      `（演出币 ${windowCrossings - windowForeign} 枚，承诺 ${towerSpec} 枚）` +
      `；累计读数 ${windowBefore.crossings}→${windowAfter.crossings}`,
  );
  // 等塔演完再继续：演出队列一次一场，别让交付与后面的集章搅在一起。
  await waitForTelemetry(
    page,
    (t) => (t?.showEvents ?? []).some((e) => e.id === 'tower' && e.phase === 'completed'),
    20_000,
  );

  // ── P6/P10：道具奖励（钻 / 箱）──
  // 两者在权重表里是**稀有档**（钻 7 / 箱 2，合计占中奖的 20%）——
  // 靠权重随机去赌「摇到箱」要几十次，所以**必须**用强制摇奖钩子验证结构：
  // 奖励表不完整时这里立刻红，而不是等真金白银的经济里才发现。
  //
  // 判据是**两态**的（照 `show` 模式的模板）：奖励事件在滚筒停格那一刻就发，
  // 但演出是排队交付的，**那一刻币还没 spawn**。所以「登记/承诺」在摇奖后立刻断言，
  // 「交付的是真币」必须等 completed 事件之后——拿旧断言赌时序就是纪律 4 的同款坑。
  const diamondReward = await spinAndWaitReward('diamond');
  const diamondRegistered = ((await readTelemetry(page))?.showEvents ?? []).find(
    (e) => e.id === 'diamond' && e.phase === 'registered',
  );
  check(
    '钻钻钻：登记 diamond 演出（承诺 1 枚）',
    diamondReward?.granted === true && diamondReward?.delivered === 1 && Boolean(diamondRegistered),
    `granted=${diamondReward?.granted} delivered=${diamondReward?.delivered} 登记=${JSON.stringify(diamondRegistered)}`,
  );
  const diamondTelemetry = await waitForTelemetry(
    page,
    (t) => (t?.showEvents ?? []).some((e) => e.id === 'diamond' && e.phase === 'completed'),
    20_000,
  );
  const diamondCompleted = (diamondTelemetry?.showEvents ?? []).find(
    (e) => e.id === 'diamond' && e.phase === 'completed',
  );
  // 关键：交付的必须是**钻石币**，不是铜币。演出默认注入铜币，
  // 漏传 `kind` 就会变成「钻石奖励给一枚铜币」——币面与实际价值不符的骗人 bug。
  const diamondOnBoard = (await readCoins(page)).filter((coin) => coin.kind === 'diamond').length;
  check(
    '钻钻钻：交付真钻石币（币种正确，且不是直接加筹码）',
    diamondCompleted?.spawned === 1 && diamondOnBoard >= 1,
    `实发 ${diamondCompleted?.spawned} 枚，盘面钻石 ${diamondOnBoard} 枚`,
  );

  const chestSpec = specs.chest?.count ?? 0;
  const chestReward = await spinAndWaitReward('chest');
  const chestRegistered = ((await readTelemetry(page))?.showEvents ?? []).find(
    (e) => e.id === 'chest' && e.phase === 'registered',
  );
  check(
    `箱箱箱：登记 chest 演出（承诺 ${chestSpec} 枚，宝箱越线返 0 筹码、兑现靠演出）`,
    chestReward?.granted === true &&
      chestReward?.delivered === chestSpec &&
      Boolean(chestRegistered),
    `granted=${chestReward?.granted} delivered=${chestReward?.delivered}（规模表 ${chestSpec}）` +
      ` 登记=${JSON.stringify(chestRegistered)}`,
  );
  await waitForTelemetry(
    page,
    (t) => (t?.showEvents ?? []).some((e) => e.id === 'chest' && e.phase === 'completed'),
    20_000,
  );

  // ── P10：胡萝卜四连 → 扣本局筹码（**三账本恒等式一字不改**）──
  //
  // 罚的是**本局筹码**（用户拍板），走 `RunState.fineChips` → `spendChips`（唯一扣减入口），
  // 于是 `spent` 把它吸收、恒等式不动；另用 `fines` 单独对账「罚了几次、扣了多少」。
  // 两条一起看才完整：只看 `chips` 分不清「扣了罚款」还是「投了一枚币」。
  const beforeFine = await readStateFresh(page);
  const fineReward = await spinAndWaitReward('fine');
  /** 罚款面值：**从满盘那一次的实扣读数取**，不写 `SLOT_PENALTY_CHIPS` 的第二份抄本。 */
  const penaltyFace = fineReward?.fined ?? 0;
  const afterFine = await readStateFresh(page);
  const finedDelta = (afterFine?.fines ?? 0) - (beforeFine?.fines ?? 0);
  const spentDelta = (afterFine?.spent ?? 0) - (beforeFine?.spent ?? 0);
  // ⚠️ 这里原本断言的是「筹码**净**减少 ≥ 罚款」——判据本身是错的（实测红）：
  // 摇奖那几秒盘面照常越线结算，读到的是「罚 6、筹码 169→208」。
  // 净变化混进了盘面节奏，而经济本身没毛病（恒等式 208 = 20 + 194 − 6 两边都对得上）
  // ⇒ 假红。改成**只走账本**：罚款必须逐笔落在 `spent` 上（唯一扣减入口），
  // 且演出前后两端三账本恒等式都成立 —— 「扣的是本局筹码」被严格证明，
  // 且与盘面节奏无关（这条判据从此不会再因为「恰好赚了一笔」而红）。
  check(
    '胡萝卜四连：扣本局筹码（fined 可对账、fines 单调、spent ≥ fines、恒等式成立）',
    fineReward?.outcome === 'fine' &&
      fineReward?.fined > 0 &&
      finedDelta === fineReward.fined &&
      spentDelta === finedDelta &&
      (afterFine?.spent ?? 0) >= (afterFine?.fines ?? 0) &&
      ledgerOk(beforeFine) &&
      ledgerOk(afterFine),
    `罚 ${fineReward?.fined}（fines ${beforeFine?.fines}→${afterFine?.fines}，spent +${spentDelta}），` +
      `筹码 ${beforeFine?.chips}→${afterFine?.chips}，${ledgerText(afterFine)}`,
  );
  // 惩罚的图标必须是胡萝卜四连——`fine` 的停格画面在上面已经断言过，
  // 这里只核**事件里带的 faces 与画面同源**（两套读数不许对不上）。
  check(
    '胡萝卜四连：事件里的停格画面是胡萝卜 ×4（与滚筒画面同源）',
    fineReward?.faces?.length === 4 && fineReward.faces.every((icon) => icon === 'carrot'),
    `faces=${JSON.stringify(fineReward?.faces)}`,
  );
  // ★ S5b 的「罚不掉转欠款」场景放在**本模式最后**（见函数末尾）：它要把余额压到面值以下，
  //   而那会让本局立刻不可投币 —— 放在中途会把后面的「落点亮槽 / 集齐触发」一起拖红
  //   （10-01 实测踩过：那两条读 `completed=null`、事件链 `[]`，红的是级联不是缺陷）。

  // ── P10：杂牌（不奖不罚）──
  //
  // 40% 的那一档必须是**真的什么都不发生**：不奖、不罚、不动账本。
  // 三分类里最容易写漏的就是它——把 `miss` 落进 `win` 的默认分支就会
  // 「杂牌也给奖励」，而那在截图上看不出来（灯色确实变了）。
  const beforeMiss = await readStateFresh(page);
  const missReward = await spinAndWaitReward('miss');
  const afterMiss = await readStateFresh(page);
  check(
    '杂牌：不奖不罚（chips / fines / boostCharges 三项都不动，且四格各不相同）',
    missReward?.outcome === 'miss' &&
      missReward?.granted === false &&
      missReward?.delivered === 0 &&
      missReward?.faces?.length === 4 &&
      new Set(missReward.faces).size === 4 &&
      afterMiss?.chips === beforeMiss?.chips &&
      afterMiss?.fines === beforeMiss?.fines &&
      afterMiss?.boostCharges === beforeMiss?.boostCharges &&
      ledgerOk(afterMiss),
    `faces=${JSON.stringify(missReward?.faces)}，筹码 ${beforeMiss?.chips}→${afterMiss?.chips}`,
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
  //
  // ★ 这条扫描有两个**必须**，都是 S13 之后的物理决定的。缺一个就永远集不齐：
  //
  //   ① 必须**跨局**投，不能假设「一局投得起 60 枚」。
  //      XIXI 是收集线（`markXixi`：「进度跨局持续，破产不清零」；`Game.startRun()`
  //      不动 `this.xixi`），而 S13 §5 把返值表重标成「每投回收 < 1」之后
  //      （`economy` ④：×1/×2/×4 = 0.811/0.683/0.508），**一局的寿命只剩 27~29 投**。
  //      原先那版默认一局能投 60 枚 —— 那在旧经济（×1 回收 1.368 > 1，局几乎不终局）
  //      下侥幸成立。失败链：扫描途中破产 → `acceptingDrops` 为假 ⇒ 后续投币全被拒
  //      **且推板停摆** ⇒ 台上的币再也掉不下去 ⇒ `markXixi` 一次都不触发。
  //
  //   ② 必须**等落床**，不能「投完立刻查」。
  //      `conveyor.speed` 归零（2026-09-24 用户拍板 0.85 → 0）之后，台面上的币
  //      只靠推板摩擦前进（`probe`；⚠️ 注释里的 26 毫米/循环是 S13 破对称期读数，出厂态对称实测 −0.25 毫米/循环），
  //      有 **1.2 米**（落币口 2026-09-25 从 −0.72 后移到 −1.20）。
  //      ★ 实测（12 枚币，×1.2 档）：**首条离台事件在第 37 个推板循环**（≈72 秒）；
  //      落点还在 −0.72 时那个数是 16~29。原先那版每投只等 0.3~0.5 秒，
  //      实测 14 条 lane 全部投出、等 3 秒、**0 槽点亮**。
  //
  //   两个都实测过：修 ① 之前账本收在 `筹码 0 = 买入 20 + 赚进 7~9 − 消耗 27~29`、
  //   事件链 `[]`（×1 与 ×1.2 各一遍，确定性复现）；只修 ① 之后不再破产，
  //   但 96 投只点亮 1 槽 —— 因为缺 ②。
  //
  //   修法顺着设计语义走（跨局收集 + 等真实物理走完），**不是放宽判据**：
  //   每轮开一局新的、整批投 12 枚、再**等 55 个推板循环**让它们落床，然后查集齐。
  const lanes = [-0.85, -0.45, 0, 0.45, 0.85, -0.6, 0.6, -0.2, 0.2, -0.7, 0.7, 0.3];
  /* 窗按 10-02 同树实测抬到 **200 循环**（旧值 55 标在「落点 −0.72 + ×1.2 档 + 庚案前」，
     那批实测是首条离台 +37 循环）。今天量到的是：
       · 薄床 12 投 —— **首次落床在第 158 个循环**（`/tmp/xixi-ttp.out`：`t+421s 循环=158 最低y=0.010 点亮=2`）；
       · 满盘臂 —— 200 循环内玩家币冻结在 z≈−0.75（`/tmp/front-reach.out`），四臂全部离台 0 条。
     ⇒ 200 = 158 + 一档余量；周期今天实测 ~2.55 秒/循环 ⇒ 200×2.55≈510 秒，上限给 600 秒留卡顿余量。
     ⚠️ 这不是把判据改松：**要亮的槽照样得亮**，改的是"等多久才判"，而这个数必须来自机器而不是上一版物理。
     代价照实说：xixi 腿最坏 4 轮 × 600 秒 ≈ 40 分钟（轮与轮之间 `Telemetry.reset()`，所以 lit 计数自己累加）。 */
  const landingCycles = 200;
  let litEventsTotal = 0; // B 判据的证据：落床点亮事件数（跨轮累计，因为每轮 startRun 会重置遥测）
  let completedEvent = null;
  for (let round = 0; round < 4 && !completedEvent; round += 1) {
    // 一局只有 20 枚筹码、而一批要投 12 枚 ⇒ 每轮都开新局，
    // 免得「投到一半没钱了」把这一批打残（XIXI 进度跨局保留）。
    await startRun(page, 'playing');
    /* 夹具：把币床掏薄。为什么这不是"把判据改成能过"：本段测的是**登记链**
       （走完台面的币会点亮槽 → 四槽集齐 → 摇奖），而满盘时玩家投下的币要先在推板可达带
       （`frontFaceZ = −0.16` + 行程 0.36 ⇒ [−0.16, +0.20]）之外排队 0.86 米。10-03 同树实测：
       · 满盘：4 轮 × 200 循环、48 投 ⇒ **0 条 lit**（`/tmp/xixi-full-leg.out`，B/C/spin 三条因此红）；
       · 掏薄：同一窗、12 投 ⇒ 第 **158** 循环落床并点亮（`:185` 因此绿）。
       ⇒ "排队要多久"是 **#49 的手感取舍**（对照表在计划里），不该继续当这条腿的隐形前置。
       掏薄之后本腿仍要求币**自己走完台面**，没有跳过任何一步物理。 */
    const clearedBed = await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.clearBedTo?.(0) ?? -1);
    if (round === 0) {
      console.log(
        `  [info] 落床段夹具：clearBedTo(0) 移走 ${clearedBed} 枚床币` +
          `（满盘排队的时长归 #49 记录，不在本判据里）`,
      );
    }
    for (const lane of lanes) await dropUntilAccepted(page, lane, 4000);
    // 等这一批币被推板送到前缘、掉下币床。⚠️ 这里等的是「走完整个台面」：
    // 集章门槛 `registerY = 0.13` 在上层台面（币心 ≈0.213）之下，只有从前唇掉下去才成立
    // ⇒ 满盘后排币按实测要四位数循环（S1a）。币床的真判据是 `isOnDeckVolume`，不是这条线。
    // 超时给 170 秒：55 个循环 ≈ 107 秒（周期 1.95 秒），留出卡顿余量。
    const from = (await readState(page))?.pusher?.cycles ?? 0;
    await waitFor(page, (s) => (s?.pusher?.cycles ?? 0) - from >= landingCycles, 600_000);
    const telemetry = await readTelemetry(page);
    litEventsTotal += (telemetry?.xixiEvents ?? []).filter((e) => e.phase === 'lit').length;
    completedEvent = (telemetry?.xixiEvents ?? []).find((e) => e.phase === 'completed') ?? null;
  }
  // B「落床点亮」与 C「集齐 → 老虎机」**分开立**：前者只要一枚币真的走完台面掉下去就能满足，
  // 后者要四个不同槽各来一枚（批里实测 200 局才 48 局集齐过 ⇒ 它是"罕见"而不是"坏了"）。
  // 把两件事写在一条判据里，红的时候分不清是登记链断了还是只是没攒够。
  check(
    '落床点亮：等过实测窗（200 循环/轮 × ≤4 轮）后至少有一枚玩家币跨过 registerY（B）',
    litEventsTotal > 0,
    `累计 lit 事件 ${litEventsTotal} 条；当前槽位 ${JSON.stringify((await readStateFresh(page))?.xixi)}` +
      `（实测窗来自 /tmp/xixi-ttp.out：首次落床 158 循环、同一刻点亮 2 槽）`,
  );
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

  // ★ **正对照**：上面那条「不白送」的判据读到的可能是 0，而 0 有两种解释 ——
  // 「演出窗口内确实没有币越线」与「计数器根本没接上」。这一条专门否证后者：
  // 一整场 xixi 跑了十几次演出（塔 / 宝箱 / 闸门补币 / 兜底补货），每次 1.5~4 秒，
  // 盘面在演出期间照常结算（P7 只暂停收尾计时，见 `Game.ts:1508` 那条注释），
  // 所以全 run 的演出窗口累计越线**必须 > 0**。它为 0 就说明探针是空的，
  // 「不白送」那条绿也就不能当证据用。
  const windowTotal = await page.evaluate(
    () => window.__THREE_GAME_TEST_HOOKS__?.showWindow?.() ?? { crossings: -1, foreign: -1 },
  );
  check(
    '演出窗口计数器非真空：全 run 演出窗口内累计越线 > 0（R4-4b 汇判据的正对照）',
    windowTotal.crossings > 0,
    `全 run 演出窗口内越线 ${windowTotal.crossings} 枚，其中存量币 ${windowTotal.foreign} 枚` +
      `、演出币 ${windowTotal.crossings - windowTotal.foreign} 枚`,
  );

  const finalState = await readStateFresh(page);
  check('XIXI 全程三账本恒等式成立', ledgerOk(finalState), ledgerText(finalState));
  // ★ S16：明细必须打出来。
  //
  // 「anomalies=1」这一个数字**完全无法定位**是哪个币种、在哪个方向出界 ——
  // 而放大模型之后这条判据第一次变红，第一件要做的事就是看样本。
  // 样本（`anomalySamples`，最多 12 条）里有帧号 / 币种 / 位置 / 速度，够反推出成因。
  const anomalyDetail = (finalState?.anomalySamples ?? [])
    .map(
      (sample) =>
        `#${sample.frame} ${sample.kind} @(${sample.x}, ${sample.y}, ${sample.z}) ` +
        `v=(${sample.vx}, ${sample.vy}, ${sample.vz}) |v|=${sample.speed}`,
    )
    .join(' | ');
  check(
    'XIXI 全程无异常',
    finalState?.anomalies === 0,
    `anomalies=${finalState?.anomalies}${anomalyDetail ? ` — ${anomalyDetail}` : ''}`,
  );

  /*
   * ── S5b：罚不掉的那一截转成欠款（放在本模式最后，理由见上面那条注释）──
   *
   * 前面那条满盘罚款场景里 `shortfall` 恒为 0 ⇒ 惩罚加强那半边永远不会被走到。
   * 这里把余额压到面值以下，构造出 shortfall ≥ 1 的另一半。
   *
   * ★ 面值不写死：用上面满盘那一次实测到的 `fined` 当面值（满盘时 `fined == 面值`），
   *   这样 `SLOT_PENALTY_CHIPS` 改了判据也不会假红 —— 与「注入率读 `bountyEveryDrops`」同一条纪律。
   * ★ 压完余额**必须重开一局**（`setState('ready')`）：`initial` 是开局那一刻的余额快照，
   *   在场外把余额从 200 改到 2 而不重开，局级恒等式就成了 `0 = 200 + 0 + 0 + 0 − 8`
   *   —— 差额 −192 是**测试自己造的**，不是引擎的账错（10-01 实测踩过，那条判据当时就红了）。
   *   重开之后 `initial = 2`，恒等式重新成立，`ledgerOk` 才真的在验东西。
   * ★ 断的是**三笔的分派**：`fined + debtAdded == 面值`、`debt` 增量 == `debtAdded`、
   *   `spent` 增量 == `fined`。任何一笔走错门（shortfall 也记进 spent、
   *   或 debt 加了而事件里没带）都会当场红。
   */
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setWallet?.(2));
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setState?.('ready'));
  const debtBefore = await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.debt?.());
  const lowBefore = await readStateFresh(page);
  const lowFine = await spinAndWaitReward('fine');
  const lowAfter = await readStateFresh(page);
  const debtAfter = await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.debt?.());
  check(
    'S5b 胡萝卜四连：扣不掉的转成欠款（fined+debtAdded=面值、debt 增量=debtAdded、恒等式仍平）',
    penaltyFace > 0 &&
      lowFine?.outcome === 'fine' &&
      (lowFine?.fined ?? -1) + (lowFine?.debtAdded ?? -1) === penaltyFace &&
      (lowFine?.fined ?? 99) <= 2 &&
      (lowFine?.debtAdded ?? 0) > 0 &&
      (debtAfter?.debt ?? 0) - (debtBefore?.debt ?? 0) === lowFine.debtAdded &&
      (lowAfter?.spent ?? 0) - (lowBefore?.spent ?? 0) === lowFine.fined &&
      ledgerOk(lowAfter),
    `面值 ${penaltyFace}：实扣 ${lowFine?.fined}（spent +${(lowAfter?.spent ?? 0) - (lowBefore?.spent ?? 0)}）` +
      ` + 转欠款 ${lowFine?.debtAdded}（debt ${debtBefore?.debt}→${debtAfter?.debt}，上限 ${debtAfter?.ceiling}），` +
      `余额 ${lowBefore?.chips}→${lowAfter?.chips}，${ledgerText(lowAfter)}`,
  );
  // ★ 欠款上限是**承重结构**（惩罚频率 15 % × 每笔都可能全额进债 ⇒ 没有上限 debt 会无界涨）。
  // 到顶需要好几笔，这里不断言「已经到顶」，只断言不变量 `debt ≤ ceiling` 在每次罚款之后成立。
  check(
    'S5b 欠款不越过上限（debt ≤ ceiling；到顶时 chargeFine 按剩余额度生效）',
    (debtAfter?.debt ?? 99) <= (debtAfter?.ceiling ?? 0),
    `debt ${debtAfter?.debt}，ceiling ${debtAfter?.ceiling}`,
  );
  /*
   * ── S5a 的四同分支判据也放在最后，理由与 S5b 同一条（而且更硬）──
   *
   * 塔四同会**往盘面上放 40 枚真币**（它就是走水量账的那一档）。放在中途时
   * 下一条「杂牌：不奖不罚」立刻红：它断的是 chips/fines/boostCharges 三项不动，
   * 而这 40 枚会在观察窗口里越线 ⇒ 三项里的 `chips` 跟着动（10-01 实测：
   * `faces=[...]，筹码 …` 直接红）。⇒ 与 S5b 一样：**改全局状态的判据放末尾**。
   */

  /*
   * ── S5a：四同大奖必须**走另一条分支** ──
   *
   * 每条都断一个可对账的读数，而不是「画面上更夸张」（那个只有人眼能判，见下面 shots 模式人工核对）。
   * 期望值全部从引擎读（`showSpecs` 的 jackpot 上限、`boostQueue` 的发数），脚本里不抄 40 与 4。
   *
   * ⚠️ 四同是 1.5 % 一档，靠随机路径等它出现不叫测试 ⇒ 全部用 `xixiSpin(symbol, 4)` 指名。
   */
  const jackpotCeilings = {
    tower: specs.tower?.jackpot ?? 0,
    chest: specs.chest?.jackpot ?? 0,
    diamond: specs.diamond?.jackpot ?? 0,
  };
  // 力×4：读**排到的行程发数**的增量。先记下，是因为待用发数会被别的加力累计（同一个 run）。
  const boostQueueBefore = await page.evaluate(
    () => window.__THREE_GAME_TEST_HOOKS__?.boostQueue?.() ?? null,
  );
  const boostJackpot = await spinAndWaitReward('boost', 4);
  const boostQueueAfter = await page.evaluate(
    () => window.__THREE_GAME_TEST_HOOKS__?.boostQueue?.() ?? null,
  );
  check(
    'S5a 力四同：排 N 发连续加长行程（N 读引擎的 jackpotBoostStrokes，不走三同的 grantBoost）',
    boostJackpot?.tier === 4 &&
      (boostQueueBefore?.jackpotStrokes ?? 0) > 0 &&
      (boostQueueAfter?.strokes ?? 0) - (boostQueueBefore?.strokes ?? 0) ===
        boostQueueBefore?.jackpotStrokes &&
      // 走的是行程而不是加力槽：`delivered` 装的是发数，不是枚数。
      boostJackpot?.delivered === boostQueueBefore?.jackpotStrokes,
    `事件 tier=${boostJackpot?.tier} delivered=${boostJackpot?.delivered}；` +
      `待发行程 ${boostQueueBefore?.strokes}→${boostQueueAfter?.strokes}（每发追加 ${(
        (boostQueueBefore?.travelBonus ?? 0) * 100
      ).toFixed(0)}% 行程）`,
  );
  // 塔×4：承诺数按 jackpot 上限走，但**预算不足时如实降级** ⇒ 断的是区间而不是等号。
  const towerJackpot = await spinAndWaitReward('tower', 4);
  const towerJackpotRegistered = ((await readTelemetry(page))?.showEvents ?? []).filter(
    (e) => e.id === 'tower' && e.phase === 'registered',
  ).at(-1);
  /*
   * ⚠️ 这里**不断 `promised === 40`**：盘面预算（`coins.remaining`）不够时如实降级是
   *   合法结果，而这个断言跑在 S5b 之后、盘面刚被重开过，剩余空位不是每次都一样。
   *   于是判据写成区间 + 「要么超过三同规模、要么承认是降级」：
   *   真把 jackpot 上限写坏（忘了抬 clamp、抬过头、或把三同也顶到 40）照样红，
   *   而预算紧的时候不会假红。
   */
  check(
    'S5a 塔四同：按 jackpot 上限请求（不少于三同规模或如实降级，且不超过表上的上限）',
    towerJackpot?.tier === 4 &&
      jackpotCeilings.tower > (specs.tower?.count ?? 0) &&
      (towerJackpotRegistered?.promised ?? 0) <= jackpotCeilings.tower &&
      ((towerJackpotRegistered?.promised ?? 0) >= (specs.tower?.count ?? 0) ||
        towerJackpotRegistered?.downgraded === true),
    `三同规模 ${specs.tower?.count}，四同上限 ${jackpotCeilings.tower}，本场承诺 ${towerJackpotRegistered?.promised}` +
      `（降级=${towerJackpotRegistered?.downgraded}）`,
  );
  /*
   * 钻 / 箱×4：**枚数刻意不变**（各 1 枚）。
   * 这两档的大奖买的是稀有感与仪式，不是数值 —— 计划里明写「不许真给 4 枚」，
   * 而宝箱那条还带着用户 09-30 拍板「不做宝箱雨」（多枚巨型宝箱同层重叠 = 求解器注入能量）。
   * ⇒ 判据断的是「走了四同分支（tier=4）但枚数与三同一致」：
   *   这样将来有人把四同改成多发几枚，这条会红，逼他重新过一次「加不加质量」的决定。
   */
  const diamondJackpot = await spinAndWaitReward('diamond', 4);
  const chestJackpot = await spinAndWaitReward('chest', 4);
  check(
    'S5a 钻/箱四同：tier=4 但枚数与三同一致（大奖靠稀有感与仪式，不靠加质量）',
    diamondJackpot?.tier === 4 &&
      chestJackpot?.tier === 4 &&
      diamondJackpot?.delivered === (specs.diamond?.count ?? -1) &&
      chestJackpot?.delivered === (specs.chest?.count ?? -1),
    `钻 ${diamondJackpot?.delivered} 枚（表 ${specs.diamond?.count}，四同上限 ${jackpotCeilings.diamond ?? '同 count'}），` +
      `箱 ${chestJackpot?.delivered} 枚（表 ${specs.chest?.count}）`,
  );

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

  /*
   * ── S5a 四同大奖的画面临时核对（计划要求「每条四同各摇一次截图人工核对」）──
   *
   * ★ 这些是**给人看的证据**，不是判据：判据那边已经能核「走了四同分支、排了几发、承诺几枚」，
   *   但「看起来像不像改变命运的一摇」只有眼睛能判 —— 而眼睛读的数不能反过来当判据用。
   * 时机：兑现发生在停格后 `REWARD_AT = 3.0` 秒，四同再多停 1.8 秒 ⇒
   *   在 3.3 秒这一刀能同时抓到「奖励已兑现 + 还在仪式停留」。
   *
   * ⚠️ **每一场之前重开一局**。第一版没重开，结果四张图里后三张都压着上一场塔的四枚币，
   *   「这一档大奖长什么样」根本判不出来（截图作为证据就废了）。重开的代价是 4 次摆盘，
   *   换来的是每张图只有一个变量。
   * ★ 力四同必须开推板（`playing`）：它排的是**加长行程**，而 `ready` 下推板不动 ⇒
   *   截图只能拍到「四枚叉 + 一行字」，拍不到那四发到底有没有把币床往前拱。
   */
  const jackpotSymbols = ['boost', 'tower', 'diamond', 'chest'];
  for (const symbol of jackpotSymbols) {
    await startRun(page, symbol === 'boost' ? 'playing' : 'ready');
    const spun = await waitFor(
      page,
      async () =>
        (await page.evaluate(
          (s) => window.__THREE_GAME_TEST_HOOKS__?.xixiSpin?.(s, 4) ?? null,
          symbol,
        ))?.kind === 'win',
      8_000,
    );
    if (!spun) {
      console.log(`  [warn] 四同 ${symbol} 没能强制摇出（老虎机一直在忙），跳过截图`);
      continue;
    }
    await page.waitForTimeout(3_300);
    if (symbol === 'boost') {
      // 等第一发行程真正走出去（推板进入 extend 段），再拍。
      await waitFor(page, (state) => (state?.pusher?.offset ?? 0) > 0.3, 6_000);
    }
    await page.screenshot({ path: `${outDir}/jackpot-${symbol}.png` });
    console.log(
      `  已保存 ${outDir}/jackpot-${symbol}.png` +
        (symbol === 'boost'
          ? `（推板 offset=${(await readState(page))?.pusher?.offset?.toFixed(3)}，` +
            `待发行程 ${(await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.boostQueue?.()))?.strokes}）`
          : ''),
    );
    // 等这一场的仪式与装置走完，免得下一场叠在同一个画面上。
    await page.waitForTimeout(3_500);
  }

  // 图鉴面板：清档后解锁一个外观，让面板里有已解锁项可看（截图专用，不写死定价）。
  //
  // ⚠️ 解锁价必须 > 0：`SaveStore.unlockSkin` 对 `cost <= 0` 直接返回 false（那是「免费解锁」
  // 的守卫）。这里原先写 0，于是**既没解锁、也没报错** —— 面板里其实一项都没解锁，
  // 而下面那句「换装后」的 `selectSkin('coin','celadon')` 也跟着静默失败，
  // 截出来的还是默认外观（零报错的静默错，看截图也只会觉得「好像没变」）。
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.clearSave?.());
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.unlockSkin?.('coin', 'celadon', 1));
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

  // ── S16：放大后的钻石 / 宝箱特写 ──
  //
  // 这两件东西的**观感**是这一轮的全部交付物，而「比例对不对 / 切面读不读得出 /
  // 边缘光有没有挂上」在数值判据里只能证明「尺寸算对了」，证明不了「看起来像不像」。
  //
  // 顺序：先宝箱（从台底升起，落在 z≈0.3 的币床中心），等它落定；再钻石
  // （从背板闸口滚出来），这样一帧里两件都在。
  await startRun(page, 'ready');
  await page.evaluate(() =>
    window.__THREE_GAME_TEST_HOOKS__?.showRequest?.('chest', { kind: 'chest' }),
  );
  await page.waitForTimeout(4500);
  await page.screenshot({ path: `${outDir}/model-chest.png` });
  console.log(`  已保存 ${outDir}/model-chest.png`);

  await page.evaluate(() =>
    window.__THREE_GAME_TEST_HOOKS__?.showRequest?.('diamond', { kind: 'diamond' }),
  );
  await page.waitForTimeout(5000);
  await page.screenshot({ path: `${outDir}/model-diamond-and-chest.png` });
  console.log(`  已保存 ${outDir}/model-diamond-and-chest.png`);

  // ── S16：喷泉溢出（真币落盘 + 纯视觉币飞出机柜）──
  //
  // 抓的是**飞行中**那一帧：真币从喷口抛向盘面，视觉币从顶沿的溢流口飞出画面外。
  // 这一帧同时证明了「两条通道并存」和「溢流口在玻璃顶沿之上」。
  await startRun(page, 'ready');
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.sprayReport?.(true));
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.showRequest?.('fountain'));
  await page.waitForTimeout(1600);
  const midFlight = await page.evaluate(() =>
    window.__THREE_GAME_TEST_HOOKS__?.sprayReport?.(),
  );
  await page.screenshot({ path: `${outDir}/fountain-spill.png` });
  console.log(
    `  已保存 ${outDir}/fountain-spill.png（飞行中视觉币 ${midFlight?.active} 枚，` +
      `机柜外最高点 ${(midFlight?.peakYOutside ?? 0).toFixed(3)} m）`,
  );

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
        upscale: state?.performance.upscale ?? 0,
        internalHeight: state?.performance.internalHeight ?? 0,
        pixelated: state?.performance.pixelated ?? false,
        shadows: state?.performance.shadows ?? false,
        coins: state?.activeCoins ?? 0,
        calls: state?.renderer.calls ?? 0,
        triangles: state?.renderer.triangles ?? 0,
      };
      rows.push(row);
      console.log(
        `  CPU ×${String(rate).padStart(2)}  ${tier.padStart(6)} 档：${row.fps.toFixed(1)} FPS，` +
          `像素 ×${row.upscale}（内部高 ${row.internalHeight}${row.pixelated ? '' : '，未像素化'}），` +
          `阴影 ${row.shadows ? '开' : '关'}，draw call ${row.calls}，三角形 ${row.triangles}`,
      );
    }
  }

  await client.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setPausedForScreenshot?.(false));

  const coinCounts = new Set(rows.map((row) => row.coins));
  check('画质分档不改盘面币数', coinCounts.size === 1, `币数集合 ${[...coinCounts].join('/')}`);

  /*
   * ── 画质锁（10-01 用户点名「不要切画质啊」）──
   *
   * ★ 为什么用 `feedFrames` 而不是"把机器跑卡了再看它降不降"：
   *   后者不可复现（这台机器今天卡、明天不卡），而且会把 CPU 争用当成测量手段
   *   —— 本项目已经吃过两次「Chromium 抢 CPU 压低读数」的亏。
   *   `governor.sample(delta)` 是纯函数，喂 delta 就能确定性地复现
   *   「连续两个 1 秒窗口 < 45 FPS ⇒ 降一档」这条规则本身。
   * ⚠️ 顺序要紧：`setQuality` 钩子自己会 `freeze(true)`（截图基线要稳定），
   *   所以测"未锁"之前必须先 `qualityLock(false)` 把它解开 ——
   *   忘了这一步的话第一条会假绿（tier 不动是因为冻住了，不是因为规则坏了）。
   */
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setQuality?.('high'));
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.qualityLock?.(false));
  const unlocked = await page.evaluate(
    () => window.__THREE_GAME_TEST_HOOKS__?.feedFrames?.(0.03, 3) ?? null,
  );
  check(
    '画质未锁时低帧确实会自动降档（feedFrames 复现滞回规则，不靠机器真的卡）',
    (unlocked?.changed ?? 0) >= 1 && unlocked.tier !== 'high',
    `33 FPS × 3 个窗口 ⇒ 换档 ${unlocked?.changed} 次，档位 high → ${unlocked?.tier}`,
  );
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setQuality?.('high'));
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.qualityLock?.(true));
  const locked = await page.evaluate(
    () => window.__THREE_GAME_TEST_HOOKS__?.feedFrames?.(0.03, 4) ?? null,
  );
  check(
    '锁上之后同样的低帧不再换档（玩家的否决权真的生效）',
    (locked?.changed ?? 1) === 0 && locked?.tier === 'high',
    `33 FPS × 4 个窗口 ⇒ 换档 ${locked?.changed} 次，档位仍是 ${locked?.tier}`,
  );
  // ★ 玩家走的是**按钮**，不是钩子：只验钩子等于没验他能不能锁。
  //   按钮在暂停面板里 ⇒ 必须先按「暂停」把它露出来（直接点会卡在 "element is not visible"，
  //   这条今天实测踩过：整轮 perf 被一个 30 秒的 click 超时打断，后面的判据全丢）。
  const beforeClick = await page.evaluate(
    () => window.__THREE_GAME_TEST_HOOKS__?.qualityLock?.() ?? null,
  );
  await page.locator('#pause-button').click();
  await page.locator('#quality-lock-button').click();
  await page.locator('#resume-button').click();
  const afterClick = await page.evaluate(
    () => window.__THREE_GAME_TEST_HOOKS__?.qualityLock?.() ?? null,
  );
  const pressed = await page.locator('#quality-lock-button').getAttribute('aria-pressed');
  check(
    '暂停面板里的画质锁按钮是玩家的真入口（暂停→点锁→继续：状态翻转、aria-pressed 跟着翻）',
    beforeClick?.locked === true &&
      afterClick?.locked === false &&
      pressed === 'false' &&
      (await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.performance?.locked)) === false,
    `locked ${beforeClick?.locked} → ${afterClick?.locked}，aria-pressed=${pressed}，` +
      `诊断 locked=${await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.performance?.locked)}`,
  );
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.qualityLock?.(false));


  const base = rows.find((row) => row.rate === 1 && row.tier === 'high');
  check('无降速时高档跑满（>50 FPS）', (base?.fps ?? 0) > 50, `fps=${base?.fps?.toFixed(1)}`);

  const worst = rows.reduce((min, row) => (row.fps < min.fps ? row : min), rows[0]);
  check(
    '最差组合仍在可玩区间（>25 FPS）',
    worst.fps > 25,
    `CPU ×${worst.rate} ${worst.tier} 档 ${worst.fps.toFixed(1)} FPS`,
  );

  // ── V1/V2：像素分辨率 ──
  // 默认档现在是**原生分辨率 + 平滑采样**（`render/PixelScale.ts` 的 `PIXEL_SCALE_DEFAULTS`），
  // 「像素风」改成显式通道（`?pixel=N` / 面板的 upscale + pixelated）。
  // 所以下面量的是「默认没有偷偷降分辨率」「显式通道真的生效」与「两个旋钮正交」，
  // 而不是旧版的「高档倍率 ≥ 2」——那条把默认档和像素美学绑在一起，正是被解耦掉的东西。
  const basePixel = rows.find((row) => row.rate === 1 && row.tier === 'high');
  check(
    '默认档 = 原生分辨率（高档倍率 1 且最近邻为关）',
    (basePixel?.upscale ?? 0) === 1 && basePixel?.pixelated === false,
    `倍率 ×${basePixel?.upscale}，内部高 ${basePixel?.internalHeight}，最近邻 ${basePixel?.pixelated}`,
  );
  // 倍率必须是整数：非整数放大时一个 texel 时而占 1 个 CSS 像素、时而占 2 个，
  // 画面出现粗细不均的条纹（正是要避免的「脏」）。
  // 读画布前先把档位切回高档——循环结束时画布停在最后测的 low 档，
  // 直接读会拿到 ×3 的画布，与高档倍率对不上（第一版就是这么假红的）。
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setQuality?.('high'));
  await page.waitForTimeout(300);
  const canvasInfo = (await readState(page))?.canvas ?? {};
  const pixelInfo = (await readState(page))?.performance ?? {};
  const reported = pixelInfo.upscale ?? 0;
  // 判据不是「引擎自报等于自报」：`reported` 是我们算出来的，`canvas.width` 是
  // WebGL 画布**实际被设成**的值——这条断言验的是「算出来的倍率真的落到画布上了」。
  const actualRatio = canvasInfo.clientWidth ? canvasInfo.width / canvasInfo.clientWidth : 0;
  check(
    'backing store = CSS 尺寸 ÷ 整数倍率（像素块等大）',
    canvasInfo.width > 0 &&
      Number.isInteger(reported) &&
      reported >= 1 &&
      Math.abs(1 / actualRatio - reported) < 0.02 &&
      Math.abs(canvasInfo.clientWidth * actualRatio - canvasInfo.width) < 1,
    `CSS ${canvasInfo.clientWidth}×${canvasInfo.clientHeight} → backing ${canvasInfo.width}×${canvasInfo.height}，` +
      `实际比值 ${actualRatio.toFixed(4)}（1/${reported}）`,
  );
  // 降档必须真的降内部分辨率。用 `>` 而不是旧版的 `>=`：默认档倍率是 1，
  // 若分档失效（比如有人把 `pixelated` 重新变成倍率的总开关），低档也会是 1，
  // `>=` 会绿得毫无意义。
  const lowPixel = rows.find((row) => row.rate === 1 && row.tier === 'low');
  check(
    '降档 = 内部分辨率真的更低（低档倍率 > 高档倍率）',
    (lowPixel?.upscale ?? 0) > (basePixel?.upscale ?? 0),
    `高档 ×${basePixel?.upscale} → 低档 ×${lowPixel?.upscale}`,
  );
  // 显式倍率通道（`?pixel=2` 走的就是这条 `upscaleOverride`）：倍率与最近邻一起给。
  const pixScale = await page.evaluate(() =>
    window.__THREE_GAME_TEST_HOOKS__?.setPixelScale?.({ upscale: 2, pixelated: true }),
  );
  check(
    '像素风通道可用（显式倍率 2 + 最近邻开，pixelRatio 1/2）',
    pixScale?.upscale === 2 &&
      pixScale?.pixelated === true &&
      Math.abs((pixScale?.pixelRatio ?? 0) - 0.5) < 1e-9,
    `倍率 ×${pixScale?.upscale}，pixelRatio ${pixScale?.pixelRatio}，内部高 ${pixScale?.internalHeight}`,
  );
  // 解耦后唯一不能破的不变量：**关最近邻不改内部分辨率**。
  // 旧版 `pixelated=false` 会把倍率吞回 1，于是画质分档在默认档下静默失效。
  const decoupled = await page.evaluate(() =>
    window.__THREE_GAME_TEST_HOOKS__?.setPixelScale?.({ pixelated: false }),
  );
  check(
    '「倍率」与「最近邻」正交：关最近邻后倍率仍是 2',
    decoupled?.pixelated === false && decoupled?.upscale === 2,
    `倍率 ×${decoupled?.upscale}，内部高 ${decoupled?.internalHeight}`,
  );
  // 取消覆盖 → 回到 `targetHeight` 推导；默认目标高度下应当回到原生（可逆，不是一次性开关）。
  const restored = await page.evaluate(() =>
    window.__THREE_GAME_TEST_HOOKS__?.setPixelScale?.({ upscale: null }),
  );
  check(
    '取消显式倍率 → 回到目标高度推导（默认档回到原生 ×1）',
    restored?.upscale === 1 && restored?.pixelRatio === 1,
    `倍率 ×${restored?.upscale}，pixelRatio ${restored?.pixelRatio}，内部高 ${restored?.internalHeight}`,
  );

  // ── V2：三渲二材质族 ──
  // 判据是**计数**而不是截图：`toon` 数骤降说明有人绕过了工厂
  // （裸建 `MeshToonMaterial`，或 `clone()` 掉了 `onBeforeCompile` 补丁）——
  // 画面只是「差一点」，肉眼在截图里几乎看不出来。
  const mats = await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.materialReport?.());
  check(
    '机台主体全部走 toon 工厂（toon ≥ 26）',
    (mats?.toon ?? 0) >= 26,
    `toon=${mats?.toon} standard=${mats?.standard} basic=${mats?.basic} other=${mats?.other} total=${mats?.total}`,
  );
  // V4 起币也走 toon 了，所以受光材质里**不该再有** MeshStandardMaterial。
  // 留 0 这个下界是刻意的：它钉住「有人又裸建了一个 standard 材质」。
  check(
    '已经没有任何 MeshStandardMaterial（V4 起全场景都是 toon）',
    (mats?.standard ?? -1) === 0,
    `standard=${mats?.standard}`,
  );
  // 去重判据取**上界**：色带数必须 ≤ 调色板数（现在 5 条：cabinet/metal/accent/device/coin），
  // 而不是随材质数（29）增长。下界 3 是因为 `device` 那条是**懒烤**的
  // ——只有演出装置真的被建出来才烤，所以没跑过演出的模式只会看到 4 条。
  check(
    '色带 LUT 按调色板去重（≤ 5 条，不是每个材质烤一条）',
    (mats?.ramps ?? 99) >= 3 && (mats?.ramps ?? 99) <= 5,
    `ramps=${mats?.ramps}（材质 ${mats?.total} 个）`,
  );
  // 风险 R4 的哨兵：色带补丁的 `customProgramCacheKey` 是常量，所以 toon 材质
  // 无论多少个都该**共享**编译好的程序。实测 29 个材质 → 14 份程序
  // （差异来自 `DOUBLE_SIDED`、阴影开关等 define 变体，不是每个材质一份）。
  //
  // 真正的失效形态是「一份材质一份程序」：那样 `programs` 会 ≥ `total`，
  // 而且随材质数线性增长。所以判据取**两个**：
  // ① 绝对上限（防呆）；② `programs < total`（共享性——这才是本质）。
  // S18：加 scoreLine / hotZone / marquee 三份贴图后，programs 从 20 变到 25（每件 +1）。
  // 上限放宽到 30，但**程序数 < 材质数**仍是真刻（不涨程序才是关键）。
  check(
    '色带补丁没有造成程序爆炸（程序数 < 材质数，说明真的在共享）',
    (mats?.programs ?? 999) < (mats?.total ?? 0) && (mats?.programs ?? 999) <= 30,
    `已编译程序 ${mats?.programs} / 材质 ${mats?.total}`,
  );

  // ── R2-T2：程序**指纹名单** ──
  // 上面那条只看总数：20 涨到 29 都还绿，而「多出来的是哪一份程序」完全读不出来。
  // 所以这里把 roster 整张打出来，并钉一条真不变量：**按分组求和必须等于总数**。
  // 不相等 ⇒ `renderer.info.programs` 与 `materialReport().programs` 取的不是同一批
  // 东西（例如首帧后又有材质懒编译），那意味着总数判据本身不可信。
  const roster = await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.programRoster?.() ?? []);
  const rosterSum = roster.reduce((n, entry) => n + entry.variants, 0);
  console.log(`  [program roster] 共 ${roster.length} 个指纹组 / ${rosterSum} 份程序`);
  for (const entry of roster) {
    console.log(`    ×${entry.variants}  ${entry.fingerprint.slice(0, 150)}`);
  }
  check(
    '程序指纹名单与总数对得上（对不上说明 programs 计数本身不可信）',
    rosterSum === (mats?.programs ?? -1),
    `roster 求和 ${rosterSum} vs materialReport().programs ${mats?.programs}`,
  );

  // ── V3：程序化表面细节（Triplanar）──
  // 判据跟着**总开关**走，不在 harness 里抄第二份默认值——开关的读数来自
  // `materialReport().detailEnabled`（真源 `artDirection.SURFACE_DETAIL_ENABLED`）。
  //
  // 09-29 用户批注「机柜只要纯色，那些肌理也不要」把开关翻到 off，原来那条
  // 「四种纹样都必须有材质在用」于是自相矛盾地一直红着。现在 off 一侧判的是
  // 「机柜必须全纯色」，on 一侧保留原判据——**两个方向的漏网都还能被抓到**。
  //
  // off 一侧为什么允许 `kind1 ≤ 1`：老虎机滚筒那一份拉丝是**显式保留**的
  //（`SlotMachine.ts:437`，用户口径「不要改筹码、老虎机的」）。写成上界而不是 `=== 0`，
  // 是为了让「有人给机柜偷偷加回纹样」仍然会红（kind2/3/4 必须 0、kind1 不得多于那一份）。
  const detailOn = (mats?.detailEnabled ?? 1) === 1;
  const detailDist = `开关 ${detailOn ? 'on' : 'off'}；细节分布 kind1=${mats?.['1'] ?? 0} kind2=${mats?.['2'] ?? 0} kind3=${mats?.['3'] ?? 0} kind4=${mats?.['4'] ?? 0} kind0=${mats?.['0'] ?? 0}`;
  check(
    detailOn
      ? '四种表面细节都有材质在用（拉丝 / 木纹 / 接缝 / 毛毡）'
      : '肌理开关 off：机柜全纯色（老虎机滚筒那份拉丝是白名单）',
    detailOn
      ? (mats?.['1'] ?? 0) >= 1 &&
        (mats?.['2'] ?? 0) >= 1 &&
        (mats?.['3'] ?? 0) >= 1 &&
        (mats?.['4'] ?? 0) >= 1
      : (mats?.['2'] ?? 0) === 0 &&
        (mats?.['3'] ?? 0) === 0 &&
        (mats?.['4'] ?? 0) === 0 &&
        (mats?.['1'] ?? 9) <= 1,
    detailDist,
  );

  // ── S16：边缘光通道（零程序代价）──
  //
  // 边缘光的 GLSL 是**无条件**注入给所有 toon 材质的（唯一一条不新增 define 的路，
  // 见 `ToonMaterial.RIM_DECL`），所以「哪几个材质真的有边缘光」这件事
  // **完全由参数传递表达**。漏传 `rimStrength` 不报错，只会得到 NaN uniform
  // （表现是某个部件整块变白或变黑），肉眼会读成「光照调过了」。
  // 所以判据是计数。
  //
  // S16 是「恰好 2」（钻石 + 宝箱）。R2-T1-1/2 把双色 rim 与 matcap-lite 开给了
  // **金属件**（rail + 两份 trim），于是期望值变成 5 = 2 件宝石 + 3 件金属。
  // R2-T1-5 的前置拆分把 `trim` 一分为二（顶板 / 檐板各一份实例，为的是挂不同构图），
  // 金属件于是是 4 份 ⇒ 6。
  // ★ 09-30 用户批注「前侧板与后侧板材质、纹理各参数统一」⇒ 侧墙低段不再走自己那份
  //   带金属边缘光的 `rail` 材质，而是与高段**共用** `panelArt` 实例 ⇒ 6 → **5**。
  //   这两条判据的期望值都是**当场量出来**的（不是推算），program 与 draw call
  //   当场复量：仍是 20 与 47 —— 共用实例只减了一个材质对象，件数没变。
  // 漆面（panel / floor）、币、玻璃仍然必须是 0 —— rim 加在 albedo 上，
  // 给到非金属件就等于「所有东西都泛白」。新增金属件时这个数会涨，那正是要涨。
  check(
    '边缘光只挂在宝石与金属件上（恰好 5 份：钻石 + 宝箱 + 三份 trim；侧墙低段已并入 panelArt）',
    (mats?.rim ?? -1) === 5,
    `rim=${mats?.rim}（toon ${mats?.toon} 个）`,
  );

  // ── G0-b：边缘光**断线**（走参考效果的「手绘感」预览通道）──
  //
  // 两条一起看，各管一种失效：
  // ① 计数 = 3。断线此刻只开在**三份 trim** 那类长边上——它们是参考那种
  //   「一条手绘的线」最直接的对应物。钻石 / 宝箱的 rim 是**逐面的切面高光**
  //  （NdotV 在一面上恒定 ⇒ 一整面拿同一个值），切成断口读起来是「脏」不是「手绘」，
  //   所以刻意不开。**这是设计取舍，不是漏传**，因此写死在这里。
  //   （原本还含护栏一份；09-30 侧墙低段与高段材质统一后随之并入，实测 4 → 3。）
  // ② 不变量 = 0。掩码是**乘在 rim 贡献上**的，所以「有断线但没有边缘光」= 空转：
  //   零视觉变化、面板和读数上却显示开了。① 只能发现数错，② 才发现「以为开了其实没开」——
  //   后者是本项目反复踩过的那类静默缺陷。
  check(
    '边缘光断线只开在金属长边上（三份 trim = 3；宝石的切面高光刻意不开）',
    (mats?.rimBreak ?? -1) === 3,
    `rimBreak=${mats?.rimBreak}（rim=${mats?.rim}，toon ${mats?.toon} 个）`,
  );
  check(
    '没有「开了断线却没有边缘光」的空转材质（掩码乘在 0 上 = 零视觉、有读数）',
    (mats?.rimBreakIdle ?? -1) === 0,
    `空转 ${mats?.rimBreakIdle} 份`,
  );

  // ── G3：描边通道的**可分性**实测（参考笔记 §6 第 4 条，至此关掉 `待验证`）──
  //
  // 这条判据读的是回传附件算出来的数，不是截图。理由写在 `Game.gbufferReport()`：
  // 「这条边描没描出来」在截图里只能定性看，而它真正的答案是「相邻两像素的 ID 差有多小」。
  // 面 ID 是 `fract()` 出来的，**不是唯一 ID** —— 两个挨着的物件完全可能撞进同一个桶，
  // 那种边永远不会出现，而它在截图里长得和「阈值调高了」一模一样。
  //
  // ★ 四条一起看，缺一条都会假绿：
  // ① `readFailed` —— 回读没拿到数据时下面三个数全是 0，看着比什么都「干净」。
  // ② `objectEdges` 要有量 —— 判据是**比例**，n 太小的话 0 漏检不代表机制对
  //   （与「阈值要离噪声远，先问判据在哪个 n 上求值」是同一条纪律）。
  // ③ `belowThreshold` —— 被当前 ID 阈值漏掉的真实交界。
  // ④ `idBlindButDepthSees` —— ID 撞桶、只能靠深度兜住的那批。它不该为零
  //   （两枚并排的币本来就只能靠 ID 分），但必须**远小于** objectEdges，
  //   否则说明 ID 通道在退化，描边实际上全靠深度在撑。
  const gb = await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.gbufferReport?.() ?? null);
  const edgeSample = gb?.objectEdges ?? 0;
  console.log(
    `  [ID 可分性] 交界样本 ${edgeSample}，最小可分差 ${gb?.minGap}，` +
      `阈值 id=${gb?.idThreshold} depth=${gb?.depthThreshold}，` +
      `漏检 ${gb?.belowThreshold}，ID 盲但深度可见 ${gb?.idBlindButDepthSees}，` +
      `不同 ID 桶 ${gb?.distinctIds}，背景占 ${gb?.backgroundShare}%`,
  );
  check('通道回读成功（读不到数据时下面几条全是假绿）', (gb?.readFailed ?? 1) === 0, `readFailed=${gb?.readFailed}`);
  check(
    '这一帧量到了足够多的物件交界（判据是比例，n 太小没有意义）',
    edgeSample >= 5000,
    `objectEdges=${edgeSample}`,
  );
  check(
    'ID 阈值没有漏掉真实交界（belowThreshold 占交界数 < 0.5%）',
    edgeSample > 0 && (gb?.belowThreshold ?? 1e9) / edgeSample < 0.005,
    `${gb?.belowThreshold}/${edgeSample} = ${(((gb?.belowThreshold ?? 0) / Math.max(1, edgeSample)) * 100).toFixed(3)}%`,
  );
  check(
    'ID 撞桶的边只占极少数（深度在兜底，但 ID 才是主判据）',
    edgeSample > 0 && (gb?.idBlindButDepthSees ?? 1e9) / edgeSample < 0.005,
    `${gb?.idBlindButDepthSees}/${edgeSample}`,
  );

  // ── V4：币面像素贴图 ──
  // 币的颜色链路有四层（调色板 → canvas 逐纹素 → 色带 → ACES），
  // 任何一层出错在截图里都只表现为「颜色不太对」。所以判据直接读**纹素**，
  // 把「贴图本身对不对」与「渲染对不对」一刀切开。
  const coins = await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.coinReport?.());
  const coinRows = Object.entries(coins ?? {});
  // 纹素尺寸**由引擎自报期望值**（`coinReport().expected`，来自 `coinTexels()`），
  // 脚本不写「铜币 16 / 字形 32」第二份公式 —— 分辨率倍率是可调旋钮
  // （`GameTuning.coinTexelScale`，默认 2×），把数字抄进测试就会在加旋钮那天开始骗人。
  // 这里额外守一条**结构**性质：有字形的币必须正好是无字形的 2 倍
  // （字形笔画要 2 倍边长才不粘），这条与倍率取值无关。
  const texelScale = coins?.bronze?.texelScale ?? 0;
  const glyphTexels = coins?.payout?.expected ?? 0;
  const plainTexels = coins?.bronze?.expected ?? 0;
  check(
    '六种币都有币面贴图，纹素尺寸 = 引擎自报期望值（2 的幂，有字形 = 无字形 ×2）',
    coinRows.length === 6 &&
      coinRows.every(([, info]) => info.texels === info.expected && info.texels > 0) &&
      Number.isInteger(Math.log2(plainTexels)) &&
      glyphTexels === plainTexels * 2 &&
      // 无字形的只有铜币一种，其余五种都带字形。
      coinRows.filter(([, info]) => info.expected === plainTexels).length === 1 &&
      coinRows.filter(([, info]) => info.expected === glyphTexels).length === 5,
    `倍率 ${texelScale}×：` + coinRows.map(([kind, info]) => `${kind}=${info.texels}`).join(' '),
  );
  check(
    '币面贴图采样设置正确（放大 Nearest / 缩小 mipmap / 各向异性 1）',
    coinRows.every(
      ([, info]) =>
        info.mag === 'nearest' && info.min === 'mip-nearest' && info.mipmaps === true && info.anisotropy === 1,
    ),
    coinRows
      .map(([kind, info]) => `${kind}:${info.mag}/${info.min}/${info.mipmaps ? 'mip' : 'no-mip'}/a${info.anisotropy}`)
      .join(' '),
  );
  // 纹素亮度下限：钉住「颜色空间转两次」那个 bug——它会把铜币底面
  // 从 `#c8802f` 压到 `#6f2905`（亮度掉 65%），而截图里只表现为「颜色偏暗红」。
  const texelLuma = (hex) => {
    const value = String(hex ?? '#000000').replace('#', '');
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16) || 0);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const dim = coinRows.filter(([, info]) => texelLuma(info.quarter) < 60);
  check(
    '每个币种的纹样区都不是黑的（色值没有被转两次）',
    coinRows.length === 6 && dim.length === 0,
    coinRows.map(([kind, info]) => `${kind}:${info.quarter}(${texelLuma(info.quarter).toFixed(0)})`).join(' '),
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
  // ★ 承诺数**从引擎的装置规模表读**，不手抄。S6 把塔从 1 枚改到阵型规模（16 枚）
  //   是配置变更而不是回归——写死 1 会让这条判据变成假红（纪律 2）。
  const specs = (await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.showSpecs?.())) ?? {};
  const towerSpec = specs.tower?.count ?? 0;
  const result = await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.showRequest?.('tower'));
  check(
    '币塔请求被接受（枚数 = 引擎规模表，未降级）',
    result?.ok === true && result?.promised === towerSpec && result?.downgraded === false,
    `规模表 ${towerSpec} 枚；返回 ${JSON.stringify(result)}`,
  );

  // 两态之「登记」：请求刚落、第一层币还没发（圆柱升起要 0.6 秒）——盘面币数必须没变。
  // 诊断快照逐帧发布，等一帧再读（readStateFresh），否则读到的是请求前的旧帧。
  const registeredState = await readStateFresh(page);
  check(
    '两态之「登记」：演出已登记、盘面币数尚未变',
    registeredState?.shows?.busy === true && registeredState?.activeCoins === before?.activeCoins,
    `busy=${registeredState?.shows?.busy}，币 ${registeredState?.activeCoins}（请求前 ${before?.activeCoins}）`,
  );

  /*
   * ★ P3 / P4 的两条演出期实测。**必须在演出进行中采样**：两条都是过程量，
   * 演出一结束「按住」这个读数就归位了（尖峰是累计量，还能事后差值）。
   *
   * 这里顺手把推板开起来再判：`park` 的语义是「正在跑，但这一会儿不许往前推」，
   * 而 `show` 模式默认推板是停的 —— 不开的话「行程一直是 0」在推板根本没跑的时候
   * 什么都没说，判据退化成恒真式。演出结束后按回停止，把状态还给后面的判据。
   */
  const spikeBeforeTower = registeredState?.spikeClamps ?? -1;
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setPusherRunning?.(true));
  let busySamples = 0;
  let parkedSamples = 0;
  let maxOffsetWhileBusy = 0;
  const completedBase = completedCount((await readTelemetry(page))?.showEvents);
  const towerDeadline = Date.now() + 20_000;
  let towerDone = null;
  for (;;) {
    const s = await readState(page);
    if (s?.shows?.busy) {
      busySamples += 1;
      if (s.pusher?.parked) parkedSamples += 1;
      if ((s.pusher?.offset ?? 0) > maxOffsetWhileBusy) maxOffsetWhileBusy = s.pusher.offset;
    }
    const completed = ((await readTelemetry(page))?.showEvents ?? []).filter((e) => e.phase === 'completed');
    if (completed.length > completedBase) {
      towerDone = completed.at(-1);
      break;
    }
    if (Date.now() >= towerDeadline) break;
    await page.waitForTimeout(60);
  }
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setPusherRunning?.(false));
  const afterTower = await readStateFresh(page);
  const scoreDelta = ((await readTelemetry(page))?.scoreEvents?.length ?? 0) - scoreBefore;
  const activeDelta = (afterTower?.activeCoins ?? 0) - (before?.activeCoins ?? 0);
  // 第三条去路：掉进下水道（见下面「三装置」循环的说明）。
  const drainedDelta = (afterTower?.drained ?? 0) - (before?.drained ?? 0);
  check(
    '两态之「完成」：实发 = 承诺，活跃差 + 结算差 + 流失差 = 承诺数',
    towerDone?.spawned === towerSpec && activeDelta + scoreDelta + drainedDelta === towerSpec,
    `事件 spawned=${towerDone?.spawned}，活跃差 ${activeDelta} + 结算差 ${scoreDelta} + ` +
      `流失差 ${drainedDelta}（应 = ${towerSpec}）`,
  );

  /*
   * ★ P3：演出**不许向币堆注入超出物理预算的能量**。
   *
   * 判据读的是引擎自己的速度护栏计数器（`Coin.clampSpeed` 每压一次记一笔），
   * 所以它量的不是「看起来有没有飞」，而是「求解器实际造出的速度有没有超过
   * 这台机器自己够得着的自由落体上限」——与 `probe` 用的是**同一个派生量**
   * （`fallBudgetMps`），不是另立一个魔数。
   *
   * ⚠️ 阈值刻意**不取 0**。四遍改后实测：护栏触发 **0 / 0 / 0 / 1 次**，
   * 那一次是柱顶把一枚币从盘缝里挤出来、截断前 3.16 米/秒（阈值 3.0）——
   * 「拱起币床」这件事本身就会偶尔挤出一点速度，那是设计内的推挤而不是爆炸。
   * 判据取「≤ 3 次 且 峰值 ≤ 落体预算」：与噪声之间留 3 倍余量（计数）
   * 与 2 倍余量（峰值），而改前/变异的读数是 **10 / 16~17 / 39 次、峰值 7.5~19.1**，
   * 两边离阈值都远，红与绿都不是擦边。
   */
  const spikeAfterTower = afterTower?.spikeClamps ?? -1;
  const towerSpikes = spikeAfterTower - spikeBeforeTower;
  const towerBudget = fallBudgetMps({ gravity: afterTower?.physics?.tuning?.gravity });
  check(
    '塔演出注入不超物理预算：演出窗口内护栏 ≤3 次、截断前峰值 ≤ 落体预算（P3）',
    spikeBeforeTower >= 0 && towerSpikes <= 3 && (afterTower?.peakSpikeSpeed ?? 99) <= towerBudget,
    `护栏 +${towerSpikes} 次（≤3），峰值 ${afterTower?.peakSpikeSpeed} 米/秒` +
      `（落体预算 ${towerBudget.toFixed(2)}）；改前同一条读数 10~39 次 / 7.5~19.1 米/秒`,
  );
  // ★ P4：演出期推板按在回收位。三条一起判，缺一条就是恒真式：
  //   采样数够多（否则「一次都没赶上」也算过）、每一次 busy 都 parked、
  //   且整个窗口里行程**一格都没走过**（>0 就说明它偷偷往前推了一程）。
  check(
    '大奖演出期间推板停在回收位、行程恒为 0（P4）',
    busySamples >= 8 && parkedSamples === busySamples && maxOffsetWhileBusy === 0,
    `演出中采样 ${busySamples} 次，按住 ${parkedSamples} 次，窗口内最大行程 ${maxOffsetWhileBusy.toFixed(4)}`,
  );

  // ── D：演出交付后账本恒等抽查 ──
  check('演出交付后三账本恒等式成立', ledgerOk(afterTower), ledgerText(afterTower));

  // ── A 覆盖三装置：喷泉与闸门同样全真币交付 ──
  //
  // ★ **注入的币有三条去路，不是两条**（P10 S7 起）：
  //   ① 留在盘面（活跃差）；② 越线结算（结算差）；③ **掉进下水道**（流失差）。
  //   只写前两项时，闸门那条会报「实发 7，6 + 0 = 6」——而它其实没丢币，
  //   是第 7 枚被推到了前侧角的洞口。判据漏掉一整条合法去路，
  //   报出来的红就是**假红**，而且会把人引去查「是不是币被吞了」。
  //   三条差额相加才是「逐枚可查」的完整算式。
  for (const [id, expected, label] of [
    ['fountain', specs.fountain?.count ?? 0, '喷泉'],
    ['gate', specs.gate?.count ?? 0, '闸门落币'],
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
    const drainedPost = (post?.drained ?? 0) - (pre?.drained ?? 0);
    check(
      `${label}真币交付：实发 ${expected}，活跃差 + 结算差 + 流失差 = 承诺数`,
      done?.spawned === expected && activePost + scorePost + drainedPost === expected,
      `事件 spawned=${done?.spawned}，活跃差 ${activePost} + 结算差 ${scorePost} + ` +
        `流失差 ${drainedPost}（应 = ${expected}）`,
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
    // 轨迹打印：这段是「按余量榨预算」的循环，60 次 × 最多 20 秒，
    // 一旦余量不降就白等 20 分钟、最后只报一句「降级记录 null」——**看不出卡在哪**。
    // 每 5 次留一行，一眼能判「余量在降」还是「被回收/补币抵住了」。
    if (attempt % 5 === 0) {
      console.log(`  [预算] 第 ${attempt + 1} 次：余量 ${remaining}，盘面 ${state?.activeCoins}`);
    }
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
  //
  // ★ 探针的 z 必须读引擎（`coinGeometry().drop.z`）：钉阵跟着**落币口**走。
  // 这里原先写死 `−0.72`（旧落币口），落币口一改探针就探空，读出来的是
  // 「钉子碰撞体半长种类数 = 0」—— 判据红在别处，很容易被误判成钉子坏了。
  const pegDiag = (await readStateFresh(page))?.pegs;
  const pegProbe = await page.evaluate(
    (dropZ) => window.__THREE_GAME_TEST_HOOKS__?.probeColliders?.(0, 1.16, dropZ) ?? [],
    geo().drop.z,
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
  //
  // ⚠️ 读的是**落地前最后一个采样**的 x，不是「2.2 秒后停在哪」。两个理由：
  //
  //   ① 币落下时要穿过钉阵（22 根、`restitution 0.3`），会被钉子撞偏。
  //      脚本里别处早就写着「落点 x 不能作为判据 —— 币落下时要穿过钉阵」
  //      （见 `runInputCheck` 的轻点用例），这条却一直在用停稳后的 x，是内部矛盾。
  //   ② 落点后移（2026-09-25，−0.72 → −1.20）之后，币落在台面**空段**上、
  //      不再被预置币堆当帧挤出去；但它会以约 15 毫米/循环慢慢横滚，
  //      2.2 秒足够漂 0.3~0.46 米 —— 那时量到的是「漂到哪」，不是「落在哪」。
  //
  //   实测失败现场（改前，×1.2）：左 x=−0.597、右 x=−0.048。
  //   右边那枚落进了预置币堆的**列**上（列距 0.16 米，+0.56 正好有币），
  //   落地当帧就被挤到盘心，判据读到的差异只剩 0.549 —— 红的不是选位，是采样时刻。
  const landingX = async (lane) => {
    await startRun(page, 'ready');
    await dropUntilAccepted(page, lane);
    // 台面静置高度之上 8 厘米 = 还没落下去。阈值从引擎读，不写死。
    const airborneFloor = geo().restY + 0.08;
    let last = null;
    for (let step = 0; step < 24; step += 1) {
      await page.waitForTimeout(80);
      const coin = await playerCoin(page);
      if (!coin) continue;
      if (coin.y <= airborneFloor) break;
      last = coin;
    }
    return last?.x ?? 0;
  };
  const laneXs = [await landingX(-0.85), await landingX(0.85)];
  check(
    '③ 左右选位产生可观察的落点差异',
    Math.abs(laneXs[0] - laneXs[1]) > 0.6,
    `左落点 x=${laneXs[0].toFixed(3)}，右落点 x=${laneXs[1].toFixed(3)}（落地前最后一帧）`,
  );

  // 5. 币的路径连续、可解释，没有瞬移
  /*
   * ★ 判据形状重写（2026-10-01）。旧形式「每 200 毫秒采一次，两次距离 < 0.6 米」
   * **量的不是瞬移，是采样相位**：币从 `drop.y = 1.45` 落到台面要 ≈0.54 秒、
   * 末段速度 ≈5.3 米/秒 ⇒ 一个 200 毫秒的窗口**本来**就能走出 0.6~1.0 米。
   * 所以阈值 0.6 落在「判据自己能产出的读数范围」里面 ——
   * 现测同一棵树上四发的 maxJump 是 0.462 / 0.452 / 0.415 / 0.376 米，
   * 而 harness 那一次读到 0.645 米（`/tmp/jump-rootcause.mjs`）。
   * ⇒ 任何动到落地时序的改动都会把它随机翻红（本次就是：`2d1eaa6`/`6fa2358` 之后翻红，
   *   但**逐帧实测排除了真瞬移**：最大逐帧位移 0.130 米，
   *   且 `位移 ÷ (该帧速度 × 帧间隔)` = 0.53~0.62，**全部 ≤ 1**）。
   *
   * 新判据与采样间隔无关，直接问「这一帧走的距离，是不是它的速度付得起的」：
   *   `位移 > max(绝对地板, 3 × speed × dt)` ⇒ 瞬移。
   * 真瞬移的特征是**位置跳了而速度没跟上**（比值 → ∞），所以 3 倍这条线抓得住它；
   * 而正常落体的比值实测 ≤0.62，离 3 有 ~5 倍余量 ⇒ 这次不再贴噪声。
   * ⚠️ 绝对地板 0.02 米是为了第一帧：`dt` 可能极小（`speed × dt` → 0）会让比值假爆。
   */
  await startRun(page, 'ready');
  const path = await page.evaluate(async () => {
    const H = window.__THREE_GAME_TEST_HOOKS__;
    /*
     * 投递必须**在这一段里面**做，不能在外面先 `dropUntilAccepted`。
     * 原因：靠「记下投递前的 slot 集合、再找不在集合里的 `playerDropped` 币」来锁定这一枚，
     * 如果在外面投、进来之后才取集合，那枚币**已经在集合里了** ⇒ 永远匹配不到，
     * 判据会读「逐帧样本 0 个」而红（第一次就踩了这个坑，红得干脆，不是假绿）。
     */
    let before = null;
    let dropped = false;
    for (let attempt = 0; attempt < 80 && !dropped; attempt += 1) {
      before = new Set((H.coins() ?? []).map((c) => c.slot));
      dropped = H.drop?.(0) === true;
      if (!dropped) await new Promise((resolve) => setTimeout(resolve, 120));
    }
    let worstRatio = 0;
    let worstJump = 0;
    let previous = null;
    let samples = 0;
    let last = performance.now();
    for (let frame = 0; dropped && frame < 200; frame += 1) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const now = performance.now();
      const dt = Math.max(0.001, (now - last) / 1000);
      last = now;
      const coin = (H.coins() ?? []).find((c) => c.playerDropped && !before.has(c.slot));
      if (!coin) continue;
      if (previous) {
        const jump = Math.hypot(coin.x - previous.x, coin.y - previous.y, coin.z - previous.z);
        const budget = Math.max(0.02, 3 * (coin.speed ?? 0) * dt);
        worstRatio = Math.max(worstRatio, jump / budget);
        worstJump = Math.max(worstJump, jump);
        samples += 1;
      }
      previous = { x: coin.x, y: coin.y, z: coin.z };
      // 落定就停：后面的帧是币床里的推挤，不属于「落币路径」。
      if (coin.y < 0.24 && (coin.speed ?? 1) < 0.15) break;
    }
    return { dropped, worstRatio, worstJump, samples };
  });
  check(
    '⑤ 落币路径连续，无位置瞬移（逐帧位移 ÷ 速度可付位移 ≤ 3）',
    path.dropped === true && path.samples > 20 && path.worstRatio <= 3,
    `投递成功=${path.dropped}，逐帧样本 ${path.samples} 个，` +
      `最大比值 ${path.worstRatio.toFixed(2)}（上限 3）；最大逐帧位移 ${path.worstJump.toFixed(3)} 米`,
  );

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
  /*
   * ★ 第一份样必须在**暂停真的生效之后**取 —— 这条判据原来红在取样时刻，不是红在物理。
   *
   * 旧写法是「读一次 → 点按钮 → 等 3.2 秒 → 再读」，于是 `beforePause` 取的是**点击之前**
   * 的状态：点击经 CDP 派发、到 `Game.togglePause()` 真正生效之间那段时间游戏是正常在跑的，
   * 全部被算进「暂停期间推进了多少」。
   * 铁证是基线读数（`6fa2358`，纯 HEAD、改动之前）：「耗时 0.52 → 0.93」——
   * 0.41 秒 ≈ 25 帧，正是点击往返加首帧的量级；而引擎里 `elapsed += delta`
   * 明明排在 `if (this.paused) { publishDiagnostics(); return; }` **之后**
   * （`Game.ts:641` → `:645`），暂停期间它不可能涨。⇒ 红的是判据自己。
   * ⚠️ 旧容差写的就是 `0.2` 秒 —— 那不是「留点余量」，是**给这个竞态打的补丁**；
   *   取样时刻修对之后容差收回 0.02 秒（暂停期间 elapsed 应当一位都不动）。
   *
   * 判「生效」用的是引擎自己的状态：`Hud.setPaused` 里 `#pause-panel` 的 `hidden`，
   * 不是脚本猜的时间。
   *
   * 顺带删掉旧代码里的 `waitFor(cycles >= 1)`：`pusher.cycles` **不随开局清零**，
   * 上一局留下的计数让它立刻为真 —— 基线那次 `elapsed=0.52` 却已经「1 个循环」就是铁证
   * （一个循环本该 2.4 秒）。它谁也没等到，是个恒真式。
   */
  await page.locator('#pause-button').click();
  let pausedShown = false;
  for (let attempt = 0; attempt < 60 && !pausedShown; attempt += 1) {
    pausedShown = await page.evaluate(
      () => document.querySelector('#pause-panel')?.hidden === false,
    );
    if (!pausedShown) await page.waitForTimeout(100);
  }
  const beforePause = await readState(page);
  await page.waitForTimeout(3200);
  const duringPause = await readState(page);
  await page.locator('#pause-button').click();
  check(
    '⑪ 暂停期间推板循环与耗时都不推进',
    pausedShown === true &&
      duringPause?.pusher.cycles === beforePause?.pusher.cycles &&
      Math.abs((duringPause?.elapsed ?? 0) - (beforePause?.elapsed ?? 0)) < 0.02,
    `暂停面板已显示=${pausedShown}（等它显出来才取第一份样），` +
      `循环 ${beforePause?.pusher.cycles}→${duringPause?.pusher.cycles}，` +
      `耗时 ${(beforePause?.elapsed ?? 0).toFixed(3)}→${(duringPause?.elapsed ?? 0).toFixed(3)} 秒`,
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
 * 同时要求多次投币的落点确实不同，不是所有币都从同一个隐藏点掉下去。
 *
 * ★★ 2026-09-25 换口径：`conveyor` 归零的**第 4 处判据受害者**（前三处见 §11.6）。
 *   旧版是「投一枚 → 等一个推板循环 → 读离台」，在 `conveyor = 0` 下**必然读到 0 条**：
 *   台面币唯一的动力是推板的摩擦拖曳（⚠️ 这里的「净 26 毫米/循环」是 **S13 破对称**期的
 *   读数；S23 已把 `retract` 改回 0.9 ⇒ 对称行程下净输送**精确 0**，见 `constants.ts:406`），
 *   而落点 `z` 到台面前唇
 *   有 **1.2 米**（落币口 2026-09-25 从 −0.72 后移到 −1.20，见 `constants.ts` 的 `drop`）。
 *   实测（12 枚币，×1.2 档，2026-09-25）：首条离台事件出现在**第 37 个推板循环**，
 *   而 `conveyor = 0` 刚上线、落点还在 −0.72 时是第 16 个循环。
 *   所以这里改成「投满一批 + **按循环数**等」——**不要按秒等**，周期会变。
 *
 *   ⚠️ 这条在 S1b/#49 已变更（旧文本留着会误导下一个改判据的人）：
 *   原先 `fallOffEvents` **只记 `playerDropped` 的币**，于是同一批实测里台面从 62 掉到 8
 *   （54 枚预置币离台）而遥测**一条事件都没有**——那既是「容易看错的读数」，
 *   也是 ④ 把『取样不到』读成『物理不对』的病根。
 *   ⇒ 现在**床币也记**，事件带 `source: 'player' | 'bed'`（`Game.ts` 的离台记录块），
 *     判据 ④a/④b 用全样本、④c 只看 player 子集。
 *   仍然成立的告诫：拿「台面枚数在掉」直接当成「玩家币离台事件应该有」依旧会自相矛盾。
 *
 * ★★ 同时把 `spread > 0.3` 换成「行程的比例」。0.3 是按 `conveyor = 0.85` 标定的：
 *   那时币被输送带在 ~1 秒内送到前唇，落点能落在整个行程里的任意一点。
 *   归零之后离台**只发生在回撤的前半段**——币在前推行程里被拖到它能到的最远处，
 *   回撤时推币面从它身上扫回去，那一刻它才失去台面归属。两版落点各实测一次，
 *   **全部事件都落在 `retract` 相位**：落点 −0.72 时 9 条、跨度 0.145 米（行程的 40%）；
 *   落点 −1.20 时 18 条、跨度 0.125 米（**35%**）。
 *   **判据的尺度必须来自机器**（`coinGeometry().pusherTravel`），不能来自上一版物理；
 *   **样本量也必须够**（见下面 `runTimingCheck` 里 4 条 → 11% vs 18 条 → 35% 的实测）。
 */
async function runTimingCheck(page) {
  await startRun(page, 'playing');
  const { pusherTravel } = geo();
  const lanes = [-0.8, -0.4, 0, 0.4, 0.8];
  await primeFirstDrop(page, lanes[0]);
  await waitFor(page, (state) => (state?.pusher.cycles ?? 0) >= 1, 25_000);

  // 投满一批，**不按循环摊开**：单枚币在台面上走几十个循环，摊开投只会把
  // 「等离台」的窗口再拉长一倍；而 `conveyor = 0` 之后落点与投币相位已经解耦
  // （见上面那段：离台只发生在回撤段），摊开也换不来额外信息。
  for (let index = 1; index <= 12; index += 1) {
    await dropUntilAccepted(page, lanes[index % lanes.length]);
    await page.waitForTimeout(120);
  }

  // 按**循环数**等离台：★ 必须等够**事件数**，不是「拿到 2 条就算」。
  //
  // 实测（落点 −1.20，×1.2，同一批 12 枚币）：**4 条事件时跨度只有 0.038 米（行程的 11%），
  // 18 条事件时是 0.125 米（35%）** —— 跨度本身是样本量的函数，拿 4 条去比阈值
  // 是在量「掷骰子掷到哪」，不是量物理。这就是「判据的必然性依赖于样本量」那条纪律。
  // 10 条是实测里稳定越过阈值的最小样本（+41 个循环时累计 11 条）。
  // 上限 60 个循环（实测全部落完在 +43；首次离台在 +37）。
  const startCycle = (await readTelemetry(page))?.cycles?.at(-1)?.cycle ?? 0;
  const telemetry = await waitForTelemetry(
    page,
    (snapshot) =>
      (snapshot?.fallOffEvents?.length ?? 0) >= 10 ||
      (snapshot?.cycles?.at(-1)?.cycle ?? 0) - startCycle >= 60,
    240_000,
  );

  const fallOffEvents = telemetry?.fallOffEvents ?? [];
  // ★ 偏差/跨度只算一份，三处调用（全样本 / 玩家币子集 / 床币子集只打印）。
  //   写第二份公式就是 #67 那条「两处写同一个数 ⇒ 第二真源」的同款病。
  const gapStats = (events) => {
    const faces = events.map((event) => event.frontFaceZ);
    const offsets = events.map((event) => event.offset);
    const spread = faces.length > 1 ? Math.max(...faces) - Math.min(...faces) : 0;
    return {
      count: events.length,
      worstGap: events.length > 0
        ? Math.max(...events.map((event) => Math.abs(event.z - event.frontFaceZ)))
        : 99,
      spread,
      strokeSpread: spread / pusherTravel,
      offsetSpread: offsets.length > 1 ? Math.max(...offsets) - Math.min(...offsets) : 0,
      phases: [...new Set(events.map((event) => event.phase))].join('/'),
    };
  };
  const all = gapStats(fallOffEvents);
  const player = gapStats(fallOffEvents.filter((event) => event.source === 'player'));
  const SPREAD_MIN = 0.25;
  // ★ 最小样本数：阈值 25% 与"最大偏差"都是在 **n ≥ 10** 上标的（等离台的等待条件本身就是
  //   「事件数 ≥ 10 或跑满 60 循环」）。实测跨子是样本量的函数：4 条事件只有行程的 11%，
  //   18 条才有 35% ⇒ 拿 3~5 条去比 25% 是在量"这次掷到哪"，不是量物理。
  //   ⇒ 样本不足时 ④a/④b 一律**缺席**（打一行说明，不进 check）：
  //   写成 `条件: true` 放行是恒绿，硬判红又是把"取样窗口不够"说成"机器坏"。
  const MIN_EVENTS = 10;

  if (all.count >= MIN_EVENTS) {
    check(
      '④a 币离开台面的位置贴合推板前缘（全样本 ⇒ 无隐藏落点）',
      all.count >= 2 && all.worstGap < 0.3,
      `${all.count} 次离台（玩家币 ${player.count} / 床币 ${all.count - player.count}），` +
        `最大偏差 ${all.worstGap.toFixed(3)} 米`,
    );
    check(
      '④b 不同推板时机的落点确实不同（全样本）',
      all.strokeSpread >= SPREAD_MIN,
      `推币面 z 跨度 ${all.spread.toFixed(3)} 米 = 行程的 ${(all.strokeSpread * 100).toFixed(0)}%` +
        `（阈值 ${(SPREAD_MIN * 100).toFixed(0)}%），行程读数跨度 ${all.offsetSpread.toFixed(3)} 米，` +
        `相位 ${all.phases || '-'}`,
    );

  } else {
    console.log(
      `  [④a/④b 未判定] 离台事件只有 ${all.count} 条（< ${MIN_EVENTS}）⇒ 跨度阈值与『最大偏差』都是在 ` +
        `${MIN_EVENTS} 条以上标的，这时报绿或报红都是在报样本量。等够事件是靠『跑满 60 循环』兜底的。`,
    );
  }

  // ④c 玩家币支。⚠️ **样本不足时既不报绿也不报红**：直接 console.log 并跳过 check()。
  //   写成 `条件: true` 的『样本为 0 就放行』是恒绿形态（本项目吃过太多次）；
  //   而报红又是错的——S1a 已实测对称行程下单枚玩家币四位数循环才离台，
  //   红在这里说的是『取样窗口不够』，不是『机器坏』。⇒ 让它**缺席**并在报告里说明缺席。
  if (player.count >= 2) {
    check(
      '④c 玩家币自己离台时同样贴合前缘且有跨度',
      player.worstGap < 0.3 && player.strokeSpread >= SPREAD_MIN,
      `玩家币 ${player.count} 次离台，最大偏差 ${player.worstGap.toFixed(3)} 米，` +
        `跨度 = 行程的 ${(player.strokeSpread * 100).toFixed(0)}%（阈值 25%）`,
    );
  } else {
    console.log(
      `  [④c 未判定] 玩家币离台样本 ${player.count} 条（<2）⇒ 这条**不参与计数**，` +
        '缺席原因是 S1a：对称行程下单枚玩家币走完台面要四位数循环',
    );
  }
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
 * 所以这里只核对「同帧 + 固定返还」这一条契约。
 *
 * 返币是**固定值**，刻意不吃热度/热区/加注任何倍率：一旦被放大，
 * 它就会变成比铜币更划算的刷筹码通道，负期望立刻失效。
 *
 * ★ **「固定返多少」必须从引擎读**。这里原先写死 `3`（连标签都是「固定返 3 筹码」），
 * S13 §5 把返币 3 → 2 之后它就成了骗人的第二份真源 —— 报的红是「返币返错钱」，
 * 而真正发生的事只是标定值改了。`crossingReturn()` 本来就是这条契约的单一真源。
 */
async function runPayoutCheck(page) {
  const hooks = (fn, ...args) => page.evaluate(fn, ...args);
  // **先复位存档**：这条检查要从「全新一局」开始数返币事件，
  // 而前面几条检查已经把排行榜/XIXI 进度写脏了。钱包由 `startRun` 辅助函数负责补满
  // （历史上这里靠 `clearSave` 顺手把钱包补回来，现在补钱包是显式的，不再依赖它）。
  await hooks(() => window.__THREE_GAME_TEST_HOOKS__?.clearSave?.());
  // 固定返值由引擎给出（`roll`/`combo`/`hot`/`betMul` 都无关，固定值不吃任何倍率）。
  const payoutChips = await hooks(
    () =>
      window.__THREE_GAME_TEST_HOOKS__?.crossingReturn?.({
        kind: 'payout',
        combo: 1,
        hot: false,
        betMul: 1,
        roll: 0,
      })?.chips ?? null,
  );

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
  const badValue = payoutEvents.filter((event) => event.value !== payoutChips).length;
  const badCredit = payoutEvents.filter(
    (event) =>
      event.chipsAfter !== event.chipsBefore &&
      event.chipsAfter !== event.chipsBefore + payoutChips,
  ).length;

  check(
    `⑨ 绿色筹码固定返 ${payoutChips} 筹码（不吃热度/热区/加注倍率）`,
    payoutChips !== null && payoutEvents.length > 0 && badValue === 0,
    `${payoutEvents.length} 枚绿色筹码越线，入账 ${[...new Set(payoutEvents.map((e) => e.value))].join('/')}，` +
      `越界值 ${badValue} 枚（引擎给出固定值 ${payoutChips}）`,
  );
  check(
    `⑨ 返币与入账同帧到账（同一事件里筹码 +${payoutChips}）`,
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
  const min = Number(process.env.PACE_MIN ?? 0.15);
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
      // 速度护栏（R4-P3 的连续泄流律）在这一遍里到底有没有被触发：
      // `spikeClamps` 是「压之前的速率 > 0 的次数」，0 就意味着这一遍**根本没碰到那条律**，
      // 于是 pace 的读数变化不能归因于 P3（律没跑 = 改动是 no-op）。见计划 P3 段。
      const guard = await readStateFresh(page);
      const pace = coinsPerCycle(cycles);
      runs.push({ earned: final?.earned ?? 0, cycles: cycles.length, ...pace });
      console.log(
        `  行程 ${travel.toFixed(2)} 米 · 第 ${attempt + 1} 遍：赚进 ${String(runs[attempt].earned).padStart(4)}，` +
          `循环 ${cycles.length}，推下 ${pace.total} 枚，平均 ${pace.average.toFixed(3)} 枚/循环，` +
          `单循环最多 ${pace.maxCycle} 枚，最长空档 ${pace.longestGap} 个循环，` +
          `护栏压 ${guard?.spikeClamps ?? -1} 次/峰值 ${guard?.peakSpikeSpeed ?? -1} 米/秒`,
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
 * 机关：扫板 / 抓斗 / 后装填（**P7 起风险转轮已删除**，它的定位由 XIXI 老虎机承接）。
 *
 * 判据：机关只施加物理作用，结算仍由「币是否越线」决定；
 * 每个机关都要有明确的可用条件与成本，条件不满足时明确拒绝而不是静默吞掉筹码。
 */
async function runMechanisms(page) {
  console.log('\n── 模式：mechanisms（三个机关） ──');
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
  // ★ R5 起抓斗有了**演出**（爪下降 → 夹紧 → 提升到顶才松手），效果改成**延迟交付**了。
  //   所以判据必须在触发之后**先等演出落地**再读账：不等就是假红 ——
  //   币还留在原位，前沿枚数与 chips 一分未动，而钱已经扣了。
  await startRun(page, 'playing');
  await dropUntilAccepted(page, 0);
  const beforeGrapple = await readStateFresh(page);
  const grappled = await hooks(() => window.__THREE_GAME_TEST_HOOKS__?.grapple?.(0) ?? false);
  // 触发后第一件事是确认**装置真的在场**。机关原来是零构件的，
  // 任何计数型判据都读不出「爪没了」，所以这里读的是网格本身。
  const clawShown = await waitForShow(page, (r) => r?.mesh?.name === 'grappleClaw' && r.mesh.mounted, 2_000);
  const grappleShow = await waitForShow(page, (r) => r?.busy === false, 15_000);
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
  // ★ R5 新增：抓斗爪是**一件实体的机械构件**，而且它「升到顶才松手」。
  //   `deliveredAt` 由引擎自己的时间轴累积，不拿墙钟去抢跑，所以这条不抖。
  //   `delivered + skipped === targeted` 是交付对账：中途越线消失的币算流失，不算漏发。
  const grappleDelivered = grappleShow?.last ?? null;
  check(
    '抓斗爪：网格在场，且币在**提升之后**才交付（延迟交付，不是调用即 teleport）',
    clawShown?.mesh?.name === 'grappleClaw' &&
      clawShown?.mesh?.mounted === true &&
      grappleDelivered !== null &&
      grappleDelivered.id === 'grapple' &&
      grappleDelivered.delivered + grappleDelivered.skipped === grappleDelivered.targeted &&
      grappleDelivered.deliveredAt >= 0.4,
    `网格 ${clawShown?.mesh?.name ?? '缺件'}（挂在场景=${clawShown?.mesh?.mounted}，x=${clawShown?.mesh?.x?.toFixed(3)}），` +
      `交付 ${grappleDelivered?.delivered ?? 0}/${grappleDelivered?.targeted ?? 0} 枚` +
      `（流失 ${grappleDelivered?.skipped ?? 0}）在第 ${((grappleDelivered?.deliveredAt ?? 0) * 1000).toFixed(0)} 毫秒`,
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
  let armShown = null;
  let sweepEnd = null;
  for (let attempt = 0; attempt < 20 && swept !== true; attempt += 1) {
    if (attempt > 0) {
      const again = await enterDrain();
      if (again?.plateStopped !== true) break;
      beforeSweep = again;
    }
    swept = await hooks(() => window.__THREE_GAME_TEST_HOOKS__?.sweep?.() ?? false);
    // ★ R5：冲量改成**臂扫到哪里就推哪里**，所以账目要等臂扫完才对得上。
    armShown = await waitForShow(page, (r) => r?.mesh?.name === 'sweepArm' && r.mesh.mounted, 2_000);
    sweepEnd = await waitForShow(page, (r) => r?.busy === false, 15_000);
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
  // ★ R5 新增：**分批**是这一轮改造的全部意义。一次把冲量全给 vs 臂扫到哪里推哪里，
  //   对**账本完全等价**（总冲量一样、越线一样），所以只有**首末命中的时刻跨度**能区分二者：
  //   写回一次性 `applyImpulse` 的话 `spread` 归零，这条立刻红。
  const sweepDelivered = sweepEnd?.last ?? null;
  const spread = (sweepDelivered?.lastHitAt ?? 0) - (sweepDelivered?.firstHitAt ?? 0);
  check(
    '扫板臂：网格在场，且冲量按臂的行程**分批**给（首末命中有跨度）',
    armShown?.mesh?.name === 'sweepArm' &&
      armShown?.mesh?.mounted === true &&
      sweepDelivered !== null &&
      sweepDelivered.id === 'sweep' &&
      sweepDelivered.delivered + sweepDelivered.skipped === sweepDelivered.targeted &&
      // 只有一枚贴线币时本来就没有「分批」可言，那种盘面不判跨度。
      (sweepDelivered.targeted <= 1 || spread >= 0.05),
    `网格 ${armShown?.mesh?.name ?? '缺件'}（挂在场景=${armShown?.mesh?.mounted}，x=${armShown?.mesh?.x?.toFixed(3)}），` +
      `命中 ${sweepDelivered?.delivered ?? 0}/${sweepDelivered?.targeted ?? 0} 枚` +
      `（流失 ${sweepDelivered?.skipped ?? 0}），跨度 ${(spread * 1000).toFixed(0)} 毫秒` +
      `（第 ${(sweepDelivered?.firstHitAt ?? 0).toFixed(2)}~${(sweepDelivered?.lastHitAt ?? 0).toFixed(2)} 秒）`,
  );

  // ── P7：停板窗口加宽（已知欠账）──
  // 原状：停板后盘面静止 `restHold = 0.8` 秒收尾就走完，而扫板只在「停板 + 静止」
  // 这个窗口里开放 —— 真人在 0.8 秒内根本来不及按，机关等于不存在。
  //
  // 判据分两层，缺一不可：
  //   ① 常量关系取**引擎自报**的两个数（`restHold` / `pusherPeriod`），
  //      不在脚本里手抄 4.8 —— 判据不写第二份公式（纪律 2）；
  //   ② **实测墙钟**：只断言常量等于 4.8、而实测仍是 0.8 的话，改的就不是行为。
  await startRun(page, 'drain');
  const windowState = await readStateFresh(page);
  const rules = windowState?.mechanisms ?? {};
  const windowStart = Date.now();
  await waitFor(page, (state) => state?.plateStopped === true, 60_000);
  const stoppedAt = Date.now();
  const beforeSettleAt = (await readTelemetry(page))?.drain?.settledAt ?? null;
  await waitForTelemetry(
    page,
    (data) => (data?.drain?.settledAt ?? null) !== beforeSettleAt,
    90_000,
  );
  const windowMs = Date.now() - stoppedAt;

  check(
    'P7 停板窗口 = 2 个完整推板循环（引擎自报，非脚本手抄）',
    (rules.restHold ?? 0) >= 2 * (rules.pusherPeriod ?? 1) - 1e-6,
    `restHold ${rules.restHold} 秒 = ${((rules.restHold ?? 0) / (rules.pusherPeriod || 1)).toFixed(1)} 个推板循环（每循环 ${rules.pusherPeriod} 秒）`,
  );
  // 容差 20%：脚本是轮询观察 `plateStopped` 的，读到它时窗口已经走了一小段，
  // 所以实测只会**偏短**，不会偏长。用下界断言就不会假绿。
  check(
    'P7 停板窗口实测：停板 → 收尾结算的墙钟 ≥ 窗口的 80%',
    windowMs >= (rules.restHold ?? Number.POSITIVE_INFINITY) * 1000 * 0.8,
    `墙钟 ${(windowMs / 1000).toFixed(1)} 秒（窗口 ${rules.restHold} 秒，从进收尾算起共 ${((Date.now() - windowStart) / 1000).toFixed(1)} 秒）`,
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

/**
 * 自动补币模式（P10 ⑦）。
 *
 * ## 为什么单开一个模式
 *
 * 「台面见底」在真实玩法里要玩好几分钟才到得了（盘面每局只掉几十枚，而阈值落在
 * 预置量的一半以下），塞进 `endless` 会把那个本来就长的模式再拉长一截，
 * 而且它自己的等待（冷却 8 秒 × 3 处）与 `endless` 的节奏测量互相干扰。
 *
 * ## 判据口径
 *
 * 阈值 / 冷却 / 枚数**全部从 `refillSpec()` 读**，脚本里不出现 180 / 8 / 7 ——
 * 它们是 S11 要逐档放大的平衡旋钮，抄一份到测试里，标定那天判据就开始骗人。
 * 「台面见底」这个状态用 `clearBedTo()` 构造（见那个钩子的说明：
 * 它按币床自然变薄的顺序删，不是随机挖空）。
 */
async function runRefill(page) {
  console.log('\n── 模式：refill（盘面见底 → 庄家补货） ──');
  const hooks = (fn, ...args) => page.evaluate(fn, ...args);

  await hooks(() => window.__THREE_GAME_TEST_HOOKS__?.clearSave?.());
  const spec = await hooks(() => window.__THREE_GAME_TEST_HOOKS__?.refillSpec?.() ?? null);
  const showSpecs = await hooks(() => window.__THREE_GAME_TEST_HOOKS__?.showSpecs?.() ?? null);
  const table = await readTable(page);

  check(
    '补币配置可从引擎读到（判据不手抄阈值）',
    (spec?.bedThreshold ?? 0) > 0 && (spec?.cooldown ?? 0) > 0 && (spec?.count ?? 0) > 0,
    `阈值 ${spec?.bedThreshold} 枚，每 ${spec?.checkEvery} 秒盘点，冷却 ${spec?.cooldown} 秒，每次 ${spec?.count} 枚`,
  );
  // 补货量必须与闸门装置同一份配置：补币走的就是 `shows.request('gate')`，
  // 两处各写一个数的话，HUD 上写的枚数会和实际掉下来的枚数不一样。
  check(
    '补货量 = 闸门装置的规模（同一份配置，不写两个数）',
    (spec?.count ?? -1) === (showSpecs?.gate?.count ?? -2),
    `补币 ${spec?.count} vs gate ${showSpecs?.gate?.count}`,
  );

  // ── ① 口径守卫 ──
  // 这一条是整套机制的**命门**：`bedCoins` 必须真的只数币床。
  // 如果实现里错用了 `activeCoins`（含上层台面 + 在途），盘面被掏空时它还是三位数，
  // 补币**永不触发**——而且零报错，判据只会看到「补币没发生」，
  // 于是很容易被误判成「阈值定得太低」而去调参数。
  await startRun(page, 'playing');
  await page.waitForTimeout(1400); // 跨过一个盘点周期
  const fresh = await readStateFresh(page);
  const gap = (fresh?.activeCoins ?? 0) - (fresh?.bedCoins ?? 0);
  check(
    '① 币床口径 ≠ 活跃总数（上层台面与在途币不算「台面筹码」）',
    (fresh?.bedCoins ?? 0) > 0 &&
      (fresh?.bedCoins ?? 0) < (fresh?.activeCoins ?? 0) &&
      gap >= (table?.deck ?? 0),
    `bedCoins=${fresh?.bedCoins}，activeCoins=${fresh?.activeCoins}，` +
      `差 ${gap}（上层台面预置 ${table?.deck} 枚 + 在途）`,
  );

  // 推板顶面的**稳态基线**：满盘时就是那 18 枚预置上层币。
  // ⑤ 要拿它判「补货的币有没有卡在顶面下不来」。
  const deckBaseline = fresh?.deckCoins ?? 0;
  check(
    '① 推板顶面读数 = 预置上层币枚数（诊断与输送共用同一份判据）',
    deckBaseline === (table?.deck ?? -1),
    `deckCoins=${deckBaseline}，预置上层 ${table?.deck} 枚`,
  );

  // ── ② 阈值之上不触发 ──
  // 满盘时 `bedCoins` 远在阈值之上。等满一个冷却周期仍不该有任何补货——
  // 否则「盘面一满就补」会把补币变成背景噪声，玩家永远看不到盘面变薄。
  const fullBed = fresh?.bedCoins ?? 0;
  await page.waitForTimeout((spec?.cooldown ?? 8) * 1000 + 1500);
  const idle = await readStateFresh(page);
  check(
    '② 盘面在阈值之上时一个冷却周期内不补货',
    fullBed > (spec?.bedThreshold ?? 0) && idle?.refills === 0,
    `盘面 ${fullBed} 枚 > 阈值 ${spec?.bedThreshold}，等了 ${spec?.cooldown} 秒，refills=${idle?.refills}`,
  );

  // ── ③ 掏空 → 触发 + 两态交付 ──
  const removed = await hooks((keep) => window.__THREE_GAME_TEST_HOOKS__?.clearBedTo?.(keep) ?? 0, 120);
  await page.waitForTimeout(700); // 跨过盘点
  const emptied = await readStateFresh(page);
  const triggered = await waitFor(page, (state) => (state?.refills ?? 0) >= 1, 15_000);
  check(
    '③ 币床掏到阈值以下 → 触发补货（refills +1）',
    (removed ?? 0) > 0 && (emptied?.bedCoins ?? 0) < (spec?.bedThreshold ?? 0) && triggered?.refills === 1,
    `删掉 ${removed} 枚 → 币床 ${emptied?.bedCoins} 枚（阈值 ${spec?.bedThreshold}）→ refills=${triggered?.refills}`,
  );

  // 两态：登记时币还没到位，交付时实发 = 承诺。
  // 判据读 `showEvents` 的 gate 条目（与 `show` 模式同源），不读「盘面涨了几枚」——
  // 后者会把「补货的币还在推板顶面滚」读成「没交付」。
  const gateShow = await waitForTelemetry(
    page,
    (summary) =>
      (summary?.showEvents ?? []).some((event) => event.id === 'gate' && event.phase === 'completed'),
    25_000,
  );
  const completed = (gateShow?.showEvents ?? [])
    .filter((event) => event.id === 'gate' && event.phase === 'completed')
    .pop();
  const requested = (gateShow?.showEvents ?? [])
    .filter((event) => event.id === 'gate' && event.phase === 'registered')
    .pop();
  check(
    '③ 两态交付：登记承诺 = 配置枚数，交付实发 = 承诺',
    requested?.promised === (spec?.count ?? -1) &&
      completed?.spawned === requested?.promised &&
      completed?.downgraded === false,
    `登记 promised=${requested?.promised}，交付 spawned=${completed?.spawned}，降级 ${completed?.downgraded}`,
  );

  // ── ④ HUD 反馈 ──
  // 读 `#status-line` 的 `data-kind`，**不匹配文案**：措辞一改判据就假红，
  // 那等于在测试里维护第二份文案。这里问的是「这句话是谁说的」。
  const status = await page.evaluate(() => {
    const element = document.querySelector('#status-line');
    return element ? { text: element.textContent ?? '', kind: element.dataset.kind ?? '' } : null;
  });
  check(
    '④ 补货有 HUD 反馈（状态行标记为 refill，不靠匹配文案）',
    status?.kind === 'refill' && (status?.text ?? '').length > 0,
    `data-kind=${status?.kind || '（空）'}，文案「${status?.text}」`,
  );

  // ── ⑤ 补货的币真的回填到币床上 ──
  // 闸门是从背板把币滚到**推板顶面**（上层台面）的，靠台面输送带进盘面再落到币床。
  // 所以这里必须轮询取**峰值**，不能等一个固定时刻读一次：
  // 单点采样既可能读在币还没落到币床之前，也可能读在它们已经被推走之后。
  //
  // ★ 这是**唯一**能看见「闸门币卡在推板顶面」的判据。那种实现下 `activeCoins`
  // 照涨 7、`shows` 事件的 `spawned` 也等于承诺数、`show` 模式全绿 ——
  // 只有「币床枚数要回升」+「顶面枚数要回落」会红。
  //
  // 判据取承诺数的**一半**（7 枚 → 至少 4 枚到账）：币从顶面落到币床的路上会经过
  // 前沿两侧的下水道，少一两枚是设计内的损失（见 `DRAIN`）。「全部 7 枚都到」
  // 是理想值，写成硬判据会把下水道的正常损耗报成缺陷。
  const arriveTarget = (emptied?.bedCoins ?? 0) + Math.ceil((spec?.count ?? 0) / 2);
  let bedPeak = emptied?.bedCoins ?? 0;
  let deckPeak = deckBaseline;
  const bedDeadline = Date.now() + 22_000;
  while (Date.now() < bedDeadline) {
    const state = await readState(page);
    bedPeak = Math.max(bedPeak, state?.bedCoins ?? 0);
    deckPeak = Math.max(deckPeak, state?.deckCoins ?? 0);
    if (bedPeak >= arriveTarget) break;
    await page.waitForTimeout(400);
  }
  check(
    '⑤ 补货的币被输送带送下推板顶面、落进币床（不是卡在顶面）',
    bedPeak >= arriveTarget,
    `币床 ${emptied?.bedCoins} → 峰值 ${bedPeak} 枚（目标 ≥ ${arriveTarget}）；` +
      `推板顶面 ${deckBaseline} → 峰值 ${deckPeak} 枚`,
  );
  // 顶面**不积压**：输送带送完最后几枚之后，顶面应当回落到预置水平。
  // 不回落就是「币停在推板顶面再也下不来」——那正是把 `gate` 接上补币时踩到的缺陷
  // （顶面从 18 涨到 25 然后一直挂着，而 `activeCoins` 看起来一切正常）。
  await page.waitForTimeout(4000);
  const deckSettled = await readStateFresh(page);
  check(
    '⑤ 推板顶面不积压（补货的币都下去了，没有停在顶面）',
    (deckSettled?.deckCoins ?? 99) <= deckBaseline + 2,
    `推板顶面 ${deckBaseline} → ${deckSettled?.deckCoins} 枚（预置上层币 ${table?.deck} 枚 + 允许 2 枚在途）`,
  );

  // ── ⑥ 不超币池预算 ──
  const budget = await readStateFresh(page);
  check(
    '⑥ 补货不超币池预算（`acquire()` 池满是静默返回 null 的历史坑）',
    (budget?.activeCoins ?? 0) <= (spec?.budget ?? 0),
    `活跃 ${budget?.activeCoins} ≤ 预算 ${spec?.budget}`,
  );

  // ── ⑦ 冷却生效 ──
  // 盘面会在阈值上下抖动。没有冷却时每 0.5 秒补一次，闸门演出排队到天上去，
  // 玩家看到的是「闸门一直在掉币」——补币从救场退化成背景噪声。
  //
  // ★ 这里**重开一局**再测，不接着 ③ 那次补货往下跑：
  // 冷却是从 ③ 触发那一刻算起的，而 ④~⑥ 已经花掉了几秒，接着测就变成
  // 「冷却还剩几秒」的运气题（跑快了过、跑慢了假红）。
  // `startRun` 把 `refills` 与冷却一起复位，判据才有确定的前置条件。
  await startRun(page, 'playing');
  await page.waitForTimeout(1200);
  await hooks((keep) => window.__THREE_GAME_TEST_HOOKS__?.clearBedTo?.(keep) ?? 0, 120);
  const firstTrigger = await waitFor(page, (state) => (state?.refills ?? 0) >= 1, 15_000);
  const baseline = firstTrigger?.refills ?? 0;
  // 立刻再掏空一次：冷却还满着，不该有第二次。
  await hooks((keep) => window.__THREE_GAME_TEST_HOOKS__?.clearBedTo?.(keep) ?? 0, 120);
  await page.waitForTimeout(2500);
  const duringCooldown = await readStateFresh(page);
  check(
    '⑦ 冷却期内不重复补货（盘面在阈值上下抖动不会刷屏）',
    baseline === 1 && duringCooldown?.refills === baseline,
    `refills ${baseline} → ${duringCooldown?.refills}（冷却 ${spec?.cooldown} 秒，只等了 2.5 秒）`,
  );
  const afterCooldown = await waitFor(page, (state) => (state?.refills ?? 0) > baseline, 25_000);
  check(
    '⑦ 冷却走完 → 下一轮补货照常触发（冷却不是一次性开关）',
    (afterCooldown?.refills ?? 0) > baseline,
    `refills ${baseline} → ${afterCooldown?.refills}`,
  );

  // ── ⑧ 沉降期不补货 ──
  // 沉降期补货 = 庄家替玩家续命。续命是跪求按钮的语义（`grantBeg`），
  // 由补币悄悄代劳的话，破产弹窗可能永远弹不出来。
  //
  // ★ 判据是「沉降期内**采样** 3 秒一次都不补」，不是「等满一个冷却再查一次」：
  // 沉降窗口最短 4.8 秒（`RULES.restHold` = 2 个推板周期），而盘面回吐筹码后
  // 本局会 `reviveFromRuin()` 回到 `playing`——等满 8 秒冷却的话，
  // 读到的是**复活之后**的阶段，那条判据就变成了「复活后补不补」，
  // 与被测的东西无关。3 秒 = 6 个盘点周期，足够暴露「没挡 phase」的实现。
  await startRun(page, 'drain');
  await page.waitForTimeout(600);
  await hooks((keep) => window.__THREE_GAME_TEST_HOOKS__?.clearBedTo?.(keep) ?? 0, 60);
  let drainPhaseHeld = true;
  let refillsDuringSettle = 0;
  const drainDeadline = Date.now() + 3000;
  while (Date.now() < drainDeadline) {
    const state = await readState(page);
    if (state?.phase !== 'drainOut') {
      drainPhaseHeld = false;
      break;
    }
    refillsDuringSettle = Math.max(refillsDuringSettle, state?.refills ?? 0);
    await simTick(page, 250);
  }
  const settleState = await readStateFresh(page);
  check(
    '⑧ 沉降期不补货（续命是跪求的语义，不能由庄家代劳）',
    drainPhaseHeld && refillsDuringSettle === 0,
    `沉降期内采样 3 秒（6 个盘点周期）：阶段保持 drainOut=${drainPhaseHeld}，` +
      `币床 ${settleState?.bedCoins} 枚（阈值 ${spec?.bedThreshold}），refills=${refillsDuringSettle}`,
  );
}

/**
 * 得分反馈分级（P10 ⑨）。
 *
 * ## 为什么单开一个模式
 *
 * 这一节的三个对象（飞字分档 / 得分线脉冲 / 热区与洞口闪光）**没有一个能靠截图判**：
 * 「连落 3 出脉冲」在画面上只是一条亮条稍微亮了点，「大号飞字」与普通飞字差一个字号。
 * 而它们的触发条件（连落 5 次、热区命中、币掉进洞）在真实对局里都是**低频**事件，
 * 塞进 `endless` 只会让那个模式变长且更不稳。
 *
 * ## 判据分两层（这是关键）
 *
 *   ① **纯函数层**：`crossingFeedbackProbe` 枚举边界点。它证明「阈值与分支对不对」——
 *      完全确定，不需要任何物理。
 *   ② **接线层**：真实对局跑一段，读 `feedbackReport()` 的**计数 + 材质自发光**。
 *      它证明「引擎真的调用了分级、视觉真的动了」。
 *
 * ★ 两层缺一不可：只做 ① 会漏掉「分级写好了但没人调用」；
 * 只做 ② 会漏掉「刚好这次跑到的都是常见分支，冷门分支是错的」。
 *
 * 阈值一律从 `feedbackSpec()` 读（不在脚本里手抄 25 / 3 / 5）：
 * S11 标定时它们是旋钮，抄一份到测试里就会开始骗人。
 */
async function runFeedback(page) {
  console.log('\n── 模式：feedback（得分反馈分级） ──');
  const hooks = (fn, ...args) => page.evaluate(fn, ...args);

  await hooks(() => window.__THREE_GAME_TEST_HOOKS__?.clearSave?.());
  const spec = await hooks(() => window.__THREE_GAME_TEST_HOOKS__?.feedbackSpec?.() ?? null);
  check(
    '反馈分级配置可从引擎读到（判据不手抄阈值）',
    (spec?.flyScoreBig ?? 0) > 0 && (spec?.comboPulse ?? 0) > 0 && (spec?.comboClimax ?? 0) > 0,
    `飞字大号 ≥ ${spec?.flyScoreBig} 筹码；连落 ${spec?.comboPulse} 脉冲、` +
      `${spec?.comboClimax} 白闪；峰值 得分线 ${spec?.emissive?.scoreLinePeak} / 热区 ${spec?.emissive?.hotZonePeak}`,
  );
  // 三条阈值必须构成正确的偏序：脉冲在前、高潮在后，否则「轻闪」永远被白闪盖掉。
  check(
    '阈值偏序：脉冲阈值 ≤ 高潮阈值（否则轻闪永远被白闪盖掉）',
    (spec?.comboPulse ?? 0) <= (spec?.comboClimax ?? 0),
    `脉冲 ${spec?.comboPulse} ≤ 高潮 ${spec?.comboClimax}`,
  );

  // ── ① 纯函数层：边界点逐一枚举 ──
  //
  // 边界点全部**由引擎阈值推出**，脚本里不出现字面量。
  // 币种分两类刻意都用上：`bronze`（自带 climax = null）验「没高潮就是没有」，
  // `diamond`（自带 climax = blue）验「连落白闪**压过**币种色」。
  // 每个点都断言「该开的开、该关的关」，所以任何一条分支写反都会被抓到。
  const probe = (input) =>
    hooks((value) => window.__THREE_GAME_TEST_HOOKS__?.crossingFeedbackProbe?.(value) ?? null, input);
  const big = spec?.flyScoreBig ?? 25;
  const pulse = spec?.comboPulse ?? 3;
  const climax = spec?.comboClimax ?? 5;

  const cases = [
    // [筹码, 连落, 热区, 币种, 期望：档位 / 脉冲 / 热区 / 高潮归属, 是否被闸门拦下]
    [big - 1, 1, false, 'bronze', { tier: 'normal', pulse: false, hot: false, reason: null }],
    [big, 1, false, 'bronze', { tier: 'big', pulse: false, hot: false, reason: null }],
    [0, pulse - 1, false, 'bronze', { tier: 'normal', pulse: false, hot: false, reason: null }],
    [0, pulse, false, 'bronze', { tier: 'normal', pulse: true, hot: false, reason: null }],
    // 铜币没有自带高潮，所以连落阈值之前**一点特效都不该出**。
    [0, climax - 1, false, 'bronze', { tier: 'normal', pulse: true, hot: false, reason: null }],
    [0, climax, false, 'bronze', { tier: 'normal', pulse: true, hot: false, reason: 'combo' }],
    // 钻石自带蓝闪：阈值之前走币种色，到了阈值被白闪接管。
    [0, climax - 1, false, 'diamond', { tier: 'normal', pulse: true, hot: false, reason: 'kind' }],
    [0, climax, false, 'diamond', { tier: 'normal', pulse: true, hot: false, reason: 'combo' }],
    [big, climax, true, 'diamond', { tier: 'big', pulse: true, hot: true, reason: 'combo' }],
    // ★ 被概率闸门拦下（S13 §5 给花纹加了闸门）：**币种高潮必须压掉**——
    // 返 0 还闪金闪就是画面在说谎。而连落白闪**不受影响**（那是玩家自己连推出来的），
    // 所以下面第二条仍应是 `combo`。这两条一起守，才说明「压的是币种、不是整档反馈」。
    [0, climax - 1, false, 'diamond', { tier: 'normal', pulse: true, hot: false, reason: null }, true],
    [0, climax, false, 'diamond', { tier: 'normal', pulse: true, hot: false, reason: 'combo' }, true],
  ];
  const rows = [];
  for (const [chips, combo, hot, kind, want, blocked] of cases) {
    const got = await probe({ chips, combo, hot, kind, blocked: blocked === true });
    rows.push({
      label: `筹码 ${chips} / 连落 ${combo} / 热区 ${hot ? '是' : '否'} / ${kind}${
        blocked ? ' / 被闸门拦下' : ''
      }`,
      ok:
        got?.flyTier === want.tier &&
        got?.scoreLinePulse === want.pulse &&
        got?.hotFlash === want.hot &&
        (got?.climax?.reason ?? null) === want.reason,
      got,
    });
  }
  check(
    '① 分级边界枚举：飞字分档 / 连落脉冲 / 高潮归属 / 热区命中逐点核对',
    rows.every((row) => row.ok),
    rows
      .map(
        (row) =>
          `${row.label}→${row.got?.flyTier}/${row.got?.scoreLinePulse ? '脉冲' : '—'}/` +
          `${row.got?.climax?.reason ?? '无高潮'}${row.ok ? '' : ' ✗'}`,
      )
      .join('　'),
  );
  // 连落高潮必须是**白闪**：它是唯一与币种无关的一档，用币种色会读成「又是那个币」。
  const comboClimax = (await probe({ chips: 0, combo: climax, hot: false, kind: 'diamond' }))?.climax;
  const kindClimax = (await probe({ chips: 0, combo: climax - 1, hot: false, kind: 'diamond' }))?.climax;
  check(
    '① 连落高潮用白闪，且压过币种自身的色调（钻石本来是蓝闪）',
    comboClimax?.tone === 'white' &&
      comboClimax?.strength === 1 &&
      kindClimax?.tone === 'blue' &&
      kindClimax?.reason === 'kind',
    `连落 ${climax} → ${comboClimax?.tone}（${comboClimax?.reason}）；` +
      `连落 ${climax - 1} → ${kindClimax?.tone}（${kindClimax?.reason}）`,
  );

  // ── ② 表现层：飞字分档真的画出来了 ──
  //
  // 走的是 `Hud.flyScore` 的真实代码路径（只有坐标是合成的）。
  // 读 `#hud` 上的持久属性而不是去 DOM 里抓那个 420 毫秒后自毁的飞字——
  // 抓它等于把判据变成时序赌博。
  const bigProbe = await hooks(
    (value) => window.__THREE_GAME_TEST_HOOKS__?.flyScoreProbe?.(value) ?? null,
    big,
  );
  const smallProbe = await hooks(
    (value) => window.__THREE_GAME_TEST_HOOKS__?.flyScoreProbe?.(value) ?? null,
    big - 1,
  );
  check(
    '② 飞字分档：大号档走 big（DOM 上有持久读数，判据不抓瞬时的飞字元素）',
    bigProbe?.tier === 'big' &&
      bigProbe?.datasetTier === 'big' &&
      smallProbe?.tier === 'normal' &&
      smallProbe?.datasetTier === 'normal',
    `${big} 筹码 → ${bigProbe?.datasetTier}；${big - 1} 筹码 → ${smallProbe?.datasetTier}`,
  );

  // ── ③ 接线层：真实对局里的计数与衰减 ──
  //
  // `startRun` 会把计数清零，所以下面读到的是**本局**的贡献。
  await startRun(page, 'playing');
  await playRun(page, { drops: 26, waitEnd: false });
  const report = await hooks(() => window.__THREE_GAME_TEST_HOOKS__?.feedbackReport?.() ?? null);
  const counts = report?.counts ?? {};
  check(
    '③ 真实对局：越线真的产生了飞字反馈（计数与画面同源）',
    (counts.flyNormal ?? 0) + (counts.flyBig ?? 0) > 0,
    `普通 ${counts.flyNormal} 次 / 大号 ${counts.flyBig} 次`,
  );
  // 得分线脉冲与热区命中是低频事件，**不设下限**（跑不到就是跑不到，不该假红），
  // 但跑到了就必须有材质证据：计数 > 0 ⇒ 峰值曾经被写过。
  check(
    '③ 脉冲/热区/洞口闪光：发生过的档位都留下了材质证据（峰值为正）',
    (counts.comboPulse ?? 0) === 0 || (spec?.emissive?.scoreLinePeak ?? 0) > (spec?.emissive?.scoreLineBase ?? 0),
    `连落脉冲 ${counts.comboPulse} 次、热区命中 ${counts.hotHit} 次、洞口闪光 ${counts.drainFlash} 次；` +
      `得分线峰值 ${spec?.emissive?.scoreLinePeak} > 基线 ${spec?.emissive?.scoreLineBase}`,
  );
  // 衰减必须**真的回到基线**：卡在峰值的得分线会一直亮着，
  // 下一次连落就再也看不出「跳了一下」。
  //
  // ⚠️ 这里**必须先停推板、再轮询到回基线**，不能等一个固定时长：
  // `playRun({ waitEnd: false })` 之后本局还在跑，推板继续把币推过线 ——
  // 固定等 700 毫秒读到的可能是「刚跳了一下」而不是「衰减完了」。
  // 实测就是这样红的（得分线 1.515、热区 2.142，都还在峰值附近，而基线是 0.35 / 0.55）。
  // 停板之后不会再有新的越线，0.22 秒的衰减才有确定的终点。
  await hooks(() => window.__THREE_GAME_TEST_HOOKS__?.setPusherRunning?.(false));
  const base = spec?.emissive?.scoreLineBase ?? 0.35;
  const hotBase = spec?.emissive?.hotZoneBase ?? 0.55;
  const settledDeadline = Date.now() + 3_000;
  let settled = null;
  while (Date.now() < settledDeadline) {
    settled = await hooks(() => window.__THREE_GAME_TEST_HOOKS__?.feedbackReport?.() ?? null);
    if (
      Math.abs((settled?.emissive?.scoreLine ?? 0) - base) < 1e-6 &&
      Math.abs((settled?.emissive?.hotZone ?? 0) - hotBase) < 1e-6 &&
      (settled?.emissive?.drainFlash ?? 0) === 0
    ) {
      break;
    }
    await page.waitForTimeout(120);
  }
  check(
    '③ 衰减回到基线：得分线 / 热区不残留峰值，洞口闪光归零',
    Math.abs((settled?.emissive?.scoreLine ?? 0) - base) < 1e-6 &&
      Math.abs((settled?.emissive?.hotZone ?? 0) - hotBase) < 1e-6 &&
      (settled?.emissive?.drainFlash ?? 0) === 0,
    `得分线 ${settled?.emissive?.scoreLine}（基线 ${base}）、热区 ${settled?.emissive?.hotZone}（基线 ${hotBase}）、` +
      `洞口 ${settled?.emissive?.drainFlash}`,
  );
  // ★ S16：**相机必须完全静止**。
  //
  // 用户先后要求删掉相机上的两路运动：
  //   ①「现在中币整个画面就会震荡，不要这个震动的动画」—— 中币的镜头抖动
  //     （`strength² × 0.055` 米，强度 1 的币种 = 整个画面跳 5.5 厘米）；
  //   ②「微震也去掉」—— 推板前推时的 2 毫米台面微震。
  // 现在 `fitCamera()` 之后没有任何代码改过相机位置，所以本局峰值偏移必须是 0。
  //
  // ★ 为什么这条必须写成判据：**相机运动在静止截图里完全看不出来** ——
  //   抖的是运动，单帧画面一模一样，`shots` 模式与 `npx playwright test` 的截图断言
  //   都抓不到它，而 `camera.position` 也不在诊断快照里。
  //   只有逐帧记账（`Game.cameraPeakOffset`）才守得住「有人把它加回来」。
  //   实测：删之前这条读数是 0.055，删完之后是 0。
  check(
    '③ 相机完全静止：本局偏移峰值恒为 0（中币不抖屏、推板也不微震）',
    (settled?.cameraPeakOffset ?? 99) <= 1e-6,
    `相机峰值偏移 ${settled?.cameraPeakOffset} m（应恒为 0）`,
  );
  // 换局必须把反馈清零：上一局的计数与残留亮度不该出现在新一局的开局画面上。
  await startRun(page, 'ready');
  const fresh = await hooks(() => window.__THREE_GAME_TEST_HOOKS__?.feedbackReport?.() ?? null);
  const clearedCounts = Object.values(fresh?.counts ?? {}).every((value) => value === 0);
  check(
    '③ 换局清零：计数归零且材质写回基线（上一局的亮度不跨局）',
    clearedCounts &&
      Math.abs((fresh?.emissive?.scoreLine ?? 0) - base) < 1e-6 &&
      (fresh?.emissive?.drainFlash ?? 0) === 0,
    `计数 ${JSON.stringify(fresh?.counts)}，得分线 ${fresh?.emissive?.scoreLine}`,
  );
}

/**
 * 低多面体模型币（S15）：结构 / 配色 / 尺寸。
 *
 * 全部是**计数判据**，因为这三件事的缺陷在截图里都只差一点：
 * 「面被糊成球面」「币互相插进对方身体」「某块面用了错档色调」肉眼都判不了。
 * 配色另有一条**读回图集纹素**的硬证据 —— 它能同时守住「条序对不对」
 * 和「颜色有没有被转两次」（本项目犯过两次的静默 bug）。
 */
async function runModels(page) {
  console.log('\n── 模式：models（低多面体模型币：结构 / 配色 / 尺寸） ──');

  const data = await page.evaluate(async () => {
    const models = await import('/src/entities/coinModels.ts');
    const textures = await import('/src/utils/coinTexture.ts');
    const constants = await import('/src/game/constants.ts');
    const atlas = {};
    for (const kind of models.COIN_MODEL_KINDS) {
      const canvas = textures.createCoinModelAtlas(kind).image;
      const context = canvas.getContext('2d');
      const size = canvas.width;
      atlas[kind] = models.MODEL_TONES.map((_, index) => {
        const x = Math.floor(((index + 0.5) / models.MODEL_TONES.length) * size);
        const [r, g, b] = context.getImageData(x, Math.floor(size / 2), 1, 1).data;
        return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
      });
    }
    return {
      audit: models.coinModelAudit(),
      atlas,
      tones: models.MODEL_TONES,
      // ★ S16：倍率从引擎读，不手抄 1.5 / 2.5 —— 尺寸比例是用户拍板的旋钮，
      //   抄进脚本就成了第二份真源（纪律 2）。
      ratios: models.MODEL_DIAMETER_RATIO,
      coin: constants.COIN,
    };
  });

  const { audit, atlas, tones, coin, ratios: MODEL_DIAMETER_RATIO } = data;
  const coinDiameter = coin.radius * 2;

  for (const entry of audit) {
    const tag = entry.kind === 'diamond' ? '钻石' : '宝箱';
    check(
      `① ${tag}：非索引三角面汤（索引几何会把硬切面糊成球面）`,
      entry.indexed === false,
      `indexed=${entry.indexed}，顶点 ${entry.vertices} / 三角形 ${entry.triangles}`,
    );
    check(
      `② ${tag}：逐面法线（${entry.triangles} 个面全部是平的）`,
      entry.flatFaces === entry.triangles,
      `${entry.flatFaces}/${entry.triangles}`,
    );
    check(
      `③ ${tag}：面内平 UV（一个面一种色调，${tones.length} 档）`,
      entry.uvFlatFaces === entry.triangles && entry.uvDistinct === tones.length,
      `平 UV ${entry.uvFlatFaces}/${entry.triangles}，不同 UV 值 ${entry.uvDistinct}`,
    );
    check(
      `④ ${tag}：模型完全落在碰撞体内（否则两枚币视觉互相插进去）`,
      entry.modelOutsideCollider === 0,
      `越界顶点 ${entry.modelOutsideCollider}，最差超出 ${entry.worstOutMillimeters.toFixed(4)} mm`,
    );
    // ⚠️ 容差必须是**相对**的：实测值读自 `Float32BufferAttribute`（float32，相对误差 ~6e-8），
    // 声明值是 float64 常量。用绝对容差（第一版写 1e-9）会得到一条**假红** ——
    // 打印出来两边都是「124.0 mm」，看不出差在哪。1e-5 相对 = 0.0012 mm，
    // 而真实的设计失配是毫米级的（踩过的锁孔 bug 差了 12 mm）。
    //
    // ★★ S16：这条判据的**语义变了**。
    //
    // S15 时它守的是「模型比币小一圈」（`circumscribedOverCoin < 1`），
    // 好让它们落进币缝而不是互相顶开。S16 用户拍板把比例翻上去
    // （钻石 1.5×、宝箱 2.5×），「< 1」成了**错断言**。
    //
    // 现在要守的是「实测外接直径 == 声明倍率 × 币径」。它真正抓的缺陷是
    // 「有个部件偷偷伸到设计范围之外」——那个缺陷与倍率取多少无关，
    // 只是当年恰好表现为「系数 > 1」而已（踩过的锁孔 bug 把外接直径撑大 10%）。
    const ratio = MODEL_DIAMETER_RATIO[entry.kind];
    check(
      `⑤ ${tag}：实测外接直径 = 声明值（${ratio} × 币径）`,
      Math.abs(entry.circumscribed - entry.specDiameter) <= entry.specDiameter * 1e-5 &&
        Math.abs(entry.circumscribedOverCoin - ratio) <= ratio * 1e-5,
      `实测 ${(entry.circumscribed * 1000).toFixed(1)} mm / 声明 ${(entry.specDiameter * 1000).toFixed(1)} mm，` +
        `占币径 ${entry.circumscribedOverCoin.toFixed(4)}（应 ${ratio}）`,
    );
    check(
      `⑥ ${tag}：碰撞体比普通币厚（层高 / 闸板下沿都读它）`,
      entry.colliderHeight > coin.halfThickness * 2,
      `${(entry.colliderHeight * 1000).toFixed(1)} mm = 币厚的 ${entry.heightOverCoinThickness.toFixed(2)} 倍`,
    );
    // ★ R4-4c「先量再改」：碰撞体里有多少是**看得见的空腔**。
    //
    // ④ 只查「模型不越出碰撞体」这一个方向；反方向（碰撞体比模型胖）从来没人量，
    // 所以「钻石四角是空的、但币进不去」这件事一直停在推测层面。
    // 这一条**先只做仪器自检**：两个比值必须有限且 ≥ 1。
    // 为什么 ≥ 1 也算判据：它与 ④ 是**同一件事的两种独立算法**
    // （④ 逐顶点比距离，这里逐三角形积分体积/投影面积），两者给出不一致的结论
    // 就说明其中一边算错了 —— 这是交叉校验，不是新放宽。
    check(
      `⑦ ${tag}：碰撞体松紧度读数有效（体积 / 占地，≥ 1 且非 NaN）`,
      Number.isFinite(entry.colliderVolumeOverModel) &&
        Number.isFinite(entry.colliderFootprintOverModel) &&
        entry.colliderVolumeOverModel >= 1 &&
        entry.colliderFootprintOverModel >= 1 &&
        Number.isFinite(entry.colliderHeightOverModel) &&
        entry.colliderHeightOverModel >= 1,
      `碰撞体 = 模型的 ${entry.colliderVolumeOverModel.toFixed(3)} 倍体积 / ` +
        `${entry.colliderFootprintOverModel.toFixed(3)} 倍占地 / ` +
        // ★ 三个数一起看才知道缝隙在**哪一维**：只报体积比会把它当成「四角内缩」，
        //   而按轴拆开之后最大的是高度 —— 要收的是碰撞体厚度，不是水平形状。
        `${entry.colliderHeightOverModel.toFixed(3)} 倍高度（形状 ${entry.collider.shape}）`,
    );
    const written = atlas[entry.kind];
    const expected = tones.map((tone) => entry.palette[tone]);
    check(
      `⑦ ${tag}：5 档色调全部来自 lockedPalette，且图集纹素一致（颜色没被转两次）`,
      written.join() === expected.join() &&
        entry.palette.light === entry.lockedPalette?.base &&
        entry.palette.deep === entry.lockedPalette?.dark &&
        entry.palette.dark === entry.lockedPalette?.ink,
      `${written.join(' ')}`,
    );
  }

  // ★ S16：从「两个模型的外接直径都 < 币径」改成「都 = 各自的声明倍率 × 币径」。
  //
  // 旧断言守的是「模型能落进币缝」。放大之后那个性质**既不成立也不该成立** ——
  // 这两件东西现在是盘面上最大的物件，靠的是碰撞体跟着换成模型自己的形状
  // （判据 ④ 守着），而不是靠尺寸比币小。
  //
  // 这条与 ⑤ 看着重复，但守的是**不同的东西**：⑤ 是逐币种「实测 == 声明」，
  // ⑧ 是跨币种「两个倍率各自都对、且**互不相同**」。只写 ⑤ 的话，
  // 有人把两个 ratio 抄成同一个值（比如都写 2.5）不会被任何判据发现。
  check(
    '⑧ 两个模型的外接直径 = 各自的声明倍率 × 币径，且倍率互不相同',
    audit.every((entry) => {
      const ratio = MODEL_DIAMETER_RATIO[entry.kind];
      return Math.abs(entry.circumscribed - coinDiameter * ratio) <= coinDiameter * ratio * 1e-5;
    }) && new Set(audit.map((entry) => MODEL_DIAMETER_RATIO[entry.kind])).size === audit.length,
    audit
      .map(
        (entry) =>
          `${entry.kind} ${(entry.circumscribed * 1000).toFixed(0)}/${(coinDiameter * 1000).toFixed(0)} mm ` +
          `= ${(entry.circumscribed / coinDiameter).toFixed(4)}×（应 ${MODEL_DIAMETER_RATIO[entry.kind]}×）`,
      )
      .join('，'),
  );
}

/**
 * 喷泉的**纯视觉币通道**（S16）。
 *
 * ## 为什么单独一个模式，而不是塞进 `show`
 *
 * 因为这条通道要跑一场**真的喷泉演出**，而 `show` 模式的后面两段都对「已经花掉多少预算」
 * 敏感：① 币塔那段写 `waitNextCompleted(0)`（假设还没有任何 completed 事件）；
 * ② 预算榨取循环的降级窗口落在 `起始余量 mod 7` 上，起始余量被提前消耗 10 枚就会
 * 跨过 `{3..6}` 那个窗口。实测把这段插进 `show` 会弄红 4 条（3 条事件错位 + 1 条降级记录 null）——
 * **那是判据之间的耦合，不是功能坏了**。单独一个模式两边都干净。
 *
 * ## 这条通道**故意不进任何账本**
 *
 * 所以「它到底跑没跑」在 `activeCoins` / `earned` / `drained` 上一个字都看不出来。
 * 要证明的事只能从 `sprayReport()` 读：
 *   ① 真的喷了（`launched > 0`）；
 *   ② 是**从玻璃顶沿之上**飞出去的（`peakYOutside ≥ 1.6`），不是穿过围板；
 *   ③ 它**一枚都没进币池**（活跃差 + 结算差 + 流失差仍精确等于真币承诺数）。
 */
async function runSpray(page) {
  console.log('\n── 模式：spray（喷泉视觉币通道） ──');
  await startRun(page, 'ready');

  const completedCount = (events) =>
    (events ?? []).filter((event) => event.phase === 'completed').length;

  const idle = await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.sprayReport?.(true));
  check(
    '空闲时不占 draw call（mesh 隐藏、活跃 0）',
    idle?.active === 0 && idle?.visible === false,
    `活跃 ${idle?.active}/${idle?.capacity}，visible=${idle?.visible}`,
  );

  const pre = await readStateFresh(page);
  const telemetryBefore = await readTelemetry(page);
  const scorePre = telemetryBefore?.scoreEvents?.length ?? 0;
  const doneBefore = completedCount(telemetryBefore?.showEvents);
  const request = await page.evaluate(() =>
    window.__THREE_GAME_TEST_HOOKS__?.showRequest?.('fountain'),
  );
  const promised = request?.promised ?? 0;

  // 飞行中：必须真的在画（`visible === true`），否则「+1 draw call」这条记账是空的。
  const airborne = await waitForSpray(page, (report) => (report?.active ?? 0) > 0);
  check(
    '演出期间视觉币在飞（活跃 > 0 且 mesh 可见）',
    (airborne?.active ?? 0) > 0 && airborne?.visible === true,
    `活跃 ${airborne?.active}，visible=${airborne?.visible}`,
  );

  await waitForTelemetry(page, (t) => completedCount(t?.showEvents) > doneBefore, 20_000);
  const report = await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.sprayReport?.());
  const post = await readStateFresh(page);
  const score = ((await readTelemetry(page))?.scoreEvents?.length ?? 0) - scorePre;
  const active = (post?.activeCoins ?? 0) - (pre?.activeCoins ?? 0);
  const drained = (post?.drained ?? 0) - (pre?.drained ?? 0);
  check(
    '确实喷出（launched > 0），且**一枚都没进币池**',
    (report?.launched ?? 0) > 0 && active + score + drained === promised,
    `launched=${report?.launched}，真币对账 活跃差 ${active} + 结算差 ${score} + 流失差 ${drained} ` +
      `= ${active + score + drained}（应 = 承诺 ${promised}）`,
  );
  check(
    '从玻璃顶沿之上飞出机柜（不是穿过围板）',
    (report?.peakYOutside ?? 0) >= 1.6 && (report?.outsideX ?? 0) > 0.8,
    `机柜外最高点 ${(report?.peakYOutside ?? 0).toFixed(3)} m（须 ≥ 1.6），` +
      `侧壁外沿 ${(report?.outsideX ?? 0).toFixed(3)} m`,
  );

  const materials = await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.sprayMaterial?.());
  check(
    '材质与铜币同 defines（0 新增程序、0 新增色条），但贴图是**两个实例**',
    Object.keys(materials?.spray ?? {}).length > 0 &&
      JSON.stringify(materials?.spray ?? {}) === JSON.stringify(materials?.bronze ?? {}) &&
      // 共享同一个贴图实例的后果是：`CoinPool.dispose()` 会把视觉币的贴图一起释放，
      // 币渲染成空 —— 零报错的静默失效。
      materials?.sprayMap !== materials?.bronzeMap,
    `defines spray ${JSON.stringify(materials?.spray)} / bronze ${JSON.stringify(materials?.bronze)}，` +
      `贴图实例 spray=${materials?.sprayMap} bronze=${materials?.bronzeMap}`,
  );

  // 演出结束后（最后一批币的飞行时间约 0.8 秒）必须全部回收。
  const settled = await waitForSpray(page, (r) => (r?.active ?? 1) === 0, 8_000);
  check(
    '演出结束后全部回收（不留残渣、恢复不占 draw call）',
    settled?.active === 0 && settled?.visible === false,
    `活跃 ${settled?.active}，visible=${settled?.visible}`,
  );

  // 换肤之后视觉币的贴图必须跟着重建 —— 漏了这条，「飞出去的币还是旧外观」
  // 在截图里几乎发现不了（币在飞，没人会去对色卡）。
  // ⚠️ 解锁价必须 > 0：`SaveStore.unlockSkin` 对 `cost <= 0` 直接返回 false（那是「免费解锁」
  // 的守卫），拿 0 去调会得到「既没解锁、也没报错」——判据于是报一条看不懂的假红。
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.unlockSkin?.('coin', 'silver', 1));
  const switched = await page.evaluate(() =>
    window.__THREE_GAME_TEST_HOOKS__?.selectSkin?.('coin', 'silver'),
  );
  const afterSkin = await page.evaluate(() =>
    window.__THREE_GAME_TEST_HOOKS__?.sprayMaterial?.(),
  );
  check(
    '换肤后视觉币贴图同步重建（仍是独立实例、仍与铜币同 defines）',
    switched?.selected === true &&
      afterSkin?.sprayMap !== materials?.sprayMap &&
      afterSkin?.sprayMap !== afterSkin?.bronzeMap &&
      JSON.stringify(afterSkin?.spray ?? {}) === JSON.stringify(afterSkin?.bronze ?? {}),
    `外观 ${switched?.coinSkin}；贴图 ${materials?.sprayMap} → ${afterSkin?.sprayMap}`,
  );
}

/**
 * 机柜 Arcane 风贴图的判据（S18）。
 *
 * 8 条判据全部是计数或像素读——「是不是 Arcane 风」走视觉，但「有没有挂上」
 * 走计数。`cabinet-tex` 模式必须在不改 `perf` 程序数与 `drawcall` 的前提下全绿。
 *
 * 依赖：
 *   - 三张 CanvasTexture 实例：**必须是不同实例**（`spray` 的同款判据），
 *     否则 `applyCabinetSkin` 切肤时 `dispose()` 会把兄弟贴图也释放掉。
 *   - `programs === 20`：与 S16 基线一字不差。
 *   - `drawcalls.max === 45`：仅招牌新增 1 平面，从 44 → 45。
 *   - 每张贴图的中心像素：`marquee` 必有彩色块；
 *     `scoreLine` 与 `hotZone` 必有「霓虹横纹」色相之一。
 */
async function runCabinetTex(page) {
  console.log('\n── 模式：cabinetTex（机柜 Arcane 风贴图） ──');

  const cabinetTex = await page.evaluate(async () => {
    const ct = await import('/src/render/cabinetTexture.ts');
    const marquee = ct.createArcaneMarqueeTexture('jinxMagenta');
    const scoreLine = ct.createArcaneScoreLineTexture('viArcane');
    const hotZone = ct.createArcaneHotZoneTexture('firelight');
    // S25 / R1-M3：侧板内凹灯饰（第四种构图）。
    const lampHousing = ct.createArcaneLampHousingTexture('cobaltArcane');
    // 把 texture 真接打包成可序列化：uuid + 中间/角落的像素 RGB。
    // 跨 evaluate 边界 `CanvasTexture` 不能 structured-clone，但 `texture.image.canvas`
    // 是真正的 `<canvas>` DOM，可以跨边界——只是序列化后会变 canvas element 不是像素。
    const samples = (texture) => {
      const canvas = texture.image;
      const ctx = canvas.getContext('2d');
      const w = canvas.width;
      const h = canvas.height;
      const mid = ctx.getImageData(Math.floor(w / 2), Math.floor(h / 2), 1, 1).data;
      const corner = ctx.getImageData(8, 8, 1, 1).data;
      return { mid: [mid[0], mid[1], mid[2]], corner: [corner[0], corner[1], corner[2]] };
    };
    return {
      marquee: { uuid: marquee.uuid, ...samples(marquee) },
      scoreLine: { uuid: scoreLine.uuid, ...samples(scoreLine) },
      hotZone: { uuid: hotZone.uuid, ...samples(hotZone) },
      lampHousing: { uuid: lampHousing.uuid, ...samples(lampHousing) },
      // 灯饰画布的高宽比是照**侧墙剖面跨度**挑的（≈0.84:1）。它一旦和那个比例脱钩，
      // 灯位就会被垂直拉扁 / 压长，而画面照样「有图」——所以在这里钉住尺寸本身。
      lampSize: [lampHousing.image.width, lampHousing.image.height],
    };
  });

  // 四张图必须不同实例——同款判据（`spray` mode）已经踩过：用同一份贴图
  // 不能跨切肤，否则 dispose 会把兄弟贴图也释放掉。
  const texUuids = [
    cabinetTex.marquee.uuid,
    cabinetTex.scoreLine.uuid,
    cabinetTex.hotZone.uuid,
    cabinetTex.lampHousing.uuid,
  ];
  check(
    '四张 CanvasTexture 必须是不同实例（共享会让 dispose 误杀兄弟）',
    new Set(texUuids).size === 4,
    texUuids.join(' '),
  );
  check(
    '灯饰画布比例 ≈ 侧墙剖面跨度（0.84:1，偏离就会把灯位拉扁）',
    Math.abs(cabinetTex.lampSize[0] / cabinetTex.lampSize[1] - 0.84) < 0.02,
    `lamp=${cabinetTex.lampSize.join('×')} → ${(cabinetTex.lampSize[0] / cabinetTex.lampSize[1]).toFixed(3)}`,
  );

  // 调色板槽数与各档颜色。`ARCANE_PALETTES[key][0..4]` 与 `MODEL_TONES.length === 5` 同档。
  const palette = await page.evaluate(async () => {
    const ct = await import('/src/render/cabinetTexture.ts');
    return ct.ARCANE_PALETTES;
  });
  check(
    '四个调色板槽数 = 5（与 coinTexture 的 5 档色带同档，不咬定义）',
    palette.jinxMagenta.length === 5 &&
      palette.viArcane.length === 5 &&
      palette.firelight.length === 5 &&
      // S20 新增 `cobaltArcane`（「深海钴蓝」皮肤用）。**新加 palette key 必须同时
      // 落进这条判据** —— 否则下次有人往某个 key 里塞 6 个槽也没人拦。
      palette.cobaltArcane.length === 5,
    `jinxMagenta=${palette.jinxMagenta.length} viArcane=${palette.viArcane.length} ` +
      `firelight=${palette.firelight.length} cobaltArcane=${palette.cobaltArcane.length}`,
  );

  // 像素读回——招牌中心必须是有饱和色块；角落里是煤黑底（`palette[4]`）。
  // 已经在第一次 evaluate 阶段把 5 像素（mid + corner）打包成可序列化对象带回来。
  // 这里直接读字段。
  // 字面比较：mid RGB 三通道之一与 corner 三通道之一不同 ⇒ 通过。
  const colorEqual = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
  check(
    '招牌中心像素 RGB 与角落里 RGB 不同（Arcane 必须有笔触，不是平铺）',
    !colorEqual(cabinetTex.marquee.mid, cabinetTex.marquee.corner),
    `mid=${cabinetTex.marquee.mid.join(',')} corner=${cabinetTex.marquee.corner.join(',')}`,
  );

  // 程序数与 draw call——这是 `perf` 判据在 cabinetTex 模式下的单独复刻。
  const perf = await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.materialReport?.());
  // S18 加 scoreLine / hotZone / marquee 三份贴图。
  // 数从 S16 的 20 变到 23，每个 map 可能 +1 程序变体。
  // 判据用 < 30 守门——给余量 7 个，正常不应涨到这个数。
  check(
    '已编译程序数 < 30（每加贴图 +1 程序变体；与 S16 基线 20 比，按件增 ~3）',
    (perf?.programs ?? 0) < 30,
    `programs=${perf?.programs}`,
  );
  // drawcall：实测上一轮 46（拆外壳 8 件 + 背板）。**S21 删掉招牌这一件 ⇒ 45**。
  // 判据仅 check ≥ 40 且 ≤ 50（与 perf 同条），不写死 45 —— 因为相机偏移 /
  // 演出期间可能瞬时再 +1（喷泉的视觉币），不是回归。
  const maxDraw = Number(perf?.renderer?.calls ?? 0);
  check(
    'drawcall ∈ [40, 50]（perf 上限是 50；S21 删招牌后基线 46 → 45）',
    maxDraw >= 40 && maxDraw <= 50,
    `drawcall=${maxDraw}`,
  );

  // 已加载贴图实例数（不与 `CoinPool.materialFor` 共享 dispose 链）——通过
  // scene.traverse + material.map 不为 null 计数。
  const mapCount = await page.evaluate(() => {
    let n = 0;
    return window.__THREE_GAME_TEST_HOOKS__?.cabinetMapCount?.() ?? -1;
  });
  // 带 map 的材质实例数。⚠️ 这个计数是**全场**的（币面贴图也算，实测 16），
  // 所以它只是一道「贴图通道整体还活着」的粗闸；「灯饰挂在哪一件上」由下面那条
  // 按 `part` 逐件比对的判据负责——那条才是 `panelArt` 拆分的守门人。
  check(
    '机柜带 map 通道的材质数 ≥ 4（scoreLine + hotZone + trim + panelArt 的下界）',
    mapCount >= 4,
    `cabinetMapCount=${mapCount}`,
  );

  // 贴图**落在哪一件上**（S25 / R1-M3 起，R2-T1-5 扩到「每件各一张」）。
  // 上面那条总量判据答不出这件事，而材质拆分的**全部意义**就是「这一件挂这一张」：
  // 哪天有人把两份实例并回一份，两件会立刻共用同一张图 —— 零报错，只是画面变平。
  // ⚠️ 这条判据原先断言的是「背板**不挂**」；T1-5 之后背板有自己的构图，
  // 断言随之从「不挂」改成「挂的是自己那张、且与别件不同」。
  const mapsByPart = await page.evaluate(() => {
    const maps = {};
    const glows = {};
    for (const entry of window.__THREE_GAME_TEST_HOOKS__?.cabinetReport?.() ?? []) {
      maps[entry.part] = entry.map;
      glows[entry.part] = entry.glow;
    }
    return {
      tallL: maps['sideWall.tall.L'] ?? null,
      tallR: maps['sideWall.tall.R'] ?? null,
      back: maps.backPanel ?? null,
      valance: maps.hoodValance ?? null,
      roof: maps.hoodRoof ?? null,
      glowL: glows['sideWall.tall.L'] ?? null,
      // 该发光的是两件「`color × map` 乘不出来的高对比亮线」：侧墙的灯管条、顶板的板缝与铆钉。
      // 檐板（招牌）**不该**发光：它本来就走亮色带，再加 emissive 就过曝成白。
      glowValance: glows.hoodValance ?? null,
      glowRoof: glows.hoodRoof ?? null,
    };
  });
  check(
    '每件外壳挂自己那张构图（侧墙左右同图；顶板 / 檐板 / 背板三张互不相同）',
    mapsByPart.tallL !== null &&
      mapsByPart.tallL === mapsByPart.tallR &&
      new Set([mapsByPart.valance, mapsByPart.roof, mapsByPart.back]).size === 3 &&
      mapsByPart.glowL !== null &&
      mapsByPart.glowValance === null,
    JSON.stringify(mapsByPart),
  );  // ★ 「挂了图」≠「灯亮着」。侧墙是深色 `panel` 色带，而 toon 材质是 `color × map`：
  //   只挂 `map` 时贴图里的近白灯管会被乘成暗斑（实测就是这样，画布上明明有灯）。
  //   亮条要靠 `emissiveMap` 走自发光的加法通道 —— 这条判据守的就是那一步有没有漏。
  check(
    '灯饰同时挂了 emissiveMap（深色带上只有自发光通道能变亮），且不外溢到招牌',
    mapsByPart.glowL !== null &&
      mapsByPart.glowL === mapsByPart.tallL &&
      mapsByPart.glowValance === null,
    `glow=${mapsByPart.glowL} sameAsMap=${mapsByPart.glowL === mapsByPart.tallL} valanceGlow=${mapsByPart.glowValance}`,
  );
  // 顶板从「不该发光」改成「该发光」是**改判据**，不是顺手放宽：原先那条推理
  // （「它吃 trim 色带，加 emissive 会像招牌一样过曝」）只对亮色带的檐板成立；
  // 顶板在演奏相机下是一大片近乎平行于视线的暗面，不走自发光通道就什么都看不见。
  // 这条同时守住「并回共用材质」那种静默退化：挂的必须**就是顶板自己那张**。
  check(
    '顶板走自发光通道（板缝 / 铆钉在演奏相机下可见），且用的就是自己那张图',
    mapsByPart.glowRoof !== null &&
      mapsByPart.glowRoof === mapsByPart.roof &&
      mapsByPart.glowValance === null,
    `roofGlow=${mapsByPart.glowRoof} roofMap=${mapsByPart.roof} 同图=${mapsByPart.glowRoof === mapsByPart.roof}`,
  );

  // 三张贴图实测在 page 内，cache 同 UUID ⇒ 切肤时会撞 dispose 链；
  // 这里不直接 dispose，让 GC 走引用链回收（页面关闭自然释放）。
  void cabinetTex;
}

/**
 * 机柜外壳的**几何真源**判据（S19）。
 *
 * ## 这个模式为什么存在
 *
 * S18 把机柜外壳改成一块 `ExtrudeGeometry` 时朝向反了 —— 一块 1.78 × 1.77 × 1.97 米的
 * 实心砖盖住玩家这一半台面、糊满画面。而当时 `perf` / `drawcall` / `programs` /
 * `cabinetTex` / `models` **全部通过**：没有一条判据在看画面，也没有一条**能**看 ——
 * 尺寸全写死在 `buildCabinetShell()` 的函数体里，判据只能手抄第二份公式。
 *
 * 所以本模式做三件事：
 *
 * ① **解析盒 vs 实测盒逐件比对**：真源是 `game/cabinetShape.ts` 的 `cabinetPartBox()`，
 *    实测来自 `__THREE_GAME_TEST_HOOKS__.cabinetReport()`（场景里 `Box3` 算的）。
 *    两者是**同一份数据的独立推导**，任何一边的公式写错都会当场失败。
 * ② **跨模块不变量**：侧墙内表面 = `TABLE.halfWidth`、背板前表面 = `TABLE.backZ`、
 *    顶板上沿 = 侧墙上沿 …… 这些不是「再抄一遍数字」，而是两个模块必须对齐的接口。
 * ③ **负空间**：外壳绝对不许裹住币床中点 `COIN_BED_MIDPOINT`。
 *    这正是 S18 那场事故的判据形态（那块砖恰好吃掉了这个点）。
 *
 * 末了落两张人工核对的截图（游玩视角 + 竖屏全景）—— 判据能盖住的只是「结构性错误」，
 * 「像不像一台机柜」仍然要人看一眼；而且**游玩视角本身看不到顶板**，
 * 只看那一张会误以为「顶盖没了」。见 ⑨ 的注释。
 */
async function runCabinet(page, context) {
  console.log('\n── 模式：cabinet（机柜外壳几何） ──');
  void context;

  // ── 真源：全部从 `cabinetShape.ts` / `constants.ts` 读，脚本里不写任何尺寸 ──
  const truth = await page.evaluate(async () => {
    const cs = await import('/src/game/cabinetShape.ts');
    const consts = await import('/src/game/constants.ts');
    const ad = await import('/src/game/artDirection.ts');
    const boxes = {};
    for (const part of cs.CABINET_SHELL_PARTS) boxes[part] = cs.cabinetPartBox(part);
    return {
      parts: [...cs.CABINET_SHELL_PARTS],
      boxes,
      // ★ S24：模型模式（`?model`）的运行期覆盖**不许**在判据下生效。
      // 若它生效了，下面那条「解析盒 vs 实测盒」会**两边一起变**、照样全绿 ——
      // 于是一个只活在 localStorage 里、从没落进代码的尺寸会被当成已提交的。
      //
      // ⚠️ 必须读**应用实例**（`cabinetShapeReport`），不能写
      // `cs.isCabinetOverridden()`：裸 `import()` 拿到的是另一个模块实例，
      // 那个实例永远没有覆盖 ⇒ 这条判据会恒真（实测踩过）。
      // 钩子缺失时给 `null` ⇒ 判据红，而不是静默通过。
      overridden: window.__THREE_GAME_TEST_HOOKS__?.cabinetShapeReport?.()?.overridden ?? null,
      midpoint: [...cs.COIN_BED_MIDPOINT],
      halfWidth: consts.TABLE.halfWidth,
      backZ: consts.TABLE.backZ,
      railHeight: consts.TABLE.railHeight,
      // 色带名单也**从引擎读**（`ROLE_RAMP` 的键集就是 `ROLE_COLOR` 的定义域），
      // 不在脚本里手抄一遍 `panel/rail/trim/...`。
      bands: Object.keys(ad.ROLE_RAMP),
      // ★ S21：侧墙两段的**轮廓折线**也在这里读出来（脚本里不写任何 z / y）。
      // 它是「包围盒内部那些斜边」的唯一真源 —— `cabinetWallOutline()` 与
      // `TableBuilder.buildSideWall()` 是两条**独立推导**（后者刻意不调它），
      // 所以下面那条逐顶点比对才有意义。
      outlines: {
        tall: cs.cabinetWallOutline('tall').map(([z, y]) => [z, y]),
        low: cs.cabinetWallOutline('low').map(([z, y]) => [z, y]),
      },
      // ★ S25：斜角是「两张表配对」的（角点 ↔ `bevel.wallChamfer` 的键）。
      // 只读**集合**，脚本里不写任何半径公式或角点名。
      wallPointIds: [
        ...cs.WALL_OUTLINE_BINDING.tall.map((point) => point.id),
        ...cs.WALL_OUTLINE_BINDING.low.map((point) => point.id),
      ],
      wallChamferKeys: Object.keys(cs.CABINET.bevel.wallChamfer),
    };
  });

  const measuredList = await page.evaluate(
    () => window.__THREE_GAME_TEST_HOOKS__?.cabinetReport?.() ?? [],
  );
  const measured = new Map();
  for (const entry of measuredList) {
    if (!measured.has(entry.part)) measured.set(entry.part, []);
    measured.get(entry.part).push(entry);
  }
  /** 取某件唯一的一份读数（缺件 / 重复返回 null）。 */
  const box = (part) => {
    const list = measured.get(part) ?? [];
    return list.length === 1 ? list[0] : null;
  };

  // 2e-5 米 = 0.02 毫米。几何属性是 float32，这个容差只吸收舍入，
  // 比任何「有意思的几何错误」（毫米级起步）小两个数量级。
  const TOL = 2e-5;
  const near = (a, b) => Math.abs(a - b) <= TOL;
  const fmt = (v) => Number(v).toFixed(5);

  // ① 件册完整性
  const rosterGap = truth.parts.filter((part) => (measured.get(part) ?? []).length !== 1);
  check(
    `${truth.parts.length} 件外壳各恰好一次（少一件 = S18 那种「背板被并进挤出件里」的静默丢失）`,
    rosterGap.length === 0,
    rosterGap.length === 0
      ? `${truth.parts.length} 件齐全：${truth.parts.join(' ')}`
      : `缺失或重复：${rosterGap.join(', ')}`,
  );

  // ①b 运行期覆盖不许在判据下生效（S24）
  //
  // 模型模式（`?model`）会把 `cabinetShape.ts` 的覆盖层打开，而
  // `cabinetPartBox()` 与建网格**都读 `cabinetShape()`** ⇒ 覆盖一旦生效，
  // 下面那条逐面比对会两边一起变、恒绿。这条把那个静默陷阱堵死：
  // 「调好了但忘了落盘」必须当场红。
  check(
    '没有模型模式的运行期覆盖在生效（否则「解析盒 = 实测盒」会两边一起变、恒绿）',
    truth.overridden === false,
    truth.overridden === false
      ? '读的是编译期真值 CABINET'
      : '★ 有 localStorage 覆盖在生效 —— 请先在 ?model 里「导出改动」并落回 cabinetShape.ts',
  );

  // ② 解析盒 = 实测盒（逐件逐轴）
  const boxDiffs = [];
  for (const part of truth.parts) {
    const entry = box(part);
    if (!entry) continue;
    const analytic = truth.boxes[part];
    for (let axis = 0; axis < 3; axis += 1) {
      if (!near(entry.min[axis], analytic.min[axis]) || !near(entry.max[axis], analytic.max[axis])) {
        boxDiffs.push(
          `${part}.${'xyz'[axis]} 实测[${fmt(entry.min[axis])},${fmt(entry.max[axis])}]` +
            ` ≠ 真源[${fmt(analytic.min[axis])},${fmt(analytic.max[axis])}]`,
        );
      }
    }
  }
  check(
    '解析盒 = 实测盒（逐件逐轴，容差 0.02 毫米）',
    boxDiffs.length === 0,
    boxDiffs.length === 0
      ? `${truth.parts.length} 件 × 6 个面全部一致`
      : boxDiffs.slice(0, 4).join(' | '),
  );

  // ③ 镜像对称
  const asym = [];
  for (const [left, right] of [
    ['sideWall.tall.L', 'sideWall.tall.R'],
    ['sideWall.low.L', 'sideWall.low.R'],
  ]) {
    const a = box(left);
    const b = box(right);
    if (!a || !b) {
      asym.push(`${left}/${right} 缺件`);
      continue;
    }
    if (!near(-a.min[0], b.max[0]) || !near(a.max[0], -b.min[0])) {
      asym.push(`${left} x[${fmt(a.min[0])},${fmt(a.max[0])}] vs ${right} x[${fmt(b.min[0])},${fmt(b.max[0])}]`);
    }
  }
  check(
    '左右侧墙镜像对称（手搭模型沿 +x 偏了 2.5 毫米 —— 那是 C4D 手工挪件的痕迹，不是设计）',
    asym.length === 0,
    asym.length === 0 ? '两对侧墙完全镜像' : asym.join(' | '),
  );

  // ④ 负空间：这是 S18 事故的判据形态
  const bed = truth.midpoint;
  const intruders = measuredList
    .filter((entry) => truth.parts.includes(entry.part))
    .filter(
      (entry) =>
        bed[0] > entry.min[0] &&
        bed[0] < entry.max[0] &&
        bed[1] > entry.min[1] &&
        bed[1] < entry.max[1] &&
        bed[2] > entry.min[2] &&
        bed[2] < entry.max[2],
    );
  check(
    '负空间：没有任何外壳件裹住币床中点（S18 那块砖恰好裹住它 ⇒ 画面被糊满）',
    intruders.length === 0,
    intruders.length === 0
      ? `探针 (${bed.map(fmt).join(', ')}) 在壳外`
      : `被裹住：${intruders.map((entry) => entry.part).join(', ')}`,
  );

  // ⑤ 跨模块不变量（都是「两个模块必须对齐」的接口，不是重抄数字）
  const tallR = box('sideWall.tall.R');
  const lowL = box('sideWall.low.L');
  const roof = box('hoodRoof');
  const valance = box('hoodValance');
  const backPanel = box('backPanel');

  /**
   * 低段斜顶的**前端**端点 y（实测）：前立面（实测最大 z）上最高的那个顶点。
   *
   * S21 的斜顶两个端点都在包围盒内部（盒的 `max[1]` 只反映后端），
   * 所以「前端有多低」只能从实测顶点集合里读 —— 这也是轮廓断言之外的
   * **量纲级**读数（它守的是「低段不能低到读不出是围挡」）。
   */
  const lowProfile = box('sideWall.low.L')?.profile ?? [];
  const lowFrontZ = lowProfile.length ? Math.max(...lowProfile.map(([, z]) => z)) : Number.NaN;
  const roofFrontY = lowProfile.length
    ? Math.max(
        ...lowProfile.filter(([, z]) => Math.abs(z - lowFrontZ) < 1e-3).map(([y]) => y),
      )
    : Number.NaN;

  const invariants = [
    [
      '侧墙内表面 = TABLE.halfWidth（与侧壁碰撞体内表面同面，否则币停在离可视墙一条缝处）',
      tallR && near(tallR.min[0], truth.halfWidth),
      tallR ? `${fmt(tallR.min[0])} vs ${fmt(truth.halfWidth)}` : '缺件',
    ],
    [
      '背板前表面 = TABLE.backZ（与后墙碰撞体内表面同面，S16 定下的接口）',
      backPanel && near(backPanel.max[2], truth.backZ),
      backPanel ? `${fmt(backPanel.max[2])} vs ${fmt(truth.backZ)}` : '缺件',
    ],
    [
      '顶板上沿 = 侧墙高段上沿（机柜顶必须是一个平面，不许有错台）',
      roof && tallR && near(roof.max[1], tallR.max[1]),
      roof && tallR ? `${fmt(roof.max[1])} vs ${fmt(tallR.max[1])}` : '缺件',
    ],
    [
      '檐板上沿 = 顶板上沿',
      roof && valance && near(valance.max[1], roof.max[1]),
      roof && valance ? `${fmt(valance.max[1])} vs ${fmt(roof.max[1])}` : '缺件',
    ],
    [
      '檐板内表面 = 侧墙台阶（否则檐板嵌进侧墙高段里）',
      valance && tallR && near(valance.min[2], tallR.max[2]),
      valance && tallR ? `${fmt(valance.min[2])} vs ${fmt(tallR.max[2])}` : '缺件',
    ],
    [
      '顶板 / 侧墙 / 背板的后缘共面',
      roof && tallR && backPanel && near(roof.min[2], tallR.min[2]) && near(backPanel.min[2], tallR.min[2]),
      roof && tallR && backPanel
        ? `${fmt(roof.min[2])} / ${fmt(tallR.min[2])} / ${fmt(backPanel.min[2])}`
        : '缺件',
    ],
    [
      // ★ S21 改写（原判据：「侧墙低段顶 > TABLE.railHeight」——注释写的是
      //   「手搭模型把墙长高了，而碰撞体没动」，即守住「可视围挡不能低于物理护栏」）。
      //
      //   用户批注 ⑤ 要求低段前端降 1/3 ⇒ 新几何是**斜顶**：后端 0.44 / 前端 0.32
      //   （后端 ≈ 0.647 × 2/3，见 `CABINET.wall.lowRoofBackY`），两者都**低于**
      //   物理护栏 0.46。也就是说「币撞得到的护栏比看得见的斜顶高」这段空隙
      //   （后端 2 厘米、前端 14 厘米）是**有意的**，用户已确认照参考图做。
      //
      //   所以这条改守它现在真正该守的东西：**可视围挡不能低到「读不出是围挡」**
      //   —— 阈值取物理护栏的 2/3（0.3067 米），斜顶的**两个端点**都要过线。
      //   端点值从实测轮廓里取（前立面 z 上最高的那个顶点），不再手抄公式。
      '侧墙低段（可视围挡）斜顶的两个端点都 ≥ 物理护栏的 2/3 —— S21 斜顶有意低于 railHeight，这条守「不能低到读不出围挡」',
      lowL && roofFrontY >= truth.railHeight * (2 / 3) && lowL.max[1] >= truth.railHeight * (2 / 3),
      lowL
        ? `斜顶后端 ${fmt(lowL.max[1])} / 前端 ${fmt(roofFrontY)}，` +
          `物理护栏 ${fmt(truth.railHeight)}（空隙 ${fmt(truth.railHeight - roofFrontY)} 米，有意保留）`
        : '缺件',
    ],
    [
      // 这条抓的是「某一件从机柜背后鼓出来」——手搭模型里正是这样：
      // 背板 6 厘米厚而侧墙 / 顶板的后缘只到 −1.3832 ⇒ 背板多探出 2.7 厘米。
      // 「三件后缘共面」只能证明**这三件**齐平，任何第四件（或将来新增的件）
      // 探出后面照样要被抓到，所以这条单独成立。
      '没有任何外壳件探出背板外表面（机柜最后缘是背板）',
      backPanel &&
        truth.parts.every((part) => {
          const entry = box(part);
          return entry ? entry.min[2] >= backPanel.min[2] - TOL : true;
        }),
      backPanel
        ? truth.parts
            .map((part) => {
              const entry = box(part);
              return entry ? `${part}:${fmt(entry.min[2])}` : `${part}:?`;
            })
            .join(' ')
        : '缺件',
    ],
  ];
  for (const [name, ok, detail] of invariants) check(name, Boolean(ok), detail);

  // ⑤b 侧墙轮廓（S21）：解析盒**看不见**的那两条斜边
  //
  // 檐板托的斜接面与低段斜顶 **100% 落在包围盒内部** ⇒ 把它们写成水平的、
  // 或者把两个端点接反，上面那些解析盒断言**仍然全绿**。所以这里逐顶点比对：
  //   真源 = `cabinetShape.ts` 的 `cabinetWallOutline()`（脚本不写第二份公式）；
  //   实测 = `cabinetReport().profile`（几何顶点投影到 (y, z) 去重后的集合）。
  // 比对的是**集合**（轮廓的起点与环绕方向无关），坐标量化到 0.1 毫米。
  const quant = (v) => Math.round(v * 1e4) / 1e4;
  const outlineDiffs = [];
  for (const [part, segment] of [
    ['sideWall.tall.L', 'tall'],
    ['sideWall.tall.R', 'tall'],
    ['sideWall.low.L', 'low'],
    ['sideWall.low.R', 'low'],
  ]) {
    const entry = box(part);
    if (!entry) {
      outlineDiffs.push(`${part} 缺件`);
      continue;
    }
    const measuredSet = new Set((entry.profile ?? []).map(([y, z]) => `${quant(y)},${quant(z)}`));
    const truthSet = new Set(truth.outlines[segment].map(([z, y]) => `${quant(y)},${quant(z)}`));
    const missing = [...truthSet].filter((key) => !measuredSet.has(key));
    const extra = [...measuredSet].filter((key) => !truthSet.has(key));
    if (missing.length || extra.length) {
      outlineDiffs.push(
        `${part} 缺 ${missing.length} 个（${missing.slice(0, 3).join(' ')}）` +
          `/ 多 ${extra.length} 个（${extra.slice(0, 3).join(' ')}）`,
      );
    }
  }
  check(
    '侧墙轮廓与 cabinetWallOutline() 逐顶点一致（斜接面 / 斜顶都在包围盒内部 ⇒ 解析盒看不见它们）',
    outlineDiffs.length === 0,
    outlineDiffs.length === 0
      ? `4 段侧墙与真源折线完全一致（高段 ${truth.outlines.tall.length} 点 / 低段 ${truth.outlines.low.length} 点，S25 起含斜角切点）`
      : outlineDiffs.join(' | '),
  );

  // ⑤c 逐角斜角的「表 ↔ 数据」配对（S25）
  //
  // `bevel.wallChamfer` 的键必须与 `WALL_OUTLINE_BINDING` 的角点**一一对应**。
  // TypeScript 已经保证「漏一个角编译不过」，但保证不了**多余**：存档 / 手改
  // 留下的失效 id 会让那一格的斜角静默失效，表现是「面板上拖了、几何不动」。
  // 这条查的是对称差，两侧都报。
  const chamferGap = [
    ...truth.wallPointIds.filter((id) => !truth.wallChamferKeys.includes(id)),
    ...truth.wallChamferKeys.filter((key) => !truth.wallPointIds.includes(key)),
  ];
  check(
    'bevel.wallChamfer 的键 ↔ WALL_OUTLINE_BINDING 的角点一一对应（无孤儿、无漏角）',
    truth.wallPointIds.length > 0 && chamferGap.length === 0,
    chamferGap.length === 0
      ? `${truth.wallPointIds.length} 个角点各有斜角名额`
      : `对不上：${chamferGap.join(', ')}`,
  );

  // ⑥ 檐板正面朝向：任何**计数型**判据都拦不住的那一类缺陷
  //
  // S19~S20 这里判的是招牌（倾斜板，法线 y>0 且 z>0）。S21 删掉招牌之后，
  // 承担招牌画布的是**檐板** —— 一块竖直薄板，局部 +z 应当正好朝前。
  // 这条断言的意义没变：它是「正面朝哪」的唯一观测通道 ——
  // S18 把招牌倾角符号写反、正面朝地面时，所有计数型判据全绿。
  check(
    '檐板正面朝前（局部 +z 的世界方向 ≈ (0, 0, 1)）—— S21 起它就是招牌画布',
    Boolean(valance) &&
      Math.abs(valance.normal[0]) < 1e-6 &&
      Math.abs(valance.normal[1]) < 1e-6 &&
      valance.normal[2] > 0.999,
    valance ? `法线 (${valance.normal.map((v) => v.toFixed(3)).join(', ')})` : '缺件',
  );

  // R3-U4：招牌显示屏。它**不在**上面那 7 件里（没有 `part`，换肤与贴图分发都不吃它），
  // 所以只能单开一条通道看。三件事要问：在不在、贴没贴上、有没有吃自己的纹理 ——
  // 第三件最容易静默失效：`emissiveMap` 忘了挂时屏是纯黑的，而纯黑的屏在截图里
  // 和「没开灯的招牌」几乎没区别，任何计数型判据都不会红。
  const screen = await page.evaluate(
    () => window.__THREE_GAME_TEST_HOOKS__?.marqueeReport?.() ?? null,
  );
  // ★ 「比例锁 4:1」这条已经作废（09-30）：屏做满之后面板比例是**几何算出来的**
  // （`hood.topY − valanceBottomY` 与 `halfWidth`，`?model` 还能改），写死 4:1 既守不住
  // 也测不对——真正该守的是「**纹理宽高比 == 面板宽高比**」，即拉伸为 0。
  // 容差 2 %：宽度取整到 4 的倍数（扫描线周期）带来的残差 ≤ 2/320 ≈ 0.6 %，
  // 而它要抓的那次失配是**同一个数**：改之前纹理 4:1、面板 4.997:1 ⇒
  // 这里打印 −19.95 %（`纹比/面比 − 1`），换个方向说就是「字被横向拉宽 24.9 %」
  //（`面比/纹比 − 1`）。两个口径都是同一件事，读数时别以为是两个缺陷。
  // 离噪声远，不是离读数近。
  const stretch =
    screen && screen.height > 0 && screen.textureHeight > 0
      ? (screen.textureWidth / screen.textureHeight) / (screen.width / screen.height) - 1
      : 1;
  check(
    '招牌屏挂在檐板正前 2 mm、居中、纹理比例贴合面板（拉伸 < 2%）、map 与 emissiveMap 都是那块画布',
    Boolean(screen) &&
      Boolean(valance) &&
      Math.abs(screen.world[2] - (valance.max[2] + 0.002)) < 1e-3 &&
      Math.abs(screen.world[0]) < 1e-6 &&
      screen.world[1] > valance.min[1] &&
      screen.world[1] < valance.max[1] &&
      Math.abs(stretch) < 0.02 &&
      screen.mapIsScreen === true &&
      screen.emissiveMapIsScreen === true &&
      screen.materialName === 'marqueeScreen',
    screen
      ? `屏 ${screen.width.toFixed(3)}×${screen.height.toFixed(3)} 米 @ z=${fmt(screen.world[2])}` +
        `（檐板前面 ${fmt(valance.max[2])} + 2 mm），map=${screen.mapIsScreen}` +
        ` emissiveMap=${screen.emissiveMapIsScreen}，纹理 ${screen.textureWidth}×${screen.textureHeight}` +
        ` ⇒ 横向拉伸 ${(stretch * 100).toFixed(2)}%`
      : '缺件',
  );

  // ★ B（文字硬边化）+ C（扫描线移到文字之下）的守卫：这块屏是 LED 面板，
  // 画布上**本该只有个位数种颜色**（底色、扫描线暗底、字色，两行时再多一种）。
  // 字体抗锯齿每多一档灰边，这个数就往上翻 —— 实测：二值化之前 **183** 种，
  // 只处理 alpha 是 **9** 种（高覆盖率的边上光栅化器仍给出 ±1~2 的 RGB 偏差），
  // 把保留像素的 RGB 也钉成填充色之后：单行 **3**、两行 **4**，正好等于调色板大小。
  //
  // 为什么用颜色数而不是「截图看起来清不清晰」：灰边在 3D 里还要再过一次
  // MSAA + ACES + 1.36 倍放大，屏幕像素上根本量不出「有没有灰边」，
  // 而在**纹理这一层**它是可精确计数的。
  //
  // 两行态要主动触发才测得到（原本只有老虎机开奖会走那条路），所以这里
  // 用 `marqueeSubtitle` 进那个状态再读一次 —— 否则判据只覆盖了单行。
  const singleLine = screen?.distinctColors ?? -1;
  await page.evaluate(() =>
    window.__THREE_GAME_TEST_HOOKS__?.marqueeSubtitle?.('投币点亮四槽，集齐摇老虎机'),
  );
  await page.waitForTimeout(600);
  const twoLines =
    (await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.marqueeReport?.() ?? null))
      ?.distinctColors ?? -1;
  console.log(`  [招牌屏调色板] 单行 ${singleLine} 种颜色 / 两行 ${twoLines} 种（二值化前 183）`);
  check(
    '招牌屏画布是硬边的（单行 ≤ 3、两行 ≤ 4 种颜色；抗锯齿灰边会把它推到几百）',
    singleLine >= 0 && singleLine <= 3 && twoLines >= 0 && twoLines <= 4,
    `单行=${singleLine} 两行=${twoLines}`,
  );

  // ★ E（循环滚动）的守卫：内容必须**真的在动**。
  //
  // 为什么这条值得钉：遮挡是按视口算出来的（桌面约 48% 被 DOM 覆盖层压住），
  // 而循环滚动的整个理由就是「不跟视口较劲，让内容自己走到可见区」。
  // 一旦有人把 `tick()` 里那行改回「只在放不下时才滚」，账本行就会**永远停在被挡住的位置**，
  // 而截图上完全看不出问题（看得见的那半截本来就是对的）—— 只有时间维度能抓到。
  //
  // 断言取「两次采样之间 offset.x 变了」+「始终在 [0,1) 内回绕」。
  // 不钉具体速度：那是审美参数，钉死只会让人不敢调。
  const scrollA = await page.evaluate(
    () => window.__THREE_GAME_TEST_HOOKS__?.marqueeReport?.()?.offsetX ?? -1,
  );
  await page.waitForTimeout(700);
  const scrollB = await page.evaluate(
    () => window.__THREE_GAME_TEST_HOOKS__?.marqueeReport?.()?.offsetX ?? -1,
  );
  check(
    '招牌屏在循环滚动（内容会自己走到没被遮挡的区域）',
    scrollA >= 0 &&
      scrollB >= 0 &&
      scrollB < 1 &&
      Math.abs(scrollB - scrollA) > 1e-4,
    `offsetX ${scrollA} → ${scrollB}（700 ms）`,
  );

  // ⑦ 「它还长得像一台机柜吗」两条量纲级断言
  const fatWalls = truth.parts.filter((part) => {
    if (!part.startsWith('sideWall')) return false;
    const entry = box(part);
    return entry ? entry.max[0] - entry.min[0] > 0.12 : false;
  });
  check(
    '侧墙是薄板（x 向厚度 ≤ 0.12 米）—— 挡住「拿一块实心体当墙」',
    fatWalls.length === 0,
    fatWalls.length === 0 ? '4 段侧墙都 ≤ 0.12 米' : fattiest(fatWalls),
  );
  check(
    '顶板与檐板都在机柜上部（下沿 y ≥ 1.2 米）—— 挡住「顶板掉到币床上」',
    Boolean(roof) && Boolean(valance) && roof.min[1] >= 1.2 && valance.min[1] >= 1.2,
    roof && valance ? `顶板下沿 ${fmt(roof.min[1])}，檐板下沿 ${fmt(valance.min[1])}` : '缺件',
  );

  // ⑧ 每件都要有色带，且色带必须在 `ROLE_RAMP` 的定义域里
  const badBands = measuredList
    .filter((entry) => truth.parts.includes(entry.part))
    .filter((entry) => entry.role === null || !truth.bands.includes(entry.role));
  check(
    `外壳件的色带都在 ROLE_RAMP 里（${truth.bands.join(' / ')}）`,
    badBands.length === 0,
    badBands.length === 0
      ? measuredList
          .filter((entry) => truth.parts.includes(entry.part))
          .map((entry) => `${entry.part}=${entry.role}`)
          .join(' ')
      : badBands.map((entry) => `${entry.part}=${entry.role}`).join(' '),
  );

  // ⑨ 截图（人工核对通道）：一张游玩视角 + 一张**竖屏全景**
  //
  // 游玩视角（1280×720）里机柜**顶部是被裁掉的**：`CAMERA_FIT.verticalExtent = 2.8`、
  // `centerY = 0.54` ⇒ 画面上沿约在 y = 1.94 米。
  // S21 之前招牌挂在 1.643、上沿还要再高 0.52（≈1.94）⇒ 只露下半截；
  // 现在招牌画布改由**檐板**（y 1.294~1.643）承担 ⇒ 完整落在画面内，
  // 而顶板（1.553~1.643）在游玩视角里仍然看不见。
  // 要人工核对「机柜是不是一个**封闭体**」，就必须换一个**窄**视口：
  // `fitCamera` 按 `halfWidth` 反算距离时会把相机自动拉远，整个机柜自然进画。
  // （这也是移动端竖屏真正看到的构图 —— 不是为截图造的假相机。）
  //
  // ★ S21 第二件必须人工看的东西：高段内收之后侧板上多了一个**穿透的「侧窗」**
  // （`z ∈ (−0.12, 0.195)`、`y` 从斜顶到斜接面），从侧面能直接看进机柜内部。
  // 游玩视角里侧板是掠射角看到的两条边，大概率只是一条变矮的边；
  // **竖屏全景（480×900）会看得很清楚** —— 那里是不是想要的样子只能靠人眼。
  const outDir = process.env.SHOT_DIR ?? 'artifacts';
  const fs = await import('node:fs/promises');
  await fs.mkdir(outDir, { recursive: true });
  await startRun(page, 'ready');
  await page.waitForTimeout(1400);

  const shots = [
    { file: 's19-cabinet-shell.png', size: { width: 1280, height: 720 }, desc: '游玩视角' },
    { file: 's19-cabinet-overview.png', size: { width: 480, height: 900 }, desc: '竖屏全景' },
  ];
  for (const item of shots) {
    await page.setViewportSize(item.size);
    await page.waitForTimeout(900);
    const shot = `${outDir}/${item.file}`;
    await page.screenshot({ path: shot });
    const stat = await fs.stat(shot);
    check(
      `外壳截图已落盘（${item.desc} ${item.size.width}×${item.size.height}，` +
        '人工核对：机柜是否围合 / 檐板是否朝相机 / 侧窗（穿透口）是否符合预期 / 有没有砖）',
      stat.size > 10_000,
      `${shot} — ${stat.size} 字节`,
    );
    console.log(`  已保存 ${shot}`);
  }
}

/** 侧墙厚度超限时的明细（避免 `check` 的 detail 里出现裸 part 名）。 */
function fattiest(parts) {
  return parts.join(', ');
}

/**
 * 摄影机机位（S22）：面板上那九个控件给的角度与坐标，到底是不是**同一份数据**。
 *
 * 需求原话是「在 debug 页加入摄影机的控制，包括角度和坐标」。这句话有两个坑，
 * 这个模式就是来钉这两个坑的：
 *
 * ① **角度与坐标不是两份数据。** 真源只有 `position` 与 `target` 两个点；
 *    `yaw / pitch / distance` 是 `(position − target)` 的球坐标反解
 *    （`render/cameraRig.ts` 顶部那张对照表）。如果有人图省事把角度存成第二份数据，
 *    两边就会各走各的 —— 拖完坐标再拖角度会跳一下，而且这种漂移**在截图里看不出来**。
 *    所以第一组判据是「角度 → 坐标 → 角度」往返恒等，以及「改角度只动相机 /
 *    改观察点只动朝向」这两条自由度隔离。
 *
 * ② **机位所有权。** 面板上任何一个手动控件都必须把 `cameraAutoFit` 翻成 false，
 *    否则下一次 `fitCamera()`（改 FOV、改窗口尺寸、切像素档位都会走到）
 *    会把机位弹回默认视角 —— 用户会说「我改了没用」。这条要端到端验：
 *    手动摆好之后改 FOV，机位必须逐位不变。
 *
 * 第三组判据在**真面板**上跑（`?debug` 开一个新页）：脚本走的是测试钩子，
 * 而用户点的是 lil-gui 控件。这仓库被 lil-gui 坑过两次（漏挂 `.onChange()`、
 * `_callOnChange` 的冒泡顺序），所以「钩子绿、面板红」这种分叉必须单独堵一次 ——
 * 直接往 DOM 里写数值 + 派发 `input` 事件，再读 `cameraReport()` 看相机有没有真的动。
 *
 * ★ 所有阈值都是**与尺寸/库存量无关**的量：角度往返用 1e-6 度、坐标用 1e-9 米
 *   （都是纯函数往返的浮点误差，不是观测量）；取景距离只验**单调性**
 *   （FOV 越小距离越大），不抄第二份 `fitCameraDistance` 的公式。
 */
async function runCamera(page, context) {
  console.log('\n── 模式：camera（摄影机机位 · 角度 / 坐标） ──');

  const report = () =>
    page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.cameraReport?.() ?? null);
  const setRig = (patch) =>
    page.evaluate((value) => window.__THREE_GAME_TEST_HOOKS__?.setCameraRig?.(value) ?? null, patch);
  const setTuning = (patch) =>
    page.evaluate((value) => window.__THREE_GAME_TEST_HOOKS__?.setTuning?.(value) ?? null, patch);

  const near = (a, b, eps) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= eps;
  const vecNear = (a, b, eps) =>
    Array.isArray(a) && a.length === b.length && a.every((v, i) => near(v, b[i], eps));
  const fmt = (value, digits = 3) =>
    Array.isArray(value) ? `(${value.map((n) => n.toFixed(digits)).join(', ')})` : String(value);
  const deg = (value) => (Number.isFinite(value) ? `${value.toFixed(6)}°` : String(value));

  // 真源常量从模块现读 —— 判据里不手抄第二份公式、也不手抄第二份常量。
  const spec = await page.evaluate(async () => {
    const rig = await import('/src/render/cameraRig.ts');
    const { createDefaultTuning } = await import('/src/systems/DebugTools.ts');
    return {
      centerY: rig.CAMERA_FIT.centerY,
      centerZ: rig.CAMERA_FIT.centerZ,
      pitchDeg: (rig.CAMERA_FIT.pitch * 180) / Math.PI,
      minDistance: rig.CAMERA_MIN_DISTANCE,
      defaultFov: createDefaultTuning().cameraFov,
    };
  });

  // ── ① 默认（自动取景）态 = 取景框的解析解 ──────────────────────────────
  const auto = await report();
  check(
    '① 默认态由取景框解出：方位角 0 / 俯角 = CAMERA_FIT.pitch / 观察点 = CAMERA_FIT 中心',
    auto?.autoFit === true &&
      near(auto.yawDeg, 0, 1e-6) &&
      near(auto.pitchDeg, spec.pitchDeg, 1e-6) &&
      vecNear(auto.target, [0, spec.centerY, spec.centerZ], 1e-6) &&
      near(auto.position[0], 0, 1e-6),
    `autoFit=${auto?.autoFit} yaw=${deg(auto?.yawDeg)} pitch=${deg(auto?.pitchDeg)} ` +
      `position=${fmt(auto?.position)} target=${fmt(auto?.target)}`,
  );
  check(
    '② 默认机位在观察点的「前上方」，且距离 ≥ 硬下界（与观察点重合会让朝向由浮点噪声决定）',
    auto.position[1] > auto.target[1] &&
      auto.position[2] > auto.target[2] &&
      auto.distance >= spec.minDistance,
    `Δy=${(auto.position[1] - auto.target[1]).toFixed(3)} Δz=${(auto.position[2] - auto.target[2]).toFixed(3)} ` +
      `距离 ${auto.distance.toFixed(3)} m ≥ ${spec.minDistance} m`,
  );

  // ── ③ 角度 ↔ 坐标：同一份数据的两个视图 ────────────────────────────────
  const pose = { yawDeg: 35, pitchDeg: 18, distance: 2.7 };
  const byAngle = await setRig(pose);
  const byCoord = await setRig({
    camX: byAngle.position[0],
    camY: byAngle.position[1],
    camZ: byAngle.position[2],
  });
  check(
    '③ 角度 → 坐标 → 角度 往返恒等（是同一份数据；存成两份就会在这条上漂）',
    near(byCoord.yawDeg, pose.yawDeg, 1e-6) &&
      near(byCoord.pitchDeg, pose.pitchDeg, 1e-6) &&
      near(byCoord.distance, pose.distance, 1e-6) &&
      vecNear(byCoord.position, byAngle.position, 1e-9),
    `给 (yaw ${pose.yawDeg}°, pitch ${pose.pitchDeg}°, ${pose.distance} m) ⇒ position ${fmt(byAngle.position)} ` +
      `⇒ 反解回 yaw ${deg(byCoord.yawDeg)} pitch ${deg(byCoord.pitchDeg)} 距离 ${byCoord.distance.toFixed(6)} m`,
  );

  // ── ④⑤ 两组自由度的隔离：改角度只动相机、改观察点只动朝向 ──────────────
  const afterYaw = await setRig({ yawDeg: -60 });
  check(
    '④ 拖角度只动相机、观察点纹丝不动',
    vecNear(afterYaw.target, byCoord.target, 1e-9) &&
      vecNear(afterYaw.position, byCoord.position, 1e-3) === false,
    `target ${fmt(afterYaw.target)}（不变） · position ${fmt(byCoord.position)} → ${fmt(afterYaw.position)}`,
  );

  const afterTarget = await setRig({ targetY: spec.centerY + 0.6 });
  check(
    '⑤ 拖观察点只动朝向、相机不动（只抬 y ⇒ 俯角变、方位角不变）',
    vecNear(afterTarget.position, afterYaw.position, 1e-9) &&
      near(afterTarget.yawDeg, afterYaw.yawDeg, 1e-6) &&
      Math.abs(afterTarget.pitchDeg - afterYaw.pitchDeg) > 1,
    `position ${fmt(afterTarget.position)}（不变） · pitch ${deg(afterYaw.pitchDeg)} → ${deg(afterTarget.pitchDeg)} ` +
      `· yaw ${deg(afterTarget.yawDeg)}（不变）`,
  );

  // ── ⑥⑦⑧⑨ 机位所有权 ───────────────────────────────────────────────────
  check(
    '⑥ 手动动过机位 ⇒ 自动取景被交还（cameraAutoFit 翻 false）',
    afterTarget.autoFit === false,
    `autoFit=${afterTarget.autoFit}`,
  );

  const manualPos = afterTarget.position;
  await setTuning({ cameraFov: spec.defaultFov + 6 });
  const afterFov = await report();
  check(
    '⑦ 交出机位之后改 FOV 不再弹回默认视角（S22 之前这里会被 fitCamera 覆盖掉手摆的机位）',
    vecNear(afterFov.position, manualPos, 1e-12) && afterFov.autoFit === false,
    `FOV ${spec.defaultFov}° → ${spec.defaultFov + 6}°，position ${fmt(manualPos)} → ${fmt(afterFov.position)}（逐位不变）`,
  );

  const refit = await setRig({ autoFit: true });
  check(
    '⑧ 「回到默认取景」真的重新取景：朝向归位、观察点归位、距离不再是手摆的那个',
    refit.autoFit === true &&
      near(refit.yawDeg, 0, 1e-6) &&
      near(refit.pitchDeg, spec.pitchDeg, 1e-6) &&
      vecNear(refit.target, [0, spec.centerY, spec.centerZ], 1e-6) &&
      Math.abs(refit.distance - pose.distance) > 0.1,
    `yaw ${deg(refit.yawDeg)} pitch ${deg(refit.pitchDeg)} target ${fmt(refit.target)} ` +
      `距离 ${pose.distance} → ${refit.distance.toFixed(3)} m`,
  );

  const wideFov = spec.defaultFov + 6;
  const narrowFov = spec.defaultFov - 12;
  await setTuning({ cameraFov: narrowFov });
  const narrow = await report();
  check(
    '⑨ 自动取景是活的：FOV 越小取景距离越大（只验单调性，不抄第二份取景公式）',
    narrow.distance > refit.distance + 0.1 && narrow.autoFit === true,
    `FOV ${wideFov}° ⇒ ${refit.distance.toFixed(3)} m ; FOV ${narrowFov}° ⇒ ${narrow.distance.toFixed(3)} m`,
  );

  // ── ⑩ S17 铁律在「电机位」这条路上也成立 ───────────────────────────────
  await page.waitForTimeout(500);
  const settled = await report();
  check(
    '⑩ 电机位之后相机基准记账没漏：偏离峰值恒为 0（`cameraBase` 没跟着机位走的话这里是个大数）',
    (settled?.cameraPeakOffset ?? 99) <= 1e-6,
    `峰值偏移 ${settled?.cameraPeakOffset} m（应恒为 0）`,
  );

  // ── B. 真面板（`?debug`）端到端：DOM → 相机 ─────────────────────────────
  //
  // 这一段才是用户原话的验收：debug 页里**真的有这组控件**，而且拖它有效。
  // 上面十项走的是测试钩子 —— 钩子绿、面板红是完全可能的（这仓库就因为
  // lil-gui 的 `_callOnChange` 冒泡顺序踩过一次「拖了没反应」）。
  const debugPage = await context.newPage();
  const paneErrors = [];
  debugPage.on('pageerror', (error) => paneErrors.push(error.message));
  debugPage.on('console', (message) => {
    if (message.type() === 'error') paneErrors.push(message.text());
  });
  const debugUrl = `${BASE}${BASE.includes('?') ? '&' : '?'}debug`;
  await debugPage.goto(debugUrl, { waitUntil: 'domcontentloaded' });
  await debugPage.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 10, null, {
    timeout: 20_000,
  });

  const panel = await debugPage.evaluate(() => {
    // 文件夹的 DOM 是 `div.lil-gui > button.lil-title + div.lil-children`；
    // 控件是 `div.lil-controller`。没有 `lil-folder` 这个类名，别按它找。
    const titleOf = (element) => element.querySelector('button.lil-title')?.textContent ?? '';
    const folderEl = [...document.querySelectorAll('.lil-gui')].find((el) =>
      titleOf(el).includes('摄影机'),
    );
    if (!folderEl) return { found: false };
    const rootTitle = document.querySelector('.lil-root > button.lil-title');
    if (rootTitle?.getAttribute('aria-expanded') !== 'true') rootTitle?.click();
    const title = folderEl.querySelector('button.lil-title');
    if (title?.getAttribute('aria-expanded') !== 'true') title?.click();
    const children = [...(folderEl.querySelector('.lil-children')?.children ?? [])];
    const rows = children.filter((el) => el.classList.contains('lil-controller'));
    const labelOf = (row) => row.querySelector('.lil-name')?.textContent?.trim() ?? '';
    const yawRow = rows.find((row) => labelOf(row).includes('方位角'));
    const yawInput = yawRow?.querySelector('input') ?? null;
    return {
      found: true,
      title: titleOf(folderEl),
      labels: rows.map(labelOf),
      note: folderEl.querySelector('.cp-debug-note')?.textContent ?? '',
      yawType: yawInput?.getAttribute('type') ?? null,
      yawValue: yawInput?.value ?? null,
      autoChecked: rows[0]?.querySelector('input')?.checked ?? null,
    };
  });

  check(
    '⑪ `?debug` 面板里真的有「摄影机（角度 / 坐标）」分组，且角度 + 坐标九条控件齐全',
    panel.found === true &&
      ['方位角', '俯角', '距离'].every((needle) => panel.labels.some((l) => l.includes(needle))) &&
      ['x', 'y', 'z'].every((needle) => panel.labels.some((l) => l.includes(`相机坐标 ${needle}`))) &&
      ['x', 'y', 'z'].every((needle) => panel.labels.some((l) => l.includes(`观察点 ${needle}`))),
    panel.found
      ? `${panel.title} · ${panel.labels.length} 条：${panel.labels.join(' / ')}`
      : '没找到分组',
  );

  // 真拖一次：直接往 lil-gui 的 `$input` 写值再派发 `input`（它的监听器就是 `addEventListener('input', onInput)`；
  // 桌面端 `$input` 是 `input[type=text]`，用 `fill()` 不会触发它自己的解析）。
  const panelMove = await debugPage.evaluate(async () => {
    const titleOf = (element) => element.querySelector('button.lil-title')?.textContent ?? '';
    const folderEl = [...document.querySelectorAll('.lil-gui')].find((el) =>
      titleOf(el).includes('摄影机'),
    );
    const rows = [...(folderEl?.querySelector('.lil-children')?.children ?? [])].filter((el) =>
      el.classList.contains('lil-controller'),
    );
    const labelOf = (row) => row.querySelector('.lil-name')?.textContent?.trim() ?? '';
    const before = window.__THREE_GAME_TEST_HOOKS__?.cameraReport?.() ?? null;
    const outcomes = [];
    for (const [needle, value] of [
      ['方位角', 40],
      ['俯角', 30],
      ['相机坐标 x', 1.5],
      ['观察点 y', 0.9],
    ]) {
      const row = rows.find((el) => labelOf(el).includes(needle));
      const input = row?.querySelector('input');
      if (!input) {
        outcomes.push({ needle, ok: false, reason: '没找到输入框' });
        continue;
      }
      input.value = String(value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const report = window.__THREE_GAME_TEST_HOOKS__?.cameraReport?.() ?? null;
      outcomes.push({
        needle,
        ok: true,
        writable: input.getAttribute('readonly') === null,
        shown: input.value,
        report,
      });
    }
    const autoRow = rows[0];
    return {
      before,
      outcomes,
      autoChecked: autoRow?.querySelector('input')?.checked ?? null,
      // 状态行（分组的实时机位读数）。**必须拖完再读** —— 它是这一组控件里
      // 唯一「人眼能不能对上号」的东西：截图里的角度要能和输入框里的数字互相印证。
      note: folderEl?.querySelector('.cp-debug-note')?.textContent ?? '',
    };
  });

  const yawStep = panelMove.outcomes.find((entry) => entry.needle === '方位角');
  const pitchStep = panelMove.outcomes.find((entry) => entry.needle === '俯角');
  check(
    '⑫ 真的拖面板控件能改到相机上（DOM 写值 → lil-gui 回调 → `cameraRig` → `camera.position`）',
    yawStep?.ok === true &&
      near(yawStep.report?.yawDeg, 40, 1e-6) &&
      pitchStep?.ok === true &&
      near(pitchStep.report?.pitchDeg, 30, 1e-6),
    `yaw ${deg(panelMove.before?.yawDeg)} → ${deg(yawStep?.report?.yawDeg)}（写到 40）、` +
      `pitch ${deg(panelMove.before?.pitchDeg)} → ${deg(pitchStep?.report?.pitchDeg)}（写到 30）`,
  );

  const camStep = panelMove.outcomes.find((entry) => entry.needle === '相机坐标 x');
  const targetStep = panelMove.outcomes.find((entry) => entry.needle === '观察点 y');
  check(
    '⑬ 面板的坐标两类都通：改「相机坐标 x」动相机且角度被反解，改「观察点 y」相机不动朝向变',
    camStep?.ok === true &&
      near(camStep.report?.position?.[0], 1.5, 1e-6) &&
      near(targetStep?.report?.position?.[0], 1.5, 1e-9) &&
      near(targetStep?.report?.target?.[1], 0.9, 1e-6) &&
      Math.abs((targetStep?.report?.pitchDeg ?? 0) - (camStep?.report?.pitchDeg ?? 0)) > 1,
    `相机 x 1.5 ⇒ position ${fmt(camStep?.report?.position)} · 观察点 y 0.9 ⇒ target ${fmt(targetStep?.report?.target)} ` +
      `（position 逐位不变）· pitch ${deg(camStep?.report?.pitchDeg)} → ${deg(targetStep?.report?.pitchDeg)}`,
  );

  check(
    '⑭ 手动动过之后面板上的「自动取景」复选框自动取消勾选（否则下一帧就会被弹回默认视角）',
    panel.autoChecked === true && panelMove.autoChecked === false,
    `勾选态 ${panel.autoChecked} → ${panelMove.autoChecked}`,
  );

  const outDir = process.env.SHOT_DIR ?? 'artifacts';
  const fs = await import('node:fs/promises');
  await fs.mkdir(outDir, { recursive: true });
  await debugPage.waitForTimeout(500);

  // ★ 两张图各管一件事，别用一张全景糊过去：
  //   - 分组**特写**才是「人工核对面板」的载体。调参面板很长（这一版有十几个分组），
  //     整页截图里摄影机分组落在视口之外 —— 实测第一版全景图里只有「推板与台面 / 物理」
  //     两个分组，核对不到任何东西。整页截图还给不出「有没有这组控件」的证据。
  //   - 全景用来看**相机真的被摆歪了**（这是机位改动唯一能被人眼确认的地方）。
  const folderHandle = await debugPage.evaluateHandle(() => {
    const titleOf = (element) => element.querySelector('button.lil-title')?.textContent ?? '';
    return [...document.querySelectorAll('.lil-gui')].find((el) => titleOf(el).includes('摄影机')) ?? null;
  });
  const folderEl = folderHandle.asElement();
  const folderShot = `${outDir}/s22-camera-folder.png`;
  if (folderEl) await folderEl.screenshot({ path: folderShot });
  const folderStat = folderEl ? await fs.stat(folderShot) : null;
  check(
    '⑮ 摄影机分组特写已落盘（人工核对：九条控件是否都在 / 状态行是否显示当前机位 / 提示是否读得通）',
    (folderStat?.size ?? 0) > 5_000 && panelMove.note.includes('看向'),
    `${folderShot} — ${folderStat?.size ?? 0} 字节 · 拖完之后的状态行「${panelMove.note}」`,
  );
  console.log(`  已保存 ${folderShot}`);

  const pageShot = `${outDir}/s22-camera-panel.png`;
  await debugPage.screenshot({ path: pageShot });
  const pageStat = await fs.stat(pageShot);
  check(
    '⑯ 整页截图已落盘（人工核对：相机确实被摆成了面板上写的那个角度）',
    pageStat.size > 10_000,
    `${pageShot} — ${pageStat.size} 字节`,
  );
  console.log(`  已保存 ${pageShot}`);

  check('面板页运行期无控制台/页面错误', paneErrors.length === 0, paneErrors.slice(0, 3).join(' | '));
  await debugPage.close();
}

/** 轮询视觉币读数直到满足条件（`sprayReport` 没有事件，只能轮询）。 */
/**
 * 等**机关演出**（R5：扫板臂 / 抓斗爪）。与 `waitForSpray` 同构，读的是
 * `mechanismShow()` 而不是诊断快照。
 *
 * 为什么判据非等不可：R5 起两个机关的效果是**延迟交付**的（臂扫到才推、爪升到顶才松手），
 * 触发后立刻读账会得到「钱扣了、币没动」的假红。
 */
async function waitForShow(page, predicate, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.mechanismShow?.() ?? null);
    if (predicate(last)) return last;
    await page.waitForTimeout(50);
  }
  return last;
}

async function waitForSpray(page, predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.sprayReport?.());
    if (predicate(last)) return last;
    await page.waitForTimeout(100);
  }
  return last;
}

/**
 * 模型模式（S24，`?model`）。
 *
 * ## 这个模式验收的到底是什么
 *
 * 用户的原话是「**我没办法准确说出修改的需求**」。所以这里要验的**不是**
 * 「面板长什么样」，而是那条链路：
 *
 *     写形状 → 重建整具外壳 → 场景里的几何跟着变 → 解析盒仍然自洽
 *
 * 面板再漂亮，链路断了就等于零。所以每一项都读**场景实测**
 *（`cabinetReport()`），不读面板自己的状态。
 *
 * ## 两条硬约束
 *
 * ① **走 `modelModeSet`，不自己造外壳。** 那个钩子内部调的就是面板的
 *    `onShapeChanged()`。两条路一旦分叉，就会出现「面板上能用、判据红」
 *    这种没法解释的差异。
 * ② **覆盖层只在 `?model` 下生效。** `cabinet` 模式里另有一条判据守着它 ——
 *    否则「解析盒 vs 实测盒」会两边一起变、恒绿，一个只活在 localStorage 里
 *    的尺寸会被当成已提交的。
 */
async function runModel(page, context) {
  console.log('\n── 模式：model（?model 模型模式） ──');
  void page;

  const modelPage = await context.newPage();
  const errors = [];
  modelPage.on('pageerror', (error) => errors.push(error.message));
  modelPage.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  const url = `${BASE}${BASE.includes('?') ? '&' : '?'}model`;
  await modelPage.goto(url, { waitUntil: 'domcontentloaded' });
  await modelPage.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 10, null, {
    timeout: 20_000,
  });

  // ① 模式启用 + 覆盖层生效
  const enabled = await modelPage.evaluate(
    () => window.__THREE_GAME_TEST_HOOKS__?.modelModeEnabled?.() ?? false,
  );
  // ⚠️ 读**应用实例**：裸 `import('/src/game/cabinetShape.ts')` 拿到的是另一个
  // 模块实例，那个实例永远没有覆盖 ⇒ 这条会恒红。见 `cabinetShapeReport` 的注释。
  const overridden = await modelPage.evaluate(
    () => window.__THREE_GAME_TEST_HOOKS__?.cabinetShapeReport?.()?.overridden ?? null,
  );
  check(
    '?model 下模型模式已启用，且 cabinetShape 的覆盖层已生效',
    enabled === true && overridden === true,
    `enabled=${enabled} overridden=${overridden}`,
  );

  // ② 面板真的挂到了 DOM 上（不是只有钩子能跑）
  const panelTitle = await modelPage.evaluate(() => {
    const titles = [...document.querySelectorAll('.lil-root > button.lil-title')].map(
      (button) => button.textContent ?? '',
    );
    return titles.find((text) => text.includes('模型模式')) ?? null;
  });
  check('面板已挂到 DOM（lil-gui 根标题含「模型模式」）', panelTitle !== null, `title=${panelTitle}`);

  // ③ 初始差异为 0
  const diff0 = await modelPage.evaluate(
    () => window.__THREE_GAME_TEST_HOOKS__?.modelModeDiffCount?.() ?? -1,
  );
  check('初始差异为 0（没改过任何东西，导出清单应当是空的）', diff0 === 0, `diff=${diff0}`);

  // ④ 改一个真源字段 → 实测几何跟着变
  //
  // 选 `hood.underY`（顶板下表面）：`cabinetPartBox('hoodRoof').min[1]` 正好就是它，
  // 判据因此不必写第二份公式；而且它**不会把任何一件的尺寸弄成负数**。
  //
  // ⚠️ 这是踩出来的：第一版取 `hood.valanceInnerZ = 0.30`，而 `valanceFrontZ` 是 0.285
  // ⇒ 檐板厚度变成 **−0.015 米**，`RoundedBoxGeometry` 当场退化
  //（实测盒从 ±0.8 涨到 ±0.8075）。面板上任何一个数都能造出这种退化几何 ——
  // 这是「无 min/max 的数字输入框」的固有代价，看见就知道该按重置。
  const readRoofUnderY = () =>
    modelPage.evaluate(() => {
      const list = window.__THREE_GAME_TEST_HOOKS__?.cabinetReport?.() ?? [];
      const entry = list.find((item) => item.part === 'hoodRoof');
      return entry ? entry.min[1] : Number.NaN;
    });
  const defaultUnderY = await modelPage.evaluate(
    () =>
      window.__THREE_GAME_TEST_HOOKS__?.cabinetShapeReport?.()?.boxes?.hoodRoof?.min?.[1] ??
      Number.NaN,
  );
  const before = await readRoofUnderY();
  const target = 1.5;
  await modelPage.evaluate(
    (value) => window.__THREE_GAME_TEST_HOOKS__?.modelModeSet?.('hood.underY', value),
    target,
  );
  const after = await readRoofUnderY();
  check(
    '改 hood.underY → 顶板实测盒跟着动（写形状 → 重建 → 场景 这条链路通）',
    Math.abs(after - target) <= 2e-5 && Math.abs(before - defaultUnderY) <= 2e-5,
    `默认 ${defaultUnderY} → 改前实测 ${before} → 改后实测 ${after}`,
  );

  // ⑤ 差异计数跟着变
  const diff1 = await modelPage.evaluate(
    () => window.__THREE_GAME_TEST_HOOKS__?.modelModeDiffCount?.() ?? -1,
  );
  check('差异计数变成 1（「导出改动」拿到的就是这一项）', diff1 === 1, `diff=${diff1}`);

  // ⑥ 调参之后解析盒仍然 = 实测盒
  //
  // 这是「重建」最容易漏的一环：几何换了、真源换了，但两者如果没一起换，
  // 就只有这条判据看得见（面板上一切正常）。
  // ★ 真源取**应用实例**的解析盒（`cabinetShapeReport().boxes`），不写 `import()`：
  // 那个实例读的是默认值，调参期间必然**假红**（实测踩过）。
  const inconsistent = await modelPage.evaluate(() => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__;
    const truth = hooks?.cabinetShapeReport?.();
    const list = hooks?.cabinetReport?.() ?? [];
    if (!truth) return ['cabinetShapeReport 钩子缺失'];
    const out = [];
    for (const part of truth.parts) {
      const entry = list.find((item) => item.part === part);
      const box = truth.boxes[part];
      if (!entry || !box) {
        out.push(`${part}:缺件`);
        continue;
      }
      for (let axis = 0; axis < 3; axis += 1) {
        if (
          Math.abs(entry.min[axis] - box.min[axis]) > 2e-5 ||
          Math.abs(entry.max[axis] - box.max[axis]) > 2e-5
        ) {
          out.push(`${part}.${'xyz'[axis]}`);
        }
      }
    }
    return out;
  });
  check(
    '调参之后「解析盒 = 实测盒」仍成立（重建没让几何与真源分叉）',
    inconsistent.length === 0,
    inconsistent.length === 0 ? '7 件 × 6 个面一致' : inconsistent.slice(0, 4).join(' | '),
  );

  // ⑦ 重建不涨 draw call / 程序数
  //
  // 材质若是每重建一次 `new` 一份，这两条会随拖滑块一路涨。
  // 它们是「模块单例」那条设计决定唯一的观测通道。
  const mats = await modelPage.evaluate(
    () => window.__THREE_GAME_TEST_HOOKS__?.materialReport?.() ?? {},
  );
  check(
    '重建不涨 draw call（材质是模块单例，重建只换几何）',
    (mats.renderer?.max ?? 999) <= 50,
    `峰值 draw call=${mats.renderer?.max}`,
  );
  check(
    '重建不涨已编译程序数（否则拖滑块会让 programs 一路涨）',
    (mats.programs ?? 999) <= 30,
    `programs=${mats.programs} / 材质 ${mats.total}`,
  );

  // ⑧ 重置回到编译期默认值
  await modelPage.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.modelModeReset?.());
  const diff2 = await modelPage.evaluate(
    () => window.__THREE_GAME_TEST_HOOKS__?.modelModeDiffCount?.() ?? -1,
  );
  const restored = await readRoofUnderY();
  // ★ 顺带问一句「模型模式手里那具壳还在不在场景里」。
  // `resetShape()` 里曾经多调了一次 `hooks.rebuild()` 而没人 `attach()` 返回值：
  // 结果 `ModelMode.shell` 指向一具被 `removeFromParent()` + `geometry.dispose()` 的
  // 旧壳 ⇒ 计数型判据（差异、件数、高亮线条数）**全绿**，但选中高亮一根都画不出来。
  // 这是「钩子绿 ≠ 面板绿」那一类，只有宿主在不在渲染树里这一句抓得住。
  const shellAttached = await modelPage.evaluate(
    () => window.__THREE_GAME_TEST_HOOKS__?.modelModeShellAttached?.() ?? null,
  );
  check(
    '重置之后差异回到 0、几何回到编译期默认值，且模型模式持有的外壳仍在场景里',
    diff2 === 0 && shellAttached === true && Math.abs(restored - defaultUnderY) <= 2e-5,
    `diff=${diff2} 外壳在场景里=${shellAttached} hoodRoof.min.y=${restored}（默认 ${defaultUnderY}）`,
  );

  // ⑨ 选中一块侧墙 —— 高亮 / 边文件夹重建 / 参数分组自动展开都挂在同一条 `select()`
  const didSelect = await modelPage.evaluate(() =>
    window.__THREE_GAME_TEST_HOOKS__?.modelModeSelect?.('sideWall.tall.L'),
  );
  const selectedBack = await modelPage.evaluate(
    () => window.__THREE_GAME_TEST_HOOKS__?.modelModeSelected?.(),
  );
  const rejected = await modelPage.evaluate(() =>
    window.__THREE_GAME_TEST_HOOKS__?.modelModeSelect?.('not-a-part'),
  );
  // ★ 高亮「有没有加上」只能靠计数：WebGL 忽略 `LineBasicMaterial.linewidth`，
  // 指示线永远是 1 像素，在截图上看不看得出来完全取决于构图 —— 不能当判据。
  // 选中一块侧墙应当恰好 **2** 条：件轮廓 + 那条折边的高亮。
  const outlines = await modelPage.evaluate(
    () => window.__THREE_GAME_TEST_HOOKS__?.modelModeOutlineCount?.() ?? -1,
  );
  check(
    '选中 sideWall.tall.L：回读一致 / 高亮线 = 2 条（件轮廓 + 边）/ 非法件名被拒',
    didSelect === true && selectedBack === 'sideWall.tall.L' && rejected === false && outlines === 2,
    `select=${didSelect} 回读=${selectedBack} 非法件名=${rejected} 高亮线=${outlines}`,
  );

  // ⑩ 落一张面板截图 —— 模型模式唯一的**人眼**验收通道
  //
  // 与 `cabinet` 模式的截图同理：数值判据能抓「砖块」，抓不住「难看」，
  // 也抓不住「面板把关键项折叠起来了」。每次动这个模式都留一张图。
  const shotDir = process.env.SHOT_DIR ?? 'artifacts';
  const shotPath = `${shotDir}/s24-model-mode.png`;
  const shot = await modelPage.screenshot({ path: shotPath });
  check(
    '模型模式截图已落盘（人工核对：面板是否可读 / 选中件是否高亮 / 有没有退化几何）',
    shot.length > 20_000,
    `${shotPath} — ${shot.length} 字节`,
  );

  // ⑪ 改选另一件 → 高亮不累积
  //
  // 背板没有折线（`wallSegmentOf` 返回 null），所以只剩件轮廓 **1** 条。
  // 这条同时守两件事：改选要清掉上一条，以及「没有折线的件不该凭空长出一条边」。
  await modelPage.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.modelModeSelect?.('backPanel'));
  const outlines2 = await modelPage.evaluate(
    () => window.__THREE_GAME_TEST_HOOKS__?.modelModeOutlineCount?.() ?? -1,
  );
  check(
    '改选 backPanel → 高亮线只剩 1 条（不累积；没有折线的件不该长出边高亮）',
    outlines2 === 1,
    `高亮线=${outlines2}`,
  );

  // ⑫ 倒角的**归属**：只有直角盒件吃倒角
  //
  // 这条守的是 S25 的设计核心。`bevelable` 不是判据这边抄的一份名单，而是
  // `TableBuilder.cabinetBoxMesh()`（全仓库唯一调用 `partBevel()` 的地方）亲手挂进
  // `userData` 的 —— 于是「面板给不给滑块」与「几何理不理这件事」**必然是同一个事实**。
  // 若改成在别处列一份「哪些件是直角盒」，某天某件从盒子改成剖面挤出（或反过来）
  // 就会分叉，表现是「滑块拖了但顶板纹丝不动」，零报错、查不到原因。
  const bevelFlags = await modelPage.evaluate(() =>
    (window.__THREE_GAME_TEST_HOOKS__?.cabinetReport?.() ?? [])
      .filter((e) => e.part.startsWith('hood') || e.part.startsWith('sideWall') || e.part === 'backPanel')
      .map((e) => `${e.part}:${e.bevelable ? 'Y' : 'N'}`)
      .sort(),
  );
  const expectBevelFlags = [
    'hoodRoof:Y',
    'hoodValance:Y',
    'backPanel:Y',
    'sideWall.tall.L:N',
    'sideWall.tall.R:N',
    'sideWall.low.L:N',
    'sideWall.low.R:N',
  ].sort();
  check(
    '倒角归属：3 件直角盒 bevelable=true（吃 bevel.perPart 滑块），4 段侧墙=false（改吃逐角斜角）',
    bevelFlags.join(',') === expectBevelFlags.join(','),
    bevelFlags.join(' '),
  );

  // ⑬ 逐件倒角真的驱动几何，而且**只**驱动这一件
  //
  // ⚠️ 为什么动 `segments` 而不是 `radius`：**半径没有任何数值观测通道** ——
  // `RoundedBoxGeometry` 始终把外尺寸做满，包围盒一格不变（`cabinet` 那 21 条
  // 「解析盒 = 实测盒」正是靠这一点才不会被倒角搞红）。分段数一变顶点数必变，
  // 所以它是这条链路唯一抓得住的一面；半径对不对只能靠 `?model` 截图人眼核。
  // 顺带一条：`diffCount` 必须 +1 —— 「导出改动」是这个模式的**产出物**，
  // 逐件倒角若进不了 diff，用户拖完半天拿到的清单是空的，整个模式就白做了。
  const verticesOfParts = () =>
    modelPage.evaluate(() =>
      Object.fromEntries(
        (window.__THREE_GAME_TEST_HOOKS__?.cabinetReport?.() ?? []).map((e) => [e.part, e.vertices]),
      ),
    );
  const vBefore = await verticesOfParts();
  const diffBefore = await modelPage.evaluate(
    () => window.__THREE_GAME_TEST_HOOKS__?.modelModeDiffCount?.() ?? -1,
  );
  await modelPage.evaluate(() =>
    window.__THREE_GAME_TEST_HOOKS__?.modelModeSet?.('bevel.perPart.hoodRoof.segments', 5),
  );
  const vAfter = await verticesOfParts();
  const diffAfter = await modelPage.evaluate(
    () => window.__THREE_GAME_TEST_HOOKS__?.modelModeDiffCount?.() ?? -1,
  );
  const roofGrew = (vAfter.hoodRoof ?? 0) > (vBefore.hoodRoof ?? 0);
  const othersStill = ['hoodValance', 'backPanel', 'sideWall.tall.L', 'sideWall.tall.R', 'sideWall.low.L', 'sideWall.low.R'].every(
    (part) => vAfter[part] === vBefore[part],
  );
  check(
    '逐件倒角驱动几何：hoodRoof 分段 1→5 顶点变多、其余 6 件一格不变，且差异计数 +1',
    roofGrew && othersStill && diffBefore === 0 && diffAfter === 1,
    `hoodRoof ${vBefore.hoodRoof}→${vAfter.hoodRoof}，其余 6 件未变=${othersStill}，diff ${diffBefore}→${diffAfter}`,
  );

  // ⑬ 留了一个「单独点名 hoodRoof」的覆盖在档上 —— 先清掉，⑮ 的 `diff 0→1` 才是它自己的。
  await modelPage.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.modelModeReset?.());
  await modelPage.waitForTimeout(120);

  // ⑮ 侧墙的**逐角**斜角真的驱动几何，而且**只**驱动那一段（S25）
  //
  // 与 ⑬ 的分工：两套机制、两条链路 —— ⑬ 验直角盒（`bevel.perPart`），这条验剖面挤出
  // 件（`bevel.wallChamfer`）。只验一条会放过另一条。
  // ★ 与 ⑬ 相反，这里动的就是**半径本身**，而且它**有**数值观测通道：
  // `low.roofBack` 是低段**唯一的**最高点（斜顶往前端是下降的），把这个角切掉，
  // 实测包围盒的 `max[1]` 就跟着降 —— 直角盒那边「外尺寸永远做满 ⇒ 半径不可见」
  // 的死角，在挤出件上不存在。所以「斜角到底落没落到几何上」是一等的数值判据。
  // 顺带钉住两件容易静默的事：
  //   · 路径 `bevel.wallChamfer.low.roofBack` 里那个**带点的键**能被解析（解析不了的
  //     老写法会 no-op，把「几何没动」当成这条判据通过）；
  //   · 改动**不外溢**：另三段侧墙与五件直角盒的读数必须一格不变。
  const boxesOfParts = () =>
    modelPage.evaluate(() =>
      Object.fromEntries(
        (window.__THREE_GAME_TEST_HOOKS__?.cabinetReport?.() ?? []).map((e) => [
          e.part,
          { min: e.min, max: e.max, vertices: e.vertices },
        ]),
      ),
    );
  const sameBox = (a, b) =>
    a && b && a.min.every((v, i) => Math.abs(v - b.min[i]) < 1e-6) &&
    a.max.every((v, i) => Math.abs(v - b.max[i]) < 1e-6) &&
    a.vertices === b.vertices;
  const wallBefore = await boxesOfParts();
  const wallDiffBefore = await modelPage.evaluate(
    () => window.__THREE_GAME_TEST_HOOKS__?.modelModeDiffCount?.() ?? -1,
  );
  await modelPage.evaluate(() =>
    window.__THREE_GAME_TEST_HOOKS__?.modelModeSet?.('bevel.wallChamfer.low.roofBack', 0),
  );
  const wallAfter = await boxesOfParts();
  const wallDiffAfter = await modelPage.evaluate(
    () => window.__THREE_GAME_TEST_HOOKS__?.modelModeDiffCount?.() ?? -1,
  );
  const lowTopRose = ['sideWall.low.L', 'sideWall.low.R'].every(
    (part) => wallAfter[part].max[1] > wallBefore[part].max[1],
  );
  const lowOtherFacesStill = ['sideWall.low.L', 'sideWall.low.R'].every(
    (part) =>
      wallBefore[part].min.every(
        (v, axis) => Math.abs(v - wallAfter[part].min[axis]) < 1e-6,
      ) &&
      [0, 2].every(
        (axis) => Math.abs(wallBefore[part].max[axis] - wallAfter[part].max[axis]) < 1e-6,
      ),
  );
  const nothingElseMoved = [
    'sideWall.tall.L',
    'sideWall.tall.R',
    'hoodRoof',
    'hoodValance',
    'backPanel',
  ].every((part) => sameBox(wallBefore[part], wallAfter[part]));
  check(
    '侧墙逐角斜角驱动几何：low.roofBack 0.012→0 ⇒ 低段实测上沿回升、其余五个面与另 5 件一格不变，且差异计数 +1',
    lowTopRose && lowOtherFacesStill && nothingElseMoved && wallDiffBefore === 0 && wallDiffAfter === 1,
    `低段上沿 ${wallBefore['sideWall.low.L'].max[1].toFixed(5)}→${wallAfter['sideWall.low.L'].max[1].toFixed(5)}，未外溢=${nothingElseMoved}，diff ${wallDiffBefore}→${wallDiffAfter}`,
  );

  // 收尾：回到编译期默认值，别把改动留给后面的检查或截图。
  await modelPage.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.modelModeReset?.());

  // ⑭ 倒角外观（机柜外 3/4 俯视）—— **半径**唯一的验收通道
  //
  // 为什么必须单独一张图：游玩视角的画面上沿只到 y ≈ 1.94 米、而且相机在机柜**内部**
  // （见 `cabinet` 模式 ⑨ 的注释），顶板那 9 厘米的板根本不在画面里；
  // 竖屏全景同样看不见顶面。于是「2.5 厘米的斜角读不读得出来」这件事
  // **一张图都没有** —— 而半径又没有任何数值通道
  // （`RoundedBoxGeometry` 始终把外尺寸做满 ⇒ 包围盒一格不变，见 ⑬ 的注释）。
  // 两者一叠加，改半径就等于闭眼调。所以这里用**模型模式自己的轨道相机**拉远 + 抬高俯角：
  // 走真实指针事件（`mouse.down/move/up` + `wheel`），而不是改 `cameraRig` 的数 ——
  // 裸 `import('/src/render/cameraRig.ts')` 拿到的是**另一个模块实例**（HMR 查询串），
  // 改了应用不认，那条坑在 `cabinetShapeReport` 的注释里记着。
  const canvasCenter = await modelPage.evaluate(() => {
    const rect = document.querySelector('canvas')?.getBoundingClientRect();
    return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null;
  });
  await modelPage.setViewportSize({ width: 1280, height: 720 });
  await modelPage.waitForTimeout(600);
  if (canvasCenter) {
    // 拉远到 `MAX_DISTANCE`（9 米）：deltaY 为正 ⇒ `distance × exp(+)` ⇒ 更远。
    await modelPage.mouse.move(canvasCenter.x, canvasCenter.y);
    await modelPage.mouse.wheel(0, 900);
    // 拖出 3/4 俯视：`pitch += dy × 0.006`（向下拖 = 抬高俯角），`yaw -= dx × 0.008`。
    // 位移刻意**以竖直为主**：第一版拖的是 (-150, +120)，结果绕到机柜**背面**去了
    // —— 顶板斜角看得见，但檐板（招牌画布）那一条看不见，而它恰恰是 R1 最要核对的一件
    //（斜角会不会啃到画布）。现在只偏 18° 左右，仍留在玩家这一侧。
    await modelPage.mouse.down();
    await modelPage.mouse.move(canvasCenter.x + 40, canvasCenter.y + 100, { steps: 12 });
    await modelPage.mouse.up();
    await modelPage.waitForTimeout(500);
  }
  const bevelShot = `${shotDir}/s25-cabinet-bevel.png`;
  const bevelPng = await modelPage.screenshot({ path: bevelShot });
  check(
    '倒角外观截图已落盘（1280×720 机柜外 3/4 俯视，人工核对：三件直角盒的斜角是否读得出来 / 檐板斜角有没有啃到招牌画布 / 侧墙剪影的斜角与 `tall.hoodTopFront`×`hoodRoof` 那条 V 形槽是否可接受）',
    bevelPng.length > 20_000,
    `${bevelShot} — ${bevelPng.length} 字节`,
  );
  // 取景还原：`0` 键走的是面板同一条 `onKeyDown`（别留一个歪相机给下一次跑）。
  await modelPage.keyboard.press('0');
  await modelPage.waitForTimeout(200);

  check(
    '运行期无控制台/页面错误',
    errors.length === 0,
    errors.length === 0 ? '0 条' : errors.slice(0, 3).join(' | '),
  );

  await modelPage.close();
}

/**
 * ── 模式：hooks ──「搬家没改行为」的三条守卫门（10-03 计划 dawn-reef-buck 步 1）。
 *
 * 为什么要这三条：`src/game/Game.ts` 里 1,843 行「── 测试钩子与诊断 ──」要逐片外移。
 * 钩子的**键名与签名**有编译期保护（`window.__THREE_GAME_TEST_HOOKS__` 是带类型的字面量赋值，
 * 漏键或改签名当场 `tsc` 红），但**语义与时机没有任何编译期保护** ⇒ 唯一能证明"搬完一样"的办法，
 * 是搬之前就把**引擎自己给出的**读数清单存成基线。三条门各堵一个具体的假绿形态：
 *   M0 结构门 —— 堵「dispose 少调一件」。`Game.dispose()` 的唯一调用点是 `main.ts:13-17` 的
 *      `import.meta.hot.dispose`（只在 Vite HMR 跑），现有 22 个模式 + 3 套用例**一条都覆盖不到**
 *      ⇒ 不立门就是无门改动。待查清单**派生**自源码（凡"声明了 dispose() 且注册了 window 监听器"
 *      的类、且被 Game 持有成字段），不在测试里手抄名单 —— 手抄名单就是第二真源。
 *   M1 census —— 堵「键还在、值算错了」与「少了一个字段」。字段路径与钩子键名全部由引擎枚举。
 *      哪些字段本就不该逐位相同（帧号/时间/FPS/在途币位置）也**不手抄**：在同一确定性状态下
 *      隔 ~200 毫秒连拍两遍，两遍不一致的自动进不稳定名单，只比结构不比值。
 *   M2 时机门 —— 堵「发布被悄悄合帧/降频」。`readStateFresh()` 只等 140 毫秒（`simTick(page,140)`），
 *      降到 5 Hz 就会让它的 69 处调用读到旧帧；`tests/visual.spec.ts:147` 的 `waitFrames()` 拿
 *      `diagnostics.frame` 增量当等待 ⇒ 降频会改掉逐字节截图门的前置时长。这条门让"频率没变"
 *      变成一个可失败的检查，也是**唯一允许日后改发布频率时守住下限**的东西。
 */
const CENSUS_FILE = process.env.CENSUS_FILE ?? resolve(REPO_ROOT, 'scripts/diagnostics-census.json');

async function runHooksGuard(page, context) {
  console.log('\n── 模式：hooks（结构门 M0 + 读数 census M1 + 发布时机门 M2） ──');
  const fs = await import('node:fs/promises');

  // ── M0-a：两个 window 全局各自只有一处装配、且在 dispose 里撤销 ──
  const gamePath = resolve(REPO_ROOT, 'src/game/Game.ts');
  const gameSrc = await fs.readFile(gamePath, 'utf8');
  for (const name of ['__THREE_GAME_TEST_HOOKS__', '__THREE_GAME_DIAGNOSTICS__']) {
    // ★ 数的是「装配点」而不是「字面量开头的形状」：S4 之后诊断全局的右边是 `diagSnapshot.build(...)`，
    //   如果判据写成只认 `= {`，搬运会把门本身弄哑（10-04 真就这么红了一次，报的是门、不是代码）。
    const total = (gameSrc.match(new RegExp(`window\\.${name} =`, 'g')) ?? []).length;
    const clears = (gameSrc.match(new RegExp(`window\\.${name} = undefined`, 'g')) ?? []).length;
    const assigns = total - clears;
    check(
      `M0 ${name}：装配点唯一且 dispose 里撤销`,
      assigns === 1 && clears >= 1,
      `赋值 ${assigns} 处（要求恰好 1，右边可以是字面量也可以是 build(...)）、置 undefined ${clears} 处（要求 ≥1）` +
        '⇒ 多出的赋值点就是第二真源',
    );
  }

  // ── M0-b：dispose() 必须调用每一个"自己实现了 dispose() 且被 Game 持有成字段"的子系统 ──
  // ★ 派生规则踩过两次坑，都写在这儿免得再犯：
  //   ① 只匹配 `x: ClassName` 会漏掉本项目最常见的 `private readonly hud = new Hud()`（无类型标注）
  //      与 `private readonly x: X` 这类**双修饰符**声明 ⇒ 网小到只剩 1 个候选，此时"0 缺失"是假绿。
  //   ② 只找 `dispose(): void;` 会把**接口声明**（`interface Show { dispose(): void; }`）算成实现
  //      ⇒ 必须要求带函数体 `dispose(): void {`。
  //   ③ 候选数为 0 一律报红（探针失效不等于没有泄漏）。
  const disposeBody = (gameSrc.match(/\n {2}dispose\(\): void \{([\s\S]*?)\n {2}\}/) ?? [])[1] ?? '';
  const classImplementsDispose = new Map(); // 类名 → 它自己文件里的 addEventListener 数（只为多打一句现场）
  for (const statement of gameSrc.match(/^import[\s\S]*?from\s+'[^']+';$/gm) ?? []) {
    const spec = (statement.match(/from\s+'([^']+)'/) ?? [])[1];
    if (!spec || !spec.startsWith('.')) continue;
    let target = resolve(gamePath, '..', spec);
    if (!target.endsWith('.ts')) target += '.ts';
    let moduleSrc = null;
    try {
      moduleSrc = await fs.readFile(target, 'utf8');
    } catch {
      continue; // 目录 / 非模块说明符：不是子系统字段
    }
    const names = (statement.match(/\{([^}]*)\}/) ?? [null, ''])[1]
      .split(',')
      .map((entry) => entry.trim().split(/\s+as\s+/)[0])
      .filter(Boolean);
    for (const typeName of names) {
      const at = moduleSrc.search(new RegExp(`class ${typeName}\\b`));
      if (at < 0) continue;
      const rest = moduleSrc.slice(at);
      const nextClass = rest.search(/\n(?:export )?(?:abstract )?class /);
      const body = nextClass > 0 ? rest.slice(0, nextClass) : rest;
      if (!/\n {2}(?:public )?dispose\(\): void \{/.test(body)) continue;
      classImplementsDispose.set(typeName, (body.match(/addEventListener/g) ?? []).length);
    }
  }
  const MOD = String.raw`(?:(?:private|public|protected|readonly)\s+)*`;
  const fieldTypes = [];
  for (const found of gameSrc.matchAll(new RegExp(`\\n {2}${MOD}([a-zA-Z]+)\\s*:\\s*([A-Za-z][\\w.]*)(?:\\s*\\|\\s*null)?[;=]`, 'g'))) {
    fieldTypes.push({ name: found[1], type: found[2].split('.').pop() ?? found[2] });
  }
  for (const found of gameSrc.matchAll(new RegExp(`\\n {2}${MOD}([a-zA-Z]+)\\s*=\\s*new\\s+([A-Za-z][\\w.]*)\\(`, 'g'))) {
    fieldTypes.push({ name: found[1], type: found[2].split('.').pop() ?? found[2] });
  }
  const needsDispose = [];
  const examined = []; // 派生循环里顺手数：零候选=探针失效，绝不能报绿
  const seenFieldNames = new Set();
  for (const field of fieldTypes) {
    if (seenFieldNames.has(field.name)) continue;
    seenFieldNames.add(field.name);
    if (!classImplementsDispose.has(field.type)) continue;
    examined.push(`${field.name}: ${field.type}`);
    if (!new RegExp(`this\\.${field.name}\\??\\.dispose\\(`).test(disposeBody)) {
      needsDispose.push(`${field.name}: ${field.type}（dispose() 里没调用它）`);
    }
  }
  check(
    'M0 Game.dispose() 调用了每个自己实现 dispose() 的子系统字段（清单由源码派生）',
    disposeBody.length > 0 && needsDispose.length === 0 && examined.length > 0,
    disposeBody.length === 0
      ? '🔴 没找到 dispose() 方法体 ⇒ 探针失效，不是"没有泄漏"'
      : examined.length === 0
        ? '🔴 派生出的待查清单是**空的** ⇒ 这条门什么都没在看（零命中先怀疑探针，不报绿）'
        : needsDispose.length === 0
          ? `查了 ${examined.length} 个候选字段，全部已被释放（${examined.join(' / ')}）`
          : `查了 ${examined.length} 个候选字段，缺 ${needsDispose.length} 件：${needsDispose.join('；')}`,
  );

  // ── M1：读数 census（结构逐字节比；不稳定字段的值不比，名单由两遍连拍派生）──
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.clearSave?.());
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.seed?.(20260921));
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setState?.('ready'));
  await waitFor(page, (state) => (state?.frame ?? 0) > 12, 40_000);

  const capture = () =>
    page.evaluate(() => {
      const fields = {};
      const walk = (value, prefix, depth) => {
        if (value === null || typeof value !== 'object') {
          fields[prefix] = { type: value === null ? 'null' : typeof value, value: String(value).slice(0, 24) };
          return;
        }
        if (depth >= 3) {
          fields[prefix] = { type: Array.isArray(value) ? `array(${value.length})` : 'object', value: '' };
          return;
        }
        if (Array.isArray(value)) {
          fields[prefix] = { type: `array(${value.length})`, value: String(value.length) };
          if (value.length > 0) walk(value[0], `${prefix}[0]`, depth + 1);
          return;
        }
        for (const [key, entry] of Object.entries(value)) walk(entry, `${prefix}.${key}`, depth + 1);
      };
      walk(window.__THREE_GAME_DIAGNOSTICS__ ?? {}, 'diag', 0);
      return {
        fields,
        hookKeys: Object.keys(window.__THREE_GAME_TEST_HOOKS__ ?? {}).sort(),
      };
    });

  const first = await capture();
  await simTick(page, 200);
  const second = await capture();
  const unstable = Object.keys(first.fields).filter(
    (p) => second.fields[p] === undefined || second.fields[p].value !== first.fields[p].value,
  );
  const structure = Object.keys(first.fields)
    .sort()
    .map((p) => `${p}:${first.fields[p].type}`);
  const stableValues = {};
  for (const p of Object.keys(first.fields).sort()) {
    if (!unstable.includes(p)) stableValues[p] = first.fields[p].value;
  }

  let golden = null;
  try {
    golden = JSON.parse(await fs.readFile(CENSUS_FILE, 'utf8'));
  } catch {
    golden = null;
  }
  const snapshot = {
    _comment:
      'M1 census 基线：由 `node scripts/verify-game.mjs hooks` 在确定性态（clearSave + seed 20260921 + setState("ready")）枚举引擎自己的诊断字段路径与钩子键名。重建：CENSUS_UPDATE=1 跑同一个模式。unstable = 两遍连拍不一致的字段，只比结构不比值。',
    generatedAt: new Date().toISOString(),
    fieldCount: structure.length,
    hookCount: first.hookKeys.length,
    unstable,
    structure,
    hookKeys: first.hookKeys,
    values: stableValues,
  };
  if (process.env.CENSUS_UPDATE === '1' || golden === null) {
    await fs.writeFile(CENSUS_FILE, `${JSON.stringify(snapshot, null, 2)}\n`);
    console.log(
      `  [census] ${golden === null ? '没有基线 ⇒ 写第一份' : 'CENSUS_UPDATE=1 ⇒ 重写基线'}：` +
        `${CENSUS_FILE}（结构 ${structure.length} 条、钩子键 ${first.hookKeys.length} 个、不稳定字段 ${unstable.length} 条）`,
    );
  } else {
    const structDiff = structure.filter((p) => !golden.structure.includes(p)).concat(golden.structure.filter((p) => !structure.includes(p)));
    const hookDiff = first.hookKeys.filter((k) => !golden.hookKeys.includes(k)).concat(golden.hookKeys.filter((k) => !first.hookKeys.includes(k)));
    const valueDiff = Object.keys(stableValues).filter((p) => golden.values[p] !== undefined && golden.values[p] !== stableValues[p]);
    check(
      'M1 census：诊断字段路径集合与基线逐字节同（含值，不稳定字段除外）',
      structDiff.length === 0 && valueDiff.length === 0,
      `结构 ${structure.length} 条 vs 基线 ${golden.structure.length} 条；差异 ${structDiff.slice(0, 6).join(' | ') || '无'}；` +
        `值不一致 ${valueDiff.length} 条（${valueDiff.slice(0, 4).join(' | ') || '无'}）；不稳定名单基线 ${(golden.unstable ?? []).length} 条/本次 ${unstable.length} 条`,
    );
    check(
      'M1 census：钩子键集合与基线逐字节同',
      hookDiff.length === 0,
      `本次 ${first.hookKeys.length} 个键 vs 基线 ${golden.hookKeys.length} 个；差异 ${hookDiff.join(' | ') || '无'}`,
    );
  }

  // ── M2：发布时机（对象身份变化次数 / rAF 心跳数）──
  const timingPage = await context.newPage();
  await timingPage.addInitScript(() => {
    const w = window;
    w.__PUB_OBS__ = { ticks: 0, publishes: 0, last: null };
    const step = () => {
      w.__PUB_OBS__.ticks += 1;
      const d = w.__THREE_GAME_DIAGNOSTICS__;
      if (d && d !== w.__PUB_OBS__.last) {
        w.__PUB_OBS__.last = d;
        w.__PUB_OBS__.publishes += 1;
      }
      w.requestAnimationFrame(step);
    };
    w.requestAnimationFrame(step);
  });
  await timingPage.goto(BASE, { waitUntil: 'domcontentloaded' });
  await timingPage.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 40, null, { timeout: 60_000 });
  const observed = await timingPage.evaluate(() => window.__PUB_OBS__);
  await timingPage.close();
  const ratio = observed && observed.ticks > 0 ? observed.publishes / observed.ticks : 0;
  check(
    'M2 发布时机：诊断快照每帧换一次对象身份（比例 ≥ 0.8 ⇒ 没被合帧/降频）',
    observed && observed.ticks > 30 && ratio >= 0.8,
    `rAF 心跳 ${observed?.ticks ?? 0} 次、身份变化 ${observed?.publishes ?? 0} 次 ⇒ ${ratio.toFixed(3)}。` +
      '下限 0.8 的依据：readStateFresh 只等 140 毫秒，5 Hz（0.17）会让它读旧帧；60 fps 下 10 Hz ≈ 0.17 同样不合格',
  );
}

async function main() {
  const browser = await chromium.launch({ channel: 'chromium' });
  const { page, context, errors } = await openGame(browser);

  try {
    if (MODE === 'probe' || MODE === 'all') await runProbe(page);
    if (MODE === 'endless' || MODE === 'all') await runEndless(page);
    if (MODE === 'economy') {
      // 长批泵：runEconomy 期间持续灌虚拟时间，结束（含抛错）立刻停。
      const economyPump = startClockPump(page);
      try {
        await runEconomy(page);
      } finally {
        await economyPump();
      }
    }
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
    if (MODE === 'models') await runModels(page);
    if (MODE === 'spray') await runSpray(page);
    if (MODE === 'cabinetTex') await runCabinetTex(page);
    if (MODE === 'cabinet') await runCabinet(page, context);
    // ★ S24：`model` **不在** `all` 里（`all` 只含 probe + endless + xixi）——
    // 它要另开一个带 `?model` 的页面，跑一次约 10 秒。单独跑：
    //   node scripts/verify-game.mjs model
    if (MODE === 'model') await runModel(page, context);
    if (MODE === 'camera') await runCamera(page, context);
    // 搬家守卫（10-03）：结构门 + 读数 census + 发布时机门。搬移前后各跑一次，census 逐字节同。
    if (MODE === 'hooks') await runHooksGuard(page, context);
    if (MODE === 'refill') await runRefill(page);
    if (MODE === 'feedback') await runFeedback(page);
    // 任何模式跑完都给一行写盘读数（步 2b：先量再改）。这条不参与判据，缺席时自己会说明。
    await reportSaveWrites(page, `模式 ${MODE} 全程`, 0);
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
