import * as THREE from 'three';
import { TABLE } from '../game/constants';
import {
  SLOT_SYMBOL_GLYPHS,
  rollSlotSymbol,
  type SlotSymbol,
} from '../game/xixi';
import type { ShowDirector } from './ShowDirector';
import type { Telemetry } from './Telemetry';

/**
 * 背板老虎机（P5）：XIXI 四槽集齐的奖励装置。
 *
 * 形态：背板上三个几何滚筒（与「几何演出风格」统一，不做 2D 屏幕贴图）。
 * 街机老虎机的标准做法——**先定结果、再演停格**：摇出符号（权重表，P8 标定），
 * 滚筒 staggered 停在该符号上，然后兑现奖励。
 *
 * 奖励表（硬约束：**不走 `gainChips`**，越线返值仍是唯一筹码来源）：
 *   塔塔塔 → ShowDirector 圆柱币塔装置
 *   泉泉泉 → ShowDirector 喷泉装置
 *   力力力 → 加力 +1（拍板项 #1 方案 A：加力的新来源，替代被拆除的三路集章）
 * 钻 / 箱符号等 P6 道具就位后扩充。
 */

type SlotDeps = {
  shows: ShowDirector;
  telemetry: Telemetry;
  /** HUD 文案（奖励宣告 / 加力已满）。 */
  notify: (message: string) => void;
  now: () => number;
  rng: () => number;
  reducedMotion: () => boolean;
  /** 加力入账（RunState.grantBoost）：存满拒收返回 false。 */
  grantBoost: () => boolean;
  /** 加力就绪音效。 */
  onBoostReady: () => void;
};

const SYMBOL_COLORS: Record<SlotSymbol, string> = {
  tower: '#3fd2c0',
  fountain: '#d8b25c',
  boost: '#ff7043',
};

/** 每个滚筒的停格时刻（秒）与奖励兑现时刻。 */
const REEL_STOPS = [1.0, 1.5, 2.0];
const REWARD_AT = 2.25;
const DONE_AT = 2.6;

export class SlotMachine {
  readonly group = new THREE.Group();

  private readonly reels: THREE.Mesh[] = [];
  private readonly lamps: THREE.MeshStandardMaterial[] = [];
  private spinning = false;
  private spinT = 0;
  private outcome: SlotSymbol | null = null;
  private rewarded = false;

  constructor(private readonly deps: SlotDeps) {
    this.buildMeshes();
  }

  get busy(): boolean {
    return this.spinning;
  }

  /**
   * 摇一次。返回摇出的符号；正在转时拒绝（调用方负责等上一场）。
   * `forced` 只给测试钩子用：奖励路径必须可指定符号逐一验证。
   */
  spin(forced?: SlotSymbol): { symbol: SlotSymbol } | null {
    if (this.spinning) return null;
    const symbol = forced ?? rollSlotSymbol(this.deps.rng());
    this.outcome = symbol;
    this.spinning = true;
    this.rewarded = false;
    this.spinT = 0;
    for (const lamp of this.lamps) {
      lamp.emissiveIntensity = 0;
    }
    this.deps.telemetry.recordXixi({ phase: 'spin', symbol, t: this.deps.now() });
    this.deps.notify(`老虎机转动……`);
    return { symbol };
  }

  /** 每帧推进（与 ShowDirector 同节奏，挂在 Game.update）。 */
  update(delta: number): void {
    if (!this.spinning) return;
    const speed = this.deps.reducedMotion() ? 3 : 1;
    this.spinT += delta * speed;

    this.reels.forEach((reel, index) => {
      const stop = REEL_STOPS[index];
      if (this.spinT < stop) {
        // 转动中：绕自身水平轴快滚，停格前减速。
        const damping = this.spinT > stop - 0.3 ? 0.35 : 1;
        reel.rotation.x += delta * speed * 14 * damping;
      } else {
        // 停格：吸附到最近的 90°，画面利落。
        const quarter = Math.PI / 2;
        reel.rotation.x = Math.round(reel.rotation.x / quarter) * quarter;
      }
    });

    if (!this.rewarded && this.spinT >= REWARD_AT && this.outcome) {
      this.rewarded = true;
      this.applyReward(this.outcome);
    }
    if (this.spinT >= DONE_AT) {
      this.spinning = false;
      this.outcome = null;
    }
  }

