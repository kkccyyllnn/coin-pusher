import { TABLE } from './constants';

/**
 * 机柜**外形**尺寸真源（S19）。
 *
 * ## 为什么单独一个文件
 *
 * S19 之前这些数字全是 `buildCabinetShell()` 函数体里的局部 `const`
 * （`halfWidth` / `trimOverhang` / `trimThickness` / `baseFrontZ`）。后果不是「不好看」，
 * 而是**没有任何东西能引用它们**：
 *   - 判据（`verify-game.mjs`）想核对尺寸，只能把公式**手抄第二份** ——
 *     而「第二份公式」正是本仓库明令禁止的东西（它会与真源分叉，然后开始骗人）；
 *   - 导出工具（`tools/cabinet-export.ts`）同样读不到；
 *   - 几何自己长什么样，只有渲染出来才知道。
 *
 * 于是 S18 那次「围合件」把 shape 的 +y 映到了世界 −z（`rotateX(-π/2)` 的方向反了），
 * 一块 1.78 × 1.77 × 1.97 米的**实心砖**盖在了玩家这一半台面上、
 * 糊满整个画面 —— 而当时 `perf` / `drawcall` / `programs` / `cabinetTex` / `models`
 * **全绿**。没有一条判据在看画面，也没有一条判据能看：尺寸根本不在可引用的地方。
 *
 * 所以这个文件的职责只有一个：**让「机柜长什么样」成为可被引用、可被断言的数据。**
 *
 * ## 坐标系
 *
 * 与 `constants.ts` 完全同一套：单位米、y 朝上、**+z 朝玩家**、x 向右。
 * 机柜关于 x = 0 对称（S19 之前实测偏 2.5 毫米，见 `CABINET` 的注释）。
 *
 * ## 与碰撞体的关系：**刻意不同源**
 *
 * 本文件只描述**看得见的壳**。币真正撞到的是 `TableBuilder.buildTable(world)` 里
 * 手写的 `ColliderDesc.cuboid`，两者刻意不共用一份数字：
 *   - 侧壁碰撞体厚 0.24 米（视觉 0.06），是为了让「挤穿翻面」在物理上不可能
 *     （见 `SIDE_WALL_HALF` 的推导）；
 *   - 后墙碰撞体内表面必须在 `TABLE.backZ`，与背板面板的前表面重合。
 * 唯一被**钉死**的接口是：**侧墙的内表面必须与侧壁碰撞体的内表面同在一个 x 平面**
 * （见 `wall.innerX`），否则币会停在离可视墙一条缝的地方 —— 看得见的墙摸不到。
 */

/**
 * 顶板 / 檐板的**内表面** z（米）＝ 檐板前立面的背面 ＝ 顶板的最前缘。
 *
 * 取值来源：用户手搭的模型 `artifacts/cabinet-obj/coin-pusher-cabinet_test.obj`
 * 里实测的台阶位置（0.1948，内表面）/（0.2848，外表面），取整到 0.195。
 *
 * ★★ S21 之前这个数与侧墙台阶是**同一个常量**（`STEP_Z`），注释里还写死
 * 「两者必须共用」。二轮造型（批注 ③「侧墙高段内收」）之后两者**不再共面**：
 *   - 侧墙高段的后退到 `WALL_INSET_Z`（−0.12）；
 *   - 顶板 / 檐板**不许**跟着退 —— 退了机柜顶的前方就开天窗了。
 * 所以拆成两个常量，各自带注释说明它为什么取这个值：
 * 「侧墙分界」与「顶板前沿」从此是**两件事**，改一个不再顺手动另一个。
 */
const HOOD_FRONT_Z = 0.195;

/**
 * 侧墙高段**内收后**的前沿 z（米）＝ 高段主面的前表面。
 *
 * S21 二轮造型（用户批注 ③）：高段从这个位置退到 −0.12，退出来的空间由
 * **「檐板托」**补回顶部 —— 所以侧面读作「高段后退 / 与檐板斜接 / 与低段斜接」，
 * 而不是简单地把侧板切短。折线见 `cabinetWallOutline()`。
 *
 * ★ 取值来源不同于本文件其他数字：它**不是**从手搭模型量的，而是从用户的
 * 侧板参考截图按 320 px/m 量出来的（原图线段落在 −0.12 附近）。
 * 量图口径记在 `PLAN-v4.md` 之外的 S21 计划里；要改就是改这一个数。
 */
const WALL_INSET_Z = -0.12;

/**
 * 檐板**下沿** y（米）。
 *
 * ★ 它是**两条几何的交汇面**，一处改动必须同时看两件：
 *   - `hood.valanceBottomY`：檐板自己的底面；
 *   - `wall.miterFrontY`：侧墙「檐板托」那条**斜接面**的前端 —— 斜接面正是从
 *     `(HOOD_FRONT_Z, VALANCE_BOTTOM_Y)` 退到 `(WALL_INSET_Z, wall.insetTopY)`。
 * 两者共用一个常量才能保证「檐板托托住檐板」这条接口不会各写一份而分叉。
 */
const VALANCE_BOTTOM_Y = 1.294;

