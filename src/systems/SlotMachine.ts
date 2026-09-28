import * as THREE from 'three';
import { TABLE } from '../game/constants';
import type { IconId } from '../game/icons';
import {
  REEL_STRIP,
  SLOT_FINE_COLOR,
  SLOT_MISS_COLOR,
  SLOT_PENALTY_CHIPS,
  SLOT_SYMBOL_COLORS,
  SLOT_SYMBOL_GLYPHS,
  SLOT_SYMBOL_KIND,
  SLOT_SYMBOL_LABELS,
  reelFacesFor,
  reelStripIndex,
  rollSlotOutcome,
  type SlotOutcome,
  type SlotSymbol,
} from '../game/xixi';
import { createReelStripTexture, ICON_TEXELS, reelOffsetFor } from '../render/iconTexture';
import { makeToonMaterial, type LitMaterial } from '../render/ToonMaterial';
import { BOOST_OVERFLOW_FALLBACK, type ShowDirector } from './ShowDirector';
import type { Telemetry } from './Telemetry';

/**
 * 背板老虎机（P5 建，**P10 重做**）：XIXI 四槽集齐的奖励装置。
 *
 * ## P10 改了什么，以及为什么
 *
 * 旧版是**三个纯几何圆柱**，滚筒上不画任何图标——结果只靠一盏灯的 `emissive` 颜色
 * 加一行 HUD 文字表达。玩家原话「演出效果不太明显」，图标缺失是主因之一：
 * 灯色变化在余光里根本读不到。
 *
 * 现在：**四个平面「滚筒窗」**，每格显示一个 32×32 像素图标，转动 = 贴图纵向滚动。
 *
 * ## ★ 为什么不是圆柱（这一条推翻 P5 的「三个几何滚筒」）
 *
 * 算过：0.34 米直径、16 段的多边形圆柱，**一个 32×32 的图标只摊到约 2.7 个折面**
 * （周长 π×0.34 = 1.07 米，一格 0.178 米弧长，每段 0.067 米）。
 * 像素画贴在折面上必然被压成几块斜面，而且弧面上的像素宽窄不一——
 * 那是像素风里最刺眼的缺陷。平面窗 + 滚动贴图是**同一件事的另一种画法**
 * （真实老虎机的视频滚筒也是这个原理），像素 1:1、零变形。
 *
 * ## 街机老虎机的标准做法：**先定结果、再演停格**
 *
 * 结果由 `xixi.ts` 的三分类表决定（45% 中奖 / 15% 胡萝卜惩罚 / 40% 杂牌），
 * 四个滚筒错开停格演出来，然后兑现。停格画面由 `reelFacesFor` 给，
 * **四个滚筒在 `win` / `fine` 时是同号（四连），在 `miss` 时两两不同**——
 * 「有没有凑齐」在画面上自证。
 *
 * 奖励表（硬约束：**不走 `gainChips`**，越线返值仍是唯一筹码来源）：
 *   力 → `grantBoost()`（存满 → 改派 `BOOST_OVERFLOW_FALLBACK` 小型补货，**不空响**）
 *   塔 / 泉 / 钻 / 箱 → `ShowDirector.request(...)`（真币演出）
 *   胡萝卜四连 → 扣本局筹码（走 `RunState.fineChips`，账本恒等式一字不改）
 */

type SlotDeps = {
  shows: ShowDirector;
  telemetry: Telemetry;
  /** HUD 文案（奖励宣告 / 加力已满 / 罚款）。 */
  notify: (message: string) => void;
  now: () => number;
  rng: () => number;
  reducedMotion: () => boolean;
  /** 加力入账（RunState.grantBoost）：存满拒收返回 false。 */
  grantBoost: () => boolean;
  /** 加力就绪音效。 */
  onBoostReady: () => void;
  /** 胡萝卜四连的罚款：从本局筹码里扣到 0 为止，返回**实扣**数额。 */
  fineChips: (amount: number) => number;
  /** 中奖音效（灯条点亮那一刻）。 */
  onReveal?: (outcome: SlotOutcome) => void;
  /**
   * 开始转动的音效。参数是**本次转动的总时长**（秒）——素材只有 1 秒，
   * 而转动持续 3.4~4.0 秒，需要据此排程重复播放才能覆盖整段。
   */
  onSpinStart?: (seconds: number) => void;
};

/**
 * 滚筒数。**这是唯一一处**：停格时刻表、转速系数、建几何的循环全部由它推出来，
 * 加一格不用去三个地方改。
 */
const REEL_COUNT = 4;

