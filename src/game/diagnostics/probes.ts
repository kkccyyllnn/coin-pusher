/**
 * 探针只读工具（S3，从 `Game.ts` 机械搬出）。
 *
 * ⚠️ 一律通过 `ProbeHost` 的**闭包**读引擎状态、不存值：搬移最容易造的假绿就是"把字段拷进袋子"
 *   —— 那样读到的是构造期快照，画面与判据会各看一份数。闭包 ⇒ 每次调用都走 `Game` 的当下字段。
 */
import * as THREE from 'three';
import { COIN } from '../constants';
import { RAPIER, type PhysicsWorld } from '../../systems/PhysicsWorld';
import type { CoinPool } from '../../entities/CoinPool';
import { round1, round3 } from '../../utils/numeric';

export interface ProbeHost {
  physics(): PhysicsWorld;
  coins(): CoinPool;
  tableGroup(): THREE.Group | null;
}

/** 调试用：列出指定点附近的碰撞体实际世界位置。 */
export function probeColliders(host: ProbeHost, x: number, y: number, z: number): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const radius = 0.6;
  host.physics().world.colliders.forEach((collider) => {
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
export function sampleCoins(host: ProbeHost, ): Array<{
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
  preset: boolean;
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
    preset: boolean;
  }> = [];
  host.coins().coins.forEach((coin, slot) => {
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
      preset: coin.preset,
    });
  });
  return out;
}

/** 竖直向下打一条射线，报告第一个命中的碰撞体（诊断币堆穿模用）。 */
export function castDown(host: ProbeHost, 
  x: number,
  y: number,
  z: number,
): { distance: number; hitY: number; shapeType: number; isSensor: boolean } | null {
  const ray = new RAPIER.Ray({ x, y, z }, { x: 0, y: -1, z: 0 });
  const hit = host.physics().world.castRay(ray, 5, true);
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
export function probeMeshes(host: ProbeHost, ): Array<Record<string, unknown>> {
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

  host.tableGroup()?.traverse((child) => {
    const role = (child.userData as { role?: string }).role;
    if (role === 'floor' && (child as THREE.Mesh).isMesh) record('floor', child);
    if (role === 'pusherTop' && (child as THREE.Mesh).isMesh) record('pusherTop', child);
  });

  // 最低的三枚活跃币：渲染位置与物理位置一起报
  const active = host.coins().coins
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
export function penetrationReport(host: ProbeHost, limitMillimeters: number): {
  coinContacts: number;
  staticContacts: number;
  coinDeepest: number;
  staticDeepest: number;
  overLimit: number;
  worst: Array<{ depth: number; pair: string; at: [number, number, number] }>;
} {
  const world = host.physics().world;
  const limit = limitMillimeters / 1000;
  const seen = new Set<string>();
  const worst: Array<{ depth: number; pair: string; at: [number, number, number] }> = [];
  let coinContacts = 0;
  let staticContacts = 0;
  let coinDeepest = 0;
  let staticDeepest = 0;
  let overLimit = 0;

  host.coins().coins.forEach((coin, slot) => {
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