/**
 * 机柜**顶面**高度（米）。顶板上表面、侧墙高段顶、檐板上沿全都在这一条线上。
 *
 * 实测来源同 `HOOD_FRONT_Z`（用户模型 1.6428）。取整到 1.643 之后，
 * 整个机柜的顶是一个**平的**面（侧墙 + 顶板 + 檐板一块平），
 * 不再有 S19 之前那种「顶沿比侧板高 3 厘米」的错台。
 */
const ROOF_TOP_Y = 1.643;

/**
 * 顶板**下表面**高度（米）。
 *
 * 顶板厚 = `ROOF_TOP_Y - ROOF_UNDER_Y` = 0.09（用户模型 1.5528 → 1.6428）。
 * 这同时是「机柜内腔的天花板」：币被求解器弹到 1.55 米以上时会撞到它 ——
 * 但注意**它没有碰撞体**（顶墙围板只到 `GLASS_TOP` = 1.60），这是对的：
 * 币的弹射拦截由围板负责，顶板只是外观。
 */
const ROOF_UNDER_Y = 1.553;

/** 背板厚（米）。用户手搭的模型给的就是 0.06 —— 与侧墙同厚。 */
const BACK_THICKNESS = 0.06;

/** 侧墙板厚（米）。背板的**半宽**由它派生，所以也不能各写一遍。 */
const WALL_THICKNESS = 0.06;

/**
 * 外壳**后缘** z（米）＝ 机柜最后面那一个平面 ＝ 背板的**外**表面。
 *
 * ★ 侧墙、顶板、背板三件的后缘全都在这一条线上（`wall.backZ` / `hood.backZ` /
 * `back.backZ` 指的都是它）。三处共用一份 —— 不许各写一遍 `TABLE.backZ - 0.06`。
 *
 * ★★ 由「背板前表面 = `TABLE.backZ`」+ 板厚**派生**，两个方向都被钉死：
 *   - 前表面是 S16 定下的**碰撞体接口**（后墙碰撞体的内表面就在那儿）；
 *   - 外表面是外壳的最后缘。
 * 中间这 0.06 米就是背板本身 —— 它既是「看得见的机柜背板」，也覆盖着
 * **后墙碰撞体**所在的那段空间（碰撞体 `z ∈ [-1.47, -1.35]`，纯逻辑、不可见），
 * 老虎机（`slotFrame` 等，`z ≈ -1.30 ~ -1.355`）就贴在这块面板的前表面上。
 *
 * ## ⚠️ 与手搭模型的一处**有意偏差**（S19 修正）
 *
 * 模型里侧墙 / 顶板的后缘停在 **−1.3832**，而背板是 `[-1.41, −1.35]` 的一块 6 厘米板
 * ⇒ 背板比外壳最后缘还**多探出 2.7 厘米**，侧墙的后端反过来嵌在背板内部。
 * 这是 C4D 里「板子一件件摆上去」留下的，不是设计意图：一个封闭机柜
 * 不该有一块板从背后鼓出来。
 *
 * S19 把侧墙 / 顶板的后缘推到与背板外表面**共面**（−1.41）。多出来的 2.7 厘米
 * 完全落在背板内部 ⇒ **看不见**，但机柜从此是一个后缘齐平的封闭体，
 * 判据也才敢断言「三件后缘共面」。
 *
 * 另一种改法是反过来把背板压到 3 厘米去迁就侧墙 —— 但那等于改掉模型的板厚，
 * 而「墙多长 2.7 厘米埋进板里」没有任何代价。所以偏差选在这个方向。
 */
const SHELL_BACK_Z = TABLE.backZ - BACK_THICKNESS;

/**
 * 侧墙与背板的**下沿** y（米）。两者共线（都由同一个值给出）。
 *
 * 伸到地板以下是为了让下沿藏进地板侧面 —— 旧护栏从 `y = 0` 起，会露出地板边。
 * 具体取值不影响画面（整段都在地板以下），共线才是要求。
 */
const SHELL_BOTTOM_Y = -0.26;

/**
 * 檐板**外**表面 z（米）。
 *
 * 铺面上的含义是「机柜顶面在 z 方向上最靠玩家的一条边」。
 *
 * S19~S20 时它还兼作招牌 `marquee.hingeZ`（招牌挂在这一条棱上）；
 * S21 删掉招牌那一件之后，檐板自己就是招牌画布（见 `TableBuilder.buildHood`），
 * 这个数不再有第二个消费者。
 */
const VALANCE_FRONT_Z = 0.285;

/**
 * 单件的**倒角**（`roundedBox` 的圆角半径与分段数）。
 *
 * ## 为什么它是「件」的属性，而不是一个模块常量
 *
 * 原本 `CORNER_RADIUS` / `CORNER_SEGMENTS` 是 `TableBuilder` 的函数体局部常量，
 * 于是「顶板圆一点、背板方一点」这种要求只能靠改代码再刷新 —— 而造型恰恰是要
 * **看着调**的。挪进真源之后，`?model` 面板可以逐件拖，`cabinetShapeDiff()`
 * 也算得出来、导得出去。
 *
 * ## ⚠️ 倒角只作用于直角盒件（`cabinetBoxMesh`）
 *
 * 剖面挤出件（侧墙两段）**保持尖边**。这不是偷懒：
 * `verify-game.mjs cabinet` 的 ⑤b 是拿几何顶点集合与 `cabinetWallOutline()`
 * 逐点比对的，给剖面加倒角会凭空多出顶点，那条判据当场红。
 * 要改侧墙的「边」，改的是**折线**（也就是角度）—— 那正是
 * `cabinetWallOutline()` 覆盖的东西。
 */