/**
 * 每个滚筒的停格时刻（秒）。4 格错开 0.45 秒——错开是「四连」这件事的**悬念来源**：
 * 前两格先停、后两格还在滚，玩家会在这半秒里读前两格。
 */
const REEL_STOPS = [0.9, 1.35, 1.8, 2.25];
if (REEL_STOPS.length !== REEL_COUNT) {
  throw new Error(`停格时刻表有 ${REEL_STOPS.length} 项，滚筒有 ${REEL_COUNT} 个`);
}
/** 结果灯条点亮（「揭晓」那一刻）。 */
const REVEAL_AT = 2.6;
/** 奖励兑现。 */
const REWARD_AT = 3.0;
/** 常规收尾。 */
const DONE_AT = 3.4;
/**
 * 中奖时多停一拍。
 *
 * 旧版全程 2.6 秒、兑现完立刻复位，中奖与杂牌在时间上**没有任何区别**——
 * 玩家来不及意识到「中了」。多这 0.6 秒是给中奖的仪式感留的。
 */
const WIN_HOLD = 0.6;

/** 贴图滚动速度（图标/秒）。**不能太快**：像素画高速滚动会产生车厢效应（轮子倒转）。 */
const SCROLL_ICONS_PER_SEC = 7.5;
/** 每个窗的转速系数——四格同速看起来像一块板在动，不是四个滚筒。 */
const REEL_SPEED_MUL = [1, 1.14, 0.92, 1.07];
/** 停格前多久开始减速（秒）。 */
const DECEL = 0.55;

/**
 * 滚筒窗的世界尺寸（米）。
 *
 * ★ **0.34 米不是随便挑的**：1280×720、`fov=42` 下背板 `(0, 0.7, -1.35)` 处是
 * **188.7 CSS px/米**；默认像素倍率 ×2 → **94.3 后备像素/米**。
 * 0.34 × 94.3 ≈ **32** → 32×32 的图标正好 **1:1** 落在后备缓冲上。
 * 改成别的值就会引入非整数缩放（32→24 会让像素行宽窄不一）。
 * 判据读 `reelWindowReport()`，不靠截图目测。
 */
const REEL_WINDOW = 0.34;
const REEL_GAP = 0.035;
const REEL_Y = 0.76;
const FRAME = { width: 1.55, height: 0.5, depth: 0.05 };
const LAMP = { width: 1.45, height: 0.06, depth: 0.02, y: 0.5 };
/** 窗与灯条相对背板的 z 偏移（框 0.05 厚，窗要探出框面）。 */
const PANEL_Z = 0.05;

export class SlotMachine {
  readonly group = new THREE.Group();

  private readonly reels: THREE.Mesh[] = [];
  /** 每块窗自己的贴图（`offset` 是 `Texture` 的 own property，四格必须各一份）。 */
  private readonly reelTextures: THREE.CanvasTexture[] = [];
  private readonly lamps: LitMaterial[] = [];
  private spinning = false;
  private spinT = 0;
  private outcome: SlotOutcome | null = null;
  private faces: IconId[] = [];
  private targetIndex: number[] = [0, 0, 0, 0];
  private revealed = false;
  private rewarded = false;

  constructor(private readonly deps: SlotDeps) {
    this.buildMeshes();
  }

  get busy(): boolean {
    return this.spinning;
  }

  /**
   * 摇一次。返回摇出的结果；正在转时拒绝（调用方负责等上一场）。
   *
   * `forced` 只给测试钩子用：奖励路径必须可指定结果逐一验证。
   * 接受 `SlotSymbol`（= 中奖）或 `'fine'` / `'miss'`。
   */
  spin(forced?: SlotSymbol | 'fine' | 'miss'): { outcome: SlotOutcome } | null {
    if (this.spinning) return null;
    // 固定消耗两次 rng：一次定分类，一次定分类内部的细节（中奖摇哪个符号 / 杂牌停哪四格）。
    // 两者互斥，所以两次够用。**即便强制指定结果也照抽**——消耗模式与随机路径一致，
    // 同一个种子跑出来的后续序列才不会因为「有没有用钩子」而分叉。
    const roll = this.deps.rng();
    const detail = this.deps.rng();
    const outcome: SlotOutcome =
      forced === 'fine'
        ? { kind: 'fine' }
        : forced === 'miss'
          ? { kind: 'miss' }
          : forced
            ? { kind: 'win', symbol: forced }
            : rollSlotOutcome(roll, detail);

    this.outcome = outcome;
    this.faces = reelFacesFor(outcome, detail);
    this.targetIndex = this.faces.map((icon) => reelStripIndex(icon));
    this.spinning = true;
    this.revealed = false;
    this.rewarded = false;
    this.spinT = 0;
    for (const lamp of this.lamps) lamp.emissiveIntensity = 0;
    this.deps.telemetry.recordXixi({
      phase: 'spin',
      outcome: outcome.kind,
      symbol: outcome.kind === 'win' ? outcome.symbol : undefined,
      faces: [...this.faces],
      t: this.deps.now(),
    });
    this.deps.notify('老虎机转动……');
    // 转动总时长随结果变化（中奖多停一拍，见 `WIN_HOLD`），音效据此排程重复播放。
    this.deps.onSpinStart?.(DONE_AT + (outcome.kind === 'win' ? WIN_HOLD : 0));
    return { outcome };
  }

