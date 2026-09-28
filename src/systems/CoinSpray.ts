import * as THREE from 'three';
import { createCoinCylinderGeometry } from '../entities/CoinPool';
import { COIN, PHYSICS, TABLE } from '../game/constants';
import { COIN_SKINS, type CoinSkin } from '../game/cosmetics';
import { createCoinMaterial } from '../utils/coinTexture';

/**
 * **纯视觉币通道**（S16）。
 *
 * ## 它解决的是什么问题
 *
 * 用户原话：「视觉上可以喷更多筹码喷出机器外，**忽略不算这部分的筹码**」。
 *
 * 「喷出机器外」这件事，用真币做不出来：
 * - 真币有 Rapier 刚体，一旦飞出机柜就会被 `processOutcomes` 的异常判据回收
 *   （`|x| > 1.3` → `anomalyCount += 1` + despawn）——**正常演出会污染异常计数**，
 *   而 `anomalies` 是「求解器还在不在造能量」这条真判据的哨兵；
 * - 真币进 `CoinPool` 会抬高 `activeCoins`，而 `show` 模式的对账是
 *   「实发 = 承诺，且 活跃差 + 结算差 + 流失差 = 承诺数」——多出来的币会让它**立刻破**；
 * - 它们还会被推板推过得分线、变成真钱，而用户明确说了「忽略不算」。
 *
 * 所以这里开一条**完全独立**的通道：没有刚体、不进 `CoinPool`、不进任何账本，
 * 只有位置 / 速度 / 自旋，自己积分。
 *
 * ## 代价（诚实记账）
 *
 * - **+1 draw call**（空闲时 `visible = false`，所以峰值只在喷泉演出期间 +1）。
 *   硬上限是 50、现在 44，还剩 6 个名额。
 * - **0 新增程序**：材质走 `createCoinMaterial('bronze', skin)`，与币池里的铜币材质
 *   **完全同 defines**（`USE_MAP` + `USE_GRADIENTMAP` + `SD_DETAIL_KIND=0`），
 *   于是命中同一份已编译程序。色带也复用 `coin` 那一条，`ramps` 不涨。
 * - **0 新增纹理**：贴图就是铜币那张 `CanvasTexture`（同一个 `coinTexels` 真源）。
 *
 * ## 为什么几何体要单独建一份
 *
 * `CoinPool.dispose()` 会释放它自己那份圆柱几何。共享同一份实例的话，
 * 币池一重建，这里的币就会渲染成空 —— three 不报错，是零报错的静默失效。
 * 所以走 `createCoinCylinderGeometry()` 各建各的（参数仍是同一个真源）。
 */

/** 同时在飞的视觉币上限。6 波 × 4 枚 = 24，留一倍余量给两场演出重叠。 */
const CAPACITY = 48;

/** 单枚视觉币的最长存活时间（秒）。兜底：防止卡在某个角落永不回收。 */
const MAX_AGE = 5;

/**
 * 回收边界。
 *
 * `y` 取负值：机柜外面**没有地板**（`TableBuilder` 的地板就是台面），
 * 所以不回收的话币会永远往下掉。−0.9 已经远在画面下方。
 */
const KILL = { y: -0.9, absX: 2.2, zMin: -3.2, zMax: 3.4 };

type VisualCoin = {
  live: boolean;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** 当前自旋角（弧度）。 */
  angle: number;
  /** 自旋角速度（弧度/秒）。 */
  spin: number;
  /** 自旋轴（单位化后使用）。**接近水平** —— 币飞出去是翻着滚的，不是像唱片一样转。 */
  ax: number;
  ay: number;
  az: number;
  age: number;
};

export class CoinSpray {
  readonly group = new THREE.Group();

  private readonly geometry: THREE.BufferGeometry;
  private material: THREE.MeshToonMaterial;
  private readonly mesh: THREE.InstancedMesh;
  private readonly items: VisualCoin[] = [];
  private active = 0;

  /** 自 `resetStats()` 以来累计发射枚数（判据：证明这条通道真的在工作）。 */
  private launched = 0;
  /** 机柜外（`|x| > 侧壁外沿`）达到过的**最高点**（判据：证明是「从顶沿之上飞出去」而不是穿玻璃）。 */
  private peakYOutside = -Infinity;

