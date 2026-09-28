import * as RAPIER from '@dimforge/rapier3d-compat';
import { PHYSICS } from '../game/constants';

export type StepCallback = (fixedDt: number) => void;

/**
 * 全机台统一的**弹性合并规则**。
 *
 * Rapier 里一次接触的有效弹性 = `combine(币侧, 对面侧)`，而默认规则是 **Average**。
 * 在 Average 下，币侧弹性只能「和对面取平均」，于是出现两种无法接受的形态：
 *
 * - 币 ↔ 地板：`平均(币, 0)`。想让币对币有一点真回弹，就必须把币侧抬到非零，
 *   可这一抬会**同时**把币↔地板抬到 `币/2` —— 而那 `币/2` 正是当年
 *   「推板挤压时币堆弹开再撞回去」抖动的来源（见 `constants.ts` 的 `COIN.restitution`）。
 * - 币 ↔ 钉：`平均(0, 0.3) = 0.15`，币自己明明是 0。观感即「撞钉乱蹦、其余全黏」。
 *
 * 换成 **Min** 之后，两侧可以各自独立表达：地板 / 玻璃 / 背墙 / 推板留 0 或 0.02，
 * 于是 `min(0.04, 0) = 0` 把抖动继续关死，而 `min(0.04, 0.04) = 0.04` 让**币对币**
 * 有那一点真回弹。
 *
 * ⚠️ **摩擦刻意不走这里**：它仍是 Average。摩擦是推进率（`perDrop`）的输入，
 * 换规则会直接改变推进节拍；本轮只动弹性。
 *
 * ## 为什么要「一处扫全机台」而不是逐面写
 *
 * `CoefficientCombineRule` 是**逐碰撞体**的属性，而 0.12 的 d.ts **没有写**
 * 「一对碰撞体两边规则不同」时按哪边算（`geometry/collider.d.ts:147-154`）。
 * 那就不能赌。逐面手抄八处 setter 的写法里，漏一面 = 那一对接触**悄悄退回 Average**，
 * 而且没有任何读数会告诉你（静置测试照样绿，因为退回 Average 的那对面恰好不受影响）。
 * 所以这里在机器造完之后用 `world.forEachCollider` 无差别扫一遍 —— 穷尽性由构造保证。
 *
 * ⚠️ **已知边界**：这一步之后**新建**的碰撞体不会自动带上规则。目前只有 4b 的金币塔
 * 碰撞体属于「演出期新建」，它接进去时必须自己 `setRestitutionCombineRule`，
 * 或者再调一次本方法。
 */
export const RESTITUTION_COMBINE_RULE = RAPIER.CoefficientCombineRule.Min;

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

  /**
   * 把 `RESTITUTION_COMBINE_RULE` 铺到**此刻世界里的每一个碰撞体**。
   *
   * 调用时机是「机器全部造完之后」—— `Game.ts` 里 `buildTable()` 之后那一步。
   * 到这里币池（`CoinPool` 构造时一次性建满 `COIN.budget` 个币）、推板、台面、
   * 钉子、围板、背墙都已注册，所以一次扫描 = 全覆盖。
   *
   * 不逐帧调：`forEachCollider` 要过 700+ 个句柄，而规则设好之后不会被别处改写
   * （`Coin.applyPhysics()` 只碰 friction / restitution / density，不碰 rule）。
   */
  applyRestitutionCombineRule(): void {
    this.world.forEachCollider((collider) => {
      collider.setRestitutionCombineRule(RESTITUTION_COMBINE_RULE);
    });
  }

  /**
   * 世界里的碰撞体总数。**只给验证脚本按需调**（走测试钩子，不进每帧 diagnostics）：
   * `forEachCollider` 要过 700+ 个句柄，放在热路径上会把 `perf` 的帧时间判据带红。
   *
   * 它的用途是 R4-4b 的生命周期自证：塔演出的 kinematic 柱体在演出中 +1、
   * 演出结束必须回到原值。读数用「演出中 vs 演出后」的**差**而不是绝对值——
   * 绝对值里混着币池的 700 个休眠碰撞体，那会把判据变成对预算的依赖。
   */
  countColliders(): number {
    let count = 0;
    this.world.forEachCollider(() => {
      count += 1;
    });
    return count;
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
