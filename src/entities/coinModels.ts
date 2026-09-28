import * as THREE from 'three';
import { COIN } from '../game/constants';
import { KINDS, type CoinKindId } from '../game/kinds';

/**
 * 钻石 / 宝箱的**低多面体模型**（S15）。
 *
 * ## 为什么不直接用参考模型
 *
 * - `Diamond.obj`：153 顶点，可以当比例尺用 —— 本文的比例**全部由它实测**（见 `DIAMOND_PROFILE`）。
 * - `Treasure_Glow`：9,763 顶点 / 9,942 面 + 3.2 MB 贴图，是**高模**。这台机器的 draw call
 *   硬上限是 50（现在 44）、已编译程序数硬上限 20（现在**正好 20**，顶格），高模进不来。
 *   所以只取它的**造型特征**：半圆桶盖 / 盖沿出檐 / 角柱 / 六边形锁板 / 底裙，
 *   以及「浅色框架 + 深色面板」的双色分工。
 *
 * ## 四条造型纪律
 *
 * 1. **模型不许超出碰撞体**（`coinColliderSpec()` 直接从几何体的 AABB 反算，
 *    所以这条是**构造上成立**的，不是靠人肉核对）。否则币会视觉互相插进去。
 * 2. **非索引三角面汤 + 逐面法线**（`computeVertexNormals()` 在非索引几何上按面算）——
 *    硬切面是低多面体的全部；共享顶点会把切面糊成球面。
 * 3. **配色只从 `KINDS[kind].lockedPalette` 派生**，不写第二份色值。
 * 4. **几何体以「碰撞体中心」为原点**（`build()` 末尾按 −H/2 平移）——
 *    物理体是绕质心转的，模型和碰撞体必须共用同一个原点，否则旋转起来会错位。
 *
 * ## ★ 多色是怎么实现的：**色板图集 + 逐面 UV**，不是顶点色
 *
 * 造型需要 5 档色调（亮 / 中 / 深 / 暗 / 墨），天然的做法是 `vertexColors: true`。
 * 但 **`perf` 的判据是 `已编译程序数 ≤ 20`，而现在正好是 20（顶格）**：
 * `vertexColors` 会打开 three 的 `USE_COLOR` define，**必然多编译一份程序变体** → 21 → 红。
 * （这是 S10「洞口闪光」踩过的同一个坑：新增材质族 / define 组合 = 新增程序变体，
 * 这不是「放宽上限」能解决的问题。）
 *
 * 所以这里改成：**把 5 档色调画成一张竖条色板图集，每个面用常量 UV 采一格**
 * （图集在 `coinTexture.createCoinModelAtlas`）。面内三个顶点的 UV 完全相同 ⇒
 * UV 导数恒为 0 ⇒ 永远采 mip 0 的那一个纹素，于是「一个面一种平色」的观感与顶点色
 * **逐像素等价**，而材质的 define 集合与既有币材质**完全一致**
 * （`USE_MAP` + `USE_GRADIENTMAP` + `SD_DETAIL_KIND=0`）——
 * 程序数一个不涨，draw call 一个不涨。
 *
 * ## ⚠️ 尺寸一律从**币径**派生，且「外接直径」是**实测**的
 *
 * - 绝对尺寸（0.124 / 0.132 之类）只在**一个**尺寸档位下成立，`?coin=` 一换就失真
 *   （本项目的老坑：「布局里任何写死的绝对尺寸都是尺寸档位的定时炸弹」）。
 * - 宝箱是箱形件，外接直径**不是**全宽，而是「最远顶点到中轴的距离 × 2」。
 *   手推那个系数错了一次（拿包围盒对角线当外接直径，多算了 7%），
 *   所以现在**先建单位形状、量出半径、再缩放**（见 `chestMetrics`）——
 *   一条真源，改任何部件都会自动跟上。
 */

/** 八边形：低多面体的「清晰切面」下限，且正好内接于币的圆脚印。 */
export const MODEL_SIDES = 8;

export type CoinModelKind = 'diamond' | 'chest';

export type CoinModelSpec = {
  /**
   * **外接直径**（米）—— 模型上任意一点到中轴的最大距离 × 2，由币径派生。
   *
   * 它是「模型装不装得进自己的碰撞体」这条纪律里被比较的量，所以必须是**真正的**
   * 外接直径：钻石是腰棱直径（八边形内接于圆）；宝箱由单位形状**实测**（`chestMetrics`）。
   *
   * ⚠️ S16 起它**大于币径**（1.5 / 2.5 倍），所以「模型 ≤ 币」这条老纪律已经作废 ——
   * 现在成立的是「模型 ≤ **自己的碰撞体**」（`coinColliderSpec` 从几何 AABB 反算，
   * 构造上成立），以及「外接直径 == `MODEL_DIAMETER_RATIO[kind]` × 币径」（判据 ⑤/⑧）。
   */
  diameter: number;
  /** 总高（米）。 */
  height: number;
};

/**
 * 外接直径 / 币径。**由用户拍板（S16）：钻石 1.5 倍、宝箱 2.5 倍**。
 *
 * ## 为什么从「比币小一圈」改成「比币大好几圈」
 *
 * S15 的两件模型是 **0.86 / 0.92 倍币径** —— 当时的动机是「落进币缝而不是互相顶开」。
 * 实测下来用户在画面上根本认不出它们：×1.2 档下钻石只有 124 mm、宝箱 132 mm，
 * 而一枚普通币是 144 mm，**模型比币还小**，观众读到的是「一枚长得有点怪的币」，
 * 而不是「中了大奖掉出来一件宝物」。所以 S16 把比例整个翻上去。
 *
 * ## ★ 比例 > 1 之后，**所有「按币径排布」的写死量都成了定时炸弹**
 *
 * 放大本身只改这一个常量（几何、碰撞体、`coinColliderHeight`、塔层高、闸板下沿
 * 全部从它派生）。但**排布**那一侧不行：
 *
 * - `TowerShow.spawnLayer` 曾写死层内偏移 `±COIN.radius` ⇒ 宝箱中心只距 0.144 m，
 *   而箱体半宽 0.161 m ⇒ **层内重叠 0.177 m**（求解器注入能量 → `anomalies`）。
 * - 同一个函数还写死 `yaw = layer * 0.9`。圆柱币转多少度都一样，**长方体不是**：
 *   转 51.6° 后世界半宽 = `hx|cos| + hz|sin|` = 0.201 m > 0.161 m。
 * - `TOWER_CYLINDER_RADIUS` 曾写死 `COIN.radius * 2.5` ⇒ 柱比宝箱窄，宝箱会悬在柱外。
 *
 * 三条都改成「从**该币种自己的碰撞体**派生」，见各自的注释。
 *
 * ⚠️ 别再把 0.216 / 0.36 写回来 —— 那是**只在一个尺寸档位下成立**的绝对尺寸，
 * `?coin=1` 时币径 120 mm ⇒ 新钻石 180 mm、宝箱 300 mm。比例与档位无关。
 */
