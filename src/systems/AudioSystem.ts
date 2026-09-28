import { kindSpec, type CoinKind } from '../game/constants';

// ── 合成音（兜底路径） ───────────────────────────────────────────────────

type ToneSpec = {
  type: OscillatorType;
  from: number;
  to: number;
  duration: number;
  gain: number;
  delay?: number;
};

// ── 采样素材 ─────────────────────────────────────────────────────────────

/**
 * 逻辑名 → 文件路径。文件由 `npm run prepare:audio` 从 `../音效/` 的原始素材
 * 裁切 + 响度对齐后生成到 `public/audio/`。
 *
 * 路径不带前导斜杠：Vite 会把 `public/` 的内容拷到站点根，用相对路径在
 * 子路径部署（如 GitHub Pages 的项目页）时也能取到。
 */
const SAMPLE_URLS = {
  coin_drop_1: 'audio/coin_drop_1.ogg',
  coin_drop_2: 'audio/coin_drop_2.ogg',
  coin_drop_3: 'audio/coin_drop_3.ogg',
  coin_drop_4: 'audio/coin_drop_4.ogg',
  coin_drop_5: 'audio/coin_drop_5.ogg',
  coin_land_light: 'audio/coin_land_light.ogg',
  coin_land_heavy: 'audio/coin_land_heavy.ogg',
  score_mid_1: 'audio/score_mid_1.ogg',
  score_mid_2: 'audio/score_mid_2.ogg',
  score_big_1: 'audio/score_big_1.ogg',
  score_big_2: 'audio/score_big_2.ogg',
  combo_up: 'audio/combo_up.ogg',
  mark: 'audio/mark.ogg',
  boost_ready: 'audio/boost_ready.ogg',
  boost_use: 'audio/boost_use.ogg',
  slot_spin: 'audio/slot_spin.ogg',
  ui_click: 'audio/ui_click.ogg',
} as const;

export type SampleId = keyof typeof SAMPLE_URLS;

/**
 * 一次发声的配置。
 *
 * `candidates` 多于一个时随机轮播——高频音效（投币、得分）不轮播会被听成复读机。
 * `rateJitter` 在轮播之外再叠一层音高抖动，进一步打散重复感。
 *
 * ⚠️ 这个表是**可变**的：调试面板会实时改 `gain`（见 `setGain`）。
 * 但只有 `gain` 允许运行时改——`group` / `throttleMs` 是节流语义的骨架，
 * 动了会让「同组共享最小间隔」这条约束失效。
 */
export type Selector = {
  /** 调试面板上显示的中文名。 */
  label: string;
  candidates: readonly SampleId[];
  /** 节流分组键。同组共享一个最小间隔窗口。 */
  group: string;
  gain: number;
  /** 播放速率抖动幅度（±比例）。 */
  rateJitter?: number;
  /** 固定播放速率，用来让同一素材表达不同档位（如小奖用更低更暗的版本）。 */
  rate?: number;
  /** 同组两次发声的最小间隔（毫秒）。防止一簇事件同时触发时糊成一片。 */
  throttleMs: number;
};

/**
 * 事件 → 取材表。
 *
 * 节流值按触发密度给：投币/落定一秒可能十几次，压到 40ms 上下；
 * 大赏、加力这类低频高情绪事件给更长的窗口，避免和别的音叠在一起。
 */
