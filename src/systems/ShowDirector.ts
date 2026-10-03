import * as THREE from 'three';
import * as RAPIER from '@dimforge/rapier3d-compat';
import type { CoinPool } from '../entities/CoinPool';
import { coinColliderHeight, coinColliderSpec } from '../entities/coinModels';
import { COIN, TABLE, type CoinKind } from '../game/constants';
import { makeToonMaterial } from '../render/ToonMaterial';
import { RESTITUTION_COMBINE_RULE } from './PhysicsWorld';
import type { Telemetry } from './Telemetry';
import { SPILL_ORIFICE, SPILL_ORIFICE_SIZE, type CoinSpray } from './CoinSpray';

/**
 * 投放演出系统（P4）。
 *
 * 定位：演出请求的**统一入口与调度**。老虎机奖励（P5）、宝箱（P6）、
 * 机关演出（P7）都从这里走——`economy.ts` 里预定的接口名就是 `ShowDirector`。
 *
 * 三条铁律（PLAN-v4 §4.2/§4.4）：
 * 1. **演出 ≠ 视觉假币**。留在盘面上的必须是真实物理币（`CoinPool.acquire + spawn`），
 *    从 spawn 那一刻起参与一切规则（越线返值、异常检测、速度护栏一视同仁）。
 * 2. **预算检查是第一公民**：注入吃 `COIN.budget` 余量。余量不足时**降级**
 *    （塔少几层）并明确告知，彻底没有时**拒绝**——绝不静默少发
 *    （`acquire()` 返回 null 的静默失败是历史坑）。
 * 3. **演出不暂停结算**：物理世界不停，装置动画只做视觉 + 到点 spawn，
 *    不碰 `fixedUpdate`。
 */

export type ShowId = 'chest' | 'diamond' | 'tower' | 'fountain' | 'gate';

export type ShowRequestOptions = {
  /** 请求的币数（装置按形态解释：塔 = 层数×4，喷泉/闸门 = 枚数）。 */
  count?: number;
  /** 注入币种（默认铜币；P6 的钻/箱会指定）。 */
  kind?: CoinKind;
  /** 落点中心 x（默认 0）。 */
  x?: number;
  /**
   * S5a 四同大奖：允许把承诺数放到 `SHOW_SPECS[id].jackpot` 那一档高度，
   * 并让演出自己走「更长的仪式时间轴」（塔逐层停格、宝箱喷一圈视觉币）。
   * ⚠️ 它**只是上限**，不是保证：预算（`coins.remaining`）该降级照样降级，
   *   降级如实记进 `downgraded` 与 completed 事件的 `spawned`。
   */
  jackpot?: boolean;
};

export type ShowResult = {
  ok: boolean;
  id: ShowId;
  /** 承诺交付的币数（降级后）。 */
  promised: number;
  /** 预算不足被降级交付。 */
  downgraded: boolean;
  reason?: string;
};

type ShowDeps = {
  coins: CoinPool;
  /**
   * Rapier 世界。**目前只有一个消费者**：R4-4b 的塔柱顶要建 kinematic 碰撞体，
   * 让「柱子升起」真的推币，而不是像改前那样只是一根纯视觉 Mesh、币穿它而过。
   *
   * 其余装置一律不碰它——铁律 1「演出 ≠ 视觉假币」靠的是 `CoinPool` 的真币，
   * 不是靠这里能拿到世界。给它只是为了 4b，别顺手把喷泉也改成推币。
   */
  world: RAPIER.World;
  telemetry: Telemetry;
  /** HUD 文案反馈（拒绝/降级必须让玩家看得见）。 */
  notify: (message: string) => void;
  /** 游戏内秒表（遥测时间戳用）。 */
  now: () => number;
  /** 游戏 RNG：演出散布也走同一种子，行为可复现。 */
  rng: () => number;
  /** 降动效：压缩时间轴，但**不少发一枚币**（演出是奖励交付物）。 */
  reducedMotion: () => boolean;
  /**
   * 纯视觉币通道（S16，喷泉溢出用）。
   *
   * ⚠️ **它不产出真币**：`CoinSpray` 里没有 Rapier 刚体、不进 `CoinPool`、
   * 不增 `activeCoins`、不进 `processOutcomes`。它存在的唯一理由是「筹码喷出机器外」
   * 这个**观感**——真币喷出去会立刻被 anomaly 判据回收（`|x| > 1.3`），
   * 而且会污染 `show` 模式的「实发 = 承诺」对账。
   *
   * 生命周期**不属于任何一场演出**：装置 `dispose()` 会把挂在自己身上的 Mesh 全拆掉，
   * 所以在飞的视觉币必须由一个长期存在的对象持有（`Game` 持有，这里只借用）。
   */
  spray?: CoinSpray;
};

/** 一次演出的完整生命周期由装置自己管：几何体、时间轴、到点 spawn。 */
interface Show {
  readonly id: ShowId;
  readonly promised: number;
  readonly downgraded: boolean;
  spawned: number;
  /** 返回 false 表示演出结束。 */
  update(delta: number): boolean;
  dispose(): void;
}

/** 演出队列上限：排队也是资源，无限排等于把拒绝藏到未来。 */
const MAX_QUEUE = 4;

/**
 * 装置默认规模与最低交付（低于最低宁可拒绝，不交一个寒酸的残次品）。
 *
 * 量级被两轮实测压过，两轮都是「奖励水源把期望打成正」逼出来的：
 *   ① 初版草案 塔 16 / 泉 10：快投机器人 600 秒 1191 投、筹码 20→495，破产在期望上不可达；
 *   ② 砍到 塔 8 / 泉 4 后：快投机器人回负（40~112 投正常破产），但**节奏投**
 *      （每推板循环 1 投，endless 模式）160 投后仍剩 66 筹码——越线/投币被推到 1.29。
 *      机理：推板吞吐是稀缺资源，投得越慢，每一投「分到」的越线越多，对水源更敏感。
 *   ③ 砍到 塔 4 / 泉 3 又**反向过冲**：节奏投 28 投就破产（低于 35~220 的存活带）。
 *   ④ 塔 6 / 泉 4（水量 ~0.32）在快投侧回负，但**节奏投仍会点火**：
 *      economy 模式两局都跑到 240 投上限（剩 21/48 筹码）、越线/投币升到 1.81——
 *      肥盘的垮塌更大，回收率被吞吐量顶回 1.0 以上。这不是尾部分布，是自增强回路的阈值。
 *   ⑤ 现档回到 塔 4 / 泉 3（水量 ~0.22）：占位量级（最终标定仍在 P8），
 *      但**符号必须现在就对**——整局在期望上必须能输光，快投与节奏投两条路都要过机器人。
 *
 * tower 的 count 不必是 4 的倍数（`TowerShow` 按承诺数硬停发，最后一层可以是半层）；
 * min 保留 2 是为了留出降级交付窗口（余量不够一整场时交半场）。
 */
/**
 * 每场演出的规模。
 *
 * `jackpot` 是 **S5a 四同大奖的上限**（不是默认值）：`request(id, {jackpot: true})`
 * 允许把承诺数放到这个高度，普通中奖仍然封顶在 `count`。
 * 刻意**只给塔填**（16 → 40）：另外三个符号的大奖不靠枚数取胜 ——
 * 力走推板行程（见 `RULES.jackpotBoostStrokes`），钻/箱走仪式与闪色（见 `SlotMachine` 的
 * 四同分支）。往盘面上加质量的那一档只此一处，水量账因此好对账。
 */
