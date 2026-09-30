import * as THREE from 'three';
import * as RAPIER from '@dimforge/rapier3d-compat';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { COLORS, DRAIN, TABLE } from '../game/constants';
import type { CabinetSkin } from '../game/cosmetics';
import {
  cabinetShape,
  chamferPolyline,
  partBevel,
  type CabinetPart,
  type CabinetShellPart,
  type WallPointId,
} from '../game/cabinetShape';
import { DETAIL_SURFACE, flatDetail, ROLE_DETAIL, ROLE_RAMP, ROLE_RIM } from '../game/artDirection';
import { isLitMaterial, makeToonMaterial, type LitMaterial } from '../render/ToonMaterial';
import {
  createArcaneHotZoneTexture,
  createArcaneScoreLineTexture,
} from '../render/cabinetTexture';
import { marqueeScreen } from '../render/marqueeScreen';
// `surfaceNormalMap` 的导入随 R2 的拉丝法线一起撤掉（机柜只要纯色）；
// 需要恢复时连同 :915 那段注释一起看，别只补导入。

/**
 * 机柜件的默认圆角半径（米）。
 *
 * 为什么是 0.015：机柜主体是 `MeshToonMaterial` + 程序化表面细节，
 * 硬 90° 边在俯视相机下会变成一条刺眼的亮线（法线在棱上突变，色带直接跳档）。
 * 半径取到 1.5 厘米时，圆角本身在 1280×720 上约占 2~3 个像素——足够让那条亮线
 * 散成一段渐变，又不会让「机柜」读起来像「肥皂」。
 *
 * ⚠️ `RoundedBoxGeometry` 会把半径**自动夹到 `min(w,h,d)/2`**，所以给薄板
 * （比如 0.06 米厚的侧板）传 0.015 是安全的，不会穿帮。
 */
const CORNER_RADIUS = 0.015;
/** 圆角分段数。2 段 = 每角两个 45° 面片，在 1.5 厘米的尺度上看不出折线。 */
const CORNER_SEGMENTS = 2;

/**
 * 按圆角参数建一个盒体几何。所有机柜件都走它，别各自写 `new RoundedBoxGeometry`。
 *
 * `segments` 是 S24 加的：机柜件的倒角分段数从 `cabinetShape.ts` 的
 * `CABINET.bevel` 逐件读进来（`?model` 面板可调）。`radius` 仍保留默认值，
 * 非机柜件（托盘 / 前立面压条）不必关心它。
 */
function roundedBox(
  width: number,
  height: number,
  depth: number,
  radius: number = CORNER_RADIUS,
  segments: number = CORNER_SEGMENTS,
): RoundedBoxGeometry {
  return new RoundedBoxGeometry(width, height, depth, segments, radius);
}

export type TableBuild = {
  group: THREE.Group;
  /**
   * 机柜外壳那一具（S24）。
   *
   * 单独交出来是因为 `?model` 模型模式要**整具拆掉重建**：外壳是唯一
   * 「参数改了就整体换掉」的部件（台面 / 钉子 / 推板都与碰撞体绑定，
   * 不许热改）。见 `disposeCabinetShell()` 与 `ModelMode.rebuild()`。
   */
  cabinetShell: THREE.Group;
  /** 钉子数量。 */
  pegCount: number;
  /** 钉子碰撞体半长（物理，全长圆柱）。 */
  pegColliderHalfLength: number;
  /** 钉子网格半长（纯显示，比碰撞体短）。 */
  pegVisualHalfLength: number;
  /** 热区高亮条：位置由 Game 每帧写入，这里只负责建出来。 */
  hotZoneStrip: THREE.Mesh;
  /**
   * 得分线的亮条材质（P10 ⑨）：连落时由 Game 脉冲它的 `emissiveIntensity`。
   *
   * 直接把**材质**交出去（而不是让 Game 去 `mesh.material` 里摸）有两个好处：
   * ① 类型是 `LitMaterial`，Game 不必写 `isLitMaterial` 守卫；
   * ② 判据能读到「脉冲到底改的是哪一份材质」——共用材质的静默错无处可藏。
   * 这与 `Pusher.lipMaterial` 是同一个做法。
   */
  scoreLineMaterial: LitMaterial;
  /** 热区亮条的材质：命中时爆闪（同一个做法）。 */
  hotZoneMaterial: LitMaterial;
  /**
   * 排水口**格栅**的材质（P10 ⑨）：币掉进洞时由 Game 脉冲它的 `emissiveIntensity`。
   *
   * ★ 洞口闪光**不另建网格**，直接点已经在那儿的格栅。
   * 一开始的做法是在洞里加两片发光板（`InstancedMesh`），实测多出一份已编译程序
   * ——「实例化 + 无贴图 + `SD_DETAIL_KIND=0`」这个 define 组合此前不存在，
   * 于是 21 > 20 撞了 `perf` 的防呆上限。而格栅本来就在洞里、本来就近黑，
   * 让它的自发光从 0 抬起来就是**最省**的「洞口闪光」：
   * 零新增 draw call、零新增材质、零新增程序，而且语义上更准
   * （发光的是洞本身，不是洞里的一块板）。
   *
   * ⚠️ 格栅网格**刻意不挂 `userData.role`**（只挂 `userData.part = 'drainGrate'`）：
   * 它的 albedo 是近黑，语义就是「一个洞」，不该被换肤改基色。
   * 顺带修掉一个静默缺陷：`TableRole` / `ROLE_COLOR` 里**没有** `drainGrate` 这一档，
   * 所以以前那个 `role = 'drainGrate'` 走的是 `Color.set(undefined)` ——
   * 一个不报错、也永远不生效的角色。这条反馈走 `emissiveIntensity`，与 role 无关。
   */
  drainGrateMaterial: LitMaterial;
};

const PEG_ROWS: Array<{ y: number; xs: number[] }> = [
  { y: 0.62, xs: [-0.65, -0.39, -0.13, 0.13, 0.39, 0.65] },
  { y: 0.8, xs: [-0.52, -0.26, 0, 0.26, 0.52] },
  { y: 0.98, xs: [-0.65, -0.39, -0.13, 0.13, 0.39, 0.65] },
  { y: 1.16, xs: [-0.52, -0.26, 0, 0.26, 0.52] },
];

const PEG_HALF_LENGTH = 0.15;
const PEG_RADIUS = 0.008;

/**
 * 钉阵的**显示**半长 = 碰撞体半长的 1/3（0.30 米 → 0.10 米）。
 *
 * 钉子是一根沿 z 轴伸出来的横杆，正对镜头看过去是一根长条。钉子太长时，整片钉阵
 * 在画面上会压成一排排长斜杠，把台面和币床的注意力抢走，所以显示长度砍到 1/3。
 *
 * **碰撞体不动**：物理仍然是 PEG_HALF_LENGTH 的全长圆柱。缩短量对钉子中心对称，
 * 所以可见段是 z ∈ [drop.z - 0.05, drop.z + 0.05]，恰好覆盖落币的 z 抖动范围
 * （TABLE.drop.jitterZ = 0.05）——币永远落在看得见的那一段上，不会出现
 * 「撞到一根看不见的钉子」。
 *
 * 调整这个值时不要小于 TABLE.drop.jitterZ，否则落币会落在可见段之外。
 */
const PEG_VISUAL_HALF_LENGTH = PEG_HALF_LENGTH / 3;

/**
 * 场地（地板 / 钉阵 / 侧墙 / 围板）的**后界 z**。
 *
 * ★ 挂在 `TABLE.backZ` —— 也就是**可见背板平面 / 后墙碰撞体内表面**。
 *
 * 这条本来就有（S13 起后墙碰撞体放在 `TABLE.backZ`），S23 只是把它写清楚：
 * 场地后界 = **可见背板平面**，因为再往后的东西玩家看不见，而推板后缘之后的空档
 * （S23 之前有 1 米多）只有地板铺满才不会让币掉出机柜。
 *
 * ⚠️ 不要改成 `TABLE.pusherBackZ`：S23 之前两者都挂在推板后缘上只是「碰巧没事」
 * （那时推板后缘 −2.35 远在背板之后，挂哪个都只影响看不见的地方）。
 * 一旦推板后缘前收，地板与侧墙的后缘就会跟着前收，把背板与推板之间那条空档
 * 变成**没有地板也没有围板**的缺口 —— 掉进去的币直接落出机柜（`anomalies` 暴涨）。
 * （S23 最终没有前收推板后缘，但这条纪律留着：两者的语义本来就不一样。）
 */
const FIELD_BACK = TABLE.backZ;
const FIELD_DEPTH = TABLE.scoreLineZ - FIELD_BACK;
const FIELD_CENTER_Z = (TABLE.scoreLineZ + FIELD_BACK) / 2;

/**
 * 地板网格的**前缘 z**（比得分线再往前 4 厘米）。
 *
 * 为什么不是刚好停在得分线：排水洞的上界就是得分线（见 `DRAIN.zMax` 的推导），
 * 若地板剪影也停在同一条线上，**洞的外沿会与剪影边界重合**——
 * `Shape` 的孔洞允许内切于边界，三角化会退化成一条缝，渲染出来是破面。
 * 留 4 厘米余量就有干净的实体边。多出来的这 4 厘米在得分线之外，
 * 而越线的币当帧就被回收了，所以那里永远不会有币。
 */
const FLOOR_FRONT_Z = TABLE.scoreLineZ + 0.04;

/**
 * 得分线亮条的自发光基线与脉冲峰值（P10 ⑨）。
 *
 * 基线 0.35 是原本的观感值（改动它等于改「常态下得分线多亮」，属另一件事）；
 * 脉冲只把它临时抬到 1.85 再指数落回。**峰值取 1.85 而不是 3+**：
 * 得分线是横贯整个盘面的一条亮条，抬太高会盖过币床本身，
 * 而这条反馈要表达的是「线在跳」，不是「线在发光」。
 */
