/**
 * 可试听音效的事件目录。
 *
 * 这是**调试面板与控制台钩子唯一的事件真源**：面板按它生成按钮，钩子按它解析 name。
 *
 * ★ 粒度是「游戏事件」而不是「素材槽位」——`landing('heavy')`、`score('bounty', 1)`、
 *   `slotReveal('fine')` 这些才是玩家与开发者会去指的东西。每个条目的 `play` 直接调
 *   `AudioSystem` 的公开方法，从而**完整复用它与素材/合成音之间的兜底关系**：
 *   有素材就放素材，没有就退合成音，调用方不需要知道区别。
 *
 * ★ 只依赖 `AudioSystem` 的**类型**，不 import 它的值，也不被它 import —— 这样
 *   不会形成循环依赖。（`AudioSystem` 侧只提供 `runAudition` 这个通用能力。）
 */

import type { AudioSystem, AuditionResult, SelectorKey } from './AudioSystem';

export type AudioEvent = {
  /** 稳定 id。控制台钩子与脚本用它指定事件。 */
  name: string;
  /** 面板上显示的中文名。 */
  label: string;
  /**
   * 对应的素材槽位。
   * `null` = 该事件目前没有素材，只能试听合成音（面板会标注、也不允许挂载）。
   */
  selector: SelectorKey | null;
  /** 真正调用的游戏方法。 */
  play: (audio: AudioSystem) => void;
};

/**
 * 全部可试听事件。
 *
 * 顺序有意义：`eventForSelector()` 取**首个**匹配项作为槽位的代表事件，
 * 所以 `scoreBig`（大赏得分）必须排在 `slotWin`（老虎机中奖）前面——两者共用
 * 同一个 `scoreBig` 槽位，而槽位试听应该听到更常见的那一个。
 */
export const AUDIO_EVENTS: readonly AudioEvent[] = [
  // ── 有素材、可挂载 ────────────────────────────────────────────────────
  { name: 'drop', label: '投币下落', selector: 'drop', play: (a) => a.drop() },
  { name: 'landLight', label: '落定·轻', selector: 'landLight', play: (a) => a.landing('light') },
  { name: 'landHeavy', label: '落定·重', selector: 'landHeavy', play: (a) => a.landing('heavy') },
  { name: 'scoreSmall', label: '得分·铜（小）', selector: 'scoreSmall', play: (a) => a.score('bronze', 1) },
  { name: 'scoreMid', label: '得分·中', selector: 'scoreMid', play: (a) => a.score('pattern', 1) },
  { name: 'scoreBig', label: '得分·大赏', selector: 'scoreBig', play: (a) => a.score('bounty', 1) },
  // 连击会同时触发 `scoreMid` + `comboUp` 两层——这正是它在游戏里的真实听感。
  { name: 'comboUp', label: '连击上行（含得分层）', selector: 'comboUp', play: (a) => a.score('pattern', 4) },
  { name: 'mark', label: 'XIXI 点亮', selector: 'mark', play: (a) => a.mark() },
  { name: 'boostReady', label: '加力就绪', selector: 'boostReady', play: (a) => a.boostReady() },
  { name: 'boostUse', label: '加力使用', selector: 'boostUse', play: (a) => a.boostUse() },
  { name: 'payout', label: '返币到账', selector: 'payout', play: (a) => a.payoutReturn() },
  // 转动素材只有 1 秒、而真实转动 3.4~4.0 秒；这里传 1.2 秒只为试听音色，
  // 不想让面板点一下响满四秒。
  { name: 'slotSpin', label: '老虎机转动', selector: 'slotSpin', play: (a) => a.slotSpin(1.2) },
  { name: 'slotWin', label: '老虎机·中奖', selector: 'scoreBig', play: (a) => a.slotReveal('win') },
  { name: 'uiClick', label: 'UI 点击', selector: 'uiClick', play: (a) => a.uiClick() },

  // ── 暂无素材：只能试听合成音，不允许挂载 ──────────────────────────────
  { name: 'hotHit', label: '热区命中（合成音）', selector: null, play: (a) => a.hotHit() },
  { name: 'drain', label: '掉下水道（合成音）', selector: null, play: (a) => a.drain() },
  { name: 'slotFine', label: '老虎机·胡萝卜（合成音）', selector: null, play: (a) => a.slotReveal('fine') },
  { name: 'slotMiss', label: '老虎机·杂牌（合成音）', selector: null, play: (a) => a.slotReveal('miss') },
  { name: 'settleSuccess', label: '收工·成功（合成音）', selector: null, play: (a) => a.settle('success') },
  { name: 'settleExhausted', label: '收工·耗尽（合成音）', selector: null, play: (a) => a.settle('exhausted') },
];

/** 全部事件名，供控制台钩子列出。 */
export function audioEventNames(): string[] {
  return AUDIO_EVENTS.map((event) => event.name);
}

export function findAudioEvent(name: string): AudioEvent | null {
  return AUDIO_EVENTS.find((event) => event.name === name) ?? null;
}

/** 某个素材槽位的代表事件（首个匹配项）。槽位试听走它，从而复用同一套兜底逻辑。 */
export function eventForSelector(key: SelectorKey): AudioEvent | null {
  return AUDIO_EVENTS.find((event) => event.selector === key) ?? null;
}

function result(
  played: boolean,
  event: AudioEvent | null,
  fallbackName: string,
  source: AuditionResult['source'],
  context: AuditionResult['context'],
): AuditionResult {
  return {
    played,
    name: event?.name ?? fallbackName,
    selector: event?.selector ?? null,
    source,
    context,
  };
}

/**
 * 试听一个事件。
 *
 * 先 `await unlock()`：`unlock()` 是幂等的（已解锁立即返回），但**首次**点击面板时
 * 音频上下文还在 `resume()` 的异步过程中——不等它，第一次试听会静悄悄地没声音。
 * 这正是把这里做成 async 的唯一原因。
 */
export async function auditionEvent(audio: AudioSystem, name: string): Promise<AuditionResult> {
  const event = findAudioEvent(name);
  await audio.unlock();
  const state = audio.debug.contextState;
  if (!event) return result(false, null, name, 'none', state);
  if (state !== 'running') return result(false, event, name, 'none', state);

  audio.runAudition(() => event.play(audio));
  return result(true, event, name, audio.lastAuditionSource, state);
}

/** 试听某个素材槽位（走它的代表事件）。 */
export async function auditionSelector(audio: AudioSystem, key: SelectorKey): Promise<AuditionResult> {
  const event = eventForSelector(key);
  if (!event) return result(false, null, key, 'none', audio.debug.contextState);
  return await auditionEvent(audio, event.name);
}