const SHOW_SPECS: Record<ShowId, { count: number; min: number; jackpot?: number }> = {
  /**
   * ★ **P10 起回到「阵型规模」**（用户拍板 #8）。
   *
   * 上面的 ①~⑤ 那五轮实测是 **P6~P9 的老前提**：当时免费币是**唯一的筹码来源**
   * （`crossingReturn` 里 payout/bounty 权重为 0，越线返值全靠盘面币），
   * 所以每一枚免费币都直接顶回收率，只能给到个位数。
   *
   * P10 换了前提：老虎机变成 **45% 中奖 / 15% 胡萝卜惩罚 / 40% 杂牌**，
   * 奖励是「看得见的大场面」而不是「涓涓细流」——总量靠**降低频率**、单次规模放大到阵型规模。
   * ⚠️ 这里原本抄了一份自己的水量算式，用的是**旧符号权重表**（塔 6/泉 4/箱 2 是 45/54 归一化那版）
   *   并且把中奖率乘了两次 ⇒ 得出「0.068 枚/投」这种低估数。口径已错位两轮，**删掉不再重算**。
   * ⇒ 水量的唯一算式在 `xixi.ts` 的 `SLOT_SYMBOL_WEIGHTS` 注释里（含箱=1 的现档与摇/投分段区间）；
   *   本表只负责「一次演出放几枚」（`SHOW_SPECS`），改这里就是改那份算式的一个因子。
   *
   * ⚠️ **这仍然高于 `FAUCET_BUDGET_PER_DROP = 0.04` 约 1.7 倍**——
   * 余量是靠 P10 新增的**汇**（两侧排水槽 + 得分线两端下水道）买回来的。
   * 所以 S6（本表）与 S7（`DRAIN`）**必须成对验证**：
   * 只放大源不装汇 → `economy` 的回收率会被顶过 1 → 整局不终局（点火）。
   */
  // 塔 16 枚 = 4 层 × 2×2，柱高 4×(2×0.01+0.004) ≈ 0.096 米。
  // ★ 四同 = 10 层 × 2×2 = 40 枚（plan S5a「中央巨塔 16 → 40」）。
  //   柱高 10 × 0.024 ≈ 0.24 米；层距由 `layerStep()` 从**碰撞体高度**派生，
  //   所以放大层数不会引来自我重叠（S16 那个坑的防法本身就在这条链上）。
  tower: { count: 16, min: 4, jackpot: 40 },
  // chest 复用 `TowerShow`。
  // ★ S16：从 8 枚（2 层 × 2×2）降到 **1 枚** —— 用户拍板「降到 1 个宝箱」。
  //
  // 理由是放大之后的物理账：宝箱外接直径 2.5 × 币径（×1.2 档下 360 mm），
  // 单枚碰撞体 321 × 259 × 224 mm、质量 **14.5 kg**（普通币的 47 倍）。
  // 8 枚挤在同一个 2×2 阵里，层内中心只距 0.144 m 而箱体半宽 0.161 m
  // ⇒ 自相重叠，求解器为了推开它们会注入巨大能量（`anomalies` 抓的就是这个）；
  // 而且 116 kg 压在同一个小区域上，会把币床预置币整片推过得分线（等于白送结算）。
  //
  // 1 枚巨型宝箱从台底升起，观感是「一件宝物被顶出来」，比一堆小箱子更像大奖；
  // 它的**收益**改由越线返值承担（见 `kinds.ts` 的 `chest.payout`，固定 50 筹码）。
  chest: { count: 1, min: 1 },
  // diamond（P6）：老虎机奖励的「变现」侧。**单枚滚出**，走 GateShow——
  // 一枚钻石从背板缝里滚出来，比「一座塔」更贴合「稀有单件」的语义。
  // 注意它是固定 25 筹码的币，真正兑现仍要玩家把它推过得分线（结算只由越线决定）。
  // ★ 它**不放大**：钻石是「单件稀有」，放大成 10 枚就变成了另一种东西。
  diamond: { count: 1, min: 1 },
  // 泉 10 枚：4 波 × 3 枚左右，从背板前缘抛出一弧。
  fountain: { count: 10, min: 3 },
  // 闸门不参与老虎机奖励表（它是「庄家补货」装置），所以保持能演出阵型的规模，
  // 也正是 show 模式用来验「降级交付」的装置（窗口 {3..6} 宽，落点确定）。
  gate: { count: 7, min: 3 },
};

/**
 * 「加力已存满」的兜底（P10 ⑨，★ PLAN 标记的**本次最容易漏的体验坑**）。
 *
 * ## 为什么必须有
 *
 * `RULES.boostStoreCap = 1`：**只能存一次**。而 P10 的中奖率是 45%，
 * 中奖符号里「力」又占 26/45（≈58%）——力力力是所有奖励里最常见的一个。
 * 玩家一旦把这次加力留着不用（收尾扫板前留着是常见打法），
 * 下一次力力力就**什么都不会发生**：只有一行「但加力已存满」的文字。
 * 中奖体验退化成空响，而且是最频繁的那一档奖励退化成空响。
 *
 * ## 为什么兜底是「补一批币」而不是「折筹码」
 *
 * 老虎机的奖励表有一条硬约束：**不走 `gainChips`**（越线返值仍是唯一筹码来源，
 * 见 §10.4）。折筹码会直接破掉那条不变式，账本判据全部要重写。
 * 改派一场真币演出则与其余四个符号**完全同构**：奖励一律是「看得见的币」，
 * 玩家还得把它推过得分线才算兑现。
 *
 * ## 为什么是 3 枚、走 `gate`
 *
 * - 复用 `gate`（闸门落币）而不是新造装置：它本来就是「庄家补货」的载体，
 *   语义贴合，且**零新增 draw call**（装置几何是演出期临时挂载的）。
 * - `count: 3` 取 `gate.min`：兜底应当**小于**一次正常奖励（泉 10 / **箱 1**，S16 从 8 降到 1，见 `SHOW_SPECS.chest`；塔 16 / 钻 1 也都是真币），
 *   否则「存满」反而比「用掉」划算，玩家会故意囤积。
 *   3 枚约合 3.9 筹码期望，比一次加力（多推一程）略低——方向是对的。
 */
export const BOOST_OVERFLOW_FALLBACK = { show: 'gate', count: 3 } as const;

const COIN_DIAMETER = COIN.radius * 2;

/**
 * 一层 2×2 的币心偏移（米）——**从该币种自己的碰撞体派生**。
 *
 * ⚠️ 这里曾经写死 `±COIN.radius`（普通币的 0.072）。那是个**只在普通币上成立**的
 * 绝对量：宝箱放大到 2.5 × 币径之后，两枚宝箱的中心仍只距 0.144 m，
 * 而箱体半宽是 0.161 m ⇒ **层内重叠 0.177 m**，求解器注入能量。
 *
 * 取「碰撞体的水平半尺寸」就是「两枚刚好面贴面」，再乘 2% 的缝：
 * 面贴面起步会让 Rapier 在第一步就解出穿透。
 */
function layerOffsets(kind: CoinKind): { x: number; z: number } {
  const spec = coinColliderSpec(kind);
  const half =
    spec.shape === 'cylinder'
      ? { x: spec.radius, z: spec.radius }
      : { x: spec.halfExtents[0], z: spec.halfExtents[2] };
  return { x: half.x * 1.02, z: half.z * 1.02 };
}

/** 单枚币的**水平外接半径**（米）：圆柱取半径，长方体取对角半径。 */
function coinCircumradius(kind: CoinKind): number {
  const spec = coinColliderSpec(kind);
  return spec.shape === 'cylinder'
    ? spec.radius
    : Math.hypot(spec.halfExtents[0], spec.halfExtents[2]);
}

