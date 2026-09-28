import * as THREE from 'three';
import * as RAPIER from '@dimforge/rapier3d-compat';
import { COIN, COIN_KINDS, TABLE, type CoinKind } from '../game/constants';
import { isOnDeckVolume } from '../game/layout';
import { COIN_SKINS, type CoinSkin } from '../game/cosmetics';
import { coinTexels, createCoinMaterial, getCoinTexelScale } from '../utils/coinTexture';
import { coinModelGeometry, disposeCoinModelGeometries, isCoinModelKind } from './coinModels';
import { Coin, type CoinRenderHooks } from './Coin';

/** 渲染分组顺序 = 币种清单（单一真源：`kinds.ts`），不再从 `COIN_KIND` 反推。 */
const KINDS = COIN_KINDS;

/**
 * 普通币的圆柱几何。
 *
 * ★ S16 抽出来给**两个**消费者用：`CoinPool` 的六个 `InstancedMesh`，
 * 以及 `CoinSpray`（喷泉溢出的纯视觉币）。
 *
 * 抽出来的理由是「不写第二份」：半径 / 厚度 / **分段数**三件东西一旦写成两份，
 * 改一份就会让视觉币看起来像「另一种币」——而这种偏差在截图里只表现为
 * 「飞出去的币好像小一点点」，肉眼基本判不了。
 *
 * 每次调用返回**新的**几何体（每个持有者各自 dispose），不是模块级共享实例：
 * `CoinPool.dispose()` 会释放自己那份，共享的话第二个持有者会拿到已释放的几何体
 * （three 不报错，只是渲染出空 —— 零报错的静默失效）。
 */
export function createCoinCylinderGeometry(): THREE.BufferGeometry {
  return new THREE.CylinderGeometry(COIN.radius, COIN.radius, COIN.halfThickness * 2, 18, 1);
}

interface RenderGroup {
  mesh: THREE.InstancedMesh;
  /**
   * owners[i] = 当前渲染在实例槽 i 上的币。活跃实例**压实**在数组前段，
   * mesh.count 始终等于 owners.length——不画空槽，也不需要缩放零矩阵藏尸。
   */
  owners: Coin[];
}

/**
 * 币对象池。活跃币总数有硬预算，超出预算时拒绝发币而不是静默删除有分值的币。
 *
 * P3 起渲染改为 6 组 InstancedMesh（按币种分组）。P6 起**几何体按币种路由**：
 * `bronze / pattern / payout / bounty` 共用一份圆柱几何，
 * `diamond / chest` 各用一份低多面体模型几何（S15）。
 *
 * 路由的代价是**零 draw call**：一个币种本来就占一个 `InstancedMesh`，
 * 换几何体不改变组的数量。反过来，如果按「几何体」而不是「币种」分组，
 * 就会多出两个 draw call —— 而硬上限只剩 6 个名额。
 *
 * Coin 只持 (组, 实例下标) 引用；入组/换槽/出组全部收在这个文件里，
 * 外部不再能碰到逐枚的 Mesh。
 */
export class CoinPool implements CoinRenderHooks {
  readonly group = new THREE.Group();
  readonly coins: Coin[] = [];
  private cursor = 0;
  /**
   * 普通币共用的圆柱几何。
   *
   * ⚠️ 这个几何体**不是**「所有币的几何体」——模型币种有自己的那一份
   * （见 `geometryFor`）。把两者混起来的写法会让 `dispose()` 把模型几何
   * 也当成共享资源处理，或者反过来漏掉释放。
   */
  private readonly geometry: THREE.BufferGeometry;
  private readonly materials: Record<CoinKind, THREE.MeshToonMaterial>;
  private readonly groups: Record<CoinKind, RenderGroup>;
  private skin: CoinSkin;

  constructor(world: RAPIER.World, budget = COIN.budget) {
    this.geometry = createCoinCylinderGeometry();
    this.skin = COIN_SKINS[0];
    // 材质表按 `COIN_KINDS` 遍历生成（P6）：币种清单只有 kinds.ts 一份，
    // 新增币种不需要回来补这一行。
    this.materials = Object.fromEntries(
      COIN_KINDS.map((kind) => [kind, createCoinMaterial(kind, this.skin)]),
    ) as Record<CoinKind, THREE.MeshToonMaterial>;
    this.groups = {} as Record<CoinKind, RenderGroup>;
    for (const kind of KINDS) {
      // 容量给满预算：极端情况下全场都是同一币种，任何组都不允许溢出。
      const mesh = new THREE.InstancedMesh(this.geometryFor(kind), this.materials[kind], budget);
      mesh.count = 0;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      // 实例每帧满场移动，自动包围球算不准，整组关掉视锥裁剪。
      mesh.frustumCulled = false;
      this.groups[kind] = { mesh, owners: [] };
      this.group.add(mesh);
    }
    for (let i = 0; i < budget; i += 1) {
      this.coins.push(new Coin(world, this));
    }
  }

