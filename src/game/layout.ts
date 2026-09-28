import { COIN, COIN_BASE_CHIPS, COIN_KINDS, DRAIN_FOOTPRINT, TABLE, type CoinKind } from './constants';
import { createSeededRandom } from '../utils/random';

/** 一枚预置币的位置与朝向。 */
export type CoinPlacement = {
  kind: CoinKind;
  x: number;
  y: number;
  z: number;
  yaw: number;
  /**
   * 这枚币落在哪张台面上。
   *
   * **必须显式标出来，不能靠 y 猜**：币塔上层会高过推板顶面（`pusherTopY`），
   * 用 `y > pusherTopY` 判「在台面上」会把塔顶的币误判成上层币，
   * 于是自检放过一批真正该报错的坐标。
   */
  surface: Surface;
};

/** 台面：`deck` = 推板顶面（上层），`bed` = 币床（下层）。 */
export type Surface = 'bed' | 'deck';

/**
 * 单层币的高度步距：币厚 + 一点余量。
 *
 * 余量不能省：同层币是「面贴面」接触，给 0 会让 Rapier 在第一步就解出穿透。
 * 但也不能大：步距明显大于币厚时，叠起来的一摞会在第一步整体下坠一小段，
 * 看起来像「盘面抖了一下」。
 */
export const LAYER_STEP = COIN.halfThickness * 2 + 0.0012;

/** 落在台面上的币心高度。 */
export const REST_Y = COIN.halfThickness + 0.002;

/**
 * 落点抖动上限（米）：**按币径等比缩放**，取币径的 1/24。
 *
 * 抖动的唯一作用是打散「一眼能看出是网格」的观感，所以它该跟币的尺寸走，
 * 而不是一个绝对米数。原尺寸（直径 0.12）下正好是 0.005 米，与 S13 之前一致。
 *
 * ★ S13 起这里**必须派生**：币尺寸档位（`?coin=1.1/1.2`）同时放大币径与抖动，
 * 而网格步距的下限（下面的 `MIN_STEP`）随两者一起涨。写死 0.005 的版本在
 * ×1.2 下会让 `MIN_STEP` 从 0.1276 涨到 0.15312，**11 列的网格当场不够用**——
 * 表现是启动时 `assertLayoutValid` 抛「盘面重叠」。显式抛错是好事，
 * 但它必须是「配置算错了」，不是「常量忘了改」。
 */
export const MAX_JITTER = (COIN.radius * 2) / 24;

/** 同层两枚预置币的最小允许间距（米）。这是 `assertLayoutValid` 的判据，只写这一份。 */
export const MIN_SPACING = COIN.radius * 2 * 0.98;

/**
 * 网格步距的下限（米）：`MIN_SPACING` 加上「两侧各一份抖动」的最坏情况。
 *
 * 相邻两枚币各朝对方偏 `jitter` 时，间距被吃掉 `2 × jitter`，所以
 * `步距 − 2 × jitter ≥ 币径 × 0.98` 是网格能成立的必要条件。
 * `fitCells()` 用它把「区域跨度」换算成「最多能放几格」。
 */
export const MIN_STEP = MIN_SPACING + MAX_JITTER * 2;

/**
 * 在给定跨度里求「满足同层最小间距的最大格数」。
 *
 * `stepX = (xMax − xMin) / (columns − 1)`，所以格数越多步距越小，
 * 于是 `columns ≤ span / MIN_STEP + 1`。`desired` 是**上限**（原尺寸下的设计密度），
 * 币放大后自动往下减。
 *
 * ★ 存在的唯一理由：币尺寸档位会同时放大币径与抖动，**同一个区域的列/行数
 * 在不同档位下必须不同**。写死 11 列的版本在 ×1.2 下步距 0.144 < `MIN_STEP` 0.15312
 * → 自检抛「盘面重叠」。减列比缩抖动更划算：抖动缩到 1.4mm 就失去打散网格的作用了。
 */