  private readonly position = new THREE.Vector3();
  private readonly quaternion = new THREE.Quaternion();
  private readonly unitScale = new THREE.Vector3(1, 1, 1);
  private readonly matrix = new THREE.Matrix4();
  private readonly axis = new THREE.Vector3();

  constructor(skin: CoinSkin = COIN_SKINS[0]) {
    this.geometry = createCoinCylinderGeometry();
    this.material = createCoinMaterial('bronze', skin);
    this.mesh = new THREE.InstancedMesh(this.geometry, this.material, CAPACITY);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // 机柜外的飞币不投影：影子接收面在台面上，投过去只会多一遍 shadow pass 的代价。
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    // 实例每帧满场移动，自动包围球算不准，整组关掉视锥裁剪。
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    // ★ 空闲时**整体隐藏**：`count = 0` 的 InstancedMesh 仍会被 three 记一次 draw call
    //   （`renderInstances` 无条件 `info.update(...)`），而 draw call 只剩 6 个名额。
    this.mesh.visible = false;
    this.group.add(this.mesh);

    for (let i = 0; i < CAPACITY; i += 1) {
      this.items.push({
        live: false,
        x: 0,
        y: 0,
        z: 0,
        vx: 0,
        vy: 0,
        vz: 0,
        angle: 0,
        spin: 0,
        ax: 0,
        ay: 1,
        az: 0,
        age: 0,
      });
    }
  }

  /**
   * 从 `origin` 喷出一批视觉币。返回**实际发出**的枚数。
   *
   * 初速度是配对的（`vx` 越大 `vy` 也越大），因为「飞出去」有个几何条件：
   * 币必须在 `|x|` 到达侧壁外沿（0.83）之前**还没掉到玻璃顶沿（1.6）以下**，
   * 否则就是「穿过玻璃围板飞出去」。最慢的一档（`vx=2.4`）在 `x=0.83` 处
   * 仍有 `y≈1.76`，留 16 厘米余量。
   */
  burst(count: number, origin: { x: number; y: number; z: number }, rng: () => number): number {
    let spawned = 0;
    for (const item of this.items) {
      if (spawned >= count) break;
      if (item.live) continue;

      item.live = true;
      // 出口是「溢流口」：给一点抖动，免得 24 枚叠成一条线。
      item.x = origin.x + (rng() - 0.5) * 0.14;
      item.y = origin.y + (rng() - 0.5) * 0.06;
      item.z = origin.z + (rng() - 0.5) * 0.14;

      // 左右交替分扇：一波里两侧都有，观感是「两侧同时溢出来」。
      //
      // ★ 速度是**配对**的（`vx` 越大 `vy` 也越大），因为「飞出去」有个几何条件：
      //   币必须在 `|x|` 到达侧壁外沿（0.83）之前**还没掉到玻璃顶沿（1.6）以下**，
      //   否则就是「穿过玻璃围板飞出去」。最慢的一档（`vx=1.9, vy=2.6`）在 `x=0.83` 处
      //   仍有 `y≈1.675`，留 7.5 厘米余量。
      //   第一版取 `vy 2.2~3.2` 时留了 16 厘米余量，但滞空只有 0.8 秒 ——
      //   截图里同时只看得见 2 枚币，「更多筹码喷出去」的观感出不来。
      //   抬高初速之后滞空 ≈ 0.87 秒、峰值 ≈ 2.0 米，一屏能同时看到 6 枚以上。
      const side = spawned % 2 === 0 ? -1 : 1;
      item.vx = side * (1.9 + rng() * 1.0);
      item.vy = 2.6 + rng() * 1.0;
      item.vz = 0.7 + rng() * 0.9;

      item.angle = rng() * Math.PI * 2;
      item.spin = (3 + rng() * 7) * (rng() < 0.5 ? -1 : 1);
      item.ax = rng() - 0.5;
      item.ay = (rng() - 0.5) * 0.4;
      item.az = rng() - 0.5;
      item.age = 0;

      this.active += 1;
      spawned += 1;
    }
    this.launched += spawned;
    if (this.active > 0) this.mesh.visible = true;
    return spawned;
  }