export type CabinetPartBevel = {
  /** 圆角半径（米）。`RoundedBoxGeometry` 会把它夹到 `min(w,h,d)/2`，薄板安全。 */
  radius: number;
  /** 圆角分段。1 段 ≈ 一圈 45° 倒角，2 段起才读得出「圆」。 */
  segments: number;
};

/**
 * 机柜外壳的**可编辑形状**。
 *
 * ## 为什么需要这一层
 *
 * `CABINET` 是**编译期默认值**，也是提交进仓库的那一份。运行期的实际取值走
 * `cabinetShape()`，而它**只在 `?model` 模型模式下**才可能不等于 `CABINET`
 * （见本文件末尾的覆盖层）。
 *
 * 这样做的结果是：「构建读到的」与「判据读到的」在非 `?model` 下永远是同一份
 * ⇒ 模型模式对 `verify-game.mjs` 与 playwright 套件**零影响**，
 * 不需要给任何判据加「忽略调参」的分支。
 *
 * 字段与 `CABINET` 逐一对齐；唯一的例外是 `bevel`（运行期新增的一档）。
 */
export type CabinetShape = {
  wall: {
    innerX: number;
    thickness: number;
    backZ: number;
    bottomY: number;
    insetZ: number;
    hoodFrontZ: number;
    miterFrontY: number;
    insetTopY: number;
    lowRoofBackY: number;
    lowRoofFrontY: number;
    lowFrontZ: number;
    tallTopY: number;
  };
  hood: {
    halfWidth: number;
    backZ: number;
    underY: number;
    topY: number;
    valanceInnerZ: number;
    valanceFrontZ: number;
    valanceBottomY: number;
  };
  back: {
    halfWidth: number;
    thickness: number;
    frontZ: number;
    backZ: number;
    bottomY: number;
    topY: number;
  };
  bevel: {
    /** 全局默认倒角（逐件没有覆盖时用它）。 */
    radius: number;
    segments: number;
    /** 逐件覆盖，键 = `CabinetShellPart`。空 = 全部走上面的全局值。 */
    perPart: Partial<Record<CabinetShellPart, CabinetPartBevel>>;
  };
};

/**
 * 机柜外壳的**全部**外形尺寸。
 *
 * ⚠️ 左右完全对称（S19 修正）：用户手搭的那版模型左右差了 5 毫米
 * （左内表面 −0.8144 / 右 +0.8194，即整件沿 +x 偏了 2.5 毫米）—— 那是 C4D 里
 * 手工挪件留下的，不是设计意图。这里按镜像对称重建，并由 `cabinet` 判据钉死
 * （`左墙 |min.x| === 右墙 max.x`，容差 1e-6）。
 */