export function fitCells(span: number, desired: number): number {
  if (span <= 0) return 1;
  // `+1e-9` 吃掉浮点误差：跨度恰好是 `MIN_STEP` 的整数倍时不该少给一格。
  return Math.max(1, Math.min(desired, Math.floor(span / MIN_STEP + 1e-9) + 1));
}

/**
 * 排水口在地板上占掉的那块方形区域：**预置盘面必须给它让位**。
 *
 * 从 `DRAIN_FOOTPRINT` 派生（真源只有一个），内边界各退 `MAX_JITTER`：
 * 网格里存的是**未加抖动**的格点，而物理拿到的是加过抖动的坐标，
 * 不退这一点点，贴着洞边的那一列会「自检过、物理掉」。
 *
 * 用法：`clearances: [...DRAIN_CLEARANCES]`。`clearances` 是 spec 级全局的，
 * 所以所有区域自动让位；但 `towers` **不经过** `clearances`，
 * 塔要是摆进洞里就只能靠 `assertLayoutValid` 兜（那里也引这份数据）。
 */
export const DRAIN_CLEARANCES: Array<{ x: number; z: number; halfX: number; halfZ: number }> = [
  -1, 1,
].map((side) => ({
  x: (side * (DRAIN_FOOTPRINT.xInner - MAX_JITTER) + side * DRAIN_FOOTPRINT.xOuter) / 2,
  z: (DRAIN_FOOTPRINT.zBack - MAX_JITTER + DRAIN_FOOTPRINT.zFront) / 2,
  halfX: (DRAIN_FOOTPRINT.xOuter - DRAIN_FOOTPRINT.xInner + MAX_JITTER) / 2,
  halfZ: (DRAIN_FOOTPRINT.zFront - DRAIN_FOOTPRINT.zBack + MAX_JITTER) / 2,
}));

/** 某个点是否落在排水口（含抖动余量）里。自检与保留区共用同一份判据。 */
export function insideDrain(x: number, z: number): boolean {
  return DRAIN_CLEARANCES.some(
    (box) => Math.abs(x - box.x) <= box.halfX && Math.abs(z - box.z) <= box.halfZ,
  );
}

/**
 * 判定「这枚币此刻在**上层台面**（推板顶面）上」的 y 下界。
 *
 * 台面平面是 `TABLE.pusherTopY`，币心静置在它之上 `REST_Y`。判据取台面平面
 * **往下让 5 毫米**，吃掉求解器穿透（币被挤压时币心会短暂低于静置高度）。
 *
 * ★ 为什么不再拿 `TABLE.conveyor.minY`（原 0.14）当这条判据：
 * 那个值同时被当成「算台面还是算币床」的归属线，于是**币塔的高度上限被它卡死**
 * ——塔顶必须 < 0.14，也就是最多 5 层。而归属是**体积**问题，不是高度带问题：
 * 塔摆在 `z = 0.62`，根本不在推板顶面覆盖的 z 区间里，不该受任何高度带约束。
 * 见 `isOnDeckVolume`。
 */
export const DECK_MIN_Y = TABLE.pusherTopY - 0.005;

/** 推板**归位时**它顶面覆盖的 z 区间。预置坐标的自检用它；运行期用 `Pusher.topRange`。 */
export const DECK_REST_RANGE = {
  back: TABLE.pusherBackZ,
  front: TABLE.pusherFrontZAtRest,
} as const;

