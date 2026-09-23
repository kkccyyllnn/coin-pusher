import * as THREE from 'three';
import * as RAPIER from '@dimforge/rapier3d-compat';
import { COLORS, PUSHER_CYCLE, RULES, TABLE } from '../game/constants';

export type PusherPhase = 'extend' | 'holdFront' | 'retract' | 'holdBack';

export type PusherTick = {
  /** 完整走完一个「前推 → 停留 → 回撤 → 停留」循环。 */
  cycleCompleted: boolean;
  /** 新的前推行程开始（加力在此刻结算）。 */
  boostConsumed: boolean;
};

const PHASE_ORDER: PusherPhase[] = ['extend', 'holdFront', 'retract', 'holdBack'];

const PHASE_DURATION: Record<PusherPhase, number> = {
  extend: PUSHER_CYCLE.extend,
  holdFront: PUSHER_CYCLE.holdFront,
  retract: PUSHER_CYCLE.retract,
  holdBack: PUSHER_CYCLE.holdBack,
};

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

const HALF_DEPTH = (TABLE.pusherFrontZAtRest - TABLE.pusherBackZ) / 2;
const CENTER_Z = (TABLE.pusherFrontZAtRest + TABLE.pusherBackZ) / 2;
const HALF_HEIGHT = TABLE.pusherTopY / 2;

/**
 * 往复推板。一整块运动学刚体：顶面是上层台面，前表面是推币面。
 * 未开始前静止；由 Game 在首次有效投币后调用 start()。
 */
export class Pusher {
  readonly body: RAPIER.RigidBody;
  readonly group = new THREE.Group();

  running = false;
  cyclesCompleted = 0;
  /** 单程行程，可由调试面板实时调整。 */
  travel: number = TABLE.pusherTravel;
  /** 推板当前的世界速度（米/秒），台面输送需要用它做参考系。 */
  velocityZ = 0;
  /** 前缘高亮条的材质：加力生效时由 Game 闪一下（动效只放大已发生的事）。 */
  lipMaterial!: THREE.MeshStandardMaterial;

  private phase: PusherPhase = 'holdBack';
  private phaseTime = 0;
  private offsetZ = 0;
  private travelForStroke: number = TABLE.pusherTravel;
  private boostQueued = false;