/**
 * 塔柱的半径（米）。
 *
 * ## 原设计（普通币档）
 *
 * 一层是 2×2 的币，币心在 ±`COIN.radius`，整层的**外接**半径是
 * `hypot(r, r) + r = r(√2 + 1) ≈ 0.174`（r = 0.072），而柱半径取 `2.5r = 0.18`
 * —— 四枚币各露出一点点边。取满外接半径会让柱面顶到相邻层的落座位置；
 * 再小则币像浮在空中。★ S13 起这个数必须随币尺寸档位走（`?coin=1.1/1.2`）。
 *
 * ## ★ S16：必须按**该币种自己的**占地派生
 *
 * 旧值 `COIN.radius * 2.5` 是**普通币**层外接半径的 `2.5/(√2+1) = 1.0355` 倍。
 * 宝箱放大到 2.5 × 币径后，单枚的外接半径就是 `hypot(0.161, 0.129) = 0.206`，
 * 比 0.18 还大 —— 柱比币窄，宝箱会明显悬在柱外。
 *
 * ```text
 * R_layer = hypot(offX, offZ) + 单枚外接半径
 * radius  = max(COIN.radius * 2.5, R_layer * 2.5 / (√2 + 1))
 * ```
 *
 * 普通币档 `R_layer = 0.174` ⇒ `max(0.18, 0.180) = 0.180`，**与原值一格不差**；
 * 宝箱（1 枚，偏移 0）`R_layer = 0.206` ⇒ 0.214。
 *
 * ⚠️ 余量系数 `2.5/(√2+1)` 是**从原设计反推的**，不是新拍的数：它保证了普通币那一档
 * 与 S13 的实测值逐位一致，改它等于改一个已经标定过的观感。
 */
function towerCylinderRadius(kind: CoinKind): number {
  const off = layerOffsets(kind);
  const layerRadius = Math.hypot(off.x, off.z) + coinCircumradius(kind);
  return Math.max(COIN.radius * 2.5, (layerRadius * 2.5) / (Math.SQRT2 + 1));
}

/**
 * 闸门面板的尺寸（米）。★ S13 起从币径派生，原尺寸下 = 0.90 × 0.14 × 0.03。
 *
 * 宽度是硬约束：面板要**盖住一次自动补币的 7 枚并排**（§10.3 ⑦ 每次 7 枚），
 * 所以是 `7 × 币径 + 半枚余量`。高度与厚度是「开口」的观感尺寸，同样跟币径走——
 * 面板矮于一枚币就会看到币从板顶探出来（×1.2 时币径 0.144 > 旧写死的 0.14）。
 */
const GATE_PANEL_SIZE = {
  width: COIN_DIAMETER * 7.5,
  height: COIN_DIAMETER * (7 / 6),
  depth: COIN_DIAMETER / 4,
} as const;

/**
 * 闸门出币时，币底沿离「台面静置币的顶」的余量（米）。
 *
 * 它是**从 S13 的写死值反推的**，不是新拍的数：
 * 原式是 `pusherTopY + 0.08`，而 `0.08 = 2 × halfThickness(0.024) + 0.044 + halfThickness(0.012)`，
 * 中间那 0.044 就是这条余量。拆开之后铜币的落点与原值实质相同（0.2806 vs 0.28），
 * 而钻石能按自己的高度抬起来 —— 见 `GateShow.spawnAtY`。
 */
const GATE_RELEASE_CLEARANCE = 0.044;

export class ShowDirector {
  /** 装置几何体的统一挂载点（一个 group，便于整体显隐与清理）。 */
  readonly group = new THREE.Group();

  private readonly queue: Array<() => Show> = [];
  private active: Show | null = null;

  constructor(private readonly deps: ShowDeps) {}

  /**
   * 装置规模表（判据读它，**不在验证脚本里手抄枚数**——纪律 2）。
   *
   * 存在的理由：`show` 模式的判据是「实发 = 承诺」，而承诺数来自这张表。
   * 脚本里写死 `promised === 1` 的话，S6 把塔从 1 改到 16 就会变成假红
   * （它其实只是配置变了）。让判据枚举引擎函数，改配置不用改测试。
   */
  /**
   * 规模表读数（判据从引擎读，不抄第二份）。
   * ★ S5a 带上 `jackpot`：四同那一档的**期望枚数**也必须能从引擎读，
   *   否则「塔四同 = 40 枚」这条判据就只能把 40 写死在脚本里。
   */
  static showSpecs(): Record<ShowId, { count: number; min: number; jackpot?: number }> {
    return SHOW_SPECS;
  }

  /** 是否有演出在跑或在排（P7 的「演出期间收尾计时暂停」会读这个）。 */
  get busy(): boolean {
    return this.active !== null || this.queue.length > 0;
  }

  get queued(): number {
    return this.queue.length;
  }

  get activeId(): ShowId | null {
    return this.active?.id ?? null;
  }

  /**
   * 请求一场投放演出。
   *
   * 预算语义：请求时按 `coins.remaining` 定**承诺数**（降级会告知）；
   * 演出过程中若预算被别的支出挤占导致 `acquire()` 落空，
   * 差额会如实记进 completed 事件的 `spawned`——承诺与实发都可对账。
   */
  request(id: ShowId, opts: ShowRequestOptions = {}): ShowResult {
    const spec = SHOW_SPECS[id];
    // ★ 大奖档位只抬高**上限**，其余口径（min 兜底、预算降级）一个字不变。
    const ceiling = opts.jackpot ? (spec.jackpot ?? spec.count) : spec.count;
    const wanted = Math.max(spec.min, Math.min(opts.count ?? ceiling, ceiling));

    if (this.queue.length >= MAX_QUEUE) {
      return this.refuse(id, wanted, '演出排队中，等上一场演完');
    }
    const remaining = this.deps.coins.remaining;
    if (remaining < spec.min) {
      return this.refuse(id, wanted, `盘面已满：连${spec.min}枚的空位都没有，等币越线腾位`);
    }

    const promised = Math.min(wanted, remaining);
    const downgraded = promised < wanted;
    if (downgraded) {
      this.deps.notify(`盘面空位不足：演出减量交付 ${promised}/${wanted} 枚`);
    }

    const kind = opts.kind ?? 'bronze';
    const x = opts.x ?? 0;
    const jackpot = opts.jackpot === true;
    this.queue.push(() => this.createShow(id, promised, downgraded, kind, x, jackpot));
    this.deps.telemetry.recordShow({
      id,
      phase: 'registered',
      requested: wanted,
      promised,
      spawned: 0,
      downgraded,
      t: this.deps.now(),
    });
    return { ok: true, id, promised, downgraded };
  }

  /** 每帧推进（挂在 Game.update，渲染节奏；暂停时整段冻结，与全世界一致）。 */
  update(delta: number): void {
    if (!this.active && this.queue.length > 0) {
      const next = this.queue.shift();
      this.active = next ? next() : null;
    }
    if (!this.active) return;
    if (!this.active.update(delta)) {
      const finished = this.active;
      finished.dispose();
      this.active = null;
      this.deps.telemetry.recordShow({
        id: finished.id,
        phase: 'completed',
        requested: finished.promised,
        promised: finished.promised,
        spawned: finished.spawned,
        downgraded: finished.downgraded,
        t: this.deps.now(),
      });
    }
  }

  /**
   * 中止所有在途演出（开新局 / 收工用）：丢弃队列 + 拆掉当前装置，
   * **不再 spawn 剩余承诺数**。
   *
   * 为什么必须中止：演出有过程时间，上一局结束时它在途的塔/喷泉会把币
   * 吐进**下一局**的开局盘面（实测重开后 318 变 324）。承诺数随本局一起作废，
   * 差额不补发——本局的账已经结清，补发就成了跨局平移。
   */
  abort(): void {
    this.queue.length = 0;
    this.active?.dispose();
    this.active = null;
  }

