import * as THREE from 'three';
import { InputController, type LaneInput, type LaneMode } from '../core/InputController';
import { Loop } from '../core/Loop';
import { createRenderer, resizeRenderer } from '../core/Renderer';
import { Coin } from '../entities/Coin';
import { CoinPool } from '../entities/CoinPool';
import { Pusher } from '../entities/Pusher';
import { AudioSystem } from '../systems/AudioSystem';
import { CollectionPanel } from '../systems/CollectionPanel';
import { DebugTools, createDefaultTuning, type GameTuning } from '../systems/DebugTools';
import { Hud, type MechanismSnapshot } from '../systems/Hud';
import { Mechanisms, MECHANISM_COST } from '../systems/Mechanisms';
import { ShowDirector, type ShowId } from '../systems/ShowDirector';
import { MotionPrefs } from '../systems/MotionPrefs';
import { PerformanceGovernor, type QualityTier } from '../systems/PerformanceGovernor';
import { PhysicsWorld } from '../systems/PhysicsWorld';
import { RunState } from '../systems/RunState';
import { SaveStore } from '../systems/SaveStore';
import { SlotMachine } from '../systems/SlotMachine';
import { applyCabinetSkin, buildTable } from '../systems/TableBuilder';
import { Telemetry } from '../systems/Telemetry';
import { RAPIER } from '../systems/PhysicsWorld';
import { createSeededRandom } from '../utils/random';
import { COLORS, COIN, COIN_KIND, ENDLESS, RULES, TABLE, type CoinKind } from './constants';
import { cabinetSkinById, coinSkinById } from './cosmetics';
import { BET_TIERS, betTier, crossingReturn } from './economy';
import { endlessLevel, type EndlessConfig } from './endless';
import { layoutValue } from './layout';
import { xixiSlot, type SlotSymbol } from './xixi';

/**
 * 镜头取景框。
 *
 * 竖直方向同时受机台高度与纵深影响——俯角越大，纵深在画面里占的高度越多。
 * `verticalExtent` 是取景框在「相机上方向」上的投影长度，已经含 12% 余量，
 * 并把中心向下偏置，免得币床和得分线被底部 HUD 压住。
 *
 * 推导（俯角 26°，机台取 y∈[-0.06,1.55]、z∈[-1.05,1.45]）：
 *   投影极值 u = y·cos - z·sin → [-0.690, 1.853]，跨度 2.543
 *   加上余量与下偏置后取 2.8，中心 u 由 0.582 下移到 0.398
 *   反解出 lookAt = (0, 0.54, 0.20)；此时落币口在画面上沿 93%、得分线在 64%、托盘在 81%，
 *   上下都留出了空间给 HUD。
 */
const CAMERA_FIT = {
  halfWidth: 0.95,
  verticalExtent: 2.8,
  centerY: 0.54,
  centerZ: 0.2,
  pitch: (26 * Math.PI) / 180,
};

/** 高于此高度视为「在途」，收尾时先等它们落到台面。 */
const IN_FLIGHT_Y = 0.55;

/** 选位遥测的采样间隔（秒）。50ms 足够看出速度曲线，又不会把数组撑爆。 */
const LANE_SAMPLE_INTERVAL = 0.05;

/** 自发光闪烁：持续时长与峰值增量。 */
const FLASH_SECONDS = 0.22;
const FLASH_PEAK = 0.85;

/**
 * 编排层：持有世界、实体与规则，按固定顺序推进。
 *
 * 更新顺序：输入意图 → 固定步长物理 → 通道/出口事件 → 得分与返币 → 胜负状态 → HUD。
 */
export class Game {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(42, 1, 0.05, 40);
  private readonly hud = new Hud();
  private readonly audio = new AudioSystem();
  private readonly save = new SaveStore();
  private readonly tuning: GameTuning = createDefaultTuning();
  private readonly loop: Loop;

  private readonly physics: PhysicsWorld;
  private readonly coins: CoinPool;
  private readonly pusher: Pusher;
  /** 四个机关：扫板 / 抓斗 / 后装填 / 风险转轮。 */
  private readonly mechanisms: Mechanisms;
  private readonly shows: ShowDirector;
  private readonly slotMachine: SlotMachine;
  /**
   * XIXI 四槽亮灭（P5）。**不进 RunState**：它是跨局持续的收集进度
   * （存档 `coin-pusher:save:v4` 的 xixi 字段），每局重置的是账本，不是收集线。
   */
  private xixi: boolean[];
  /** 集齐时老虎机正在转：排队一次，转完补摇（集齐奖励不允许被吞）。 */
  private pendingXixiSpin = false;
  private readonly input: InputController;
  private readonly debugTools: DebugTools;
  private readonly governor = new PerformanceGovernor();
  private readonly collection: CollectionPanel;
  private readonly telemetry = new Telemetry();
  private drainRecorded = false;
  private tableGroup: THREE.Group | null = null;
  /** 钉阵长度信息：网格长度是显示值，碰撞体长度是物理值，刻意不同。 */
  private readonly pegs = { count: 0, colliderHalfLength: 0, visualHalfLength: 0 };
  /** 选位遥测：上一帧的模式与采样计时。 */
  private lastLaneMode: LaneMode = 'auto';
  private laneSampleTimer = 0;
  /** 最近一帧的输入意图，供诊断对象读取（选位模式、落点）。 */
  private lastIntent: LaneInput | null = null;
  /** 落币口材质：投币时闪一下。 */
  private spitterMaterial: THREE.MeshStandardMaterial | null = null;
  /** 正在衰减的自发光闪烁（材质 → 基准强度与剩余时间）。 */
  private readonly flashes = new Map<THREE.MeshStandardMaterial, { base: number; life: number }>();

  private run: RunState;
  private readonly config: EndlessConfig;
  /** 本局的跪求次数。 */
  private begsThisRun = 0;
  /** 破产弹窗是否正在显示。 */
  private ruinVisible = false;
  /** 结算卡片是否正在显示。 */
  private summaryVisible = false;
  /** 加注档位下标（0 = 1 投 · ×1）。 */
  private betIndex = 0;
  /** 热区高亮条与它当前的世界 x（无尽恒开，见 EndlessConfig.hotZone）。 */
  private hotZoneStrip: THREE.Mesh | null = null;
  private hotZoneX = 0;
  private hotZoneDir: 1 | -1 = 1;
  private rng = createSeededRandom(1);
  private seedOverride: number | null = null;

  private frame = 0;
  private elapsed = 0;
  private dropCooldown = 0;
  private paused = false;
  private pausedForScreenshot = false;
  /** 动效偏好：系统媒体查询 + 测试覆盖，CSS 与 JS 共用同一个信号。 */
  private readonly motion = new MotionPrefs();
  private restTimer = 0;
  private settleWindow = 0;
  private anomalyCount = 0;
  /**
   * 最近几次「异常」发生时那枚币在哪。诊断用，最多留 12 条。
   *
   * **异常币会被立刻 `despawn()`**，所以事后再看盘面是看不到它们的
   * （实测：`coins()` 里已经查不到任何越界币，只留下一个变小的 `activeCoins`）。
   * 「异常 = 币飞出机柜」这条判据必须能说出**它从哪儿出去的、当时多快**，
   * 否则只剩一个计数，等于没有信息。
   */
  private anomalySamples: Array<{
    frame: number;
    kind: string;
    x: number;
    y: number;
    z: number;
    vx: number;
    vy: number;
    vz: number;
    speed: number;
  }> = [];
  /**
   * 速度护栏的遥测（见 `COIN.maxSpeed` 的注释）。
   *
   * 存在的意义是**让修法本身可被检验**：如果只压速度、不留数，那么「求解器还在不在
   * 造能量」就重新变成不可见——币不再飞出机柜，缺陷却还在，只是被盖住了。
   * 这两个数让判据可以问一个更准的问题：不是「有没有币飞出去」（被围板挡住之后
   * 必然为 0，什么都说明不了），而是「**还有没有能量注入**」。
   */
  private spikeClamps = 0;
  private peakSpikeSpeed = 0;
  /** 本局累计越线枚数（遥测用：节奏测量不能被热度倍率污染）。 */
  private settledCoins = 0;
  private drainPromptVisible = false;
  private readonly laneMarker = new THREE.Group();
  /** 镜头基准位置（取景算出来的），抖动在此基础上叠加。 */
  private readonly cameraBase = new THREE.Vector3();
  /** 高潮反馈的镜头抖动强度，随时间衰减。 */
  private shake = 0;

