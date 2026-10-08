/**
 * 测试钩子的装配（S5，从 `Game.ts` 机械搬出：97 个键、1,160 行）。
 *
 * ⚠️ 三条规矩：
 *   ① 读一律走 `host` 的闭包/bound 方法 ⇒ 永远取 `Game` 的当下值；把值拷进袋子就是第二份状态。
 *   ② 被钩子写的只有四个（`rng` / `seedOverride` / `xixi` / `pausedForScreenshot`）⇒ 各配一个 `setXxx`，
 *      其余成员在袋子里**没有写入口** ⇒ "钩子不该改的东西改不了"这件事由类型保证，不靠自觉。
 *   ③ `window.__THREE_GAME_TEST_HOOKS__ = ` 这条赋值留在 Game 里（M0-a 数装配点）。
 */
import type { TestHooksHost } from '../Game';
import { Coin } from '../../entities/Coin';
import {
  cameraRig,
  cameraRigReport,
  fitCameraRig,
  placeCameraRig,
  syncCameraRigAngles,
  toRad,
} from '../../render/cameraRig';
import { iconReport } from '../../render/iconTexture';
import type { CoinEffectId } from '../effects';
import { marqueeScreen } from '../../render/marqueeScreen';
import { isLitMaterial } from '../../render/ToonMaterial';
import {
  AUDIO_EVENTS,
  audioEventNames,
  auditionEvent,
  findAudioEvent,
} from '../../systems/audioCatalog';
import { type QualityTier } from '../../systems/PerformanceGovernor';
import {
  BOOST_OVERFLOW_FALLBACK,
  ShowDirector,
  type ShowId,
} from '../../systems/ShowDirector';
import { FEEDBACK_EMISSIVE } from '../../systems/TableBuilder';
import { clamp } from '../../utils/numeric';
import { createSeededRandom } from '../../utils/random';
import {
  CABINET_SHELL_PARTS,
  cabinetPartBox,
  cabinetShape,
  cabinetWallOutline,
  isCabinetOverridden,
  type Box3Like,
} from '../cabinetShape';
import { coinPhysics } from '../coinPhysics';
import { COIN_SCALE } from '../coinScale';
import {
  COIN,
  COIN_KINDS,
  REFILL,
  RULES,
  TABLE,
  kindSpec,
  type CoinKind,
} from '../constants';
import {
  BET_TIERS,
  crossingReturn,
  ledgerBalances,
} from '../economy';
import { endlessCapacity } from '../endless';
import {
  FEEDBACK,
  crossingFeedback,
  flyTier,
} from '../feedback';
import {
  LAYER_STEP,
  MAX_JITTER,
  MIN_SPACING,
  MIN_STEP,
  REST_Y,
  insideDrain,
  isOnDeckVolume,
  layoutSummary,
  layoutValue,
} from '../layout';
import {
  FINE_RATIO_CEIL,
  FINE_RATIO_FLOOR,
  FINE_RAMP_DROPS,
  SLOT_OUTCOME_KEYS,
  SLOT_OUTCOME_WEIGHTS,
  SLOT_SYMBOL_WEIGHTS,
  SLOT_TIER4_SYMBOLS,
  fineAmount,
  fineRatio,
  outcomeTotalWeight,
  outcomeWeightKey,
  reelFacesFor,
  rollSlotOutcome,
  xixiSlot,
  type SlotOutcome,
  type SlotSymbol,
  type SlotTier,
} from '../xixi';
import * as THREE from 'three';