  /** 停手清理（dispose 游戏实例时）。物理币留在池里，只拆装置几何。 */
  dispose(): void {
    this.abort();
    this.group.clear();
  }

  private refuse(id: ShowId, wanted: number, reason: string): ShowResult {
    this.deps.notify(reason);
    this.deps.telemetry.recordShow({
      id,
      phase: 'refused',
      requested: wanted,
      promised: 0,
      spawned: 0,
      downgraded: false,
      reason,
      t: this.deps.now(),
    });
    return { ok: false, id, promised: 0, downgraded: false, reason };
  }

  private createShow(
    id: ShowId,
    promised: number,
    downgraded: boolean,
    kind: CoinKind,
    x: number,
    jackpot: boolean,
  ): Show {
    switch (id) {
      case 'fountain':
        return new FountainShow(this.deps, this.group, id, promised, downgraded, kind, x, jackpot);
      case 'gate':
      case 'diamond':
        return new GateShow(this.deps, this.group, id, promised, downgraded, kind, x, jackpot);
      case 'chest':
      case 'tower':
        return new TowerShow(this.deps, this.group, id, promised, downgraded, kind, x, jackpot);
    }
  }

  /** 装置共用的发币口：预算在演出途中被挤占时如实停发（差额进 completed 事件）。 */
  static spawnOne(
    deps: ShowDeps,
    kind: CoinKind,
    x: number,
    y: number,
    z: number,
    yaw: number,
    velocity?: { x: number; y: number; z: number },
  ): boolean {
    const coin = deps.coins.acquire();
    if (!coin) return false;
    coin.spawn(kind, x, y, z, yaw, false);
    coin.fromShow = true;
    if (velocity) coin.body.setLinvel(velocity, true);
    return true;
  }
}

/** 时间轴小工具：降动效时压缩时长，spawn 节奏跟着压（枚数不变）。 */
abstract class TimedShow implements Show {
  protected elapsed = 0;
  spawned = 0;
  /** 演出期间是否已经把装置几何挂进场景。 */
  private mounted = false;

  constructor(
    protected readonly deps: ShowDeps,
    protected readonly mount: THREE.Group,
    readonly id: ShowId,
    readonly promised: number,
    readonly downgraded: boolean,
    protected readonly kind: CoinKind,
    protected readonly x: number,
    /**
     * S5a 四同大奖的仪式标记。子类各自决定它**多演什么**：
     * 目前只有 `TowerShow` 用（宝箱大奖喷一圈视觉币 + 拉长节拍），
     * `GateShow` / `FountainShow` 拿到它是**故意什么都不做**——
     * 那两档的枚数没有 jackpot 上限（见 `SHOW_SPECS` 的注释），加戏等于加水量。
     */
    protected readonly jackpot = false,
  ) {}

  /** 子类的时间轴总长（未压缩）。 */
  protected abstract baseDuration(): number;
  /** 每秒（未压缩时间轴）推进：几何动画 + 到点 spawn。 */
  protected abstract tick(t: number, dt: number): void;
  protected abstract buildMeshes(): THREE.Object3D;

  update(delta: number): boolean {
    if (!this.mounted) {
      this.mount.add(this.buildMeshes());
      this.mounted = true;
    }
    const speed = this.deps.reducedMotion() ? 3 : 1;
    this.elapsed += delta * speed;
    const t = this.elapsed;
    this.tick(t, delta * speed);
    return t < this.baseDuration();
  }

  dispose(): void {
    // 几何与材质都是演出临时件，整场拆掉，不留残渣。
    if (!this.mounted) return;
    this.mount.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
        const material = child.material;
        if (Array.isArray(material)) material.forEach((m) => m.dispose());
        else material.dispose();
      }
    });
    this.mount.clear();
  }

  protected spawn(y: number, z: number, yaw: number, velocity?: { x: number; y: number; z: number }): boolean {
    const ok = ShowDirector.spawnOne(this.deps, this.kind, this.x, y, z, yaw, velocity);
    if (ok) this.spawned += 1;
    return ok;
  }
}

/**
 * 装置 A · 圆柱币塔：台底（币床中心）升起一根圆柱，分层顶出真币后回缩。
 * 层数 = promised / 4（2×2 一层），随预算弹性。
 *
 * ## ★ P3（2026-09-30）：碰撞体**只做平移，全程不换形状**
 *
 * 改前两件事叠在一起，把这台机器里唯一测得到的能量注入源造了出来
 * （判据在 `scripts/verify-game.mjs` 的 `show` 模式，两条新判据 P3 / P4）：
 *
 * 1. 碰撞体按「与网格高度差 ≥ 一层」才 `setShape` 重建 ⇒ **一次跳一整层**
 *    （普通币 28 mm、宝箱 **228 mm**）。`setShape` 是瞬时的：新出现的体积直接
 *    把币埋在里头，Rapier 的位置修正按 `erp × 穿透 / dt = 0.8 × 穿透 × 60`
 *    还成速度 ⇒ 228 mm 那一跳等于凭空给埋住的币 **10.9 米/秒**。
 * 2. 分层 spawn 的高度写死在 `0.03 + (layer+1) × layerStep`，而柱顶在升起段就已经
 *    到了 `0.03 + layers × layerStep` ⇒ **除最后一层外，每一层都生在柱子实体内部**
 *    （4 层塔的前三层分别埋在柱里 84 / 56 / 28 mm）。
 *
 * 实测后果（一场 16 枚的塔，`/tmp/show-timeline.mjs` 每 100 ms 采一次）：
 * 速度护栏触发 16~17 次、护栏**压之前**峰值 7.5~10.8 米/秒（这台机器自己的
 * 自由落体上限是 6.3）、一枚币被顶到 y=0.94（床面以上 94 厘米）、
 * 币↔币穿透冲到 76 mm、一枚币被压到 y=−0.048（床面以下）。
 * 玩家看到的「顶飞」就是这几毫秒。
 *
 * ⇒ 现在的形状：**一次建好、只走 `setNextKinematicTranslation`**。柱顶从床面
 * （top=0，整体埋在台面板以下）线性升到 `topHeight()`，退场时再沉回去。
 * 升起段每帧的位移是 2.9 mm（塔）/ 5.4 mm（宝箱），对应的位置修正速度
 * 0.14 / 0.26 米/秒 —— 与正常玩法同一量级，「柱子顶币」从一次爆炸变回一次推挤。
 * 分层 spawn 的高度改成读**实际可站表面**（见 `stackTop()`），所以永远不会生在柱子里。
 */
class TowerShow extends TimedShow {
  private readonly layers = Math.max(1, Math.round(this.promised / 4));
  /** 柱体半径（米）。网格与碰撞体**共用这一个数**，见 `towerCylinderRadius`。 */
  private readonly radius = towerCylinderRadius(this.kind);
  /**
   * 升起 0.8 秒 / 每层 0.4 秒 / 回缩 0.45 秒（P10 放大：0.6 / 0.35）。
   *
   * 塔从 1 枚变成 16 枚（4 层）之后，**每层之间的间隔就是玩家数「还有几层」的节拍**：
   * 0.35 秒时四层在 1.4 秒里发完，看起来像一次「噗」；0.4 秒 + 更慢的升起，
   * 整场约 2.85 秒，才有「一层一层长出来」的仪式感（用户原话「演出效果不太明显」）。
   */
  private readonly rise = 0.8;
  private readonly perLayer = 0.4;
  private readonly retract = 0.45;
  private cylinder: THREE.Mesh | null = null;
  /** 塔基发光环，见 `buildMeshes` / `tickHalo`。与 `cylinder` 同一次建立、同一条生命周期。 */
  private halo: THREE.Mesh | null = null;
  private spawnedLayers = 0;