const SCORE_LINE_BASE_EMISSIVE = 0.35;
const SCORE_LINE_PULSE_EMISSIVE = 1.85;

/** 热区亮条的自发光基线与命中爆闪峰值。基线是原本的观感值。 */
const HOT_ZONE_BASE_EMISSIVE = 0.55;
const HOT_ZONE_FLASH_EMISSIVE = 2.6;

/**
 * 洞口闪光的峰值。
 *
 * 取 1.6 而不是更高：格栅离相机远、又在洞里，**亮度过高会把它读成「一块亮板」**
 * 而不是「洞里透出来的光」。它要的是「余光里看到洞口亮了一下」。
 */
const DRAIN_FLASH_EMISSIVE = 1.6;

/**
 * 币床两侧围板的上沿高度（米）。见护栏循环里那段注释。
 *
 * 取值依据是**实测的弹射高度**，不是观感：`anomalySamples` 抓到的最高现场是
 * `y = 5.7`（币在机外下落中）→ 反推发射顶点约 6 米。要完全挡住 6 米级的弹射，
 * 围板得做到 6 米高，既不现实也没必要——**围板的作用是让币回到床里，不是当屋顶**：
 * 币竖直上飞时不碰任何东西，落回时被围板拦住即可，所以只要挡到「币落回时可能飘出
 * 的横向范围」所对应的高度。实测弹射币的横向漂移很小（|vx| ≤ 2.1 米/秒），
 * 1.6 米足够覆盖下落全过程里向外漂的那一段，同时低于机柜顶沿（1.66 米的视觉带），
 * 不会与顶沿穿插。
 */
const GLASS_TOP = 1.6;

/**
 * 静态机台：地面、侧壁、钉阵、得分线、出币托盘。
 * 只建一次，整局复用；重置时不动这些刚体。
 */
