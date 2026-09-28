import { COIN_KINDS, KINDS, type CoinKind } from './kinds';
import type { RampId } from './artDirection';
// `ArcanePaletteKey` 的真源在 `render/cabinetTexture.ts`（S20 起），这里只转发。
// 此前这里另有一份同名声明，两处没有编译关联 —— 加 key 时漏改一边不报错，
// 只会让两边的定义域悄悄不一致。
import type { ArcanePaletteKey } from '../render/cabinetTexture';

export type CoinSkinId = 'copper' | 'silver' | 'celadon' | 'obsidian';
export type CabinetSkinId = 'classic' | 'mint' | 'amber' | 'violet';
export type Motif = 'rings' | 'hex' | 'waves' | 'petals';

/** Arcane 风调色板 id（S18）。真源与全部可选值见 `render/cabinetTexture.ts`。 */
export type { ArcanePaletteKey };

type KindColors = { base: string; dark: string; ink: string };
type CoinPalette = Record<CoinKind, KindColors>;

export type CoinSkin = {
  id: CoinSkinId;
  name: string;
  /** 花纹筹码与返币筹码的颜色是玩法信息，不随外观改变。 */
  palette: CoinPalette;
  motif: Motif;
  /**
   * 币的色带（V4 起取代 `metalness` / `roughness`）。
   *
   * `MeshToonMaterial` **没有** `metalness` / `roughness`——三渲二里「金属感」
   * 由**色带的对比度**表达：色阶越硬越像金属，越柔越像瓷器。
   * 所以外观之间的差异从「两个 PBR 数值」变成「选哪条色带」，
   * 观感差异反而更大（`metal` 硬、`cabinet` 柔、`device` 偏紫）。
   *
   * 存档只存外观 **id**（`coinSkins: string[]` / `selectedCoinSkin`），
   * 不存这两个数值，所以替换没有迁移成本。
   */
  ramp: RampId;
  /** 未解锁时显示的成本（筹码数量）。默认外观成本为 0。 */
  cost: number;
};

export type CabinetSkin = {
  id: CabinetSkinId;
  name: string;
  colors: {
    floor: string;
    rail: string;
    pusherTop: string;
    pusherFace: string;
    panel: string;
    trim: string;
  };
  /**
   * Arcane 风贴图调色板（S18）。
   *
   * 三个 canvas（招牌、得分线、热区）都按这个 key 烘；切肤时重画。
   * 老存档没有这个字段 ⇒ 取默认 `jinxMagenta`。
   */
  marqueePalette: ArcanePaletteKey;
  cost: number;
};

/**
 * 锁定的玩法保留色**从 `kinds.ts` 派生**（P6 起不再是第二份手写表）。
 * 除了普通铜币，所有币种的配色在所有外观下保持一致，避免影响可读性
 * （花纹、返币、大赏、钻石、宝箱：颜色本身就是玩法信息）。
 */
const KIND_LOCKED = Object.fromEntries(
  COIN_KINDS.filter((id) => KINDS[id].lockedPalette !== null).map((id) => [id, KINDS[id].lockedPalette]),
) as Record<Exclude<CoinKind, 'bronze'>, KindColors>;

/**
 * 币纹外观。**绿色是玩法保留色**（绿色返币筹码），
 * 所以任何普通铜币的配色都不能落进绿色区间，否则玩家会分不清哪枚能返币。
 * 返币筹码本身还有回环箭头与「+1」压印作为冗余识别，但颜色不能先造成误导。
 *
 * `cost` 是**筹码**定价（v3 起没有图鉴券）。全部外观买齐约 200 筹码，
 * 按每局净流出 8~20 筹码算，是一条 15~30 局的长线钩子。
 */