/**
 * 某个世界坐标是否落在**上层台面的体积**里。这是「算台面还是算币床」的**唯一判据**。
 *
 * 三个条件缺一不可：
 *   ① `y ≥ DECK_MIN_Y` —— 在台面平面之上（含穿透余量）；
 *   ② `y ≤ TABLE.conveyor.maxY` —— 上界仍然要有：落币走廊里的币（`drop.y = 1.45`）
 *      在 z 上正好落在台面区间内，只看 ①③ 会把**正在下落**的币判成台面币；
 *   ③ `z ∈ range` —— 在推板顶面覆盖的 z 区间内。**区间随推板行程移动**
 *      （`Pusher.topRange`），所以前缘的币被推出去之后仍然算台面币。
 *
 * ★ ③ 是关键：币床的币塔摆在 `z = 0.62`，即使塔顶高过 `pusherTopY`，
 * 也因为 z 不在区间内而不算台面币 —— **塔高因此不再受任何高度带约束**。
 * 反过来说，币床区域一旦被配置到 `z < pusherFrontZAtRest`，那些币就会被判成台面币，
 * `assertLayoutValid` 会当场拦住（这就是它那条判据现在的形态）。
 *
 * ★ 三处共用这一份实现：`Game.isOnDeck()`、`CoinPool.countBed()`、
 * `assertLayoutValid`。口径一旦分叉，就会出现「诊断说台面上没币、输送却在送币」
 * 这种自相矛盾的读数——那类缺陷零报错，只能靠「只有一份判据」来防。
 */
export function isOnDeckVolume(
  x: number,
  y: number,
  z: number,
  range: { back: number; front: number },
): boolean {
  return (
    Math.abs(x) <= TABLE.halfWidth &&
    y >= DECK_MIN_Y &&
    y <= TABLE.conveyor.maxY &&
    z >= range.back &&
    z <= range.front
  );
}

/**
 * 台面区域：一块用「列 × 行 × 层」描述的位置网格。
 *
 * 排布不再手写坐标，而是把「一块地方铺多密、叠几层、铺哪种币」写成数据。
 * 好处是自检（`assertLayoutValid`）能对**任意**配置生效，
 * 而不是只对某一版手写布局生效——P2 之后盘面会从 74 枚涨到 310 枚，
 * 靠人眼是验不过来的。
 */
export type LayoutRegion = {
  kind: CoinKind;
  /** 横向范围（含端点）。 */
  xMin: number;
  xMax: number;
  /** 纵深范围（含端点）。 */
  zMin: number;
  zMax: number;
  columns: number;
  rows: number;
  /** 叠几层，默认 1。 */
  layers?: number;
  /** 从第几层开始叠，用来在别的区域上面再加一层。默认 0。 */
  layerOffset?: number;
  /** 台面基准高度，默认币床（`TABLE.floorY`）。上层台面用 `TABLE.pusherTopY`。 */
  baseY?: number;
  /** 落在哪张台面上，默认币床。上层台面必须写 `'deck'`（见 `CoinPlacement.surface`）。 */
  surface?: Surface;
  /**
   * 从网格里抽这么多个格子，其余留空（稀疏铺）。省略 = 全铺。
   *
   * 抽样顺序是**按种子洗过的固定序列**，`pick` 取它的前 N 个。这一点很关键：
   * 前缀必须嵌套——上层币要压在下层币上，所以「抽 30 个」必须是「抽 48 个」的
   * **子集**。如果两层各自独立抽样，上层就会出现悬空的币，开局自己往下掉，
   * 「静置 10 秒全静止」这条验收直接失败。
   */
  pick?: number;
  /**
   * 抽样起点：取洗过的序列的第 `pickFrom` 到 `pickFrom + pick` 个。
   *
   * 存在的唯一理由：让**多个区域共用同一层网格而互不重叠**。
   * 花纹与返币要撒在同一层的不同格子上，如果各自独立抽样，两次都会从头开始取，
   * 必然撞在一起（自检会抛「盘面重叠」）。
   */
  pickFrom?: number;
  /** 排除的格子 `[行, 列]`，用来给币塔让位。 */
  skip?: Array<[number, number]>;
};

/** 币塔：底面 `footprint × footprint`、指定层数的一摞。 */
export type TowerSpec = {
  kind?: CoinKind;
  x: number;
  z: number;
  layers: number;
  /** 底面边长（币数）：1 = 单柱，2 = 2×2。默认 2。 */
  footprint?: 1 | 2;
  baseY?: number;
  /** 落在哪张台面上，默认币床。 */
  surface?: Surface;
};