export const MODEL_DIAMETER_RATIO: Record<CoinModelKind, number> = {
  diamond: 1.5,
  chest: 2.5,
};

/**
 * 参考钻石（`Diamond.obj`）实测的四带剖面 —— 本文的比例直接用它，不手拍。
 *
 * | 环 | 从底（× 总高） | 半径（× 腰棱半径） | 参考模型顶点数 |
 * |---|---|---|---|
 * | 底尖（culet） | 0.000 | 0.002 | 1 |
 * | 亭部中间环 | **0.283** | **0.432** | 8 |
 * | 腰棱（girdle） | **0.707** | 1.000 | 16 |
 * | 冠部中间环 | **0.934** | **0.700** | 8 |
 * | 台面（table） | 1.000 | **0.529** | 8 |
 *
 * 总高 / 直径 = **0.610**。低模把 16 边腰棱降到 8 边（`MODEL_SIDES`），
 * 比例一个不动 —— 于是它仍然是一枚「标准明亮式」，只是切面数减半。
 */
export const DIAMOND_PROFILE = {
  pavilionMid: { y: 0.283, radius: 0.432 },
  girdle: { y: 0.707, radius: 1 },
  crownMid: { y: 0.934, radius: 0.7 },
  table: { y: 1, radius: 0.529 },
  /** 参考模型的底尖是**一个点**；低模切成 0.06R 的小平面 —— 尖点会退化成零面积三角形。 */
  culetFacet: 0.06,
  /** 总高 / 直径（实测）。 */
  aspect: 0.61,
} as const;

/**
 * 参考宝箱（`Treasure_Glow`）实测的剖面比例。
 *
 * ## 全部由 OBJ 顶点**实测**，不是照图估的
 *
 * 归一化到「全宽 = 1」之后（原始全宽 1.9909）：
 *
 * | 量 | 实测 | 含义 |
 * |---|---|---|
 * | `heightOverWidth` | **0.780** | 总高 / 全宽（1.5535 / 1.9909） |
 * | `depthOverWidth` | **0.333** | 箱体半深 / 全宽（腰部 `max\|z\|`） |
 * | `lidOverhang` | **1.126** | 拱盖半深 / 箱体半深（0.375 / 0.333） |
 *
 * 其中两个量**不设成常量，而是派生**（避免「两个数互相打架」）：
 *
 * ```text
 * 拱心高 springY = 总高 − 拱半深          （拱顶正好等于总高）
 * body = springY / 总高 = 1 − 1.126×0.333/0.78 = 0.519   （实测 0.52 ✓）
 * lid  = 拱半深 / 总高 = 1.126×0.333/0.78       = 0.481   （实测 0.48 ✓）
 * ```
 *
 * ⚠️ 第一版这几个数是**看图估的**（`body 0.73 / aspect 0.888`），错得很典型：
 * 把「箱体高度」当成了「拱心高度」。参考模型的拱盖占了将近一半高度，
 * 是一个**又高又圆的桶盖**，不是浅浅的圆弧顶。
 * 判据是 `y` 分桶后 `max|z|` 的拐点：底 0.373 → 腰 0.333（箱体）→
 * 0.3775 @ y≈0.56H（拱盖最宽处）→ 顶部收窄。
 *
 * ## 造型上的取舍
 *
 * - **箱体是「切角矩形」不是正八边形**：实测箱体宽:深 = 1 : 0.666，
 *   正八边形做不出这个长宽比。低模用「矩形切四角」表达，仍是 8 条边。
 * - **底裙**（`baseFlare`）：实测底沿 `max|z|` 0.373 比腰部 0.333 宽 12%。
 * - **侧面提环**刻意不做：它在 x 上比箱体宽出 0.13，会突破「模型不超出碰撞体」。
 *
 * ## 五档色调的**分工**（这是「一眼认出是宝箱」的一半）
 *
 * 参考模型最醒目的特征是**「浅色框架 + 深色面板」**，而不是某一种具体颜色。
 * 所以色调不按「上亮下暗」分配，而是按**构件角色**分配：
 *
 * | 档 | 构件 |
 * |---|---|
 * | `light` | 框架：底裙 / 四角立柱 / 顶沿压条 / 两条拱肋 / 正面竖条 / 锁板 |
 * | `deep` | 面板：箱体四面 / 拱盖曲面 |
 * | `mid` | 锁板内的宝石**台面** |
 * | `shade` | 宝石**侧面**（切面感） |
 * | `dark` | 搭扣 |
 *
 * ⚠️ **拱肋必须比拱盖曲面凸出一圈**（`lidRecess`）：齐平的话「两条箍 + 中间一块面板」
 * 就消失了，渲出来只是一个素圆桶 —— 第一版就是这样。
 * 同理**角柱必须沿对角向外推**（`postProud`），不推则柱子的外角正好等于切角前的矩形角，
 * 整根柱子落在轮廓里面，24 个面一个都看不见。
 */