  private constructor(canvas: HTMLCanvasElement, physics: PhysicsWorld) {
    this.physics = physics;
    this.renderer = createRenderer(canvas);
    this.renderer.toneMappingExposure = this.tuning.exposure;

    this.input = new InputController(
      canvas,
      this.getElement('#drop-button'),
      this.getElement('#boost-button'),
      this.getElement('#giveup-button'),
      this.getElement('#sweeper-button'),
      this.getElement('#grapple-button'),
      this.getElement('#reload-button'),
      this.getElement('#wheel-button'),
      this.getElement('#bet-button'),
    );

    this.coins = new CoinPool(physics.world);
    this.pusher = new Pusher(physics.world);
    this.mechanisms = new Mechanisms(this.coins);
    this.shows = new ShowDirector({
      coins: this.coins,
      telemetry: this.telemetry,
      notify: (message) => this.hud.setStatus(message),
      now: () => this.elapsed,
      rng: () => this.rng(),
      reducedMotion: () => this.motion.reduced,
    });
    this.slotMachine = new SlotMachine({
      shows: this.shows,
      telemetry: this.telemetry,
      notify: (message) => this.hud.setStatus(message),
      now: () => this.elapsed,
      rng: () => this.rng(),
      reducedMotion: () => this.motion.reduced,
      grantBoost: () => this.run.grantBoost(),
      onBoostReady: () => this.audio.boostReady(),
    });
    // XIXI 进度从存档恢复：跨局持续，破产不清零。
    this.xixi = [...this.save.snapshot.xixi];
    const table = buildTable(physics.world);
    this.pegs.count = table.pegCount;
    this.pegs.colliderHalfLength = table.pegColliderHalfLength;
    this.pegs.visualHalfLength = table.pegVisualHalfLength;
    this.hotZoneStrip = table.hotZoneStrip;

    this.debugTools = new DebugTools(physics.world, this.tuning, () => this.applyTuning());

    this.config = endlessLevel();
    // 占位实例：**真正的买入发生在构造函数末尾的 `startRun()` 里**，那一次才扣钱包。
    // 这里绝对不能再调 `save.buyIn()`——那会让每次打开页面都扣两份买入
    // （钱包少 40 而局内只有 20，多出来的 20 谁也拿不到）。
    // 这个实例在同一次构造里就被 `startRun()` 换掉，中间不会有任何一帧跑在它上面。
    this.run = new RunState(this.config);

    this.buildScene(table.group);
    this.hud.bindPauseToggle(() => this.togglePause());
    this.hud.bindRuinActions(
      () => this.begForChips(),
      () => this.endRun(),
    );

    this.collection = new CollectionPanel(
      this.save,
      ({ coinSkin, cabinetSkin }) => {
        this.coins.applyCoinSkin(coinSkin);
        if (this.tableGroup) applyCabinetSkin(this.tableGroup, cabinetSkin);
        applyCabinetSkin(this.pusher.group, cabinetSkin);
        this.hud.setStatus(`已换装：${coinSkin.name} · ${cabinetSkin.name}`);
      },
    );
    this.applySkins();

    this.loop = new Loop(
      (delta) => this.update(delta),
      () => this.render(),
    );

    resizeRenderer(this.renderer, this.camera, this.tuning.maxDpr);
    this.fitCamera();
    this.startRun();
    this.installTestHooks();
    this.publishDiagnostics();
  }

  static async create(canvas: HTMLCanvasElement): Promise<Game> {
    const physics = await PhysicsWorld.create();
    return new Game(canvas, physics);
  }

  start(): void {
    this.loop.start();
  }

  dispose(): void {
    this.loop.stop();
    this.input.dispose();
    this.audio.dispose();
    this.debugTools.dispose();
    this.coins.dispose();
    this.renderer.dispose();
    window.__THREE_GAME_DIAGNOSTICS__ = undefined;
    window.__THREE_GAME_TEST_HOOKS__ = undefined;
  }

  // ── 每帧 ────────────────────────────────────────────────────────────────

  private update(delta: number): void {
    this.frame += 1;
    if (this.pausedForScreenshot) {
      this.publishDiagnostics();
      return;
    }

    if (resizeRenderer(this.renderer, this.camera, this.tuning.maxDpr)) this.fitCamera();

    if (this.paused) {
      this.publishDiagnostics();
      return;
    }

    this.elapsed += delta;
    this.run.tick(delta);
    this.dropCooldown = Math.max(0, this.dropCooldown - delta);

    const intent = this.input.sample(delta);
    this.lastIntent = intent;
    this.handleIntent(intent);
    this.recordLaneTelemetry(intent, delta);

    this.physics.step(delta, (fixedDt) => this.fixedUpdate(fixedDt));

    this.coins.syncAll();
    this.processOutcomes();
    this.updateRunState(delta);
    this.laneMarker.position.x = intent.laneX;
    this.updateHotZone(delta);
    this.updateFlashes(delta);
    this.shows.update(delta);
    this.slotMachine.update(delta);
    if (this.pendingXixiSpin && this.slotMachine.spin()) this.pendingXixiSpin = false;
    this.applyCameraShake(delta);
    if (this.governor.sample(delta)) this.applyQuality();
    this.debugTools.update();
    this.publishHud();
    this.publishDiagnostics();
  }

  /**
   * 一次性自发光闪烁。
   *
   * 动效只放大**物理已经发生的事**：投币闪落币口、加力闪推板前缘。
   * 不伪造结果，也不改任何数值。降动效时整段跳过。
   */
  private flash(material: THREE.MeshStandardMaterial | null, base: number): void {
    if (!material || this.motion.reduced) return;
    this.flashes.set(material, { base, life: FLASH_SECONDS });
    material.emissiveIntensity = base + FLASH_PEAK;
  }

  private updateFlashes(delta: number): void {
    if (this.flashes.size === 0) return;
    for (const [material, state] of this.flashes) {
      state.life -= delta;
      if (state.life <= 0) {
        material.emissiveIntensity = state.base;
        this.flashes.delete(material);
      } else {
        material.emissiveIntensity = state.base + FLASH_PEAK * (state.life / FLASH_SECONDS);
      }
    }
  }

  /**
   * 选位遥测。
   *
   * 「自动选位是否匀速」「手动接管与恢复是否跳变」这两条不能靠外部按帧采样判定
   * （采样间隔会漏掉切换当帧），所以由模拟内部记录：每 50ms 一个采样点，
   * 模式切换时额外记一个事件点。
   */
  private recordLaneTelemetry(intent: LaneInput, delta: number): void {
    if (!this.telemetry.active) return;
    if (intent.mode !== this.lastLaneMode) {
      this.telemetry.recordLaneEvent(
        this.elapsed,
        intent.laneX,
        intent.mode,
        intent.mode === 'manual' ? 'enter' : 'resume',
      );
      this.lastLaneMode = intent.mode;
    }
    this.laneSampleTimer += delta;
    if (this.laneSampleTimer >= LANE_SAMPLE_INTERVAL) {
      this.laneSampleTimer = 0;
      this.telemetry.recordLaneSample(this.elapsed, intent.laneX, intent.mode);
    }
  }

  /**
   * 热区：得分线上一段匀速左右扫的亮条，币在其中越线得分翻倍。
   *
   * 和自动选位用同一套三角波（世界坐标匀速 + 反射折返），
   * 所以两个「时机」是同一个节拍，玩家能学会预判它们的交汇。
   */
  private updateHotZone(delta: number): void {
    if (!this.hotZoneStrip) return;
    if (!this.config.hotZone) {
      this.hotZoneStrip.visible = false;
      return;
    }
    this.hotZoneStrip.visible = true;
    const limit = TABLE.drop.halfLane - TABLE.hotZone.halfWidth;
    let x = this.hotZoneX + this.hotZoneDir * TABLE.hotZone.speed * delta;
    if (x > limit) {
      x = 2 * limit - x;
      this.hotZoneDir = -1;
    } else if (x < -limit) {
      x = -2 * limit - x;
      this.hotZoneDir = 1;
    }
    this.hotZoneX = x;
    this.hotZoneStrip.position.x = x;
  }

  /** 这枚币是不是在热区里越的线。 */
  private isInHotZone(x: number): boolean {
    return this.config.hotZone && Math.abs(x - this.hotZoneX) <= TABLE.hotZone.halfWidth;
  }

  /**
   * 高潮反馈：得分链或高价值币触发短促镜头抖动。
   * 爽感来自「币真的被推下去了」这件事本身，不靠遮屏特效。
   */
  private triggerClimax(strength: number, kind: 'gold' | 'green'): void {
    if (this.motion.reduced) return;
    this.shake = Math.max(this.shake, strength);
    this.hud.flashClimax(kind);
  }

  private applyCameraShake(delta: number): void {
    // 推板前推时台面微震：振幅 2 毫米，跟行程同相。刻意做得很小——
    // 它是「机器在动」的触觉提示，不是特效，幅度大了会晕。
    const rumble =
      !this.motion.reduced && this.pusher.running && this.pusher.currentPhase === 'extend'
        ? Math.sin(this.elapsed * 92) * 0.002
        : 0;

    if (this.shake <= 0 && rumble === 0) {
      this.camera.position.copy(this.cameraBase);
      return;
    }
    this.shake = Math.max(0, this.shake - delta * 3.4);
    const amplitude = this.shake * this.shake * 0.055;
    const t = this.elapsed * 46;
    this.camera.position.set(
      this.cameraBase.x + Math.sin(t) * amplitude,
      this.cameraBase.y + Math.sin(t * 1.7 + 1.3) * amplitude + rumble,
      this.cameraBase.z,
    );
  }

  private applyQuality(): void {
    const settings = this.governor.current;
    this.tuning.maxDpr = settings.maxDpr;
    this.renderer.shadowMap.enabled = settings.shadows;
    this.renderer.shadowMap.needsUpdate = true;
    this.coins.setCastShadow(settings.coinShadows);
    this.hud.setStatus(`画质已切到${settings.tier === 'high' ? '高' : settings.tier === 'medium' ? '中' : '低'}档`);
  }

