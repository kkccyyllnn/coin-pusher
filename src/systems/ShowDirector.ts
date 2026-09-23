import * as THREE from 'three';
import type { CoinPool } from '../entities/CoinPool';
import { COIN, TABLE, type CoinKind } from '../game/constants';
import type { Telemetry } from './Telemetry';

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

export type ShowId = 'chest' | 'tower' | 'fountain' | 'gate';

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
  // 塔/泉各交 1 枚：免费币预算是硬红线（见 `xixi.ts` 的 `FAUCET_BUDGET_PER_DROP`），
  // 1 枚 × (15%+15%) 权重 × 每 11 投集齐 ≈ 0.027 枚/投，是唯一站得住的量级。
  tower: { count: 1, min: 1 },
  // chest 在 P6 才接上「越线触发」的调用方；这里先注册为同量级的投放，接口就位。
  chest: { count: 1, min: 1 },
  fountain: { count: 1, min: 1 },
  // 闸门不参与老虎机奖励表（它是「庄家补货」装置），所以保持能演出阵型的规模，
  // 也正是 show 模式用来验「降级交付」的装置（窗口 {3..6} 宽，落点确定）。
  gate: { count: 7, min: 3 },
};

const COIN_DIAMETER = COIN.radius * 2;

export class ShowDirector {
  /** 装置几何体的统一挂载点（一个 group，便于整体显隐与清理）。 */
  readonly group = new THREE.Group();

  private readonly queue: Array<() => Show> = [];
  private active: Show | null = null;

  constructor(private readonly deps: ShowDeps) {}

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
  private readonly rise = 0.6;
  private readonly perLayer = 0.35;
  private readonly retract = 0.45;
  private cylinder: THREE.Mesh | null = null;
  private spawnedLayers = 0;

  protected baseDuration(): number {
    return this.rise + this.layers * this.perLayer + this.retract;
  }

  protected buildMeshes(): THREE.Object3D {
    const material = new THREE.MeshStandardMaterial({
      color: '#3fd2c0',
      roughness: 0.35,
      metalness: 0.5,
      emissive: '#1a6f66',
      emissiveIntensity: 0.6,
    });
    // 圆柱从台底向上长：几何原点放在柱体中心，靠 scale.y + position.y 模拟升起。
    this.cylinder = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 1, 20), material);
    this.cylinder.position.set(this.x, 0, 0.3);
    this.cylinder.scale.y = 0.001;
    return this.cylinder;
  }

  /** 圆柱顶的目标高度：刚好托住最后一层。 */
  private topHeight(): number {
    return 0.03 + this.layers * (COIN.halfThickness * 2 + 0.004);
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
    const y = 0.03 + (layer + 1) * (COIN.halfThickness * 2 + 0.004);
    const offsets = [
      [-COIN.radius, -COIN.radius],
      [COIN.radius, COIN.radius],
      [-COIN.radius, COIN.radius],
      [COIN.radius, -COIN.radius],
    ];
    for (const [dx, dz] of offsets) {
      // 承诺数是硬上限：降级交付时最后一层可能不足 4 枚，按承诺停发。
      if (this.spawned >= this.promised) return;
      const ok = ShowDirector.spawnOne(this.deps, this.kind, this.x + dx, y, 0.3 + dz, layer * 0.9);
      if (ok) this.spawned += 1;
    }
  }
}

/**
 * 装置 B · 喷泉：背板前缘向盘面均匀抛出一弧真币。
 * 真抛射、落点交给物理——初速度全部压在这台机器自身的合法上限之内
 * （vy ≤ 2.2 < COIN.maxUpwardSpeed，合速度 < 6.3 的自由落体上限）。
 */
class FountainShow extends TimedShow {
  private readonly bursts = 3;
  private readonly perBurst = Math.max(1, Math.ceil(this.promised / this.bursts));
  private readonly nozzleAt = { y: 1.35, z: TABLE.backZ + 0.07 };
  private fired = 0;

  protected baseDuration(): number {
    return this.bursts * 0.3 + 0.4;
  }

  protected buildMeshes(): THREE.Object3D {
    const material = new THREE.MeshStandardMaterial({
      color: '#d8b25c',
      roughness: 0.3,
      metalness: 0.75,
      emissive: '#7a5a1e',
      emissiveIntensity: 0.5,
    });
    const nozzle = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.16, 14), material);
    nozzle.position.set(this.x, this.nozzleAt.y, this.nozzleAt.z);
    nozzle.rotation.x = Math.PI / 3; // 朝前上方斜指盘面
    return nozzle;
  }

  protected tick(t: number): void {
    const due = Math.min(this.bursts, Math.floor(t / 0.3));
    while (this.fired < due) {
      this.fireBurst(this.fired);
      this.fired += 1;
    }
  }

  private fireBurst(burst: number): void {
    for (let i = 0; i < this.perBurst; i += 1) {
      if (this.spawned >= this.promised) return;
      const rng = this.deps.rng;
      const spread = (this.spawned / Math.max(1, this.promised) - 0.5) * 2.2;
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
  private readonly slotAt = { y: TABLE.pusherTopY + 0.06, z: TABLE.backZ + 0.05 };
  private readonly interval = 0.16;
  private released = 0;
  private panel: THREE.Mesh | null = null;

  protected baseDuration(): number {
    return 0.35 + this.promised * this.interval + 0.4;
  }

  protected buildMeshes(): THREE.Object3D {
    const material = new THREE.MeshStandardMaterial({
      color: '#8a7346',
      roughness: 0.55,
      metalness: 0.4,
      emissive: '#3f3a2a',
      emissiveIntensity: 0.5,
    });
    this.panel = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.14, 0.03), material);
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
      const offset = (index - (this.promised - 1) / 2) * (COIN_DIAMETER + 0.015);
      // 逐枚从缝里滚出：横向落点错位由 x 承担，这里覆盖基类居中的 x。
      const ok = ShowDirector.spawnOne(
        this.deps,
        this.kind,
        this.x + offset,
        this.slotAt.y + 0.02,
        this.slotAt.z + 0.14,
        this.deps.rng() * Math.PI * 2,
        { x: 0, y: 0, z: 0.8 },
      );
      if (ok) this.spawned += 1;
      else break;
    }
  }
}
