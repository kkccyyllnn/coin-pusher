import { COIN, ENDLESS, TABLE } from './constants';
import { COIN_SCALE } from './coinScale';
import { buildLayout, assertLayoutValid, layoutSummary, layoutCapacity, fitCells, MAX_JITTER, DRAIN_CLEARANCES, type CoinPlacement, type LayoutSpec } from './layout';

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
 * 币床：**一整张连续网格**，再从中间切成前后两段。
 *
 * **必须从推板归位前缘一直铺到得分线前**，不留死区。旧盘面从 z=0.32 才开始，
 * 而推板归位前缘在 -0.16：中间 0.48 米的空档逼着行程必须拉到 0.48 米以上才碰得到币，
 * 而 0.84 米的行程会把整张币床当刚体推走（实测 8.4 枚/循环、单循环 106 枚的垮塌）。
 * 参考项目（coin-pusher-2000）的币床同样是从推板前缘铺到前沿的，没有空档。
 *
 * 分成两段的唯一理由是**给返币筹码单独留一块前沿地**：
 * 返币只占盘面的 4%，随机撒在整张床上时，一局（只越线几十枚）里很可能一枚都没轮到，
 * 玩家就完全看不到「绿色返币筹码」这个机制。把它固定放在前沿，它会在一局的前几轮就掉出来。
 *
 * ## ★ 列数/行数一律派生，不写死（S13）
 *
 * 原尺寸下这里是 **11 列 × 9 行**（列距 0.144、行距 0.145，自检要求同层间距 ≥ 币径 × 0.98
 * = 0.1176，抖动 0.005 之后最坏间距 0.134，还留得住）。但 `?coin=1.1/1.2` 会同时放大
 * **币径与抖动**：×1.2 时判据涨到 0.14112、抖动涨到 0.006，步距下限 `MIN_STEP` 从
 * 0.1276 涨到 **0.15312** —— 0.144 的步距当场不够用。所以格数交给 `fitCells()` 反算：
 * 跨度装得下几格就放几格，**币越大格越少**（×1.2 时 11→10 列、9→8 行）。
 * 写死格数的版本不是「密一点」，是**启动即抛 `盘面重叠`**。
 *
 * ## ★ 为什么两段必须共用同一份行距（踩过的坑）
 *
 * 第一版让两段**各自**用 `fitCells(zSpan, 原行数)` 算行距。原尺寸下两段行距都是 0.145，
 * 交界正好落在 0.665 / 0.81，看不出问题。但 ×1.2 时后段 6→5 行、行距涨到 0.18125，
 * 而前段 3→2 行、行距涨到 0.29 —— **交界处却还是老位置**，实际间距 0.145 < 0.15312，
 * 开局抛「盘面重叠：(0.719, 0.667) 与 (0.724, 0.807) 间距 0.139」。
 * 根因是「分段各自算行距」这件事本身：**两段是同一张床**，行距必须由**整张床**决定。
 * 所以现在先算总行数与总行距，再按行数切段（后段 = 总行数 − 前段行数）。
 */
const BED_X_MIN = -0.72;
const BED_X_MAX = 0.72;
const BED_SPAN_X = BED_X_MAX - BED_X_MIN;
/** 币床列数（原尺寸 11）。三段共用，列数一致拼起来才是对齐的一整张床。 */
const BED_COLUMNS = fitCells(BED_SPAN_X, 11);

/** 币床的 z 范围：推板归位前缘之后，到得分线之前。 */
const BED_Z_MIN = -0.06;
const BED_Z_MAX = 1.1;
/** 币床总行数（原尺寸 9）。★ 由**整张床**的深度反算，不是分段各算。 */
const BED_ROWS = fitCells(BED_Z_MAX - BED_Z_MIN, 9);
/** 行距（米）：由总行数反推，两段共用。原尺寸 0.145。 */
const BED_STEP_Z = (BED_Z_MAX - BED_Z_MIN) / (BED_ROWS - 1);
/** 前段（前沿地）的行数：原尺寸 3 行。至少给后段留 1 行。 */
const BED_FRONT_ROWS = Math.min(3, BED_ROWS - 1);
const BED_BACK_ROWS = BED_ROWS - BED_FRONT_ROWS;
/** 后段最后一行的 z；前段从它再走一行开始，所以两段之间**正好一个行距**。 */
const BED_BACK_Z_MAX = BED_Z_MIN + (BED_BACK_ROWS - 1) * BED_STEP_Z;
const BED_FRONT_Z_MIN = BED_Z_MIN + BED_BACK_ROWS * BED_STEP_Z;