export const CHEST_PROFILE = {
  heightOverWidth: 0.78,
  depthOverWidth: 0.333,
  lidOverhang: 1.126,
  /**
   * 拱盖曲面半径 / 拱肋外半径。
   *
   * **拱肋（箍）必须比曲面凸出一圈**，否则「两条箍 + 中间一块面板」这个
   * 参考模型最醒目的特征就没了（第一版做成齐平，渲出来只是一个大圆桶）。
   * 0.90 ⇒ 每侧内收 0.0375W ≈ 4 mm（成品尺寸下），在 44 像素的币上也有 1 像素。
   */
  lidRecess: 0.9,
  /** 拱肋的弧段数：6 段 = 一眼看得出是「拱」的最少段数。 */
  lidSegments: 6,
  /** 拱肋在 x 方向的宽度（每条）。 */
  hoopWidth: 0.075,
  baseFlare: 1.12,
  baseHeight: 0.07,
  rimOverhang: 1.03,
  rimHeight: 0.06,
  /** 角柱半宽（柱宽 = 2 × 它 = 0.09W，正好铺满一条切角面）。 */
  postWidth: 0.045,
  /**
   * 角柱沿对角向外推的距离。
   *
   * ⚠️ 不推的话柱子的外角**正好等于**切角前的矩形角 ⇒ 整根柱子落在切角后的轮廓
   * 里面，24 个面一个都看不见（第一版就是这样：渲出来只有一只素箱子）。
   * 上限受「底裙角仍是全模型最远点」约束：`postProud ≤ 0.023`。
   */
  postProud: 0.02,
  chamfer: 0.09,
  /** 正面中央竖条的半宽与凸出量（锁板挂在它上面）。 */
  stripWidth: 0.055,
  stripProud: 0.022,
  lockRadius: 0.42,
  lockProud: 0.05,
  /** 锁板内宝石的半径 / 锁板半径，以及宝石的凸出量。 */
  gemScale: 0.62,
  gemProud: 0.045,
} as const;

type V3 = [number, number, number];

/**
 * 三角面汤。**非索引**是刻意的：`computeVertexNormals()` 只在非索引几何上按面算法线，
 * 共享顶点会把硬切面糊成球面 —— 那正是低多面体唯一不能丢的东西。
 *
 * ⚠️ 它只写**色调档位对应的 UV**，不碰任何颜色值 ——
 * 颜色在 `coinTexture.createCoinModelAtlas()` 里落进图集纹素。
 * 这样「5 档色调的色值」只有一个来源（`coinModelPalette`），
 * 几何侧只负责「哪个面用哪一档」。
 */
class Soup {
  private readonly position: number[] = [];
  private readonly uv: number[] = [];
  private tone: ModelTone = 'mid';

  /** 之后的三角形都用这一档色调（面内三顶点的 UV 完全相同 ⇒ 一个面一种平色）。 */
  use(tone: ModelTone): void {
    this.tone = tone;
  }

  private put(p: V3): void {
    this.position.push(p[0], p[1], p[2]);
    const [u, v] = toneUv(this.tone);
    this.uv.push(u, v);
  }

  tri(a: V3, b: V3, c: V3): void {
    this.put(a);
    this.put(b);
    this.put(c);
  }

  /** 四边形按 a→b→c→d 环绕（逆时针为正面）。 */
  quad(a: V3, b: V3, c: V3, d: V3): void {
    this.tri(a, b, c);
    this.tri(a, c, d);
  }

  /**
   * 两圈之间铺带子。
   *
   * ⚠️ 环绕方向是 `(下[i], 上[i], 上[j], 下[j])`。写成 `(下[i], 下[j], 上[j], 上[i])`
   * 会**整圈翻面**（法线朝内），而 toon 材质默认 `FrontSide` ⇒ 整件东西变成黑色剪影。
   * 推导：θ=0 处下点 `(r,0,0)`、上点 `(r,1,0)`、下一点 `(r·cosα, ·, r·sinα)`，
   * `(下[i]→上[i]) × (上[i]→上[j]) = (0,1,0) × (0,0,ε) = (+ε,0,0)` —— 朝外 ✓。
   */
  band(lower: V3[], upper: V3[]): void {
    for (let i = 0; i < lower.length; i += 1) {
      const j = (i + 1) % lower.length;
      this.quad(lower[i], upper[i], upper[j], lower[j]);
    }
  }

  /** 顶盖（法线朝 +y）。 */
  capUp(center: V3, ring: V3[]): void {
    for (let i = 0; i < ring.length; i += 1) {
      const j = (i + 1) % ring.length;
      this.tri(center, ring[j], ring[i]);
    }
  }

  /** 底盖（法线朝 −y）。 */
  capDown(center: V3, ring: V3[]): void {
    for (let i = 0; i < ring.length; i += 1) {
      const j = (i + 1) % ring.length;
      this.tri(center, ring[i], ring[j]);
    }
  }

  /** 轴对齐长方体（中心 + 半尺寸）。 */
  box(center: V3, half: V3): void {
    const [cx, cy, cz] = center;
    const [hx, hy, hz] = half;
    const p = (sx: number, sy: number, sz: number): V3 => [cx + sx * hx, cy + sy * hy, cz + sz * hz];
    const a = p(-1, -1, 1);
    const b = p(1, -1, 1);
    const c = p(1, 1, 1);
    const d = p(-1, 1, 1);
    const e = p(-1, -1, -1);
    const f = p(1, -1, -1);
    const g = p(1, 1, -1);
    const h = p(-1, 1, -1);
    this.quad(a, b, c, d); // +z
    this.quad(f, e, h, g); // −z
    this.quad(b, f, g, c); // +x
    this.quad(e, a, d, h); // −x
    this.quad(d, c, g, h); // +y
    this.quad(e, f, b, a); // −y
  }