export const CABINET = {
  /**
   * 侧墙。左右各一块 —— 每边**两段**（高段含檐板托 / 低段斜顶）拼成一条连续轮廓，
   * 分界线是 `insetZ` 那条竖直面。折线真源见 `cabinetWallOutline()`。
   */
  wall: {
    /**
     * 内表面 |x|（米）。
     *
     * ★★ **必须等于 `TABLE.halfWidth`**（0.80），也就是侧壁碰撞体的内表面。
     *
     * 依据：旧的可视护栏内表面就正好在 ±0.80（`BoxGeometry(0.06, 0.46, 3.5)` 落在
     * `side * (halfWidth + railThickness)`，即 ±0.83 中心、厚 0.06 ⇒ 内表面 ±0.80），
     * 与碰撞体齐平。用户那版模型把内表面放到 0.815，会留出 **15 毫米的缝**：
     * 币撞到碰撞体（0.80）就停了，而视线里的墙还在 0.815，看上去「墙摸不到」。
     *
     * 反方向（把碰撞体也挪到 0.815）**不可接受**：那等于把币床净宽从 1.60 改成 1.63，
     * 是币床几何变更 ⇒ 按本仓库铁律必须重标返值表。所以让视觉件回到 0.80。
     */
    innerX: TABLE.halfWidth,
    /** 板厚（米）。与旧护栏 / 旧侧板同为 0.06。 */
    thickness: WALL_THICKNESS,
    /** 后缘 z：与背板外表面同一平面。 */
    backZ: SHELL_BACK_Z,
    /** 下沿 y：伸到地板**以下**，尾端藏进地板侧面里（旧护栏从 y=0 起，会露出地板边）。 */
    bottomY: SHELL_BOTTOM_Y,
    /**
     * 高段前沿 z（内收后）＝ 低段后沿 z —— ★ **两段共用这一条竖直面**。
     *
     * 这就是批注 ⑤ 说的「两段融合」：S21 之前两段在一个**台阶**（`STEP_Z` = 0.195）
     * 处对接 —— 低段在此处高 0.647、高段在此处到顶 1.643，侧面看是两件东西；
     * 现在两段在同一个 z 上换段，接缝是一条竖直缝，侧面读作**一条连续轮廓**。
     * 色带分界（`rail` / `panel`）也落在这一面。
     */
    insetZ: WALL_INSET_Z,
    /**
     * 「檐板托」前缘 z：与檐板内表面同面（`HOOD_FRONT_Z`）。
     *
     * ★ 高段内收之后**仍然**要保留这一段伸到 `HOOD_FRONT_Z` 的檐板托，
     * 否则 `verify-game.mjs` 那条「檐板内表面 = 侧墙台阶」会红，
     * 而且檐板会变成只靠顶板前缘连着的悬臂。
     */
    hoodFrontZ: HOOD_FRONT_Z,
    /** 「檐板托」斜接面**前端** y：与檐板下沿同一条线（`VALANCE_BOTTOM_Y`）。 */
    miterFrontY: VALANCE_BOTTOM_Y,
    /**
     * 内收面（竖直面 @ `insetZ`）的**顶** y ＝ 斜接面**后端**。
     *
     * 斜接面 = `(hoodFrontZ, miterFrontY) → (insetZ, insetTopY)` 这一段：
     * 深 `hoodFrontZ − insetZ` = 0.315 米、降 0.074 米，约 13°。
     */
    insetTopY: 1.22,
    /**
     * 低段斜顶·后端（@ `insetZ`）y。
     *
     * 原值 0.647（平顶）；批注 ⑤「降低 1/3」⇒ 0.647 × 2/3 ≈ 0.43，取整到 0.44。
     * ⚠️ 它现在**低于 `TABLE.railHeight`（0.46）** —— 这是**有意的**（照参考图做）：
     * 物理护栏仍是 0.46，`y ∈ (0.32, 0.46)` 这一段变成「币撞得到、看得见的是斜顶」。
     * 后果与判据改写见 `verify-game.mjs` 的「可视围挡」那一条。
     */
    lowRoofBackY: 0.44,
    /** 低段斜顶·前端（@ `lowFrontZ`）y：比后端再低 0.12 米（参考图量得 ≈0.32）。 */
    lowRoofFrontY: 0.32,
    /** 低段前缘 z：与地板剪影前缘齐（`FLOOR_FRONT_Z`）。 */
    lowFrontZ: TABLE.scoreLineZ + 0.04,
    /** 高段顶 y：与机柜顶面齐平。 */
    tallTopY: ROOF_TOP_Y,
  },

  /**
   * 顶板 + 檐板：手搭模型里是**一整块** L 形钣金（沿 x 挤出）。
   *
   * 实际建网格时拆成两件直角盒（`hoodRoof` / `hoodValance`）—— 外形与 L 形完全一致，
   * 但两件各自有一个解析包围盒，判据才比对得上；合成一件的话判据只能比并集，
   * 「檐板位置写错」这一类缺陷会被放走。见 `TableBuilder.buildHood`。
   *
   * ★ S21：招牌 `marquee` 被删掉之后，**檐板自己就是招牌画布**
   * （`Game.pickCabinetMap` 本来就把它分到招牌贴图那一支）。
   * 它的正面 `1.6 × 0.349` 米，比原招牌矮而宽 ⇒ 画布会被垂直压缩，见 S21 计划 §3.2。
   */
  hood: {
    /** 半宽：正好落在两侧墙的**内表面之间**（±0.80），与墙的内表面严丝合缝。 */
    halfWidth: TABLE.halfWidth,
    backZ: SHELL_BACK_Z,
    /** 顶板下表面（= 内腔天花板）。 */
    underY: ROOF_UNDER_Y,
    /** 顶板上表面。 */
    topY: ROOF_TOP_Y,
    /**
     * 檐板内表面 z = 顶板最前缘。
     * ★ 用 `HOOD_FRONT_Z`（0.195），**不是**侧墙的 `wall.insetZ`（−0.12）：
     * 侧墙内收之后机柜顶的前沿没动，檐板仍与「檐板托」的前缘同面。
     */
    valanceInnerZ: HOOD_FRONT_Z,
    /** 檐板外表面 z。厚度 = `valanceFrontZ - valanceInnerZ` = 0.09。 */
    valanceFrontZ: VALANCE_FRONT_Z,
    /** 檐板下沿 y：与侧墙「檐板托」斜接面的前端共线（`VALANCE_BOTTOM_Y`）。 */
    valanceBottomY: VALANCE_BOTTOM_Y,
  },

  /**
   * 背板。**S19 从 S18 手里拿回来的**一件。
   *
   * S18 把「背板 + 侧板 + 顶沿」合并成一块挤出件，同时删掉了独立的背板网格 ——
   * 而那块挤出件朝向反了。于是 S18 之后**机柜背面是空的**：
   * 背墙碰撞体（`z ∈ [-1.47, -1.35]`）后面什么都没有，
   * 而老虎机（`slotFrame` / `slotReelWindow` / `slotLamp` 在 `z ≈ -1.30 ~ -1.355`）
   * 等于悬空挂在碰撞体上。用户手搭的模型保留了这一件，尺寸与 S18 之前一致。
   */
  back: {
    /**
     * 半宽 —— ★ 与侧墙**外表面**（`innerX + thickness`）同一平面。
     * **派生**，不硬编码 0.86：背板比侧墙宽一点或窄一点都会在机柜后角露出错台。
     */
    halfWidth: TABLE.halfWidth + WALL_THICKNESS,
    thickness: BACK_THICKNESS,
    /**
     * **前**表面 z —— ★★ 必须正好落在 `TABLE.backZ`。
     *
     * 后墙碰撞体的内表面就在那儿，币撞到碰撞体就是撞到看得见的背板（S16 接口）。
     * 判据直接断言 `cabinetPartBox('backPanel').max[2] === TABLE.backZ`。
     */
    frontZ: TABLE.backZ,
    /**
     * **外**表面 z ＝ 外壳最后缘。= `frontZ − thickness`。
     *
     * ⚠️ 直接用 `SHELL_BACK_Z`（与 `wall.backZ` 是同一个平面），不再写第二份算式。
     *
     * S19 之前这里写的是「`z: SHELL_BACK_Z` + `thickness: WALL_THICKNESS`」——
     * 同一个常量在侧墙上当**后缘**用、在背板上却当**中心**用，于是背板的外表面
     * 跑到 −1.41，比侧墙后缘多探出 3 厘米。（判据是这一轮才加的：
     * 在此之前这件事**没有任何观测通道**。）
     */
    backZ: SHELL_BACK_Z,
    /** 下沿 y：与侧墙共线（都藏在地板以下）。 */
    bottomY: SHELL_BOTTOM_Y,
    /**
     * 上沿 y：**与顶板上表面齐平**。
     *
     * 手搭模型给的是 1.65（比顶板高 7 毫米），差出来的这一条会从顶面后缘
     * 露出一道 7 毫米的棱 —— 既然要求「机柜顶是一个平面」，就取同一个值。
     */
    topY: ROOF_TOP_Y,
  },

  /**
   * 倒角（S24）。逐件可覆盖，空表 = 全部走全局值。
   *
   * 取值沿用 S19~S23 的 `CORNER_RADIUS = 0.015` / `CORNER_SEGMENTS = 2`，
   * 所以默认行为与之前**逐位一致** —— 这一档只是把常量挪进真源，不是改造型。
   *
   * ⚠️ 1.5 厘米在 1.6 米宽的机柜上是 1%：480p 下不到一个像素，
   * 所以画面上读不到任何高光带。要「像压铸件」，这个数得按**构件尺寸**给
   * （大件 2~3 厘米），而不是按「薄板别穿帮」给。薄板有 `RoundedBoxGeometry`
   * 的自动夹取兜着（半径被夹到 `min(w,h,d)/2`），调大了不会穿。
   */
  bevel: {
    radius: 0.015,
    segments: 2,
    perPart: {},
  },

  /**
   * ## ☠️ S21 删掉的 `marquee`（招牌）
   *
   * 这里原本有一块 `width 1.6 / height 0.6 / thickness 0.04 / tiltDeg −30` 的
   * 倾斜板，挂在 `(hingeY = ROOF_TOP_Y, hingeZ = VALANCE_FRONT_Z)` 那条棱上。
   * 用户批注 ① 要求删掉它，改由**檐板自己**当招牌（批注 ②）——
   * 于是连带删除了：`CabinetShellPart` / `CABINET_SHELL_PARTS` 里的这一项、
   * `cabinetPartBox()` 的 `case 'marquee'`、`TableBuilder.buildMarqueePanel()`、
   * `Game.pickCabinetMap` 的 `part === 'marquee'` 分支。
   *
   * ★ **教训仍然有效，别丢**：`rotation.x = θ` 把局部 +z（正面法线）映到
   * `(0, -sin θ, cos θ)`。S18 写的是 `θ = +30°` ⇒ 法线 `(0, −0.5, +0.866)`，
   * 面朝**前下方**（相机在前上方）⇒ 招牌面朝地面，而当时所有计数型判据全绿。
   * 将来若再加任何倾斜面板，符号一律按这条公式现推，不要靠「看上去对」。
   */
} as const satisfies CabinetShape;

