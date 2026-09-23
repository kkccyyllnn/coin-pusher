import * as THREE from 'three';
import * as RAPIER from '@dimforge/rapier3d-compat';
import { COIN, type CoinKind } from '../game/constants';

/**
 * 渲染挂接点。P3 起币的渲染走 CoinPool 的 4 组 InstancedMesh，
 * Coin 自己不再持有 Mesh——spawn/despawn 时通过这对回调让池分配/回收实例槽。
 */
export interface CoinRenderHooks {
  attach(coin: Coin, kind: CoinKind): void;
  detach(coin: Coin): void;
}

// sync() 每帧对几百枚币各跑一次，矩阵与向量全部模块级复用，不在堆上分配。
const _position = new THREE.Vector3();
const _quaternion = new THREE.Quaternion();
const _scale = new THREE.Vector3(1, 1, 1);
const _matrix = new THREE.Matrix4();

/**
 * 一枚可复用的币。物理体与全部玩法状态都在这里；
 * 渲染只是「持有 (组 InstancedMesh, 实例下标) 引用」，同步只发生在 sync()。
 * 停用时不销毁，靠 setEnabled(false) 移出模拟，避免反复建体。
 */
export class Coin {
  readonly body: RAPIER.RigidBody;

  /** 渲染槽：所属组的 InstancedMesh 与组内实例下标。未激活时为 null / -1。 */
  renderMesh: THREE.InstancedMesh | null = null;
  renderIndex = -1;

  kind: CoinKind = 'bronze';
  active = false;
  /** 只有玩家主动投入的币才有资格点亮 XIXI 槽位。 */
  playerDropped = false;
  /** 已经登记过 XIXI 槽位（每枚只登记首次）。 */
  xixiMarked = false;
  /** 已越过得分线，防止重复结算。 */
  settled = false;
  /**
   * 这枚币投出时的加注倍率（1 / 2 / 4）。
   *
   * 加注买的是「这一投的返值倍率」，而倍率必须在**投出那一刻**定下来：
   * 玩家可以在币在途时改档，若在越线时读当前档位，就变成「用 1 枚的价
   * 享受 5 枚的倍率」。所以档位要盖在币身上。
   */
  betMul = 1;
  /** 上一物理步是否在推板顶面上，用于识别「离开台面」这一刻。 */
  onDeck = false;

  constructor(
    world: RAPIER.World,
    private readonly render: CoinRenderHooks,
  ) {
    const desc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(0, -60, 0)
      .setLinearDamping(COIN.linearDamping)
      .setAngularDamping(COIN.angularDamping)
      // 额外迭代次数默认 0（见 `constants.COIN.additionalSolverIterations` 的注释）：
      // 设成 1 的那一版实测会把整堆币压进地板，所以这里不硬编码，由 `Game.applyTuning`
      // 从调参表统一施加，方便 A/B 对照。
      .setAdditionalSolverIterations(COIN.additionalSolverIterations)
      .setCanSleep(true);
    this.body = world.createRigidBody(desc);

    const collider = RAPIER.ColliderDesc.cylinder(COIN.halfThickness, COIN.radius)
      .setDensity(COIN.density)
      .setFriction(COIN.friction)
      .setRestitution(COIN.restitution);
    world.createCollider(collider, this.body);

    this.body.setEnabled(false);
  }

  spawn(kind: CoinKind, x: number, y: number, z: number, yaw: number, playerDropped: boolean): void {
    this.kind = kind;
    this.playerDropped = playerDropped;
    this.xixiMarked = false;
    this.settled = false;
    this.betMul = 1;
    this.onDeck = false;
    this.active = true;

    this.body.setTranslation({ x, y, z }, true);
    const half = yaw / 2;
    this.body.setRotation({ x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setEnabled(true);
    this.body.wakeUp();

    // 物理就位后再入组：attach 会立刻写一次实例矩阵，读到的必须是新位姿。
    this.render.attach(this, kind);
  }

  despawn(): void {
    if (!this.active) return;
    this.active = false;
    this.body.setEnabled(false);
    this.render.detach(this);
  }

  /** 唯一的位置同步点：物理 → 渲染（写进所属组的实例矩阵）。 */
  sync(): void {
    if (!this.active || !this.renderMesh) return;
    const t = this.body.translation();
    const r = this.body.rotation();
    _position.set(t.x, t.y, t.z);
    _quaternion.set(r.x, r.y, r.z, r.w);
    _matrix.compose(_position, _quaternion, _scale);
    this.renderMesh.setMatrixAt(this.renderIndex, _matrix);
  }

  /**
   * 渲染侧位置（从实例矩阵读回）。诊断探针用：把渲染与物理放到同一把尺子上量。
   * 未渲染（未激活）时返回 null。
   */
  renderPosition(): THREE.Vector3 | null {
    if (!this.renderMesh || this.renderIndex < 0) return null;
    this.renderMesh.getMatrixAt(this.renderIndex, _matrix);
    return new THREE.Vector3().setFromMatrixPosition(_matrix);
  }

  get position(): RAPIER.Vector {
    return this.body.translation();
  }

  speed(): number {
    return Math.hypot(...this.velocity3());
  }

  /**
   * 线速度三分量。诊断用：异常币只报一个速率是不够的——
   * 「被币堆弹飞」（vy 明显为负/正且 |v| 远大于推板速度）与
   * 「沿台面滑出侧壁」（vx 主导、|v| 接近推板速度）是两种完全不同的缺陷。
   */
  velocity3(): [number, number, number] {
    const v = this.body.linvel();
    return [v.x, v.y, v.z];
  }

  /**
   * 速度护栏：把求解器**凭空造出来的**速度压回这台机器物理上可能的值。
   *
   * 两个上限的取值依据见 `COIN.maxSpeed` / `COIN.maxUpwardSpeed` 的注释。
   * 返回**压之前的速率**（没压到就返回 0）——调用方拿它做遥测，
   * 这样「求解器还在不在造能量」是可观测的，而不是被悄悄抹平。
   *
   * 只在**醒着**的币上调用：睡着的币不参与积分，不可能产生速度尖峰。
   */
  clampSpeed(maxSpeed: number, maxUpward: number): number {
    const v = this.body.linvel();
    let { x, y, z } = v;
    const before = Math.hypot(x, y, z);
    if (y > maxUpward) y = maxUpward;

    let after = Math.hypot(x, y, z);
    if (after > maxSpeed) {
      const scale = maxSpeed / after;
      x *= scale;
      y *= scale;
      z *= scale;
      after = maxSpeed;
    }

    if (after === before) return 0;
    this.body.setLinvel({ x, y, z }, true);
    return before;
  }

  /** 台面输送：只补足向前速度，不覆盖横向与垂直运动。 */
  applyConveyor(targetSpeedZ: number): void {
    const v = this.body.linvel();
    if (v.z >= targetSpeedZ) return;
    const mass = this.body.mass();
    this.body.applyImpulse({ x: 0, y: 0, z: (targetSpeedZ - v.z) * mass }, true);
  }
}