  /**
   * 沿 **z** 轴挤出的棱柱：`polygon` 是 (x,y) 平面上**逆时针**（从 +z 看）的多边形。
   *
   * 存在的理由：`band()` 的环绕推导只对「绕 y 轴的两圈」成立，把同一套环绕用在
   * z 向棱柱上会**整件翻面**（`FrontSide` 下变成黑色剪影）。这里单独推导过：
   * 侧面 = `(后[i], 后[j], 前[j], 前[i])`，前面 = `(心, 前[i], 前[j])`，后面反向。
   *
   * `capTone` 给「前后两个端盖」换一档色调（侧带仍用当前档）——
   * 宝石靠它做出「亮台面 + 暗侧面」的切面感，用完后色调还原。
   */
  prismZ(polygon: Array<[number, number]>, zBack: number, zFront: number, capTone?: ModelTone): void {
    const bandTone = this.tone;
    const back: V3[] = polygon.map(([x, y]) => [x, y, zBack]);
    const front: V3[] = polygon.map(([x, y]) => [x, y, zFront]);
    const cx = polygon.reduce((sum, p) => sum + p[0], 0) / polygon.length;
    const cy = polygon.reduce((sum, p) => sum + p[1], 0) / polygon.length;
    for (let i = 0; i < polygon.length; i += 1) {
      const j = (i + 1) % polygon.length;
      this.use(bandTone);
      this.quad(back[i], back[j], front[j], front[i]);
      if (capTone) this.use(capTone);
      this.tri([cx, cy, zFront], front[i], front[j]);
      this.tri([cx, cy, zBack], back[j], back[i]);
    }
    this.use(bandTone);
  }

  /**
   * 沿 **x** 轴挤出的棱柱：`polygon` 是 (z,y) 平面上的多边形（拱肋就是半圆）。
   *
   * 单独一套的理由与 `prismZ` 相同：环绕方向**不能靠「同一套抄过来」**——
   * 抄错的结果是整件翻面（`FrontSide` 下变黑色剪影），而画面只会「看起来暗一点」，
   * 很难判成环绕问题。这里独立推导：
   * `(右[i]−左[i]) × (右[i+1]−右[i]) = (w,0,0) × (0,Δy,Δz) = (0, −wΔz, wΔy)`；
   * 拱盖弧上 `Δz < 0`、`Δy > 0` ⇒ 法线 `(0, +, +)` = 朝外上方 ✓
   *
   * 端盖的环绕：`(p_i−心) × (p_{i+1}−心)` 的 x 分量 = `R²·sin(t_i − t_{i+1}) < 0`
   * ⇒ `tri(心, i, i+1)` 朝 **−x**（左端盖），`tri(心, i+1, i)` 朝 **+x**（右端盖）。
   */
  prismAlongX(polygon: Array<[number, number]>, x0: number, x1: number): void {
    const left: V3[] = polygon.map(([z, y]) => [x0, y, z]);
    const right: V3[] = polygon.map(([z, y]) => [x1, y, z]);
    const cz = polygon.reduce((sum, p) => sum + p[0], 0) / polygon.length;
    const cy = polygon.reduce((sum, p) => sum + p[1], 0) / polygon.length;
    for (let i = 0; i < polygon.length; i += 1) {
      const j = (i + 1) % polygon.length;
      this.quad(left[i], right[i], right[j], left[j]);
      this.tri([x1, cy, cz], right[j], right[i]);
      this.tri([x0, cy, cz], left[i], left[j]);
    }
  }