export function buildTable(world: RAPIER.World): TableBuild {
  const group = new THREE.Group();

  // 地面（币堆所在的低台）——**P10 起真的开了两个洞**（见 `DRAIN` 的推导）
  //
  // 厚度 0.24 米而不是观感上的 0.10 米，且全部向下加（承载面 y=0 不动）：
  // 实测抓到币被求解器**向下**踢到 vy ≈ −7.6 米/秒（速度护栏 8 以内的合法极值），
  // 一个子步位移 0.127 米 > 地板 0.10 米 + 币半厚——**无 CCD 的离散碰撞直接隧穿**
  // （2026-09-22 `anomalySamples`：两枚铜币 y=−0.89、vy=−7.57）。
  // 0.24 米时隧穿需要 |vy| > 15.6 米/秒，是护栏上限的近两倍，物理上不可达。
  //
  // ★ 拆成 3 块而不是 1 块：中路整条 + 两侧只铺到洞口之前。
  //   `|x| > DRAIN.xMin 且 z ∈ [DRAIN.zMin, DRAIN.zMax]` 这块 footprint **没有任何碰撞体**，
  //   币推进去就真的掉下去，由 `Game.processOutcomes` 的排水判定回收（不计分、不算异常）。
  //   **不改厚度**：厚度是被隧穿实测钉死的，开洞与厚度是两件事（纪律 1）。
  const floorHalfWidth = TABLE.halfWidth + TABLE.railThickness; // 0.83
  const drainHalfWidth = (floorHalfWidth - DRAIN.xMin) / 2;
  const drainCenterX = (floorHalfWidth + DRAIN.xMin) / 2;
  const sideHalfDepth = (DRAIN.zMin - FIELD_BACK) / 2;
  const sideCenterZ = (DRAIN.zMin + FIELD_BACK) / 2;
  // 台面摩擦与弹性（S11 物理侧标定，2026-09-24）。
  //
  // ★ 摩擦 **0.32 → 0.45**：Rapier 默认按 **Average** 合并两个碰撞体的摩擦，
  //   所以「币↔台面」的实际值是 `(COIN.friction + 这里) / 2`。S11 把 `COIN.friction`
  //   从 0.3 抬到 0.5，这里必须同步抬 —— 只改一边的话实际摩擦只涨一半，
  //   而「币床整体滑动」正是左尾（16 投的极短局）的成因。详见 `COIN.friction` 的注释。
  //
  // ★ 弹性 **0.02 → 0**：币落在床面上**一点都不该弹**。0.02 虽然小，但 314 枚币
  //   每帧有上千次接触，任何非零弹性都会被累积成持续的微抖动。
  //   侧壁 / 钉子的弹性另算（钉子 0.3 是有意的：币要能在钉阵上散开）。
  const floorFriction = { friction: 0.45, restitution: 0 };
  const floorCollider = (halfX: number, halfZ: number, x: number, z: number) =>
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(halfX, 0.12, halfZ)
        .setTranslation(x, TABLE.floorY - 0.12, z)
        .setFriction(floorFriction.friction)
        .setRestitution(floorFriction.restitution),
    );
  // ① 中路：整条铺满（含洞口所在的 z 段，但只到 `xMin`）。
  floorCollider(DRAIN.xMin, FIELD_DEPTH / 2, 0, FIELD_CENTER_Z);
  // ② 两侧：只铺到洞口之前，把洞口让出来。
  for (const side of [-1, 1]) {
    floorCollider(drainHalfWidth, sideHalfDepth, side * drainCenterX, sideCenterZ);
  }

  // 地板网格：`Shape` + `holes` + `ExtrudeGeometry` —— **真洞，不是贴上去的色块**。
  // 1 个 draw call；用三块板拼同样的剪影要 3 个。
  //
  // 坐标系：`rotation.x = +π/2` 把 shape 的 (x, y) 直接映到世界的 (x, z)，
  // 挤出方向（局部 +z）映到世界 **−y** —— 所以 shape 画在承载面 y=0 上，
  // 挤出 0.1 米刚好向下长，承载面不动。
  const floorShape = new THREE.Shape();
  floorShape.moveTo(-floorHalfWidth, FIELD_BACK);
  floorShape.lineTo(floorHalfWidth, FIELD_BACK);
  floorShape.lineTo(floorHalfWidth, FLOOR_FRONT_Z);
  floorShape.lineTo(-floorHalfWidth, FLOOR_FRONT_Z);
  floorShape.closePath();
  // 洞口比碰撞体**窄 3 厘米**：外侧那一条（x ∈ [0.80, 0.83]）正好压在侧围板底下，
  // 看不见；而币心最远只能到 0.74（币半径 0.06 + 内壁 0.80），
  // 所以「看得见的洞」完全覆盖了「币真能掉下去的范围」——不会出现凭空消失的币。
  for (const side of [-1, 1]) {
    const hole = new THREE.Path();
    const inner = side * DRAIN.xMin;
    const outer = side * (floorHalfWidth - 0.03);
    hole.moveTo(inner, DRAIN.zMin);
    hole.lineTo(outer, DRAIN.zMin);
    hole.lineTo(outer, DRAIN.zMax);
    hole.lineTo(inner, DRAIN.zMax);
    hole.closePath();
    floorShape.holes.push(hole);
  }
  const floor = new THREE.Mesh(
    new THREE.ExtrudeGeometry(floorShape, { depth: 0.1, bevelEnabled: false, curveSegments: 1 }),
    makeToonMaterial({
      name: 'floor',
      // 建场时先给一个默认色，`applyCabinetSkin` 随后按当前皮肤刷一遍。
      // ★ S20：不再写死字面量 —— `COLORS.floor` 派生自 `CABINET_SKINS[0].colors.floor`，
      // 配色只有一份真源。抬高明度是 V2 的必要条件：彩色色带是**乘**在 albedo 上的，
      // 近黑的 albedo 乘任何色带都还是近黑。
      color: COLORS.floor,
      ramp: ROLE_RAMP.floor,
      // V3：币床的绒布颗粒。
      ...ROLE_DETAIL.floor,
    }),
  );
  floor.rotation.x = Math.PI / 2;
  floor.receiveShadow = true;
  floor.userData.role = 'floor';
  floor.userData.part = 'floor';
  group.add(floor);

  // 洞口底下的**暗格栅**：没有它，洞里就是一片能看穿机柜的空。
  // 近黑的 albedo 乘任何色带都还是近黑，所以它天然读作「洞」而不是「一块深色地板」。
  // ★ 它同时是 P10 ⑨ 的**洞口闪光**载体（见 `buildDrainGrateMaterial`）：
  //   自发光从 0 抬起来，不需要另加一片发光板。
  const grateMaterial = buildDrainGrateMaterial();
  for (const side of [-1, 1]) {
    const grate = new THREE.Mesh(
      new THREE.BoxGeometry(drainHalfWidth + 0.03, 0.02, DRAIN.zMax - DRAIN.zMin),
      grateMaterial,
    );
    grate.position.set(side * drainCenterX, TABLE.floorY - 0.06, (DRAIN.zMin + DRAIN.zMax) / 2);
    grate.userData.part = 'drainGrate';
    group.add(grate);
  }

  /*
   * 侧壁碰撞体的厚度必须是**视觉厚度的 4 倍**（0.24 米 vs 0.06 米），且只向外侧加。
   *
   * 实测缺陷（2026-09-22，mobile-safari 复现 1/24 局抓到现场）：满盘币堆的侧向压力
   * 把一枚铜币**低速挤进**侧壁（不是弹飞，vx 只有 1.38 米/秒）；币心一旦越过
   * 薄墙的中面，Rapier 按「最小穿透方向」解算就会翻面，把它朝**机外**推，
   * erp=0.8 顺手送一脚 `0.8 × 0.03 / (1/60) ≈ 1.44` 米/秒——与现场 vx=1.38 严丝合缝。
   * 速度护栏（8 米/秒）管不到这种低速渗透，围板高度也管不到（它穿墙而过，不翻墙）。
   *
   * 修法不是继续调求解器，而是让「穿到中面」在物理上不可能：
   * 壁厚 0.24 米时翻面需要币心深入 0.134 米（≈ 10 倍币半径），币堆压力做不到。
   * **内侧面位置不变**（x = ±0.80，与视觉网格齐平），合法币的接触手感一点都不变；
   * 加厚部分全部伸向机外，那里只有纯视觉的机柜壳，没有碰撞体。
   */
  const SIDE_WALL_HALF = 0.12;
  for (const side of [-1, 1]) {
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(SIDE_WALL_HALF, TABLE.railHeight / 2, FIELD_DEPTH / 2)
        .setTranslation(
          side * (TABLE.halfWidth + SIDE_WALL_HALF),
          TABLE.railHeight / 2,
          FIELD_CENTER_Z,
        )
        .setFriction(0.24)
        /* R4-P1：0.14 → 0.08，和钉子收进同一条窄带。侧墙原本是仅次于钉子的软面，
           Average 下给币↔墙留 0.07 的回弹 —— 「回弹忽强忽弱」里的『忽强』有一半是它。
           内侧面位置不动（x = ±0.80），这里只改材料属性。 */
        .setRestitution(0.08),
    );

    /*
     * 护栏之上的**侧向围板**（不可见）。
     *
     * 为什么必须有：护栏只有 `railHeight` = 0.46 米高，而 `PHYSICS.erp` = 0.8 把 318 枚币的
     * 币堆做得接近刚体。求解器在这么硬的堆上会偶发**能量注入**——实测把单枚币顶到
     * 11~12 米/秒（推板本身只有 0.4 米/秒，放大 30 倍），币竖直飞到 5~6 米高，
     * 落回来时已经飘到机外（`anomalySamples` 的现场：`x ≈ ±1.31`、`y` 从 −0.8 到 5.7）。
     *
     * 关键判断：**这不是「参数没调好」，而是机台少了一面围板。** 真机的币床是封闭的
     * （玻璃/亚克力罩），币在物理上不可能飞出机柜；而这里 —— 见 `buildCabinetShell` ——
     * 机柜的背板、顶沿、侧板**全是纯视觉网格，一个碰撞体都没有**，所以护栏之上完全敞开。
     * 降 `erp` 能把弹射压下去（实测 0.5 时 10 局 0 枚），但 0.5 会让 95 枚币沉进地板
     * （见 `PHYSICS.erp` 的扫描表）——**刚度与弹射在这个旋钮上是互相拉扯的**，
     * 所以正确的修法是补上围板，而不是把刚度让回去。
     *
     * 尺寸：与护栏同一个 x 平面、同样的厚度，等于把护栏沿竖直方向续上去，
     * 顶到 `GLASS_TOP`。视觉上不需要新增美术件——围板正好落在护栏的正上方。
     */
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(
        SIDE_WALL_HALF,
        (GLASS_TOP - TABLE.railHeight) / 2,
        FIELD_DEPTH / 2,
      )
        .setTranslation(
          side * (TABLE.halfWidth + SIDE_WALL_HALF),
          (GLASS_TOP + TABLE.railHeight) / 2,
          FIELD_CENTER_Z,
        )
        // 低摩擦、低弹性：币撞上去**滑回来**，不要在围板里来回弹。
        // 厚度与护栏同为 0.24 米——围板段同样是挤穿翻面的潜在通道，一起加厚。
        .setFriction(0.1)
        .setRestitution(0.02),
    );
  }

  /*
   * ── 后墙（背板碰撞体）────────────────────────────────────────────────
   *
   * ## 为什么是 `TABLE.backZ` 而不是 `FIELD_BACK`
   *
   * 计划（S2）原写「位置 `FIELD_BACK`」（= `TABLE.pusherBackZ` = −2.35）。**那一版不对**，
   * 两个理由：
   *
   * ① **它挡不住玩家看得见的那面墙。** 背板面板（`buildCabinetShell`）在 `TABLE.backZ`，
   *    而推板顶面（上层台面）从 `offset − 2.35` 一直铺到 `offset + 0.20`
   *    —— 也就是**有约 1 米的台面藏在背板后面**。币滑到 z < `TABLE.backZ` 之后就穿过了
   *    面板、在画面里凭空消失。这正是「背板没有碰撞」的观感来源，而 −2.35 那面墙在
   *    推板体的正后方，玩家永远看不到、币也基本到不了。
   * ② **`FIELD_BACK` 那面墙会造出一个夹缝。** 推板体占 z ∈ [`offset` − 2.35, `offset` − 0.16]，
   *    后墙放在 −2.35 就等于紧贴推板后表面：一旦有币落进那个缝，回撤行程会把它
   *    **压在推板后表面与墙之间**（推板体只有 0.2 米高，币只能被挤着往上跳）。
   *
   * 放在可见背板平面就没有这两个问题：推板体**始终包住**这面墙的 z 区间
   * （归位时 [−2.35, −0.16]、全伸时 [−1.99, 0.20]，都含 `backZ` 附近的 [−1.30, −1.18]），
   * 于是墙只对**台面上的币**起作用，对推板（kinematic）与币床都不产生任何影响。
   *
   * ## 内表面为什么正好落在 `TABLE.backZ`（S13 改，S23 随背板一起前移）
   *
   * `TABLE.backZ` 就是**可见背板面板的前表面**（`buildCabinetShell` 的 `backPanel`
   * 前表面 = `TABLE.backZ`、后表面 = `SHELL_BACK_Z`，厚 0.06）。把碰撞内表面也放在
   * 同一平面上，币贴墙停住时圆心在 `backZ + 币半径`，**后缘恰好与面板齐平**，
   * 一枚币都不会陷进去。S23 之后这个平面是 −1.178（= 上层币床末排的实际后缘）。
   *
   * ★ 改前它退在 `TABLE.backZ − 0.04`，理由（见下面的旧注释）是躲开闸门吐币的
   * 出生重叠。代价是**贴墙的币有 4 厘米（币径 0.144 的 28%）嵌进背板里** —— 用户报的
   * 「币贴到背板时嵌进去」就是这一处。那段退让换来的出生间隙现在改由**闸门落点前移**
   * 承担：`GateShow.slotAt.z` 与 `FountainShow.nozzleAt.z` 都从 `backZ + 0.05 / +0.07`
   * 改到 `backZ + 0.10`（**相对量**，跟着墙走），币后缘离墙 2.8 厘米，**无重叠**。
   *
   * 副作用（可接受，而且正是想要的）：推板顶面物理上从 `offsetZ − 2.35` 铺到
   * `offsetZ + 0.20`，后墙这一刀把 `z < TABLE.backZ` 那段台面封在机柜里 —— 那一段
   * 本来就在可见面板背后，币滑进去就穿过面板消失。静态后墙与推板（kinematic）之间
   * 不生成接触对，两者几何重叠不影响物理。
   *
   * 尺寸：x 取**整个场内净宽 + 围板厚度**（不是 `SIDE_WALL_HALF` —— 计划里那个值
   * 是从侧墙抄过来的半宽，照抄会让后墙只有 0.24 米宽，等于一根柱子）。
   * y 与侧向围板同为 [0, `GLASS_TOP`]。摩擦/弹性也与围板一致：撞上去滑回来。
   */
  const BACK_WALL_HALF = 0.12;
  const BACK_WALL_FACE_Z = TABLE.backZ;
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(
      TABLE.halfWidth + SIDE_WALL_HALF,
      GLASS_TOP / 2,
      BACK_WALL_HALF,
    )
      .setTranslation(0, GLASS_TOP / 2, BACK_WALL_FACE_Z - BACK_WALL_HALF)
      .setFriction(0.1)
      .setRestitution(0.02),
  );

  // 钉阵：沿 z 轴的水平杆，币落下来被打散。
  // 网格用缩短后的长度（纯显示），碰撞体一律用全长 PEG_HALF_LENGTH（物理判定不变）。
  // P3：22 根钉子的网格合并为一个 InstancedMesh（改前每根一个 drawcall）；碰撞体不动。
  const pegGeometry = new THREE.CylinderGeometry(PEG_RADIUS, PEG_RADIUS, PEG_VISUAL_HALF_LENGTH * 2, 8);
  const pegMaterial = makeToonMaterial({
    name: 'peg',
    color: COLORS.peg,
    ramp: 'metal',
    // 钉子半径只有 0.008 米，拉丝在它身上基本看不出——给个细粒度毛毡更实在。
    // 但它必须过**同一个**肌理总开关：`peg` 刻意不挂 `role`，拿不到 `ROLE_DETAIL`，
    // 直接展开 `DETAIL_SURFACE.felt` 就会在「机柜全纯色」之后留下一处漏网的纹样
    //（而漏网的这一处正是 perf 判据要数出来的那种静默不一致）。
    ...flatDetail(DETAIL_SURFACE.felt),
  });
  const pegQuaternion = axisAngleX(Math.PI / 2);
  const pegTotal = PEG_ROWS.reduce((total, row) => total + row.xs.length, 0);
  const pegMesh = new THREE.InstancedMesh(pegGeometry, pegMaterial, pegTotal);
  pegMesh.castShadow = true;
  // 钉子**刻意不挂 `role`**：它是可读性锚点，不参与换肤（见 `TableRole` 的注释）。
  // 但身份要有 —— 导出工具与判据都靠它认件。
  pegMesh.userData.part = 'peg';
  // 钉子静止且永远在镜头内，不做逐组合包围球裁剪。
  pegMesh.frustumCulled = false;
  const pegWorldQuat = new THREE.Quaternion(pegQuaternion.x, pegQuaternion.y, pegQuaternion.z, pegQuaternion.w);
  const pegMatrix = new THREE.Matrix4();
  const pegPosition = new THREE.Vector3();
  const pegScale = new THREE.Vector3(1, 1, 1);
  let pegCount = 0;
  for (const row of PEG_ROWS) {
    for (const x of row.xs) {
      world.createCollider(
        RAPIER.ColliderDesc.cylinder(PEG_HALF_LENGTH, PEG_RADIUS)
          .setTranslation(x, row.y, TABLE.drop.z)
          .setRotation(pegQuaternion)
          .setFriction(0.12)
          /* R4-P1：0.3 → 0.08。0.3 是全机台最软的一处弹性，比其余表面高一个数量级，
             在 Average 下给币→钉留下 0.15 的有效回弹 —— 观感就是「撞钉乱蹦、其余全黏」。
             收进和围板同一窄带（.08），钉子的散射只保留在**几何**层面（打散落点），
             不再兼任弹射器。 */
          .setRestitution(0.08),
      );
      pegPosition.set(x, row.y, TABLE.drop.z);
      pegMatrix.compose(pegPosition, pegWorldQuat, pegScale);
      pegMesh.setMatrixAt(pegCount, pegMatrix);
      pegCount += 1;
    }
  }
  pegMesh.instanceMatrix.needsUpdate = true;
  group.add(pegMesh);

  const scoreLine = buildScoreLine();
  group.add(scoreLine.object);
  group.add(buildTray());
  // ★ 外壳单独留一份引用（S24）：`?model` 模型模式要能把它**整具拆掉重建**。
  // 原先写成 `group.add(buildCabinetShell())` 把引用丢了 —— 想重建就只能
  // `group.children.find(...)` 去猜，那又是「靠名字反推身份」。
  const cabinetShell = buildCabinetShell();
  group.add(cabinetShell);
  group.add(buildDropCorridor());
  group.add(buildFrontBaffle());

  const hotZone = buildHotZone();
  group.add(hotZone.object);

  return {
    group,
    cabinetShell,
    pegCount,
    pegColliderHalfLength: PEG_HALF_LENGTH,
    pegVisualHalfLength: PEG_VISUAL_HALF_LENGTH,
    hotZoneStrip: hotZone.object,
    scoreLineMaterial: scoreLine.material,
    hotZoneMaterial: hotZone.material,
    drainGrateMaterial: grateMaterial,
  };
}