  private render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  /** 物理子步：只做必须在 world.step() 之前完成的写入。 */
  private fixedUpdate(fixedDt: number): void {
    const tick = this.pusher.update(fixedDt);

    if (tick.cycleCompleted) {
      this.run.onCycleCompleted();
      this.telemetry.recordCycle(this.pusher.cyclesCompleted, this.run.earned, this.settledCoins);
    }
    if (tick.boostConsumed) {
      this.hud.setStatus('加力生效：本次前推行程追加 20%');
      // 推板前缘闪一次，让玩家「看见」加力生效。
      this.flash(this.pusher.lipMaterial, 0.16);
    }

    // 速度护栏：**在每个子步推进之前**把上一子步被求解器注入的超额速度压回去，
    // 于是下一子步不会带着这个速度继续积分。睡着的币不参与积分，跳过它们
    // （满盘静置时绝大多数币都在睡，这个判断把开销从 318 枚降到个位数）。
    this.coins.forEachActive((coin) => {
      if (coin.body.isSleeping()) return;
      const spike = coin.clampSpeed(COIN.maxSpeed, COIN.maxUpwardSpeed);
      if (spike > 0) {
        this.spikeClamps += 1;
        if (spike > this.peakSpikeSpeed) this.peakSpikeSpeed = spike;
      }
    });

    // 台面输送：只作用于确实落在推板顶面上的币。
    // 速度以推板为参考系，所以推板回撤时币在世界里会跟着后退——和真机一致。
    const targetSpeed = this.pusher.velocityZ + this.tuning.conveyorSpeed;
    const { back, front } = this.pusher.topRange;
    this.coins.forEachActive((coin) => {
      const p = coin.position;
      const onDeck =
        p.y >= TABLE.conveyor.minY && p.y <= TABLE.conveyor.maxY && p.z >= back && p.z <= front;
      const wasOnDeck = coin.onDeck;
      coin.onDeck = onDeck;

      // 记录「越过台面前缘」这一刻：这是币从上层掉到币床的唯一通道，
      // 位置必须贴合推板前缘，不能是任何形式的隐藏传送。
      if (wasOnDeck && !onDeck && coin.playerDropped && p.z > front) {
        this.telemetry.recordFallOff({
          z: round3(p.z),
          frontFaceZ: round3(this.pusher.frontFaceZ),
          offset: round3(this.pusher.offset),
          phase: this.pusher.currentPhase,
        });
      }

      if (!onDeck) return;
      // 台面输送**只负责把玩家投下的币送到币床**。
      //
      // 预置的上层币刻意不吃这一口：它们的唯一动力是推板顶面的摩擦，
      // 于是随着推板前后滑动、停在原地——「推币台上下都有金币」的观感才留得住。
      // 如果预置币也吃输送（0.85 m/s、离前缘只有 0.12 米），它们会在不到一秒内
      // 被整片冲下前缘，上层瞬间空掉（P2 的「上层倾泻 < 15%」就是量这一条）。
      if (!coin.playerDropped) return;
      coin.applyConveyor(targetSpeed);
    });
  }

  // ── 输入 ────────────────────────────────────────────────────────────────

  private handleIntent(intent: LaneInput): void {
    if (intent.giveUpPressed && this.drainPromptVisible) {
      this.run.abandonBoost();
      this.setDrainPrompt(false);
      this.finishRun();
      return;
    }
    if (intent.boostPressed) this.tryBoost();
    if (intent.dropPressed) this.tryDrop(intent.laneX);
    if (intent.sweepPressed) this.trySweep();
    if (intent.grapplePressed) this.tryGrapple(intent.laneX);
    if (intent.reloadPressed) this.tryReload();
    if (intent.wheelPressed) this.tryWheel();
    if (intent.betPressed) this.cycleBet();
  }

  // ── 机关 ────────────────────────────────────────────────────────────────

  /** 扫板：收尾停板后把贴着得分线的币推过去。与加力互斥（同一次收尾只能选一个）。 */
  private trySweep(): boolean {
    if (this.run.phase !== 'drainOut' || !this.run.plateStopped) return false;
    if (this.run.canUseBoost) {
      this.hud.setStatus('先决定加力：用掉或放弃，然后再扫板');
      return false;
    }
    const result = this.mechanisms.sweep();
    if (!result.ok) {
      this.hud.setStatus(result.reason ?? '扫板不可用');
      return false;
    }
    this.audio.payoutReturn();
    this.hud.setStatus(`扫板：把 ${result.affected} 枚贴线的币向前送了一把`);
    return true;
  }

  /** 抓斗：花 2 枚额度，把选位标记附近 0.3×0.3 米区域内的币整堆搬到前沿。 */
  private tryGrapple(centerX: number): boolean {
    if (this.run.phase !== 'playing') return false;
    if (this.mechanisms.usesLeft('grapple') <= 0) {
      this.hud.setStatus('本局抓斗已用完');
      return false;
    }
    if (this.run.chips < MECHANISM_COST.grapple) {
      this.hud.setStatus(`筹码不足：抓斗要花 ${MECHANISM_COST.grapple} 枚`);
      return false;
    }
    const result = this.mechanisms.grapple(centerX);
    if (!result.ok) {
      this.hud.setStatus(result.reason ?? '抓斗不可用');
      return false;
    }
    // 成本从局内筹码里扣，和直接投币用的是同一个池子——这就是它的机会成本。
    this.run.spendChips(MECHANISM_COST.grapple);
    this.audio.boostUse();
    this.hud.setStatus(`抓斗：把 ${result.affected} 枚币搬到了前沿`);
    return true;
  }

  /** 后装填：花 1 枚额度，往盘面后区注入一小叠币（额度的延迟投资）。 */
  private tryReload(): boolean {
    if (this.run.phase !== 'ready' && this.run.phase !== 'playing') return false;
    if (this.run.chips < MECHANISM_COST.reload) {
      this.hud.setStatus(`筹码不足：后装填要花 ${MECHANISM_COST.reload} 枚`);
      return false;
    }
    const result = this.mechanisms.reload();
    if (!result.ok) {
      this.hud.setStatus(result.reason ?? '后装填不可用');
      return false;
    }
    this.run.beginPlay();
    this.run.spendChips(MECHANISM_COST.reload);
    this.pusher.start();
    this.audio.drop();
    this.hud.setStatus(`后装填：注入 ${result.affected} 枚，等两三个循环才开始产出`);
    return true;
  }

  /** 风险转轮：收尾时把剩余额度押上去，三格结果由概率决定。 */
  private tryWheel(): boolean {
    if (this.run.phase !== 'drainOut') return false;
    if (this.run.chips <= 0) {
      this.hud.setStatus('没有可押的筹码');
      return false;
    }
    const wagered = this.run.chips;
    const result = this.mechanisms.spin(wagered);
    if (!result.ok) {
      this.hud.setStatus(result.reason ?? '转轮不可用');
      return false;
    }
    // 押上的筹码一律没收：这是赌注，不是消费。
    this.run.spendChips(wagered);
    const label =
      result.outcome === 'front'
        ? `直落前沿：${result.affected} 枚币压到了得分线前`
        : result.outcome === 'reload'
          ? `转成后装填：${result.affected} 枚币落到了后区`
          : '全部沉没：这一把没了';
    this.hud.setStatus(`转轮：押上 ${wagered} 筹码 → ${label}`);
    return true;
  }

  /** 切换加注档位。 */
  private cycleBet(): boolean {
    this.betIndex = (this.betIndex + 1) % ENDLESS.bets.length;
    const bet = ENDLESS.bets[this.betIndex];
    this.hud.setStatus(`加注切到 ${bet.label}`);
    return true;
  }

  private mechanismSnapshot(): MechanismSnapshot {
    return {
      sweeper: this.mechanisms.usesLeft('sweeper'),
      grapple: this.mechanisms.usesLeft('grapple'),
      reload: this.mechanisms.usesLeft('reload'),
      wheel: this.mechanisms.usesLeft('wheel'),
    };
  }

  private tryDrop(laneX: number): boolean {
    if (!this.run.acceptingDrops) return false;
    if (this.dropCooldown > 0) return false;

    // 加注：一次押 1 / 2 / 5 枚筹码，换这一投更高的**返值倍率**。
    const bet = betTier(this.betIndex);
    if (this.run.chips < bet.chips) {
      this.hud.setStatus(`筹码不足：当前加注要 ${bet.chips} 枚`);
      return false;
    }

    const coin = this.coins.acquire();
    if (!coin) {
      // 预算耗尽不再静默失败：不提示的话玩家只会觉得按钮坏了。
      this.hud.setStatus('盘面已满：等几枚币越线腾出空位再投');
      return false;
    }

    const jitterX = (this.rng() - 0.5) * 2 * TABLE.drop.jitterX;
    const jitterZ = (this.rng() - 0.5) * 2 * TABLE.drop.jitterZ;
    coin.spawn(
      'bronze',
      clamp(laneX + jitterX, -TABLE.drop.halfLane, TABLE.drop.halfLane),
      TABLE.drop.y,
      TABLE.drop.z + jitterZ,
      this.rng() * Math.PI * 2,
      true,
    );
    // 倍率盖在币身上，而不是越线时读当前档位：否则玩家可以在币在途时改档，
    // 用 1 枚的价钱享受 5 枚的倍率。
    coin.betMul = bet.mul;

    this.run.beginPlay();
    this.run.spendChips(bet.chips);
    this.run.noteDrop();
    this.dropCooldown = this.tuning.dropCooldown;
    this.pusher.start();
    this.audio.drop();
    // 落币口亮一下，与真实生成同步（不提前）。
    this.flash(this.spitterMaterial, 0.42);
    // 每 N 投注入一枚金色大赏币（方差的主杠杆）。
    if (this.run.drops % ENDLESS.bountyEveryDrops === 0) this.spawnBounty();
    return true;
  }

  /**
   * 注入一枚金色大赏币。
   *
   * 落点随机：有时贴着得分线（马上兑现），有时埋在后排（长线悬念）。
   * 视觉与铜币同尺寸同碰撞体，靠贴图与自发光区分——不动物理。
   */
  private spawnBounty(): boolean {
    const coin = this.coins.acquire();
    if (!coin) return false;
    const x = (this.rng() - 0.5) * 2 * TABLE.drop.halfLane;
    const z = -0.1 + this.rng() * 1.05;
    coin.spawn('bounty', x, TABLE.pusherTopY + 0.5, z, this.rng() * Math.PI * 2, false);
    // 只在真的注入成功时计数：预算耗尽时 `acquire` 返回 null，那次没发生。
    this.run.noteBounty();
    this.hud.setStatus(`金色大赏币注入：越线固定 +${ENDLESS.bountyChips} 筹码`);
    return true;
  }