  /**
   * 收口（**不平移**）：底面留在 y = 0。宝箱的单位形状要先量半径再缩放，
   * 缩放之前不知道该往哪移，所以这一层单独暴露出来。
   */
  buildRaw(): THREE.BufferGeometry {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(this.position, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
  }

  /**
   * 收口 + 把模型**平移到以碰撞体中心为原点**（`centerY` = 从底到顶的中点）。
   *
   * 为什么必须平移：物理体绕质心旋转，`Coin.sync()` 直接把刚体的位姿写进实例矩阵。
   * 模型若以「底面 y=0」为原点，币一翻滚就会绕底边转 —— 视觉上币飞出碰撞体。
   */
  build(centerY: number): THREE.BufferGeometry {
    const geometry = this.buildRaw();
    geometry.translate(0, -centerY, 0);
    return geometry;
  }
}

/**
 * 绕 y 轴的一圈点（逆时针，从 +x 起）。
 *
 * `phase` 以「格」为单位：0 = 顶点落在 0°/45°/…，0.5 = 顶点落在 22.5°/67.5°/…
 */
function ringAt(y: number, radius: number, sides = MODEL_SIDES, phase = 0): V3[] {
  const out: V3[] = [];
  for (let i = 0; i < sides; i += 1) {
    const a = ((i + phase) / sides) * Math.PI * 2;
    out.push([Math.cos(a) * radius, y, Math.sin(a) * radius]);
  }
  return out;
}

/**
 * **切角矩形**的一圈点（逆时针，从 +x 侧起，与 `band()` 的环绕推导一致）。
 *
 * 存在的理由：参考宝箱的箱体宽:深 = 1 : 0.666，**正八边形做不出这个长宽比**
 * （正八边形 x/z 对边距必然相等）。所以用「矩形切四角」表达 ——
 * 仍然是 8 条边、仍然是「一眼看出是切面」，但长宽比是自由的。
 */
function chamferRing(y: number, hx: number, hz: number, cut: number): V3[] {
  const cx = Math.min(cut, hx * 0.45);
  const cz = Math.min(cut, hz * 0.45);
  return [
    [hx, y, hz - cz],
    [hx - cx, y, hz],
    [-hx + cx, y, hz],
    [-hx, y, hz - cz],
    [-hx, y, -hz + cz],
    [-hx + cx, y, -hz],
    [hx - cx, y, -hz],
    [hx, y, -hz + cz],
  ];
}

/**
 * 钻石：八边、四带、`DIAMOND_PROFILE` 的比例。
 *
 * 带子由下往上：底尖面 → 亭下带 → 亭上带 → 冠下带 → 冠上带 → 台面，
 * 色调由暗到亮、与受光方向一致 —— 于是「亮」这件事既有**切面法线**又有**色阶**两份冗余，
 * 360p 内部缓冲下也读得出来（与币面「字形 + 自发光」的冗余识别是同一条纪律）。
 *
 * 外接直径是**解析的**：八边形相位 0 ⇒ 有一个顶点正好落在 `(R, 0, 0)`，
 * 所以「最远顶点到中轴的距离」恒等于 `R = diameter / 2`，不需要实测。
 */
export function buildDiamondGeometry(spec: CoinModelSpec = coinModelSpec('diamond')): THREE.BufferGeometry {
  const R = spec.diameter / 2;
  const H = spec.height;
  const p = DIAMOND_PROFILE;
  const soup = new Soup();

  const culet = ringAt(0, R * p.culetFacet);
  const pavilionMid = ringAt(H * p.pavilionMid.y, R * p.pavilionMid.radius);
  const girdle = ringAt(H * p.girdle.y, R * p.girdle.radius);
  const crownMid = ringAt(H * p.crownMid.y, R * p.crownMid.radius);
  const table = ringAt(H * p.table.y, R * p.table.radius);

  soup.use('dark');
  soup.capDown([0, 0, 0], culet);
  soup.use('shade');
  soup.band(culet, pavilionMid);
  soup.use('deep');
  soup.band(pavilionMid, girdle);
  soup.use('mid');
  soup.band(girdle, crownMid);
  soup.use('light');
  soup.band(crownMid, table);
  soup.capUp([0, H, 0], table);

  return soup.build(H / 2);
}

/**
 * 宝箱的**单位形状**：全宽 = 1、高 = `heightOverWidth`、底面在 y = 0。
 *
 * 为什么先建单位形状再缩放，而不是「按目标尺寸直接建」：
 * 宝箱是箱形件，**外接直径不是全宽**（底裙角、拱盖下角、角柱外角谁最远要算），
 * 而这个系数一旦手推就会错（第一版拿包围盒对角线当外接直径，多算了 7%，
 * 宝箱会比设计的大一圈）。单位形状量出来的半径是**实测**的，改任何部件都自动跟上。
 */
function buildChestShape(): THREE.BufferGeometry {
  const W = 1;
  const H = CHEST_PROFILE.heightOverWidth;
  const c = CHEST_PROFILE;
  const soup = new Soup();

  const bX = W / 2;
  const bZ = W * c.depthOverWidth;
  /** 拱肋外半径 = 拱盖半深（实测 0.375W）。**总高由它定**：拱顶 = `springY + lZ`。 */
  const lZ = bZ * c.lidOverhang;
  /** 拱盖曲面半径：比肋内收一圈 ⇒ 两条箍凸出来。 */
  const lidR = lZ * c.lidRecess;
  /** 拱心（= 箱体顶）高度。由「拱顶正好等于总高」反推，不另设系数。 */
  const springY = H - lZ;
  const cut = W * c.chamfer;
  const baseTop = H * c.baseHeight;
  const rimY = springY - H * c.rimHeight;
  const hoopT = W * c.hoopWidth;
  const postHalf = W * c.postWidth;
  const proud = (W * c.postProud) / Math.SQRT2;
  const postX = bX - cut / 2 + proud;
  const postZ = bZ - cut / 2 + proud;
  const stripHalf = W * c.stripWidth;
  const stripZ = W * c.stripProud;
  const lockR = bZ * c.lockRadius;
  const lockY = springY * 0.62;
  const lockFace = bZ + stripZ;

  /** 半圆拱的弧点（`(z, y)`，从 +z 侧绕到 −z 侧）。 */
  const arch = (radius: number): Array<[number, number]> => {
    const out: Array<[number, number]> = [];
    for (let i = 0; i <= c.lidSegments; i += 1) {
      const t = (i / c.lidSegments) * Math.PI;
      out.push([Math.cos(t) * radius, springY + Math.sin(t) * radius]);
    }
    return out;
  };

  /** 正六边形（`(x, y)`，尖角朝 ±x）。 */
  const hexagon = (radius: number, y: number): Array<[number, number]> => {
    const out: Array<[number, number]> = [];
    for (let i = 0; i < 6; i += 1) {
      const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
      out.push([Math.cos(a) * radius, y + Math.sin(a) * radius]);
    }
    return out;
  };

  // ── ① 底裙（框架色）：比箱身宽一圈（实测底沿 0.373 vs 腰部 0.333） ──
  soup.use('light');
  soup.band(
    chamferRing(0, bX * c.baseFlare, bZ * c.baseFlare, cut),
    chamferRing(baseTop, bX, bZ, cut),
  );
  soup.capDown([0, 0, 0], chamferRing(0, bX * c.baseFlare, bZ * c.baseFlare, cut));

  // ── ② 箱体四面（面板色）：顶面被拱盖盖住，所以不铺顶盖 ──
  soup.use('deep');
  soup.band(chamferRing(baseTop, bX, bZ, cut), chamferRing(springY, bX, bZ, cut));

  // ── ③ 顶沿压条（框架色）：比箱体略出一圈，是「框架」的第一条横带 ──
  soup.use('light');
  soup.band(
    chamferRing(rimY, bX * c.rimOverhang, bZ * c.rimOverhang, cut),
    chamferRing(springY, bX * c.rimOverhang, bZ * c.rimOverhang, cut),
  );

  // ── ④ 四角立柱（框架色）：压在四条切角面上，沿对角向外推 `postProud` ──
  soup.use('light');
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      soup.box([sx * postX, springY / 2, sz * postZ], [postHalf, springY / 2, postHalf]);
    }
  }

  // ── ⑤ 拱盖曲面（面板色）：沿 x 的半圆桶，半径比肋小一圈 ──
  // 曲面铺满整个 x 跨度：两端伸进拱肋的实体里，于是接缝天然被盖住（不用另做端盖）。
  const inner = arch(lidR);
  const atX = (x: number): V3[] => inner.map(([z, y]) => [x, y, z]);
  const innerLeft = atX(-bX);
  const innerRight = atX(bX);
  soup.use('deep');
  for (let i = 0; i < c.lidSegments; i += 1) {
    soup.quad(innerLeft[i], innerRight[i], innerRight[i + 1], innerLeft[i + 1]);
  }

  // ── ⑥ 两条拱肋（框架色）：实心半圆棱柱，箍住拱盖两端 ──
  // 实心（而不是一圈薄壳）是为了自带端面 —— 参考模型上那两条箍的「厚度」正是靠端面读出来的。
  soup.use('light');
  soup.prismAlongX(arch(lZ), -bX, -bX + hoopT);
  soup.prismAlongX(arch(lZ), bX - hoopT, bX);

  // ── ⑦ 正面中央竖条（框架色）：锁板挂在它上面 ──
  soup.use('light');
  soup.box(
    [0, (baseTop + springY) / 2, bZ + stripZ / 2],
    [stripHalf, (springY - baseTop) / 2, stripZ / 2],
  );

  // ── ⑧ 锁板（框架色）→ 宝石（亮台面 + 暗侧面）→ 搭扣（墨色） ──
  soup.use('light');
  soup.prismZ(hexagon(lockR, lockY), lockFace, lockFace + W * c.lockProud);
  soup.use('shade');
  soup.prismZ(
    hexagon(lockR * c.gemScale, lockY),
    lockFace + W * c.lockProud,
    lockFace + W * c.lockProud + W * c.gemProud,
    'mid',
  );
  soup.use('dark');
  soup.box(
    [0, lockY - lockR * 0.86, lockFace + W * c.lockProud + lockR * 0.07],
    [lockR * 0.14, lockR * 0.2, lockR * 0.07],
  );

  // 单位形状**不平移**（底面留在 y = 0）：缩放之后才知道该往哪移。
  return soup.buildRaw();
}

