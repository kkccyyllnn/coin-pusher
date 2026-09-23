import * as RAPIER from '@dimforge/rapier3d-compat';
import { PHYSICS } from '../game/constants';

export type StepCallback = (fixedDt: number) => void;

/**
 * Rapier 世界的唯一持有者。渲染代码不得直接接触物理。
 *
 * 固定步长 + 钳制累加器：切后台或掉帧时不会追帧雪崩。
 */
export class PhysicsWorld {
  readonly world: RAPIER.World;
  private accumulator = 0;
  private substepsLastFrame = 0;

  private constructor(world: RAPIER.World) {
    this.world = world;
  }

  static async create(): Promise<PhysicsWorld> {
    await RAPIER.init();
    const world = new RAPIER.World({ x: 0, y: PHYSICS.gravity, z: 0 });
    world.timestep = PHYSICS.fixedDt;
    const instance = new PhysicsWorld(world);
    instance.applyTuning({
      gravity: PHYSICS.gravity,
      solverIterations: PHYSICS.solverIterations,
      erp: PHYSICS.erp,
    });
    return instance;
  }

  /**
   * 运行时改物理旋钮（调试面板与验证脚本用）。
   *
   * 存在的理由是**穿模的调参必须是单变量的**：满盘下币堆被挤实的深度取决于
   * 「载荷 ↔ 位置修正 ↔ 迭代次数」三者的平衡，只有能在同一条盘面上逐个改、
   * 立刻重新量，才知道是哪一项在起作用。改完不需要重建世界，下一帧就生效。
   */
  applyTuning(patch: { gravity?: number; solverIterations?: number; erp?: number }): void {
    if (patch.gravity !== undefined) {
      this.world.gravity = { x: 0, y: patch.gravity, z: 0 };
    }
    const params = this.world.integrationParameters;
    if (patch.solverIterations !== undefined) {
      params.numSolverIterations = Math.max(1, Math.round(patch.solverIterations));
    }
    if (patch.erp !== undefined) {
      params.erp = Math.min(1, Math.max(0.01, patch.erp));
    }
  }

  /** 当前物理旋钮，供诊断与验证脚本记录「这一跑用的是哪组值」。 */
  get tuning(): { gravity: number; solverIterations: number; erp: number } {
    const params = this.world.integrationParameters;
    return {
      gravity: this.world.gravity.y,
      solverIterations: params.numSolverIterations,
      erp: params.erp,
    };
  }

  /** 推进物理。返回本帧实际执行的子步数（0 表示没有推进）。 */
  step(deltaSeconds: number, onSubStep: StepCallback): number {
    this.accumulator += Math.min(deltaSeconds, 0.1);
    let steps = 0;
    while (this.accumulator >= PHYSICS.fixedDt && steps < PHYSICS.maxSubSteps) {
      onSubStep(PHYSICS.fixedDt);
      this.world.step();
      this.accumulator -= PHYSICS.fixedDt;
      steps += 1;
    }
    if (steps >= PHYSICS.maxSubSteps) {
      // 丢弃积压，避免持续落后于实时。
      this.accumulator = 0;
    }
    this.substepsLastFrame = steps;
    return steps;
  }

  get substeps(): number {
    return this.substepsLastFrame;
  }

  /** 冻结模拟：丢弃累加器，恢复后不补算后台时间。 */
  freeze(): void {
    this.accumulator = 0;
  }

  get bodyCount(): number {
    return this.world.bodies.len();
  }

  get colliderCount(): number {
    return this.world.colliders.len();
  }
}

export { RAPIER };
