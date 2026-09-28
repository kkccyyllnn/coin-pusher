import { ENDLESS } from '../game/constants';
import { COIN_SKINS, CABINET_SKINS } from '../game/cosmetics';

/** 一局的历史记录（排行榜三列：赚进 / 存活投数 / 跪求次数）。 */
export type RunRecord = { earned: number; drops: number; begs: number };

export type SaveData = {
  /** 筹码钱包：图鉴的购买力，跨局持久化。 */
  wallet: number;
  /** 已解锁的币纹与机柜配色 id。 */
  coinSkins: string[];
  cabinetSkins: string[];
  /** 当前选用的外观。 */
  selectedCoinSkin: string;
  selectedCabinetSkin: string;
  /** 历史单局最高「赚进筹码」。 */
  bestEarned: number;
  /** 终身累计跪求次数（排行榜的第二列）。 */
  totalBegs: number;
  /** 最近几局的记录，用于本地排行榜三列展示。 */
  runs: RunRecord[];
  /** XIXI 四槽亮灭（P5）：跨局、跨会话持续的收集进度。 */
  xixi: boolean[];
};

const STORAGE_KEY = 'coin-pusher:save:v4';
/** 老版本的键：只在迁移时读一次，不删（便于回滚）。 */
const LEGACY_V3_KEY = 'coin-pusher:save:v3';
const LEGACY_V2_KEY = 'coin-pusher:save:v2';
const LEGACY_V1_KEY = 'coin-pusher:save:v1';

const DEFAULT_COIN_SKIN = COIN_SKINS[0].id;
const DEFAULT_CABINET_SKIN = CABINET_SKINS[0].id;

/**
 * 老存档里的图鉴券折算成筹码的汇率。
 *
 * 券在 v2 是「通关奖励」，在 v3 已经不存在发券渠道，所以一次性按 5 筹码回收，
 * 让老玩家的积累不至于凭空消失。
 */
const TICKET_TO_CHIPS = 5;
/** 老存档里的分数折算成筹码的除数（10 分 ≈ 1 筹码，与旧面值同量级）。 */
const SCORE_TO_CHIPS = 10;

function defaultSave(): SaveData {
  return {
    wallet: ENDLESS.walletStart,
    coinSkins: [DEFAULT_COIN_SKIN],
    cabinetSkins: [DEFAULT_CABINET_SKIN],
    selectedCoinSkin: DEFAULT_COIN_SKIN,
    selectedCabinetSkin: DEFAULT_CABINET_SKIN,
    bestEarned: 0,
    totalBegs: 0,
    runs: [],
    xixi: [false, false, false, false],
  };
}

/** v2 存档形状（战役六关 + 图鉴券 + 分数制无尽），只在迁移时出现。 */
type LegacySave = {
  tickets?: number;
  coinSkins?: string[];
  cabinetSkins?: string[];
  selectedCoinSkin?: string;
  selectedCabinetSkin?: string;
  endlessBest?: number;
  endlessBegs?: number;
  endlessRuns?: Array<{ score?: number; drops?: number; begs?: number }>;
};

/**
 * 本地进度：筹码钱包、无尽排行榜、图鉴外观。
 *
 * v3 起**没有分数也没有图鉴券**：筹码就是唯一的进度货币。
 * 玩家在 v2 里已经买到手的外观、券余额与最高分都会在迁移时折成筹码，
 * 不会因为改版被清零。
 */
export class SaveStore {
  private data: SaveData;
  /** 累计充值额。**刻意不落盘、不被 `clear()` 清零** —— 见 `refillWallet`。 */
  private refilledTotal = 0;

  constructor() {
    const { data, migrated } = this.read();
    this.data = data;
    // 迁移结果立刻落盘到 v3；v2 的键不删，便于回滚。
    if (migrated) this.write();
  }

  get snapshot(): SaveData {
    return this.data;
  }

  get wallet(): number {
    return this.data.wallet;
  }

  isSkinUnlocked(kind: 'coin' | 'cabinet', id: string): boolean {
    const list = kind === 'coin' ? this.data.coinSkins : this.data.cabinetSkins;
    return list.includes(id);
  }

