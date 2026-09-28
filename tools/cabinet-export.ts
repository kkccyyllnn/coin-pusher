/**
 * 机柜 → OBJ 导出（S17 工具，给 Blender 用）。
 *
 * ## 为什么必须走 Vite
 *
 * `page.evaluate` 里的 `import('three')` **解析不了 bare specifier**（浏览器不认识
 * node_modules 的布局），所以这里写成 `.ts` 交给 Vite 编译，探针用
 * `import('/tools/cabinet-export.ts')` 引它。做法与 `PLAN-v4.md` §13.8 记的那几个
 * 临时工具完全一致。
 *
 * ## 为什么是「重新建一份」而不是「抓现场场景」
 *
 * 现场场景里有 300+ 枚币、正在跑的演出装置、纯视觉币通道 —— 全都会被导出去。
 * 这里用一个**一次性 RAPIER world** 把机台重新建一遍：`buildTable()`、
 * `Pusher` 与 `SlotMachine` 的构造函数都**只建网格 + 碰撞体、没有副作用**，
 * 所以拿到的是「归位状态、零币、零演出」的干净整机。
 *
 * ## ★ 坑：`OBJExporter` 不展开 `instanceMatrix`
 *
 * 钉阵（22 根）与 XIXI 标牌（4 块）是 `InstancedMesh`。`OBJExporter.parseMesh`
 * 只做 `vertex.applyMatrix4( mesh.matrixWorld )`（`OBJExporter.js:82`），
 * **完全不看 `instanceMatrix`** —— 于是那 26 件会被导出成「一份几何摆在原点」，
 * 在 Blender 里表现为「22 根钉叠在一起」，而导出的包围盒看起来又是对的
 * （因为 `matrixWorld` 是单位阵，盒子只是小得离谱）。**零报错的静默错**。
 *
 * 所以导出前先 `bakeInstanced()`：把每个实例分解成独立的 `Mesh`。
 * 分解用的是 `Matrix4.decompose`，`position / quaternion / scale` 三件都带上，
 * 所以钉阵那根绕 x 转 90° 的朝向也保得住。
 *
 * ## 坐标与单位
 *
 * 世界坐标，**单位米**，y 轴朝上，+z 朝向玩家。
 *
 * ## 命名（S19：改用 `userData.part`）
 *
 * 件名优先取 `mesh.userData.part`（**身份**），同名的多件追加序号；没有 `part` 的件
 * 退回材质名。OBJ 的 `usemtl` 行仍会带上材质名，所以色带信息也没丢。
 *
 * ★ 为什么必须从材质名换过来：材质名回答的是「刷哪个色带」，不是「这是哪一件」。
 * 共用一份材质的件会被同名 —— S18 的顶板 / 檐板 / 招牌共用 `trimMaterial`，
 * 导出后就是 `trim#0` / `trim#1` / `trim#2`，在 Blender 里完全分不出哪块是哪块。
 * `part` 是 `TableBuilder` / `Pusher` / `SlotMachine` 显式挂上去的身份
 * （`src/game/cabinetShape.ts` 的 `CabinetPart`）。
 *
 * 配套的 `cabinet-parts.txt` 列出「名字 → 世界位置 / 包围盒尺寸 / 层」，
 * 用来在 Blender 里认件。`layer` 见 `PartLayer`。
 */
import * as THREE from 'three';
import * as RAPIER from '@dimforge/rapier3d-compat';
import { OBJExporter } from 'three/addons/exporters/OBJExporter.js';
import { buildTable } from '../src/systems/TableBuilder';
import { Pusher } from '../src/entities/Pusher';
import { SlotMachine } from '../src/systems/SlotMachine';

/**
 * 件与物理的关系。
 *
 * - `physics`：这件上有**一条面与手写碰撞体的表面同面**，动它就会让「看得见的墙」
 *   与「币撞到的墙」分家。在 C4D 里改这些件等于改物理接口。
 * - `visual`：纯外观，改尺寸只影响画面。
 *
 * ⚠️ 这不是「有没有碰撞体」：机柜外壳**一件碰撞体都没有**，但侧墙 / 背板的内表面
 * 被碰撞体钉住了，所以它们属于 `physics`。
 */
export type PartLayer = 'physics' | 'visual';

/**
 * 哪些件上有「与碰撞体同面」的表面。
 *
 * 判据是「谁的某个平面是物理接口」，不是「谁有碰撞体」：
 *   - `sideWall.*` —— 内表面 `x = ±TABLE.halfWidth`（侧壁碰撞体内表面）；
 *   - `backPanel`  —— 前表面 `z = TABLE.backZ`（后墙碰撞体内表面）；
 *   - `floor`      —— 上表面 `y = TABLE.floorY`；
 *   - `peg`        —— 圆柱与钉子碰撞体同源；
 *   - `pusherFace` / `pusherTop` —— 推板碰撞体。
 *
 * 其余（顶板 / 檐板 / 托盘 / 压条 / 导槽 / 老虎机 / XIXI 标牌）是纯外观。
 * S21 之后没有招牌这一件了（檐板承担招牌画布）。
 */