export const SELECTORS = {
  drop: {
    label: '投币下落',
    candidates: ['coin_drop_1', 'coin_drop_2', 'coin_drop_3', 'coin_drop_4', 'coin_drop_5'],
    group: 'drop',
    gain: 1.35,
    rateJitter: 0.08,
    throttleMs: 45,
  },
  landLight: {
    label: '落定·轻',
    candidates: ['coin_land_light'],
    group: 'land',
    gain: 1.1,
    rateJitter: 0.1,
    throttleMs: 40,
  },
  landHeavy: {
    label: '落定·重',
    candidates: ['coin_land_heavy'],
    group: 'land',
    gain: 1.25,
    rateJitter: 0.06,
    throttleMs: 40,
  },
  scoreSmall: {
    label: '得分·铜（小）',
    candidates: ['score_mid_1', 'score_mid_2'],
    group: 'score',
    gain: 0.75,
    rate: 0.9,
    throttleMs: 30,
  },
  scoreMid: {
    label: '得分·中',
    candidates: ['score_mid_1', 'score_mid_2'],
    group: 'score',
    gain: 1.15,
    rateJitter: 0.04,
    throttleMs: 30,
  },
  scoreBig: {
    label: '得分·大赏',
    candidates: ['score_big_1', 'score_big_2'],
    group: 'scoreBig',
    gain: 1.4,
    throttleMs: 120,
  },
  comboUp: {
    label: '连击上行',
    candidates: ['combo_up'],
    group: 'combo',
    gain: 0.85,
    throttleMs: 60,
  },
  mark: {
    label: 'XIXI 点亮',
    candidates: ['mark'],
    group: 'mark',
    gain: 1.2,
    throttleMs: 60,
  },
  boostReady: {
    label: '加力就绪',
    candidates: ['boost_ready'],
    group: 'boostReady',
    gain: 1.3,
    throttleMs: 200,
  },
  boostUse: {
    label: '加力使用',
    candidates: ['boost_use'],
    group: 'boostUse',
    gain: 1.3,
    throttleMs: 200,
  },
  payout: {
    label: '返币到账',
    candidates: ['coin_land_heavy'],
    group: 'payout',
    gain: 1.3,
    rateJitter: 0.05,
    throttleMs: 150,
  },
  slotSpin: {
    label: '老虎机转动',
    candidates: ['slot_spin'],
    group: 'slotSpin',
    gain: 1.15,
    throttleMs: 500,
  },
  uiClick: {
    label: 'UI 点击',
    candidates: ['ui_click'],
    group: 'uiClick',
    gain: 0.7,
    throttleMs: 40,
  },
  // ★ 这里刻意**不加 `as const`**：调试面板要实时改 `gain`。
  // `satisfies` 仍然保留，所以字段拼错、漏字段、类型不符都会在编译期被抓出来。
  // 去掉 `as const` 只影响属性的可变性，`keyof` 依旧是这 13 个字面量的并集。
} satisfies Record<string, Selector>;

/** 取材表的键。调试面板与事件目录都以它为槽位标识。 */
export type SelectorKey = keyof typeof SELECTORS;

/**
 * 同时发声上限。超过就丢弃新的（而不是抢占正在播的）——对音效来说，
 * "这一声没响"远好过"声音被掐断"。移动端给更低的额度，避免弱机掉帧。
 */
const VOICE_CAP_TOUCH = 12;
const VOICE_CAP_DESKTOP = 24;

/** 试听一次发声实际走的路径。 */
export type AuditionSource = 'override' | 'sample' | 'synth' | 'none';

/** 一个素材槽位的只读快照，供调试面板枚举音量滑块。 */
export type SelectorInfo = {
  key: SelectorKey;
  label: string;
  group: string;
  gain: number;
  samples: readonly SampleId[];
  throttleMs: number;
  /** 是否已被上传文件临时挂载。 */
  mounted: boolean;
};

/** 一次试听的结果。 */
export type AuditionResult = {
  played: boolean;
  name: string;
  selector: SelectorKey | null;
  source: AuditionSource;
  context: AudioContextState | 'none';
};

/** 音频子系统的调试摘要（进 `__THREE_GAME_DIAGNOSTICS__.audio`）。 */
export type AudioDebugSnapshot = {
  muted: boolean;
  contextState: AudioContextState | 'none';
  loadedSamples: number;
  activeVoices: number;
  voiceCap: number;
  mounted: SelectorKey[];
};

/**
 * 试听上传文件时用的中性配置：不做节流、不加音高抖动、音量原样。
 *
 * 它不参与 `SELECTORS`，因为「试听一个任意文件」在语义上没有对应的事件槽位。
 */
const AUDITION_SELECTOR: Selector = {
  label: '试听',
  candidates: [],
  group: 'audition',
  gain: 1,
  throttleMs: 0,
};

/** 音量滑块的取值范围（面板与 `setGain` 共用）。 */
export const GAIN_MIN = 0;
export const GAIN_MAX = 3;

