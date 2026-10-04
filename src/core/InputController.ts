import { TABLE } from '../game/constants';
import { clamp } from '../utils/numeric';

/** 选位模式：自动匀速往返 / 玩家手动接管。 */
export type LaneMode = 'auto' | 'manual';

export type LaneInput = {
  /** 归一化选位，-1 最左，+1 最右。 */
  lane: number;
  /** 目标落点的世界 x 坐标。 */
  laneX: number;
  /** 当前选位模式。 */
  mode: LaneMode;
  /** 手动接管的剩余秒数（自动模式下为 0）。 */
  manualHoldLeft: number;
  dropPressed: boolean;
  boostPressed: boolean;
  giveUpPressed: boolean;
  /** 机关：扫板 / 抓斗 / 后装填。 */
  sweepPressed: boolean;
  grapplePressed: boolean;
  reloadPressed: boolean;
  /** 无尽模式：切换加注档位。 */
  betPressed: boolean;
};

type Pointers = {
  aimId: number | null;
};

/** 一次按下：用来区分「轻点投币」与「拖动选位」。 */
type PointerGesture = {
  id: number;
  startX: number;
  startY: number;
  startedAt: number;
  /** 位移超过阈值后置位，之后这个手势就只负责选位，不再投币。 */
  moved: boolean;
};

/** 屏幕中段用于映射选位的横向比例（左右各留 15% 边距）。 */
const LANE_BAND = 0.35;

/** 键盘选位速度（归一化单位/秒）。 */
const KEYBOARD_LANE_SPEED = 1.7;

/** 自动选位的匀速，单位是**世界坐标的米/秒**（不是归一化单位）。 */
const AUTO_LANE_SPEED = 0.62;

/** 玩家最后一次操作之后，自动选位等多久恢复（秒）。 */
const MANUAL_HOLD_SECONDS = 2;

/** 指针位移超过这个像素数就不再算轻点，转为拖动选位。 */
const TAP_MAX_PX = 8;

/** 按住不动超过这个毫秒数也不再算轻点——长按松手不该误投一枚币。 */
const TAP_HOLD_MS = 500;

/**
 * 输入意图。
 *
 * 选位默认**自动匀速左右往返**（三角波，匀速、两端即时折返），玩家只在对的瞬间投币；
 * 玩家一碰 A/D / ←→ 或横向拖动就进入手动接管，松手 2 秒后从当前位置继续自动。
 *
 * 投币：空格、投币按钮、或在机台上**轻点**（只投币，不选位）。
 * 拖动才是选位；轻点与拖动的分界是 8 像素位移。
 */
export class InputController {
  private readonly keys = new Set<string>();
  private readonly pointers: Pointers = { aimId: null };
  private gesture: PointerGesture | null = null;

  private lane = 0;
  private laneDirty = false;
  private dropQueued = false;
  private boostQueued = false;
  private giveUpQueued = false;
  private sweepQueued = false;
  private grappleQueued = false;
  private reloadQueued = false;
  private betQueued = false;
  private enabled = true;