const PHYSICS_PARTS = new Set<string>([
  'floor',
  'sideWall.tall.L',
  'sideWall.tall.R',
  'sideWall.low.L',
  'sideWall.low.R',
  'backPanel',
  'peg',
  'pusherFace',
  'pusherTop',
]);

const layerOf = (part: string | null): PartLayer =>
  part !== null && PHYSICS_PARTS.has(part) ? 'physics' : 'visual';

export type CabinetExportPart = {
  /** 件名（OBJ 的 `o` 名 / Blender 的对象名）。实例集写作 `peg ×22`。 */
  name: string;
  /** 身份（`userData.part`）。没有挂 `part` 的件（比如纯几何占位）为 `null`。 */
  part: string | null;
  /** 与物理的关系。见 `PartLayer`。 */
  layer: PartLayer;
  material: string;
  /** 该件贡献的三角形数（实例集按**一份**几何算）。 */
  triangles: number;
  /** 实例数（非 `InstancedMesh` 为 1）。 */
  instances: number;
  /** 世界包围盒中心与尺寸（米）。实例集取**并集**。 */
  center: [number, number, number];
  size: [number, number, number];
};

export type CabinetExport = {
  /** OBJ 全文。 */
  obj: string;
  parts: CabinetExportPart[];
  /** 整机包围盒（米）。 */
  bounds: { min: [number, number, number]; max: [number, number, number] };
  triangles: number;
};

const round = (value: number): number => Math.round(value * 1e4) / 1e4;
const isMesh = (object: THREE.Object3D): object is THREE.Mesh => (object as THREE.Mesh).isMesh === true;

/**
 * 把 `InstancedMesh` 展开成一组普通 `Mesh`。
 *
 * 不改几何、不合并、不动父子关系之外的东西；新网格**共用同一份 geometry**
 * （所以内存不涨），只是各自带一个从 `instanceMatrix` 分解出来的变换。
 */
function bakeInstanced(root: THREE.Object3D): number {
  const jobs: Array<{ parent: THREE.Object3D; instanced: THREE.InstancedMesh; meshes: THREE.Mesh[] }> = [];

  root.traverse((child) => {
    const instanced = child as THREE.InstancedMesh;
    if (instanced.isInstancedMesh !== true || !instanced.parent) return;
    const material = instanced.material;
    const matrix = new THREE.Matrix4();
    const meshes: THREE.Mesh[] = [];
    for (let i = 0; i < instanced.count; i += 1) {
      instanced.getMatrixAt(i, matrix);
      const mesh = new THREE.Mesh(instanced.geometry, material);
      matrix.decompose(mesh.position, mesh.quaternion, mesh.scale);
      mesh.castShadow = instanced.castShadow;
      mesh.receiveShadow = instanced.receiveShadow;
      mesh.userData.role = instanced.userData.role;
      // `part` 也要跟着走：展开后这些网格虽然靠父级名字进了 OBJ，
      // 但任何**之后**读 `userData.part` 的代码（报告 / 判据 / 将来的工具）
      // 在展开过的树上会一律读到 `undefined` —— 那是与 `role` 一样的信息丢失。
      mesh.userData.part = instanced.userData.part;
      meshes.push(mesh);
    }
    jobs.push({ parent: instanced.parent, instanced, meshes });
  });

  for (const { parent, instanced, meshes } of jobs) {
    // 实例网格自身可能带变换（这里钉阵与标牌都是单位阵，但不假定）。
    const holder = new THREE.Group();
    holder.position.copy(instanced.position);
    holder.quaternion.copy(instanced.quaternion);
    holder.scale.copy(instanced.scale);
    holder.name = instanced.name;
    for (const mesh of meshes) holder.add(mesh);
    parent.add(holder);
    parent.remove(instanced);
  }

  return jobs.reduce((total, job) => total + job.meshes.length, 0);
}

/**
 * 建一份「归位状态」的整机并导出为 OBJ。
 *
 * 包含：地面 / 洞口格栅 / 两侧护栏 / 22 根钉 / 得分线 / 热区条 / 出币托盘 /
 * 前立面挡板 / 落币导槽 / 机柜外壳 / 推板（归位）/ 老虎机。
 *
 * **不包含**演出装置（闸门 / 喷泉 / 溢流口）—— 那些是 `ShowDirector` 在演出期间
 * 临时建、演出结束就拆的，不属于机柜本体。
 */
