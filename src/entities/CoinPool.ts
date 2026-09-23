import * as THREE from 'three';
import * as RAPIER from '@dimforge/rapier3d-compat';
import { COIN, COIN_KIND, type CoinKind } from '../game/constants';
import { COIN_SKINS, type CoinSkin } from '../game/cosmetics';
import { createCoinMaterial } from '../utils/coinTexture';
import { Coin, type CoinRenderHooks } from './Coin';

const KINDS = Object.keys(COIN_KIND) as CoinKind[];

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
 * P3 起渲染改为 4 组 InstancedMesh（按币种分组，共享一份圆柱几何）。
 * Coin 只持 (组, 实例下标) 引用；入组/换槽/出组全部收在这个文件里，
 * 外部不再能碰到逐枚的 Mesh。
 */
export class CoinPool implements CoinRenderHooks {
  readonly group = new THREE.Group();
  readonly coins: Coin[] = [];
  private cursor = 0;
  private readonly geometry: THREE.BufferGeometry;
  private readonly materials: Record<CoinKind, THREE.MeshStandardMaterial>;
  private readonly groups: Record<CoinKind, RenderGroup>;
  private skin: CoinSkin;

  constructor(world: RAPIER.World, budget = COIN.budget) {
    this.geometry = new THREE.CylinderGeometry(COIN.radius, COIN.radius, COIN.halfThickness * 2, 18, 1);
    this.skin = COIN_SKINS[0];
    this.materials = {
      bronze: createCoinMaterial('bronze', this.skin),
      pattern: createCoinMaterial('pattern', this.skin),
      payout: createCoinMaterial('payout', this.skin),
      bounty: createCoinMaterial('bounty', this.skin),
    };
    this.groups = {} as Record<CoinKind, RenderGroup>;
    for (const kind of KINDS) {
      // 容量给满预算：极端情况下全场都是同一币种，任何组都不允许溢出。
      const mesh = new THREE.InstancedMesh(this.geometry, this.materials[kind], budget);
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
   */
  applyCoinSkin(skin: CoinSkin): void {
    if (skin.id === this.skin.id) return;
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
    for (const material of Object.values(this.materials)) {
      material.map?.dispose();
      material.dispose();
    }
  }
}