export type LayoutSpec = {
  /** 盘面种子：同一份配置必须每次都生成同一个盘面。 */
  seed: number;
  jitter?: number;
  /**
   * 保留区：这些盒子里的散币格一律跳过。
   *
   * 币塔的底面在**第 0 层**，和币床散币同一层，所以塔基周围必须让位，
   * 否则开局就有一堆币插在塔基里（自检会直接抛错）。
   * 让位范围要比塔的物理占地略大一圈——自检的判据是「同层间距 ≥ 币径 × 0.98」，
   * 贴着塔边放的币会刚好压线。
   */
  clearances?: Array<{ x: number; z: number; halfX: number; halfZ: number }>;
  regions: LayoutRegion[];
  towers?: TowerSpec[];
};

/** 从候选格里按种子洗出一个固定序列。`pick` 取它的前缀，所以前缀天然嵌套。 */
function shuffled<T>(cells: T[], rng: () => number): T[] {
  const order = cells.slice();
  for (let index = order.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(rng() * (index + 1));
    [order[index], order[swap]] = [order[swap], order[index]];
  }
  return order;
}

/**
 * 按配置生成盘面。**确定性**：同一个 seed 每次得到同一份坐标，
 * 所以「盘面变了」永远是配置变了，不是随机漂了。
 */
export function buildLayout(spec: LayoutSpec): CoinPlacement[] {
  const jitter = spec.jitter ?? MAX_JITTER;
  const layout: CoinPlacement[] = [];
  const clearances = spec.clearances ?? [];
  const reserved = (x: number, z: number): boolean =>
    clearances.some(
      (box) => Math.abs(x - box.x) <= box.halfX && Math.abs(z - box.z) <= box.halfZ,
    );

  /**
   * 网格缓存：**同几何的区域共用同一份顺序与抖动**。
   *
   * 这条是 `pickFrom` 能工作的前提。花纹与返币要撒在同一层的不同格子上，
   * 靠「同一份洗过的序列、各取一段」来错开；如果每个区域各自洗牌，
   * 两次洗出来的顺序不同，`pickFrom` 就完全错位——两批币会撞在同一格上
   * （自检报「盘面重叠：(0.722, 0.924) 与 (0.724, 0.924) 间距 0.002」）。
   *
   * 顺带保证**层与层对齐**：同一个格子在任何层拿到的是同一份抖动，
   * 叠起来的一摞是正对的，不会因为各层乱偏而互相穿插。
   */
  const grids = new Map<string, Array<{ x: number; z: number; yaw: number }>>();
  const gridFor = (region: LayoutRegion) => {
    const key = [
      region.xMin,
      region.xMax,
      region.zMin,
      region.zMax,
      region.columns,
      region.rows,
      (region.skip ?? []).map(([row, column]) => `${row}:${column}`).join(','),
    ].join('|');
    const cached = grids.get(key);
    if (cached) return cached;

    const stepX = region.columns > 1 ? (region.xMax - region.xMin) / (region.columns - 1) : 0;
    const stepZ = region.rows > 1 ? (region.zMax - region.zMin) / (region.rows - 1) : 0;
    const cells: Array<{ x: number; z: number }> = [];
    for (let row = 0; row < region.rows; row += 1) {
      for (let column = 0; column < region.columns; column += 1) {
        if (region.skip?.some(([skipRow, skipColumn]) => skipRow === row && skipColumn === column)) {
          continue;
        }
        const x = region.xMin + column * stepX;
        const z = region.zMin + row * stepZ;
        if (reserved(x, z)) continue;
        cells.push({ x, z });
      }
    }

    const order = shuffled(cells, createSeededRandom(spec.seed));
    const noise = createSeededRandom(spec.seed + 977);
    const built = order.map((cell) => ({
      x: cell.x + (noise() - 0.5) * 2 * jitter,
      z: cell.z + (noise() - 0.5) * 2 * jitter,
      yaw: noise() * Math.PI * 2,
    }));
    grids.set(key, built);
    return built;
  };

  for (const region of spec.regions) {
    const baseY = region.baseY ?? TABLE.floorY;
    const grid = gridFor(region);
    const pickFrom = region.pickFrom ?? 0;
    const chosen = grid.slice(pickFrom, pickFrom + (region.pick ?? grid.length));

    const layers = region.layers ?? 1;
    const layerOffset = region.layerOffset ?? 0;
    const surface = region.surface ?? 'bed';
    for (let layer = 0; layer < layers; layer += 1) {
      const y = baseY + REST_Y + (layerOffset + layer) * LAYER_STEP;
      for (const cell of chosen) {
        layout.push({ kind: region.kind, x: cell.x, y, z: cell.z, yaw: cell.yaw, surface });
      }
    }
  }

  for (const tower of spec.towers ?? []) {
    const baseY = tower.baseY ?? TABLE.floorY;
    const kind = tower.kind ?? 'bronze';
    const footprint = tower.footprint ?? 2;
    const surface = tower.surface ?? 'bed';
    const offset = COIN.radius + 0.001;
    const slots = footprint === 2 ? [-offset, offset] : [0];
    for (let layer = 0; layer < tower.layers; layer += 1) {
      const y = baseY + REST_Y + layer * LAYER_STEP;
      for (const dx of slots) {
        for (const dz of slots) {
          layout.push({ kind, x: tower.x + dx, y, z: tower.z + dz, yaw: 0, surface });
        }
      }
    }
  }

  return layout;
}

