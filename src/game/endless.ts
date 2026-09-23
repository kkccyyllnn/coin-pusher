import { COIN, ENDLESS, TABLE } from './constants';
import { buildLayout, assertLayoutValid, layoutSummary, type CoinPlacement, type LayoutSpec } from './layout';

export type { CoinPlacement };

/**
 * 无尽模式的关配置（v3 起游戏只有这一种玩法）。
 *
 * 战役六关已摘除：没有目标分、星级、循环预算与解锁条件。
 * 「撑多久、堆多高」就是全部目标，破产是内容不是失败。
 */
export type EndlessConfig = {
  name: string;
  /**
   * 本局买入筹码的**兜底值**。
   *
   * 实际入场额由 `SaveStore.buyIn()` 决定（受钱包余额限制，余额不足时按余额全押），
   * 这个字段只在没有存档上下文时（例如纯布局测试）被用到。
   */
  credits: number;
  /** 本局预置盘面。 */
  layout: CoinPlacement[];
  /** 开场提示语。 */
  focus: string;
  /** 盘面种子，保证布局可复现。 */
  seed: number;
  /** 是否开启热区（无尽恒开）。 */
  hotZone: boolean;
};

/**
 * 币床分成前后两段，行距一致（0.145），拼起来是连续的一整张床。
 *
 * **必须从推板归位前缘一直铺到得分线前**，不留死区。旧盘面从 z=0.32 才开始，
 * 而推板归位前缘在 -0.16：中间 0.48 米的空档逼着行程必须拉到 0.48 米以上才碰得到币，
 * 而 0.84 米的行程会把整张币床当刚体推走（实测 8.4 枚/循环、单循环 106 枚的垮塌）。
 * 参考项目（coin-pusher-2000）的币床同样是从推板前缘铺到前沿的，没有空档。
 *
 * 分成两段的唯一理由是**给返币筹码单独留一块前沿地**（见下面的 `payoutFront`）：
 * 返币只占盘面的 4%，随机撒在整张床上时，一局（只越线几十枚）里很可能一枚都没轮到，
 * 玩家就完全看不到「绿色返币筹码」这个机制。把它固定放在前沿，它会在一局的前几轮就掉出来。
 *
 * 列距 0.144、行距 0.145，都大于币径 0.12——自检要求同层间距 ≥ 币径 × 0.98 = 0.1176，
 * 抖动上限 0.005 之后最坏间距 0.134，还留得住。**要加密只能加列**。
 */
const BED_BACK = { xMin: -0.72, xMax: 0.72, zMin: -0.06, zMax: 0.665, columns: 11, rows: 6 };
const BED_FRONT = { xMin: -0.72, xMax: 0.72, zMin: 0.81, zMax: 1.1, columns: 11, rows: 3 };
/**
 * 币床**最前沿的一行**（离得分线 0.05 米）。
 *
 * 返币筹码钉在这一行、并且只钉 3 枚：一局只越线几十枚，而前段两行（z=0.81/0.955）
 * 在整局里往往都轮不到——实测一局 22 次越线、返币一次都没露面。
 * 钉在最前沿之后它必然在开局几轮就掉出来，「绿色返币筹码」这个机制才看得见。
 */
const BED_EDGE = { xMin: -0.72, xMax: 0.72, zMin: 1.1, zMax: 1.1, columns: 11, rows: 1 };
/** 上层台面（推板顶面）的稀疏铺：只放 18 枚，密铺会在一秒内被台面输送整片倾泻下去。 */
const DECK = { xMin: -0.72, xMax: 0.72, zMin: -1.1, zMax: -0.28, columns: 6, rows: 3 };

/**
 * 两座币塔：都在推板前缘够得到的位置（z=0.62），靠推板接触自然唤醒。
 *
 * **层数被「台面输送」的高度带卡死**：`TABLE.conveyor` 是 y ∈ [0.14, 0.34]，
 * 而币床的币一旦落进那一段就会被持续施加向前的冲量、堆好的塔自己就散了。
 * 层高 `LAYER_STEP` = 0.0212，所以塔最多 6 层（塔顶 y = 0.118 < 0.14）。
 * 想要更高的塔，得先把 `conveyor.minY` 抬到推板顶面之上——那是 P2 物理调优的事，
 * 不要在这里偷偷改（自检会直接把越界的配置顶回来）。
 */
const TOWER_A = { x: 0.34, z: 0.62, layers: 5 };
const TOWER_B = { x: -0.42, z: 0.62, layers: 5 };

