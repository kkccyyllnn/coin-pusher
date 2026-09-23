/**
 * xixi 大王的嘲讽文案库。
 *
 * 按**累计跪求次数**分四级，同层随机抽取、不连续重复。
 * 文案纪律：嘲讽只嘲手气与决策，不嘲玩家本人；Tier 3 封顶，不升级到真正的恶意——
 * 嘲讽的价值在于好笑，一旦刻薄就不好笑了。
 */
const TIERS: string[][] = [
  // Tier 0 · 首次破产
  [
    '就这？本大王的茶还没凉，你就空了？',
    '20 筹码撑了 {drops} 投——它们是纸糊的吗？',
    '破产而已，脸别红。本大王见过更惨的。',
  ],
  // Tier 1 · 第 2~3 次
  [
    '又来。本大王这儿是推币机，不是善堂——行吧，是善堂。',
    '跪姿挺标准，练过？起来，这次少给点。',
    '你上一条命的骨气，和筹码一起没了。本大王都看见了。',
  ],
  // Tier 2 · 第 4~5 次
  [
    '本大王开始怀疑：你是来推币的，还是来跪的？',
    '赏赐在递减，膝盖在递增。这买卖，本大王赚麻了。',
    '揣着没用的加力破产——是舍不得，还是忘了？',
  ],
  // Tier 3 · 6 次以上
  [
    'xixi 大王大赏·终身成就奖：累计跪求 {begs} 次，仍未学会量入为出。',
    '年度最佳反向慈善家，就是你了。拿去，别谢本大王。',
    '本大王宣布：从今往后，你的膝盖归本机台所有。',
  ],
];

/** 赏赐播报（跪求成功后抽一条）。 */
const GRANTS = [
  '赏你 {grant} 筹码。滚去推币，别再回来。',
  '看在你跪得诚恳。就这一次。（本大王每次都这么说）',
  '{grant} 筹码，拿好。本大王今天心情好，别问为什么。',
];

/**
 * 收工总结的一句话。
 *
 * 收工不是破产，不该再嘲讽——玩家主动离场，这里只做一次收束：
 * 提醒他钱包里剩下多少、下一步该去哪（图鉴）。
 */
const CLOSINGS = [
  '本局到此为止。钱包里的筹码，才是你能带走的。',
  '收工。本大王记下这一局了——下次别带这么少来。',
  '盘面清空，账已结。图鉴在等你把筹码花出去。',
];

/** 每个文案池各自记住上一条，保证「同层随机、不连续重复」。 */
const lastPicked = new Map<string[], string>();

function pick(lines: string[], roll: number): string {
  if (lines.length <= 1) return lines[0];
  const previous = lastPicked.get(lines);
  const start = Math.abs(Math.floor(roll)) % lines.length;
  for (let offset = 0; offset < lines.length; offset += 1) {
    const candidate = lines[(start + offset) % lines.length];
    if (candidate !== previous) {
      lastPicked.set(lines, candidate);
      return candidate;
    }
  }
  return lines[start];
}

function tierOf(totalBegs: number): number {
  if (totalBegs <= 1) return 0;
  if (totalBegs <= 3) return 1;
  if (totalBegs <= 5) return 2;
  return 3;
}

/** 取一条嘲讽文案。`totalBegs` 是终身累计跪求次数。 */
export function tauntFor(totalBegs: number, drops: number, roll = Math.random() * 1000): string {
  const lines = TIERS[tierOf(totalBegs)];
  return pick(lines, roll).replace('{drops}', String(drops)).replace('{begs}', String(totalBegs));
}

/** 取一条赏赐播报。 */
export function grantLine(grant: number, roll = Math.random() * 1000): string {
  return pick(GRANTS, roll).replace('{grant}', String(grant));
}

/** 取一条收工总结。 */
export function closingLine(roll = Math.random() * 1000): string {
  return pick(CLOSINGS, roll);
}

/** 仅供测试：清掉「不连续重复」的记忆。 */
export function resetTauntMemory(): void {
  lastPicked.clear();
}

export const TAUNT_TIER_COUNT = TIERS.length;
export const TAUNT_TOTAL_LINES = TIERS.reduce((sum, tier) => sum + tier.length, 0);
