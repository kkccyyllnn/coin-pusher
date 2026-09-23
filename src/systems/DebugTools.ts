import GUI from 'lil-gui';
import * as THREE from 'three';
import * as RAPIER from '@dimforge/rapier3d-compat';
import { COIN, PHYSICS, TABLE } from '../game/constants';

export type GameTuning = {
  /** 台面输送速度（米/秒）。 */
  conveyorSpeed: number;
  /** 推板单程行程（米）。 */
  pusherTravel: number;
  /** 投币冷却（秒）。 */
  dropCooldown: number;
  /** 重力加速度（负值，米/秒²）。 */
  gravity: number;
  /** 接触求解器迭代次数。 */
  solverIterations: number;
  /** 位置修正比（ERP）。 */
  erp: number;
  /** 每枚币额外追加的求解器迭代次数。 */
  coinSolverIterations: number;
  /** 镜头高度与距离。 */
  cameraHeight: number;
  cameraDistance: number;
  cameraFov: number;
  exposure: number;
  maxDpr: number;
  showColliders: boolean;
  muted: boolean;
};

export function createDefaultTuning(): GameTuning {
  return {
    conveyorSpeed: TABLE.conveyor.speed,
    pusherTravel: TABLE.pusherTravel,
    dropCooldown: 0.45,
    gravity: PHYSICS.gravity,
    solverIterations: PHYSICS.solverIterations,
    erp: PHYSICS.erp,
    coinSolverIterations: COIN.additionalSolverIterations,
    cameraHeight: 1.35,
    cameraDistance: 2.35,
    cameraFov: 42,
    exposure: 1.06,
    maxDpr: 2,
    showColliders: false,
    muted: false,
  };
}

/**
 * 调试面板与碰撞体可视化。只有带 ?debug 参数时才创建 GUI。
 */
export class DebugTools {
  private gui: GUI | null = null;
  private readonly colliderGroup = new THREE.Group();
  private colliderLines: THREE.LineSegments | null = null;
  private readonly enabled: boolean;

  constructor(
    private readonly world: RAPIER.World,
    private readonly tuning: GameTuning,
    private readonly onChange: () => void,
  ) {
    this.enabled = new URLSearchParams(window.location.search).has('debug');
    if (!this.enabled) return;

    this.gui = new GUI({ title: '推币机调参' });
    this.gui.add(tuning, 'conveyorSpeed', 0, 3, 0.05).name('台面输送速度');
    this.gui.add(tuning, 'pusherTravel', 0.3, 1.2, 0.01).name('推板行程');
    this.gui.add(tuning, 'dropCooldown', 0.1, 1.2, 0.05).name('投币冷却');
    this.gui.add(tuning, 'gravity', -20, -4, 0.5).name('重力');
    this.gui.add(tuning, 'solverIterations', 2, 16, 1).name('求解器迭代');
    this.gui.add(tuning, 'erp', 0.05, 0.9, 0.05).name('位置修正 ERP');
    this.gui.add(tuning, 'coinSolverIterations', 0, 4, 1).name('币额外迭代');
    this.gui.add(tuning, 'cameraHeight', 0.6, 3, 0.05).name('镜头高度');
    this.gui.add(tuning, 'cameraDistance', 1.2, 4.5, 0.05).name('镜头距离');
    this.gui.add(tuning, 'cameraFov', 24, 70, 1).name('镜头 FOV');
    this.gui.add(tuning, 'maxDpr', 1, 2, 0.25).name('最大 DPR');
    this.gui.add(tuning, 'exposure', 0.6, 1.8, 0.01).name('曝光');
    this.gui.add(tuning, 'showColliders').name('显示碰撞体');
    this.gui.add(tuning, 'muted').name('静音').onChange(() => this.onChange());
  }

  /** 需要每帧调用：同步碰撞体可视化。 */
  update(): void {
    if (!this.enabled) return;
    if (!this.tuning.showColliders) {
      if (this.colliderLines) this.colliderLines.visible = false;
      return;
    }

    const { vertices, colors } = this.world.debugRender();
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 4));

    if (this.colliderLines) {
      this.colliderGroup.remove(this.colliderLines);
      this.colliderLines.geometry.dispose();
      (this.colliderLines.material as THREE.Material).dispose();
    }
    this.colliderLines = new THREE.LineSegments(
      geometry,
      new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthTest: false }),
    );
    this.colliderLines.visible = true;
    this.colliderGroup.add(this.colliderLines);
  }

  get overlay(): THREE.Group {
    return this.colliderGroup;
  }

  setHidden(hidden: boolean): void {
    if (!this.gui) return;
    if (hidden) this.gui.hide();
    else this.gui.show();
  }

  get active(): boolean {
    return this.enabled;
  }

  dispose(): void {
    this.gui?.destroy();
    this.gui = null;
    if (this.colliderLines) {
      this.colliderLines.geometry.dispose();
      (this.colliderLines.material as THREE.Material).dispose();
      this.colliderLines = null;
    }
    this.colliderGroup.clear();
  }
}

export const COIN_RADIUS = COIN.radius;