let chestShapeCache: THREE.BufferGeometry | null = null;
let chestMetricCache: { radius: number; top: number } | null = null;

/** 宝箱的单位形状（缓存）。 */
function chestShape(): THREE.BufferGeometry {
  if (!chestShapeCache) chestShapeCache = buildChestShape();
  return chestShapeCache;
}

/**
 * 单位形状的**实测**指标：水平外接半径与总高。
 *
 * 「水平外接半径」= 所有顶点到中轴距离的最大值 —— 这正是「模型能不能塞进币的圆脚印」
 * 要比较的量。取顶点而不是包围盒角：包围盒角可能根本不是模型的点
 * （八边形、切角矩形都有这个问题）。
 */
function chestMetrics(): { radius: number; top: number } {
  if (chestMetricCache) return chestMetricCache;
  const position = chestShape().getAttribute('position');
  let radius = 0;
  let top = 0;
  for (let i = 0; i < position.count; i += 1) {
    radius = Math.max(radius, Math.hypot(position.getX(i), position.getZ(i)));
    top = Math.max(top, position.getY(i));
  }
  chestMetricCache = { radius, top };
  return chestMetricCache;
}

/** 宝箱外接直径 / 全宽（实测，≈ 1.255）。 */
export function chestSpanFactor(): number {
  return chestMetrics().radius * 2;
}

/** 宝箱总高 / 外接直径（实测，≈ 0.621）。 */
export function chestHeightFactor(): number {
  return chestMetrics().top / chestSpanFactor();
}

/**
 * 建议尺寸 —— **从币径派生**（默认 ×1.2 档：币径 **144 mm**、币厚 **24 mm**）。
 *
 * ## S16 起的两档（用户拍板：钻石 1.5×、宝箱 2.5×）
 *
 * | 件 | 外接直径 | 包围盒（宽 × 深） | 总高 | 相对币厚 | 质量（密度 780） |
 * |---|---|---|---|---|---|
 * | 钻石 | **216 mm** | 216 × 216 mm | **132 mm** | 5.49 × | 3.77 kg（普通币的 12.4 倍） |
 * | 宝箱 | **360 mm** | 321 × 258 mm | **224 mm** | 9.33 × | 14.5 kg（普通币的 47 倍） |
 *
 * ⚠️ 宝箱的「包围盒宽」**不是**外接直径：外接直径是「最远顶点到中轴的距离 × 2」，
 * 那个顶点是**底裙的切角**（`(0.56, 0.283)`），不是 x 轴上的点。
 * 第一版把这两个混为一谈，写下了「全宽 105 mm」—— 那个数是 `1 / 外接直径比` 算出来的，
 * 只有当最远顶点正好落在 x 轴上时才成立（钻石就是，宝箱不是）。
 *
 * ⚠️ **「高/宽」是参考模型的硬比例，不能为了压扁而改**（改了就不是那个东西了）。
 * 所以这两件模型**必然比一枚币厚 5~9 倍** —— 碰撞体跟着换形状（见 `coinColliderSpec`），
 * 而不是把模型压进 24 mm（那会变成浮雕，切面全丢）。
 */
export function coinModelSpec(kind: CoinModelKind): CoinModelSpec {
  const diameter = COIN.radius * 2 * MODEL_DIAMETER_RATIO[kind];
  if (kind === 'diamond') {
    return { diameter, height: diameter * DIAMOND_PROFILE.aspect };
  }
  return { diameter, height: diameter * chestHeightFactor() };
}

/** 色调档位。**顺序 = 色板图集里从左到右的条序**，不要重排（改序会让所有面的颜色错位）。 */
export const MODEL_TONES = ['light', 'mid', 'deep', 'shade', 'dark'] as const;
export type ModelTone = (typeof MODEL_TONES)[number];
export type CoinModelPalette = Record<ModelTone, string>;

/**
 * 从锁定配色派生 5 档色调。
 *
 * `lerp` 在**线性空间**做（`THREE.Color` 构造出来就是线性的），所以不需要任何
 * sRGB 转换 —— 多转一次就是本项目踩过两次的那个静默 bug。派生完立刻转回十六进制。
 */
export function coinModelPalette(kind: CoinModelKind): CoinModelPalette {
  const locked = KINDS[kind as CoinKindId].lockedPalette;
  const base = new THREE.Color(locked?.base ?? '#cccccc');
  const dark = new THREE.Color(locked?.dark ?? '#777777');
  const ink = new THREE.Color(locked?.ink ?? '#333333');
  const hex = (color: THREE.Color): string => `#${color.getHexString()}`;
  const mix = (a: THREE.Color, b: THREE.Color, t: number): string => hex(a.clone().lerp(b, t));
  return {
    light: hex(base),
    mid: mix(base, dark, 0.45),
    deep: hex(dark),
    shade: mix(dark, ink, 0.5),
    dark: hex(ink),
  };
}

/**
 * 某一档色调在图集里的**纹素中心 UV**。
 *
 * `u` 取条带正中 `(i + 0.5) / 条数`：`NearestFilter` 下它一定落在第 i 条内部。
 * 每条宽度 `1/5` 在 64 纹素上是 12.8 格（非整数），但采样点离边界至少 2 格，
 * 所以不依赖条宽是否整除。
 */