export const COIN_SKINS: CoinSkin[] = [
  {
    id: 'copper',
    name: '厚铜',
    palette: {
      bronze: { base: '#c8802f', dark: '#7d4a1c', ink: '#4a2a0c' },
      ...KIND_LOCKED,
    },
    motif: 'rings',
    // 中性硬色阶：最像「压铸铜」。
    ramp: 'coin',
    cost: 0,
  },
  {
    id: 'silver',
    name: '银锭',
    palette: {
      bronze: { base: '#c9d2d8', dark: '#7d8a93', ink: '#3b464d' },
      ...KIND_LOCKED,
    },
    motif: 'hex',
    // 最硬、顶段最亮的色阶：银的镜面感靠它。
    ramp: 'metal',
    cost: 25,
  },
  {
    id: 'celadon',
    name: '青瓷',
    palette: {
      bronze: { base: '#5aa9c4', dark: '#2b6d80', ink: '#10333d' },
      ...KIND_LOCKED,
    },
    motif: 'waves',
    // 最柔的色阶（机柜那条）：青瓷是釉面不是金属，色阶要软。
    ramp: 'cabinet',
    cost: 25,
  },
  {
    id: 'obsidian',
    name: '黑曜',
    palette: {
      bronze: { base: '#4a4f63', dark: '#262a38', ink: '#c8b6ff' },
      ...KIND_LOCKED,
    },
    motif: 'petals',
    // 偏紫的色阶：与黑曜的冷紫底同向，暗部更沉。
    ramp: 'device',
    cost: 60,
  },
];

