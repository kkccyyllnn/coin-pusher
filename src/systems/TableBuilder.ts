import * as THREE from 'three';
import * as RAPIER from '@dimforge/rapier3d-compat';
import { COLORS, TABLE } from '../game/constants';
import type { CabinetSkin } from '../game/cosmetics';

export type TableBuild = {
  group: THREE.Group;
  /** 钉子数量。 */
  pegCount: number;
  /** 钉子碰撞体半长（物理，全长圆柱）。 */
  pegColliderHalfLength: number;
  /** 钉子网格半长（纯显示，比碰撞体短）。 */
  pegVisualHalfLength: number;
  /** 热区高亮条：位置由 Game 每帧写入，这里只负责建出来。 */
  hotZoneStrip: THREE.Mesh;
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

const FIELD_BACK = TABLE.pusherBackZ;
const FIELD_DEPTH = TABLE.scoreLineZ - FIELD_BACK;
const FIELD_CENTER_Z = (TABLE.scoreLineZ + FIELD_BACK) / 2;

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

  // 地面（币堆所在的低台）
  //
  // 厚度 0.24 米而不是观感上的 0.10 米，且全部向下加（承载面 y=0 不动）：
  // 实测抓到币被求解器**向下**踢到 vy ≈ −7.6 米/秒（速度护栏 8 以内的合法极值），
  // 一个子步位移 0.127 米 > 地板 0.10 米 + 币半厚——**无 CCD 的离散碰撞直接隧穿**
  // （2026-09-22 `anomalySamples`：两枚铜币 y=−0.89、vy=−7.57）。
  // 0.24 米时隧穿需要 |vy| > 15.6 米/秒，是护栏上限的近两倍，物理上不可达。
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(TABLE.halfWidth + TABLE.railThickness, 0.12, FIELD_DEPTH / 2)
      .setTranslation(0, TABLE.floorY - 0.12, FIELD_CENTER_Z)
      .setFriction(0.32)
      .setRestitution(0.02),
  );
  const floor = new THREE.Mesh(
    new THREE.BoxGeometry(TABLE.halfWidth * 2 + TABLE.railThickness * 2, 0.1, FIELD_DEPTH),
    new THREE.MeshStandardMaterial({ color: '#2f3d34', roughness: 0.74, metalness: 0.12 }),
  );
  floor.position.set(0, TABLE.floorY - 0.05, FIELD_CENTER_Z);
  floor.receiveShadow = true;
  floor.userData.role = 'floor';
  group.add(floor);

  // 左右实体护栏：首版不做侧边吞币洞。两侧共用一份材质，换配色时一次改完。
  const railMaterial = new THREE.MeshStandardMaterial({
    color: COLORS.rail,
    roughness: 0.6,
    metalness: 0.28,
  });
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
        .setRestitution(0.14),
    );
    const rail = new THREE.Mesh(
      new THREE.BoxGeometry(TABLE.railThickness * 2, TABLE.railHeight, FIELD_DEPTH),
      railMaterial,
    );
    rail.position.set(side * (TABLE.halfWidth + TABLE.railThickness), TABLE.railHeight / 2, FIELD_CENTER_Z);
    rail.castShadow = true;
    rail.receiveShadow = true;
    rail.userData.role = 'rail';
    group.add(rail);

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

  // 钉阵：沿 z 轴的水平杆，币落下来被打散。
  // 网格用缩短后的长度（纯显示），碰撞体一律用全长 PEG_HALF_LENGTH（物理判定不变）。
  // P3：22 根钉子的网格合并为一个 InstancedMesh（改前每根一个 drawcall）；碰撞体不动。
  const pegGeometry = new THREE.CylinderGeometry(PEG_RADIUS, PEG_RADIUS, PEG_VISUAL_HALF_LENGTH * 2, 8);
  const pegMaterial = new THREE.MeshStandardMaterial({
    color: COLORS.peg,
    roughness: 0.28,
    metalness: 0.82,
  });
  const pegQuaternion = axisAngleX(Math.PI / 2);
  const pegTotal = PEG_ROWS.reduce((total, row) => total + row.xs.length, 0);
  const pegMesh = new THREE.InstancedMesh(pegGeometry, pegMaterial, pegTotal);
  pegMesh.castShadow = true;
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
          .setRestitution(0.3),
      );
      pegPosition.set(x, row.y, TABLE.drop.z);
      pegMatrix.compose(pegPosition, pegWorldQuat, pegScale);
      pegMesh.setMatrixAt(pegCount, pegMatrix);
      pegCount += 1;
    }
  }
  pegMesh.instanceMatrix.needsUpdate = true;
  group.add(pegMesh);

  group.add(buildScoreLine());
  group.add(buildTray());
  group.add(buildCabinetShell());
  group.add(buildDropCorridor());

  const hotZoneStrip = buildHotZone();
  group.add(hotZoneStrip);

  return {
    group,
    pegCount,
    pegColliderHalfLength: PEG_HALF_LENGTH,
    pegVisualHalfLength: PEG_VISUAL_HALF_LENGTH,
    hotZoneStrip,
  };
}

/**
 * 热区高亮条：贴在得分线上的一段亮条，由 Game 每帧挪位置。
 * 纯视觉 + 计分判定，不加碰撞体——币的越线判定完全不变。
 */
