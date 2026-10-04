/**
 * 诊断快照的装配（S4，从 `Game.ts` 机械搬出）。
 *
 * ⚠️ 两条不能改的规矩：
 *   ① 所有读数走 `host` 的**闭包** —— 值必须在发布那一刻现取；袋子里存值就等于造出第二份状态
 *      （画面一份数、判据一份数，是本项目反复出事的病根）。
 *   ② `window.__THREE_GAME_DIAGNOSTICS__ = ` 这条赋值**留在 Game 里** —— `hooks` 的 M0-a 数的就是
 *      它的装配点必须只有一个，所以本模块只 `return`，不负责发布。
 */
import type { DiagnosticsHost } from '../Game';
import { FINAL_PASS_SHADOW_RANGE, FINAL_PASS_SHADOW_TINT } from '../../render/FinalPass';
import { round3 } from '../../utils/numeric';
import { coinPhysics } from '../coinPhysics';
import { ENDLESS, RULES, TABLE } from '../constants';
import { ledgerBalances } from '../economy';

export function build(host: DiagnosticsHost) {
const info = host.renderer().info;
const snapshot = host.run().snapshot();
const canvas = host.renderer().domElement;
return {
  frame: host.frame(),
  elapsed: host.elapsed(),
  phase: snapshot.phase,
  // S4 合并账户后的恒等式：`balance = initial + earned + begged + loaned − spent`
  chips: snapshot.chips,
  initial: snapshot.initial,
  earned: snapshot.earned,
  begged: snapshot.begged,
  loaned: snapshot.loaned,
  spent: snapshot.spent,
  /** 本局被分流抵债的累计额（S2）。不进恒等式，与 `fines` 同族，见 `RunState.repaid`。 */
  repaid: snapshot.repaid,
  /** ★ 恒等式的唯一真源（`economy.ledgerBalances`）——诊断快照与 `ledger()` 钩子共用这一个函数。 */
  balanced: ledgerBalances(host.run().ledger),
  /** 可花余额（扣掉跪来的那一份）——脏钱约束在合并之后唯一的执行点。 */
  spendable: host.save().spendable,
  balance: host.save().balance,
  bestCombo: snapshot.bestCombo,
  /** XIXI 四槽亮灭（跨局持续；点亮/集齐事件在 telemetry.xixiEvents）。 */
  xixi: [...host.xixi()],
  /**
   * 本局被老虎机罚掉的筹码（P10 的胡萝卜四连）。
   *
   * 它是**独立的对账口径**：`fines` 不进恒等式（已含在 `spent` 里），
   * 所以判据要同时看「`fines` 涨了多少」与「`spent ≥ fines`」两件事。
   */
  fines: host.run().fines,
  boostCharges: snapshot.boostCharges,
  settleReason: snapshot.settleReason,
  /** 收尾阶段推板是否已停板（扫板的开放条件）。 */
  plateStopped: snapshot.plateStopped,
  activeCoins: host.coins().activeCount(),
  /**
   * 本局累计越线结算枚数（`settledCoins`，开局归零）。
   * 和 `activeCoins` 配成一条**守恒式**才判得了「币有没有凭空消失」：
   * 只比两个时刻的 `activeCoins` 是把「推板照常结算」也算成了丢币（实测假红过 330→323）。
   */
  settledCoins: host.settledCoins(),
  anomalies: host.anomalyCount(),
  /**
   * 掉进币床前侧角下水道的币数（P10 的「汇」，见 `DRAIN`）。
   *
   * ★ **必须与 `anomalies` 分开读**：两者都让盘面少一枚币，但一个是设计好的
   * 合法损失、一个是缺陷。混在一起就再也分不清「洞开得太大」和
   * 「求解器又把币甩出机柜了」。逐枚现场在 `telemetry().drainEvents`。
   */
  drained: host.drainCount(),
  /**
   * 币床上的活跃币数与自动补币的触发次数（P10 ⑦）。
   *
   * ★ `bedCoins` 是**上一轮盘点的值**（每 `REFILL.checkEvery` 秒刷一次），
   * 不是当帧值。判据要先等一个盘点周期再读，否则会把补币前的旧读数当成「没生效」。
   *
   * ★ 它**不能**用 `activeCoins` 代替：后者含正在下落的、演出排队没落的、
   * 上层台面的币，盘面掏空时它仍是三位数（见 `CoinPool.countBed()`）。
   */
  bedCoins: host.bedCoins(),
  refills: host.refillCount(),
  /**
   * 此刻停在**推板顶面**（台面输送带）上的活跃币数。
   *
   * 这条读数是「补货的币到没到币床」的**现场**：闸门从背板吐币，币先落在顶面、
   * 被输送带送过前缘才掉进币床。若输送不带它们走，这 7 枚就会**停在顶面**
   * ——`activeCoins` 照涨 7，`bedCoins` 一动不动。只有顶面枚数能区分
   * 「还在路上」与「卡住了」。
   *
   * 与输送共用 `isOnDeck` 一份判据（不写第二份），所以它不受降动效影响。
   */
  deckCoins: host.countDeckCoins(),
  /** 异常币飞出时的坐标与速度（`anomalies > 0` 时用它定位，最多 12 条）。 */
  anomalySamples: host.anomalySamples(),
  /**
   * 速度护栏的计数与峰值（见 `COIN.maxSpeed`）。
   *
   * **这是「求解器还在不在造能量」的直接读数**：围板补上之后 `anomalies` 恒为 0
   * 是必然的（币根本出不去），所以它不再是有效判据；`spikeClamps` 才是。
   */
  spikeClamps: host.spikeClamps(),
  peakSpikeSpeed: round3(host.peakSpikeSpeed()),
  peakPostClampUpward: round3(host.peakPostClampUpward()),
  // 钉阵：网格是显示长度，碰撞体是物理长度，两者刻意不同（只改显示不改物理）。
  pegs: {
    count: host.pegs().count,
    colliderHalfLength: host.pegs().colliderHalfLength,
    visualHalfLength: host.pegs().visualHalfLength,
  },
  input: {
    lane: round3(host.lastIntent()?.lane ?? 0),
    laneX: round3(host.lastIntent()?.laneX ?? 0),
    mode: host.lastIntent()?.mode ?? 'auto',
    manualHoldLeft: round3(host.lastIntent()?.manualHoldLeft ?? 0),
  },
  motion: {
    reduced: host.motion().reduced,
    source: host.motion().source,
  },
  /*
   * 音频子系统摘要。
   *
   * `loadedSamples === 0` 是最有用的一个读数：它说明**全部事件都在走合成音兜底**
   * （旧 Safari 不支持 Ogg Vorbis，或素材没取到）。没有这个字段的话，
   * 「音效没变」和「音效加载失败」在脚本层面完全无法区分。
   */
  audio: host.audio().debug,
  // 机关：剩余次数与币预算余量（后装填会撞预算上限）。
  mechanisms: {
    ...host.mechanismSnapshot(),
    coinsRemaining: host.coins().remaining,
    // P7：停板窗口的宽度与「一个推板循环」的长度。
    // 判据要拿它们算「窗口 ≥ 2 个循环」，而不是在脚本里手抄 4.8 这个数。
    restHold: RULES.restHold,
    // 从推板读而不是读 `PUSHER_PERIOD` 常量：相位时长可调，常量会陈旧。
    // `scripts/verify-game.mjs` 正是从这里推导推进率基线。
    pusherPeriod: host.pusher().period,
  },
  // 投放演出：两态判据读这个——registered 时币尚未动，completed 时币已到位。
  shows: { busy: host.shows().busy, queued: host.shows().queued, active: host.shows().activeId },
  // 加注档位：`mul` 是越线返值倍率（押 5 枚 = ×4，押越大单位期望越低）。
  bet: {
    index: host.betIndex(),
    chips: ENDLESS.bets[host.betIndex()].chips,
    mul: ENDLESS.bets[host.betIndex()].mul,
  },
  // 热区：亮条位置（无尽恒开）。
  hotZone: {
    active: host.config().hotZone,
    x: round3(host.hotZoneX()),
    halfWidth: TABLE.hotZone.halfWidth,
  },
  // 本局：筹码、存活投数、筹码峰值、破产弹窗状态。
  endless: {
    active: true,
    begs: host.begsThisRun(),
    totalBegs: host.save().begCount(),
    drops: snapshot.drops,
    chipsPeak: snapshot.chipsPeak,
    bestEarned: host.save().snapshot.bestEarned,
    ruinVisible: host.hud().ruinVisible,
    // 大赏币注入间隔。测试读这里而不是写死数字：P8 重新标定时
    // 硬编码的 15/30 会让断言变成假失败，而它其实只是配置。
    bountyEveryDrops: ENDLESS.bountyEveryDrops,
    /**
     * 一个**标准注额**（`ENDLESS.buyIn`）。S4 合并账户之后它不再是「每局买入」——
     * 一局的入场额就是全部余额 —— 它现在只有两个读者：贷款额的基准，
     * 以及 `economy` 批用来把局长口径对齐到旧标定（脚本里不抄第二份常量，同一个理由）。
     */
    referenceStake: ENDLESS.buyIn,
    // 本局已注入的大赏币枚数（注入率断言的分子）。
    bounties: snapshot.bounties,
  },
  pusher: {
    offset: host.pusher().offset,
    phase: host.pusher().currentPhase,
    running: host.pusher().running,
    /** 演出期「停在回收位」的闸门是否合上（判据要能分清「没在推」与「被演出按住」）。 */
    parked: host.pusher().isParked,
    cycles: host.pusher().cyclesCompleted,
    frontFaceZ: host.pusher().frontFaceZ,
  },
  physics: {
    bodies: host.physics().bodyCount,
    colliders: host.physics().colliderCount,
    substeps: host.physics().substeps,
    // 诊断里带上当前物理旋钮：穿模/节奏的每一条实测记录都必须能对应到一组参数上，
    // 否则「这次跑为什么不一样」永远查不出来。
    tuning: {
      ...host.physics().tuning,
      coinSolverIterations: host.tuning().coinSolverIterations,
      // 下面两块一律读**实际生效值**（注册表 / 推板实例字段），不读调参表：
      // 调参表只是 UI 的镜像，真正参与求解的是这两处。
      coin: {
        density: coinPhysics.density,
        friction: coinPhysics.friction,
        restitution: coinPhysics.restitution,
        linearDamping: coinPhysics.linearDamping,
        angularDamping: coinPhysics.angularDamping,
        maxSpeed: coinPhysics.maxSpeed,
        maxUpwardSpeed: coinPhysics.maxUpwardSpeed,
        upwardBleedTau: coinPhysics.upwardBleedTau,
      },
      pusher: {
        travel: host.pusher().travel,
        extendSec: host.pusher().durations.extend,
        holdFrontSec: host.pusher().durations.holdFront,
        retractSec: host.pusher().durations.retract,
        holdBackSec: host.pusher().durations.holdBack,
        boostTravelBonus: host.pusher().boostTravelBonus,
        period: host.pusher().period,
      },
    },
  },
  performance: {
    fps: round3(host.governor().fps),
    tier: host.governor().current.tier,
    /** 画质锁是否合上（10-01）。`tier` 相同而 `locked` 不同是两种完全不同的状态。 */
    locked: host.governor().isFrozen,
    // 像素分辨率（V1）：取代了旧的 maxDpr。`upscale` 是整数倍率，
    // `internalHeight` 是实际内部渲染高度（CSS 像素）。
    pixelTargetHeight: host.tuning().pixelTargetHeight,
    pixelated: host.pixelScale().pixelated,
    upscale: host.pixelScale().upscale,
    internalHeight: host.pixelScale().internalHeight,
    shadows: host.governor().current.shadows,
  },
  collection: {
    balance: host.save().balance,
    coinSkin: host.save().snapshot.selectedCoinSkin,
    cabinetSkin: host.save().snapshot.selectedCabinetSkin,
    coinSkins: host.save().snapshot.coinSkins.length,
    cabinetSkins: host.save().snapshot.cabinetSkins.length,
  },
  /**
   * 贷款 / 欠款（S2）。`repaid` 是**本局**被分流抵债的累计额（`RunState.repaid`，
   * 不进三账本恒等式），所以「gross 产出」= `earned + repaid` —— economy 的稳态判据
   * 读的就是 `repaid / (earned + repaid)` 这个分流率。
   */
  debt: {
    debt: host.save().debt,
    ceiling: host.save().debtCeiling,
    loanedTotal: host.save().loanedTotal,
    repaidThisRun: host.run().repaid,
  },
  reel: host.reelDiagnostics(),
  renderer: {
    // 同 `materialReport()`：两遍出画之后 `info` 只剩最后一遍，这里要的是整帧的数。
    calls: host.frameDrawCalls(),
    triangles: host.frameTriangles(),
    geometries: info.memory.geometries,
    textures: info.memory.textures,
    /**
     * 描边的**当前生效值**（不是出厂值、不是调参表的镜像）。
     *
     * 立硬判据的前提是「判据读得到被审的那个数」：强度现在由 `tuning` 驱动
     *（面板与测试都能改），如果快照里只有物理那几项，判据就只能自己抄一份默认值 ——
     * 那就是第二份真源，改默认的人不会记得改它（与 `detailEnabled` 同一条理由）。
     */
    outline: {
      scale: host.tuning().outlineScale,
      ...host.finalPass().outlineThresholds,
    },
    /**
     * 暗部分级的**当前生效值**：grade 走 tuning（面板/测试都能改，恒等门读的就是它），
     * tint/range 是常量所以直接报——它们没有被第二份可改的副本，不构成第二真源。
     */
    shadow: {
      grade: host.tuning().shadowGrade,
      tint: FINAL_PASS_SHADOW_TINT,
      range: FINAL_PASS_SHADOW_RANGE,
    },
  },
  canvas: {
    clientWidth: canvas.clientWidth,
    clientHeight: canvas.clientHeight,
    width: canvas.width,
    height: canvas.height,
    /** 真实 DPR（设备像素 / CSS 像素）。**只作诊断**，不再参与分辨率计算。 */
    dpr: window.devicePixelRatio || 1,
    /** backing store 与 CSS 尺寸的整数比（= `pixelScale.upscale`）。 */
    upscale: host.pixelScale().upscale,
  },
};
}

