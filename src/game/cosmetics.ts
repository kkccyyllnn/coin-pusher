import type { CoinKind } from './constants';

export type CoinSkinId = 'copper' | 'silver' | 'celadon' | 'obsidian';
export type CabinetSkinId = 'classic' | 'mint' | 'amber' | 'violet';
export type Motif = 'rings' | 'hex' | 'waves' | 'petals';

type CoinPalette = Record<CoinKind, { base: string; dark: string; ink: string }>;

export type CoinSkin = {
  id: CoinSkinId;
  name: string;
  /** 花纹筹码与返币筹码的颜色是玩法信息，不随外观改变。 */
  palette: CoinPalette;
  motif: Motif;
  metalness: number;
  roughness: number;
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
  cost: number;
};

/** 花纹、返币与大赏筹码的配色在所有外观下保持一致，避免影响可读性。 */
const KIND_LOCKED = {
  pattern: { base: '#f4e6c8', dark: '#c9a86e', ink: '#8c3f6b' },
  payout: { base: '#3f9c5c', dark: '#1f6b3a', ink: '#0f3d20' },
  // 金色与铜色的明度刻意拉开：大赏币只在无尽模式出现，但玩家不该靠猜。
  bounty: { base: '#ffd24a', dark: '#b9861f', ink: '#5c3a06' },
} as const;

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
    metalness: 0.72,
    roughness: 0.36,
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
    metalness: 0.86,
    roughness: 0.24,
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
    metalness: 0.34,
    roughness: 0.42,
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
    metalness: 0.62,
    roughness: 0.3,
    cost: 60,
  },
];

export const CABINET_SKINS: CabinetSkin[] = [
  {
    id: 'classic',
    name: '原色机柜',
    colors: {
      floor: '#2f3d34',
      rail: '#8a7346',
      pusherTop: '#5b6f64',
      pusherFace: '#3f4f47',
      panel: '#241d13',
      trim: '#4d3a20',
    },
    cost: 0,
  },
  {
    id: 'mint',
    name: '薄荷绿屏',
    colors: {
      floor: '#31473f',
      rail: '#9fb08a',
      pusherTop: '#6f8f80',
      pusherFace: '#4a6357',
      panel: '#18251f',
      trim: '#3c5a4a',
    },
    cost: 20,
  },
  {
    id: 'amber',
    name: '琥珀街机',
    colors: {
      floor: '#3d3428',
      rail: '#c39a55',
      pusherTop: '#7d6a4e',
      pusherFace: '#57493a',
      panel: '#2a2118',
      trim: '#6b4f2a',
    },
    cost: 20,
  },
  {
    id: 'violet',
    name: '夜紫机柜',
    colors: {
      floor: '#353047',
      rail: '#9a8ac0',
      pusherTop: '#6a6488',
      pusherFace: '#494464',
      panel: '#1e1b2b',
      trim: '#4a3f68',
    },
    cost: 50,
  },
];

export function coinSkinById(id: string): CoinSkin {
  return COIN_SKINS.find((skin) => skin.id === id) ?? COIN_SKINS[0];
}

export function cabinetSkinById(id: string): CabinetSkin {
  return CABINET_SKINS.find((skin) => skin.id === id) ?? CABINET_SKINS[0];
}