/** 预置币落在上层台面（推板顶面）上，而不是币床上。 */
function onDeck(coin: CoinPlacement): boolean {
  return coin.surface === 'deck';
}

/**
 * 盘面自检：任何两枚同层预置币不得互相穿插，且每枚都落在自己的台面范围内。
 *
 * 这里查的是**预置坐标**，不是运行期位置——运行期的堆叠由物理负责。
 * 目的只有一个：把「配置写错了」变成一句能读的报错，而不是开局后一堆币炸开、
 * 再让人从录像里反推是哪一行写错了。
 */
export function assertLayoutValid(layout: CoinPlacement[]): void {
  const limitX = TABLE.halfWidth - COIN.radius;
  // 币床：币必须在推板归位时的推币面之前（否则开局就嵌在推板体内），且在得分线之内。
  const bedMinZ = TABLE.pusherFrontZAtRest + COIN.radius;
  const bedMaxZ = TABLE.scoreLineZ - COIN.radius * 0.2;
  // 上层台面：币必须在**后墙**与归位时的前缘之间。
  // ★ S13：后界从推板后缘 `pusherBackZ` 换成后墙所在的可见背板平面 `TABLE.backZ`
  // （见 `TableBuilder` 的后墙注释）。台面物理上仍铺到 `pusherBackZ`，但 `z < backZ`
  // 那一段已经被后墙封住，预置在那里的币开局会被墙顶出来一片乱飞 —— 用旧值自检放行、
  // 运行期才炸，正是这条断言要拦的东西。
  const deckMinZ = TABLE.backZ + COIN.radius;
  const deckMaxZ = TABLE.pusherFrontZAtRest - COIN.radius;

  for (const coin of layout) {
    if (Math.abs(coin.x) > limitX) {
      throw new Error(`盘面有币越出侧壁：x=${coin.x.toFixed(3)}（上限 ±${limitX.toFixed(3)}）`);
    }
    if (onDeck(coin)) {
      if (coin.z < deckMinZ || coin.z > deckMaxZ) {
        throw new Error(
          `上层台面有币越界：z=${coin.z.toFixed(3)}（应在 ${deckMinZ.toFixed(3)} ~ ${deckMaxZ.toFixed(3)}）`,
        );
      }
      // 台面币必须落在**台面体积**里，否则它会被 `Game.isOnDeck()` 判成币床币。
      // ⚠️ 原注释的理由（「否则它不会被输送向前——上层就死住了」）在 S13 台面输送归零后
      // 已经不成立：现在台面上**本来就没有输送**（见 `TABLE.conveyor.speed` 的注释）。
      // 这条现在管的是「这枚币算台面还是算币床」这个归属问题。
      //
      // ★ S13 改成调 `isOnDeckVolume`（与 `Game.isOnDeck()` 同一份判据），
      // 于是它**没有上界了**：原句 `y > conveyor.maxY` 会把「台面上叠了几层」直接判死。
      // 台面币的 z 区间上面已经查过（`deckMinZ` / `deckMaxZ`，比体积判据更紧）。
      if (!isOnDeckVolume(coin.x, coin.y, coin.z, DECK_REST_RANGE)) {
        throw new Error(
          `上层台面有币不在台面体积里：(${coin.x.toFixed(3)}, ${coin.y.toFixed(3)}, ${coin.z.toFixed(3)})` +
            `（体积：y ∈ [${DECK_MIN_Y}, ${TABLE.conveyor.maxY}]、` +
            `z ∈ [${DECK_REST_RANGE.back}, ${DECK_REST_RANGE.front}]）`,
        );
      }
      continue;
    }
    if (coin.z < bedMinZ || coin.z > bedMaxZ) {
      throw new Error(
        `币床有币越界：z=${coin.z.toFixed(3)}（应在 ${bedMinZ.toFixed(3)} ~ ${bedMaxZ.toFixed(3)}）`,
      );
    }
    // 币床上没有洞的碰撞体，币心一旦落在排水口占地里，第一帧就会掉出机柜。
    // 这不是「观感问题」而是**枚数守恒被静默打破**：`activeCoins` 会凭空少几枚，
    // 而币种合计、异常计数、币池预算全都还是绿的（P10 S7 实测 318 → 314）。
    // 所以它必须是一条**自检**，而不是靠物理跑起来之后再从读数里反推。
    if (insideDrain(coin.x, coin.z)) {
      throw new Error(
        `币床有币坐在排水口上：(${coin.x.toFixed(3)}, ${coin.z.toFixed(3)})` +
          `（洞 x ∈ ±[${DRAIN_FOOTPRINT.xInner}, ${DRAIN_FOOTPRINT.xOuter}]，` +
          `z ∈ [${DRAIN_FOOTPRINT.zBack}, ${DRAIN_FOOTPRINT.zFront}]）` +
          `—— 盘面区域必须加 \`...DRAIN_CLEARANCES\` 让位`,
      );
    }
    // 币床上的币不能落进**台面体积**：那一段在语义上属于推板顶面，
    // 落在里面的币会被 `Game.isOnDeck()` 判成「在台面上」，遥测与台面判定都会串味。
    //
    // ⚠️ **S13 起这条不再是「物理必然」**：原先的理由是「落进去就会被持续施加向前的冲量、
    // 堆好的盘面自己散架」，而台面输送已经归零（`TABLE.conveyor.speed = 0`，
    // `Game.fixedUpdate` 对 0 直接短路，完全不施加冲量）。所以现在它约束的是
    // **台面/币床的归属划分**，不是力学。
    //
    // ★★ S13 把判据从「高度带」换成「体积」之后，**币塔的高度上限被解除了**。
    // 旧判据是 `y ∈ [0.14, 0.34]` 就报错 —— 塔顶必须 < 0.14，也就是最多 5 层。
    // 新判据多了一条 `z ∈ [pusherBackZ, pusherFrontZAtRest]`，而塔摆在 `z = 0.62`
    // 远在 `pusherFrontZAtRest = −0.16` 之前，**再高也不会落进体积里**。
    // 于是「塔能盖多高」重新变成一个纯物理问题（会不会倒），不再是记账问题。
    if (isOnDeckVolume(coin.x, coin.y, coin.z, DECK_REST_RANGE)) {
      throw new Error(
        `币床有币落在台面体积里：(${coin.x.toFixed(3)}, ${coin.y.toFixed(3)}, ${coin.z.toFixed(3)})` +
          `（体积：y ∈ [${DECK_MIN_Y}, ${TABLE.conveyor.maxY}]、` +
          `z ∈ [${DECK_REST_RANGE.back}, ${DECK_REST_RANGE.front}]）` +
          `—— 币床的 z 必须整体落在推板归位前缘 ${TABLE.pusherFrontZAtRest} 之后`,
      );
    }
  }

  // 同层间距。上层与币床各自判：它们不在同一张台面上，纵向叠放是允许的。
  const diameter = COIN.radius * 2;
  for (let i = 0; i < layout.length; i += 1) {
    for (let j = i + 1; j < layout.length; j += 1) {
      const a = layout[i];
      const b = layout[j];
      if (onDeck(a) !== onDeck(b)) continue;
      if (Math.abs(a.y - b.y) >= COIN.halfThickness * 2) continue;
      const distance = Math.hypot(a.x - b.x, a.z - b.z);
      if (distance < diameter * 0.98) {
        throw new Error(
          `盘面重叠：(${a.x.toFixed(3)}, ${a.z.toFixed(3)}) 与 ` +
            `(${b.x.toFixed(3)}, ${b.z.toFixed(3)}) 间距 ${distance.toFixed(3)}`,
        );
      }
    }
  }
}