const DECK_Z_MIN = -1.1;
const DECK_Z_MAX = -0.28;

const BED_BACK = {
  xMin: BED_X_MIN,
  xMax: BED_X_MAX,
  zMin: BED_Z_MIN,
  zMax: BED_BACK_Z_MAX,
  columns: BED_COLUMNS,
  rows: BED_BACK_ROWS,
};
const BED_FRONT = {
  xMin: BED_X_MIN,
  xMax: BED_X_MAX,
  zMin: BED_FRONT_Z_MIN,
  zMax: BED_Z_MAX,
  columns: BED_COLUMNS,
  rows: BED_FRONT_ROWS,
};
/**
 * 币床**最前沿的一行**（离得分线 0.05 米）。
 *
 * 返币筹码钉在这一行、并且只钉 3 枚：一局只越线几十枚，而前段两行在整局里往往都轮不到
 * ——实测一局 22 次越线、返币一次都没露面。
 * 钉在最前沿之后它必然在开局几轮就掉出来，「绿色返币筹码」这个机制才看得见。
 */
const BED_EDGE = {
  xMin: BED_X_MIN,
  xMax: BED_X_MAX,
  zMin: BED_Z_MAX,
  zMax: BED_Z_MAX,
  columns: BED_COLUMNS,
  rows: 1,
};
/**
 * 上层台面（推板顶面）的铺法：**铺满当前区域**（S13 S6）。
 *
 * 格数与币床同一套派生规则（`fitCells`），所以**币越大格越少**：
 * 原尺寸 11 × 6 = 66 枚；×1.2 时步距下限 `MIN_STEP` 涨到 0.15312，
 * 列距 1.44/10 = 0.144 就装不下 11 列 → 10 × 6 = **60 枚**。
 * 一律以 `layout` 验证模式打印的读数为准，不要在注释里手算（这条已经坑过一次）。
 *
 * ⚠️ 这里原先写着「只放 18 枚，密铺会在一秒内被台面输送整片倾泻下去」——**那句话是错的**。
 * `Game.ts:803` 的 `if (coin.preset) return;` 让**预置币根本不吃台面输送**，
 * 所以密铺不会倾泻。18 枚只是历史遗留，不是物理限制。
 *
 * ## 铺满的意义：它是上层唯一的「喂料源」
 *
 * S13 把台面输送归零之后，台面上的币**只剩真实接触力**。推板的往复是对称的
 * （`PUSHER_CYCLE` 两侧都是 0.9 秒的 `smoothstep`），所以摩擦能给出的**一个循环的净位移
 * 就是 0** —— 币被带上去、又被带回来，不会自己往前挪。真机也一样：
 * 上层台面的币是靠**后面不断落下的币把它拱出去**的。
 *
 * 于是「台面上有多少币」直接决定喂料能不能发生：稀疏的 18 枚之间有空档，
 * 新落下的币只是掉进空档里；铺满之后整层连成一片，落下的币才顶得动前面。
 * 这就是 S6 与 S13 的手感改造是**同一件事**的原因。
 *
 * S0 阶段**刻意不改密度**：那一步要单独观察币尺寸档位的效果，一次只动一个变量（纪律 1）。
 */
const DECK = {
  xMin: BED_X_MIN,
  xMax: BED_X_MAX,
  zMin: DECK_Z_MIN,
  zMax: DECK_Z_MAX,
  columns: fitCells(BED_SPAN_X, 11),
  rows: fitCells(DECK_Z_MAX - DECK_Z_MIN, 6),
};

