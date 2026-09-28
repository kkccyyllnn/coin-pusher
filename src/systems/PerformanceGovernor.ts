export type QualityTier = 'high' | 'medium' | 'low';

export type QualitySettings = {
  tier: QualityTier;
  /**
   * 像素化的目标内部高度（见 `render/PixelScale.ts`）。
   *
   * **调低 = 像素更粗 = 更省**，所以降档与像素美学同向：不是「变糊」而是「更方块」。
   * 取代了原来的 `maxDpr`——DPR 不再参与分辨率计算。
   */
  pixelTargetHeight: number;
  shadows: boolean;
  /** 币的阴影开关，低档设备单独关掉能省一大笔 draw call。 */
  coinShadows: boolean;
};

/**
 * 各档的像素目标高度。**数值刻意拉开**：整数倍率有量化（`floor(视口高 / 目标高度)`），
 * 目标高度挨得太近时两档会算出同一个倍率，分档就等于没分。
 * 实测 664（iPhone 13）/ 720 / 900 三种视口下：高 2 / 中 2~3 / 低 3~4。
 * 分辨率之外还有 `shadows` / `coinShadows` 两个真正的开销旋钮，所以即使某档倍率相同也仍有意义。
 */
const PRESETS: Record<QualityTier, QualitySettings> = {
  high: { tier: 'high', pixelTargetHeight: 360, shadows: true, coinShadows: true },
  medium: { tier: 'medium', pixelTargetHeight: 260, shadows: true, coinShadows: false },
  low: { tier: 'low', pixelTargetHeight: 180, shadows: false, coinShadows: false },
};

const ORDER: QualityTier[] = ['high', 'medium', 'low'];

/**
 * 帧率监测与画质分档。
 *
 * 只降画质，不改分数规则、可推币数量与出口位置——降档不影响玩法公平性。
 * 采样窗口取 1 秒；连续两个窗口低于阈值才降档，避免偶发卡顿就掉画质。
 */
export class PerformanceGovernor {
  private readonly frameTimes: number[] = [];
  private windowElapsed = 0;
  private lowWindows = 0;
  private highWindows = 0;
  private fpsValue = 60;
  private settings: QualitySettings;
  private frozen = false;

  constructor(initial: QualityTier = 'high') {
    this.settings = PRESETS[initial];
  }

  get current(): QualitySettings {
    return this.settings;
  }

  get fps(): number {
    return this.fpsValue;
  }

  /** 测试与截图时冻结「自动换档」，帧率采样继续跑。 */
  freeze(frozen: boolean): void {
    this.frozen = frozen;
  }

  /** 每帧调用。返回 true 表示画质档位发生了变化。 */
  sample(delta: number): boolean {
    this.frameTimes.push(delta);
    this.windowElapsed += delta;
    if (this.windowElapsed < 1) return false;

    const total = this.frameTimes.reduce((sum, value) => sum + value, 0);
    const frames = this.frameTimes.length;
    this.fpsValue = frames > 0 ? frames / total : 0;
    this.frameTimes.length = 0;
    this.windowElapsed = 0;

    // 被冻结时只更新帧率，不自动换档。
    if (this.frozen) return false;

    const index = ORDER.indexOf(this.settings.tier);
    if (this.fpsValue < 45 && index < ORDER.length - 1) {
      this.lowWindows += 1;
      this.highWindows = 0;
      if (this.lowWindows >= 2) {
        this.lowWindows = 0;
        this.settings = PRESETS[ORDER[index + 1]];
        return true;
      }
      return false;
    }

    if (this.fpsValue > 58 && index > 0) {
      this.highWindows += 1;
      this.lowWindows = 0;
      if (this.highWindows >= 6) {
        this.highWindows = 0;
        this.settings = PRESETS[ORDER[index - 1]];
        return true;
      }
      return false;
    }

    this.lowWindows = 0;
    this.highWindows = 0;
    return false;
  }

  /** 由测试钩子强制指定档位。 */
  force(tier: QualityTier): QualitySettings {
    this.settings = PRESETS[tier];
    return this.settings;
  }
}
