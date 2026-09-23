import type { CoinKind } from '../game/constants';

type ToneSpec = {
  type: OscillatorType;
  from: number;
  to: number;
  duration: number;
  gain: number;
  delay?: number;
};

/**
 * 程序化音效。不依赖任何外部音频资产，先保证事件有声音再谈音色。
 */
export class AudioSystem {
  private context: AudioContext | null = null;
  private unlocked = false;
  private muted = false;

  constructor() {
    const unlock = () => {
      void this.unlock();
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
  }

  async unlock(): Promise<void> {
    if (this.unlocked) return;
    const AudioContextClass =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return;
    this.context = new AudioContextClass();
    await this.context.resume();
    this.unlocked = true;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
  }

  drop(): void {
    this.tone({ type: 'triangle', from: 520, to: 300, duration: 0.12, gain: 0.06 });
  }

  landing(): void {
    this.tone({ type: 'square', from: 180, to: 120, duration: 0.05, gain: 0.03 });
  }

  score(kind: CoinKind, combo: number): void {
    const base = kind === 'pattern' ? 700 : kind === 'payout' ? 620 : 460;
    const lift = Math.min(combo - 1, 6) * 40;
    this.tone({ type: 'triangle', from: base, to: base + 240 + lift, duration: 0.14, gain: 0.07 });
    if (kind !== 'bronze') {
      this.tone({ type: 'sine', from: base * 1.5, to: base * 2, duration: 0.18, gain: 0.05, delay: 0.06 });
    }
  }

  mark(): void {
    this.tone({ type: 'sine', from: 880, to: 1180, duration: 0.1, gain: 0.05 });
  }

  boostReady(): void {
    this.tone({ type: 'sawtooth', from: 300, to: 900, duration: 0.28, gain: 0.05 });
  }

  boostUse(): void {
    this.tone({ type: 'sawtooth', from: 200, to: 120, duration: 0.3, gain: 0.07 });
  }

  payoutReturn(): void {
    this.tone({ type: 'triangle', from: 640, to: 960, duration: 0.16, gain: 0.06 });
    this.tone({ type: 'triangle', from: 960, to: 1280, duration: 0.16, gain: 0.05, delay: 0.1 });
  }

  settle(reason: 'success' | 'exhausted' | 'budget'): void {
    if (reason === 'success') {
      [0, 0.12, 0.24].forEach((delay, index) => {
        this.tone({
          type: 'triangle',
          from: 520 + index * 160,
          to: 780 + index * 180,
          duration: 0.22,
          gain: 0.06,
          delay,
        });
      });
    } else {
      this.tone({ type: 'sine', from: 320, to: 180, duration: 0.5, gain: 0.05 });
    }
  }

  dispose(): void {
    void this.context?.close();
    this.context = null;
  }

  private tone(spec: ToneSpec): void {
    if (this.muted) return;
    const context = this.context;
    if (!context || context.state !== 'running') return;

    const start = context.currentTime + (spec.delay ?? 0);
    const oscillator = context.createOscillator();
    const gain = context.createGain();

    oscillator.type = spec.type;
    oscillator.frequency.setValueAtTime(Math.max(40, spec.from), start);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(40, spec.to), start + spec.duration);

    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(spec.gain, start + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + spec.duration);

    oscillator.connect(gain).connect(context.destination);
    oscillator.start(start);
    oscillator.stop(start + spec.duration + 0.02);
  }
}