/**
 * 机柜外壳的件身份。`cabinetPartBox()` 只对这些件给得出解析包围盒。
 *
 * S21 从 8 件减到 7 件：删掉了 `'marquee'`（批注 ①，原因见 `CABINET` 尾部那段）。
 */
export type CabinetShellPart =
  | 'sideWall.tall.L'
  | 'sideWall.tall.R'
  | 'sideWall.low.L'
  | 'sideWall.low.R'
  | 'hoodRoof'
  | 'hoodValance'
  | 'backPanel';

/**
 * 外壳件的**运行期身份**。与 `userData.role`（色带）**正交**：
 *
 *   - `role` 回答「刷哪个色带」——`floor / rail / panel / trim / pusherTop / pusherFace`，
 *     由 `applyCabinetSkin` 消费；
 *   - `part` 回答「**这是哪一件**」——刷哪张贴图、导出叫什么名字、判据核对哪一个盒，
 *     由 `pickCabinetMap` / `tools/cabinet-export.ts` / `verify-game.mjs cabinet` 消费。
 *
 * ## 为什么必须分开（S19 的结构性修正）
 *
 * S18 把这两件事挤在 `role` 一个字段里，于是 `pickCabinetMap(role)` 写下了三条分支，
 * 其中两条**永远不会命中**：
 *   - `role === 'scoreLine'` / `'hotZone'` —— 全仓库**没有任何网格**挂这两个 role
 *     （得分线与热区亮条只挂 `scoreLineMaterial` / `hotZoneMaterial`，**没有 role**）。
 *     后果不只是死代码：`applyCabinetMapTextures` 靠它决定「换肤时重画哪张贴图」，
 *     于是**切肤之后得分线 / 热区仍然挂着建场时写死的调色板**
 *     （`createArcaneScoreLineTexture('viArcane')` / `createArcaneHotZoneTexture('firelight')`），
 *     永远不跟着 `marqueePalette` 走；
 *   - `role === 'trim'` 同时命中招牌、顶沿、前立面压条 —— 三件共用招牌贴图，
 *     其中只有招牌是「招牌」。S18 的注释承认这是将就（「现阶段不挑」）。
 *
 * 一个字段干两件事，就必然在某个维度上少一个词。补上 `part` 之后，
 * `role` 的语义回到纯粹「色带」，两条死分支变成 `part` 上的正常映射。
 */
