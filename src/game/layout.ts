import { COIN, COIN_BASE_CHIPS, TABLE, type CoinKind } from './constants';
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
 * 落点抖动上限（米）。
 *
 * 盘面自检要求**同层**币间距 ≥ 币径 × 0.98 = 0.1176 米。抖动是两个方向各一份，
 * 最坏情况下相邻两枚各朝对方偏 `jitter`，所以要求
 * `最小步距 − 2 × jitter ≥ 0.1176`。当前最密的一档步距是 0.144（11 列），
 * 余量 0.0264，取 0.005 留足安全边际。
 */
export const MAX_JITTER = 0.005;

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
  // 上层台面：币必须在推板后缘与归位时的前缘之间。
  const deckMinZ = TABLE.pusherBackZ + COIN.radius;
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
      // 台面币必须落在「台面输送」的高度带里，否则它不会被输送向前——上层就死住了。
      if (coin.y < TABLE.conveyor.minY || coin.y > TABLE.conveyor.maxY) {
        throw new Error(
          `上层台面有币不在输送带里：y=${coin.y.toFixed(3)}` +
            `（应在 ${TABLE.conveyor.minY} ~ ${TABLE.conveyor.maxY}）`,
        );
      }
      continue;
    }
    if (coin.z < bedMinZ || coin.z > bedMaxZ) {
      throw new Error(
        `币床有币越界：z=${coin.z.toFixed(3)}（应在 ${bedMinZ.toFixed(3)} ~ ${bedMaxZ.toFixed(3)}）`,
      );
    }
    // 币床上的币不能落进「台面输送」的高度带：那一段是给推板顶面用的，
    // 币床的币一旦落进去就会被持续施加向前的冲量，堆好的盘面会自己散架。
    // 这条同时约束了币塔的高度——塔顶必须低于 conveyor.minY。
    if (coin.y >= TABLE.conveyor.minY && coin.y <= TABLE.conveyor.maxY) {
      throw new Error(
        `币床有币落进台面输送带：y=${coin.y.toFixed(3)}` +
          `（输送带 ${TABLE.conveyor.minY} ~ ${TABLE.conveyor.maxY}，叠太高了）`,
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
  const byKind: Record<CoinKind, number> = { bronze: 0, pattern: 0, payout: 0, bounty: 0 };
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