export async function buildCabinetObj(): Promise<CabinetExport> {
  // 游戏本身已经 init 过，这里再调一次是幂等的（模块级单例）。
  await RAPIER.init();
  const world = new RAPIER.World({ x: 0, y: -13, z: 0 });

  const table = buildTable(world);
  const pusher = new Pusher(world);
  // `SlotMachine` 的构造函数只调 `buildMeshes()`，`deps` 一个字段都不碰 ——
  // 所以给个空桩即可（不传会在 `buildMeshes` 之前就抛，那是另一回事）。
  const slot = new SlotMachine({} as unknown as ConstructorParameters<typeof SlotMachine>[0]);

  const root = new THREE.Group();
  root.name = 'coin-pusher';
  root.add(table.group);
  root.add(pusher.group);
  root.add(slot.group);
  root.updateMatrixWorld(true);

  // ── 命名：材质名 + 同名序号。实例集先用不带序号的名字（报告里再加 ×N）──
  const counters = new Map<string, number>();
  const named: THREE.Mesh[] = [];
  root.traverse((child) => {
    if (!isMesh(child)) return;
    const first = Array.isArray(child.material) ? child.material[0] : child.material;
    // ★ 件名优先取**身份**（`userData.part`），材质名只是后备。
    //   共用一份材质的件靠材质名会撞在一起（见文件头的「命名」一节）。
    const part = (child.userData.part as string | undefined) ?? null;
    const label = part || first?.name || 'part';
    const instanced = (child as THREE.InstancedMesh).isInstancedMesh === true;
    const index = counters.get(label) ?? 0;
    counters.set(label, index + 1);
    child.name = instanced ? label : `${label}#${index}`;
    named.push(child);
  });

  // ── 逐件读数（用几何包围盒 × matrixWorld，不依赖 `Box3.setFromObject`
  //    对 InstancedMesh 的处理方式；实例集取并集）──
  const parts: CabinetExportPart[] = [];
  const min = new THREE.Vector3(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
  const max = new THREE.Vector3(Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY);
  let triangles = 0;

  const instanceMatrix = new THREE.Matrix4();
  for (const mesh of named) {
    const geometry = mesh.geometry;
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    const local = geometry.boundingBox as THREE.Box3;
    const box = new THREE.Box3();
    const instanced = mesh as THREE.InstancedMesh;
    const count = instanced.isInstancedMesh === true ? instanced.count : 1;

    if (instanced.isInstancedMesh === true) {
      for (let i = 0; i < count; i += 1) {
        instanced.getMatrixAt(i, instanceMatrix);
        const world = instanceMatrix.clone().premultiply(mesh.matrixWorld);
        box.union(local.clone().applyMatrix4(world));
      }
    } else {
      box.copy(local).applyMatrix4(mesh.matrixWorld);
    }

    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const index = geometry.getIndex();
    const faces = (index ? index.count : geometry.getAttribute('position').count) / 3;

    const part = (mesh.userData.part as string | undefined) ?? null;
    parts.push({
      name: count > 1 ? `${mesh.name} ×${count}` : mesh.name,
      part,
      layer: layerOf(part),
      material: (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material)?.name ?? '',
      triangles: faces,
      instances: count,
      center: [round(center.x), round(center.y), round(center.z)],
      size: [round(size.x), round(size.y), round(size.z)],
    });
    min.min(box.min);
    max.max(box.max);
    // 实例集在 OBJ 里会展开成 N 份几何 —— 这里的 `triangles` 是**一份**，
    // 整机三角形数另按展开后的份数计。
    triangles += faces * count;
  }

  // ── 展开实例（见文件头那个坑），再命名一遍、导出 ──
  bakeInstanced(root);
  let bakedIndex = 0;
  root.traverse((child) => {
    if (!isMesh(child) || child.name !== '') return;
    const parent = child.parent;
    const label = parent?.name || 'part';
    child.name = `${label}#${bakedIndex}`;
    bakedIndex += 1;
  });
  root.updateMatrixWorld(true);

  const obj = new OBJExporter().parse(root);

  const header = [
    '# coin-pusher 机柜 —— 世界坐标，单位米，y 朝上，+z 朝玩家',
    '# 生成自 tools/cabinet-export.ts（每次改完 TableBuilder 的尺寸请重新导出）',
    '# 件名 = userData.part（身份）+ 同名序号；无 part 时退回材质名',
    '# 对照表见 cabinet-parts.txt（含 layer：physics = 有面与碰撞体同面 / visual = 纯外观）',
    '# 钉阵与 XIXI 标牌已从 InstancedMesh 展开成独立对象',
    '# 本文件不含演出装置（闸门 / 喷泉 / 溢流口），那些是演出期间临时建的',
    '',
  ].join('\n');

  return {
    obj: header + obj,
    parts,
    bounds: {
      min: [round(min.x), round(min.y), round(min.z)],
      max: [round(max.x), round(max.y), round(max.z)],
    },
    triangles,
  };
}