/** 反馈脉冲的峰值常量（Game 需要它们来算插值，**不在两处各写一遍**）。 */
export const FEEDBACK_EMISSIVE = {
  scoreLineBase: SCORE_LINE_BASE_EMISSIVE,
  scoreLinePeak: SCORE_LINE_PULSE_EMISSIVE,
  hotZoneBase: HOT_ZONE_BASE_EMISSIVE,
  hotZonePeak: HOT_ZONE_FLASH_EMISSIVE,
  /** 洞口闪光的峰值（基线恒为 0：近黑基色 + 零自发光 = 一个纯粹的洞）。 */
  drainPeak: DRAIN_FLASH_EMISSIVE,
} as const;

/**
 * 热区高亮条：贴在得分线上的一段亮条，由 Game 每帧挪位置。
 * 纯视觉 + 计分判定，不加碰撞体——币的越线判定完全不变。
 *
 * 同样把材质交出去：命中时 Game 会把它爆闪到 `HOT_ZONE_FLASH_EMISSIVE`，
 * 让「这一下瞄上了」在画面上有第二路证据（第一路是专属音效）。
 */
/**
 * 热区高亮条（带 Arcane 风贴图，S18）。
 *
 * `acc` 色带 + 自发光识别色 + **`map`** 走 `createArcaneHotZoneTexture`。
 *
 * `color: '#ffffff'` 让贴图原色不受铝色腰带影响——这一档材质实际显示的是
 * 「贴图色 × emissive 颜色」。`map` 通道是 three 既有的，**不涨程序**。
 */
function buildHotZone(): { object: THREE.Mesh; material: LitMaterial } {
  const material = makeToonMaterial({
    name: 'hotZone',
    color: '#ffffff',
    ramp: 'accent',
    map: createArcaneHotZoneTexture('firelight'),
    emissive: COLORS.bounty,
    emissiveIntensity: HOT_ZONE_BASE_EMISSIVE,
    transparent: true,
    opacity: 0.8,
  });
  const strip = new THREE.Mesh(new THREE.BoxGeometry(TABLE.hotZone.halfWidth * 2, 0.014, 0.07), material);
  strip.position.set(0, TABLE.floorY + 0.009, TABLE.scoreLineZ);
  strip.userData.part = 'hotZone';
  strip.visible = false;
  return { object: strip, material };
}

/**
 * 排水口闪光（P10 ⑨）：币掉进洞时，洞口亮一下。
 *
 * ## 为什么必须有
 *
 * PLAN 的原话：「否则玩家分不清『没进』和『掉了』」。这两件事对盘面的影响
 * **方向相反**：没进的币还留在床上，掉了的币永久离开。只有一声 `audio.drain()`
 * 不够——玩家在余光里看不到声音的来源，会以为币是被挤没了。
 *
 * ## 为什么是「两侧一起闪」
 *
 * 格栅是**两个网格共用一份材质**，`emissive` 是材质级的、不是网格级的，
 * 所以逐侧闪要多一份材质（+1 材质、可能 +1 程序）。收益不值：
 * 这条反馈要表达的是**「机器在吞币」**，不是「哪一侧吞的」——
 * 币是在哪一侧掉的，玩家本来就看得到。
 *
 * ## 颜色
 *
 * 冷青（`COLORS.drain`），**刻意与越线得分的暖金相反**。
 * 纯白会与连落白闪（`ClimaxTone = 'white'`）撞色。
 */
function buildDrainGrateMaterial(): LitMaterial {
  return makeToonMaterial({
    name: 'drainGrate',
    color: '#1b201d',
    ramp: ROLE_RAMP.floor,
    emissive: COLORS.drain,
    // 基线 0：近黑基色 + 零自发光 ⇒ 平时完全读作「一个洞」。
    emissiveIntensity: 0,
  });
}

/**
 * 落币导槽：从吐币口（`TABLE.drop.y = 1.45`）一路到台面，把「币从哪进来」讲清楚。
 *
 * 原来的两片导流片只覆盖 `y ∈ [0.22, 0.62]`（碰钉区最低一排钉子到台面之间），
 * **0.62 → 1.45 这一整段是空的** —— 截图里币看起来就是从半空凭空出现的。
 * 现在把它一路顶到吐币口，同时补上两片斜向收口的漏斗片，
 * 让「投币口 → 导槽 → 落点」在画面上连成一条可读的通路。
 *
 * 纯视觉，不加碰撞体，不改变物理（币的落点仍由 `TABLE.drop` 与抖动决定）。
 */
function buildDropCorridor(): THREE.Group {
  const corridor = new THREE.Group();
  const material = makeToonMaterial({
    name: 'dropCorridor',
    color: COLORS.pusherLip,
    ramp: 'accent',
    // ★ 背面走 `metal`（底档 #2f3a52，比 accent 的 #4a4460 更暗更冷）：这两片是
    // `DoubleSide` + 26% 透明，从外面会**同时看见近壁和透过它看见的远壁**。
    // 正背面同一条色带时两面完全一样，导槽在截图里就是一张纸；分开之后远壁沉下去，
    // 「一条槽」的厚度才读得出来。
    // ⚠️ 选调色板要看**开机时已加载哪几条**，不是看语义：色带缓存按 id 建，
    //   填一条只有演出装置才用的 `device` 会把 LUT 从 4 条抬到 5 条（实测），
    //   而 `metal` 是护栏/顶沿开机就在的，用它 LUT 数量不变。
    rampBack: 'metal',
    transparent: true,
    opacity: 0.26,
    side: THREE.DoubleSide,
  });
  const bottom = TABLE.pusherTopY + 0.02;
  // ★ 顶端从 `PEG_ROWS[0].y`（0.62）抬到吐币口高度，把空段补掉。
  const top = TABLE.drop.y;
  const height = top - bottom;
  for (const side of [-1, 1]) {
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.01, height, 0.24), material);
    fin.position.set(side * 0.7, bottom + height / 2, TABLE.drop.z);
    fin.userData.part = 'dropCorridor';
    corridor.add(fin);
  }
  return corridor;
}

/**
 * 得分线：币越过这条线才结算。
 *
 * 返回值带**材质**（P10 ⑨）：连落 ≥ 3 时 Game 要脉冲它的 `emissiveIntensity`，
 * 让「得分线在跳」成为可读的反馈。交出材质而不是交出网格，见 `TableBuild` 的说明。
 */
/**
 * 得分线（带 Arcane 风贴图，S18）。
 *
 * 与 hot zone 同源——共用 'accent' 色带 + 自发光识别色 + 走贴图通道（不涨程序）。
 * 得分线用 `'viArcane'` 调色板（青辉橙主），与热区的 `'firelight'` 红橙主
 * **不同**：`cabinet-tex` 判据会读两个贴图实例的像素颜色桶，不一致 ⇒ 绿。
 */
function buildScoreLine(): { object: THREE.Group; material: LitMaterial } {
  const line = new THREE.Group();
  const material = makeToonMaterial({
    name: 'scoreLine',
    color: '#ffffff',
    ramp: 'accent',
    map: createArcaneScoreLineTexture('viArcane'),
    emissive: COLORS.scoreLine,
    emissiveIntensity: SCORE_LINE_BASE_EMISSIVE,
  });
  // ★ 亮条只画到 `±DRAIN.xMin`（P10）：两端的开口是下水道，不是得分线。
  //   画满会让玩家以为「线在那边还在」，而那里的币其实是掉进洞里的。
  const strip = new THREE.Mesh(
    new THREE.BoxGeometry(DRAIN.xMin * 2, 0.008, 0.03),
    material,
  );
  strip.position.set(0, TABLE.floorY + 0.006, TABLE.scoreLineZ);
  // ★ 身份必须有：`Game.pickCabinetMap` 就是按它决定「切肤时重画哪张贴图」的。
  //   以前这里没有任何标识，于是那条分支永远不命中 —— 切肤之后得分线仍然挂着
  //   建场时写死的 `'viArcane'` 调色板。
  strip.userData.part = 'scoreLine';
  line.add(strip);

  const dashes = makeToonMaterial({
    name: 'scoreDashes',
    color: COLORS.pusherLip,
    ramp: 'accent',
    emissive: COLORS.pusherLip,
    emissiveIntensity: 0.2,
  });
  for (let i = -3; i <= 3; i += 1) {
    const dash = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.006, 0.09), dashes);
    dash.position.set(i * 0.21, TABLE.floorY + 0.005, TABLE.scoreLineZ + 0.075);
    dash.userData.part = 'scoreDashes';
    line.add(dash);
  }
  return { object: line, material };
}