  private tryBoost(): boolean {
    if (this.pusher.pendingBoost) return false;
    if (!this.run.canUseBoost) return false;
    if (!this.run.useBoost()) return false;

    this.pusher.requestBoost();
    this.audio.boostUse();
    if (this.run.settling && !this.pusher.running) {
      this.pusher.start();
      this.settleWindow = 0;
      this.restTimer = 0;
      this.setDrainPrompt(false);
    }
    this.hud.setStatus('加力已排队，下一次前推追加行程');
    return true;
  }

  // ── 事件处理 ────────────────────────────────────────────────────────────

  private processOutcomes(): void {
    this.coins.forEachActive((coin) => {
      const p = coin.position;

      // 穿模/掉出机柜：开发期记录为缺陷，不当作合法损失。
      if (p.y < -0.8 || Math.abs(p.x) > 1.3 || p.z < TABLE.pusherBackZ - 0.6) {
        this.anomalyCount += 1;
        if (this.anomalySamples.length < 12) {
          const [vx, vy, vz] = coin.velocity3();
          this.anomalySamples.push({
            frame: this.frame,
            kind: coin.kind,
            x: round3(p.x),
            y: round3(p.y),
            z: round3(p.z),
            vx: round3(vx),
            vy: round3(vy),
            vz: round3(vz),
            speed: round3(Math.hypot(vx, vy, vz)),
          });
        }
        return true;
      }

      if (p.z > TABLE.scoreLineZ) {
        this.settleCrossing(coin);
        return true;
      }

      // XIXI 集章：只有玩家主动投入的币、且已经掉到币床上（离开上层台面）才登记——
      // 沿用通道印记的 `registerY` 判定语义（「真的掉到币床上才算」，弹飞的不登记）。
      if (coin.playerDropped && !coin.xixiMarked) {
        if (p.y < TABLE.channel.registerY) {
          coin.xixiMarked = true;
          this.markXixi(p.x);
        }
      }

      return false;
    });
  }

  /**
   * 登记一枚落床币的 XIXI 槽位（拍板 #2：按物理落点 x，不按投币口）。
   *
   * 四槽集齐 → 清空 → 触发背板老虎机。进度**跨局持续**（存档 v4 的 xixi 字段），
   * 破产不清零——它是收集线，不是赌本。同一槽重复点亮不累计（P8 可再调）。
   */
  private markXixi(x: number): void {
    const slot = xixiSlot(x);
    if (slot < 0 || this.xixi[slot]) return;

    this.xixi[slot] = true;
    this.save.setXixi(this.xixi);
    this.telemetry.recordXixi({ phase: 'lit', slot, t: this.elapsed });
    this.audio.mark();

    if (this.xixi.every(Boolean)) {
      this.xixi = [false, false, false, false];
      this.save.setXixi(this.xixi);
      this.telemetry.recordXixi({ phase: 'completed', t: this.elapsed });
      // 老虎机正在转时不吞这次集齐：排队到转完再摇（见 update 里的 pendingXixiSpin）。
      if (!this.slotMachine.spin()) this.pendingXixiSpin = true;
    }
  }

  /**
   * 一枚币越过得分线：结算筹码。
   *
   * 顺序不能反：**先算连落**（热度倍率挂在 combo 上），再算返值，最后入账。
   * 入账**不取消沉降**（见 `RunState.gainChips` 的说明）：沉降期返值照记，
   * 但本局能不能继续由「沉降走完时手里有没有筹码」决定，不靠某一枚币。
   *
   * 随机数在这里取（走游戏 RNG），所以概率返值是可复现的：
   * 同一个种子跑出同一串结果，账本恒等式才能逐笔核对。
   */
  private settleCrossing(coin: Coin): void {
    const kind = coin.kind;
    const combo = this.run.nextCombo(this.elapsed);
    // 热区：币在亮条范围内越线，返值翻倍。
    const hot = this.isInHotZone(coin.position.x);
    const outcome = crossingReturn({
      kind,
      combo: combo.combo,
      hot,
      betMul: coin.betMul,
      roll: this.rng(),
    });

    const chipsBefore = this.run.chips;
    this.run.gainChips(outcome.chips);
    const chipsAfter = this.run.chips;

    coin.settled = true;
    this.settledCoins += 1;

    this.telemetry.recordScore(
      {
        kind,
        // 入账筹码（含热度倍率、热区翻倍与加注倍率），不是面值——否则逐笔合计对不上。
        value: outcome.chips,
        z: round3(coin.position.z),
        combo: combo.combo,
        chipsBefore,
        chipsAfter,
        hot,
      },
      this.elapsed,
    );

    this.audio.score(kind, combo.combo);
    // 没返值的铜币要**诚实呈现**：灰字 +0，而不是假装什么都没发生。
    this.hud.flashScore(outcome.chips);
    // 飞字必须从**真的越线位置**起飞，所以这里把币的世界坐标投影到屏幕。
    const from = this.toScreen(coin.position.x, coin.position.y, coin.position.z);
    this.hud.flyScore(from.x, from.y, outcome.chips);
    if (outcome.chips > 0 && (kind === 'payout' || kind === 'bounty')) this.audio.payoutReturn();
    if (combo.combo >= 3) this.hud.showCombo(combo.combo, COIN_KIND[kind].label);

    // 反馈分级：没中的铜币只有小声；花纹筹码、连落和返币才是高潮反馈。
    if (kind === 'bounty') this.triggerClimax(1, 'gold');
    else if (combo.combo >= 5) this.triggerClimax(1, 'gold');
    else if (kind === 'pattern') this.triggerClimax(0.55, 'gold');
    else if (kind === 'payout') this.triggerClimax(0.75, 'green');
  }

  // ── 状态机推进 ──────────────────────────────────────────────────────────

  private updateRunState(delta: number): void {
    if (this.run.phase === 'settled') return;

    this.run.setInFlight(this.countInFlight() > 0);

    // 筹码归零不立即判破产，先让盘面沉降——
    // 沉降期照样有币越线返值（照记进账本），但**返值本身不取消沉降**：
    // 满盘一波就能返十几枚，若返值能立刻复活，沉降永远走不完。
    // 能不能继续由沉降走完那一刻手里的筹码决定（见下面 drainWindow 分支）。
    if (this.run.phase === 'playing' && this.run.chips <= 0) {
      this.run.enterRuinSettle();
      this.hud.setStatus('筹码见底：盘面沉降中，撑到沉降结束就能带着盘面回吐的筹码继续');
    }

    if (!this.run.settling) {
      this.setDrainPrompt(false);
      return;
    }

    if (this.run.settleReason !== null && !this.drainRecorded) {
      this.drainRecorded = true;
      this.telemetry.recordDrainStart(this.run.settleReason, this.elapsed, this.run.earned);
    }

    if (!this.run.plateStopped && this.run.shouldStopPlate()) {
      this.run.stopPlate();
      this.pusher.stop();
      this.settleWindow = 0;
      this.restTimer = 0;
      this.audio.settle(this.run.settleReason ?? 'exhausted');
      this.hud.setStatus('推板已停板，等待盘面沉降');
    }

    if (!this.run.plateStopped) return;

    // 加力不能被吞：持有加力时提示玩家使用或放弃，不静默清空。
    // 提示不再 return——破产弹窗必须能同时弹出（加力在沉降期仍能救命）。
    this.setDrainPrompt(this.run.canUseBoost);

    this.settleWindow += delta;
    this.restTimer = this.allResting() ? this.restTimer + delta : 0;
    if (this.restTimer >= RULES.restHold || this.settleWindow >= RULES.drainWindow) {
      // 沉降走完，两条路：
      // · 盘面在这段时间里把筹码还回来了 → **本局继续**。玩家手里有筹码就该能接着玩，
      //   这里不能悄悄结束本局——那等于把返值吞掉。
      // · 一枚都没回来 → 破产弹窗（跪求是唯一救济 / 保留尊严收工）。
      if (this.run.chips > 0) {
        // 这一轮收尾到此结束，先把结算落盘再继续本局：
        // 不落盘的话「收尾持续了多久」这条断言就再也测不到了。
        this.telemetry.recordSettle(this.elapsed, this.run.earned);
        this.run.reviveFromRuin();
        this.pusher.start();
        this.settleWindow = 0;
        this.restTimer = 0;
        this.setDrainPrompt(false);
        // 允许下一轮沉降重新开一条记录（刚走完的那条留着）。
        this.resetDrainRecord();
        this.hud.setStatus(`盘面回吐筹码，本局继续（手里 ${this.run.chips} 枚）`);
      } else {
        this.showRuin();
      }
    }
  }