function buildHotZone(): THREE.Mesh {
  const strip = new THREE.Mesh(
    new THREE.BoxGeometry(TABLE.hotZone.halfWidth * 2, 0.014, 0.07),
    new THREE.MeshStandardMaterial({
      color: COLORS.bounty,
      emissive: new THREE.Color(COLORS.bounty),
      emissiveIntensity: 0.55,
      transparent: true,
      opacity: 0.8,
      roughness: 0.35,
      metalness: 0.4,
    }),
  );
  strip.position.set(0, TABLE.floorY + 0.009, TABLE.scoreLineZ);
  strip.visible = false;
  return strip;
}

/**
 * 落币导槽：碰钉区最低一排钉子（y=0.62）到台面（y=0.20）之间是空的，
 * 补两片半透明导流片把这段过渡在画面上讲清楚，避免「看不见的落点传送」的观感。
 * 纯视觉，不加碰撞体，不改变物理。
 */
function buildDropCorridor(): THREE.Group {
  const corridor = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({
    color: COLORS.pusherLip,
    transparent: true,
    opacity: 0.26,
    roughness: 0.5,
    metalness: 0.32,
    side: THREE.DoubleSide,
  });
  const bottom = TABLE.pusherTopY + 0.02;
  const top = PEG_ROWS[0].y;
  const height = top - bottom;
  for (const side of [-1, 1]) {
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.01, height, 0.24), material);
    fin.position.set(side * 0.7, bottom + height / 2, TABLE.drop.z);
    corridor.add(fin);
  }
  return corridor;
}

/** 得分线：币越过这条线才结算。 */
function buildScoreLine(): THREE.Group {
  const line = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({
    color: COLORS.scoreLine,
    emissive: new THREE.Color(COLORS.scoreLine),
    emissiveIntensity: 0.35,
    roughness: 0.4,
    metalness: 0.3,
  });
  const strip = new THREE.Mesh(
    new THREE.BoxGeometry(TABLE.halfWidth * 2, 0.008, 0.03),
    material,
  );
  strip.position.set(0, TABLE.floorY + 0.006, TABLE.scoreLineZ);
  line.add(strip);

  const dashes = new THREE.MeshStandardMaterial({
    color: COLORS.pusherLip,
    emissive: new THREE.Color(COLORS.pusherLip),
    emissiveIntensity: 0.2,
    roughness: 0.5,
    metalness: 0.4,
  });
  for (let i = -3; i <= 3; i += 1) {
    const dash = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.006, 0.09), dashes);
    dash.position.set(i * 0.21, TABLE.floorY + 0.005, TABLE.scoreLineZ + 0.075);
    line.add(dash);
  }
  return line;
}

/** 出币托盘：视觉上承接越过得分线的币。 */
function buildTray(): THREE.Mesh {
  const tray = new THREE.Mesh(
    new THREE.BoxGeometry(TABLE.halfWidth * 2, 0.16, 0.34),
    new THREE.MeshStandardMaterial({ color: '#0f1512', roughness: 0.9, metalness: 0.05 }),
  );
  tray.position.set(0, TABLE.floorY - 0.08, TABLE.scoreLineZ + 0.18);
  return tray;
}

/** 机柜外壳与背板。背板会与推板穿插，正好形成「推板从背板后伸出」的观感。 */
function buildCabinetShell(): THREE.Group {
  const shell = new THREE.Group();
  const panelMaterial = new THREE.MeshStandardMaterial({
    color: COLORS.cabinet,
    roughness: 0.72,
    metalness: 0.22,
  });
  const trimMaterial = new THREE.MeshStandardMaterial({
    color: COLORS.cabinetTrim,
    roughness: 0.55,
    metalness: 0.4,
  });

  const backPanel = new THREE.Mesh(
    new THREE.BoxGeometry(TABLE.halfWidth * 2 + TABLE.railThickness * 4, 1.9, 0.06),
    panelMaterial,
  );
  backPanel.position.set(0, 0.7, TABLE.backZ - 0.03);
  backPanel.receiveShadow = true;
  backPanel.userData.role = 'panel';
  shell.add(backPanel);

  const hood = new THREE.Mesh(
    new THREE.BoxGeometry(TABLE.halfWidth * 2 + TABLE.railThickness * 4, 0.06, 0.5),
    trimMaterial,
  );
  hood.position.set(0, 1.66, TABLE.backZ + 0.2);
  hood.castShadow = true;
  hood.userData.role = 'trim';
  shell.add(hood);

  const sidePanelGeometry = new THREE.BoxGeometry(0.06, 1.9, 1.2);
  for (const side of [-1, 1]) {
    const sidePanel = new THREE.Mesh(sidePanelGeometry, panelMaterial);
    sidePanel.position.set(side * (TABLE.halfWidth + 0.09), 0.7, TABLE.backZ + 0.6);
    sidePanel.castShadow = true;
    sidePanel.userData.role = 'panel';
    shell.add(sidePanel);
  }

  return shell;
}

/** 可换配色的机台部件角色。钉阵、得分线、托盘保持原色，它们是可读性锚点。 */
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
      if (entry instanceof THREE.MeshStandardMaterial) {
        entry.color.set(skin.colors[ROLE_COLOR[role]]);
      }
    }
  });
}

function axisAngleX(angle: number): { x: number; y: number; z: number; w: number } {
  const half = angle / 2;
  return { x: Math.sin(half), y: 0, z: 0, w: Math.cos(half) };
}