/** 出币托盘：视觉上承接越过得分线的币。 */
function buildTray(): THREE.Mesh {
  const tray = new THREE.Mesh(
    // 托盘是玩家最近距离看到的一件，圆角给到 2 厘米——前缘不再是一条刀口。
    roundedBox(TABLE.halfWidth * 2, 0.16, 0.34, 0.02),
    makeToonMaterial({
      name: 'tray',
      color: '#3a4a42',
      ramp: 'cabinet',
      // 出币托盘原先走木纹（与推板顶面同属「木作」）——机柜与推板都改纯色之后，
      // 这一件单独留纹样会变成全场唯一一块「有图案的面」，反而更刺眼，所以一并平掉。
    }),
  );
  tray.position.set(0, TABLE.floorY - 0.08, TABLE.scoreLineZ + 0.18);
  tray.userData.part = 'tray';
  return tray;
}

/**
 * 机台**最前方的立面挡板 + 下币口**。
 *
 * ## 为什么需要它
 *
 * 现状：币床前缘之外什么都没有 —— 得分线白虚线之下直接是一块光板（出币托盘），
 * 机台正面是**敞开**的。于是「下币口」读不出是个口子，整台机器缺一个正面。
 *
 * ## 做法
 *
 * 在托盘前缘立一片全宽立面，中间开一道横向长口当**下币口**：
 * 下裙板 → 开口 → 上沿压条，开口的高度带对齐出币托盘（`y ∈ [-0.16, 0]`），
 * 于是「币越过得分线 → 掉进托盘 → 从这道口子被看见」在画面上连成一句。
 *
 * ## 两个刻意的选择
 *
 * 1. **开口是真的洞，不是贴上去的色块。** 用 `Shape` + `shape.holes` + `ExtrudeGeometry`
 *    一次成型。用三块板拼也能做出同样的剪影，但要 3 个 draw call（预算见 `verify-game`
 *    的 perf 判据：硬上限 50，现基线 40）。
 * 2. **圆角走 `bevelEnabled`**，与机柜其余件的 `RoundedBoxGeometry` 观感统一。
 *
 * 纯视觉，不加碰撞体 —— 币越过 `TABLE.scoreLineZ` 即被 `settleCrossing` 结算并回收，
 * 这里不参与任何物理，改它不会动经济。
 */
function buildFrontBaffle(): THREE.Group {
  const baffle = new THREE.Group();

  const width = TABLE.halfWidth * 2 + TABLE.railThickness * 2;
  // ★ 高度必须让**开口落在画面里**，不能只按「真实托盘高度」取。
  //
  // 实测（1280×720，逐像素扫出来的）：机台最前方 z≈1.52 处，
  //   世界 y = 0.24 → 屏幕 y ≈ 654，世界 y = 0.10 → 屏幕 y ≈ 712
  // 即 **414 像素 / 米**，而画面底边（720）对应世界 **y ≈ 0.08**。
  // 也就是说 y < 0.08 的东西全部在画面外 —— 前两版把开口放在托盘高度带
  // （y ∈ [-0.15, -0.03] / [-0.06, 0.10]）上，桌面视口里只看得到压条与实心板。
  //
  // 于是开口抬到 y ∈ [0.09, 0.21]（可见区中段），上沿压条到 y = 0.26。
  //
  // **上限由得分线决定**：从相机到 (0, 0.006, scoreLineZ) 的视线在 z=1.52 处
  // 高 y ≈ 0.292，挡板顶一旦超过它就会把得分线挡掉。0.26 留了约 3 厘米余量。
  const bottom = -0.30;
  const top = 0.26;
  const slotHalf = (width - 0.22) / 2;
  const slotBottom = 0.09;
  const slotTop = 0.21;
  const thickness = 0.05;
  // 托盘前缘在 z = scoreLineZ + 0.35，挡板贴到它前面 2 厘米处。
  const frontZ = TABLE.scoreLineZ + 0.37;

  const shape = new THREE.Shape();
  shape.moveTo(-width / 2, bottom);
  shape.lineTo(width / 2, bottom);
  shape.lineTo(width / 2, top);
  shape.lineTo(-width / 2, top);
  shape.closePath();

  const slot = new THREE.Path();
  slot.moveTo(-slotHalf, slotBottom);
  slot.lineTo(slotHalf, slotBottom);
  slot.lineTo(slotHalf, slotTop);
  slot.lineTo(-slotHalf, slotTop);
  slot.closePath();
  shape.holes.push(slot);

  // 挤出方向是 +z、从 z=0 长到 z=thickness，所以整体回退半个厚度让它关于 frontZ 对称。
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: thickness,
    bevelEnabled: true,
    bevelThickness: 0.006,
    bevelSize: 0.006,
    bevelSegments: 2,
    curveSegments: 2,
  });
  geometry.translate(0, 0, -thickness / 2);

  const panel = new THREE.Mesh(
    geometry,
    makeToonMaterial({
      name: 'frontBaffle',
      color: COLORS.cabinet,
      ramp: ROLE_RAMP.panel,
      ...ROLE_DETAIL.panel,
    }),
  );
  panel.position.z = frontZ;
  panel.userData.role = 'panel';
  panel.userData.part = 'frontBaffle';
  baffle.add(panel);

  // 上沿压条：把「立面顶端」这条边收掉，同时让挡板与机柜顶沿（同样走 trim）成一组。
  const lip = new THREE.Mesh(
    roundedBox(width, 0.04, thickness + 0.02),
    makeToonMaterial({
      name: 'frontBaffleLip',
      color: COLORS.cabinetTrim,
      ramp: ROLE_RAMP.trim,
      ...ROLE_DETAIL.trim,
      ...ROLE_RIM.trim,
    }),
  );
  lip.position.set(0, top, frontZ);
  lip.castShadow = true;
  lip.userData.role = 'trim';
  lip.userData.part = 'frontBaffleLip';
  baffle.add(lip);

  return baffle;
}

/**
 * 机柜外壳（S19 重写：直译用户手搭的模型 `artifacts/cabinet-obj/coin-pusher-cabinet_test.obj`）。
 *
 * ## 尺寸从哪来
 *
 * **全部**来自 `game/cabinetShape.ts` 的 `CABINET`。本函数只做一件事：把那份数字
 * 变成网格。**一个尺寸都不许在这里重新发明** —— S18 那块砖就是从「在这里自己算一遍
 * 尺寸」开始的。
 *
 * ## 件册（7 件，与 `CABINET_SHELL_PARTS` 一一对应）
 *
 * | part | 形态 | role（色带） |
 * | --- | --- | --- |
 * | `sideWall.tall.L/R` | 侧墙高段（机柜侧板 + 檐板托，**沿 x 挤出的异形板**） | `panel` |
 * | `sideWall.low.L/R` | 侧墙低段（币床围挡，**斜顶**，沿 x 挤出） | `panel`（09-30 起与高段同一份材质） |
 * | `hoodRoof` | 顶板 | `trim` |
 * | `hoodValance` | 檐板（顶板前面垂下来的立面，**S21 起它就是招牌画布**） | `trim` |
 * | `backPanel` | 背板 | `panel` |
 *
 * S21 之前是 8 件（多一块 `marquee` 招牌）。用户批注 ① 要求删掉招牌、
 * 批注 ② 改由檐板承担招牌面 ⇒ 这一件连同 `buildMarqueePanel()` 一起删除。
 *
 * ## ★ 为什么拆成多件，而不是 S18 那样一件挤出的壳
 *
 * S18 把「侧板 + 顶沿 + 背板」做成**一整块** `ExtrudeGeometry`，两个后果：
 *
 * 1. **朝向反了**：`rotateX(-π/2)` 把 shape 的 +y 映到世界 −z，结果是一块
 *    1.78 × 1.77 × 1.97 米的实心砖盖住玩家这一半台面、糊满整个画面。
 *    而当时 `perf` / `drawcall` / `programs` / `cabinetTex` / `models` **全绿** ——
 *    因为没有任何判据在引用「机柜长什么样」。
 * 2. 即使朝向对了，那件壳也**没法被断言**：一件里塞三块板，`cabinetPartBox()`
 *    给不出它的解析盒，判据只能比并集 ⇒ 放走「檐板位置写错」这类缺陷。
 *
 * 拆开之后**每个 `part` 恰好对应一个网格**，件盒与几何一一对应，判据可以直接比对
 * （见 `verify-game.mjs` 的 `cabinet` 模式）。S21 起侧墙两段不再是直角盒，
 * 所以「形状」由 `cabinetShape.ts` 的 `cabinetWallOutline()` 折线 + 判据的
 * 顶点集合比对兜住 —— 解析盒对盒内的斜面是瞎的。
 *
 * ## 物理不变
 *
 * 外壳是**纯视觉** —— 所有 collider 仍在 `buildTable(world)` 里手写（后墙 / 侧壁 / 顶墙围板），
 * 本函数一行碰撞体都不建，所以 `physics` / `economy` 判据不受影响。
 *
 * ## role 与 part 正交
 *
 * `role` 只回答「刷哪个色带」（`applyCabinetSkin` 消费）；
 * `part` 回答「**这是哪一件**」（`pickCabinetMap` / 导出命名 / `cabinet` 判据消费）。
 * S18 把两件事挤在 `role` 一个字段里，于是 `pickCabinetMap` 的 `scoreLine` / `hotZone`
 * 两条分支**永远不会命中**（没有任何网格挂这两个 role），切肤之后得分线与热区
 * 仍然挂着建场时写死的调色板。见 `cabinetShape.ts` 的 `CabinetPart` 注释。
 */