  /**
   * 破产弹窗：嘲讽 + 两条真实选择。
   *
   * 跪求 → 领递减赏赐，**盘面保留**（你堆起来的台面是沉没价值，这是「再跪一次」的拉力）。
   * 保留尊严 → 结束本局、回存钱包、盘面清空。
   *
   * 这里**不回存钱包**：本局还没结束，玩家随时可能跪求续命。回存在 showEndlessSummary。
   */
  private showRuin(): void {
    if (this.ruinVisible) return;
    this.ruinVisible = true;
    this.pusher.stop();
    // 破产也是「本次收尾结束」，必须和 finishRun 一样落一条结算记录，
    // 否则遥测里永远看不到破产局的收尾时长与迟到返值。
    this.telemetry.recordSettle(this.elapsed, this.run.earned);
    this.hud.showRuin({
      earned: this.run.earned,
      chips: this.run.chips,
      drops: this.run.drops,
      chipsPeak: this.run.chipsPeak,
      begs: this.begsThisRun,
      totalBegs: this.save.begCount(),
      best: this.save.snapshot.bestEarned,
      wallet: this.save.wallet,
      runs: this.save.snapshot.runs,
      grant: ENDLESS.begs[Math.min(this.begsThisRun, ENDLESS.begs.length - 1)],
    });
    this.hud.setStatus('破产。跪求 xixi 大王，还是保留尊严？');
  }

  /** 跪求 xixi 大王大赏：递减赏赐，只给筹码，盘面保留。 */
  private begForChips(): boolean {
    if (!this.ruinVisible) return false;
    const grant = ENDLESS.begs[Math.min(this.begsThisRun, ENDLESS.begs.length - 1)];
    this.begsThisRun += 1;
    this.ruinVisible = false;
    this.hud.hideRuin();
    // 赏赐走 grantBeg 而不是 gainChips：它记进 begged（脏钱），
    // 所以收工时**不能回存钱包**——否则跪求就成了无限刷筹码的漏洞。
    this.run.grantBeg(grant);
    // 赏赐只续命：不计入赚进、不给任何加成。
    this.run.reviveFromRuin();
    // 本局被拉回收尾之前：那次收尾没有结算，清掉记录重新计时。
    this.resetDrainRecord();
    this.pusher.start();
    this.settleWindow = 0;
    this.restTimer = 0;
    this.audio.payoutReturn();
    this.hud.setStatus(`xixi 大王赏你 ${grant} 筹码。滚去推币，别再回来。`);
    return true;
  }

  /** 保留尊严，收工：记录本局，盘面清空；若已在总结页则直接再来一局。 */
  private endRun(): void {
    if (this.summaryVisible) {
      this.summaryVisible = false;
      this.hud.hideRuin();
      this.startRun();
      return;
    }
    if (!this.ruinVisible) return;
    this.ruinVisible = false;
    this.hud.hideRuin();
    // 收工即收摊：在途演出/摇奖一并作废，本局成绩单不再被「收工后才落地的币」追改
    // （那些迟到越线会让 earned 在快照之后继续涨，快照与实时读数就对不上了）。
    this.shows.abort();
    this.slotMachine.abort();
    this.pendingXixiSpin = false;
    this.showEndlessSummary();
  }

  /**
   * 本局结算卡片。
   *
   * 顺序很关键：**先回存钱包，再记这一局**——卡片上显示的钱包余额必须
   * 和存档里的数字一致，否则玩家会看到「回存 +12」但钱包没动。
   * 回存额由 `RunState.cashOut` 给出，已经扣掉不可回存的跪求筹码。
   *
   * 跪求次数是排行榜的第二列：把羞辱变成收集品。
   */
  private showEndlessSummary(): void {
    const snapshot = this.run.snapshot();
    const cashOut = this.run.cashOut;
    this.save.depositWallet(cashOut);
    const record = this.save.recordRun(snapshot.earned, snapshot.drops, this.begsThisRun);
    this.summaryVisible = true;
    this.hud.showRuin({
      earned: snapshot.earned,
      chips: snapshot.chips,
      cashOut,
      wallet: this.save.wallet,
      drops: snapshot.drops,
      chipsPeak: snapshot.chipsPeak,
      begs: this.begsThisRun,
      totalBegs: record.totalBegs,
      best: record.best,
      runs: this.save.snapshot.runs,
      grant: 0,
      summary: true,
    });
    this.hud.setStatus(`本局结束：回存 ${cashOut} 筹码，钱包现有 ${this.save.wallet}`);
    this.publishDiagnostics();
  }

  private setDrainPrompt(visible: boolean): void {
    if (this.drainPromptVisible === visible) return;
    this.drainPromptVisible = visible;
    this.hud.showDrainPrompt(visible);
  }

  /**
   * 本局从收尾被拉回进行中：允许下一轮收尾重新开一条记录。
   *
   * 只复位这个一次性标志，**不清遥测记录**——刚走完的那轮收尾记录要留给断言读
   * （`Telemetry.recordDrainStart` 每次覆盖，所以不需要手动清）。
   */
  private resetDrainRecord(): void {
    this.drainRecorded = false;
  }

  /** 收尾：定格本局并弹结算卡片。 */
  private finishRun(): void {
    this.run.finish();
    this.setDrainPrompt(false);
    this.pusher.stop();
    this.telemetry.recordSettle(this.elapsed, this.run.earned);
    this.showEndlessSummary();
  }

  // ── 开局装载 ────────────────────────────────────────────────────────────

  /** 开一局新的：盘面预置，筹码从钱包买入。 */
  private startRun(): void {
    // 买入放在最前面：钱包扣款必须发生在任何状态重置之前。
    // 钱包见底时 buyIn 返回 0（不拒绝），本局会以 0 筹码开局、立刻进沉降，
    // 玩家跪求一次就能继续——这条路必须走得通，否则钱包空就成了死状态。
    this.run = new RunState(this.config, this.save.buyIn());
    this.rng = createSeededRandom(this.seedOverride ?? this.config.seed);

    // **推板先归位，再摆盘。顺序不能反。**
    //
    // 摆盘是按「推板归位」的几何算出来的（上层币就在推板后缘与归位前缘之间）。
    // 如果先摆盘、后归位，这一帧里推板还停在上一局结束时的位置（最远在行程前方
    // 0.36 米），而摆盘用的是归位几何 —— 两件事错开，背排的币会落在推板体内。
    // 更糟的是 `reset()` 会把推板从行程最大处一路搬回来，那段位移在一步内完成，
    // 等效 21 米/秒的**倒扫**，直接把背排币挤飞出机柜。
    // 实测：重开一局盘面只剩 287~295 枚（应 318），丢的 16~31 枚全部记进 `anomalies`。
    //
    // `travel` 必须在 `reset()` **之前**赋值：`reset()` 拿 `this.travel` 初始化
    // `travelForStroke`，反了的话第一趟行程用的还是上一局的行程值。
    this.pusher.travel = this.tuning.pusherTravel;
    this.pusher.reset();

    this.coins.releaseAll();
    for (const placement of this.config.layout) {
      const coin = this.coins.acquire();
      if (!coin) break;
      coin.spawn(placement.kind, placement.x, placement.y, placement.z, placement.yaw, false);
    }
    this.coins.syncAll();

    this.mechanisms.reset();
    // 在途演出与摇奖必须随本局作废：不中止的话，上一局的塔/喷泉会把剩余承诺数
    // 吐进**这一局**的开局盘面（实测重开后 318 变 324 枚）。
    this.shows.abort();
    this.slotMachine.abort();
    this.pendingXixiSpin = false;
    this.physics.freeze();
    this.telemetry.reset();
    this.drainRecorded = false;
    this.begsThisRun = 0;
    this.betIndex = 0;
    this.ruinVisible = false;
    this.summaryVisible = false;
    this.hud.hideRuin();

    this.elapsed = 0;
    this.dropCooldown = 0;
    this.restTimer = 0;
    this.settleWindow = 0;
    this.anomalyCount = 0;
    this.anomalySamples.length = 0;
    this.spikeClamps = 0;
    this.peakSpikeSpeed = 0;
    this.settledCoins = 0;
    this.setDrainPrompt(false);
    this.hud.resetCombo();
    this.hud.setStatus(
      `${this.config.focus} · 本局买入 ${this.run.buyIn} 筹码 · 选位自动左右摆，轻点机台或按空格投币`,
    );
    this.input.setEnabled(true);
    this.publishHud();
  }

  // ── 场景 ────────────────────────────────────────────────────────────────

  private buildScene(tableGroup: THREE.Group): void {
    this.scene.background = new THREE.Color(COLORS.screenDeep);
    this.scene.add(new THREE.HemisphereLight('#dff0e4', '#16241d', 2.3));

    const key = new THREE.DirectionalLight('#fff2cd', 3.1);
    key.position.set(-1.6, 3.2, 2.4);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.near = 0.5;
    key.shadow.camera.far = 9;
    key.shadow.camera.left = -1.6;
    key.shadow.camera.right = 1.6;
    key.shadow.camera.top = 1.8;
    key.shadow.camera.bottom = -1.2;
    this.scene.add(key);

    const rim = new THREE.DirectionalLight('#8ee0b8', 1.15);
    rim.position.set(1.8, 1.4, -2.2);
    this.scene.add(rim);

    const fill = new THREE.DirectionalLight('#ffe6b0', 0.7);
    fill.position.set(0.4, 1.2, 3.0);
    this.scene.add(fill);

    this.scene.add(tableGroup);
    this.tableGroup = tableGroup;
    this.scene.add(this.pusher.group);
    this.scene.add(this.coins.group);
    this.scene.add(this.shows.group);
    this.scene.add(this.slotMachine.group);
    this.scene.add(this.debugTools.overlay);
    this.scene.add(this.buildLaneMarker());
  }

  /** 套用存档里选用的外观。只改渲染，不动物理与数值。 */
  private applySkins(): void {
    const coinSkin = coinSkinById(this.save.snapshot.selectedCoinSkin);
    const cabinetSkin = cabinetSkinById(this.save.snapshot.selectedCabinetSkin);
    this.coins.applyCoinSkin(coinSkin);
    if (this.tableGroup) applyCabinetSkin(this.tableGroup, cabinetSkin);
    applyCabinetSkin(this.pusher.group, cabinetSkin);
  }