export const CABINET_SKINS: CabinetSkin[] = [
  {
    id: 'classic',
    name: '霓虹玫红',
    /*
     * ★ V2 起整体抬高明度。彩色色带是**乘**在 albedo 上的，原来的 `panel: '#241d13'`
     * 接近全黑——乘任何色带都还是近黑，「暗部换冷色阶」根本出不来。
     * 主体抬到中间调（sRGB 0.3~0.5）之后，色带才有上下两侧的余量。
     * 纯观感改动，不动物理与规则。
     *
     * ── ★ S20 去黄重配色（用户要求：更现代、不要黄色调、优先玫红与蓝）──
     *
     * 四条设计依据，改色前先读：
     *
     * ① **主色钉在 H≈330°（玫红那一侧），不取 310°（姨紫）**。
     *    唯一直接光在 `(-1.6, 3.2, 2.4)`，背板与右侧板 `N·L < 0`，只吃
     *    `HemisphereLight('#cfe4ff','#1b2a3a',2.0)` 的冷光。色相再往紫挪一点，
     *    被冷光一压就读成「紫」而不是「玫红」。
     * ② **币床与台面一律取冷色（蓝）**。币是暖铜 `#c8802f`，只有冷底托得出来。
     *    玫红只出现在**竖直的围合面**（背板 + 两侧高墙）；台面 `pusherTop`
     *    刻意是一条石板蓝紫的「舞台」，不与画面中央的币抢眼。
     * ③ **`rail` 是点缀色而非主体色**。两片低围挡是全机柜唯一的高光金属带
     *    （`metal` 色带顶段 `#fffdf5`），拿它当一条冷钢蓝亮线来切分画面。
     * ④ **招牌走 `jinxMagenta`**：洋红笔触 `#ff36a6` + 青霓虹 `#22e6e9` + 煤黑底，
     *    本身不含黄，与机体的玫红同色相、与冷蓝互补。
     * ⑤ ★ **`trim` 的亮度 = 招牌涂鸦的亮度，`trim` 选的不是「顶板颜色」**。
     *    招牌 / 顶板 / 檐板 / 前立面压条共用一份 `trimMaterial`，而前三件都挂着
     *    Arcane 招牌贴图（见 `Game.pickCabinetMap`）⇒ `MeshToonMaterial` 的
     *    `color` 是**乘**在 `map` 上的，而那张贴图的底是煤黑、**只有笔触有亮度**。
     *    所以 `trim` 实际决定的是「涂鸦线条是什么颜色、有多亮」。
     *    ⇒ `trim` 必须比 `rail` **同色相再亮一档**，否则招牌上的涂鸦读不出来；
     *      同时两者明度要拉开，不然两块蓝看起来是同一块。
     *    （`rail` = 围挡金属 · V 0.61；`trim` = 涂鸦线条 · V 0.75。）
     *
     * 与 `amber`（深海钴蓝）构成**反色的一对**；与 `mint`（绿）、`violet`（夜紫）
     * 在色相上分别隔开（玫红 / 绿 / 钴蓝 / 夜紫）。全部避开 40°~65° 的黄橙区，
     * 也避开 `pusherLip` / `bounty` / `scoreLine` / `drain` 这些**玩法识别色**。
     */
    colors: {
      floor: '#33405c',
      rail: '#59679c',
      pusherTop: '#5d5a78',
      pusherFace: '#545087',
      panel: '#6f2a48',
      trim: '#6a76c0',
    },
    marqueePalette: 'jinxMagenta',
    cost: 0,
  },
  {
    id: 'mint',
    name: '薄荷绿屏',
    colors: {
      floor: '#4f6f64',
      rail: '#b8c8a4',
      pusherTop: '#93b3a2',
      pusherFace: '#6c897b',
      panel: '#3d5248',
      trim: '#5f8571',
    },
    marqueePalette: 'firelight',
    cost: 20,
  },
  {
    id: 'amber',
    name: '深海钴蓝',
    /*
     * ★ S20 去黄重配色：把 `classic` 的玫红 / 钴蓝**反转**过来 —— 钴蓝当主体，
     * 玫红只留作顶端那道横贯的霓虹框。两个理由：
     *
     * ① 机柜色带（`artDirection.ts` 的 `cabinet`）暗档本来就是**蓝紫** `#3f4c6b`，
     *    所以钴蓝机体会读起来偏单色、少一层色相张力；`trim`（顶板 + 檐板 +
     *    招牌框）取玫红 `#8a3560` 恰好补回这层张力 —— 面积最小，位置却最抢眼。
     * ② 必须与 `violet`（夜紫机柜，H≈260°）分开：本色相钉在 **205°~215°**，
     *    是钴蓝不是紫。四套皮肤因此铺开成 玫红 / 绿 / 钴蓝 / 夜紫。
     *
     * `marqueePalette` 用 S20 新增的 `cobaltArcane`（电光蓝笔触 + 玫红辉光），
     * 与 `classic` 的 `jinxMagenta`（洋红笔触 + 青辉光）构成反色的一对。
     * ⚠️ 别退回 `viArcane` / `firelight` —— 它们的主色 `#f35b04` / `#ffb13d`
     *    是橙黄，与本方案的去黄要求直接冲突。
     */
    colors: {
      floor: '#26445f',
      rail: '#5f95b8',
      pusherTop: '#4a6e93',
      pusherFace: '#3f6488',
      panel: '#2f4f7d',
      trim: '#8a3560',
    },
    marqueePalette: 'cobaltArcane',
    cost: 20,
  },
  {
    id: 'violet',
    name: '夜紫机柜',
    colors: {
      floor: '#544d6e',
      rail: '#b2a3d4',
      pusherTop: '#8c85aa',
      pusherFace: '#6a6388',
      panel: '#443e5c',
      trim: '#71629a',
    },
    marqueePalette: 'jinxMagenta',
    cost: 50,
  },
];

export function coinSkinById(id: string): CoinSkin {
  return COIN_SKINS.find((skin) => skin.id === id) ?? COIN_SKINS[0];
}

export function cabinetSkinById(id: string): CabinetSkin {
  const found = CABINET_SKINS.find((skin) => skin.id === id);
  if (found) return found;
  const fallback = CABINET_SKINS[0];
  // 老存档（没有 marqueePalette 字段）走 classic 的默认色。
  return { ...fallback, marqueePalette: fallback.marqueePalette ?? 'jinxMagenta' };
}