/**
 * **背板位置 × 币床末排 × 落币口**的三条跨模块派生守卫（S23）。
 *
 * S23 把可见背板平面（`TABLE.backZ`）前移到「上层币床最后一排的后缘」之后，
 * 有三个数值关系必须同时成立，而它们各自横跨三个模块
 * （`constants` 的背板与落币口 × 本文件的盘面 × 币尺寸档位）：
 *
 * ① **末排恰好贴着背板**：`DECK.zMin − 抖动 − 半径 == TABLE.backZ`。
 *    抖动必须算进去 —— `layout.buildLayout` 给每个格子加 ±{@link MAX_JITTER}，
 *    所以末排的**实际**后缘比名义排距还后 6 毫米。这条就是「红线」的定义本身。
 * ② **末排不嵌进背板**：`DECK.zMin − 抖动 ≥ TABLE.backZ + 半径`（等价于 ①，写出来是为了
 *    在报错信息里能分清是「悬空」还是「嵌进去」）。
 * ③ **落币口在背板之前**：`drop.z − jitterZ − 半径 ≥ TABLE.backZ`
 *    —— 出生间隙。不成立时币出生就嵌在墙里，求解器会把它弹飞。
 *
 * 三条都属于「改了常量就静默错位」：错位本身不报错，只是币悬空、嵌入，
 * 从诊断上看什么都没有。所以放在配置期钉死，**数值一律现算**，不在这里写第二份。
 */
function assertWallMeetsDeck(): void {
  const deckBack = DECK.zMin - MAX_JITTER - COIN.radius;
  if (Math.abs(deckBack - TABLE.backZ) > 1e-6) {
    throw new Error(
      `上层币床末排没有贴着背板：DECK.zMin − 抖动 − 半径 = ${deckBack.toFixed(4)} ≠ ` +
        `TABLE.backZ = ${TABLE.backZ}` +
        `（差 ${((deckBack - TABLE.backZ) * 1000).toFixed(1)} 毫米 —— ` +
        `背板前移/后移之后必须同步挪 DECK.zMin，或反之）`,
    );
  }
  const landingBack = TABLE.drop.z - TABLE.drop.jitterZ - COIN.radius;
  if (landingBack < TABLE.backZ - 1e-9) {
    throw new Error(
      `落币口太靠后：drop.z − jitterZ − 半径 = ${landingBack.toFixed(4)} < ` +
        `TABLE.backZ = ${TABLE.backZ}` +
        `（币出生就嵌进背板，把 TABLE.drop.z 往前挪）`,
    );
  }
}

assertWallMeetsDeck();

/**
 * 两座币塔：都在推板前缘够得到的位置（z=0.62），靠推板接触自然唤醒。
 *
 * ## ★ S13 起层数不再受任何高度带约束（5 → 9 层）
 *
 * 原先层数被「台面输送」的高度带卡死：`TABLE.conveyor` 是 y ∈ [0.14, 0.34]，
 * 而 `assertLayoutValid` 会拦「币床的币落进那一段」，于是塔顶必须 **< 0.14**
 * ⇒ ×1.2 下最多 5 层（层高 0.0252，`REST_Y + 4 × 0.0252 = 0.1148`；6 层 = 0.14 正好踩线）。
 *
 * 那条约束的本质是**归属划分**（这枚币算台面还是算币床），而归属是**体积**问题：
 * S13 把判据从「高度带」换成 `layout.isOnDeckVolume`（高度 **+ z 区间**）。
 * 塔摆在 `z = 0.62`，远在推板归位前缘 `pusherFrontZAtRest = −0.16` 之后，
 * **再高也不会落进台面体积**。
 *
 * 于是「塔能盖多高」重新变成纯物理问题（会不会倒），不再是记账问题。
 *
 * 9 层是本轮的目标规模：塔顶 `REST_Y + 8 × LAYER_STEP`，×1.2 下 = **0.2156 米**，
 * 已经高过推板顶面（0.2）—— 正是用户要的「塔很高很具规模」。
 * 站不站得住由 `physics` ①（静置 10 秒全静止）与 ④（静止后不穿插）判。
 *
 * ⚠️ 塔高直接决定盘面枚数（每座 `4 × 层数`），所以下面的分解表跟着变了。
 * 枚数一律以 `layout` 验证模式的读数为准，**不要拿这张表去核对别的档位**。
 */