export function toneUv(tone: ModelTone): [number, number] {
  return [(MODEL_TONES.indexOf(tone) + 0.5) / MODEL_TONES.length, 0.5];
}

/**
 * 几何体缓存。
 *
 * 缓存的理由不只是省 CPU：**碰撞体规格是从几何体的 AABB 反算的**（见 `coinColliderSpec`），
 * 每次重建几何体会得到一份浮点末位不同的 AABB，于是「模型 ≤ 碰撞体」这条判据
 * 会在边界上随机抖 —— 缓存让两者**引用同一个数**。
 */
const geometryCache = new Map<CoinModelKind, THREE.BufferGeometry>();

/** 取某个模型币种的几何体（**缓存**，渲染与碰撞体共用同一份）。 */
export function coinModelGeometry(kind: CoinModelKind): THREE.BufferGeometry {
  const cached = geometryCache.get(kind);
  if (cached) return cached;

  let geometry: THREE.BufferGeometry;
  if (kind === 'diamond') {
    geometry = buildDiamondGeometry();
  } else {
    const spec = coinModelSpec('chest');
    const scale = spec.diameter / 2 / chestMetrics().radius;
    geometry = chestShape().clone();
    geometry.scale(scale, scale, scale);
    // 单位形状底面在 y = 0、顶在 heightOverWidth；缩放后顶在 spec.height。
    geometry.translate(0, -spec.height / 2, 0);
  }
  geometryCache.set(kind, geometry);
  return geometry;
}

/**
 * 释放模型几何体的 GPU 资源并**清空缓存**。
 *
 * ⚠️ 必须「释放 + 清缓存」成对：只释放不清缓存的话，下一个 `CoinPool` 会拿到
 * 一份**已经 dispose 过**的几何体（three 不会报错，只是渲染出空 —— 零报错的静默失效）。
 */
export function disposeCoinModelGeometries(): void {
  for (const geometry of geometryCache.values()) geometry.dispose();
  geometryCache.clear();
}

/** 模型币种清单（渲染分组、材质表、验证判据都按它分区）。 */
export const COIN_MODEL_KINDS: CoinModelKind[] = ['diamond', 'chest'];

/** 某个币种是不是低多面体模型币种。 */
export function isCoinModelKind(kind: CoinKindId): kind is CoinModelKind {
  return (COIN_MODEL_KINDS as string[]).includes(kind);
}

/**
 * 碰撞体规格。
 *
 * ## 为什么必须跟着模型换形状
 *
 * 模型高 76~82 mm，而普通币只有 24 mm（**3.2~3.4 倍**）。用原来的扁平圆柱碰撞体装不进去，
 * 后果不是「穿模一点点」而是**两枚模型币视觉上互相插进对方身体里**。
 *
 * ## 形状怎么选
 *
 * - **普通币**：原样（扁平圆柱）。**这一支必须逐位不变** —— 它是整套物理标定的基准，
 *   动一位就要重标返值表。
 * - **钻石**：圆柱。八边形脚印内接于圆，半径取 AABB 的 x/z 极值 = 腰棱半径。
 * - **宝箱**：长方体。它是箱形件，用圆柱会在四角留出 1.5 倍的缝；
 *   长方体的半尺寸直接取 AABB，**模型恰好装进去**。
 *
 * ⚠️ 半尺寸**从几何体的 AABB 反算**，不手抄 0.088 / 0.0491 之类的数 ——
 * 手抄一份就等于「模型 ≤ 碰撞体」这条纪律多了一个可以悄悄失配的副本。
 */
export type CoinColliderSpec =
  | { shape: 'cylinder'; radius: number; halfHeight: number }
  | { shape: 'cuboid'; halfExtents: [number, number, number] };

/** 碰撞体规格的**唯一**来源（普通币与模型币都在这里分派）。 */
export function coinColliderSpec(kind: CoinKindId): CoinColliderSpec {
  if (!isCoinModelKind(kind)) {
    return { shape: 'cylinder', radius: COIN.radius, halfHeight: COIN.halfThickness };
  }
  const box = coinModelGeometry(kind).boundingBox;
  if (!box) throw new Error(`模型币种 ${kind} 的几何体没有包围盒。`);
  const halfY = box.max.y;
  if (kind === 'diamond') {
    // 八边形脚印：外接半径就是 AABB 在 x/z 上的极值。
    return { shape: 'cylinder', radius: Math.max(box.max.x, box.max.z), halfHeight: halfY };
  }
  return { shape: 'cuboid', halfExtents: [box.max.x, halfY, box.max.z] };
}

/** 碰撞体的稳定字符串键（用来判断「这次 spawn 需不需要真的改形状」）。 */
export function coinColliderKey(spec: CoinColliderSpec): string {
  if (spec.shape === 'cylinder') return `cyl:${spec.radius.toFixed(5)}:${spec.halfHeight.toFixed(5)}`;
  return `cub:${spec.halfExtents.map((v) => v.toFixed(5)).join(':')}`;
}

/**
 * 碰撞体的**高度**（米）——「一层币有多厚」的唯一来源。
 *
 * 存在理由：`ShowDirector` 的塔层高与闸板下沿都按「一层 = 币厚」写死过。
 * 模型币的碰撞体是 3 倍厚，写死的那两处会让塔**自相重叠**（求解器把整座塔弹飞，
 * 触发 `anomalies`），以及闸板**扫过静置币**。两处都必须读这里。
 */
export function coinColliderHeight(kind: CoinKindId): number {
  const spec = coinColliderSpec(kind);
  return spec.shape === 'cylinder' ? spec.halfHeight * 2 : spec.halfExtents[1] * 2;
}