/**
 * 机柜外壳的三份材质（**模块单例**）。
 *
 * ## ★ 为什么必须提到模块级 —— 这一条是 `?model` 模型模式的前提
 *
 * `buildCabinetShell()` 在模型模式下会被**反复调用**（每调一次参数重建一次）。
 * 材质若留在函数体里 `new`，重建一次就多三份材质，两个后果都是零报错的静默失效：
 *
 *   1. `programs` 一路涨 ⇒ `perf` / `cabinetTex` 的程序数判据直接红；
 *   2. `applyCabinetSkin` / `applyCabinetMapTextures` 刚刷上的颜色与 Arcane 贴图
 *      **当场作废** —— 它们刷的是旧实例，而新网格用的是新实例。
 *      表现是「换肤之后一调模型参数，机柜就变回默认色」，而且没有任何报错。
 *
 * 所以材质是单例，重建只 dispose **几何**（见 `disposeCabinetShell`）。
 */
let cabinetMaterialCache: {
  panel: LitMaterial;
  panelArt: LitMaterial;
  trimRoof: LitMaterial;
  trimValance: LitMaterial;
  screen: LitMaterial;
} | null = null;

function cabinetMaterials(): {
  panel: LitMaterial;
  panelArt: LitMaterial;
  trimRoof: LitMaterial;
  trimValance: LitMaterial;
  screen: LitMaterial;
} {
  if (!cabinetMaterialCache) {
    const panelParams = {
      color: COLORS.cabinet,
      ramp: ROLE_RAMP.panel,
      // V3：背板 / 侧板的接缝 + 铆钉（格边长 0.5 米）。
      ...ROLE_DETAIL.panel,
    };
    const trimParams = (name: string) => ({
      name,
      color: COLORS.cabinetTrim,
      ramp: ROLE_RAMP.trim,
      ...ROLE_DETAIL.trim,
      ...ROLE_RIM.trim,
    });
    cabinetMaterialCache = {
      panel: makeToonMaterial({ name: 'panel', ...panelParams }),
      // ★ 与 `panel` **同色带、同纹样、不同实例**，为的是能挂一张不同的 `map`。
      //
      // S18 的教训是反方向生效的：当时「招牌 / 顶沿 / 前立面压条」共用一份 `trim`
      // 材质，于是 `pickCabinetMap` 只能给三件同一个构图（`role` 撞名）。这里把
      // **要挂灯饰贴图的侧板高段**单独拆一份实例：
      //   - `role` 仍是 `panel` ⇒ 换肤照旧走同一条色带，两件永远同色；
      //   - defines 与 `panel` 一字不差 ⇒ **不涨 program**（`perf` 判据不让步）；
      //   - 只是多一个材质对象 ⇒ **不涨 draw call**（件数没变）。
      // 背板留在 `panel` 上：它的可见部分只有币床上方那一条，贴图会被金币堆糊满。
      panelArt: makeToonMaterial({ name: 'panelArt', ...panelParams }),
      // ★ 顶板与檐板**同色带、同纹样、不同实例**（和上面 panelArt 同一手法），
      // 为的是 R2-T1-5：两件要挂不同的 Arcane 构图。
      //
      // 为什么拆实例是**唯一**办法：一份材质只有一个 map 槽，两件共用时
      // `pickCabinetMap` 后写的那张会覆盖先写的 —— 零报错，只是两块板变成同一张画。
      // 这正是 S18「招牌 / 顶沿 / 压条共用 trim ⇒ 三件只能同构图」的根因。
      //
      // 代价核算（与 panelArt 那条一样走「只多对象、不多定义」）：
      //   - defines 一字不差 ⇒ +0 program；
      //   - 网格件数没变 ⇒ +0 draw call；
      //   - 但 `materialReport().rim` 会 +1（两份都带金属边缘光）⇒ perf 判据的
      //     期望值必须跟着改成实测值，**不是**放宽断言。
      trimRoof: makeToonMaterial(trimParams('trimRoof')),
      trimValance: makeToonMaterial(trimParams('trimValance')),
      // ★ R3-U4 招牌显示屏。**defines 与 panelArt 一字不差**（同 detailKind、
      // 同挂 map + emissiveMap）⇒ 复用同一个 program，只多一个 draw call。
      //
      // 底色压到近黑是刻意的：这块面**不该被场景光照**，它的光全来自 emissiveMap。
      // 留一点余量（不是纯 0）是为了让檐板的圆角高光能在屏面上落一道极淡的边 ——
      // 完全不吃光的贴片看起来像 PS 上去的。
      screen: makeToonMaterial({
        name: 'marqueeScreen',
        color: '#0b0f0c',
        ramp: ROLE_RAMP.panel,
        ...ROLE_DETAIL.panel,
        map: marqueeScreen().texture,
        emissiveMap: marqueeScreen().texture,
        emissive: '#ffffff',
        emissiveIntensity: 1.15,
      }),
    };
  }
  return cabinetMaterialCache;
}

/**
 * 建一具机柜外壳（7 件）。
 *
 * 导出给 `Game.rebuildCabinetShell()`：`?model` 模型模式每改一次参数就
 * 「dispose 旧的 → 建新的」。**材质是模块单例**（见 `cabinetMaterials()`），
 * 所以重复调用不会涨已编译程序数、也不会把换肤结果冲掉。
 */
export function buildCabinetShell(): THREE.Group {
  const shell = new THREE.Group();
  const { panel, panelArt, trimRoof, trimValance, screen } = cabinetMaterials();

  // ── 7 件外壳 ──
  //
  // 顺序即「从里往外」：两侧墙（高段 + 低段）→ 顶板 + 檐板 → 背板。
  // 每件的中心与尺寸都在对应的 `build*` 里直接由 `cabinetShape()` 的字段算出，
  // 这里只负责挂上去 —— 写在这儿的任何数字都会变成「第二份真源」。
  //
  // ★ 高段走 `panelArt`（与 `panel` 同色带、同纹样，只是独立实例），它要挂 R1-M3 的
  //   内凹灯饰贴图。★ 用户批注（09-30）：**前侧板（低段）与后侧板（高段）材质统一**
  //   ⇒ 低段现在共用同一个 `panelArt` 实例，而不是原来那份带金属边缘光的 `rail`。
  //   共用实例是这件事最强的形式：以后任何一方加贴图/改色带都不可能只落到一半，
  //   「两块板参数不一致」这类缺陷从结构上消失（原来那份 `rail` 材质已随之删除）。
  //   代价：`materialReport().rim` 少一份、`rimBreak` 少一份 ⇒ perf 的期望值按实测改。
  shell.add(buildSideWall(-1, panelArt));
  shell.add(buildSideWall(1, panelArt));
  shell.add(buildHood(trimRoof, trimValance, screen));
  shell.add(buildBackPanel(panel));

  return shell;
}

/**
 * 拆掉一具外壳：**只 dispose 几何**，材质是模块单例（见 `cabinetMaterials()`）。
 *
 * ⚠️ 顺序不能反：先 `removeFromParent()` 再 dispose 几何。反过来会让「几何已释放、
 * 网格还挂在场景里」存在一帧 —— 这一帧正好撞上截图就是白模。
 *
 * 这是 `?model` 模型模式重建外壳的唯一入口；非 `?model` 下永远不会被调用。
 */
export function disposeCabinetShell(shell: THREE.Object3D): void {
  shell.removeFromParent();
  shell.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh === true) mesh.geometry?.dispose();
  });
}

/**
 * 由「中心 + 尺寸」建一个机柜件网格，并把**身份**挂上。
 *
 * `role`（色带）与 `part`（身份）都必须显式给出 —— 不许靠网格名或材质名反推，
 * 那正是 S18 里 `trim#0` / `trim#1` 撞名的成因（顶沿与招牌共用一份 trim 材质）。
 */
function cabinetBoxMesh(
  size: readonly [number, number, number],
  center: readonly [number, number, number],
  role: TableRole,
  /** ★ 只能是外壳件 —— 倒角是按件查的（见下）。 */
  part: CabinetShellPart,
  material: LitMaterial,
  castShadow = false,
): THREE.Mesh {
  // ★ 倒角**在这里**从真源取，不由调用方传。
  //
  // 让调用方传 `partBevel(part)` 看着更显式，实际是个陷阱：漏传不报错，
  // 只是那个件的倒角永远停在模块默认值 —— 又一个零报错的静默失效
  //（「拖了滑块顶板不动」，而且找不到原因）。
  const bevel = partBevel(part);
  const mesh = new THREE.Mesh(
    roundedBox(size[0], size[1], size[2], bevel.radius, bevel.segments),
    material,
  );
  mesh.position.set(center[0], center[1], center[2]);
  // 只有侧墙低段投影（原来那条可视护栏本来就是投影的）。
  // 高段 / 顶板 / 背板只接收：它们是 1.6 米级的大件，让它们进阴影通道会把
  // 阴影贴图的可用分辨率摊薄，而它们背后本来也没有需要接影的东西。
  mesh.castShadow = castShadow;
  mesh.receiveShadow = true;
  mesh.userData.role = role;
  mesh.userData.part = part;
  // ★ 「这件吃不吃倒角」由**这个函数**声明，不在别处另列一份名单。
  //
  // 这里是全仓库唯一调用 `partBevel()` 的地方 ⇒ 它是唯一真正应用倒角的建法；
  // 剖面挤出件（`cabinetProfileMesh`）走另一条路，天生不吃。于是 `?model` 面板读
  // `userData.bevelable` 就知道该不该给那一组滑块，**不需要**再维护一份
  // 「哪些件是直角盒」的表 —— 那种表会在某件从盒子改成挤出（或反过来）时静默漂移，
  // 表现是「面板上能拖、几何不理」（本仓库最忌讳的零报错失效）。
  mesh.userData.bevelable = true;
  return mesh;
}