export function createTestHooks(host: TestHooksHost): ThreeGameTestHooks {

  return {
  seed: (value: number) => {
    host.setSeedOverride(value);
    host.setRng(createSeededRandom(value));
  },
  setState: (name: string) => {
    const state = host.applyTestState(name);
    host.render();
    host.publishDiagnostics();
    return { state };
  },
  setPausedForScreenshot: (paused: boolean) => {
    host.setPausedForScreenshot(paused);
  },
  /**
   * 只停/启推板，**不重置盘面**（测试用）。
   *
   * 存在的理由：穿模判据如果取「推板跑到第 10 个循环那一瞬间」的快照，
   * 量到的是**推板正在挤压**的瞬时姿态——币会顺着推币面爬上去、
   * 短暂地彼此嵌入，几秒后又自己解开。那是推币机的正常形态，不是缺陷。
   * 有了这个钩子，判据可以「停推板 → 等币堆自己静止 → 再量」，
   * 量到的才是**稳定下来的穿模**，同一条盘面每次跑结论一致。
   */
  setPusherRunning: (running: boolean) => {
    if (running) host.pusher().start();
    else host.pusher().stop();
    return { running: host.pusher().running, cycles: host.pusher().cyclesCompleted };
  },
  setReducedMotion: (enabled: boolean) => {
    host.motion().setOverride(enabled);
    if (enabled) {
      // 截图用：停掉环境动效，让同一状态两次渲染一致。
      // （相机不用归位 —— S16 起它本来就一动不动，见 `trackCameraOffset`。）
      host.pusher().stop();
    }
    host.render();
    host.publishDiagnostics();
    return { reduced: host.motion().reduced, source: host.motion().source };
  },
  hideDebugUi: (hidden: boolean) => {
    host.debugTools().setHidden(hidden);
  },
  setQuality: (tier: string) => {
    const settings = host.governor().force(tier as QualityTier);
    host.governor().freeze(true);
    host.applyQuality();
    host.hud().setQualityLock(true, settings.tier);
    host.render();
    return {
      tier: settings.tier,
      pixelTargetHeight: settings.pixelTargetHeight,
      shadows: settings.shadows,
    };
  },
  /**
   * 画质锁（10-01 用户点名）。`locked` 省略时**读**当前锁状态而不改 ——
   * 判据要能分清「没锁」与「锁在高档」，而这两件事在 tier 上看起来一样。
   */
  qualityLock: (locked?: boolean) => {
    if (locked === undefined) {
      return { locked: host.governor().isFrozen, tier: host.governor().current.tier, fps: host.governor().fps };
    }
    const tier = host.setQualityLock(locked);
    return { locked: host.governor().isFrozen, tier, fps: host.governor().fps };
  },
  /**
   * 灌 N 个「低帧」采样窗口，用来验锁档真的拦住了自动降档。
   *
   * 为什么要有这条钩子：判据不能靠"等机器真的卡"——那是不可复现的等待。
   * `sample()` 是纯的（吃 delta 出换档决定），所以把 delta 喂进去就能确定性地
   * 复现「连续两个 1 秒窗口低于 45 ⇒ 降一档」这条规则本身。
   */
  feedFrames: (delta: number, windows: number) => {
    let changed = 0;
    for (let i = 0; i < Math.max(0, Math.round(windows)); i += 1) {
      // 一个窗口 = 累计满 1 秒仿真时间；`1 / delta` 帧就是那个窗口的帧数。
      const frames = Math.max(2, Math.ceil(1 / Math.max(0.001, delta)));
      for (let f = 0; f < frames; f += 1) {
        if (host.governor().sample(delta)) {
          changed += 1;
          host.applyQuality();
        }
      }
    }
    return { changed, tier: host.governor().current.tier, fps: host.governor().fps };
  },
  /**
   * 像素分辨率开关（V1，V2 解耦）：`pixelated` 只管最近邻/平滑，`upscale` 管内部分辨率。
   * 两个旋钮独立可断言——`visual.spec.ts` 专门钉「关最近邻不改倍率」。
   */
  setPixelScale: (patch: { targetHeight?: number; upscale?: number | null; pixelated?: boolean }) => {
    if (patch.targetHeight !== undefined) host.tuning().pixelTargetHeight = patch.targetHeight;
    if (patch.pixelated !== undefined) host.tuning().pixelated = patch.pixelated;
    // `upscale: null` 取消显式倍率，回到 `targetHeight` 推导。
    if (patch.upscale !== undefined) host.pixelSettings().upscaleOverride = patch.upscale;
    host.applyPixelScale();
    host.render();
    return { ...host.pixelScale() };
  },
  drop: (lane: number) => {
    host.input().setLane(lane);
    return host.tryDrop(clamp(lane, -1, 1) * TABLE.drop.halfLane);
  },
  /** 只设定选位、不投币；视为一次手动接管（自动选位会让位 2 秒）。 */
  setLane: (lane: number) => {
    host.input().setLane(lane);
    return { lane, laneX: clamp(lane, -1, 1) * TABLE.drop.halfLane };
  },
  boost: () => host.tryBoost(),
  /** 机关：直接触发，返回是否生效（测试用）。 */
  sweep: () => host.trySweep(),
  grapple: (laneX: number) => host.tryGrapple(laneX),
  reload: () => host.tryReload(),
  cycleBet: () => host.cycleBet(),
  mechanisms: () => host.mechanismSnapshot(),
  /**
   * 机关构件的在场与**交付剖面**（R5）。
   *
   * 为什么必须暴露：扫板「分批给冲量」与老写法「一次全给」在**账本上完全等价**
   * （总冲量一样、越线一样），任何计数型判据都读不出区别。只有交付时刻
   * （`firstHitAt` ~ `lastHitAt` 的跨度、抓斗 `deliveredAt` 晚于提升）能证明这件事，
   * 而那两个字段的唯一出处就是这里。
   */
  mechanismShow: () => host.mechanismShows().report(),
  /** 开一局新的 / 跪求 / 收工，供自动化试玩。 */
  startRun: () => {
    host.startRun();
    return true;
  },
  beg: () => host.begForChips(),
  quitRun: () => host.endRun(),
  /**
   * 把**当前这一局就地**推到破产弹窗（测试用）。
   *
   * 与 `setState('ruin')` 的区别是关键的：那个会先 `startRun()` 重开一局，
   * 于是 `earned` / `begsThisRun` / 消耗**全被清零**。拿它去搭「收工 → 总结页」
   * 的场景，会把**被测的东西本身**擦掉——总结页要显示的正是「本局赚了多少、
   * 跪求过几次」，而它读的是 `recordRun(earned, drops, begsThisRun)`
   * （实测踩过：跪求过一次之后用 `setState('ruin')` 搭场景，总结页报「累计跪求 0」）。
   *
   * 这个钩子只走收尾那一步：清零筹码 → 进沉降 → 弹窗。账本身份原样保留，
   * 所以 `spent` 会记上这次清空，恒等式仍然平。
   */
  forceRuin: () => {
    if (host.hud().ruinVisible) return false;
    host.run().spendChips(host.run().chips);
    host.run().enterRuinSettle();
    host.showRuin();
    return true;
  },
  /**
   * 把币床掏空到只剩 `keep` 枚，返回实际删掉的枚数（P10 ⑦ 补币判据的**状态构造器**）。
   *
   * 为什么要一个构造器：「台面见底」在真实玩法里要玩好几分钟才到得了
   * ——盘面每局只掉几十枚，而阈值落在预置量的一半以下。用它当验收的**入口**
   * 会让判据变成一条几分钟的慢测，而且不确定（掉多少取决于玩家怎么投）。
   *
   * ★ **从最靠前（z 最大）的开始删**：那是币床自然变薄时的顺序——
   * 推板把币往前挤，前沿的先越线、先掉进下水道。所以构造出来的状态与
   * 「真的玩到那一步」是**同一个形态**，而不是一个「随机挖空」的人造态。
   *
   * 只 `despawn`，不碰账本：币不是筹码，`balance = initial + earned + begged + loaned − spent`
   * 不受影响。判据要的是「盘面变薄」这一个变量，别的一律不动。
   */
  clearBedTo: (keep = 120) => {
    const bed: Coin[] = [];
    const range = host.pusher().topRange;
    host.coins().forEachActive((coin) => {
      const p = coin.position;
      if (p.z >= TABLE.scoreLineZ) return;
      // 与 `CoinPool.countBed()` 同一份口径（「不在台面体积里」= 在币床上）：
      // 币塔上的币也算币床库存，否则「把盘面掏到 120 枚」会留下一座塔没动。
      if (isOnDeckVolume(p.x, p.y, p.z, range)) return;
      bed.push(coin);
    });
    if (bed.length <= keep) return 0;
    bed.sort((a, b) => b.position.z - a.position.z);
    let removed = 0;
    for (const coin of bed) {
      if (bed.length - removed <= keep) break;
      coin.despawn();
      removed += 1;
    }
    return removed;
  },
  run: () => ({
    begs: host.begsThisRun(),
    totalBegs: host.save().begCount(),
    best: host.save().snapshot.bestEarned,
    balance: host.save().balance,
    // 验证脚本会主动充值钱包（见 `refillWallet` 钩子），所以钱包守恒的
    // 算式必须把 Σ充值 算进去，否则会报出假失败。
    refilled: host.save().refilled,
    ruinVisible: host.hud().ruinVisible,
    summaryVisible: host.summaryVisible(),
  }),
  /**
   * 本局账本 + 账户读数：验收要逐笔核对
   * `balance = initial + earned + begged + loaned − spent`（S4 合并账户之后的式子）。
   *
   * ★ `balanced` 是**这条恒等式唯一的真源**（直接调 `economy.ledgerBalances`）。
   * 原先 harness 的 `ledgerOk()`、Playwright 的 `expect(...).toBe(...)`、以及
   * `ledgerText()` 打的中文式子**各自手抄了一遍同一个算式**（共四处）。
   * 于是 S4 合并账户动 `Ledger` 那一族时要同步改四个地方——漏一处就是
   * 「src 绿、spec 红」的假回归对。现在下游一律**读这个字段**，不再自己算。
   */
  ledger: () => ({
    ...host.run().ledger,
    balance: host.save().balance,
    spendable: host.save().spendable,
    refilled: host.save().refilled,
    balanced: ledgerBalances(host.run().ledger),
    /**
     * ★ S4 的全局守恒式（验证批 ②）要用它。
     * 局级账本每次开局重新快照，抓不到「上一局收尾时那笔没记进任何局账的余额变动」
     * —— 旧 ② 报的「差 26」正是这种。这份累计表不按局清零，所以抓得到。
     */
    totals: host.save().accountTotals,
  }),
  /** 加注档位表（含返值倍率），供验证脚本做「换档重算」。 */
  betTiers: () => BET_TIERS.map((tier) => ({ ...tier })),
  /**
   * 经济纯函数：验证脚本拿它做蒙特卡洛。
   *
   * 之所以要暴露到页面里而不是在脚本里重写一遍：**只有真的调这条函数**，
   * 测出来的期望才是游戏实际的期望。脚本里抄一份公式，改了一边忘了另一边，
   * 测试就会一直绿着骗人。
   */
  crossingReturn: (input: { kind: CoinKind; combo: number; hot: boolean; betMul: number; roll: number }) =>
    crossingReturn(input),
  snapshot: () => host.run().snapshot(),
  coins: () => host.sampleCoins(),
  probeColliders: (x: number, y: number, z: number) => host.probeColliders(x, y, z),
  /**
   * 调试用：从某点竖直向下打一条射线，返回第一个命中的碰撞体。
   *
   * 用来回答「这枚币脚下到底是什么、支撑面在哪个高度」——币堆穿模排查时，
   * 光看币的坐标只能知道它沉下去了，射线才知道它沉进了什么。
   */
  castDown: (x: number, y: number, z: number) => host.castDown(x, y, z),
  /** 调试用：报告地板网格与最低几枚币的**网格**世界包围盒（渲染侧真实位置）。 */
  probeMeshes: () => host.probeMeshes(),
  /**
   * 调试/验证用：从**接触流形**里读真实穿透深度。
   *
   * 为什么不用「同层横向距离」那种几何启发式：币堆里出现倾斜的币时，
   * 两枚币心可以靠得很近、高度也只差几毫米，却是**合法的倚靠**（斜币的边缘
   * 搭在另一枚的币面上）。启发式会把它们全判成穿模，于是币堆一变硬就满屏误报。
   * 接触流形的 `contactDist` 是物理引擎自己算出来的穿透量，与姿态无关。
   */
  penetrationReport: (limitMillimeters: number) => host.penetrationReport(limitMillimeters),
  setTuning: (patch: Record<string, number | boolean>) => {
    Object.assign(host.tuning(), patch);
    host.applyTuning();
    return { ...host.tuning(), physics: host.physics().tuning };
  },
  /**
   * 直接写 `coinPhysics` 注册表——**不经调参表、不上滑块**。
   *
   * 存在的唯一理由：有些注册表键刻意不给滑块（`upwardBleedTau` 是「护栏以什么形状
   * 生效」的定义，不是手感旋钮），但它的 A/B 仍然必须能在**同一次页面加载**里换臂。
   * 换臂的另一条路是改 `constants.ts` ⇒ 整页刷新 ⇒ 进行中的验证批全部作废。
   *
   * 键名逐个校验（与 `requireSelectorKey` 同一条理由）：拼错的键会静悄悄写进一个
   * 不存在的属性，然后 A/B 的两条臂测的是同一个东西。
   */
  setCoinPhysics: (patch: Record<string, number>) => {
    for (const key of Object.keys(patch)) {
      if (!(key in coinPhysics)) {
        throw new Error(
          `未知的硬币物理键「${key}」。可用键：${Object.keys(coinPhysics).join(', ')}`,
        );
      }
    }
    Object.assign(coinPhysics, patch);
    return { ...coinPhysics };
  },
  // ── 音频调试 ──────────────────────────────────────────────────────
  // 这组钩子与调试面板共用同一条路径（`audioCatalog` 的事件表），
  // 所以脚本能试听到与面板完全一致的东西。
  soundNames: () => audioEventNames(),
  sound: (name: string) => auditionEvent(host.audio(), name),
  soundInfo: (name?: string) => {
    const snapshot = host.audio().debug;
    if (name === undefined) {
      return {
        ...snapshot,
        events: AUDIO_EVENTS.map((event) => ({
          name: event.name,
          label: event.label,
          selector: event.selector,
          mountable: event.selector !== null,
          mounted: event.selector !== null && host.audio().hasOverride(event.selector),
        })),
      };
    }
    const event = findAudioEvent(name);
    if (!event) return null;
    const info = event.selector
      ? host.audio().selectorInfos().find((entry) => entry.key === event.selector)
      : null;
    return {
      name: event.name,
      label: event.label,
      selector: event.selector,
      mountable: event.selector !== null,
      mounted: event.selector !== null && host.audio().hasOverride(event.selector),
      gain: info?.gain ?? null,
      throttleMs: info?.throttleMs ?? null,
      samples: info ? [...info.samples] : [],
    };
  },
  setSoundGain: (selector: string, value: number) => {
    const key = host.requireSelectorKey(selector);
    return { selector: key, gain: host.audio().setGain(key, value) };
  },
  clearSoundOverride: (selector?: string) => {
    const key = selector === undefined ? undefined : host.requireSelectorKey(selector);
    return { cleared: host.audio().clearOverride(key) };
  },
  /**
   * 从 URL 拉一个音频文件解码后挂到槽位。
   *
   * 这是 GUI 之外的能力，专供脚本化验证：不用真的去操作 `<input type=file>`，
   * 就能把「挂载 → 事件走 override 路径」这条链跑通。
   */
  overrideSoundFromUrl: async (selector: string, url: string) => {
    const key = host.requireSelectorKey(selector);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bytes = await response.arrayBuffer();
    const buffer = await host.audio().decodeFile(new File([bytes], url));
    host.audio().overrideSelector(key, buffer, url);
    return { ok: true, selector: key, name: url, duration: buffer.duration };
  },
  table: () => {
    const summary = layoutSummary(host.config().layout);
    return {
      name: host.config().name,
      coins: host.config().layout.length,
      value: layoutValue(host.config().layout),
      // 按币种计数：`byKind` 是 P6 之后的通路口径（新增币种自动出现），
      // bronze/pattern/payout 三个旧字段保留给既有判据读。
      byKind: { ...summary.byKind },
      // 币种清单也一并给出：判据用「byKind 的键集 == kinds」来核对，
      // 这样新增币种时判据自动跟上，不用在测试脚本里再抄一份名单。
      kinds: [...COIN_KINDS],
      bronze: host.config().layout.filter((coin) => coin.kind === 'bronze').length,
      pattern: host.config().layout.filter((coin) => coin.kind === 'pattern').length,
      payout: host.config().layout.filter((coin) => coin.kind === 'payout').length,
      /**
       * 上层台面（推板顶面）与币床的预置枚数。
       *
       * 补币判据要它：`bedCoins` 的口径是「币床上的币」，而 `activeCoins` 含上层台面，
       * 所以「`bedCoins < activeCoins`」这条守卫必须能说出**差在哪里**——
       * 差值应当 ≈ `deck` + 在途币。差得离谱就说明口径写错了（例如把上层也算进来了）。
       */
      deck: summary.deck,
      bed: summary.bed,
      /**
       * 盘面**容量**：把稀疏铺去掉后这份配置能放多少枚。
       *
       * 判据用它算「填充率」。**不要**拿它当「满盘应当多少枚」——
       * 满盘枚数随币尺寸档位下降，而填充率不随。见 `layoutCapacity()`。
       */
      capacity: endlessCapacity(),
    };
  },
  /**
   * 币的几何派生量（S13）：**验证脚本的唯一真源**。
   *
   * 存在的理由（纪律 2「判据不写第二份公式」）：脚本里原先手抄了一串
   * `0.12`（币径）、`0.0212`（层高）、`0.005`（抖动）之类的常量，
   * 而 `?coin=1.1/1.2` 会把这些**全部**改掉。手抄的那份不会跟着变，
   * 于是判据在别的档位下会**假绿**——拿旧尺寸去量新币，怎么看都合格。
   * 所以脚本一律改读这个钩子，把手抄常量删掉。
   *
   * `mass` 一并给出：`Mechanisms` 的定值冲量必须按质量比（`k³`）补偿，
   * 判据要能算出「同样的冲量在别的档位下给出多少 Δv」。
   */
  coinGeometry: () => ({
    scale: COIN_SCALE,
    radius: COIN.radius,
    halfThickness: COIN.halfThickness,
    diameter: COIN.radius * 2,
    /** 单层高度步距（币厚 + 余量）。 */
    layerStep: LAYER_STEP,
    /** 台面上币心的静置高度。 */
    restY: REST_Y,
    maxJitter: MAX_JITTER,
    /** 自检的同层最小间距判据：币径 × 0.98。 */
    minSpacing: MIN_SPACING,
    /** 网格步距下限：`minSpacing + 2 × maxJitter`。区域列/行数由它反算。 */
    minStep: MIN_STEP,
    /** 单枚币的质量（千克）：πr² × 2h × ρ。定值冲量的补偿基准。 */
    mass: Math.PI * COIN.radius ** 2 * COIN.halfThickness * 2 * coinPhysics.density,
    // ⚠️ 以下四项一律读 `coinPhysics` 注册表，**不是** `COIN.*` 常量。
    // 这份钩子自称「派生量唯一真源、脚本不准手抄」，那就必须反映调参后的实际值；
    // 读常量会让脚本在调试面板改过之后拿到陈旧数据，判据**假绿**。
    density: coinPhysics.density,
    friction: coinPhysics.friction,
    restitution: coinPhysics.restitution,
    linearDamping: coinPhysics.linearDamping,
    angularDamping: coinPhysics.angularDamping,
    /** 台面输送带的高度上界与当前速度（`?debug` 面板可实时改）。下界见 `isOnDeckAt`。 */
    conveyor: {
      maxY: TABLE.conveyor.maxY,
      speed: host.tuning().conveyorSpeed,
    },
    /** 推板顶面高度（上层台面的基准 y）。 */
    pusherTopY: TABLE.pusherTopY,
    /**
     * 推板行程，以及推币面的 z 区间（归位 → 全伸）。
     *
     * 为什么把它放进这份「派生量真源」（纪律 2「判据不写第二份公式」）：
     * `accept` ④ 要判「币离开台面的位置贴合推板前缘，且不同时机的落点确实不同」，
     * 而**「不同」的尺度只能是推板行程本身**。那条判据原先写死 `spread > 0.3`，
     * 是按 `conveyor = 0.85` 标定的：那时台面币被输送带在 ~1 秒内送到前唇，
     * 落点能落在整个行程里的任意一点。`conveyor` 归零之后离台**只发生在回撤的
     * 前半段**（见 `runTimingCheck` 的注释），实测跨度 0.145 米 = 行程的 40%，
     * 写死的 0.3 永远够不到。改成「行程的比例」之后，改行程不会让判据失真。
     *
     * ⚠️ 读 `host.pusher().travel` 而不是 `TABLE.pusherTravel`：后者是**出厂常量**，
     * 面板改过行程之后它就是陈旧的——上面这段「改行程不会让判据失真」的承诺
     * 只有在读运行时值时才成立。
     */
    pusherTravel: host.pusher().travel,
    pusherFrontZ: {
      rest: TABLE.pusherFrontZAtRest,
      extended: TABLE.pusherFrontZAtRest + host.pusher().travel,
    },
    /**
     * 落币口。判据要用它来定位**落币走廊与钉阵**。
     *
     * `accept` ⓪ 的探针点原先写死 `(0, 1.16, −0.72)` —— 那个 z 就是旧的落币口。
     * 2026-09-25 落币口后移到 `−1.20` 之后，探针会探空，读出来的是
     * 「钉子碰撞体半长种类数 = 0」，判据**红在别的地方**，很容易被误判成钉子本身坏了。
     * 所以口径一律从引擎读。
     */
    drop: { y: TABLE.drop.y, z: TABLE.drop.z, halfLane: TABLE.drop.halfLane },
    /** 速度护栏，判据拿它当「求解器有没有造能量」的阈值。 */
    maxSpeed: coinPhysics.maxSpeed,
    maxUpwardSpeed: coinPhysics.maxUpwardSpeed,
  }),
  /**
   * 某个 (x, z) 是否落在币床前侧角的排水口里（含抖动余量）。
   *
   * 暴露它的理由（纪律 2「判据不写第二份公式」）：`physics` ⑤ 要判「币床的币
   * 坐在台面上」，而**掉进排水口的币本来就该在地板高度以下**——它们正在被
   * 这张桌子合法地回收。判据必须把这一块排除掉，而排除的口径只能来自
   * 引擎自己的 `insideDrain`（真源是 `DRAIN_FOOTPRINT`，含 `MAX_JITTER` 退让）。
   * 在脚本里另抄一个 `|x| > 0.66 && z ∈ [0.98, 1.15]` 就是第二份公式，
   * 它不会跟着 `DRAIN` / `MAX_JITTER` 一起改，下一次调洞就会假红或假绿。
   */
  insideDrain: (x: number, z: number) => insideDrain(x, z),
  /**
   * 某个世界坐标是否落在**上层台面的体积**里（与 `Game.isOnDeck` 同一份判据）。
   *
   * 暴露它的理由与 `insideDrain` 同：验证脚本要按「台面 / 币床」分桶统计，
   * 而**分桶口径必须来自引擎**。S13 之前脚本用 `deckY()`（一个高度中点）近似，
   * 那在塔顶高过台面之后会把塔上的币算进台面 —— 读数看着正常，其实是假的。
   * 现在塔能盖到 9 层（塔顶 0.216 > 高度中点 0.177），这条口径必须精确。
   *
   * `z` 用**当前**推板行程（`pusher.topRange`），所以前缘被推出去的币仍算台面币。
   */
  isOnDeckAt: (x: number, y: number, z: number) =>
    isOnDeckVolume(x, y, z, host.pusher().topRange),
  /**
   * V2：材质族统计（toon / standard / basic / other）+ 色带数 + 已编译程序数。
   * 见 `materialReport()` 的注释：这三项都是「只能靠计数发现的静默缺陷」。
   */
  materialReport: () => {
    const base = host.materialReport();
    // S18：把 draw call 顺路带上，cabinet-tex 模式可以读到。
    // ★ 读**自己按帧累计的两份**，不读 `renderer.info`：两遍出画之后那里
    //   只剩最后一遍的 1 次调用 / 2 个三角形，判据会绿得毫无意义。
    (base as unknown as Record<string, unknown>).renderer = {
      calls: host.frameDrawCalls(),
      triangles: host.frameTriangles(),
      sceneCalls: host.sceneDrawCalls(),
      max: host.rendererPeakDrawCalls(),
    };
    return base;
  },
  /**
   * G3-a：回读通道附件，量「面 ID 能不能分开**真正相邻**的物体」。
   *
   * 这条读数是 G3 全部阈值的地基。参考笔记 §6 第 4 条一直标着 `待验证`，
   * 理由写得很清楚：ID 是 `fract()` 出来的连续标量，量化到 8 位之后
   * 「两个相邻物体的可分差」可能小于噪声 —— 而**判据要按可分差设计，不是按
   * 「看起来有描边」设计**。抄参考的数值不行：他的场景尺度（树/叶子）与我们
   * 的（一米级柜体 + 几厘米的币）完全不同。
   */
  gbufferReport: () => host.gbufferReport(),
  /**
   * 招牌显示屏的**实测读数**（R3-U4）。
   *
   * 屏是第 8 个外壳网格，但**故意不带** `userData.part` / `role`：换肤与贴图分发
   * 都按这两个字段找件，屏两者都不吃。代价是 `cabinetReport()` 那 7 件看不见它 ——
   * 没有这个通道，「屏到底在不在、贴没贴上、有没有吃自己的纹理」就只能盯截图。
   */
  marqueeReport: () => {
    const mesh = host.tableGroup()?.getObjectByName('marqueeScreen') as THREE.Mesh | undefined;
    if (!mesh) return null;
    const texture = marqueeScreen().texture;
    const material = mesh.material as THREE.MeshToonMaterial;
    const size = (mesh.geometry as THREE.PlaneGeometry).parameters;
    const world = mesh.getWorldPosition(new THREE.Vector3());
    return {
      width: size.width ?? 0,
      height: size.height ?? 0,
      // 纹理自己的尺寸：判据要的是「纹理宽高比 == 面板宽高比」这条**比值相等**关系，
      // 而不是某个写死的 4:1（做满之后面板比例是几何算出来的，会随 `?model` 变）。
      textureWidth: marqueeScreen().texels.width,
      textureHeight: marqueeScreen().texels.height,
      // 画布上出现过的不同颜色数：LED 面板本该是个位数，抗锯齿灰边会把它推到几百。
      distinctColors: marqueeScreen().distinctColors,
      world: [world.x, world.y, world.z] as [number, number, number],
      materialName: material.name,
      mapIsScreen: material.map === texture,
      emissiveMapIsScreen: material.emissiveMap === texture,
      offsetX: Number(texture.offset.x.toFixed(4)),
    };
  },
  /**
   * 招牌屏在**屏幕空间**的包围盒（CSS 像素，相对视口）。G-遮挡判据吃它（Stage 3a）。
   *
   * 做法与 `Game.ts:2620` 那条 HUD 锚定同源：取面板几何的四角、`localToWorld`、
   * `project(camera)`，再把 NDC 换到画布矩形里的像素。
   * 刻意在页面里算完再返回纯数字 —— DOMRect 不能跨 evaluate 边界序列化。
   */
  marqueeScreenBox: () => {
    const mesh = host.tableGroup()?.getObjectByName('marqueeScreen') as THREE.Mesh | undefined;
    if (!mesh) return null;
    const size = (mesh.geometry as THREE.PlaneGeometry).parameters;
    const halfW = (size.width ?? 0) / 2;
    const halfH = (size.height ?? 0) / 2;
    const box = host.canvasBox();
    const camera = host.camera();
    const corners: Array<[number, number]> = [];
    for (const [sx, sy] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ]) {
      const point = new THREE.Vector3(sx * halfW, sy * halfH, 0);
      mesh.localToWorld(point);
      point.project(camera);
      corners.push([
        box.left + ((point.x + 1) / 2) * box.width,
        box.top + ((1 - point.y) / 2) * box.height,
      ]);
    }
    const xs = corners.map((c) => c[0]);
    const ys = corners.map((c) => c[1]);
    return {
      minX: Math.min(...xs),
      maxX: Math.max(...xs),
      minY: Math.min(...ys),
      maxY: Math.max(...ys),
      corners,
    };
  },
  /**
   * 播一条招牌屏字幕（与玩法里的 `announce()` 同一条路径）。
   *
   * 存在的理由很具体：屏的**两行态**（亮色账本行 + 暗色字幕行）原来只有玩法事件能触发
   *（老虎机开奖、机关提示），于是「两行时画布还剩几种颜色」这件事在测试里根本测不到 ——
   * 判据只能给单行态留余量。补上这个钩子之后，两行态是一个**可主动进入的状态**。
   */
  marqueeSubtitle: (message: string): void => {
    // 刻意**不**回读 `distinctColors`：重画是节流的（≤8 fps），这一行立刻读到的
    // 还是上一帧的调色板 —— 返回一个看着像结果的旧数，比不返回更容易骗人。
    marqueeScreen().subtitle(message);
  },
  /**
   * 已编译程序的**指纹名单**（R2-T2）。
   *
   * `perf` 原来只断言「程序数 < 30」。那条判据从 20 涨到 29 都还是绿的，
   * 而「谁多要了一份程序」完全读不出来 —— 加参数的人只能猜，守门的人只能看总数。
   * 这里把 `renderer.info.programs` 的 cacheKey 折叠成**可读指纹**并按指纹分组：
   * 程序数一旦变化，跑一次 `perf` 就能看到多出来的是哪一行。
   *
   * cacheKey 里一半以上是 `true` / `false` 的布尔位，读起来全是噪声；丢掉它们之后剩下的
   * 就是有语义的部分（shader 组合、`SD|DETAIL|KIND`、`uv`、`customProgramCacheKey` 的
   * `toon-ramp-v1`）。⚠️ 序号**要留**：丢掉数字会把四种 detail 纹样折叠成同一行指纹，
   * 而「哪种纹样多要了一份程序」恰恰是这里要看的东西。
   */
  programRoster: (): Array<{ fingerprint: string; variants: number }> => {
    const groups = new Map<string, number>();
    for (const program of host.renderer().info.programs ?? []) {
      const key = String((program as unknown as { cacheKey?: string }).cacheKey ?? '');
      const fingerprint = key
        .split(',')
        .filter((token) => token !== '' && token !== 'true' && token !== 'false')
        .join(',');
      groups.set(fingerprint, (groups.get(fingerprint) ?? 0) + 1);
    }
    return [...groups.entries()]
      .map(([fingerprint, variants]) => ({ fingerprint, variants }))
      .sort((a, b) => b.variants - a.variants || a.fingerprint.localeCompare(b.fingerprint));
  },
  /**
   * 机柜外壳**实测读数**（S19）：逐件给出世界轴对齐盒 + 那件局部 +z 的世界方向。
   *
   * 判据（`verify-game.mjs cabinet`）拿它比对 `game/cabinetShape.ts` 里的
   * `cabinetPartBox()`。★ 为什么必须开这个通道：S18 那次「实心砖」之所以
   * `perf` / `drawcall` / `programs` / `cabinetTex` / `models` **全绿**通过，
   * 就是因为没有任何办法把「场景里的几何长什么样」读出来 —— 尺寸全在
   * `buildCabinetShell` 的函数体里，判据只能手抄第二份公式。
   *
   * 返回里的 `normal` 是**局部 +z** 的世界方向，也就是件的「正面法线」。
   * 招牌靠它判朝向：S18 把倾角符号写反，招牌正面朝了地面，
   * 而那件事**任何计数型判据都看不见**。S21 删招牌之后它改判檐板正面（法线 ≈ +z）。
   *
   * ## `profile`：包围盒内部那些**斜边**的唯一观测通道（S21）
   *
   * S21 的侧墙有两处斜边（檐板托的斜接面、低段的斜顶），它们**整个落在包围盒内部**
   * ⇒ 解析盒比对看不到，写平了也是全绿。所以这里额外把每件几何的**顶点集合**
   * 投影到 (y, z) 平面去重后带出来，由判据与 `cabinetWallOutline()` 的折线比对。
   *
   * 去掉 x 是有意的：轮廓沿 x 挤出，同一组 (y, z) 在两个端面上各出现一次，
   * 投影后自然合并成一份；坐标先量化到 1e-4 米（float32 的舍入在 1.7e-7 量级，
   * 差四个数量级，量化不会把两个不同的顶点并成一个）。
   */
  cabinetReport: () => {
    const out: Array<{
      part: string;
      role: string | null;
      min: [number, number, number];
      max: [number, number, number];
      normal: [number, number, number];
      profile: Array<[number, number]>;
      /**
       * 这件**吃不吃倒角**（S25）。由 `cabinetBoxMesh()` 亲手挂进 `userData`，
       * 也就是「几何会不会理你」的同一个事实 —— 判据据此断言「剖面挤出件改了倒角
       * 顶点数不许变」，而不是再抄一份直角盒名单。
       */
      bevelable: boolean;
      /**
       * 顶点数（S25）：倒角唯一**看得见**的观测通道。
       *
       * ⚠️ 半径**没有**任何观测通道 —— `RoundedBoxGeometry` 始终把外尺寸做满，
       * 包围盒一格不变（`cabinet` 判据的「解析盒 = 实测盒」正是靠这一点才不会被
       * 倒角搞红）。所以「面板拖了到底生没生效」只能数顶点：分段数一变顶点必变，
       * 半径那一条要靠 `?model` 的截图人眼核。
       */
      vertices: number;
      /**
       * 这件挂的**材质实例名**与 `map` 的 uuid（S25 / R1-M3 新增，无 map 时为 null）。
       *
       * 为什么判据需要它：`cabinetMapCount()` 只数「全场带 map 的材质有几份」，
       * 那是个**总量**——币面贴图也算进去（实测 16），所以「侧板到底挂没挂上图」
       * 「侧板和背板是不是被刷成同一张」这类问题它一个都答不了。
       * 而这两件事恰恰是 `panelArt` 那份材质拆分的**全部意义**：
       * 拆坏了（并回 `panel`）就是背板也被画满灯位，零报错。
       */
      material: string | null;
      map: string | null;
      glow: string | null;
    }> = [];
    const vertex = new THREE.Vector3();
    host.tableGroup()?.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (mesh.isMesh !== true) return;
      const part = mesh.userData.part as string | undefined;
      if (!part) return;
      mesh.updateWorldMatrix(true, false);
      const box = new THREE.Box3().setFromObject(mesh);
      const normal = new THREE.Vector3(0, 0, 1).transformDirection(mesh.matrixWorld).normalize();

      // (y, z) 顶点集合：量化去重 + 排序，顺序无关（比对的是集合）。
      const seen = new Set<string>();
      const profile: Array<[number, number]> = [];
      const position = mesh.geometry?.getAttribute?.('position');
      if (position) {
        for (let i = 0; i < position.count; i += 1) {
          vertex.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld);
          const y = Math.round(vertex.y * 1e4) / 1e4;
          const z = Math.round(vertex.z * 1e4) / 1e4;
          const key = `${y},${z}`;
          if (seen.has(key)) continue;
          seen.add(key);
          profile.push([y, z]);
        }
        profile.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      }

      out.push({
        part,
        role: (mesh.userData.role as string | undefined) ?? null,
        min: [box.min.x, box.min.y, box.min.z],
        max: [box.max.x, box.max.y, box.max.z],
        normal: [normal.x, normal.y, normal.z],
        profile,
        bevelable: mesh.userData.bevelable === true,
        vertices: mesh.geometry?.getAttribute?.('position')?.count ?? 0,
        material: (mesh.material as THREE.Material | undefined)?.name ?? null,
        map:
          ((mesh.material as { map?: THREE.Texture | null } | undefined)?.map?.uuid ?? null),
        // 「贴图挂上了」≠「灯真的亮」：`emissiveMap` 才是让深色色带上的亮条活过来的
        // 那一环，漏了它画面照样「有图」但只剩暗斑 —— 本仓库最恨的静默失效。
        glow:
          (mesh.material as { emissiveMap?: THREE.Texture | null } | undefined)?.emissiveMap
            ?.uuid ?? null,
      });
    });
    return out;
  },
  /**
   * 外壳形状的**应用实例**读数（S24）。
   *
   * ★ 它不能用 `page.evaluate(import('/src/game/cabinetShape.ts'))` 代替：
   * Vite 给应用内的模块 URL 带了 HMR 查询串，裸 `import()` 拿到的是
   * **另一个模块实例** —— 实测把 `hood.valanceInnerZ` 改成 0.3 之后，
   * 那边读到的仍是 0.195、`isCabinetOverridden()` 仍是 false。
   * 用它验「覆盖层生效了吗」会**恒 false**（永远绿），等于没查。
   */
  cabinetShapeReport: () => {
    const boxes: Record<string, Box3Like> = {};
    for (const part of CABINET_SHELL_PARTS) boxes[part] = cabinetPartBox(part);
    return {
      overridden: isCabinetOverridden(),
      shape: cabinetShape() as unknown as Record<string, unknown>,
      parts: [...CABINET_SHELL_PARTS],
      boxes,
      outlines: {
        tall: cabinetWallOutline('tall').map(([z, y]) => [z, y]),
        low: cabinetWallOutline('low').map(([z, y]) => [z, y]),
      },
    };
  },
  /**
   * 模型模式（S24，`?model`）的测试钩子。
   *
   * 判据（`verify-game.mjs model`）只走这几个 —— 它们内部走的是
   * **与面板同一条路**（`setFieldForTest` → `onShapeChanged` → 重建整具外壳），
   * 而不是自己另造一具。两条路一旦分叉就会出现「面板上能用、判据红」
   * 这种没法解释的差异。
   *
   * 非 `?model` 下 `modelMode` 为 null ⇒ 一律回答「未启用」。
   */
  modelModeEnabled: () => host.modelMode()?.enabled === true,
  modelModeDiffCount: () => host.modelMode()?.diffCount() ?? -1,
  modelModeSelected: () => host.modelMode()?.selectedPart() ?? null,
  modelModeSet: (path: string, value: number) => host.modelMode()?.setFieldForTest(path, value),
  modelModeReset: () => host.modelMode()?.resetForTest(),
  modelModeSelect: (part: string) => host.modelMode()?.selectForTest(part) ?? false,
  modelModeOutlineCount: () => host.modelMode()?.outlineCount() ?? -1,
  // 「挂了几条线」与「那些线在不在场景里」是两件事：前者查不出重建把
  // `ModelMode.shell` 换成游离节点这件事（见 `ModelMode.shellAttached()`）。
  modelModeShellAttached: () => host.modelMode()?.shellAttached() ?? null,
  /**
   * V4：币面贴图的实际纹素与采样设置。
   * 把「贴图本身对不对」与「渲染对不对」切开——币的颜色链路有四层，
   * 只看截图没法定位是哪一层出的问题。
   */
  /**
   * S22：摄影机机位读数。
   *
   * 连同 `autoFit` 与 `cameraPeakOffset` 一起交出来，因为「手动动机位」最容易
   * 踩坏的就是 S17 那条铁律：`cameraPeakOffset` 必须恒为 0
   * （电机位之后 `cameraBase` 要跟着走，否则每一帧都在记「相机偏离了基准」）。
   */
  cameraReport: () => ({
    ...cameraRigReport(),
    autoFit: host.tuning().cameraAutoFit,
    cameraPeakOffset: host.cameraPeakOffset(),
  }),
  /**
   * S22：改写机位。与调试面板的「摄影机」分组走**同一组纯函数**
   * （`placeCameraRig` / `syncCameraRigAngles`），不另开一条脚本专用通道 ——
   * 两条路一旦分叉就会出现「面板绿、脚本红」这类没法解释的差异。
   *
   * ★ 手动字段（角度 / 相机坐标 / 观察点）一旦出现就**交出所有权**
   * （`cameraAutoFit = false`），与面板 setter 里的 `takeOwnership()` 完全同义。
   * 不这样做的话，脚本摆完机位之后改 FOV 会被 `fitCamera()` 弹回默认视角，
   * 而面板上不会 —— 那正是「两条路分叉」。
   * 只给 `autoFit` 一项时不翻：否则「回到默认取景」（`{ autoFit: true }`）
   * 会把自己刚打开的开关关掉。
   */
  setCameraRig: (patch) => {
    const manual =
      patch.yawDeg !== undefined ||
      patch.pitchDeg !== undefined ||
      patch.distance !== undefined ||
      patch.camX !== undefined ||
      patch.camY !== undefined ||
      patch.camZ !== undefined ||
      patch.targetX !== undefined ||
      patch.targetY !== undefined ||
      patch.targetZ !== undefined;
    if (manual) host.tuning().cameraAutoFit = false;
    else if (patch.autoFit !== undefined) host.tuning().cameraAutoFit = patch.autoFit;
    // 先按取景框解一次（只在**要求**自动、且没有手动字段时），后面给的显式字段一律盖在它上面。
    if (patch.autoFit === true && !manual) {
      fitCameraRig(host.tuning().cameraFov, host.camera().aspect);
    }

    if (patch.targetX !== undefined || patch.targetY !== undefined || patch.targetZ !== undefined) {
      if (patch.targetX !== undefined) cameraRig.target.x = patch.targetX;
      if (patch.targetY !== undefined) cameraRig.target.y = patch.targetY;
      if (patch.targetZ !== undefined) cameraRig.target.z = patch.targetZ;
      // 观察点动了、相机没动 ⇒ 只有朝向变，所以是反解角度。
      syncCameraRigAngles();
    }
    if (patch.camX !== undefined || patch.camY !== undefined || patch.camZ !== undefined) {
      if (patch.camX !== undefined) cameraRig.position.x = patch.camX;
      if (patch.camY !== undefined) cameraRig.position.y = patch.camY;
      if (patch.camZ !== undefined) cameraRig.position.z = patch.camZ;
      syncCameraRigAngles();
    }
    if (patch.yawDeg !== undefined || patch.pitchDeg !== undefined || patch.distance !== undefined) {
      if (patch.yawDeg !== undefined) cameraRig.yaw = toRad(patch.yawDeg);
      if (patch.pitchDeg !== undefined) cameraRig.pitch = toRad(patch.pitchDeg);
      if (patch.distance !== undefined) cameraRig.distance = patch.distance;
      placeCameraRig();
    }

    host.applyCameraRigFromPanel();
    host.debugTools().refreshCameraControllers();
    // 带上 `autoFit`：不然脚本没法在一句话里验「手动字段是否顺手交出了所有权」
    // （面板那侧靠复选框显示，脚本没得看）。
    return { ...cameraRigReport(), autoFit: host.tuning().cameraAutoFit };
  },
  coinReport: () => host.coins().coinReport(),
  collection: () => ({
    balance: host.save().balance,
    coinSkins: [...host.save().snapshot.coinSkins],
    cabinetSkins: [...host.save().snapshot.cabinetSkins],
    selectedCoinSkin: host.save().snapshot.selectedCoinSkin,
    selectedCabinetSkin: host.save().snapshot.selectedCabinetSkin,
  }),
  clearSave: () => {
    host.save().clear();
    // 存档清了多少，内存态就同步多少——XIXI 是存档背书的进度，不同步就是假重置。
    host.setXixi([...host.save().snapshot.xixi]);
    host.collection().refresh();
    host.applySkins();
    return { balance: host.save().balance };
  },
  /**
   * 往钱包里补筹码（测试/调试用）。
   *
   * 存在的理由：**验证脚本会在同一个会话里反复 `startRun`，而一局就是把余额投到底**，
   * 脚本跑几条用例就把余额见底，于是下一局以 0 起始开局 —— 引擎会正确地以
   * 「开局即破产」响应（见 `startRun` 的零余额分支）。
   * 那些用例测的是玩法而不是破产，所以在 `startRun` 之前先补满。
   *
   * 充值额记进 `SaveStore` 的 `totals.refill`（旧名 `refilled`），
   * 余额守恒算式把它算进去（`run()` / `ledger()` 两个钩子都暴露）。
   */
  // R4-4b 的生命周期自证用（见 `PhysicsWorld.countColliders` 为何不进 diagnostics）。
  countColliders: () => host.physics().countColliders(),
  /**
   * S5a 四同「力」的对账读数：待发的加长行程**发数** + 引擎侧那次排了几发。
   * 判据要能分清「四同真的排了 N 发」与「只排了一发普通加力」——
   * 这两件事在画面上只差几个循环，看截图是判不出来的。
   */
  boostQueue: () => ({
    strokes: host.pusher().pendingBoostStrokes,
    jackpotStrokes: RULES.jackpotBoostStrokes,
    travelBonus: host.pusher().boostTravelBonus,
  }),
  // R4-4b 的「汇」：演出窗口内越线的枚数，按出处分成「演出币 / 存量币」。
  showWindow: () => ({
    crossings: host.showWindowCrossings(),
    foreign: host.showWindowForeign(),
  }),
  refillWallet: (amount = 200) => {
    host.save().refillWallet(amount);
    host.publishHud();
    return { balance: host.save().balance, refilled: host.save().refilled };
  },
  /**
   * 贷一笔款（S2）。返回**实际到账额**——到上限时它小于请求额，甚至为 0。
   *
   * 与 `refillWallet` 刻意分成两个钩子：`refillWallet` 是**验证脚本发钱**（记进 `refilled`，
   * 守恒式要减掉它），`loan` 是**游戏机制发钱**（记进 `debt` 与 `loanedTotal`）。
   * 合成一个的话，钱包守恒那条判据就分不出「白给的」与「借的」，
   * 而 S2 的全部意义就在这两者的区别上。
   */
  loan: (amount?: number) => {
    const applied = host.save().loan(amount);
    host.publishHud();
    return {
      applied,
      balance: host.save().balance,
      debt: host.save().debt,
      ceiling: host.save().debtCeiling,
      loanedTotal: host.save().loanedTotal,
    };
  },
  /** 只读欠款状态（判据与调试用，不改任何账）。 */
  debt: () => ({
    debt: host.save().debt,
    ceiling: host.save().debtCeiling,
    loanedTotal: host.save().loanedTotal,
    repaidThisRun: host.run().repaid,
    offer: host.save().loanOffer,
  }),
  /**
   * 走一次「贷款续玩」（S3）。返回 false = 什么都没发生
   * （不在破产态，或欠款已到顶 ⇒ 破产弹窗上那个按钮本来就该是藏着的）。
   *
   * ★ 判据要拿它验的是**盘面枚数不变**：这条路径不调 `startRun()`，
   * 所以调用前后 `coins().length` 必须逐枚相同。那是本功能唯一近确定性的判据。
   */
  loanToContinue: () => {
    const before = {
      onDeck: host.coins().activeCount(),
      chips: host.run().chips,
      loaned: host.run().loaned,
    };
    const applied = host.loanToContinue();
    return {
      applied,
      before,
      after: { onDeck: host.coins().activeCount(), chips: host.run().chips, loaned: host.run().loaned },
      debt: host.save().debt,
      ceiling: host.save().debtCeiling,
    };
  },
  /**
   * 把钱包设成指定值（验证脚本用）。
   *
   * 存在的理由：**「钱包见底 → 开局筹码 0」那条死锁必须能被确定性地构造出来。**
   * 靠反复 `startRun` 把 200 扣完要跑十局、又慢又不稳；直接置零才是一步到位的
   * 冷路径判据。差额记进 `SaveStore.refilled`，守恒式照样精确。
   */
  setWallet: (amount: number) => {
    host.save().setWallet(amount);
    host.publishHud();
    return { balance: host.save().balance, refilled: host.save().refilled };
  },
  unlockSkin: (kind: string, id: string, cost: number) => {
    const unlocked = host.save().unlockSkin(kind as 'coin' | 'cabinet', id, cost);
    host.collection().refresh();
    return { unlocked, balance: host.save().balance };
  },
  selectSkin: (kind: string, id: string) => {
    const selected = host.save().selectSkin(kind as 'coin' | 'cabinet', id);
    if (selected) host.applySkins();
    host.collection().refresh();
    return { selected, coinSkin: host.save().snapshot.selectedCoinSkin, cabinetSkin: host.save().snapshot.selectedCabinetSkin };
  },
  enableTelemetry: () => {
    host.telemetry().enable();
    return { enabled: true };
  },
  telemetry: () => host.telemetry().summary(),
  /** P4 投放演出：统一入口。返回值含承诺数/降级标记，事件进 telemetry.showEvents。 */
  showRequest: (id: string, opts?: { count?: number; kind?: CoinKind; x?: number }) =>
    host.shows().request(id as ShowId, opts),
  /**
   * 纯视觉币通道的读数 + 统计清零（S16）。
   *
   * 为什么需要它：这条通道**故意不进任何账本**，所以「它到底跑没跑」
   * 在 `activeCoins` / `earned` / `drained` 上一个字都看不出来。
   * 判据要证明的三件事都只能从这里读：
   *   ① `launched > 0` —— 演出真的喷了视觉币；
   *   ② `peakYOutside >= 1.6` —— 币是**从玻璃顶沿之上**飞出去的，不是穿过围板；
   *   ③ `active === 0 && visible === false` —— 演出结束后全部回收，空闲不占 draw call。
   */
  sprayReport: (reset = false) => {
    const snapshot = host.spray().report();
    if (reset) host.spray().resetStats();
    return snapshot;
  },
  /** 视觉币的材质与铜币材质是否同 defines（判据：证明 0 新增程序）。 */
  sprayMaterial: () => {
    const spray = host.spray().currentMaterial;
    const bronze = host.coins().materialFor('bronze');
    return {
      spray: { ...(spray.defines ?? {}) },
      bronze: { ...(bronze.defines ?? {}) },
      /**
       * 两张贴图的 **uuid**（不是内容）。
       *
       * 判据用它对两件事：① 换肤 / 改分辨率之后视觉币的贴图**真的重建了**
       * （uuid 变了）；② 它与铜币那张是**两个实例**——
       * 共享同一个实例会让 `CoinPool.dispose()` 把视觉币的贴图一起释放掉，
       * 那是零报错的静默失效（币渲染成空）。
       */
      sprayMap: spray.map?.uuid ?? null,
      bronzeMap: bronze.map?.uuid ?? null,
    };
  },
  /**
   * S18：数 scene 里挂 `map` 通道的机柜部件材质数。
   *
   * 招牌 + 得分线 + 热区三件都挂了——剩 0 表示漏挂，剩 > 3 表示别处加了。
   */
  cabinetMapCount: () => {
    let count = 0;
    const seen = new Set<THREE.Material>();
    host.scene().traverse((child) => {
      if (!(child as THREE.Mesh).isMesh) return;
      const mesh = child as THREE.Mesh;
      const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const entry of list) {
        if (!isLitMaterial(entry)) continue;
        if (seen.has(entry)) continue;
        seen.add(entry);
        if (entry.map) count += 1;
      }
    });
    return count;
  },
  /**
   * 装置规模表（枚数 / 最低交付）。
   *
   * 判据写「实发 = 承诺」时必须**读这张表**而不是手抄数字——
   * S6 把塔从 1 枚改到 16 枚是配置变更，不是回归。
   */
  showSpecs: () => ShowDirector.showSpecs(),
  /**
   * 「加力已存满」的兜底配置（P10 ⑨）。
   *
   * 判据同样**从引擎读**：兜底用哪个装置、发几枚都是可调的平衡旋钮，
   * 抄进脚本就成了第二份真源。
   */
  boostOverflowSpec: () => ({ ...BOOST_OVERFLOW_FALLBACK, cap: RULES.boostStoreCap }),
  /**
   * 自动补币的配置（P10 ⑦）。
   *
   * 判据**从引擎读阈值**，不在脚本里手抄 180 / 8 / 7：那些是可调的平衡旋钮，
   * 抄一份到测试里，S11 标定时判据就会开始骗人（改配置却报红，或者更糟——
   * 配置改了判据还在用旧值，于是它测的根本不是线上那套数）。
   */
  refillSpec: () => ({ ...REFILL, budget: COIN.budget }),
  /**
   * 得分反馈分级（P10 ⑨）。
   *
   * 判据**从引擎读阈值**（飞字大号 25 / 连落 3 脉冲 / 连落 5 白闪），
   * 不在脚本里手抄——S11 标定时会调它们，抄一份到测试里就会开始骗人。
   * 峰值一并给出：判据要核对「脉冲确实到了峰值」而不是只涨了一点点。
   */
  feedbackSpec: () => ({
    ...FEEDBACK,
    emissive: { ...FEEDBACK_EMISSIVE },
  }),
  /**
   * 反馈分级的**纯函数**（判据枚举边界点，不重写分支）。
   *
   * 输入只给「筹码 / 连落 / 是否热区 / 币种」，`kindClimax` 由引擎自己
   * 从 `kindSpec()` 取——币种的高潮定义单一真源在 `kinds.ts`，
   * 让测试传进来等于把它抄成第二份。
   */
  crossingFeedbackProbe: (input: {
    chips: number;
    combo: number;
    hot: boolean;
    kind?: string;
    blocked?: boolean;
  }) =>
    crossingFeedback({
      chips: input.chips,
      combo: input.combo,
      hot: input.hot,
      kindClimax: kindSpec((input.kind ?? 'bronze') as CoinKind).climax,
      blocked: input.blocked,
    }),
  /**
   * 反馈的**实时状态**：计数 + 三个材质的自发光。
   *
   * 计数与画面同源（都由 `crossingFeedback()` 的结果驱动），所以判据读它们
   * 就能同时证明「分支走对了」与「视觉真的动了」——只读计数会漏掉
   * 「计数在涨但材质没接上」这种半接线状态。
   */
  feedbackReport: () => host.feedbackReport(),
  /**
   * 直接走一次飞字（测试用）：坐标是合成的，**代码路径是真的**
   * （`Hud.flyScore` + `flyTier` 的分档判定）。
   *
   * 存在的理由：`chips ≥ 25` 的入账要靠高价值币越线才出得来，
   * 而「大号飞字有没有生效」不该等一枚钻石走到线上才能验。
   */
  flyScoreProbe: (chips: number) => {
    const tier = flyTier(chips);
    // ★ **刻意不动 `feedbackCounts`**：计数属于引擎那条路（`settleCrossing`），
    //   这条探针只验表现层（`Hud.flyScore` 有没有按档位画）。
    //   两者混在一起之后，「真实对局里出了几次大号飞字」就再也说不清了。
    host.hud().flyScore(640, 360, chips, tier);
    return {
      tier,
      datasetTier: document.querySelector('#hud')?.getAttribute('data-last-fly-tier') ?? null,
    };
  },
  /** XIXI 槽位映射（引擎纯函数）：判据枚举调用它收成集合，不在测试里手写分段。 */
  xixiSlot: (x: number) => xixiSlot(x),
  /**
   * 直接设定 XIXI 四槽的亮灭（测试用）。
   *
   * 存在的理由：四槽要**真的投中**才会亮，而「哪个落点进哪个槽」是物理决定的，
   * 想凑出「槽 0 与槽 2 亮、槽 1 与 3 灭」这种指定组合得投很多枚。
   * 这条路径只改渲染状态（`host.xixi()` + 推板标牌），不碰存档、不碰遥测。
   */
  setXixi: (slots: boolean[]) => {
    host.setXixi(slots.map(Boolean).slice(0, 4));
    while (host.xixi().length < 4) host.xixi().push(false);
    host.publishHud();
    return host.pusher().xixiLaneReport();
  },
  /** 推板前缘 XIXI 标牌的实际颜色（判据按计数比对，不看截图）。 */
  xixiLanes: () => host.pusher().xixiLaneReport(),
  /**
   * 直接摇一次背板老虎机（可指定符号）。
   * 奖励路径必须可逐一指定验证：「力力力→加力入账且 earned 不动」、
   * 「塔塔塔→ShowDirector 登记」，不能靠权重随机去赌。
   */
  xixiSpin: (forced?: string, tier?: SlotTier | null) => {
    // ⚠️ `?? 3` 而不是直接把 `tier` 传下去：TS 的默认参数只在 `undefined` 时生效，
    // 而脚本从页面外面传进来的是 `null` —— 不夹的话强制三同会摇出一个 `tier: null` 的结果，
    // 四同分支判断 `tier === 4` 为假、时间轴判断也跟着走空。
    const result = host.slotMachine().spin(
      forced as SlotSymbol | 'fine' | 'miss' | undefined,
      tier ?? 3,
    );
    if (!result) return null;
    return {
      kind: result.outcome.kind,
      symbol: result.outcome.kind === 'win' ? result.outcome.symbol : undefined,
      tier: result.outcome.kind === 'win' ? result.outcome.tier : undefined,
      faces: host.slotMachine().reelWindowReport().faces,
    };
  },
  /** 滚筒窗读数（与诊断同一个读数，见 `reelDiagnostics`）。 */
  reelWindowReport: () => host.reelDiagnostics(),
  /** 像素图标图集的读数：来源、尺寸、每格调色板大小。 */
  iconReport: () => iconReport(),
  /**
   * 结果表的实测分布：把 `rollSlotOutcome` 在 `[0,1)` 上均匀枚举。
   *
   * ★ S5a：计数桶**按权重表的键开**（`SLOT_OUTCOME_KEYS`），并把权重表本身与
   * 符号数一起吐出去 ⇒ 判据拿「枚举出来的比例」对「引擎自己的表」，
   * 测试里不再出现 45/15/40 与「5 个符号」这类第二份事实。
   * 加一档（win4）或改权重，判据自己跟上；反过来**表写漏一格也会当场红**
   * （计数键不在表里 → Σcounts ≠ samples）。
   */
  slotOdds: (samples = 2000) => {
    const total = Math.max(1, Math.floor(samples));
    const counts: Record<string, number> = {};
    for (const key of SLOT_OUTCOME_KEYS) counts[key] = 0;
    const symbols: Record<string, number> = {};
    const tier4SymbolsSeen: Record<string, number> = {};
    /**
     * `detailRoll` 走**独立的确定性 LCG**（不引入 `Math.random`：判据要可复现）。
     *
     * ⚠️ 不能两个 roll 都用 `i / total`：那样「中奖摇哪个符号」与分类完全相关，
     * 枚举一遍只会摇出同一个符号（实测：2000 次全是 boost，看起来像「符号表只有一项」）。
     * 分类比例要精确 → `roll` 等距枚举；符号分布要真实 → `detailRoll` 伪随机。
     */
    let seed = 0x2545f491;
    const nextDetail = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x80000000;
    };
    for (let i = 0; i < total; i += 1) {
      const outcome = rollSlotOutcome(i / total, nextDetail());
      counts[outcomeWeightKey(outcome)] += 1;
      if (outcome.kind === 'win') {
        symbols[outcome.symbol] = (symbols[outcome.symbol] ?? 0) + 1;
        if (outcome.tier === 4) {
          tier4SymbolsSeen[outcome.symbol] = (tier4SymbolsSeen[outcome.symbol] ?? 0) + 1;
        }
      }
    }
    return {
      samples: total,
      counts,
      symbols,
      weights: { ...SLOT_OUTCOME_WEIGHTS },
      totalWeight: outcomeTotalWeight(),
      /** 符号池大小由引擎给：判据断「无死项」时读它，不写 5。 */
      symbolCount: SLOT_SYMBOL_WEIGHTS.length,
      /** 符号名单本身（判据要「逐符号」核画面时读它，不在测试里抄第二份五个符号）。 */
      symbolList: SLOT_SYMBOL_WEIGHTS.map((entry) => entry.symbol),
      /** 四同池成员与**枚举里真的摇到过的符号**：判据据此核「池里没有死项、池外没人混进来」。 */
      tier4Symbols: [...SLOT_TIER4_SYMBOLS],
      tier4SymbolsSeen,
    };
  },
  /**
   * 停格画面的枚举：给定结果，`reelFacesFor` 沿 `detailRoll` 轴扫一遍。
   * 判据用它核「四同四连、三同差一格、杂牌两两不同」，不在测试里重写这段规则。
   */
  reelFaces: (kind: string, symbol?: string, tier?: SlotTier) => {
    const outcome: SlotOutcome =
      kind === 'fine'
        ? { kind: 'fine' }
        : kind === 'miss'
          ? { kind: 'miss' }
          : { kind: 'win', symbol: (symbol ?? 'boost') as SlotSymbol, tier: tier ?? 3 };
    const out: string[][] = [];
    for (let i = 0; i < 25; i += 1) out.push(reelFacesFor(outcome, i / 25));
    return out;
  },
  /**
   * 1a 比例制罚款的**表与算式**（只读）。
   *
   * 判据不许自己写 10% / 40% / 90 投的第二份抄本，也不许自己写线性插值 ——
   * 一律调这里的 `ratioAt` / `amountFor`，它们就是 `xixi.ts` 那两个函数本身。
   * 端点由判据用**字面量**钉住（0.1 / 0.4 是用户拍板的设计值，不是从实现读回来的数），
   * 否则"改了表判据也跟着改"就成了自证。
   */
  fineRule: () => ({
    ratioFloor: FINE_RATIO_FLOOR,
    ratioCeil: FINE_RATIO_CEIL,
    rampDrops: FINE_RAMP_DROPS,
    ratioAt: (progress: number) => fineRatio(progress),
    amountFor: (balance: number, progress: number) => fineAmount(balance, progress),
  }),
  /**
   * 用**合成金额**走一遍罚款结算的两步（`RunState.fineChips` → `SaveStore.chargeFine`）。
   *
   * 存在的理由（10-07 用户拍板 A）：比例制上限 40% ⇒ 真实玩法里 `shortfall` 恒为 0，
   * 「扣不掉转欠款 + 欠款上限 clamp」这套机器**从玩法到达不了**。要么把它当死代码放着不测，
   * 要么直接喂一个超过余额的金额 —— 选后者：它是承重结构（S5b 的原始理由），
   * 不测就等于把 clamp 与 debt 上限的回归敞着。
   *
   * ⚠️ 这两步是 `Game.ts` 里 SlotMachine deps 那份组合的**镜像**（同样
   *   `fineChips` → `chargeFine` → `publishHud`）。镜像万一与真接线走散也不会静默：
   *   真玩法那条由 xixi 模式的逐事件恒等门覆盖（`applied === requested` 且 `debtAdded === 0`）。
   */
  /**
   * 直接触发一次**币种效果**（Stage 2 的催债币 / 票币），返回两侧读数。
   *
   * 存在的理由与前两条同族：真让一枚效果币走完台面要几分钟物理，
   * 而"结算走的是那一条唯一出口、并且留了归因"这件事本身是**结算逻辑**，可以定点验。
   * 真实越线那条**接线**由 economy 批的逐局恒等门覆盖（效果币按 `effects.ts` 的表自动注入）。
   */
  coinEffectTrigger: (effect: string) => {
    const read = () => ({
      chips: host.run().chips,
      fines: host.run().fines,
      spent: host.run().spent,
      debt: host.save().debt,
      earned: host.run().earned,
      /** 票券侧（`ticketCoin` 那条腿吃它）：筹码五个字段对它一律不动。 */
      tickets: host.run().tickets,
      ticketEarned: host.run().ticketEarned,
      ticketEffect: host.run().ticketBySource.effect,
    });
    const before = read();
    const id = effect as CoinEffectId;
    const triggersBefore = host.coinEffects().coinEffectReport().byEffect[id]?.triggers ?? 0;
    host.coinEffects().dispatchCoin(id);
    host.publishHud();
    const report = host.coinEffects().coinEffectReport();
    return {
      before,
      after: read(),
      report,
      /** 本次是否真的多了一条触发（`effect` 不认识时为 false —— 别把空操作读成生效）。 */
      fired: (report.byEffect[id]?.triggers ?? 0) > triggersBefore,
      statusLine: document.querySelector('#status-line')?.textContent ?? '',
    };
  },
  applyFine: (amount: number) => {
    const read = () => ({
      chips: host.run().chips,
      fines: host.run().fines,
      spent: host.run().spent,
      debt: host.save().debt,
    });
    const before = read();
    const { applied, shortfall } = host.run().fineChips(amount);
    const debtAdded = host.save().chargeFine(shortfall);
    host.publishHud();
    return {
      requested: amount,
      applied,
      shortfall,
      debtAdded,
      before,
      after: read(),
      ceiling: host.save().debtCeiling,
    };
  },
  /**
   * 合成地走 N 次「一枚币越线」的票券入口（`RunState.noteCrossing`）。
   *
   * 存在的理由与 `applyFine` 同一条：**真攒 12 枚越线要等约 27 分钟的物理行程**
   * （`TICKET_EVERY_CROSSINGS = 12`，而薄床下单枚币走完台面要四位数循环），
   * 判据不能靠"恰好走到"。这里驱动的是**引擎自己那个函数**，不是另写一份计数逻辑，
   * 所以它验的是状态机（发券、分源、待办标记），不是接线。
   * ⚠️ 接线（`Game.settleCrossing` 真的会调它）由 economy 的逐局恒等门覆盖，不在这里。
   */
  noteCrossings: (count: number) => {
    const run = host.run();
    const n = Math.max(0, Math.floor(count));
    for (let i = 0; i < n; i += 1) run.noteCrossing(0);
    host.publishHud();
    return {
      asked: n,
      crossings: run.crossings,
      tickets: run.tickets,
      ticketEarned: run.ticketEarned,
      ticketSpent: run.ticketSpent,
      ticketEvery: run.ticketEvery,
      wave: run.wave,
      waveTickets: run.waveTickets,
      pendingDraft: run.pendingDraft,
    };
  },
};
}