  /**
   * 一层的厚度（米）= **这个币种碰撞体的高度** + 一点余量。
   *
   * ⚠️ 原先写死 `COIN.halfThickness * 2 + 0.004`（一层 = 一枚普通币）。
   * `chest` 是低多面体模型，S16 起碰撞体高 **224 mm**，是普通币（24 mm）的 9.3 倍 ——
   * 写死的那份会让宝箱塔**自相重叠**（层距 28 mm、箱高 224 mm，每层插进下层一半），
   * 求解器为了把它们推开会注入巨大能量，正是 `anomalies` 要抓的形态。
   *
   * 余量 0.004 不能省：同层币是面贴面接触，给 0 会让 Rapier 在第一步就解出穿透。
   */
  private layerStep(): number {
    return coinColliderHeight(this.kind) + 0.004;
  }

  protected baseDuration(): number {
    return this.rise + this.layers * this.perLayer + this.retract;
  }

  protected buildMeshes(): THREE.Object3D {
    const material = makeToonMaterial({
      name: 'towerCylinder',
      color: '#3fd2c0',
      ramp: 'device',
      emissive: '#1a6f66',
      emissiveIntensity: 0.6,
    });
    // ★ P3：几何**一次做到终高**，升起靠整根柱子平移（原来靠 `scale.y`，
    // 而 `scale.y` 与碰撞体是两回事——那正是「网格追上碰撞体」对不上的来源）。
    // 半径见模块顶部的 `towerCylinderRadius()`（按**这个币种自己的**层占地派生）。
    const height = this.topHeight();
    this.cylinder = new THREE.Mesh(
      new THREE.CylinderGeometry(this.radius, this.radius, height, 20),
      material,
    );
    // 起始：柱顶正好贴在床面（y=0）上 ⇒ 整根柱体埋在台面板以下，画面上看不见。
    this.cylinder.position.set(this.x, height / 2 - height, TowerShow.COLUMN_Z);

    // ★ R4b 的**与物理无关**那一半：塔基一圈发光环（计划把它和 kinematic 碰撞体分开，
    // 因为环不碰求解器，不需要等重标）。
    //
    // 为什么要有它：圆柱是从**币床底下**长出来的，升起的前 0.1 秒画面里只有「币自己在动」,
    // 看不出有东西在顶。环先亮 = 先把「这里要出事件」交代清楚，是事件的**预告**而不是装饰。
    //
    // 尺寸全部从柱体半径派生，不新写数字 —— 环必须**套住**柱体，
    // 而柱体半径本身已经按该币种的层占地算过一遍（写死第二个半径就是第二份真源）。
    const haloMaterial = makeToonMaterial({
      name: 'towerHalo',
      color: '#3fd2c0',
      ramp: 'device',
      emissive: '#2fd8c4',
      emissiveIntensity: 1.1,
    });
    const halo = new THREE.Mesh(
      new THREE.RingGeometry(this.radius * 1.15, this.radius * 1.5, 24),
      haloMaterial,
    );
    // ⚠️ 平躺要 `rotation.x = -π/2`：局部 +z 经 `rotation.x = θ` 映到 `(0, -sinθ, cosθ)`，
    //   取 **−**π/2 才得到 `(0, 1, 0)`（面朝上）。取 +π/2 会让环面朝地面 ——
    //   S18 那次「招牌面朝地面而所有计数判据全绿」就是踩在这条上，几何计数读不出朝向。
    halo.rotation.x = -Math.PI / 2;
    // 抬高 8 mm：床面本身是个网格，共面必 z-fighting（截图上表现为环忽隐忽现的闪）。
    halo.position.set(this.x, 0.008, 0.3);
    // 初始就得是 0：mount 与第一帧 tick 之间可能先画一次，默认 scale 1 会闪一帧满环。
    halo.scale.set(0.001, 0.001, 1);
    // 环与柱体不同高度，但**同一条生命周期**：`TimedShow.dispose()` 遍历 mount 逐个
    // dispose 几何与材质，所以挂在同一个 Group 下就不用管清理。
    const group = new THREE.Group();
    group.add(this.cylinder, halo);
    this.halo = halo;
    return group;
  }

  /**
   * 柱顶的终高（米）。
   *
   * ★ P3 起它的语义变了：改前是「刚好托住最后一层」，而最后一层的高度就是柱顶
   * ⇒ 下面几层必然生在柱子实体里。现在是「柱顶停在最下面那一层的**脚下**」，
   * 各层从柱顶之上依次出生、往上叠。
   */
  private topHeight(): number {
    return 0.03 + this.layers * this.layerStep();
  }

  /**
   * R4-4b：柱顶的**真碰撞体**。一根 kinematic 圆柱，**尺寸一次定死、只走平移**。
   *
   * 改前 `this.cylinder` 是纯视觉 Mesh、没有碰撞体 ⇒「塔顶开」画面上有根柱子升起来，
   * 物理上什么都不推。加了碰撞体之后柱子会真的拱起币床 —— 这正是计划里点名的风险
   * （白送结算），所以配套的是 `xixi` 侧的「汇」判据：演出窗口内被拱过线的存量币
   * 必须 ≤ 这场演出的承诺数。
   *
   * 两处刻意的设计：
   * - `setRestitutionCombineRule` **必须自己设**：开机那次 `forEachCollider` 扫描
   *   （`PhysicsWorld.applyRestitutionCombineRule`）只覆盖扫描那一刻存在的碰撞体，
   *   演出期新建的吃不到——这是 R4-P2 就写进注释的已知边界。漏了它，币↔柱这一对
   *   会静默退回 Average，弹性变成「看谁先建」的函数。
   * - 摩擦给 0.35，与推板立面（`Pusher` 的两块碰撞体）同值：都是「装置顶着币床走」的
   *   接触面，用同一个数才不会出现「同样是推动面，一个拖一个滑」。
   *   弹性给 0：柱子不该把币弹开，Min 规则下它同时保证了币↔柱 = 0。
   */
  private towerBody: RAPIER.RigidBody | null = null;

  /** 柱体的世界落点：与 `buildMeshes` 里网格的 x/z 同一处。 */
  private static readonly COLUMN_Z = 0.3;

  /**
   * 四同宝箱出场喷的**视觉币**枚数（S5a）。纯渲染，不进 `CoinPool`、不进账本，
   * 所以这个数不影响任何经济读数 —— 它买的是「看一眼就知道这不是一般的一摇」。
   */
  private static readonly JACKPOT_SPRAY_COUNT = 12;