/**
 * 塔基保留区。
 *
 * `halfX` 要够大（0.20）：自检的判据是「同层间距 ≥ 币径 × 0.98」，
 * 而塔的四个角币离塔心只有 0.061 米，保留区开小了，紧贴塔边那一列会刚好压线。
 * `halfZ` 0.16 覆盖三行（0.47 / 0.62 / 0.77）：塔角币在 z 方向也是 ±0.061，
 * 只覆盖一行的话，斜对角那两个格子会落在 0.115 米——比 0.1176 的判据还近。
 *
 * 代价是每层让掉 3 列 × 3 行 × 2 座 = 18 格（66 → 48），币床层数因此要加到 5 层。
 */
const TOWER_CLEAR = { halfX: 0.2, halfZ: 0.16 };

/**
 * 无尽满盘的生成配置。目标预置 300 枚出头（P2 从 74 枚提到这个量级）：
 *
 * ```
 *   上层台面      18（6×3，稀疏）
 *   币床后段 1-2 层 108 = (66 格 − 12 格塔基保留) × 2 层，铜币
 *   币床后段 3 层    44（铜币，稀疏铺）
 *   币床后段 4 层    39 = 花纹 30 + 返币 9（共用同一份抽样、靠 pickFrom 错开）
 *   币床前段 1-2 层  66 = 33 格 × 2 层，铜币
 *   币床前段 3 层     3（返币，贴线摆着）
 *   币塔            40 = 2×2×5 × 2 座
 *   合计           318
 * ```
 *
 * 层与层之间是**前缀嵌套**的（`pick` 取洗过序列的前 N 个），所以上层币一定压在下层币上，
 * 不会有开局就往下掉的悬空币——「静置 10 秒全静止」这条验收靠的就是这个。
 *
 * 币种配比刻意沿用旧盘面的比例（铜币 ~83%、花纹 ~12%、返币 ~4%），
 * 因为回收率是按「越线构成」标定的——比例一变，`bronzePayoutChance` 就要重标。
 */
const ENDLESS_SPEC: LayoutSpec = {
  seed: 606,
  clearances: [
    { x: TOWER_A.x, z: TOWER_A.z, ...TOWER_CLEAR },
    { x: TOWER_B.x, z: TOWER_B.z, ...TOWER_CLEAR },
  ],
  regions: [
    { kind: 'bronze', ...BED_BACK, layers: 2 },
    { kind: 'bronze', ...BED_BACK, layers: 1, layerOffset: 2, pick: 44 },
    // 花纹与返币撒在第 4 层：共用同一份抽样，靠 `pickFrom` 错开，不会撞格。
    { kind: 'pattern', ...BED_BACK, layers: 1, layerOffset: 3, pick: 30 },
    { kind: 'payout', ...BED_BACK, layers: 1, layerOffset: 3, pick: 9, pickFrom: 30 },
    { kind: 'bronze', ...BED_FRONT, layers: 2 },
    // 前沿这三枚返币是**故意**的：绿币钉在离得分线 0.05 米的地方，一局的前几轮就会掉出来，
    // 玩家看得见这个机制。随机撒在整张床上时它一局都可能不露面（实测 22 次越线里 0 次）。
    { kind: 'payout', ...BED_EDGE, layers: 1, layerOffset: 2, pick: 3 },
    // 上层只稀疏预置：密铺会被台面输送在一秒内整片推下去。
    { kind: 'bronze', ...DECK, baseY: TABLE.pusherTopY, surface: 'deck', layers: 1 },
  ],
  towers: [
    { ...TOWER_A, footprint: 2 },
    { ...TOWER_B, footprint: 2 },
  ],
};

let cached: EndlessConfig | null = null;

/** 无尽模式的盘面：满盘开局，没有目标分与星级——衡量的是「撑了多久、堆了多高」。 */
export function endlessLevel(): EndlessConfig {
  if (cached) return cached;
  const layout = buildLayout(ENDLESS_SPEC);
  assertLayoutValid(layout);
  cached = {
    name: '无尽 · xixi 大王大赏',
    credits: ENDLESS.buyIn,
    layout,
    focus: 'xixi 大王大赏：撑多久算多久，破产了可以跪',
    seed: ENDLESS_SPEC.seed,
    hotZone: true,
  };
  return cached;
}

/** 盘面摘要，供 `layout` 验证模式打印。 */
export function endlessSummary() {
  return layoutSummary(endlessLevel().layout);
}

/** 币池是否装得下整盘（含给机关注入留的余量）。 */
export function layoutFitsBudget(): { preset: number; budget: number; headroom: number } {
  const preset = endlessLevel().layout.length;
  const headroom = COIN.budget - preset;
  return { preset, budget: COIN.budget, headroom };
}