  /** 每帧推进（与 ShowDirector 同节奏，挂在 Game.update）。 */
  update(delta: number): void {
    if (!this.spinning) return;
    const speed = this.deps.reducedMotion() ? 3 : 1;
    this.spinT += delta * speed;

    const tiles = REEL_STRIP.length;
    this.reelTextures.forEach((texture, index) => {
      const stop = REEL_STOPS[Math.min(index, REEL_STOPS.length - 1)];
      if (this.spinT < stop) {
        // 转动中：贴图纵向滚动。停格前 `DECEL` 秒内按平方曲线减速——
        // 线性减速会让「快停」那一下显得很硬，平方曲线才有机械滚筒的惯性感。
        const remaining = stop - this.spinT;
        const ease = Math.min(1, remaining / DECEL);
        const speedMul = REEL_SPEED_MUL[Math.min(index, REEL_SPEED_MUL.length - 1)];
        const iconsPerSec = SCROLL_ICONS_PER_SEC * speedMul * (0.2 + 0.8 * ease * ease);
        texture.offset.y += (delta * speed * iconsPerSec) / tiles;
      } else {
        // 停格：吸附到目标格。**必须保持圈数连续**（见 `snapTo`）。
        this.snapTo(texture, this.targetIndex[index], tiles);
      }
    });

    if (!this.revealed && this.spinT >= REVEAL_AT && this.outcome) {
      this.revealed = true;
      this.revealLamps(this.outcome);
      this.deps.onReveal?.(this.outcome);
    }
    if (!this.rewarded && this.spinT >= REWARD_AT && this.outcome) {
      this.rewarded = true;
      this.applyReward(this.outcome);
    }
    const done = DONE_AT + (this.outcome?.kind === 'win' ? WIN_HOLD : 0);
    if (this.spinT >= done) {
      this.spinning = false;
      this.outcome = null;
    }
  }

  /**
   * 中止摇奖（开新局 / 收工用）：**不兑现**尚未落地的奖励。
   * 奖励随本局作废——上一局的奖励注入到下一局的盘面就是跨局平移。
   */
  abort(): void {
    this.spinning = false;
    this.spinT = 0;
    this.outcome = null;
    this.revealed = false;
    this.rewarded = false;
    for (const lamp of this.lamps) lamp.emissiveIntensity = 0;
  }