export type CabinetPart =
  | CabinetShellPart
  | 'floor'
  | 'drainGrate'
  | 'scoreLine'
  | 'scoreDashes'
  | 'hotZone'
  | 'tray'
  | 'frontBaffle'
  | 'frontBaffleLip'
  | 'dropCorridor'
  | 'peg'
  | 'pusherFace'
  | 'pusherTop'
  | 'pusherGroove'
  | 'pusherLip'
  | 'slotFrame'
  | 'slotReelWindow'
  | 'slotLamp'
  | 'xixiLane';

/**
 * 外壳件的名单。判据用它枚举「必须存在、且必须只有一个」的件。
 *
 * S21：7 件（原 8 件，删掉 `marquee`）。
 */
export const CABINET_SHELL_PARTS: readonly CabinetShellPart[] = [
  'sideWall.tall.L',
  'sideWall.tall.R',
  'sideWall.low.L',
  'sideWall.low.R',
  'hoodRoof',
  'hoodValance',
  'backPanel',
];

/** 轴对齐盒。与 `THREE.Box3` 的 `min`/`max` 同形，但不依赖 three。 */
export type Box3Like = {
  min: [number, number, number];
  max: [number, number, number];
};

/**
 * 台面中点（币床中部、离地 0.5 米）——**机柜外壳绝对不许碰到它**。
 *
 * 这是 S18 那场事故的**负空间判据**：那块砖的包围盒
 * `x ±0.915, y 0..1.72, z −0.565..1.405` 恰好把这个点裹在里面，
 * 而它是「玩家正在看的币床」的中心 —— 任何机柜件裹住它，画面就一定出问题。
 *
 * 判据不许手抄这个点：它是从 `constants.ts` 派生的。
 */
export const COIN_BED_MIDPOINT: readonly [number, number, number] = [
  0,
  TABLE.floorY + 0.5,
  (TABLE.backZ + TABLE.scoreLineZ) / 2,
];

/** 由中心 + 尺寸造一个轴对齐盒。 */
function boxOf(
  center: readonly [number, number, number],
  size: readonly [number, number, number],
): Box3Like {
  return {
    min: [center[0] - size[0] / 2, center[1] - size[1] / 2, center[2] - size[2] / 2],
    max: [center[0] + size[0] / 2, center[1] + size[1] / 2, center[2] + size[2] / 2],
  };
}

/**
 * 外壳件的**解析包围盒**（世界坐标）。
 *
 * ★ 这是「判据不与几何分叉」的关键：判据不写第二份公式，
 * 而是把这里算出来的盒与场景里实测的盒比对。谁的公式错了都会当场失败 ——
 * 包括**几何建错了但记的是一份漂亮数字**这种最难发现的情况。
 *
 * `boxOf` 的入参全部来自 `CABINET`，与 `TableBuilder` 建网格时用的是同一份。
 */