/**
 * 把剖面挤出件的 UV 从「米」归一到 0..1。
 *
 * `THREE.ExtrudeGeometry` 的默认 UV 生成器给**端面**的是 shape 自己的 `(x, y)`，
 * 也就是世界的 `(z, y)`、单位是米（±1.4 这种值），不是 0..1。直接挂贴图 = 一张图
 * 在墙上按米平铺、原点还落在中间。这里按**剖面自身的范围**线性归一，让一整个端面
 * 恰好铺满一张图 —— 灯饰构图才能按画布坐标设计（见 `render/cabinetTexture.ts` 的
 * `createArcaneLampHousingTexture`，它的高宽比就是照这里的跨度挑的）。
 *
 * 范围从**入参剖面**取，不从 `geometry.boundingBox` 取：端面顶点的 uv 就是剖面坐标，
 * 两者必须同源；而包围盒还额外含着挤出方向那 6 厘米，是另一个量。
 *
 * ⚠️ 侧壁（挤出那一圈薄边）的 uv 由另一条公式给出、会落到范围外 ⇒ 夹到 [0,1]。
 * 那几面只有 6 厘米宽，采样边缘像素比按 `RepeatWrapping` 平铺干净。
 */
function normalizeProfileUv(
  geometry: THREE.BufferGeometry,
  profile: readonly (readonly [number, number])[],
): void {
  const uv = geometry.getAttribute('uv');
  let minZ = Infinity;
  let maxZ = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [z, y] of profile) {
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const spanZ = Math.max(1e-6, maxZ - minZ);
  const spanY = Math.max(1e-6, maxY - minY);
  for (let i = 0; i < uv.count; i += 1) {
    const u = Math.min(1, Math.max(0, (uv.getX(i) - minZ) / spanZ));
    const v = Math.min(1, Math.max(0, (uv.getY(i) - minY) / spanY));
    uv.setXY(i, u, v);
  }
  uv.needsUpdate = true;
}

/**
 * 由 **(z, y) 平面的闭合轮廓**沿 x 挤出一块机柜件，并把**身份**挂上。
 *
 * ## 为什么需要它（S21）
 *
 * `cabinetBoxMesh()` 只能建直角盒；S21 的侧墙有两处**斜边**（檐板托的斜接面、
 * 低段的斜顶），`roundedBox` 做不出来 —— 而这两条边**整个都落在包围盒内部**，
 * 只靠解析盒比对的判据永远发现不了它们（写成平的、或者两个端点接反，全绿）。
 *
 * ## 坐标系怎么对上
 *
 * `THREE.Shape` 活在它自己的 (x, y) 平面上、沿 +z 挤出。这里取
 * **shape.x = 世界的 z**、**shape.y = 世界的 y**、**挤出方向 = 世界的 −x**：
 * `rotateY(-π/2)` 把 `(px, py, pz)` 映到 `(−pz, py, px)`，于是
 *   - 轮廓点 `(z, y, 0)` → 世界 `(0, y, z)` ✓
 *   - 挤出段 `pz ∈ [0, thickness]` → 世界 `x ∈ [−thickness, 0]`，居中之后
 *     再由网格位置搬到 `side` 那一侧 ⇒ 内表面正好落在 `wall.innerX`（外壳接口面）。
 *
 * ⚠️ 轮廓的**环绕方向**不用管：`ExtrudeGeometry` 会按 `ShapeUtils.isClockWise`
 * 自己纠正（与 `buildFrontBaffle` 的 `Shape` 同一个道理）。
 */
function cabinetPrismMesh(
  profile: readonly (readonly [number, number])[],
  role: TableRole,
  part: CabinetPart,
  material: LitMaterial,
  side: -1 | 1,
  castShadow = false,
): THREE.Mesh {
  const { wall } = cabinetShape();
  const shape = new THREE.Shape();
  shape.moveTo(profile[0][0], profile[0][1]);
  for (let i = 1; i < profile.length; i += 1) shape.lineTo(profile[i][0], profile[i][1]);
  shape.closePath();

  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: wall.thickness,
    bevelEnabled: false,
    curveSegments: 1,
  });
  normalizeProfileUv(geometry, profile);
  geometry.rotateY(-Math.PI / 2);
  // 挤出段落在 `x ∈ [−thickness, 0]`：先把它**居中**（±thickness/2），再由网格位置
  // 摆到那一侧。这样左右两件共用同一份几何、只是 x 位置取反 ——
  // **镜像对称是构造出来的，不是各算一遍算出来的**（S19 手搭模型就是在这儿偏了 2.5 毫米）。
  geometry.translate(wall.thickness / 2, 0, 0);

  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(side * (wall.innerX + wall.thickness / 2), 0, 0);
  // 只有低段投影（原来那条可视护栏就是投影的）。理由同 `cabinetBoxMesh`。
  mesh.castShadow = castShadow;
  mesh.receiveShadow = true;
  mesh.userData.role = role;
  mesh.userData.part = part;
  return mesh;
}

/**
 * 一侧的侧墙：低段 + 高段在 `CABINET.wall.insetZ` 处对接，**两段同一份材质**
 *（09-30 用户批注：前侧板与后侧板的材质、纹理各参数统一）。
 *
 * ## S21 的两处新形状（用户批注 ③⑤）
 *
 *   - **高段内收**：主面从 `hoodFrontZ`（0.195）退到 `insetZ`（−0.12），
 *     顶上留一条「**檐板托**」把前缘接回檐板内表面 —— 两者之间是一条**斜接面**
 *     （`(hoodFrontZ, miterFrontY) → (insetZ, insetTopY)`，约 13°）。
 *     侧面因此读作「高段后退 + 与檐板斜接 + 与低段斜接」，而不是把侧板切短。
 *   - **低段斜顶**：原来的平顶 0.647 换成 `(insetZ, lowRoofBackY)` →
 *     `(lowFrontZ, lowRoofFrontY)` 这条斜线（后端降 1/3，前端再低一点）。
 *
 * 这两条边都在包围盒**内部** ⇒ 解析盒比对看不见它们，所以这里写出来的轮廓必须与
 * `cabinetShape.ts` 的 `cabinetWallOutline()` **逐点一致**（`cabinet` 判据逐顶点比对）。
 *
 * ★ 几何由 `CABINET.wall` 的字段直接拼出来，**不调 `cabinetPartBox()`**，
 * 也**不调 `cabinetWallOutline()`**，也**不读 `WALL_OUTLINE_BINDING`**。
 * 这样「建网格」与「算盒 / 算折线」是同一份数据的**两条独立推导**，`cabinet` 判据
 * 比对两者才有意义；若两边都调同一个函数，比对恒真，等于没查。
 *
 * ## S25：逐角斜角
 *
 * 侧墙沿 x 挤出，倒角不能靠 `RoundedBoxGeometry`（那只会把挤出截面整个换掉），
 * 必须**画进剖面折线**里。所以下面每个角点自带一个 `id`，半径从
 * `CABINET.bevel.wallChamfer` 按 `id` 取，再交给 `chamferPolyline()` 展开 ——
 * 这是全仓库第二份「角点 ↔ 字段」列表，它与真源那张表**内容相同、来源独立**。
 *
 * ⚠️ 为什么点与 `id` 绑在同一个对象里，而不是两份平行数组：平行数组靠下标对齐，
 * 调一次顺序就把斜角挪到别的角上，几何照样闭合、**零报错**。绑成一条记录之后，
 * 漏标或错标的角在 `Record<WallPointId, number>` 上直接编译不过。
 */
type WallCorner = {
  id: WallPointId;
  z: number;
  y: number;
};

function buildSideWall(
  side: -1 | 1,
  /**
   * 高段与低段**共用的一份**材质（09-30 用户批注：前侧板与后侧板材质统一）。
   *
   * 参数名按**件**而不是按**色带**取的历史原因仍然成立：这份实例的色带是 `panel`，
   * 但实例是 `panelArt`（要单独挂灯饰贴图），叫它 `panel` 会把
   * 「同色带 ≠ 同材质」藏起来。而现在两段连实例都同一份 ⇒ 签名只剩一个参数，
   * 「两块板各拿一份材质」这条路径在类型层面就没有入口了。
   */
  material: LitMaterial,
): THREE.Group {
  const { wall, bevel } = cabinetShape();
  const group = new THREE.Group();
  const suffix = side < 0 ? '.L' : '.R';

  /** 尖角点列表 → 斜角展开后的剖面环（半径按 `id` 取，与点的顺序无关）。 */
  const outline = (corners: readonly WallCorner[]) =>
    chamferPolyline(
      corners.map((c) => [c.z, c.y] as const),
      corners.map((c) => bevel.wallChamfer[c.id]),
    );

  // 低段：z ∈ [insetZ, lowFrontZ]、y ∈ [bottomY, 斜顶]。前缘与地板剪影前缘齐。
  group.add(
    cabinetPrismMesh(
      outline([
        { id: 'low.backBottom', z: wall.insetZ, y: wall.bottomY },
        { id: 'low.frontBottom', z: wall.lowFrontZ, y: wall.bottomY },
        { id: 'low.roofFront', z: wall.lowFrontZ, y: wall.lowRoofFrontY },
        { id: 'low.roofBack', z: wall.insetZ, y: wall.lowRoofBackY },
      ]),
      'panel',
      `sideWall.low${suffix}` as CabinetPart,
      material,
      side,
      true,
    ),
  );

  // 高段：主面退到 `insetZ`，顶部留「檐板托」伸到 `hoodFrontZ`（与檐板内表面同面），
  // 上沿与机柜顶面齐平（tallTopY）。
  group.add(
    cabinetPrismMesh(
      outline([
        { id: 'tall.backBottom', z: wall.backZ, y: wall.bottomY },
        { id: 'tall.insetBottom', z: wall.insetZ, y: wall.bottomY },
        { id: 'tall.insetTop', z: wall.insetZ, y: wall.insetTopY },
        { id: 'tall.hoodBottomFront', z: wall.hoodFrontZ, y: wall.miterFrontY },
        { id: 'tall.hoodTopFront', z: wall.hoodFrontZ, y: wall.tallTopY },
        { id: 'tall.backTop', z: wall.backZ, y: wall.tallTopY },
      ]),
      'panel',
      `sideWall.tall${suffix}` as CabinetPart,
      material,
      side,
    ),
  );

  return group;
}