  /**
   * 从钱包买入本局筹码。
   *
   * 余额不足时**按余额全押**（不拒绝）：钱包见底是设计内的状态，
   * 玩家会带着 0 筹码开局、立刻破产、然后跪求大王——这条路必须走得通，
   * 否则「钱包空」就变成了死状态。
   */
  buyIn(): number {
    const stake = Math.min(ENDLESS.buyIn, this.data.wallet);
    if (stake <= 0) return 0;
    this.data.wallet -= stake;
    this.write();
    return stake;
  }

  /** 收工回存。`amount` 由 `RunState.cashOut` 给出，已扣除不可回存的跪求筹码。 */
  depositWallet(amount: number): void {
    if (amount <= 0) return;
    this.data.wallet += amount;
    this.write();
  }

  /**
   * 充值/补充钱包（调试与验证脚本用）。
   *
   * `refilled` 是**单调递增的累计值，`clear()` 也不清零** —— 钱包守恒算式
   * `wallet终 = wallet起 + Σ充值 − Σ买入 + Σ回存` 要用它的增量，
   * 中途被 `clear()` 归零会让增量变成负数、算式凭空多出一笔。
   */
  refillWallet(amount: number = 100): void {
    if (amount <= 0) return;
    this.data.wallet += amount;
    this.refilledTotal += amount;
    this.write();
  }

  /** 累计充值额（不落盘，只在本次会话内累计）。 */
  get refilled(): number {
    return this.refilledTotal;
  }

  /**
   * 直接把钱包设成某个值（验证脚本用）。
   *
   * 差额记进 `refilledTotal`：这样无论调用方把钱包改成多少，
   * 守恒式 `wallet终 = wallet起 + Σ充值 − Σ买入 + Σ回存` 依然精确成立，
   * 不会因为「测试偷偷改了钱包」而报出假失败。
   */
  setWallet(amount: number): void {
    const next = Math.max(0, Math.round(amount));
    this.refilledTotal += next - this.data.wallet;
    this.data.wallet = next;
    this.write();
  }

  /** 记录一局：最高赚进、排行榜与累计跪求次数。 */
  recordRun(earned: number, drops: number, begs: number): { best: number; totalBegs: number } {
    this.data.bestEarned = Math.max(this.data.bestEarned, earned);
    this.data.totalBegs += begs;
    this.data.runs.unshift({ earned, drops, begs });
    this.data.runs = this.data.runs.slice(0, 10);
    this.write();
    return { best: this.data.bestEarned, totalBegs: this.data.totalBegs };
  }

  /** 终身累计跪求次数。 */
  begCount(): number {
    return this.data.totalBegs;
  }

  /** 用筹码解锁一个外观。返回 false 表示筹码不够或已解锁。 */
  unlockSkin(kind: 'coin' | 'cabinet', id: string, cost: number): boolean {
    if (cost <= 0 || this.isSkinUnlocked(kind, id)) return false;
    if (this.data.wallet < cost) return false;

    this.data.wallet -= cost;
    if (kind === 'coin') this.data.coinSkins.push(id);
    else this.data.cabinetSkins.push(id);
    this.write();
    return true;
  }

  selectSkin(kind: 'coin' | 'cabinet', id: string): boolean {
    if (!this.isSkinUnlocked(kind, id)) return false;
    if (kind === 'coin') this.data.selectedCoinSkin = id;
    else this.data.selectedCabinetSkin = id;
    this.write();
    return true;
  }

  clear(): SaveData {
    this.data = defaultSave();
    this.write();
    return this.data;
  }

  /**
   * 读取存档。v3 缺失时从 v2（或 v1）迁移：
   *
   * - 已购外观与选用外观原样保留；
   * - 券按 `TICKET_TO_CHIPS` 折成筹码，叠在起始钱包上；
   * - 历史最高分按 `SCORE_TO_CHIPS` 折成筹码，同样叠进钱包（一次性补偿）；
   * - 排行榜的分数列换算成「赚进筹码」，跪求次数沿用；
   * - 战役六关的进度字段直接丢弃。
   */
  private read(): { data: SaveData; migrated: boolean } {
    const base = defaultSave();
    try {
      const current = window.localStorage.getItem(STORAGE_KEY);
      if (current) return { data: this.parse(current, base), migrated: false };

      // v3 与 v4 同构（只差 xixi 字段）：按当前格式解析，缺的字段默认补齐。
      const legacyV3 = window.localStorage.getItem(LEGACY_V3_KEY);
      if (legacyV3) return { data: this.parse(legacyV3, base), migrated: true };

      const legacy =
        window.localStorage.getItem(LEGACY_V2_KEY) ?? window.localStorage.getItem(LEGACY_V1_KEY);
      if (!legacy) return { data: base, migrated: false };
      return { data: this.migrate(this.parseLegacy(legacy), base), migrated: true };
    } catch {
      return { data: base, migrated: false };
    }
  }