export function cabinetPartBox(part: CabinetShellPart): Box3Like {
  // ★ 走 `cabinetShape()` 而不是 `CABINET`：模型模式重建之后，解析盒必须与
  // **建网格时读到的那份数据**一致，否则 `cabinet` 判据会在调参期间误报。
  // 非 `?model` 下两者恒等，所以这条不改变任何既有行为。
  const { wall, hood, back } = cabinetShape();
  const wallCenterX = wall.innerX + wall.thickness / 2;

  switch (part) {
    case 'sideWall.tall.L':
    case 'sideWall.tall.R': {
      const side = part.endsWith('.L') ? -1 : 1;
      // ★ S21：高段前沿内收之后，这个盒的 max[2] **仍然是 `hoodFrontZ`**（0.195）——
      // 因为「檐板托」把高段的最高处一直伸到檐板内表面。内收只发生在
      // `y ∈ (insetTopY, miterFrontY)` 以下，**落在盒内部 ⇒ 解析盒看不见**。
      // 形状对不对由 `cabinetWallOutline()` + 判据的折线比对负责。
      return boxOf(
        [
          side * wallCenterX,
          (wall.bottomY + wall.tallTopY) / 2,
          (wall.backZ + wall.hoodFrontZ) / 2,
        ],
        [wall.thickness, wall.tallTopY - wall.bottomY, wall.hoodFrontZ - wall.backZ],
      );
    }
    case 'sideWall.low.L':
    case 'sideWall.low.R': {
      const side = part.endsWith('.L') ? -1 : 1;
      // max[1] 取斜顶的**后端**（= 最高点）；斜顶本身同样落在盒内部。
      return boxOf(
        [
          side * wallCenterX,
          (wall.bottomY + wall.lowRoofBackY) / 2,
          (wall.insetZ + wall.lowFrontZ) / 2,
        ],
        [wall.thickness, wall.lowRoofBackY - wall.bottomY, wall.lowFrontZ - wall.insetZ],
      );
    }
    case 'hoodRoof':
      return boxOf(
        [0, (hood.underY + hood.topY) / 2, (hood.backZ + hood.valanceInnerZ) / 2],
        [hood.halfWidth * 2, hood.topY - hood.underY, hood.valanceInnerZ - hood.backZ],
      );
    case 'hoodValance':
      return boxOf(
        [
          0,
          (hood.valanceBottomY + hood.topY) / 2,
          (hood.valanceInnerZ + hood.valanceFrontZ) / 2,
        ],
        [hood.halfWidth * 2, hood.topY - hood.valanceBottomY, hood.valanceFrontZ - hood.valanceInnerZ],
      );
    case 'backPanel':
      // 盒由**两个面**（前 / 后）夹出来，而不是「中心 ± 半厚」——
      // 因为这两个面各自是一个接口（碰撞体内表面 / 外壳最后缘），
      // 中间任何一个面写错都必须立刻失败。
      return boxOf(
        [0, (back.bottomY + back.topY) / 2, (back.frontZ + back.backZ) / 2],
        [back.halfWidth * 2, back.topY - back.bottomY, back.frontZ - back.backZ],
      );
  }
}

/** 侧墙的两段。`tall` = 机柜侧板（含檐板托），`low` = 币床围挡（斜顶）。 */
export type CabinetWallSegment = 'tall' | 'low';

/**
 * 侧墙一段的**轮廓折线**（真源）：`(z, y)` 平面的闭合环，**首点不重复**、顺序即建网格的顺序。
 *
 * ## 为什么必须有它：解析盒对「形状」是瞎的
 *
 * S21 之前两段侧墙都是直角盒 ⇒ `cabinetPartBox()` 那三个尺寸就把形状说完了。
 * 二轮造型给侧墙加了**斜接面**与**斜顶**，而这两条边**全部落在包围盒内部**：
 * 盒的六个面一个都没变。也就是说 —— 如果把斜接面写成水平、把斜顶写成平的，
 * 或者两个端点接反，**所有既有判据仍然全绿**。这正是本仓库最忌讳的那类缺陷
 * （零报错的静默退化）。
 *
 * 所以形状本身也要有真源，并由 `verify-game.mjs cabinet` 与**场景里实测的**顶点集合比对。
 *
 * ## ★★ 纪律：`TableBuilder` 不许调这个函数
 *
 * 建网格（`TableBuilder.buildSideWall`）与算折线必须是**两条独立推导** ——
 * 各自从 `CABINET.wall` 的字段拼出来。若两边都调同一个函数，比对恒真、等于没查
 * （同 `cabinetPartBox()` 与 `build*` 的分工，见 `buildSideWall` 的注释）。
 */
/** 折线的一个端点由 `wall` 的哪两个字段给出。 */
export type WallPointBinding = {
  /** 该端点的 z 取自 `CABINET.wall` 的哪个字段。 */
  z: keyof CabinetShape['wall'];
  /** 该端点的 y 取自哪个字段。 */
  y: keyof CabinetShape['wall'];
  /** 模型模式面板上显示的中文名。 */
  label: string;
};

/**
 * 侧墙折线的**点 ↔ 字段绑定表**（S24）。
 *
 * ## 为什么需要它
 *
 * `?model` 模型模式要能「选中一条边 → 看它的角度 → 拖它的两个端点」。
 * 而折线端点是**派生量**（`backZ` / `tallTopY` / `hoodFrontZ` … 的组合），
 * 直接改端点就得反解回字段。这张表把「哪个端点由哪两个字段给出」写下来，
 * 于是面板改的永远是**字段本身** —— 不存在「改了一个派生量、却没落到真源上」
 * 的中间态。
 *
 * ## ★ 它同时是 `cabinetWallOutline()` 的真源
 *
 * 不是两份数据：`cabinetWallOutline()` 就是拿这张表拼出来的。若这里再写一份
 * 逐点数组，加一个端点就会漏改一处 —— 而漏改的表现是「面板上比几何少一条边」，
 * 零报错。
 *
 * ⚠️ 但**仍然不许** `TableBuilder.buildSideWall()` 调它：「建网格」与「算折线」
 * 必须是两条**独立推导**（见 `cabinetWallOutline()` 的注释），否则判据的逐点比对
 * 恒真、等于没查。
 */