  /**
   * 懒建 kinematic 柱体。**第一帧 `tick` 才建**，不在 `ShowDirector` 构造期建：
   * 演出是按需的，构造期建等于每局都往世界里塞一根没人看的柱子。
   *
   * 初值把柱顶摆在床面（y=0）上 ⇒ 整根埋在台面板以下，看不见也碰不着。
   */
  private ensureCollider(): void {
    if (this.towerBody) return;
    const half = this.topHeight() / 2;
    this.towerBody = this.deps.world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(
        this.x,
        -half,
        TowerShow.COLUMN_Z,
      ),
    );
    this.deps.world.createCollider(
      RAPIER.ColliderDesc.cylinder(half, this.radius)
        .setFriction(0.35)
        .setRestitution(0)
        .setRestitutionCombineRule(RESTITUTION_COMBINE_RULE),
      this.towerBody,
    );
  }

  /**
   * 把柱顶搬到 `topY`。**位置每帧跟、形状一动不动。**
   *
   * 走 `setNextKinematicTranslation` 而不是直接改 collider 的相对平移：
   * kinematic 刚体的速度是 Rapier 从「下一位置 − 当前位置」推出来的，只有走这条口
   * 柱子才是「以某个速度顶上去」；直接改 collider 平移等于瞬移，求解器会按穿透处理，
   * 每一帧都注一次能量（`anomalies` / `peakSpikeSpeed` 就是抓这个的）。
   */
  private moveCollider(topY: number): void {
    this.towerBody?.setNextKinematicTranslation({
      x: this.x,
      y: topY - this.topHeight() / 2,
      z: TowerShow.COLUMN_Z,
    });
  }

  /** 柱顶在当前时刻的高度：升起段线性长出床面，发层段保持，回缩段线性沉回去。 */
  private topAt(t: number): number {
    const hold = this.rise + this.layers * this.perLayer;
    if (t < this.rise) return this.topHeight() * (t / this.rise);
    if (t < hold) return this.topHeight();
    return this.topHeight() * Math.max(0, 1 - (t - hold) / this.retract);
  }

  /**
   * 柱子占地内的**最高币面**（返回币心 y）。
   *
   * 出生高度必须由它算，不能由「第几层 × 层高」算：床面本身是起伏的存量币堆，
   * 写死的坐标会生在币堆里（见类注释里那 84 / 56 / 28 mm 的三层埋深）。
   */
  private stackTop(): number {
    const reach = this.radius + coinCircumradius(this.kind);
    let top = 0;
    this.deps.coins.forEachActive((coin) => {
      const p = coin.position;
      if (Math.hypot(p.x - this.x, p.z - TowerShow.COLUMN_Z) > reach) return;
      if (p.y > top) top = p.y;
    });
    return top;
  }

  protected tick(t: number): void {
    if (!this.cylinder) return;
    const hold = this.rise + this.layers * this.perLayer;
    const topY = this.topAt(t);
    if (t >= this.rise && t < hold) {
      // 到一层发一层：柱顶已经到位，币在柱顶**之上**出生、落座。
      const dueLayer = Math.min(this.layers, Math.floor((t - this.rise) / this.perLayer) + 1);
      while (this.spawnedLayers < dueLayer) {
        this.spawnLayer(this.spawnedLayers, topY);
        this.spawnedLayers += 1;
        /*
         * ★ S5a 宝箱四同的「不一样出场」：**只加视觉，不加碰撞体**。
         *
         * 为什么用 `CoinSpray` 而不是多给几个宝箱：用户 09-30 明确拍板**不做宝箱雨**，
         * 而理由不是审美 —— 多枚巨型宝箱同层重叠就是求解器注入能量（R4-P3 修过的同一类，
         * 宝箱碰撞体高 224 mm，层距稍小就互相插进一半）。所以要堆的是**仪式感**而不是数量：
         * 缩放/旋转入场（既有时间轴）+ 这一圈纯渲染的溢币 + 全屏金闪（`SlotMachine` 那侧的
         * `climax`）+ 招牌屏开奖字幕（`notify` 已经把文案推给 `marqueeScreen().subtitle`）。
         * 四样里三样是现成的，新增的这一样 `burst()` **不进 `CoinPool`、不进账本**
         * （见 `ShowDeps.spray` 的警告），所以 `economy` 的回收率读数一个字都不动。
         */
        if (this.jackpot && this.kind === 'chest' && this.spawnedLayers === 1) {
          this.deps.spray?.burst(
            TowerShow.JACKPOT_SPRAY_COUNT,
            { x: this.x, y: 0.12, z: TowerShow.COLUMN_Z },
            this.deps.rng,
          );
        }
      }
    }
    const centerY = topY - this.topHeight() / 2;
    this.cylinder.position.y = centerY;
    // 碰撞体与网格**同一条派生**：都只吃这一个 `topY`，不引入第二个高度来源。
    this.ensureCollider();
    this.moveCollider(topY);
    this.tickHalo(t, hold);
  }

  /**
   * 拆演出时把刚体**还回世界**。
   *
   * ⚠️ 基类 `TimedShow.dispose()` 只遍历 mount 拆几何与材质——它不知道物理世界的存在。
   * 漏这一步等于每次塔演出泄漏一根 kinematic 圆柱：币床里会莫名出现「看不见的墙」,
   * 而 `activeCoins`、`anomalies` 一类判据**全都读不出它**（没有币、也没有穿透，
   * 只是多了一个碰撞体）。所以这里显式 `removeRigidBody`，并在删后置空。
   */
  dispose(): void {
    if (this.towerBody) {
      this.deps.world.removeRigidBody(this.towerBody);
      this.towerBody = null;
    }
    super.dispose();
  }

  /**
   * 光环时间线：**升起段的前一半**就长到位，之后一路保持，到回缩段才缩回去。
   *
   * 它必须比柱体**快**，否则「预告」不成立 —— 柱体 0.8 秒长满，环若跟着走同样 0.8 秒，
   * 玩家看到环时币已经在动了，环就成了跟随物而不是事件的预告。
   *
   * 用 scale 而不是透明度：`transparent = true` 是一次材质状态变更（并且会让这条
   * 材质进透明队列、排序行为跟着变），而缩放只是矩阵 ⇒ 与计划的 +0 program 一致。
   * 环平躺后局部 x/y 轴就是世界 x/z，所以 `set(k, k, 1)`。
   */
  private tickHalo(t: number, hold: number): void {
    if (!this.halo) return;
    const k =
      t < this.rise * 0.5
        ? t / (this.rise * 0.5)
        : t < hold
          ? 1
          : Math.max(0, 1 - (t - hold) / this.retract);
    this.halo.scale.set(k, k, 1);
  }

  /**
   * 发一层币。
   *
   * ★ 出生高度 = **柱顶与「柱子占地里的最高币面」之中较高的那个** + 半个币高 + 下落余量。
   * 原来写死的 `0.03 + (layer+1) × layerStep` 是「第几层」的函数，而柱顶在升起段就已经
   * 走到了 `0.03 + layers × layerStep` —— 除最后一层外每一枚都生在柱子实体内部
   * （4 层塔：前三层分别埋 84 / 56 / 28 mm），位置修正把它们当穿透弹出去。
   * 现在这个函数不吃 `layer` 的高度，只吃**当前盘面**，所以：
   * - 生在柱顶之上 → 永远不会在柱子里；
   * - 生在存量币堆之上 → 永远不会在币堆里；
   * - 后一层看得见前一层的币心 → 一层压一层地落座。
   */
  private spawnLayer(layer: number, topY: number): void {
    const spec = coinColliderSpec(this.kind);
    const off = layerOffsets(this.kind);
    const half = coinColliderHeight(this.kind) / 2;
    // 12 mm 的下落余量：贴着放会一出生就是接触态，给一点点距离让它「落进去」。
    const y = Math.max(topY, this.stackTop() + half) + half + 0.012;

    // ★ S16：`yaw` 对**长方体**币种必须取 0。
    //
    // 铜币与钻石是圆柱，绕 y 轴转多少度脚印都一样，所以 `layer * 0.9` 这个
    // 「每层错开朝向」的写法在 S15 之前一直没暴露问题。宝箱是**切角矩形**：
    // 转 51.6° 后它的世界半宽从 `hx`（0.161）涨到 `hx|cos| + hz|sin|`（0.201），
    // 而邻位中心只距 `2 × offX`（0.328）⇒ 层内重叠约 8 厘米，
    // 求解器为了把它们推开会注入巨大能量 —— 正是 `anomalies` 抓的形态。
    // 圆柱保留错开（币面朝向更自然），长方体一律轴对齐。
    const yaw = spec.shape === 'cuboid' ? 0 : layer * 0.9;

    // 承诺数只有 1 枚时**居中**：直接取 2×2 的第一个角会让它偏出 0.16 米，
    // 看起来像「宝箱没对准柱子」。（宝箱 S16 起就是 1 枚。）
    const corners: ReadonlyArray<readonly [number, number]> =
      this.promised === 1
        ? [[0, 0]]
        : [
            [-off.x, -off.z],
            [off.x, off.z],
            [-off.x, off.z],
            [off.x, -off.z],
          ];

    for (const [dx, dz] of corners) {
      // 承诺数是硬上限：降级交付时最后一层可能不足 4 枚，按承诺停发。
      if (this.spawned >= this.promised) return;
      const ok = ShowDirector.spawnOne(
        this.deps,
        this.kind,
        this.x + dx,
        y,
        TowerShow.COLUMN_Z + dz,
        yaw,
      );
      if (ok) this.spawned += 1;
    }
  }
}