const TOWER_A = { x: 0.34, z: 0.62, layers: 9 };
const TOWER_B = { x: -0.42, z: 0.62, layers: 9 };

/**
 * 塔基保留区。
 *
 * **真正的兜底是 `assertLayoutValid` 的实距判据**（同层间距 ≥ 币径 × 0.98）：
 * 它开局就跑，不通过直接抛错。这里的盒子是一个**够用的启发式**——
 * 开小了会让「紧贴塔边的那一列」压线，开大了白让格子。
 *
 * ## 严格下界：`offset + spacing`
 *
 * `offset` = 塔角币离塔心 = `radius + 0.001`；`spacing` = 实距判据 = `币径 × 0.98`。
 * 证明：盒子外的点必有一轴满足 `|Δ| > half`，于是它到角币在那一轴上的距离
 * `≥ half − offset`，取 `half = offset + spacing` 就得 `≥ spacing`。
 * 原尺寸下 = 0.1786。
 *
 * ## 为什么还要跟历史比例值取 `max`
 *
 * 历史值是 **0.20 × 0.16**：x 侧比严格下界宽，z 侧反而比它窄（靠**网格离散**兜住——
 * 币床行距 0.145，最近能活下来的行在 0.375，离塔 0.245 米）。
 * 直接把 z 换成严格下界（0.16 → 0.1786）会让币床多让掉一列，**改动原尺寸的盘面**，
 * 而 S0 只该改币尺寸这一个变量（纪律 1）。所以两个轴都取
 * `max(历史比例值 × 档位, 严格下界)`——原尺寸一格不差，放大后严格下界接管。
 *
 * ## 为什么 z 侧必须随币放大（踩过的坑）
 *
 * ×1.1 时 `0.16 × 1.1 = 0.176 < 0.19`，于是 `BED_FRONT` 最靠后的那一行（`z = 0.81`）
 * **没被保留**，而它到塔角币只有 0.125 米、判据已经涨到 0.1294 ——
 * 开局 `assertLayoutValid` 直接抛「盘面重叠：(0.434, 0.809) 与 (0.407, 0.687) 间距 0.125」。
 * 这就是「启发式不随尺寸放大」的代价：原尺寸侥幸合法（0.1327 vs 0.1176），
 * 币一大就翻车。严格下界（×1.1 = 0.1964、×1.2 = 0.2141）自动把那一行吃掉。
 *
 * 原尺寸下让掉 3 列 × **2** 行 × 2 座 = 12 格（66 → 54）。
 *
 * ⚠️ 行数是 **2** 不是 3：保留区 z ∈ [0.46, 0.78]，而 `BED_BACK` 的行在
 * −0.06 / 0.085 / 0.23 / 0.375 / 0.52 / 0.665 —— 只有 0.52 与 0.665 落进去。
 * 这条注释原先写「3 行 × 2 座 = 18 格（66 → 48）」，与实测的 108 = (66 − 12) × 2
 * 差了 12 格。**盘面摘要的总枚数是对的，错的是注释里的手算式**——
 * 所以「手写第二份算术」这件事本身就是坑，总数请以 `layout` 验证模式的读数为准。
 */
const TOWER_CLEAR = (() => {
  const offset = COIN.radius + 0.001;
  const spacing = COIN.radius * 2 * 0.98;
  const strict = offset + spacing;
  return {
    halfX: Math.max(0.2 * COIN_SCALE, strict),
    halfZ: Math.max(0.16 * COIN_SCALE, strict),
  };
})();