export const WALL_OUTLINE_BINDING: Record<CabinetWallSegment, readonly WallPointBinding[]> = {
  // 高段：从后上角出发，沿上沿 → 檐板托前立面 → 斜接面 → 内收面 → 底边回到起点。
  tall: [
    { z: 'backZ', y: 'tallTopY', label: '后上角' },
    { z: 'hoodFrontZ', y: 'tallTopY', label: '檐板托·前上角' },
    { z: 'hoodFrontZ', y: 'miterFrontY', label: '檐板托·前下角' },
    { z: 'insetZ', y: 'insetTopY', label: '内收面·顶' },
    { z: 'insetZ', y: 'bottomY', label: '内收面·底' },
    { z: 'backZ', y: 'bottomY', label: '后下角' },
  ],
  // 低段：从 `insetZ` 的底角出发，沿底边向前 → 前立面 → 斜顶回到起点。
  low: [
    { z: 'insetZ', y: 'bottomY', label: '后下角' },
    { z: 'lowFrontZ', y: 'bottomY', label: '前下角' },
    { z: 'lowFrontZ', y: 'lowRoofFrontY', label: '斜顶·前端' },
    { z: 'insetZ', y: 'lowRoofBackY', label: '斜顶·后端' },
  ],
};

export function cabinetWallOutline(
  segment: CabinetWallSegment,
): readonly (readonly [number, number])[] {
  const { wall } = cabinetShape();
  return WALL_OUTLINE_BINDING[segment].map((point) => [wall[point.z], wall[point.y]]);
}

// ── 运行期覆盖层（只服务 `?model` 模型模式）───────────────────────────────
//
// ## 设计约束：覆盖**只在 `?model` 下存在**
//
// `Game` 只有在 URL 里看到 `?model` 时才会 `beginCabinetOverride()`；否则
// `override` 恒为 `null`、`cabinetShape()` 恒返回 `CABINET`。于是：
//
//   - `verify-game.mjs` 的 `cabinet` 判据（它在页面里
//     `import('/src/game/cabinetShape.ts')` 之后读 `cabinetPartBox()` /
//     `cabinetWallOutline()`）读到的是**编译期真值**，不需要加任何
//     「忽略调参」的分支；
//   - playwright 套件同理（导航时不带 `?model`）。
//
// ## ⚠️ 这条约束不是可选的
//
// 判据比的是「场景实测盒 vs 解析盒」，**两边都走 `cabinetShape()`**。
// 如果覆盖在判据下也生效，两边会**一起变** ⇒ 判据照样全绿。那样一来，
// 一个只活在 localStorage 里、从没落进代码的尺寸会被当成已提交的。
// `isCabinetOverridden()` 就是留给这种情况的观测通道。

let override: CabinetShape | null = null;

/** 当前生效的外壳形状。非 `?model` 下恒等于 `CABINET`。 */
export function cabinetShape(): Readonly<CabinetShape> {
  return override ?? CABINET;
}

/** 是否有运行期覆盖在生效（判据 / 面板用）。 */
export function isCabinetOverridden(): boolean {
  return override !== null;
}

export function beginCabinetOverride(shape: CabinetShape): void {
  override = shape;
}

export function endCabinetOverride(): void {
  override = null;
}

/**
 * `CABINET` 的**深拷贝**，作为模型模式的初始工作副本。
 *
 * 用 JSON 往返而不是手写逐字段拷贝：手写那份会在 `CABINET` 加字段时**静默漏掉**
 * 新字段（新字段永远改不动、也导不出去），而 JSON 往返不可能漏。
 */
export function cloneCabinetShape(): CabinetShape {
  return JSON.parse(JSON.stringify(CABINET)) as CabinetShape;
}

/**
 * 某件的倒角：逐件覆盖优先，缺省回落到全局值。
 *
 * ⚠️ 只对**直角盒件**有意义。剖面挤出件（侧墙两段）是尖边，
 * 理由见 `CabinetPartBevel` 的注释。
 */
export function partBevel(part: CabinetShellPart): CabinetPartBevel {
  const { bevel } = cabinetShape();
  return bevel.perPart[part] ?? { radius: bevel.radius, segments: bevel.segments };
}

function flattenNumbers(value: unknown, prefix: string, out: Map<string, number>): void {
  if (typeof value === 'number') {
    out.set(prefix, value);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    flattenNumbers(child, prefix === '' ? key : `${prefix}.${key}`, out);
  }
}

/**
 * 与编译期默认值的差异 —— 模型模式的「导出改动」。
 *
 * 返回**拍平后的数值路径**，例如
 *   `{ path: 'wall.insetZ', from: -0.12, to: -0.18 }`
 *   `{ path: 'bevel.perPart.hoodValance.radius', from: NaN, to: 0.03 }`
 * `from === NaN` 表示「默认值里没有这一项」（逐件倒角是运行期新加的键）。
 *
 * ★ 这是「我说不出需求」的解法：拖完滑块点一下导出，拿到的就是需求本身。
 */
export function cabinetShapeDiff(
  current: CabinetShape = override ?? cloneCabinetShape(),
): Array<{ path: string; from: number; to: number }> {
  const base = new Map<string, number>();
  const now = new Map<string, number>();
  flattenNumbers(CABINET, '', base);
  flattenNumbers(current, '', now);
  const diffs: Array<{ path: string; from: number; to: number }> = [];
  for (const [path, to] of now) {
    const from = base.get(path);
    if (from === undefined) {
      diffs.push({ path, from: Number.NaN, to });
    } else if (Math.abs(from - to) > 1e-9) {
      diffs.push({ path, from, to });
    }
  }
  return diffs;
}