/**
 * 音效系统。
 *
 * **两条发声路径**：
 *   1. 采样播放（首选）——`public/audio/` 下的 OGG 素材，预解码成 AudioBuffer，
 *      走 BufferSourceNode。零解码延迟，适合卡点音效。
 *   2. 合成音兜底——素材未加载完、加载失败、或该事件还没有素材时，
 *      退回原本的 OscillatorNode 程序化音。
 *
 * ★ 第 2 条同时是**兼容退路**：旧版 Safari 不支持 Ogg Vorbis，
 *   `decodeAudioData` 会 reject，于是全部事件自动走合成音——游戏不会变成哑巴。
 */
export class AudioSystem {
  private context: AudioContext | null = null;
  private unlocked = false;
  private muted = false;

  /** 已解码的素材。加载失败的条目不会出现在这里，播放时自动走兜底。 */
  private readonly samples = new Map<SampleId, AudioBuffer>();
  /** 预载只发起一次。 */
  private preloading: Promise<void> | null = null;
  /** 当前在播的 voice 数，用于并发上限。 */
  private activeVoices = 0;
  private readonly voiceCap: number;
  /** 节流窗口：分组键 → 上次发声时刻（秒，AudioContext 时间轴）。 */
  private readonly lastPlayed = new Map<string, number>();

  /** 正在试听（调试面板发起）：临时绕过静音，并跳过节流窗口。 */
  private auditioning = false;
  /** 最近一次试听实际走的路径。只在试听期间被写入。 */
  private lastSource: AuditionSource = 'none';
  /** 事件槽位的临时挂载：挂载期间该 selector 改用上传的文件发声。 */
  private readonly overrides = new Map<SelectorKey, { buffer: AudioBuffer; name: string }>();