  constructor(world: RAPIER.World) {
    this.body = world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, 0, 0),
    );

    world.createCollider(
      RAPIER.ColliderDesc.cuboid(TABLE.pusherHalfWidth, HALF_HEIGHT, HALF_DEPTH)
        .setTranslation(0, HALF_HEIGHT, CENTER_Z)
        .setFriction(0.35)
        .setRestitution(0.02),
      this.body,
    );

    this.buildVisuals();
    this.applyTransform();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.phase = 'holdBack';
    this.phaseTime = 0;
    this.offsetZ = 0;
    this.velocityZ = 0;
  }

  stop(): void {
    this.running = false;
    this.velocityZ = 0;
  }

  /** 复位到归位状态，用于重试与切关。**瞬时传送**，不是一次归位行程。 */
  reset(): void {
    this.running = false;
    this.phase = 'holdBack';
    this.phaseTime = 0;
    this.offsetZ = 0;
    this.velocityZ = 0;
    this.travelForStroke = this.travel;
    this.boostQueued = false;
    this.cyclesCompleted = 0;
    this.applyTransform(true);
  }

  /** 请求在下一次完整前推上追加行程。返回 false 表示已有一发待用。 */
  requestBoost(): boolean {
    if (this.boostQueued) return false;
    this.boostQueued = true;
    return true;
  }

  get pendingBoost(): boolean {
    return this.boostQueued;
  }

  cancelBoost(): void {
    this.boostQueued = false;
  }

  get currentPhase(): PusherPhase {
    return this.phase;
  }

  get offset(): number {
    return this.offsetZ;
  }

  /** 当前推币面的 z 坐标。 */
  get frontFaceZ(): number {
    return this.offsetZ + CENTER_Z + HALF_DEPTH;
  }

  /** 推板顶面（上层台面）的世界 z 区间。 */
  get topRange(): { back: number; front: number } {
    return { back: this.offsetZ + TABLE.pusherBackZ, front: this.frontFaceZ };
  }

  /** 推进一步。必须在 world.step() 之前调用。 */
  update(delta: number): PusherTick {
    const tick: PusherTick = { cycleCompleted: false, boostConsumed: false };
    if (!this.running) {
      this.velocityZ = 0;
      return tick;
    }

    this.phaseTime += delta;
    let guard = 0;
    while (this.phaseTime >= PHASE_DURATION[this.phase] && guard < 4) {
      this.phaseTime -= PHASE_DURATION[this.phase];
      const previous = this.phase;
      const nextIndex = (PHASE_ORDER.indexOf(this.phase) + 1) % PHASE_ORDER.length;
      this.phase = PHASE_ORDER[nextIndex];
      guard += 1;

      if (this.phase === 'extend') {
        this.travelForStroke = this.travel;
        if (this.boostQueued) {
          this.travelForStroke = this.travel * (1 + RULES.boostTravelBonus);
          this.boostQueued = false;
          tick.boostConsumed = true;
        }
      }

      if (previous === 'holdBack' && this.phase === 'extend') {
        this.cyclesCompleted += 1;
        tick.cycleCompleted = true;
      }
    }

    const previousOffset = this.offsetZ;
    this.offsetZ = this.computeOffset();
    this.velocityZ = delta > 0 ? (this.offsetZ - previousOffset) / delta : 0;
    this.applyTransform();
    return tick;
  }

  private computeOffset(): number {
    const duration = PHASE_DURATION[this.phase];
    const t = duration > 0 ? Math.min(this.phaseTime / duration, 1) : 1;
    switch (this.phase) {
      case 'holdBack':
        return 0;
      case 'extend':
        return this.travelForStroke * smoothstep(t);
      case 'holdFront':
        return this.travelForStroke;
      case 'retract':
        return this.travelForStroke * (1 - smoothstep(t));
      default:
        return 0;
    }
  }

  /**
   * 把推板搬到 `offsetZ` 处。
   *
   * `teleport = false`（默认，走行程时用）：只设 `setNextKinematicTranslation`，
   * 表达「**下一步到达**这里」——引擎据此算出一段平滑的 kinematic 速度。
   *
   * `teleport = true`（**复位**用）：先 `setTranslation` **立刻**搬过去，再设同值的 next。
   * 这一步不能省，理由是实测出来的：
   * `reset()` 从行程最大处（+`travel`）归位到 0，若只用 next 目标，引擎会把这段
   * 位移当成**一帧内走完**，等效速度 ≈ `travel × 60` ≈ **21 米/秒**——
   * 也就是推板以 21 米/秒**倒着扫过币床**。新开局摆好的背排币正好在这个扫掠带里，
   * 会被挤飞出机柜（实测单局丢 16~31 枚，全被记成 `anomalies`，盘面因此比预置少一截）。
   *
   * **复位是传送，不是运动。** 这条必须写在实现里，不能靠调用顺序兜底
   * （`startRun` 现在也按「先归位、再摆盘」排序，两层都防着）。
   * 两个都设是为了避免下一步又朝某个陈旧的 next 目标掠过去。
   */
  private applyTransform(teleport = false): void {
    if (teleport) this.body.setTranslation({ x: 0, y: 0, z: this.offsetZ }, true);
    this.body.setNextKinematicTranslation({ x: 0, y: 0, z: this.offsetZ });
    this.group.position.z = this.offsetZ;
  }

  private buildVisuals(): void {
    const halfWidth = TABLE.pusherHalfWidth;

    const body = new THREE.Mesh(
      new THREE.BoxGeometry(halfWidth * 2, HALF_HEIGHT * 2, HALF_DEPTH * 2),
      new THREE.MeshStandardMaterial({ color: COLORS.pusherFace, roughness: 0.62, metalness: 0.2 }),
    );
    body.position.set(0, HALF_HEIGHT, CENTER_Z);
    body.castShadow = true;
    body.receiveShadow = true;
    body.userData.role = 'pusherFace';
    this.group.add(body);

    // 上层台面：薄板贴在最上面，比推币面浅一档，让上下两层在画面上分得开。
    const top = new THREE.Mesh(
      new THREE.BoxGeometry(halfWidth * 2, 0.012, HALF_DEPTH * 2),
      new THREE.MeshStandardMaterial({ color: COLORS.pusherTop, roughness: 0.58, metalness: 0.22 }),
    );
    top.position.set(0, TABLE.pusherTopY - 0.006, CENTER_Z);
    top.castShadow = true;
    top.receiveShadow = true;
    top.userData.role = 'pusherTop';
    this.group.add(top);

    // 台面压条：把整块台面切成「落币段 / 输送段 / 出币段」，否则大片单色看不出进度。
    const grooveMaterial = new THREE.MeshStandardMaterial({
      color: '#2f3d37',
      roughness: 0.8,
      metalness: 0.1,
    });
    for (const z of [TABLE.drop.z - 0.34, TABLE.drop.z + 0.34, TABLE.pusherFrontZAtRest - 0.26]) {
      const groove = new THREE.Mesh(new THREE.BoxGeometry(halfWidth * 2 - 0.06, 0.004, 0.014), grooveMaterial);
      groove.position.set(0, TABLE.pusherTopY + 0.001, z);
      this.group.add(groove);
    }

    // 前缘高亮条：把「上层台面的出口」标出来，玩家才能预判币什么时候掉下去。
    const lipMaterial = new THREE.MeshStandardMaterial({
      color: COLORS.pusherLip,
      emissive: new THREE.Color(COLORS.pusherLip),
      emissiveIntensity: 0.16,
      roughness: 0.4,
      metalness: 0.5,
    });
    this.lipMaterial = lipMaterial;
    const lip = new THREE.Mesh(new THREE.BoxGeometry(halfWidth * 2, 0.016, 0.026), lipMaterial);
    lip.position.set(0, TABLE.pusherTopY - 0.004, TABLE.pusherFrontZAtRest - 0.013);
    this.group.add(lip);
  }
}