/**
 * 无尽满盘的生成配置。目标预置 300 枚出头（P2 从 74 枚提到这个量级）。
 *
 * ★ 下面的分解表是**原尺寸（`?coin` 不写）的基线**。`?coin=1.1/1.2` 下币径、抖动、
 * 格数、层高全都会变，枚数自然不同（币越大装得越少）——**不要拿这张表去核对别的档位**，
 * 总数一律以 `layout` 验证模式打印的 `preset` 为准。
 *
 * ```
 *   上层台面      66（11×6，铺满；S13 S6 从 18 枚改来）
 *   币床后段 1-2 层 108 = (66 格 − 12 格塔基保留) × 2 层，铜币
 *   币床后段 3 层    44（铜币，稀疏铺）
 *   币床后段 4 层    39 = 花纹 30 + 返币 9（共用同一份抽样、靠 pickFrom 错开）
 *   币床前段 1-2 层  62 = 31 格 × 2 层，铜币（33 格再让掉排水口的 2 格）
 *   币床前段 3 层     3（返币，贴线摆着）
 *   币塔            72 = 2×2×9 × 2 座（S13 从 2×2×5 × 2 座 = 40 改来）
 *   合计           394
 * ```
 *
 * 层与层之间是**前缀嵌套**的（`pick` 取洗过序列的前 N 个），所以上层币一定压在下层币上，
 * 不会有开局就往下掉的悬空币——「静置 10 秒全静止」这条验收靠的就是这个。
 *
 * 币种配比刻意沿用旧盘面的比例（铜币 ~83%、花纹 ~12%、返币 ~4%），
 * 因为回收率是按「越线构成」标定的——比例一变，闸门（`kinds.ts` 的 `gateChance`）就要重标。
 * S13 §5 就是这么重标的一次：`越线/投币` 从 1.328 涨到 1.70~2.15，
 * 于是铜币闸门 0.18 → 0.09、花纹从「必返」改「半数返」、返币 3 → 2、大赏 8 → 5。
 *
 * ## 排水口必须让位（P10 S7）
 *
 * `BED_FRONT` / `BED_EDGE` 的网格含 `x = ±0.72` 一列，而 `z = 1.1` 正落在
 * 排水口的 z 带 `[0.98, 1.15]` 里 —— 不让位的话，`BED_FRONT` 两层 × 2 列 = **4 枚**
 * 预置币开局就坐在洞上，第一帧掉出机柜，`activeCoins` 从 318 静默变成 314。
 * 让位后 318 → 314，而**这 4 枚本来就是会被洞吃掉的那批**（在洞的正上方），
 * 所以「洞让盘面变少」不是损失，是把一个第一帧就发生的泄漏提到配置期说清楚。
 */
const ENDLESS_SPEC: LayoutSpec = {
  seed: 606,
  clearances: [
    { x: TOWER_A.x, z: TOWER_A.z, ...TOWER_CLEAR },
    { x: TOWER_B.x, z: TOWER_B.z, ...TOWER_CLEAR },
    ...DRAIN_CLEARANCES,
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
    // 上层**铺满**（S13 S6）：台面输送归零后，这层是上层唯一的喂料源，见 `DECK` 的注释。
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

/**
 * 盘面容量：把所有稀疏铺去掉后能放多少枚（见 `layout.layoutCapacity`）。
 *
 * 判据用它算「填充率」——那是个与币尺寸档位无关的量，而「满盘多少枚」不是。
 * 配置是静态的，所以算一次就缓存。
 */
let cachedCapacity: number | null = null;
export function endlessCapacity(): number {
  cachedCapacity ??= layoutCapacity(ENDLESS_SPEC);
  return cachedCapacity;
}

/** 币池是否装得下整盘（含给机关注入留的余量）。 */
export function layoutFitsBudget(): { preset: number; budget: number; headroom: number } {
  const preset = endlessLevel().layout.length;
  const headroom = COIN.budget - preset;
  return { preset, budget: COIN.budget, headroom };
}