/**
 * 装置 B · 喷泉：背板前缘向盘面均匀抛出一弧真币，**同时**从机柜顶部的溢流口
 * 喷出一批**纯视觉币**飞到机柜外面去。
 *
 * 真抛射、落点交给物理——初速度全部压在这台机器自身的合法上限之内
 * （vy ≤ 2.2 < `COIN.maxUpwardSpeed`，合速度 < 6.3 的自由落体上限）。
 *
 * ## ★ S16：两条通道，语义完全不同
 *
 * | | 真币 | 视觉币（`CoinSpray`） |
 * |---|---|---|
 * | 出处 | `ShowDirector.spawnOne` → `coins.acquire` | `deps.spray.burst` |
 * | 物理 | Rapier 刚体，参与一切规则 | 无刚体，自己积分 |
 * | 账本 | 进 `activeCoins`、能越线结算 | **一个账本都不进** |
 * | 观感 | 落在盘面上，是奖励 | 飞出机柜外，纯看 |
 *
 * 用户原话「视觉上可以喷更多筹码喷出机器外，**忽略不算这部分的筹码**」——
 * 「忽略不算」在代码里就是「不碰 `CoinPool`」。理由见 `CoinSpray` 的模块注释。
 *
 * 真币枚数**一枚不动**（`SHOW_SPECS.fountain.count = 10`）：每多一枚免费币都在顶
 * 回收率，而这一轮只要效果不要数值。要「更多筹码」的那部分全部由视觉币承担。
 */
class FountainShow extends TimedShow {
  /**
   * 波次 6（S16 放大：4）。
   *
   * 10 枚真币分 6 波 = 2/2/2/2/1/1 —— 波数变多、每波变薄，读起来是「持续地涌」而不是
   * 「噗噗噗三下」。波与波之间那 0.45 秒的空档是玩家读「还没喷完」的地方。
   */
  private readonly bursts = 6;
  private readonly perBurst = Math.max(1, Math.ceil(this.promised / this.bursts));
  /** 每波额外喷出的**纯视觉币**枚数（6 波 × 6 = 36 枚）。 */
  private readonly sprayPerBurst = 6;
  /**
   * 喷口位置。★ S13：z 从 `backZ + 0.07` 前移到 `+ 0.10` —— 后墙内表面已经移到可见
   * 背板平面 `TABLE.backZ`（见 `TableBuilder` 的后墙注释），再按旧值吐币会让币后缘
   * 落在 −1.352，**嵌进墙里 0.2 厘米**，求解器把它弹出来（观感是「币从墙里蹦出来」）。
   * 前移到 −1.25 后币后缘 −1.322，离墙 2.8 厘米。
   */
  private readonly nozzleAt = { y: 1.35, z: TABLE.backZ + 0.1 };
  /** 波间隔（秒）。真币的到点判定与视觉币共用它，所以两路是**同一拍**。 */
  private readonly burstInterval = 0.45;
  private fired = 0;

  /**
   * 整场时长（S16：1.6 → 3.9 秒）。
   *
   * `bursts × 0.45 + 1.2`：那 1.2 秒的尾巴是**留给溢流口的**——
   * 视觉币的飞行时间约 0.8 秒，最后一波喷完还要看着它们飞出画面。
   * 用户原话「持续时间长一点」。
   */
  protected baseDuration(): number {
    return this.bursts * this.burstInterval + 1.2;
  }

  protected buildMeshes(): THREE.Object3D {
    const nozzleMaterial = makeToonMaterial({
      name: 'fountainNozzle',
      color: '#d8b25c',
      ramp: 'device',
      emissive: '#7a5a1e',
      emissiveIntensity: 0.5,
    });
    // 喷口 0.09（P10 放大：0.06）：背板处约 94 后备像素/米，0.06 的锥口只有 5~6 像素，
    // 在 360p 内部缓冲上几乎看不见；0.09 才读得出是个「喷头」。
    const nozzle = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.2, 14), nozzleMaterial);
    nozzle.position.set(this.x, this.nozzleAt.y, this.nozzleAt.z);
    nozzle.rotation.x = Math.PI / 3; // 朝前上方斜指盘面

    // 溢流口：一个扁槽，横在机柜顶沿之上。它是**演出装置**（只在演出期间存在），
    // 所以走和喷头同一条生命周期 —— `TimedShow.dispose()` 会连同几何与材质一起拆掉。
    const orificeMaterial = makeToonMaterial({
      name: 'spillOrifice',
      color: '#c8b273',
      ramp: 'device',
      emissive: '#6f5c26',
      emissiveIntensity: 0.55,
    });
    const orifice = new THREE.Mesh(
      new THREE.BoxGeometry(
        SPILL_ORIFICE_SIZE.width,
        SPILL_ORIFICE_SIZE.height,
        SPILL_ORIFICE_SIZE.depth,
      ),
      orificeMaterial,
    );
    orifice.position.set(SPILL_ORIFICE.x, SPILL_ORIFICE.y, SPILL_ORIFICE.z);

    const group = new THREE.Group();
    group.add(nozzle);
    group.add(orifice);
    return group;
  }

  protected tick(t: number): void {
    const due = Math.min(this.bursts, Math.floor(t / this.burstInterval));
    while (this.fired < due) {
      this.fireBurst(this.fired);
      this.fired += 1;
    }
  }

  private fireBurst(burst: number): void {
    // ★ 视觉币**先发**：它们不需要预算（`CoinPool` 满不满都照喷），
    //   而且要和这一波真币同时出现在画面上，晚一帧就会读成「两件事」。
    this.deps.spray?.burst(
      this.sprayPerBurst,
      { x: SPILL_ORIFICE.x + this.x, y: SPILL_ORIFICE.y, z: SPILL_ORIFICE.z },
      this.deps.rng,
    );

    for (let i = 0; i < this.perBurst; i += 1) {
      if (this.spawned >= this.promised) return;
      const rng = this.deps.rng;
      // 散布 2.8（P10 放大：2.2）：横向铺开的弧线要更宽才不叠成一坨。
      const spread = (this.spawned / Math.max(1, this.promised) - 0.5) * 2.8;
      this.spawn(this.nozzleAt.y, this.nozzleAt.z, rng() * Math.PI * 2, {
        x: spread + (rng() - 0.5) * 0.4,
        y: 1.4 + rng() * 0.8,
        z: 1.6 + rng() * 1.0 + burst * 0.15,
      });
    }
  }
}