  /** 每帧推进（挂在 `Game.update`，与演出同一节奏）。 */
  update(delta: number): void {
    if (this.active === 0) return;
    // 切后台回来时 `delta` 可能是几秒 —— 钳一下，否则一步就跳出回收边界。
    const dt = Math.min(delta, 1 / 20);
    const outsideX = TABLE.halfWidth + TABLE.railThickness;

    let write = 0;
    for (const item of this.items) {
      if (!item.live) continue;

      item.age += dt;
      item.vy += PHYSICS.gravity * dt;
      item.x += item.vx * dt;
      item.y += item.vy * dt;
      item.z += item.vz * dt;
      item.angle += item.spin * dt;

      if (
        item.age > MAX_AGE ||
        item.y < KILL.y ||
        Math.abs(item.x) > KILL.absX ||
        item.z < KILL.zMin ||
        item.z > KILL.zMax
      ) {
        item.live = false;
        this.active -= 1;
        continue;
      }

      if (Math.abs(item.x) > outsideX) {
        this.peakYOutside = Math.max(this.peakYOutside, item.y);
      }

      this.position.set(item.x, item.y, item.z);
      this.axis.set(item.ax, item.ay, item.az).normalize();
      this.quaternion.setFromAxisAngle(this.axis, item.angle);
      this.matrix.compose(this.position, this.quaternion, this.unitScale);
      this.mesh.setMatrixAt(write, this.matrix);
      write += 1;
    }

    this.mesh.count = write;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.visible = write > 0;
  }

  /**
   * 换币纹外观。**必须与 `CoinPool.applyCoinSkin` 同步调用**，
   * 否则飞出去的币还是旧外观 —— 这种「一半新一半旧」在截图里很难发现。
   */
  setSkin(skin: CoinSkin): void {
    const previous = this.material;
    const next = createCoinMaterial('bronze', skin);
    this.material = next;
    this.mesh.material = next;
    previous.map?.dispose();
    previous.dispose();
  }

  /** 清空所有在飞的币（开局 / 收工）。 */
  clear(): void {
    for (const item of this.items) item.live = false;
    this.active = 0;
    this.mesh.count = 0;
    this.mesh.visible = false;
  }

  /** 清空统计（判据在每次演出前调一次）。 */
  resetStats(): void {
    this.launched = 0;
    this.peakYOutside = -Infinity;
  }

  /**
   * 验证读数（`verify-game.mjs` 的 `spray` 判据消费）。
   *
   * `peakYOutside` 是**这条通道存在意义的唯一硬证据**：它记录「币在侧壁外沿之外
   * 达到过的最高点」。如果它 < `GLASS_TOP`（1.6），说明币是**穿过玻璃围板**
   * 飞出去的 —— 那是穿模，不是溢出。
   */
  report(): {
    active: number;
    capacity: number;
    visible: boolean;
    launched: number;
    peakYOutside: number;
    /** 机柜侧壁的外沿（米），判据拿它当「机内 / 机外」的分界。 */
    outsideX: number;
  } {
    return {
      active: this.active,
      capacity: CAPACITY,
      visible: this.mesh.visible,
      launched: this.launched,
      peakYOutside: Number.isFinite(this.peakYOutside) ? this.peakYOutside : 0,
      outsideX: TABLE.halfWidth + TABLE.railThickness,
    };
  }

  /** 材质（验证脚本要核它和铜币材质同 defines）。 */
  get currentMaterial(): THREE.MeshToonMaterial {
    return this.material;
  }

  /** 几何体的圆柱参数（验证脚本核「与币池同真源」）。 */
  get coinGeometry(): THREE.BufferGeometry {
    return this.geometry;
  }

  dispose(): void {
    this.group.clear();
    this.geometry.dispose();
    this.material.map?.dispose();
    this.material.dispose();
    this.items.length = 0;
    this.active = 0;
  }
}

/** 溢流口的默认位置（米）：**玻璃顶沿（1.6）与顶盖视觉件（1.66）之上**。 */
export const SPILL_ORIFICE = {
  x: 0,
  y: 1.78,
  z: TABLE.backZ + 0.3,
} as const;

/** 溢流口的观感尺寸（米）——比一枚币略宽，读得出「筹码是从这里涌出来的」。 */
export const SPILL_ORIFICE_SIZE = {
  width: COIN.radius * 4,
  height: COIN.radius * 0.9,
  depth: COIN.radius * 2.2,
} as const;