  /** 自动选位的当前方向：+1 向右，-1 向左。 */
  private autoDirection: 1 | -1 = 1;
  /** 手动接管的剩余秒数。 */
  private manualHold = 0;
  private mode: LaneMode = 'auto';

  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (event.repeat) {
      if (event.code === 'Space') event.preventDefault();
      return;
    }
    this.keys.add(event.code);
    if (event.code === 'Space') {
      event.preventDefault();
      this.dropQueued = true;
    }
    if (event.code === 'KeyB') this.boostQueued = true;
    if (event.code === 'KeyG') this.giveUpQueued = true;
  };

  private readonly onKeyUp = (event: KeyboardEvent) => {
    this.keys.delete(event.code);
  };

  private readonly onPointerDown = (event: PointerEvent) => {
    if (!this.enabled) return;
    if (event.button !== 0 && event.pointerType === 'mouse') return;
    if (this.pointers.aimId !== null) return;
    this.pointers.aimId = event.pointerId;
    this.gesture = {
      id: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startedAt: performance.now(),
      moved: false,
    };
    try {
      this.canvas.setPointerCapture(event.pointerId);
    } catch {
      // 合成事件没有可捕获的 pointer id。
    }
    // 按下时先不选位：轻点是投币，拖动才是选位（分界在 pointermove 里判）。
  };

  private readonly onPointerMove = (event: PointerEvent) => {
    if (this.pointers.aimId !== event.pointerId) return;
    const gesture = this.gesture;
    if (gesture && !gesture.moved) {
      const travel = Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY);
      if (travel <= TAP_MAX_PX) return;
      gesture.moved = true;
    }
    this.aim(event.clientX);
  };

  private readonly onPointerUp = (event: PointerEvent) => {
    if (this.pointers.aimId !== event.pointerId) return;
    const gesture = this.gesture;
    this.pointers.aimId = null;
    this.gesture = null;
    // 没挪过位置、也没长按 → 轻点：只投币，不选位。
    if (gesture && !gesture.moved && performance.now() - gesture.startedAt <= TAP_HOLD_MS) {
      this.dropQueued = true;
      return;
    }
    if (gesture?.moved) this.manualHold = MANUAL_HOLD_SECONDS;
  };

  private readonly onDropClick = (event: Event) => {
    event.preventDefault();
    this.dropQueued = true;
  };

  private readonly onBoostClick = (event: Event) => {
    event.preventDefault();
    this.boostQueued = true;
  };

  private readonly onGiveUpClick = (event: Event) => {
    event.preventDefault();
    this.giveUpQueued = true;
  };

  private readonly onSweepClick = (event: Event) => {
    event.preventDefault();
    this.sweepQueued = true;
  };

  private readonly onGrappleClick = (event: Event) => {
    event.preventDefault();
    this.grappleQueued = true;
  };

  private readonly onReloadClick = (event: Event) => {
    event.preventDefault();
    this.reloadQueued = true;
  };

  private readonly onBetClick = (event: Event) => {
    event.preventDefault();
    this.betQueued = true;
  };

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly dropButton: HTMLElement,
    private readonly boostButton: HTMLElement,
    private readonly giveUpButton: HTMLElement,
    private readonly sweepButton: HTMLElement,
    private readonly grappleButton: HTMLElement,
    private readonly reloadButton: HTMLElement,
    private readonly betButton: HTMLElement,
  ) {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointercancel', this.onPointerUp);
    dropButton.addEventListener('pointerdown', this.onDropClick);
    boostButton.addEventListener('pointerdown', this.onBoostClick);
    giveUpButton.addEventListener('pointerdown', this.onGiveUpClick);
    sweepButton.addEventListener('pointerdown', this.onSweepClick);
    grappleButton.addEventListener('pointerdown', this.onGrappleClick);
    reloadButton.addEventListener('pointerdown', this.onReloadClick);
    betButton.addEventListener('pointerdown', this.onBetClick);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.pointers.aimId = null;
      this.gesture = null;
    }
  }

  /** 每帧读取一次。返回后边沿触发的输入会被清空。 */
  sample(delta: number): LaneInput {
    const keyboardLeft = this.keys.has('KeyA') || this.keys.has('ArrowLeft');
    const keyboardRight = this.keys.has('KeyD') || this.keys.has('ArrowRight');

    // 长按不动超过阈值：转为手动选位（落在按下的位置），松手时不再当轻点。
    if (this.gesture && !this.gesture.moved && performance.now() - this.gesture.startedAt > TAP_HOLD_MS) {
      this.gesture.moved = true;
      this.aim(this.gesture.startX);
    }

    const pointerHeld = this.pointers.aimId !== null && (this.gesture?.moved ?? false);
    const manualActive = keyboardLeft || keyboardRight || pointerHeld;

    if (manualActive) {
      this.manualHold = MANUAL_HOLD_SECONDS;
      this.mode = 'manual';
      if (keyboardLeft) {
        this.lane = clamp(this.lane - KEYBOARD_LANE_SPEED * delta, -1, 1);
        this.laneDirty = true;
      }
      if (keyboardRight) {
        this.lane = clamp(this.lane + KEYBOARD_LANE_SPEED * delta, -1, 1);
        this.laneDirty = true;
      }
    } else if (this.manualHold > 0) {
      this.manualHold = Math.max(0, this.manualHold - delta);
      this.mode = 'manual';
    } else if (this.enabled) {
      this.mode = 'auto';
      this.advanceAuto(delta);
    }

    const result: LaneInput = {
      lane: this.lane,
      laneX: this.lane * TABLE.drop.halfLane,
      mode: this.mode,
      manualHoldLeft: this.manualHold,
      dropPressed: this.dropQueued,
      boostPressed: this.boostQueued,
      giveUpPressed: this.giveUpQueued,
      sweepPressed: this.sweepQueued,
      grapplePressed: this.grappleQueued,
      reloadPressed: this.reloadQueued,
      betPressed: this.betQueued,
    };
    this.dropQueued = false;
    this.boostQueued = false;
    this.giveUpQueued = false;
    this.sweepQueued = false;
    this.grappleQueued = false;
    this.reloadQueued = false;
    this.betQueued = false;
    return result;
  }

  /**
   * 三角波：以世界坐标匀速推进，到端点即时折返。
   *
   * 用世界坐标（而不是归一化 lane）推进，是因为 laneX = lane × halfLane，
   * 在归一化坐标上推进会让实际速度随 halfLane 变化。
   * 折返用反射而不是截断，保证每帧位移恒定（两端不会「停留」）。
   */
  private advanceAuto(delta: number): void {
    const halfLane = TABLE.drop.halfLane;
    const step = AUTO_LANE_SPEED * delta;
    let x = this.lane * halfLane + this.autoDirection * step;
    if (x > halfLane) {
      x = 2 * halfLane - x;
      this.autoDirection = -1;
    } else if (x < -halfLane) {
      x = -2 * halfLane - x;
      this.autoDirection = 1;
    }
    this.lane = clamp(x / halfLane, -1, 1);
    this.laneDirty = true;
  }

  consumeLaneDirty(): boolean {
    const dirty = this.laneDirty;
    this.laneDirty = false;
    return dirty;
  }

  /** 由测试钩子直接设定选位。视为一次手动接管，避免被自动选位立刻覆盖。 */
  setLane(lane: number): void {
    this.lane = clamp(lane, -1, 1);
    this.laneDirty = true;
    this.manualHold = MANUAL_HOLD_SECONDS;
    this.mode = 'manual';
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointercancel', this.onPointerUp);
    this.dropButton.removeEventListener('pointerdown', this.onDropClick);
    this.boostButton.removeEventListener('pointerdown', this.onBoostClick);
    this.giveUpButton.removeEventListener('pointerdown', this.onGiveUpClick);
    this.sweepButton.removeEventListener('pointerdown', this.onSweepClick);
    this.grappleButton.removeEventListener('pointerdown', this.onGrappleClick);
    this.reloadButton.removeEventListener('pointerdown', this.onReloadClick);
    this.betButton.removeEventListener('pointerdown', this.onBetClick);
  }

  private aim(clientX: number): void {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = (clientX - rect.left) / rect.width;
    const normalized = clamp((ratio - 0.5) / LANE_BAND, -1, 1);
    this.lane = normalized;
    this.laneDirty = true;
  }
}