/**
 * 装置 C · 闸门落币：背板下方开一条缝，逐枚滚出一排真币到台面后区
 * （推板顶面尾部，输送带会把它们带进盘面——视觉上是「庄家补货」）。
 */
class GateShow extends TimedShow {
  /**
   * 闸口位置。★ S13：z 从 `backZ + 0.05` 前移到 `+ 0.10` —— 后墙内表面已经移到可见
   * 背板平面 `TABLE.backZ`（见 `TableBuilder` 的后墙注释），旧值 −1.30 吐出的币后缘在
   * −1.372，**有 2.2 厘米嵌在墙里**，求解器会把它弹出来。前移到 −1.25 后币后缘 −1.322，
   * 离墙 2.8 厘米。
   *
   * ★ S14：`y` 从 `pusherTopY + 0.06` 抬到**静置币顶之上**。
   *
   * 起因是落币口后移到 A 区（`TABLE.drop.z` −0.72 → −1.20）：闸板原先立在台面尾部、
   * 一枚币都够不到，现在**正立在落点带里**——
   *   闸板 z ∈ [−1.268, −1.232]（深 `COIN_DIAMETER / 4`），
   *   落币脚印（半径 0.072）覆盖 `z_c ∈ [−1.25, −1.15]` 的 **90%**，
   *   而币被摩擦拖出这条带要 **~7 秒**（⚠️ 这个 7 秒是用 **S13 破对称期**的 26 毫米/循环推出来的：
   *     出厂态对称时 `probe` 净漂移 **−0.25 毫米/循环**（上限 2.32）⇒ 摩擦几乎不拖行，
   *     所以 7 秒只能读成「破对称态下会这么快」，不是出厂态的保证。口径详见 `kinds.ts` 标定史第 5 轮。）⇒ 玩家一在投币，
   *   闸板「滑下」那 0.35 秒几乎每场演出都会扫过一枚静置币。
   * 所以闭闸下沿必须 ≥ 币顶 `pusherTopY + 2 × halfThickness`，否则就是穿模。
   *
   * ⚠️ 只抬**面板**、不抬**出币高度**（见 `tick` 里的 spawn）：闸板没有碰撞体，
   * 抬它不会动到任何物理读数，抬 spawn 会（落点高度变了 → 补货币的散布与弹跳都变）。
   *
   * ★ S15：下沿的「币顶」改读**这个币种的碰撞体高度**（`coinColliderHeight`）。
   * `diamond` 是低多面体模型，碰撞体高 76 mm（普通币的 3.2 倍）——
   * 沿用普通币厚度的写法会让**静置的钻石被滑闸从中间扫过**（视觉穿模）。
   * 写成 getter 而不是字段：字段初始化时 `this.kind` 还没保证就位，
   * 而这类「初始化顺序」缺陷是**零报错**的（读到 `undefined` 只是把面板放在 NaN 高度）。
   */
  private get slotAt(): { y: number; z: number } {
    return {
      y:
        TABLE.pusherTopY +
        coinColliderHeight(this.kind) +
        0.005 +
        GATE_PANEL_SIZE.height / 2,
      z: TABLE.backZ + 0.1,
    };
  }

  /**
   * 出币高度（米）。
   *
   * ⚠️ 出币高度**不跟 `slotAt.y` 走**：闸板抬到币顶之上只是为了让滑闸不扫过静置币，
   * 币仍然从台面高度滚出来。
   *
   * ★ S16：原先写死 `TABLE.pusherTopY + 0.08`。拆开看那个 0.08 是
   * 「台面静置币的顶（`2 × halfThickness = 0.024`）+ 余量 `0.044` + **半个普通币**（0.012）」，
   * 而 `GateShow` 也送**钻石** —— 钻石 S16 起高 131.8 mm，是普通币的 5.5 倍。
   *
   * 写死时的后果：钻石底沿落在 `0.28 − 0.0659 = 0.214`，而台面静置币的顶是
   * `pusherTopY + 0.024 = 0.224` ⇒ **出生就嵌进币堆 1 厘米**。
   * 求解器为了把它推出来会注入速度，实测在 `xixi` 里表现为**币床上的铜币被挤穿地板**：
   * `anomalySamples` 抓到 `bronze @(-0.615, -0.932, 0.278) v=(…, -5.907, …)`。
   * （对照实验：把 S16 的尺寸与宝箱枚数回退到 S15，`xixi` 连跑 3 遍 anomalies = 0。）
   *
   * 拆成「台面静置币的顶 + 余量 + **这个币种**碰撞体的一半」之后：
   *   - 铜币：`0.2 + 0.024 + 0.044 + 0.0126 = 0.2806`，与原写死值 0.28 **实质相同**；
   *   - 钻石：`0.2 + 0.024 + 0.044 + 0.0659 = 0.334`，底沿 0.268 > 0.224 ✓。
   */
  private get spawnAtY(): number {
    const restingTop = TABLE.pusherTopY + COIN.halfThickness * 2;
    return restingTop + GATE_RELEASE_CLEARANCE + coinColliderHeight(this.kind) / 2;
  }
  private readonly interval = 0.16;
  private released = 0;
  private panel: THREE.Mesh | null = null;

  protected baseDuration(): number {
    return 0.35 + this.promised * this.interval + 0.4;
  }

  protected buildMeshes(): THREE.Object3D {
    const material = makeToonMaterial({
      name: 'gatePanel',
      color: '#8a7346',
      ramp: 'device',
      emissive: '#3f3a2a',
      emissiveIntensity: 0.5,
    });
    // 面板尺寸见模块顶部的 `GATE_PANEL_SIZE`：宽度必须盖住 7 枚并排（7 × 币径 + 余量），
    // 所以它随币尺寸档位走。开口太窄会让币在缝里互相顶住。
    this.panel = new THREE.Mesh(
      new THREE.BoxGeometry(GATE_PANEL_SIZE.width, GATE_PANEL_SIZE.height, GATE_PANEL_SIZE.depth),
      material,
    );
    this.panel.position.set(this.x, this.slotAt.y, this.slotAt.z);
    return this.panel;
  }

  protected tick(t: number): void {
    // 闸板先滑开、发完币再滑回。
    const openT = 0.35;
    const closeAt = this.baseDuration() - 0.35;
    if (this.panel) {
      if (t < openT) this.panel.position.y = this.slotAt.y + (t / openT) * 0.13;
      else if (t > closeAt) this.panel.position.y = this.slotAt.y + Math.max(0, 1 - (t - closeAt) / 0.35) * 0.13;
    }
    const due = Math.min(this.promised, Math.floor(Math.max(0, t - openT) / this.interval));
    while (this.released < due) {
      const index = this.released;
      this.released += 1;
      // 落点间距 = 币径 × 1.125（原尺寸 0.135 = 币径 0.12 + 0.015 的缝）。
      // ★ S13 起缝也随币径走：固定 0.015 在 ×1.2 下只剩币径的 10%，几枚币会挤在一起。
      const offset = (index - (this.promised - 1) / 2) * (COIN_DIAMETER * 1.125);
      // 逐枚从缝里滚出：横向落点错位由 x 承担，这里覆盖基类居中的 x。
      const ok = ShowDirector.spawnOne(
        this.deps,
        this.kind,
        this.x + offset,
        // 出币高度见 `spawnAtY`（按**这个币种**的碰撞体高度派生，不再写死 0.08）。
        this.spawnAtY,
        this.slotAt.z + 0.14,
        this.deps.rng() * Math.PI * 2,
        { x: 0, y: 0, z: 0.8 },
      );
      if (ok) this.spawned += 1;
      else break;
    }
  }
}