  /**
   * 中止摇奖（开新局 / 收工用）：**不兑现**尚未落地的奖励。
   * 奖励随本局作废——上一局的奖励注入到下一局的盘面就是跨局平移。
   */
  abort(): void {
    this.spinning = false;
    this.spinT = 0;
    this.outcome = null;
    this.rewarded = false;
    for (const lamp of this.lamps) lamp.emissiveIntensity = 0;
  }

  dispose(): void {
    this.group.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
        const material = child.material;
        if (Array.isArray(material)) material.forEach((m) => m.dispose());
        else material.dispose();
      }
    });
    this.group.clear();
  }

  private applyReward(symbol: SlotSymbol): void {
    const glyph = SLOT_SYMBOL_GLYPHS[symbol];
    for (const lamp of this.lamps) {
      lamp.emissive.set(SYMBOL_COLORS[symbol]);
      lamp.emissiveIntensity = 1.4;
    }

    if (symbol === 'boost') {
      const granted = this.deps.grantBoost();
      this.deps.telemetry.recordXixi({
        phase: 'reward',
        symbol,
        granted,
        t: this.deps.now(),
      });
      if (granted) {
        this.deps.onBoostReady();
        this.deps.notify(`老虎机：${glyph}${glyph}${glyph}！加力 +1`);
      } else {
        this.deps.notify(`老虎机：${glyph}${glyph}${glyph}，但加力已存满`);
      }
      return;
    }

    const result = this.deps.shows.request(symbol);
    this.deps.telemetry.recordXixi({
      phase: 'reward',
      symbol,
      granted: result.ok,
      delivered: result.promised,
      t: this.deps.now(),
    });
    this.deps.notify(
      result.ok
        ? `老虎机：${glyph}${glyph}${glyph}！${symbol === 'tower' ? '圆柱币塔' : '喷泉'}演出奉上`
        : `老虎机：${glyph}${glyph}${glyph}，但${result.reason}`,
    );
  }

  private buildMeshes(): void {
    const frameMaterial = new THREE.MeshStandardMaterial({
      color: '#4a3f2e',
      roughness: 0.6,
      metalness: 0.35,
    });
    const reelMaterial = new THREE.MeshStandardMaterial({
      color: '#efe6d0',
      roughness: 0.4,
      metalness: 0.15,
    });

    // 背板前的挂机框（z 微微探出板面，纯视觉，无碰撞体）。
    const frame = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.3, 0.05), frameMaterial);
    frame.position.set(0, 0.7, TABLE.backZ + 0.02);
    this.group.add(frame);

    for (let index = 0; index < 3; index += 1) {
      const x = (index - 1) * 0.19;
      // 滚筒：圆柱轴线转成水平（绕 z 转 90°），spin 时绕 x 快滚。
      const reel = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.11, 12), reelMaterial.clone());
      reel.rotation.z = Math.PI / 2;
      reel.position.set(x, 0.7, TABLE.backZ + 0.055);
      this.reels.push(reel);
      this.group.add(reel);

      // 结果灯：停格后以符号色点亮（塔青 / 泉金 / 力橙）。
      const lampMaterial = new THREE.MeshStandardMaterial({
        color: '#2c2c34',
        roughness: 0.5,
        metalness: 0.2,
        emissive: '#000000',
        emissiveIntensity: 0,
      });
      const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.04, 0.02), lampMaterial);
      lamp.position.set(x, 0.83, TABLE.backZ + 0.055);
      this.lamps.push(lampMaterial);
      this.group.add(lamp);
    }
  }
}