  /**
   * 逐币种几何体路由。
   *
   * 模型币种走 `coinModels` 的**缓存**几何体（缓存是必须的：碰撞体规格也是从
   * 同一份几何体的 AABB 反算的，见 `coinColliderSpec`）。
   */
  private geometryFor(kind: CoinKind): THREE.BufferGeometry {
    return isCoinModelKind(kind) ? coinModelGeometry(kind) : this.geometry;
  }

  /** CoinRenderHooks：spawn 时按 kind 入组，槽位 = 组尾。 */
  attach(coin: Coin, kind: CoinKind): void {
    const group = this.groups[kind];
    coin.renderMesh = group.mesh;
    coin.renderIndex = group.owners.length;
    group.owners.push(coin);
    group.mesh.count = group.owners.length;
    // 立刻写一次矩阵：spawn 到下一次 syncAll 之间不允许有一帧残影。
    coin.sync();
    group.mesh.instanceMatrix.needsUpdate = true;
  }

  /** CoinRenderHooks：swap-remove——组尾币补进空槽，保持活跃实例压实在前。 */
  detach(coin: Coin): void {
    const group = this.groups[coin.kind];
    if (!group || coin.renderMesh !== group.mesh) return;
    const index = coin.renderIndex;
    const last = group.owners.length - 1;
    const moved = group.owners[last];
    group.owners.pop();
    if (index !== last) {
      group.owners[index] = moved;
      moved.renderIndex = index;
      // 被换位的币立刻把矩阵补写到空出的槽位。
      moved.sync();
    }
    coin.renderMesh = null;
    coin.renderIndex = -1;
    group.mesh.count = group.owners.length;
    group.mesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * 换币纹外观。只替换材质贴图与金属度，不动物理与分值。
   * 旧材质要显式 dispose，否则重复换装会漏纹理。
   *
   * `force` 用来绕过「同 id 直接返回」的短路：**币面分辨率倍率变化时外观 id 没变**，
   * 但贴图必须重建。没有这个开关的话，调参面板把倍率从 1× 拉到 4× 会一点反应都没有
   * ——而调用方看起来「明明调了 `applyCoinSkin`」。
   */
  applyCoinSkin(skin: CoinSkin, force = false): void {
    if (!force && skin.id === this.skin.id) return;
    this.skin = skin;
    for (const kind of KINDS) {
      const previous = this.materials[kind];
      const next = createCoinMaterial(kind, skin);
      this.materials[kind] = next;
      this.groups[kind].mesh.material = next;
      previous.map?.dispose();
      previous.dispose();
    }
  }

  /** 画质分档：按组开关投影（实例化之后不再有逐枚的 Mesh 可设）。 */
  setCastShadow(enabled: boolean): void {
    for (const kind of KINDS) this.groups[kind].mesh.castShadow = enabled;
  }

  get currentSkin(): CoinSkin {
    return this.skin;
  }

  /**
   * 取某个币种当前在用的材质。
   *
   * 存在的理由（S16）：`CoinSpray` 的视觉币要和铜币**共用同一份着色器程序**，
   * 判据得能拿到两边的材质来比 `defines`。让判据去 `groups[kind].mesh.material` 里摸
   * 也不是不行，但那是**内部结构**；这里给一个明确的读取口，
   * 以后 `groups` 的结构变了判据不用跟着改。
   */
  materialFor(kind: CoinKind): THREE.MeshToonMaterial {
    return this.materials[kind];
  }

  /**
   * V4 判据：币面贴图的**实际纹素**与采样设置。
   *
   * 为什么需要它：币的颜色链路有四层（调色板 → canvas 逐纹素 → 色带 → ACES），
   * 任何一层出错在截图里都只表现为「颜色不太对」，靠肉眼反推要来回试很多轮。
   * 直接读纹素就能把「贴图本身对不对」与「渲染对不对」一刀切开。
   *
   * `center` 取贴图正中心（有字形时是字色，无字形时是底面），
   * `quarter` 取 1/4 处（纹样/颗粒区）。
   */
  coinReport(): Record<string, Record<string, unknown>> {
    const out: Record<string, Record<string, unknown>> = {};
    for (const kind of KINDS) {
      const map = this.materials[kind].map;
      const canvas = map?.image as HTMLCanvasElement | undefined;
      const ctx = canvas?.getContext('2d') ?? null;
      let center = '';
      let quarter = '';
      if (canvas && ctx) {
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        const at = (x: number, y: number): string => {
          const offset = (y * canvas.width + x) * 4;
          return `#${[data[offset], data[offset + 1], data[offset + 2]]
            .map((value) => value.toString(16).padStart(2, '0'))
            .join('')}`;
        };
        center = at(canvas.width >> 1, canvas.height >> 1);
        quarter = at(canvas.width >> 2, canvas.height >> 1);
      }
      out[kind] = {
        texels: canvas?.width ?? 0,
        // ★ 引擎自报的**期望值**：判据拿它和 `texels` 比，就不用在脚本里
        // 手写「铜币 16 / 字形 32」第二份公式 —— 分辨率倍率是可调的，
        // 抄一份到测试里，加旋钮的那天判据就会开始骗人。
        expected: coinTexels(kind),
        texelScale: getCoinTexelScale(),
        mag: map?.magFilter === THREE.NearestFilter ? 'nearest' : 'other',
        min: map?.minFilter === THREE.NearestMipmapNearestFilter ? 'mip-nearest' : 'other',
        mipmaps: map?.generateMipmaps ?? false,
        anisotropy: map?.anisotropy ?? 0,
        center,
        quarter,
      };
    }
    return out;
  }

  /** 取一枚空闲币。预算耗尽时返回 null。 */
  acquire(): Coin | null {
    for (let i = 0; i < this.coins.length; i += 1) {
      const index = (this.cursor + i) % this.coins.length;
      const coin = this.coins[index];
      if (!coin.active) {
        this.cursor = (index + 1) % this.coins.length;
        return coin;
      }
    }
    return null;
  }

  /**
   * 还能再发几枚币。
   *
   * 盘面满盘化之后预算变得吃紧（P2 预置 310 枚，还要给玩家投币与机关注入留余量，
   * 所以 `COIN.budget` 抬到了 500）。机关要注入新币，必须先问一句够不够——
   * 池满时 `acquire()` 返回 null，而调用方（`Game.tryDrop`）以前是**静默失败**：
   * 不扣额度、不提示，玩家只看到「按了没反应」。
   */
  get remaining(): number {
    return this.coins.reduce((count, coin) => count + (coin.active ? 0 : 1), 0);
  }

  releaseAll(): void {
    for (const coin of this.coins) coin.despawn();
    this.cursor = 0;
  }

  syncAll(): void {
    for (const coin of this.coins) coin.sync();
    for (const kind of KINDS) {
      const { mesh } = this.groups[kind];
      if (mesh.count > 0) mesh.instanceMatrix.needsUpdate = true;
    }
  }

  activeCount(): number {
    let count = 0;
    for (const coin of this.coins) if (coin.active) count += 1;
    return count;
  }

  /**
   * 币床上还坐着多少枚币（P10 自动补币的判定口径，见 `REFILL`）。
   *
   * ## 口径：**「不在台面上」就是「在币床上」**
   *
   * S13 之前这里是「币心低于 `TABLE.channel.registerY`（0.13）且在得分线内」。
   * 那条高度判据在币塔只有 5 层时勉强够用，但**塔一高就失效**：
   * 塔顶盖到 9 层（`y` 到 0.216）时，塔上有 24 枚币根本读不到，
   * 于是「盘面还有没有币」这个口径**系统性偏低 24 枚** ——
   * 而 `REFILL.bedThreshold = 180`，这个偏差足以让补币在盘面还很满的时候触发。
   *
   * 现在改成 `layout.isOnDeckVolume` 的补集（与 `Game.isOnDeck()` 同一份判据）：
   * 台面是一个**体积**（高度 + z 区间），台面之外的活跃币都算币床 ——
   * 塔上的币、正在下落的币、贴在地板上的币，一律照算。这正是「币床库存」的语义。
   *
   * 后半个条件（得分线）是防御性的：越线的币在 `processOutcomes` 里当帧就被 `despawn`，
   * 但补币盘点可能与那一帧错开，把「已经越线、还没结算」的币算进盘面会高估占用度。
   *
   * ★ **为什么不复用 `activeCount()`**：那个是「整个币池里活跃的币」，
   * 含正在下落的、演出排队还没落的、以及上层台面上的。盘面已经被掏空时它依然是三位数，
   * 拿它当补币输入的话，补币条件永远不成立——一个**零报错的静默失效**
   * （判据会写成「补币没触发」而真实原因是「口径选错了」）。
   *
   * `range` 由调用方给（`Game` 传 `pusher.topRange`）：台面体积随推板行程移动，
   * 这里拿不到推板，也不该去拿 —— 币池不该知道推板。
   */
  countBed(range: { back: number; front: number }): number {
    let count = 0;
    for (const coin of this.coins) {
      if (!coin.active) continue;
      const p = coin.position;
      if (p.z >= TABLE.scoreLineZ) continue;
      if (isOnDeckVolume(p.x, p.y, p.z, range)) continue;
      count += 1;
    }
    return count;
  }

  /** 遍历活跃币，回调返回 true 表示该币应在遍历后停用。 */
  forEachActive(visit: (coin: Coin) => boolean | void): void {
    for (const coin of this.coins) {
      if (!coin.active) continue;
      if (visit(coin) === true) coin.despawn();
    }
  }

  dispose(): void {
    this.group.clear();
    this.coins.length = 0;
    for (const kind of KINDS) {
      this.groups[kind].mesh.dispose();
      this.groups[kind].owners.length = 0;
    }
    this.geometry.dispose();
    // 模型几何体是模块级缓存（渲染与碰撞体共用），所以由 `coinModels` 统一释放，
    // 不能在循环里逐组 dispose —— 那样第二组会 dispose 到同一份已释放的几何体。
    disposeCoinModelGeometries();
    for (const material of Object.values(this.materials)) {
      material.map?.dispose();
      material.dispose();
    }
  }
}