  private buildLaneMarker(): THREE.Group {
    const spitterMaterial = new THREE.MeshStandardMaterial({
      color: COLORS.bronzeRim,
      emissive: new THREE.Color(COLORS.bronzeRim),
      emissiveIntensity: 0.42,
      roughness: 0.34,
      metalness: 0.62,
    });
    this.spitterMaterial = spitterMaterial;
    const spitter = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.05, 0.07), spitterMaterial);
    spitter.position.set(0, TABLE.drop.y + 0.09, TABLE.drop.z);
    this.laneMarker.add(spitter);

    const guideBottom = TABLE.pusherTopY + 0.02;
    const guideHeight = TABLE.drop.y - guideBottom;
    const guide = new THREE.Mesh(
      new THREE.BoxGeometry(0.006, guideHeight, 0.006),
      new THREE.MeshBasicMaterial({ color: COLORS.bronzeRim, transparent: true, opacity: 0.22 }),
    );
    guide.position.set(0, guideBottom + guideHeight / 2, TABLE.drop.z);
    this.laneMarker.add(guide);

    return this.laneMarker;
  }

  private fitCamera(): void {
    const fovRad = (this.tuning.cameraFov * Math.PI) / 180;
    const aspect = Math.max(0.2, this.camera.aspect);
    const halfTan = Math.tan(fovRad / 2);
    const sin = Math.sin(CAMERA_FIT.pitch);
    const cos = Math.cos(CAMERA_FIT.pitch);

    const distanceToFitWidth = (CAMERA_FIT.halfWidth * 2) / 2 / (halfTan * aspect);
    const distanceToFitHeight = CAMERA_FIT.verticalExtent / 2 / halfTan;
    const distance = Math.max(distanceToFitWidth, distanceToFitHeight);

    this.camera.fov = this.tuning.cameraFov;
    this.camera.position.set(
      0,
      CAMERA_FIT.centerY + sin * distance,
      CAMERA_FIT.centerZ + cos * distance,
    );
    this.cameraBase.copy(this.camera.position);
    this.camera.lookAt(0, CAMERA_FIT.centerY, CAMERA_FIT.centerZ);
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld(true);
    this.updateMarksAnchor();
  }

  /** 世界坐标 → 屏幕 CSS 像素。飞字与集章贴台面都要用它。 */
  private toScreen(x: number, y: number, z: number): { x: number; y: number } {
    const projected = new THREE.Vector3(x, y, z).project(this.camera);
    const canvas = this.renderer.domElement;
    return {
      x: (projected.x * 0.5 + 0.5) * canvas.clientWidth,
      y: (-projected.y * 0.5 + 0.5) * canvas.clientHeight,
    };
  }

  /**
   * 把三路集章贴到币床上缘。
   *
   * 用世界坐标投影而不是百分比定位——竖屏与横屏下机台在画面里的位置不同，
   * 百分比会把圆点漂到别处。锚点取币床最深处（推板归位时的推币面）。
   */
  private updateMarksAnchor(): void {
    const anchor = this.toScreen(0, TABLE.pusherTopY + 0.02, TABLE.pusherFrontZAtRest);
    this.hud.setMarksAnchor(anchor.y);
  }

  private togglePause(): void {
    this.paused = !this.paused;
    this.hud.showPause(this.paused);
    if (this.paused) this.physics.freeze();
    this.hud.setStatus(this.paused ? '已暂停：推板与物理都已冻结' : '继续游戏');
  }

  // ── 查询 ────────────────────────────────────────────────────────────────

  private countInFlight(): number {
    let count = 0;
    this.coins.forEachActive((coin) => {
      if (coin.position.y > IN_FLIGHT_Y) count += 1;
    });
    return count;
  }

  private allResting(): boolean {
    let resting = true;
    this.coins.forEachActive((coin) => {
      if (coin.speed() > RULES.restSpeed) resting = false;
    });
    return resting;
  }

  private publishHud(): void {
    this.hud.update(
      this.run.snapshot(),
      this.config,
      this.save.snapshot.bestEarned,
      this.mechanismSnapshot(),
      betTier(this.betIndex),
      this.save.wallet,
      this.xixi,
    );
  }

  // ── 测试钩子与诊断 ──────────────────────────────────────────────────────

  private installTestHooks(): void {
    window.__THREE_GAME_TEST_HOOKS__ = {
      seed: (value: number) => {
        this.seedOverride = value;
        this.rng = createSeededRandom(value);
      },
      setState: (name: string) => {
        const state = this.applyTestState(name);
        this.render();
        this.publishDiagnostics();
        return { state };
      },
      setPausedForScreenshot: (paused: boolean) => {
        this.pausedForScreenshot = paused;
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
        if (running) this.pusher.start();
        else this.pusher.stop();
        return { running: this.pusher.running, cycles: this.pusher.cyclesCompleted };
      },
      setReducedMotion: (enabled: boolean) => {
        this.motion.setOverride(enabled);
        if (enabled) {
          // 截图用：停掉环境动效，让同一状态两次渲染一致。
          this.pusher.stop();
          this.shake = 0;
          this.camera.position.copy(this.cameraBase);
        }
        this.render();
        this.publishDiagnostics();
        return { reduced: this.motion.reduced, source: this.motion.source };
      },
      hideDebugUi: (hidden: boolean) => {
        this.debugTools.setHidden(hidden);
      },
      setQuality: (tier: string) => {
        const settings = this.governor.force(tier as QualityTier);
        this.governor.freeze(true);
        this.applyQuality();
        this.render();
        return { tier: settings.tier, maxDpr: settings.maxDpr, shadows: settings.shadows };
      },
      drop: (lane: number) => {
        this.input.setLane(lane);
        return this.tryDrop(clamp(lane, -1, 1) * TABLE.drop.halfLane);
      },
      /** 只设定选位、不投币；视为一次手动接管（自动选位会让位 2 秒）。 */
      setLane: (lane: number) => {
        this.input.setLane(lane);
        return { lane, laneX: clamp(lane, -1, 1) * TABLE.drop.halfLane };
      },
      boost: () => this.tryBoost(),
      /** 机关：直接触发，返回是否生效（测试用）。 */
      sweep: () => this.trySweep(),
      grapple: (laneX: number) => this.tryGrapple(laneX),
      reload: () => this.tryReload(),
      spinWheel: () => this.tryWheel(),
      cycleBet: () => this.cycleBet(),
      mechanisms: () => this.mechanismSnapshot(),
      /** 开一局新的 / 跪求 / 收工，供自动化试玩。 */
      startRun: () => {
        this.startRun();
        return true;
      },
      beg: () => this.begForChips(),
      quitRun: () => this.endRun(),
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
        if (this.hud.ruinVisible) return false;
        this.run.spendChips(this.run.chips);
        this.run.enterRuinSettle();
        this.showRuin();
        return true;
      },
      run: () => ({
        begs: this.begsThisRun,
        totalBegs: this.save.begCount(),
        best: this.save.snapshot.bestEarned,
        wallet: this.save.wallet,
        ruinVisible: this.hud.ruinVisible,
        summaryVisible: this.summaryVisible,
      }),
      /** 三账本 + 钱包：P1 验收要逐笔核对 `chips = buyIn + earned + begged − spent`。 */
      ledger: () => ({
        ...this.run.ledger,
        cashOut: this.run.cashOut,
        wallet: this.save.wallet,
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
      snapshot: () => this.run.snapshot(),
      coins: () => this.sampleCoins(),
      probeColliders: (x: number, y: number, z: number) => this.probeColliders(x, y, z),
      /**
       * 调试用：从某点竖直向下打一条射线，返回第一个命中的碰撞体。
       *
       * 用来回答「这枚币脚下到底是什么、支撑面在哪个高度」——币堆穿模排查时，
       * 光看币的坐标只能知道它沉下去了，射线才知道它沉进了什么。
       */
      castDown: (x: number, y: number, z: number) => this.castDown(x, y, z),
      /** 调试用：报告地板网格与最低几枚币的**网格**世界包围盒（渲染侧真实位置）。 */
      probeMeshes: () => this.probeMeshes(),
      /**
       * 调试/验证用：从**接触流形**里读真实穿透深度。
       *
       * 为什么不用「同层横向距离」那种几何启发式：币堆里出现倾斜的币时，
       * 两枚币心可以靠得很近、高度也只差几毫米，却是**合法的倚靠**（斜币的边缘
       * 搭在另一枚的币面上）。启发式会把它们全判成穿模，于是币堆一变硬就满屏误报。
       * 接触流形的 `contactDist` 是物理引擎自己算出来的穿透量，与姿态无关。
       */
      penetrationReport: (limitMillimeters: number) => this.penetrationReport(limitMillimeters),
      setTuning: (patch: Record<string, number>) => {
        Object.assign(this.tuning, patch);
        this.applyTuning();
        return { ...this.tuning, physics: this.physics.tuning };
      },
      table: () => ({
        name: this.config.name,
        coins: this.config.layout.length,
        value: layoutValue(this.config.layout),
        bronze: this.config.layout.filter((coin) => coin.kind === 'bronze').length,
        pattern: this.config.layout.filter((coin) => coin.kind === 'pattern').length,
        payout: this.config.layout.filter((coin) => coin.kind === 'payout').length,
      }),
      collection: () => ({
        wallet: this.save.wallet,
        coinSkins: [...this.save.snapshot.coinSkins],
        cabinetSkins: [...this.save.snapshot.cabinetSkins],
        selectedCoinSkin: this.save.snapshot.selectedCoinSkin,
        selectedCabinetSkin: this.save.snapshot.selectedCabinetSkin,
      }),
      clearSave: () => {
        this.save.clear();
        // 存档清了多少，内存态就同步多少——XIXI 是存档背书的进度，不同步就是假重置。
        this.xixi = [...this.save.snapshot.xixi];
        this.collection.refresh();
        this.applySkins();
        return { wallet: this.save.wallet };
      },
      unlockSkin: (kind: string, id: string, cost: number) => {
        const unlocked = this.save.unlockSkin(kind as 'coin' | 'cabinet', id, cost);
        this.collection.refresh();
        return { unlocked, wallet: this.save.wallet };
      },
      selectSkin: (kind: string, id: string) => {
        const selected = this.save.selectSkin(kind as 'coin' | 'cabinet', id);
        if (selected) this.applySkins();
        this.collection.refresh();
        return { selected, coinSkin: this.save.snapshot.selectedCoinSkin, cabinetSkin: this.save.snapshot.selectedCabinetSkin };
      },
      enableTelemetry: () => {
        this.telemetry.enable();
        return { enabled: true };
      },
      telemetry: () => this.telemetry.summary(),
      /** P4 投放演出：统一入口。返回值含承诺数/降级标记，事件进 telemetry.showEvents。 */
      showRequest: (id: string, opts?: { count?: number; kind?: CoinKind; x?: number }) =>
        this.shows.request(id as ShowId, opts),
      /** XIXI 槽位映射（引擎纯函数）：判据枚举调用它收成集合，不在测试里手写分段。 */
      xixiSlot: (x: number) => xixiSlot(x),
      /**
       * 直接摇一次背板老虎机（可指定符号）。
       * 奖励路径必须可逐一指定验证：「力力力→加力入账且 earned 不动」、
       * 「塔塔塔→ShowDirector 登记」，不能靠权重随机去赌。
       */
      xixiSpin: (symbol?: string) => this.slotMachine.spin(symbol as SlotSymbol | undefined),
    };
  }

  /** 调试用：列出指定点附近的碰撞体实际世界位置。 */
  private probeColliders(x: number, y: number, z: number): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    const radius = 0.6;
    this.physics.world.colliders.forEach((collider) => {
      const t = collider.translation();
      const dx = t.x - x;
      const dy = t.y - y;
      const dz = t.z - z;
      if (Math.hypot(dx, dy, dz) > radius) return;
      const r = collider.rotation();
      const shape = collider.shape as unknown as {
        type: number;
        halfExtents?: () => unknown;
        halfHeight?: number;
        radius?: number;
      };
      out.push({
        handle: collider.handle,
        isSensor: collider.isSensor(),
        t: [round3(t.x), round3(t.y), round3(t.z)],
        q: [round3(r.x), round3(r.y), round3(r.z), round3(r.w)],
        shapeType: shape.type,
        half: typeof shape.halfExtents === 'function' ? shape.halfExtents() : null,
        // 圆柱（钉子）：halfHeight 是沿自身 y 轴的半长，配合 q 的旋转可还原世界长度。
        cylinder:
          typeof shape.halfHeight === 'number'
            ? { halfHeight: shape.halfHeight, radius: shape.radius ?? null }
            : null,
      });
    });
    return out;
  }

  /**
   * 调试/试玩用：采样活跃币的位置与速度。
   *
   * `slot` 是对象池里的固定槽位号——`forEachActive` 会跳过停用的币，
   * 数组下标会被压缩，只有槽位号才能跨帧稳定标识同一枚币。
   */
  private sampleCoins(): Array<{
    slot: number;
    kind: string;
    x: number;
    y: number;
    z: number;
    vz: number;
    speed: number;
    /**
     * 币面法线（圆柱轴）与竖直方向的夹角，单位度。0 = 平躺。
     *
     * 验证脚本判「穿模」时要靠它：两枚币心在竖直方向只差几毫米、横向又只差几厘米，
     * **平躺**的两枚是真的挤穿了，而**倾斜**的那枚是搭在邻居的币边上——
     * 后者是真实币堆的正常形态，只看坐标会把它们混为一谈。
     */
    tiltDeg: number;
    /**
     * 物理体是否处于「睡眠」状态。
     *
     * 睡眠会**冻结穿透修正**：Rapier 只对活跃体做位置修正，一旦在互相嵌入的
     * 状态下睡着，穿透就永久留在那里（速度是 0，所以「静止」断言照样通过）。
     * 诊断穿模必须能区分「静止的合法姿态」与「睡着了冻住的穿透」。
     */
    sleeping: boolean;
    playerDropped: boolean;
  }> {
    const out: Array<{
      slot: number;
      kind: string;
      x: number;
      y: number;
      z: number;
      vz: number;
      speed: number;
      tiltDeg: number;
      sleeping: boolean;
      playerDropped: boolean;
    }> = [];
    this.coins.coins.forEach((coin, slot) => {
      if (!coin.active) return;
      const p = coin.position;
      const r = coin.body.rotation();
      // 把局部 +Y 用四元数转到世界系，再与 (0,1,0) 取夹角。
      const upY = 1 - 2 * (r.x * r.x + r.z * r.z);
      const tiltDeg = (Math.acos(Math.min(1, Math.max(-1, upY))) * 180) / Math.PI;
      out.push({
        slot,
        kind: coin.kind,
        x: round3(p.x),
        y: round3(p.y),
        z: round3(p.z),
        vz: round3(coin.body.linvel().z),
        // 合速度：静置断言要的是「真的不动了」，只看 vz 会漏掉横向漂移。
        speed: round3(coin.speed()),
        tiltDeg: round1(tiltDeg),
        sleeping: coin.body.isSleeping(),
        playerDropped: coin.playerDropped,
      });
    });
    return out;
  }

  /**
   * 把 `tuning` 里的一切落到实际系统上。调试面板与验证脚本的 `setTuning` 共用这一条路径，
   * 免得出现「面板改了但某个子系统没跟上」的半生效状态。
   */
  private applyTuning(): void {
    this.renderer.toneMappingExposure = this.tuning.exposure;
    this.audio.setMuted(this.tuning.muted);
    this.pusher.travel = this.tuning.pusherTravel;
    this.physics.applyTuning({
      gravity: this.tuning.gravity,
      solverIterations: this.tuning.solverIterations,
      erp: this.tuning.erp,
    });
    // 每枚币的额外迭代次数：这是**币自己的属性**（走 RigidBody 而不是世界参数），
    // 所以要在币池上逐个施加。默认 0——见 `Coin` 构造函数的注释。
    const extraIterations = Math.max(0, Math.round(this.tuning.coinSolverIterations));
    for (const coin of this.coins.coins) {
      coin.body.setAdditionalSolverIterations(extraIterations);
    }
    this.fitCamera();
  }

  /** 竖直向下打一条射线，报告第一个命中的碰撞体（诊断币堆穿模用）。 */
  private castDown(
    x: number,
    y: number,
    z: number,
  ): { distance: number; hitY: number; shapeType: number; isSensor: boolean } | null {
    const ray = new RAPIER.Ray({ x, y, z }, { x: 0, y: -1, z: 0 });
    const hit = this.physics.world.castRay(ray, 5, true);
    if (!hit) return null;
    const collider = hit.collider;
    const t = collider.translation();
    const shape = collider.shape as unknown as { type: number };
    return {
      distance: round3(hit.toi),
      hitY: round3(t.y),
      shapeType: shape.type,
      isSensor: collider.isSensor(),
    };
  }

  /**
   * 渲染侧的真实位置：地板网格顶面、推板顶面、最低几枚币的网格中心。
   *
   * 存在的理由：物理读数说「币沉在地板下方」，画面却说「币好好地摆在地板上」时，
   * 必须有一条能把**渲染**与**物理**放在同一把尺子上量的通路，否则只能靠猜。
   */
  private probeMeshes(): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    const box = new THREE.Box3();
    const record = (label: string, object: THREE.Object3D) => {
      if (!object.visible) return;
      box.setFromObject(object);
      out.push({
        label,
        min: [round3(box.min.x), round3(box.min.y), round3(box.min.z)],
        max: [round3(box.max.x), round3(box.max.y), round3(box.max.z)],
        worldY: round3(object.getWorldPosition(new THREE.Vector3()).y),
      });
    };

    this.tableGroup?.traverse((child) => {
      const role = (child.userData as { role?: string }).role;
      if (role === 'floor' && (child as THREE.Mesh).isMesh) record('floor', child);
      if (role === 'pusherTop' && (child as THREE.Mesh).isMesh) record('pusherTop', child);
    });

    // 最低的三枚活跃币：渲染位置与物理位置一起报
    const active = this.coins.coins
      .map((coin, slot) => ({ coin, slot }))
      .filter((entry) => entry.coin.active)
      .map((entry) => ({ ...entry, y: entry.coin.body.translation().y }))
      .sort((a, b) => a.y - b.y)
      .slice(0, 3);
    for (const entry of active) {
      // P3 起币走 InstancedMesh：没有逐枚的 Object3D 可量，渲染位置从实例矩阵读回，
      // 包围盒用币半径近似——探针要的是「渲染与物理对在同一把尺子上」，不是精确 AABB。
      const p = entry.coin.renderPosition();
      if (!p) continue;
      const r = COIN.radius;
      out.push({
        label: `coin#${entry.slot}(物理y=${round3(entry.y)})`,
        min: [round3(p.x - r), round3(p.y - r), round3(p.z - r)],
        max: [round3(p.x + r), round3(p.y + r), round3(p.z + r)],
        worldY: round3(p.y),
      });
    }
    return out;
  }

  /**
   * 从接触流形读真实穿透深度（负距离 = 穿透）。
   *
   * 返回两组数：币与币之间、以及币与**静态机台**（地板/护栏/推板）之间的最深穿透。
   * 两者要分开看：币躺在地板上时本来就有毫米级穿透（Rapier 的 `allowedLinearError`
   * 默认就是 1 毫米），而那属于正常工作区间；币与币之间嵌进半个币厚才是缺陷。
   */
  private penetrationReport(limitMillimeters: number): {
    coinContacts: number;
    staticContacts: number;
    coinDeepest: number;
    staticDeepest: number;
    overLimit: number;
    worst: Array<{ depth: number; pair: string; at: [number, number, number] }>;
  } {
    const world = this.physics.world;
    const limit = limitMillimeters / 1000;
    const seen = new Set<string>();
    const worst: Array<{ depth: number; pair: string; at: [number, number, number] }> = [];
    let coinContacts = 0;
    let staticContacts = 0;
    let coinDeepest = 0;
    let staticDeepest = 0;
    let overLimit = 0;

    this.coins.coins.forEach((coin, slot) => {
      if (!coin.active) return;
      const own = coin.body.collider(0);
      world.contactPairsWith(own, (other) => {
        // 同一对接触会被两边各报一次，按句柄排序去重。
        const key = own.handle < other.handle ? `${own.handle}:${other.handle}` : `${other.handle}:${own.handle}`;
        if (seen.has(key)) return;
        seen.add(key);

        // 币是圆柱，机台是 cuboid，用形状类型区分（不需要额外的分组标记）。
        const otherShape = other.shape as unknown as { type: number };
        const isCoinPair = otherShape.type !== 1;

        world.contactPair(own, other, (manifold) => {
          for (let i = 0; i < manifold.numContacts(); i += 1) {
            const distance = manifold.contactDist(i);
            if (distance >= 0) continue;
            const depth = -distance;
            if (isCoinPair) {
              coinContacts += 1;
              coinDeepest = Math.max(coinDeepest, depth);
            } else {
              staticContacts += 1;
              staticDeepest = Math.max(staticDeepest, depth);
            }
            if (depth > limit) overLimit += 1;
            worst.push({
              depth: round3(depth),
              pair: isCoinPair ? `coin#${slot} ↔ coin` : `coin#${slot} ↔ 机台`,
              at: [round3(coin.position.x), round3(coin.position.y), round3(coin.position.z)],
            });
          }
        });
      });
    });

    worst.sort((a, b) => b.depth - a.depth);
    return {
      coinContacts,
      staticContacts,
      coinDeepest: round3(coinDeepest),
      staticDeepest: round3(staticDeepest),
      overLimit,
      worst: worst.slice(0, 5),
    };
  }

  private applyTestState(name: string): string {
    switch (name) {
      case 'ready':
        this.startRun();
        return name;
      case 'playing':
        this.startRun();
        this.run.beginPlay();
        this.pusher.start();
        return name;
      case 'drain':
        // 收尾场景：把筹码清零触发沉降。满盘沉降会回吐筹码 → 本局继续，
        // 所以这个状态同时也是「停板窗口」的入口（扫板/转轮的开放条件）。
        this.startRun();
        this.run.beginPlay();
        this.run.spendChips(this.run.chips);
        this.run.enterRuinSettle();
        this.pusher.start();
        return name;
      case 'ruin':
        // 破产弹窗场景：筹码清零、沉降收尾、弹嘲讽窗。
        this.startRun();
        this.run.beginPlay();
        this.run.spendChips(this.run.chips);
        this.run.enterRuinSettle();
        this.showRuin();
        return name;
      case 'settled':
        this.startRun();
        this.run.finish();
        this.showEndlessSummary();
        return name;
      default:
        throw new Error(`未知测试状态: ${name}`);
    }
  }

  private publishDiagnostics(): void {
    const info = this.renderer.info;
    const snapshot = this.run.snapshot();
    const canvas = this.renderer.domElement;
    window.__THREE_GAME_DIAGNOSTICS__ = {
      frame: this.frame,
      elapsed: this.elapsed,
      phase: snapshot.phase,
      // 三账本：`chips === buyIn + earned + begged − spent` 必须在每一帧都成立。
      chips: snapshot.chips,
      buyIn: snapshot.buyIn,
      earned: snapshot.earned,
      begged: snapshot.begged,
      spent: snapshot.spent,
      cashOut: this.run.cashOut,
      wallet: this.save.wallet,
      bestCombo: snapshot.bestCombo,
      /** XIXI 四槽亮灭（跨局持续；点亮/集齐事件在 telemetry.xixiEvents）。 */
      xixi: [...this.xixi],
      boostCharges: snapshot.boostCharges,
      settleReason: snapshot.settleReason,
      /** 收尾阶段推板是否已停板（扫板/转轮的开放条件）。 */
      plateStopped: snapshot.plateStopped,
      activeCoins: this.coins.activeCount(),
      anomalies: this.anomalyCount,
      /** 异常币飞出时的坐标与速度（`anomalies > 0` 时用它定位，最多 12 条）。 */
      anomalySamples: this.anomalySamples,
      /**
       * 速度护栏的计数与峰值（见 `COIN.maxSpeed`）。
       *
       * **这是「求解器还在不在造能量」的直接读数**：围板补上之后 `anomalies` 恒为 0
       * 是必然的（币根本出不去），所以它不再是有效判据；`spikeClamps` 才是。
       */
      spikeClamps: this.spikeClamps,
      peakSpikeSpeed: round3(this.peakSpikeSpeed),
      // 钉阵：网格是显示长度，碰撞体是物理长度，两者刻意不同（只改显示不改物理）。
      pegs: {
        count: this.pegs.count,
        colliderHalfLength: this.pegs.colliderHalfLength,
        visualHalfLength: this.pegs.visualHalfLength,
      },
      input: {
        lane: round3(this.lastIntent?.lane ?? 0),
        laneX: round3(this.lastIntent?.laneX ?? 0),
        mode: this.lastIntent?.mode ?? 'auto',
        manualHoldLeft: round3(this.lastIntent?.manualHoldLeft ?? 0),
      },
      motion: {
        reduced: this.motion.reduced,
        source: this.motion.source,
      },
      // 机关：剩余次数与币预算余量（后装填/转轮会撞预算上限）。
      mechanisms: { ...this.mechanismSnapshot(), coinsRemaining: this.coins.remaining },
      // 投放演出：两态判据读这个——registered 时币尚未动，completed 时币已到位。
      shows: { busy: this.shows.busy, queued: this.shows.queued, active: this.shows.activeId },
      // 加注档位：`mul` 是越线返值倍率（押 5 枚 = ×4，押越大单位期望越低）。
      bet: {
        index: this.betIndex,
        chips: ENDLESS.bets[this.betIndex].chips,
        mul: ENDLESS.bets[this.betIndex].mul,
      },
      // 热区：亮条位置（无尽恒开）。
      hotZone: {
        active: this.config.hotZone,
        x: round3(this.hotZoneX),
        halfWidth: TABLE.hotZone.halfWidth,
      },
      // 本局：筹码、存活投数、筹码峰值、破产弹窗状态。
      endless: {
        active: true,
        begs: this.begsThisRun,
        totalBegs: this.save.begCount(),
        drops: snapshot.drops,
        chipsPeak: snapshot.chipsPeak,
        bestEarned: this.save.snapshot.bestEarned,
        ruinVisible: this.hud.ruinVisible,
        // 大赏币注入间隔。测试读这里而不是写死数字：P8 重新标定时
        // 硬编码的 15/30 会让断言变成假失败，而它其实只是配置。
        bountyEveryDrops: ENDLESS.bountyEveryDrops,
        // 本局已注入的大赏币枚数（注入率断言的分子）。
        bounties: snapshot.bounties,
      },
      pusher: {
        offset: this.pusher.offset,
        phase: this.pusher.currentPhase,
        running: this.pusher.running,
        cycles: this.pusher.cyclesCompleted,
        frontFaceZ: this.pusher.frontFaceZ,
      },
      physics: {
        bodies: this.physics.bodyCount,
        colliders: this.physics.colliderCount,
        substeps: this.physics.substeps,
        // 诊断里带上当前物理旋钮：穿模/节奏的每一条实测记录都必须能对应到一组参数上，
        // 否则「这次跑为什么不一样」永远查不出来。
        tuning: { ...this.physics.tuning, coinSolverIterations: this.tuning.coinSolverIterations },
      },
      performance: {
        fps: round3(this.governor.fps),
        tier: this.governor.current.tier,
        maxDpr: this.tuning.maxDpr,
        shadows: this.governor.current.shadows,
      },
      collection: {
        wallet: this.save.wallet,
        coinSkin: this.save.snapshot.selectedCoinSkin,
        cabinetSkin: this.save.snapshot.selectedCabinetSkin,
        coinSkins: this.save.snapshot.coinSkins.length,
        cabinetSkins: this.save.snapshot.cabinetSkins.length,
      },
      renderer: {
        calls: info.render.calls,
        triangles: info.render.triangles,
        geometries: info.memory.geometries,
        textures: info.memory.textures,
      },
      canvas: {
        clientWidth: canvas.clientWidth,
        clientHeight: canvas.clientHeight,
        width: canvas.width,
        height: canvas.height,
        dpr: Math.min(window.devicePixelRatio || 1, this.tuning.maxDpr),
      },
    };
  }

  private getElement(selector: string): HTMLElement {
    const element = document.querySelector<HTMLElement>(selector);
    if (!element) throw new Error(`缺少元素: ${selector}`);
    return element;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** 角度只留一位小数：诊断里要的是「平躺 / 搭着 / 立起」三档，不是精确姿态。 */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