/**
 * 顶板 + 檐板（`trim` 色带）。两件直角盒拼出用户模型里那块 L 形钣金。
 *
 * ★ 为什么不挤成一件 L 形挤出：见 `buildCabinetShell` 的注释 —— 合成一件之后
 * 判据只能比并集，「檐板位置写错」这一类缺陷会被放走。两件在接缝
 * （`z = hood.valanceInnerZ` = `hoodFrontZ`、`y ∈ [underY, topY]`）处是内表面对内表面，
 * 不会 z-fighting。
 *
 * ★ S21（批注 ①②）：招牌 `marquee` 删了，**檐板自己就是招牌画布** ——
 * 它的正面 `1.6 × 0.349` 米承受 `createArcaneMarqueeTexture` 那张 2:1 画布
 * （`Game.pickCabinetMap` 本来就把它分到招牌那一支），代价是垂直压缩 ≈42%。
 * 侧墙高段的「檐板托」正好托在它下沿（`valanceBottomY`）上。
 */
function buildHood(
  roofMaterial: LitMaterial,
  valanceMaterial: LitMaterial,
  screen: LitMaterial,
): THREE.Group {
  const { hood } = cabinetShape();
  const group = new THREE.Group();

  // 顶板：z ∈ [backZ, valanceInnerZ]、y ∈ [underY, topY]。机柜内腔的「天花板」（无碰撞体）。
  group.add(
    cabinetBoxMesh(
      [hood.halfWidth * 2, hood.topY - hood.underY, hood.valanceInnerZ - hood.backZ],
      [0, (hood.underY + hood.topY) / 2, (hood.backZ + hood.valanceInnerZ) / 2],
      'trim',
      'hoodRoof',
      roofMaterial,
    ),
  );

  // 檐板：z ∈ [valanceInnerZ, valanceFrontZ]、y ∈ [valanceBottomY, topY]。
  // ★ S21 起它就是**招牌画布**（正面朝 +z，正对相机），下沿被侧墙的檐板托托住。
  group.add(
    cabinetBoxMesh(
      [hood.halfWidth * 2, hood.topY - hood.valanceBottomY, hood.valanceFrontZ - hood.valanceInnerZ],
      [0, (hood.valanceBottomY + hood.topY) / 2, (hood.valanceInnerZ + hood.valanceFrontZ) / 2],
      'trim',
      'hoodValance',
      valanceMaterial,
    ),
  );

  // ★ R3-U4：檐板正前 2 mm 的一块 LED 小屏（见 `render/marqueeScreen.ts`）。
  group.add(buildMarqueeScreenMesh(screen));

  return group;
}

/**
 * 招牌显示屏的贴片（R3-U4）。
 *
 * 尺寸从檐板反推、不写死：屏**铺满檐板倒角以内的整块平坦区**（用户批注：直接做满）。
 *
 * ★ 做满之后面板是 4.997:1，而纹理一直是 4:1 ⇒ 字被横向白拉 **24.9 %**（实测）。
 *   早先这里锁 4:1 与纹理对齐，去掉锁之后注释写的是「剩下的只有轻微的字宽拉伸」——
 *   那个判断错了，25 % 对文字不是轻微。现在改成**把纹理宽度反过来贴合面板比例**
 *   （`setAspect`），拉伸归零，而且 `?model` 改檐板尺寸时会自动跟上。
 *   判据见 `verify-game.mjs` 的「纹理宽高比 == 面板宽高比」。
 *
 * 没有 `userData.role` / `userData.part`：换肤（`applyCabinetSkin`）与贴图分发
 * （`Game.applyCabinetMapTextures`）都是按这两个字段找件的，屏既不吃机柜配色
 * 也不吃 Arcane 构图，让它俩天然跳过比自己写一条「如果是屏就 continue」干净。
 */
function buildMarqueeScreenMesh(material: LitMaterial): THREE.Mesh {
  const { hood } = cabinetShape();
  const bevel = partBevel('hoodValance').radius;
  const height = hood.topY - hood.valanceBottomY - bevel * 2;
  const width = hood.halfWidth * 2 - bevel * 2;
  // 先对比例、后建网格：画布尺寸一变，`PlaneGeometry` 的 UV 是 0..1，
  // 拉伸完全由「纹理宽高比 ÷ 面板宽高比」决定，所以这一步必须与几何同源同序。
  marqueeScreen().setAspect(width / height);
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), material);

  mesh.name = 'marqueeScreen';
  mesh.position.set(
    0,
    (hood.valanceBottomY + hood.topY) / 2,
    hood.valanceFrontZ + 0.002,
  );
  return mesh;
}

/**
 * 背板。★ **S19 从 S18 手里拿回来的**一件。
 *
 * S18 把它并进那块朝向反了的挤出件里，于是 S18 之后机柜背面是空的 ——
 * 背墙碰撞体（`z ∈ [-1.47, -1.35]`）后面什么都没有，老虎机
 * （`slotFrame` / `slotReelWindow` / `slotLamp`，`z ≈ -1.30 ~ -1.355`）等于悬空挂着。
 *
 * ★ 前表面必须正好落在 `TABLE.backZ`，与后墙碰撞体的内表面**同面** ——
 * 这是 S16「修背板嵌入」定下的接口：币撞到碰撞体就是撞到看得见的背板。
 * ★ 后表面 = 外壳最后缘，与侧墙 / 顶板的后缘共面（见 `cabinetShape.ts` 的
 * `SHELL_BACK_Z` 注释：手搭模型在这里多探出 2.7 厘米，S19 已修正）。
 *
 * 两个面都由 `CABINET.back` 的 **`frontZ` / `backZ`** 给出（而不是「中心 ± 半厚」）：
 * 两个面各自是一个必须成立的接口，`cabinet` 判据逐面断言。
 */
function buildBackPanel(material: LitMaterial): THREE.Mesh {
  const { back } = cabinetShape();
  return cabinetBoxMesh(
    [back.halfWidth * 2, back.topY - back.bottomY, back.frontZ - back.backZ],
    [0, (back.bottomY + back.topY) / 2, (back.frontZ + back.backZ) / 2],
    'panel',
    'backPanel',
    material,
  );
}

/**
 * ☠️ S21 删掉的 `buildMarqueePanel()`（招牌面板）。
 *
 * 原来这里建一块 `1.6 × 0.6 × 0.04`、绕 x 轴 −30° 的倾斜板，挂在「顶板前上缘」，
 * 由 `Game.pickCabinetMap` 给它贴 `createArcaneMarqueeTexture`。用户批注 ① 要求删掉，
 * 批注 ② 改由**檐板**承担招牌面（`Game.pickCabinetMap` 本来就把它分到同一支）⇒
 * 这一件连同 `CABINET.marquee`、`CABINET_SHELL_PARTS` 里的那一项一起删除。
 *
 * ★ 留下的教训（`cabinetShape.ts` 的 `CABINET` 尾部也记了一份）：
 * `rotation.x = θ` 把局部 +z（正面法线）映到 `(0, −sin θ, cos θ)`，
 * S18 取 `+30°` ⇒ 法线朝**前下方** ⇒ 招牌面朝地面，而当时所有计数型判据全绿。
 * `cabinet` 判据现在改成断言**檐板正面朝前**（法线 ≈ `(0, 0, 1)`）。
 */

/**
 * 可换配色的机台部件**色带**（S19 起只管颜色）。
 *
 * ⚠️ `role` 与 `userData.part` **正交**，别把身份塞进这里：
 *   - `role` → 刷哪个色带（`applyCabinetSkin` 消费）；
 *   - `part` → 这是哪一件（`Game.pickCabinetMap` / `tools/cabinet-export.ts` /
 *     `verify-game.mjs cabinet` 消费）。
 *   S18 把两件事挤在 `role` 里，直接导致 `pickCabinetMap` 的两条分支是死代码。
 *
 * 钉阵、得分线、托盘、洞口格栅**刻意不在此列**：它们是可读性锚点，保持原色。
 * （得分线 / 热区的`part` 照样要挂 —— 那是身份，不是色带。）
 */
export type TableRole = 'floor' | 'rail' | 'panel' | 'trim' | 'pusherTop' | 'pusherFace';

const ROLE_COLOR: Record<TableRole, keyof CabinetSkin['colors']> = {
  floor: 'floor',
  rail: 'rail',
  panel: 'panel',
  trim: 'trim',
  pusherTop: 'pusherTop',
  pusherFace: 'pusherFace',
};

/**
 * 套用机柜配色。只改颜色，不动几何、碰撞体与任何数值。
 * 同一材质被多个网格共用时只改一次。
 */
export function applyCabinetSkin(root: THREE.Object3D, skin: CabinetSkin): void {
  const touched = new Set<THREE.Material>();
  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const role = child.userData.role as TableRole | undefined;
    if (!role) return;
    const material = child.material;
    const list = Array.isArray(material) ? material : [material];
    for (const entry of list) {
      if (touched.has(entry)) continue;
      touched.add(entry);
      // 判据走 `isLitMaterial`（而不是 `instanceof MeshStandardMaterial`）：
      // 换成 toon 材质后，旧判定会把所有部件都跳过——**换肤静默失效**，
      // 遍历照跑、零报错、颜色一点都不变。这是本轮最容易漏的一处。
      if (isLitMaterial(entry)) {
        entry.color.set(skin.colors[ROLE_COLOR[role]]);
      }
    }
  });
}

function axisAngleX(angle: number): { x: number; y: number; z: number; w: number } {
  const half = angle / 2;
  return { x: Math.sin(half), y: 0, z: 0, w: Math.cos(half) };
}