/**
 * 「模型 ≤ 碰撞体」判据的容差（米）。
 *
 * ⚠️ **不能取 0，也不能取 1e-9**：顶点位置存在 `Float32BufferAttribute` 里
 * （float32 在 0.05~0.13 这个量级上相对误差 ~6e-8），而碰撞体的半径是
 * `Math.max(box.max.x, box.max.z)` 这种 float64 派生量。
 * 于是八边形 45° 那个顶点的 `hypot(x, z)` 会比碰撞体半径**大出 1e-8 量级**，
 * 被当成「越界」—— 实测在 ×1.1 档位报出 24 个越界顶点、最差超出 0.0000 mm，
 * 而在 ×1.2 档位又恰好是 0 个（舍入方向不同）。**这是掷骰子式的假红。**
 *
 * 取 1 微米：比 float32 噪声大 100 倍，比任何真实设计失配（毫米级，
 * 踩过的锁孔 bug 差 12 mm）小 100 倍。
 */
const COLLIDER_EPSILON = 1e-6;

/** 单个模型币种的结构自检读数。 */
export type CoinModelAudit = {
  kind: CoinModelKind;
  vertices: number;
  triangles: number;
  indexed: boolean;
  /** 三个顶点法线都等于几何面法线的三角形数（应当 == `triangles`）。 */
  flatFaces: number;
  /** 出现过的不同 UV 值个数（图集方案下应当 == 色调档数 5）。 */
  uvDistinct: number;
  /** 面内三顶点 UV 完全相同的三角形数（应当 == `triangles`）。 */
  uvFlatFaces: number;
  /** 落在碰撞体之外的顶点数（必须 0）。 */
  modelOutsideCollider: number;
  worstOutMillimeters: number;
  /** **实测**外接直径（顶点到中轴最大距离 × 2）。 */
  circumscribed: number;
  specDiameter: number;
  specHeight: number;
  collider: CoinColliderSpec;
  colliderHeight: number;
  heightOverCoinThickness: number;
  circumscribedOverCoin: number;
  palette: CoinModelPalette;
  /** `KINDS[kind].lockedPalette` 原样（可能是 `null` —— 未锁定配色的币种）。 */
  lockedPalette: { base?: string; dark?: string; ink?: string } | null;
};

/**
 * 结构自检（验证脚本的 `models` 模式消费）。
 *
 * 这几条性质**肉眼看不出来**，只能算 —— 所以按项目纪律把它们写成**计数**，
 * 而不是靠看截图（截图里「面被糊成球面」「币互相插进身体里」都只差一点）。
 *
 * | 判据 | 为什么它是硬判据 |
 * |---|---|
 * | `indexed === false` | 索引几何会合并顶点 → `computeVertexNormals()` 走「按顶点平均」→ 硬切面糊成球面 |
 * | `flatFaces === triangles` | 上一条的**结果判据**（比「有没有 index」更本质） |
 * | `modelOutsideCollider === 0` | 违反 = 两枚币视觉互相插进对方身体，截图很难判 |
 * | `uvFlatFaces === triangles` | 面内 UV 相同才是一面一平色；否则图集退化成「每面自己插值出渐变」 |
 * | `uvDistinct === 5` | 图集确实只有 5 档，没有面采样到条带边界上 |
 * | `circumscribed === specDiameter` | 两者不等 = 有个部件偷偷伸到设计范围之外（踩过：锁孔撑大 10%） |
 */
export function coinModelAudit(): CoinModelAudit[] {
  return COIN_MODEL_KINDS.map((kind) => {
    const geometry = coinModelGeometry(kind);
    const position = geometry.getAttribute('position');
    const normal = geometry.getAttribute('normal');
    const uv = geometry.getAttribute('uv');
    const spec = coinModelSpec(kind);
    const collider = coinColliderSpec(kind);

    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const ab = new THREE.Vector3();
    const ac = new THREE.Vector3();
    const face = new THREE.Vector3();
    const vertexNormal = new THREE.Vector3();

    let triangles = 0;
    let flatFaces = 0;
    let uvFlatFaces = 0;
    let outside = 0;
    let worstOut = 0;
    let radial = 0;
    const uvs = new Set<string>();

    for (let t = 0; t < position.count; t += 3) {
      triangles += 1;
      a.fromBufferAttribute(position, t);
      b.fromBufferAttribute(position, t + 1);
      c.fromBufferAttribute(position, t + 2);
      face.copy(ab.subVectors(b, a).cross(ac.subVectors(c, a)).normalize());

      let flat = true;
      for (let k = 0; k < 3; k += 1) {
        vertexNormal.fromBufferAttribute(normal, t + k);
        // 阈值 1e-4 ≈ 0.006°，远小于任何真实切角 —— 只在「确实共面」时通过。
        if (face.dot(vertexNormal) <= 1 - 1e-4) flat = false;
      }
      if (flat) flatFaces += 1;

      const key = (i: number): string => `${uv.getX(i).toFixed(6)},${uv.getY(i).toFixed(6)}`;
      uvs.add(key(t));
      if (key(t) === key(t + 1) && key(t) === key(t + 2)) uvFlatFaces += 1;

      for (const point of [a, b, c]) {
        radial = Math.max(radial, Math.hypot(point.x, point.z));
        const out =
          collider.shape === 'cylinder'
            ? Math.max(
                Math.hypot(point.x, point.z) - collider.radius,
                Math.abs(point.y) - collider.halfHeight,
              )
            : Math.max(
                Math.abs(point.x) - collider.halfExtents[0],
                Math.abs(point.y) - collider.halfExtents[1],
                Math.abs(point.z) - collider.halfExtents[2],
              );
        if (out > COLLIDER_EPSILON) outside += 1;
        worstOut = Math.max(worstOut, out);
      }
    }

    return {
      kind,
      vertices: position.count,
      triangles,
      indexed: geometry.getIndex() !== null,
      flatFaces,
      uvDistinct: uvs.size,
      uvFlatFaces,
      modelOutsideCollider: outside,
      worstOutMillimeters: worstOut * 1000,
      circumscribed: radial * 2,
      specDiameter: spec.diameter,
      specHeight: spec.height,
      collider,
      colliderHeight: coinColliderHeight(kind),
      heightOverCoinThickness: spec.height / (COIN.halfThickness * 2),
      circumscribedOverCoin: (radial * 2) / (COIN.radius * 2),
      palette: coinModelPalette(kind),
      lockedPalette: KINDS[kind].lockedPalette,
    };
  });
}