/** 盘面「标称价值」：按各币种的返值基数求和，用于布局模式的摘要与预算核对。 */
export function layoutValue(layout: CoinPlacement[]): number {
  return layout.reduce((sum, coin) => sum + COIN_BASE_CHIPS[coin.kind], 0);
}

/**
 * 盘面**容量**：把所有「稀疏铺」（`pick` / `pickFrom`）去掉之后，这份配置能放多少枚。
 *
 * 存在的理由（纪律 2「判据不写第二份公式」）：验证脚本原先写死「满盘应在 280~320 枚」，
 * 而那个区间是**盘面容量的代理**，容量随币尺寸档位下降（币越大，网格列/行越少）——
 * `?coin=1.2` 下盘面天然只有 257 枚，写死的区间会一直红。那不是缺陷，是判据没跟上尺寸。
 *
 * 有了这个数，判据可以改问一个**与尺寸无关**的问题：「盘面填到容量的几成」。
 * 容量本身由 `buildLayout` 现算，所以改配置不用改判据。
 */
export function layoutCapacity(spec: LayoutSpec): number {
  return buildLayout({
    ...spec,
    regions: spec.regions.map((region) => ({ ...region, pick: undefined, pickFrom: undefined })),
  }).length;
}

export type LayoutSummary = {
  total: number;
  deck: number;
  bed: number;
  value: number;
  byKind: Record<CoinKind, number>;
  /** 单枚最高的币心高度，用来核对「有没有币高到会被判成在途」。 */
  topY: number;
};

/** 盘面摘要：布局模式打印它，也用来给断言一个稳定的输入。 */
export function layoutSummary(layout: CoinPlacement[]): LayoutSummary {
  // 按 `COIN_KINDS` 建零表（P6）：新增币种不用回来补这一行。
  const byKind = Object.fromEntries(COIN_KINDS.map((kind) => [kind, 0])) as Record<CoinKind, number>;
  let deck = 0;
  let topY = 0;
  for (const coin of layout) {
    byKind[coin.kind] += 1;
    if (onDeck(coin)) deck += 1;
    topY = Math.max(topY, coin.y);
  }
  return {
    total: layout.length,
    deck,
    bed: layout.length - deck,
    value: layoutValue(layout),
    byKind,
    topY,
  };
}