  private parseLegacy(raw: string): LegacySave {
    return JSON.parse(raw) as LegacySave;
  }

  /** v3 存档：字段缺失时用默认值补齐，不写入 undefined。 */
  private parse(raw: string, base: SaveData): SaveData {
    const parsed = JSON.parse(raw) as Partial<SaveData>;
    let wallet = typeof parsed.wallet === 'number' ? parsed.wallet : base.wallet;
    const runs = Array.isArray(parsed.runs) ? parsed.runs : base.runs;
    const totalBegs = typeof parsed.totalBegs === 'number' ? parsed.totalBegs : base.totalBegs;
    // 如果无有效历史局且无跪求记录、但钱包被扣空（如频繁刷新），自动重置为起始钱包，防止新局坏死
    if (wallet <= 0 && runs.length === 0 && totalBegs === 0) {
      wallet = base.wallet;
    }
    return {
      wallet,
      coinSkins:
        Array.isArray(parsed.coinSkins) && parsed.coinSkins.length > 0 ? parsed.coinSkins : base.coinSkins,
      cabinetSkins:
        Array.isArray(parsed.cabinetSkins) && parsed.cabinetSkins.length > 0
          ? parsed.cabinetSkins
          : base.cabinetSkins,
      selectedCoinSkin:
        typeof parsed.selectedCoinSkin === 'string' ? parsed.selectedCoinSkin : base.selectedCoinSkin,
      selectedCabinetSkin:
        typeof parsed.selectedCabinetSkin === 'string'
          ? parsed.selectedCabinetSkin
          : base.selectedCabinetSkin,
      bestEarned: typeof parsed.bestEarned === 'number' ? parsed.bestEarned : base.bestEarned,
      totalBegs,
      runs,
      // v3 存档没有 xixi 字段 → 默认全灭；有则原样沿用（四槽亮灭是持续进度）。
      xixi:
        Array.isArray(parsed.xixi) && parsed.xixi.length === 4
          ? parsed.xixi.map(Boolean)
          : [...base.xixi],
    };
  }

  private migrate(legacy: LegacySave, base: SaveData): SaveData {
    const tickets = typeof legacy.tickets === 'number' ? legacy.tickets : 0;
    const best = typeof legacy.endlessBest === 'number' ? legacy.endlessBest : 0;
    const legacyRuns = Array.isArray(legacy.endlessRuns) ? legacy.endlessRuns : [];

    return {
      wallet: base.wallet + tickets * TICKET_TO_CHIPS + Math.round(best / SCORE_TO_CHIPS),
      coinSkins:
        Array.isArray(legacy.coinSkins) && legacy.coinSkins.length > 0 ? legacy.coinSkins : base.coinSkins,
      cabinetSkins:
        Array.isArray(legacy.cabinetSkins) && legacy.cabinetSkins.length > 0
          ? legacy.cabinetSkins
          : base.cabinetSkins,
      selectedCoinSkin:
        typeof legacy.selectedCoinSkin === 'string' ? legacy.selectedCoinSkin : base.selectedCoinSkin,
      selectedCabinetSkin:
        typeof legacy.selectedCabinetSkin === 'string'
          ? legacy.selectedCabinetSkin
          : base.selectedCabinetSkin,
      bestEarned: Math.round(best / SCORE_TO_CHIPS),
      totalBegs: typeof legacy.endlessBegs === 'number' ? legacy.endlessBegs : 0,
      runs: legacyRuns.map((run) => ({
        earned: Math.round((typeof run.score === 'number' ? run.score : 0) / SCORE_TO_CHIPS),
        drops: typeof run.drops === 'number' ? run.drops : 0,
        begs: typeof run.begs === 'number' ? run.begs : 0,
      })),
      xixi: [...base.xixi],
    };
  }

  /** 写 XIXI 四槽状态：点亮与集齐清空都走这里，是 xixi 进存档的唯一入口。 */
  setXixi(slots: boolean[]): void {
    this.data.xixi = slots.map(Boolean);
    this.write();
  }

  private write(): void {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data));
    } catch {
      // 隐私模式下写入失败不影响本局游玩。
    }
  }
}