  constructor() {
    const coarse =
      typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
    this.voiceCap = coarse ? VOICE_CAP_TOUCH : VOICE_CAP_DESKTOP;

    const unlock = () => {
      void this.unlock();
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
  }

  async unlock(): Promise<void> {
    if (this.unlocked) return;
    const AudioContextClass =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return;
    this.context = new AudioContextClass();
    await this.context.resume();
    this.unlocked = true;
    // 预载不阻塞解锁：先把上下文跑起来，素材到了自然会接管发声。
    this.preloading = this.preload();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
  }

  /**
   * 等待素材预载完成。
   *
   * 用途有两个：一是让调用方/测试能确认素材**真的解码成功**（而不是悄悄退回
   * 合成音），二是排查「旧 Safari 不支持 Ogg Vorbis」这类兼容问题时有个抓手。
   */
  async whenLoaded(): Promise<void> {
    await this.preloading;
  }

  /** 已成功解码的素材条数。0 表示全部在走合成音兜底。 */
  get loadedSampleCount(): number {
    return this.samples.size;
  }

  // ── 调试接口 ───────────────────────────────────────────────────────────

  /** 全部素材槽位的只读快照。调试面板用它枚举音量滑块。 */
  selectorInfos(): SelectorInfo[] {
    return (Object.keys(SELECTORS) as SelectorKey[]).map((key) => {
      const selector = SELECTORS[key];
      return {
        key,
        label: selector.label,
        group: selector.group,
        gain: selector.gain,
        samples: selector.candidates,
        throttleMs: selector.throttleMs,
        mounted: this.overrides.has(key),
      };
    });
  }

  /**
   * 实时改某个槽位的音量。
   *
   * 之所以能即时生效：`emit()` → `startVoice()` 是在**发声当刻**读
   * `selector.gain`，没有任何地方缓存 selector 对象，所以改表即可。
   * 只允许改 `gain`——`group` / `throttleMs` 是节流语义的骨架。
   */
  setGain(key: SelectorKey, value: number): number {
    const clamped = Math.min(GAIN_MAX, Math.max(GAIN_MIN, value));
    SELECTORS[key].gain = clamped;
    return clamped;
  }

  getGain(key: SelectorKey): number {
    return SELECTORS[key].gain;
  }

  hasOverride(key: SelectorKey): boolean {
    return this.overrides.has(key);
  }

  /**
   * 把这个 buffer 挂到某个事件槽位：之后游戏里该事件就改用它发声。
   *
   * 挂载粒度是**槽位**（selector）而不是单条素材：槽位内多个变体在挂载期间
   * 退化为「只用这一个文件」——这正是「该事件临时用这个文件」的预期语义。
   */
  overrideSelector(key: SelectorKey, buffer: AudioBuffer, name = '上传文件'): void {
    this.overrides.set(key, { buffer, name });
  }

  /** 清除挂载。不传 key 则清全部，返回清除的条数。 */
  clearOverride(key?: SelectorKey): number {
    if (key === undefined) {
      const count = this.overrides.size;
      this.overrides.clear();
      return count;
    }
    return this.overrides.delete(key) ? 1 : 0;
  }

  /**
   * 解码一个本地文件。
   *
   * ★ 与预载不同，这里**失败必须抛**：预载失败是静默跳过（退合成音即可），
   * 而调试面板需要把「这个文件解不了」明确告诉人（格式不支持 / 文件损坏）。
   */
  async decodeFile(file: File): Promise<AudioBuffer> {
    await this.unlock();
    const context = this.context;
    if (!context) throw new Error('音频上下文不可用（浏览器不支持 Web Audio）');
    const bytes = await file.arrayBuffer();
    return await context.decodeAudioData(bytes);
  }

  /**
   * 在「试听模式」下执行一次发声：临时绕过静音、跳过节流窗口。
   *
   * ★ 为什么是 public：事件目录（`src/systems/audioCatalog.ts`）持有
   * 「事件名 → 调哪个公开方法」的映射，它需要把这次调用包进试听模式。
   * 若做成私有，目录就得反过来被 `AudioSystem` 依赖，形成循环 import。
   */
  runAudition(fn: () => void): void {
    const previous = this.auditioning;
    this.lastSource = 'none';
    this.auditioning = true;
    try {
      fn();
    } finally {
      this.auditioning = previous;
    }
  }

  /** 最近一次 `runAudition` 实际走的发声路径。由事件目录读出来组装返回值。 */
  get lastAuditionSource(): AuditionSource {
    return this.lastSource;
  }

  /**
   * 直接试听一个 buffer（不挂载到任何槽位）。用于「刚上传，先听听看」。
   *
   * 绕过 `emit()` 直接调 `startVoice()`：这里没有事件语义，不该受节流约束。
   */
  auditionBuffer(buffer: AudioBuffer, label = '上传文件'): AuditionResult {
    void this.unlock();
    const context = this.context;
    const state = context?.state ?? 'none';
    if (!context || context.state !== 'running' || this.activeVoices >= this.voiceCap) {
      return { played: false, name: label, selector: null, source: 'none', context: state };
    }
    this.startVoice(context, buffer, AUDITION_SELECTOR);
    return { played: true, name: label, selector: null, source: 'override', context: state };
  }

  /** 供诊断与调试面板读取的音频摘要。 */
  get debug(): AudioDebugSnapshot {
    return {
      muted: this.muted,
      contextState: this.context?.state ?? 'none',
      loadedSamples: this.samples.size,
      activeVoices: this.activeVoices,
      voiceCap: this.voiceCap,
      mounted: [...this.overrides.keys()],
    };
  }

  drop(): void {
    this.emit('drop', () => {
      this.tone({ type: 'triangle', from: 520, to: 300, duration: 0.12, gain: 0.06 });
    });
  }

  /**
   * 币落定。
   *
   * `intensity` 由调用方按碰撞力度判定：轻撞（单币触台）与重撞（砸进币堆）
   * 用两个不同素材，这是推币机里密度最高的一路反馈。
   */
  landing(intensity: 'light' | 'heavy' = 'light'): void {
    this.emit(intensity === 'heavy' ? 'landHeavy' : 'landLight', () => {
      this.tone({ type: 'square', from: 180, to: 120, duration: 0.05, gain: 0.03 });
    });
  }

  score(kind: CoinKind, combo: number): void {
    // 档位划分沿用原设计的意图：币种越稀有越"亮"，连击额外叠一层上行音。
    const key: SelectorKey =
      kind === 'bounty' ? 'scoreBig' : kind === 'bronze' ? 'scoreSmall' : 'scoreMid';

    this.emit(key, () => {
      // 兜底：音高读币种自身的定义（单一真源）。
      const base = kindSpec(kind).audioHz;
      const lift = Math.min(combo - 1, 6) * 40;
      this.tone({ type: 'triangle', from: base, to: base + 240 + lift, duration: 0.14, gain: 0.07 });
      if (kind !== 'bronze') {
        this.tone({ type: 'sine', from: base * 1.5, to: base * 2, duration: 0.18, gain: 0.05, delay: 0.06 });
      }
    });

    // 连击第二层：素材侧只有一条固定音高的上行音，靠播放速率把它拉成音阶。
    if (combo >= 3) {
      const step = Math.min(combo - 3, 6);
      this.emit(
        'comboUp',
        () => {
          const base = kindSpec(kind).audioHz;
          this.tone({ type: 'sine', from: base * 1.5, to: base * 2, duration: 0.1, gain: 0.04 });
        },
        { rate: 1 + step * 0.06 },
      );
    }
  }

  mark(): void {
    this.emit('mark', () => {
      this.tone({ type: 'sine', from: 880, to: 1180, duration: 0.1, gain: 0.05 });
    });
  }

  /**
   * 热区命中（P10 ⑨）：币在亮条范围内越线。
   *
   * ★ 这声**必须与普通越线分开**：热区是玩家瞄出来的（亮条在来回扫），
   * 命中意味着他的操作成功了。如果与普通越线同音，玩家永远不知道自己瞄没瞄上，
   * 那条来回移动的亮条就退化成了纯装饰。
   *
   * 暂无对应素材，走合成音：一声高而亮的双音（比 `score` 高一整个八度以上）。
   */
  hotHit(): void {
    this.tone({ type: 'triangle', from: 1180, to: 1780, duration: 0.11, gain: 0.055 });
    this.tone({ type: 'sine', from: 1560, to: 2360, duration: 0.13, gain: 0.04, delay: 0.045 });
  }

  boostReady(): void {
    this.emit('boostReady', () => {
      this.tone({ type: 'sawtooth', from: 300, to: 900, duration: 0.28, gain: 0.05 });
    });
  }

  boostUse(): void {
    this.emit('boostUse', () => {
      this.tone({ type: 'sawtooth', from: 200, to: 120, duration: 0.3, gain: 0.07 });
    });
  }

  payoutReturn(): void {
    this.emit('payout', () => {
      this.tone({ type: 'triangle', from: 640, to: 960, duration: 0.16, gain: 0.06 });
      this.tone({ type: 'triangle', from: 960, to: 1280, duration: 0.16, gain: 0.05, delay: 0.1 });
    });
  }

  /**
   * 老虎机揭晓（P10）。**三种结果必须是三种不同的声音**——
   * 旧版中奖与不中奖只差一行 HUD 文字，玩家在余光里读不到。
   *
   * 中奖用大赏素材（与收工成功同族，都是"好事"）；胡萝卜与杂牌暂无素材，
   * 保持合成音：下行钝音 = 明确的"亏了"，闷响 = 无喜无悲。
   */
  slotReveal(outcome: 'win' | 'fine' | 'miss'): void {
    if (outcome === 'win') {
      this.emit('scoreBig', () => {
        [0, 0.09, 0.18].forEach((delay, index) => {
          this.tone({
            type: 'triangle',
            from: 660 + index * 220,
            to: 990 + index * 260,
            duration: 0.16,
            gain: 0.06,
            delay,
          });
        });
      });
      return;
    }
    if (outcome === 'fine') {
      this.tone({ type: 'square', from: 300, to: 90, duration: 0.4, gain: 0.07 });
      this.tone({ type: 'square', from: 210, to: 70, duration: 0.45, gain: 0.05, delay: 0.12 });
      return;
    }
    this.tone({ type: 'sine', from: 220, to: 160, duration: 0.18, gain: 0.035 });
  }

  /**
   * 币掉进下水道（P10）。
   *
   * ★ 这声**必须有**：没有它，玩家分不清「这枚币没进」和「这枚币掉洞里了」，
   * 而两者对盘面的影响完全相反（前者还留在床上，后者永久离开）。
   * 暂无对应素材，保持合成音：一声很短的下坠钝响，比 `landing` 更低、更闷。
   */
  drain(): void {
    this.tone({ type: 'sine', from: 260, to: 110, duration: 0.22, gain: 0.05 });
    this.tone({ type: 'triangle', from: 150, to: 70, duration: 0.28, gain: 0.035, delay: 0.05 });
  }

  /**
   * 老虎机开始转动。素材是转轮咔哒的机械声。
   *
   * ★ 素材只有 1 秒，而转动本身持续 3.4 秒（中奖 4.0 秒，见 `DONE_AT` / `WIN_HOLD`），
   * 单次播放会有三分之二的时间是静的。这里按素材时长**排程重复**覆盖整段转动，
   * 而不是用 `loop = true`：素材尾部烘焙了淡出（原始素材是硬截断，不淡出会"咔"一声），
   * 循环播放会在每个接缝处听见一个凹陷；换成多次一次性播放，那点淡出反而听成了
   * 咔哒之间的自然起伏。
   */
  slotSpin(seconds = 3.4): void {
    if (this.muted && !this.auditioning) return;
    const context = this.context;
    if (!context || context.state !== 'running') return;

    const override = this.overrides.get('slotSpin');
    const buffer = override?.buffer ?? this.pickBuffer(SELECTORS.slotSpin.candidates);
    if (!buffer) {
      if (this.auditioning) this.lastSource = 'synth';
      this.tone({ type: 'square', from: 420, to: 380, duration: 0.5, gain: 0.035 });
      return;
    }

    if (!this.auditioning) {
      const now = context.currentTime;
      const last = this.lastPlayed.get(SELECTORS.slotSpin.group);
      if (last !== undefined && (now - last) * 1000 < SELECTORS.slotSpin.throttleMs) return;
      this.lastPlayed.set(SELECTORS.slotSpin.group, now);
    }

    // 上界 4 次：转动最长 4.0 秒、素材 1 秒，足够覆盖；多排只会白占 voice。
    const repeats = Math.max(1, Math.min(Math.ceil(seconds / buffer.duration), 4));
    for (let index = 0; index < repeats; index += 1) {
      if (this.activeVoices >= this.voiceCap) break;
      this.startVoice(context, buffer, SELECTORS.slotSpin, index * buffer.duration);
    }
    if (this.auditioning) this.lastSource = override ? 'override' : 'sample';
  }

  /** UI 按钮点击。 */
  uiClick(): void {
    this.emit('uiClick', () => {
      this.tone({ type: 'square', from: 720, to: 620, duration: 0.04, gain: 0.03 });
    });
  }

  settle(reason: 'success' | 'exhausted' | 'budget'): void {
    if (reason === 'success') {
      [0, 0.12, 0.24].forEach((delay, index) => {
        this.tone({
          type: 'triangle',
          from: 520 + index * 160,
          to: 780 + index * 180,
          duration: 0.22,
          gain: 0.06,
          delay,
        });
      });
    } else {
      this.tone({ type: 'sine', from: 320, to: 180, duration: 0.5, gain: 0.05 });
    }
  }

  dispose(): void {
    void this.context?.close();
    this.context = null;
    this.samples.clear();
    // 挂载的 buffer 归调用方（调试面板）所有，但要清掉引用，避免热重载后残留。
    this.overrides.clear();
    this.lastPlayed.clear();
    this.preloading = null;
  }

  // ── 内部 ───────────────────────────────────────────────────────────────

  /**
   * 统一发声入口：静音/未解锁 → 丢弃；节流窗口内 → 跳过；
   * 有素材（或已挂载） → 采样播放；否则 → 走调用方给的合成音兜底。
   *
   * 按 **key** 而不是 selector 对象取参：override 与实时 `gain` 都需要一个
   * 稳定的查找键，传对象进来就得再额外传一次键、两处容易漂移。
   *
   * `overrides` 用于「同一次调用临时改几个字段」（目前只有 `score` 的连击层用它调 `rate`）。
   */
  private emit(key: SelectorKey, fallback: () => void, overrides?: Partial<Selector>): void {
    // 试听时绕过静音：调试面板最忌讳「点了没声音」。
    if (this.muted && !this.auditioning) return;
    const context = this.context;
    if (!context || context.state !== 'running') return;

    const selector = overrides ? { ...SELECTORS[key], ...overrides } : SELECTORS[key];

    // 试听既不读也不写节流窗口：调试时连点同一个按钮必须每次都响，
    // 而且不能把玩法侧的节流窗口顶掉。
    //
    // ★ 注意这里比改造前多了一层：节流**对兜底路径也生效**了。旧版是在取到
    // 素材之后才写窗口，于是「素材还没预载完」的那一小段时间里合成音是不受
    // 节流的——而 `landing()` 现在按物理子步触发（最多一帧 4 次），不节流会叠成一片。
    if (!this.auditioning) {
      const now = context.currentTime;
      const last = this.lastPlayed.get(selector.group);
      if (last !== undefined && (now - last) * 1000 < selector.throttleMs) return;
      this.lastPlayed.set(selector.group, now);
    }

    // 挂载优先于素材：这就是「该事件临时用这个文件」。
    const override = this.overrides.get(key);
    const buffer = override?.buffer ?? this.pickBuffer(selector.candidates);
    if (!buffer) {
      if (this.auditioning) this.lastSource = 'synth';
      fallback();
      return;
    }
    if (this.activeVoices >= this.voiceCap) return;

    if (this.auditioning) this.lastSource = override ? 'override' : 'sample';
    this.startVoice(context, buffer, selector);
  }

  /** 从候选里随机取一个已装载的素材；全都没装载好时返回 null（触发兜底）。 */
  private pickBuffer(candidates: readonly SampleId[]): AudioBuffer | null {
    if (candidates.length === 1) return this.samples.get(candidates[0]) ?? null;
    const loaded = candidates.filter((id) => this.samples.has(id));
    if (loaded.length === 0) return null;
    return this.samples.get(loaded[Math.floor(Math.random() * loaded.length)]) ?? null;
  }

  private startVoice(
    context: AudioContext,
    buffer: AudioBuffer,
    selector: Selector,
    whenOffset = 0,
  ): void {
    const source = context.createBufferSource();
    source.buffer = buffer;

    const jitter = selector.rateJitter ?? 0;
    const base = selector.rate ?? 1;
    source.playbackRate.value = base * (jitter > 0 ? 1 + (Math.random() * 2 - 1) * jitter : 1);

    const gain = context.createGain();
    gain.gain.value = selector.gain;

    source.connect(gain).connect(context.destination);
    this.activeVoices += 1;
    // voice 计数必须在结束时归还，否则并发上限会被慢慢吃满、音效逐渐消失。
    source.onended = () => {
      this.activeVoices = Math.max(0, this.activeVoices - 1);
    };
    source.start(context.currentTime + whenOffset);
  }

  /** 异步预载并解码全部素材。单个失败不影响其它——播放时那一项自动走兜底。 */
  private async preload(): Promise<void> {
    const context = this.context;
    if (!context) return;
    const entries = Object.entries(SAMPLE_URLS) as Array<[SampleId, string]>;
    await Promise.all(
      entries.map(async ([id, url]) => {
        try {
          const response = await fetch(url);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const bytes = await response.arrayBuffer();
          const buffer = await context.decodeAudioData(bytes);
          // 预载期间可能已经 dispose（热重载），此时不要再往 Map 里写。
          if (this.context === context) this.samples.set(id, buffer);
        } catch {
          // 静默跳过：可能是格式不支持（旧 Safari 无 Ogg Vorbis）或网络失败，
          // 两种情况都由 `emit()` 退回合成音处理。
        }
      }),
    );
  }

  private tone(spec: ToneSpec): void {
    if (this.muted && !this.auditioning) return;
    const context = this.context;
    if (!context || context.state !== 'running') return;
    if (this.auditioning) this.lastSource = 'synth';

    const start = context.currentTime + (spec.delay ?? 0);
    const oscillator = context.createOscillator();
    const gain = context.createGain();

    oscillator.type = spec.type;
    oscillator.frequency.setValueAtTime(Math.max(40, spec.from), start);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(40, spec.to), start + spec.duration);

    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(spec.gain, start + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + spec.duration);

    oscillator.connect(gain).connect(context.destination);
    oscillator.start(start);
    oscillator.stop(start + spec.duration + 0.02);
  }
}