  dispose(): void {
    this.group.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
        const material = child.material;
        if (Array.isArray(material)) material.forEach((m) => m.dispose());
        else material.dispose();
      }
    });
    // 贴图是每块窗一份、由本类创建的，`material.dispose()` 不会连带释放。
    for (const texture of this.reelTextures) texture.dispose();
    this.reelTextures.length = 0;
    this.group.clear();
  }

  /**
   * 滚筒窗的读数（**判据读它，不读截图**）。
   *
   * 「图标在画面上到底占几个像素」这件事只能靠读数确认：截图上看「有点糊」
   * 无法反推是窗口太小、贴图被缩放、还是像素倍率档位不对。
   * 世界尺寸给出来，验证脚本结合 `pixelScale.upscale` 与投影就能算出后备像素边长。
   */
  reelWindowReport(): {
    count: number;
    windowSize: number;
    /** 窗口中心的世界高度 / 深度——**给 `backPixelSize` 用**。 */
    windowY: number;
    windowZ: number;
    /** 相邻两窗中心的世界间距（含缝），判据拿它核「四格不重叠」。 */
    windowPitch: number;
    iconTexels: number;
    stripTiles: number;
    /** 停格位置（格号），`miss` 时四个互不相同。 */
    targetIndex: number[];
    /** 当前画面上的图标（转动中会变，静止时 = 目标）。 */
    faces: IconId[];
    /** 结果灯条是否已点亮 + 当前自发光强度（0 = 暗）。 */
    lampIntensity: number;
    /** 是否正在转。 */
    spinning: boolean;
  } {
    return {
      count: this.reels.length,
      windowSize: REEL_WINDOW,
      windowY: REEL_Y,
      windowZ: TABLE.backZ + PANEL_Z,
      windowPitch: REEL_WINDOW + REEL_GAP,
      iconTexels: ICON_TEXELS,
      stripTiles: REEL_STRIP.length,
      targetIndex: [...this.targetIndex],
      faces: [...this.faces],
      lampIntensity: this.lamps[0]?.emissiveIntensity ?? 0,
      spinning: this.spinning,
    };
  }

  /**
   * 把 `offset.y` 吸附到目标格，**保持圈数连续**。
   *
   * ⚠️ 直接写 `offset.y = reelOffsetFor(index)` 是个坑：转动期间 offset 已经涨到
   * 十几（每圈 = 1），直接赋值等于让它**倒回去十几圈**，画面上是一次剧烈的反向跳变。
   * 纹理是 `RepeatWrapping` 的，所以只要保持 `offset mod 1` 不变，视觉位置就对——
   * 把差值取整补回去即可。
   */
  private snapTo(texture: THREE.Texture, index: number, tiles: number): void {
    const target = reelOffsetFor(index, tiles);
    const revolutions = Math.round(texture.offset.y - target);
    texture.offset.y = target + revolutions;
  }

  private revealLamps(outcome: SlotOutcome): void {
    const color =
      outcome.kind === 'win'
        ? SLOT_SYMBOL_COLORS[outcome.symbol]
        : outcome.kind === 'fine'
          ? SLOT_FINE_COLOR
          : SLOT_MISS_COLOR;
    const intensity = outcome.kind === 'miss' ? 0.7 : 1.5;
    for (const lamp of this.lamps) {
      lamp.emissive.set(color);
      lamp.emissiveIntensity = intensity;
    }
  }

  private applyReward(outcome: SlotOutcome): void {
    if (outcome.kind === 'miss') {
      this.deps.telemetry.recordXixi({
        phase: 'reward',
        outcome: 'miss',
        faces: [...this.faces],
        granted: false,
        delivered: 0,
        t: this.deps.now(),
      });
      this.deps.notify('老虎机：杂牌，没凑齐');
      return;
    }

    if (outcome.kind === 'fine') {
      const fined = this.deps.fineChips(SLOT_PENALTY_CHIPS);
      this.deps.telemetry.recordXixi({
        phase: 'reward',
        outcome: 'fine',
        faces: [...this.faces],
        granted: false,
        delivered: 0,
        fined,
        t: this.deps.now(),
      });
      this.deps.notify(
        fined > 0
          ? `老虎机：胡萝卜×4，罚 ${fined} 筹码`
          : '老虎机：胡萝卜×4，但你已经一分不剩了',
      );
      return;
    }

    const { symbol } = outcome;
    const glyph = SLOT_SYMBOL_GLYPHS[symbol];

    if (symbol === 'boost') {
      const granted = this.deps.grantBoost();
      if (granted) {
        this.deps.telemetry.recordXixi({
          phase: 'reward',
          outcome: 'win',
          symbol,
          faces: [...this.faces],
          granted,
          t: this.deps.now(),
        });
        this.deps.onBoostReady();
        this.deps.notify(`老虎机：${glyph}${glyph}${glyph}${glyph}！加力 +1`);
        return;
      }

      // ★ 存满兜底（P10 ⑨）：**不能空响**。`boostStoreCap = 1` + 45% 中奖率 +
      //   力占 26/45，使「加力已满」成为最常见的中奖失效形态（详见
      //   `BOOST_OVERFLOW_FALLBACK` 的推导）。兜底改派一场**小型补货**演出：
      //   与其余四个符号同构（奖励 = 看得见的真币），且不碰账本不变式。
      const fallback = this.deps.shows.request(BOOST_OVERFLOW_FALLBACK.show, {
        count: BOOST_OVERFLOW_FALLBACK.count,
      });
      this.deps.telemetry.recordXixi({
        phase: 'reward',
        outcome: 'win',
        symbol,
        faces: [...this.faces],
        granted: false,
        // 兜底实发的枚数照记进 `delivered`：`granted === false && delivered > 0`
        // 就是「加力没进去、但玩家没有空手」的可对账形态。
        delivered: fallback.ok ? fallback.promised : 0,
        t: this.deps.now(),
      });
      this.deps.notify(
        fallback.ok
          ? `老虎机：${glyph}${glyph}${glyph}${glyph}！加力已存满 → 改派补货 ${fallback.promised} 枚`
          : `老虎机：${glyph}${glyph}${glyph}${glyph}，加力已存满且${fallback.reason}`,
      );
      return;
    }

    // 除加力外，每个符号都直接是 ShowDirector 的 ShowId：奖励一律是「一场真币演出」。
    // 钻 / 箱要指定币种，否则演出会默认注入铜币——那就成了「钻石奖励给一枚铜币」。
    const result = this.deps.shows.request(symbol, { kind: SLOT_SYMBOL_KIND[symbol] });
    this.deps.telemetry.recordXixi({
      phase: 'reward',
      outcome: 'win',
      symbol,
      faces: [...this.faces],
      granted: result.ok,
      delivered: result.promised,
      t: this.deps.now(),
    });
    this.deps.notify(
      result.ok
        ? `老虎机：${glyph}${glyph}${glyph}${glyph}！${SLOT_SYMBOL_LABELS[symbol]}演出奉上`
        : `老虎机：${glyph}${glyph}${glyph}${glyph}，但${result.reason}`,
    );
  }

  private buildMeshes(): void {
    const frameMaterial = makeToonMaterial({
      name: 'slotFrame',
      color: '#4a3f2e',
      ramp: 'metal',
      // 老虎机框是金属件，给拉丝（滚筒面保持干净，免得转动时闪）。
      // 频率比机柜更低：框有 1.55 米宽、离相机更远，像素率更低。
      detailKind: 1,
      detailScale: 2.5,
    });

    // 背板前的挂机框（z 微微探出板面，纯视觉，无碰撞体）。
    const frame = new THREE.Mesh(
      new THREE.BoxGeometry(FRAME.width, FRAME.height, FRAME.depth),
      frameMaterial,
    );
    frame.position.set(0, REEL_Y, TABLE.backZ + 0.02);
    frame.userData.part = 'slotFrame';
    this.group.add(frame);

    // 四块滚筒窗。★ **每块一份材质**：`offset` 挂在 `Texture` 上，四格必须各有一份贴图；
    // 材质也各建一份（`makeToonMaterial` 很便宜，编译好的程序由 `customProgramCacheKey` 共享）。
    // ⚠️ **不能 `material.clone()`**：`Material.copy()` 不复制 `onBeforeCompile`，
    // 克隆体静默退回灰阶色带（零报错，只有暗部不再换色相）。
    for (let index = 0; index < REEL_COUNT; index += 1) {
      const strip = createReelStripTexture();
      this.reelTextures.push(strip);
      const material = makeToonMaterial({
        name: 'slotReelWindow',
        // 基色纯白：贴图是乘在它上面的，填别的颜色等于给图标整体染色。
        color: '#ffffff',
        ramp: 'metal',
        map: strip,
        // 图标**按自己的颜色发光**（而不是平铺一层白）：亮处亮、暗处仍暗，
        // 而且背板一旦进色带最低档，图标也不会跟着黑掉——它是一块「显示屏」。
        emissive: '#ffffff',
        emissiveMap: strip,
        emissiveIntensity: 0.42,
      });
      const window = new THREE.Mesh(new THREE.PlaneGeometry(REEL_WINDOW, REEL_WINDOW), material);
      window.position.set(
        (index - 1.5) * (REEL_WINDOW + REEL_GAP),
        REEL_Y,
        TABLE.backZ + PANEL_Z,
      );
      window.userData.part = 'slotReelWindow';
      this.reels.push(window);
      this.group.add(window);
    }

    // 结果灯条：**一条**横贯四格，而不是四盏。
    // 四连同一符号的结果只有一种，所以「一条灯表达同一个结果」在语义上就是对的；
    // 顺带省掉 2 个 draw call（四段以上的同类小件一律 InstancedMesh 的同一条纪律）。
    const lampMaterial = makeToonMaterial({
      name: 'slotLamp',
      color: '#2c2c34',
      ramp: 'accent',
      emissive: '#000000',
      emissiveIntensity: 0,
    });
    const lamp = new THREE.Mesh(new THREE.BoxGeometry(LAMP.width, LAMP.height, LAMP.depth), lampMaterial);
    lamp.position.set(0, LAMP.y, TABLE.backZ + PANEL_Z);
    lamp.userData.part = 'slotLamp';
    this.lamps.push(lampMaterial);
    this.group.add(lamp);
  }
}
