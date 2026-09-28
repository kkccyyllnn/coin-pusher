import * as THREE from 'three';
import type { CoinPool } from '../entities/CoinPool';
import { coinColliderHeight, coinColliderSpec } from '../entities/coinModels';
import { COIN, TABLE, type CoinKind } from '../game/constants';
import { makeToonMaterial } from '../render/ToonMaterial';
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
const SHOW_SPECS: Record<ShowId, { count: number; min: number }> = {
  /**
   * ★ **P10 起回到「阵型规模」**（用户拍板 #8）。
   *
   * 上面的 ①~⑤ 那五轮实测是 **P6~P9 的老前提**：当时免费币是**唯一的筹码来源**
   * （`crossingReturn` 里 payout/bounty 权重为 0，越线返值全靠盘面币），
   * 所以每一枚免费币都直接顶回收率，只能给到个位数。
   *
   * P10 换了前提：老虎机变成 **45% 中奖 / 15% 胡萝卜惩罚 / 40% 杂牌**，
   * 奖励是「看得见的大场面」而不是「涓涓细流」——总量靠**降低频率**（中奖符号权重
   * 力 26 / 钻 7 / 塔 6 / 泉 4 / 箱 2）压下来，单次规模则放大到阵型规模。
   * 期望水量 ≈ 0.45 × (0.06×16 + 0.04×10 + 0.02×8) ≈ **0.75 枚/摇奖 ≈ 0.068 枚/投**。
   *
   * ⚠️ **这仍然高于 `FAUCET_BUDGET_PER_DROP = 0.04` 约 1.7 倍**——
   * 余量是靠 P10 新增的**汇**（两侧排水槽 + 得分线两端下水道）买回来的。
   * 所以 S6（本表）与 S7（`DRAIN`）**必须成对验证**：
   * 只放大源不装汇 → `economy` 的回收率会被顶过 1 → 整局不终局（点火）。
   */
  // 塔 16 枚 = 4 层 × 2×2，柱高 4×(2×0.01+0.004) ≈ 0.096 米。
  tower: { count: 16, min: 4 },
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
 * - `count: 3` 取 `gate.min`：兜底应当**小于**一次正常奖励（泉 10 / 箱 8），
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
  static showSpecs(): Record<ShowId, { count: number; min: number }> {
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
    const wanted = Math.max(spec.min, Math.min(opts.count ?? spec.count, spec.count));

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
    this.queue.push(() => this.createShow(id, promised, downgraded, kind, x));
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

  private createShow(id: ShowId, promised: number, downgraded: boolean, kind: CoinKind, x: number): Show {
    switch (id) {
      case 'fountain':
        return new FountainShow(this.deps, this.group, id, promised, downgraded, kind, x);
      case 'gate':
      case 'diamond':
        return new GateShow(this.deps, this.group, id, promised, downgraded, kind, x);
      case 'chest':
      case 'tower':
        return new TowerShow(this.deps, this.group, id, promised, downgraded, kind, x);
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
 */
class TowerShow extends TimedShow {
  private readonly layers = Math.max(1, Math.round(this.promised / 4));
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
    // 圆柱从台底向上长：几何原点放在柱体中心，靠 scale.y + position.y 模拟升起。
    // 半径见模块顶部的 `towerCylinderRadius()`（按**这个币种自己的**层占地派生）。
    const radius = towerCylinderRadius(this.kind);
    this.cylinder = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, 1, 20), material);
    this.cylinder.position.set(this.x, 0, 0.3);
    this.cylinder.scale.y = 0.001;
    return this.cylinder;
  }

  /** 圆柱顶的目标高度：刚好托住最后一层。 */
  private topHeight(): number {
    return 0.03 + this.layers * this.layerStep();
  }

  protected tick(t: number): void {
    if (!this.cylinder) return;
    const hold = this.rise + this.layers * this.perLayer;
    let height: number;
    if (t < this.rise) {
      height = this.topHeight() * (t / this.rise);
    } else if (t < hold) {
      height = this.topHeight();
      // 到一层发一层：圆柱顶着币升出床面，回缩前币已落座。
      const dueLayer = Math.min(this.layers, Math.floor((t - this.rise) / this.perLayer) + 1);
      while (this.spawnedLayers < dueLayer) {
        this.spawnLayer(this.spawnedLayers);
        this.spawnedLayers += 1;
      }
    } else {
      height = this.topHeight() * Math.max(0, 1 - (t - hold) / this.retract);
    }
    this.cylinder.scale.y = Math.max(0.001, height);
    this.cylinder.position.y = height / 2;
  }

  private spawnLayer(layer: number): void {
    // 层高走 `layerStep()`（= 这个币种碰撞体的高度 + 余量），不写死普通币的厚度。
    const y = 0.03 + (layer + 1) * this.layerStep();
    const spec = coinColliderSpec(this.kind);
    const off = layerOffsets(this.kind);

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
      const ok = ShowDirector.spawnOne(this.deps, this.kind, this.x + dx, y, 0.3 + dz, yaw);
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
   *   而币被摩擦拖出这条带要 **~7 秒**（26 毫米/循环）⇒ 玩家一在投币，
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
