import * as THREE from 'three';

/**
 * 镜头取景框。
 *
 * 竖直方向同时受机台高度与纵深影响——俯角越大，纵深在画面里占的高度越多。
 * `verticalExtent` 是取景框在「相机上方向」上的投影长度，并把中心偏置，
 * 免得币床和得分线被底部 HUD 压住。
 *
 * ★★ S23：下面这组值是**由目标机位反解出来的**，不是拍脑袋定的。
 * 目标机位（用户给定的参考图）：
 *   相机 (0, 1.788, 3.634) · 看向 (0, 0.300, 0.200)
 * 反解（`syncCameraRigAngles` 的同一份算式）：
 *   offset = (0, 1.488, 3.434) → distance = 3.7425258850140235
 *   pitch = asin(1.488 / distance) = 23.427756327762303°、yaw = 0
 * 再按 fov 42° / 16:9（aspect = 1920/1296）把 `verticalExtent` 调成
 * **由高度方向主导**、且恰好解出上面那个 distance：
 *   halfTan = tan21° = 0.3838640350354158
 *   distanceToFitHeight = verticalExtent / 2 / halfTan = 3.7425258850140235
 *   ⇒ verticalExtent = 2 × 3.7425258850140235 × tan21° = 2.873242174891947
 *   （宽度方向 distanceToFitWidth = 0.95 / (halfTan × 1.481481) = 1.6705 < 3.7425 ⇒ 高度主导 ✓）
 * 自洽校验：0.30 + sin(23.427756°)×3.742526 = 1.788157、0.20 + cos(...)×3.742526 = 3.634128
 * ⇒ 与目标机位逐位一致（差异来自圆角，< 1e-3 米）。
 *
 * ⚠️ `centerZ` 保持 0.2（等于 `TABLE` 的纵深中点），只有 `centerY` 从 0.54 下移到 0.30
 * ——目标机位比 S22 之前的默认取景**看得更低**，落币口因此更靠画面上沿。
 *
 * ★ S22：这份表从 `Game.ts` 搬到本模块 —— 因为「自动取景」与「摄影机面板」都要用它，
 * 留在 `Game.ts` 会造成 `Game ⇄ DebugTools` 的循环 import。
 *
 * ★ S23：改这组值 = 改**默认取景**（`cameraAutoFit` 默认为真，换窗口尺寸会重新取景）。
 * `scripts/verify-game.mjs` 的 `camera` 模式从本模块现读，会跟着一起动，脚本不必改。
 */
export const CAMERA_FIT = {
  halfWidth: 0.95,
  verticalExtent: 2.873242174891947,
  centerY: 0.3,
  centerZ: 0.2,
  pitch: (23.427756327762303 * Math.PI) / 180,
};

/**
 * 相机到观察点的最小距离（米）。
 *
 * 再近就会退化成「相机与观察点重合」——`lookAt` 的方向完全由浮点噪声决定，
 * 反解 yaw/pitch 也会变成 `atan2(0, 0)`。所以它是**硬下界**，不是提示。
 */
export const CAMERA_MIN_DISTANCE = 0.25;

/**
 * 摄影机机位。
 *
 * ★★ **这里是机位的唯一真源**（`camera.position` / `camera.quaternion` 都是它推出来的）。
 *
 * 真源 = `target` + `position` 两个点；`yaw / pitch / distance` 是
 * `(position − target)` 的球坐标**反解**，只是同一份数据的另一种写法。
 * 四组控件（角度 / 距离 / 相机坐标 / 观察点）都是它的**视图**，任何一路改完都必须
 * 回到这两个点上来，所以不存在「角度和坐标对不上」的中间态：
 *
 * | 改的是 | 走哪个函数 | 结果 |
 * | --- | --- | --- |
 * | `yaw` / `pitch` / `distance` | `placeCameraRig()` | 绕/沿观察点转、进退 ⇒ 只有 `position` 变 |
 * | `position`（相机坐标） | `syncCameraRigAngles()` | 观察点不动、朝向跟着变 ⇒ 角度重解 |
 * | `target`（观察点） | `syncCameraRigAngles()` | 相机不动、朝向改变 ⇒ 角度重解 |
 *
 * ⚠️ 它是一个**模块级单例**（与 `coinPhysics` 同款）：`Game` 与 `DebugTools` 各自
 * import 同一个对象，不必穿过构造函数互相递引用。写它之前先读完上面这张表。
 */
export type CameraRig = {
  /** 观察点（相机看向的世界坐标）。 */
  target: THREE.Vector3;
  /** 相机世界坐标。 */
  position: THREE.Vector3;
  /** 方位角（弧度）。0 = 相机在观察点的 +z 侧（正对机台的游玩方向）。 */
  yaw: number;
  /** 俯角（弧度）。正 = 相机在观察点**上方**。 */
  pitch: number;
  /** 到观察点的距离（米）。恒 ≥ `CAMERA_MIN_DISTANCE`。 */
  distance: number;
};

export const cameraRig: CameraRig = {
  target: new THREE.Vector3(0, CAMERA_FIT.centerY, CAMERA_FIT.centerZ),
  // 占位值：真的机位由首帧之前那次 `fitCamera()` 解出来（`cameraAutoFit` 默认为真）。
  position: new THREE.Vector3(0, CAMERA_FIT.centerY, CAMERA_FIT.centerZ + 3.65),
  yaw: 0,
  pitch: CAMERA_FIT.pitch,
  distance: 3.65,
};

/** 反解用的临时向量（避免每次拖滑块都分配）。 */
const _offset = new THREE.Vector3();

export function toDeg(rad: number): number {
  return (rad * 180) / Math.PI;
}

export function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/**
 * `position` − `target` → `yaw` / `pitch` / `distance`。
 *
 * 相机与观察点重合时角度**无定义**（`atan2(0, 0)`），此时保持原角度不动，
 * 只把距离夹到硬下界——静默地把朝向扭到某个任意值比留着旧角度更难排查。
 */
export function syncCameraRigAngles(rig: CameraRig = cameraRig): void {
  _offset.subVectors(rig.position, rig.target);
  const length = _offset.length();
  rig.distance = Math.max(CAMERA_MIN_DISTANCE, length);
  if (length < 1e-6) return;
  rig.pitch = Math.asin(Math.min(1, Math.max(-1, _offset.y / length)));
  rig.yaw = Math.atan2(_offset.x, _offset.z);
}

/** `target` + `yaw` / `pitch` / `distance` → `position`。 */
export function placeCameraRig(rig: CameraRig = cameraRig): void {
  const distance = Math.max(CAMERA_MIN_DISTANCE, rig.distance);
  const horizontal = Math.cos(rig.pitch) * distance;
  rig.position.set(
    rig.target.x + horizontal * Math.sin(rig.yaw),
    rig.target.y + Math.sin(rig.pitch) * distance,
    rig.target.z + horizontal * Math.cos(rig.yaw),
  );
}

/**
 * 取景框反算出的机位距离（米）。
 *
 * 宽与高各算一个距离取较大者——哪个方向先装不下就由哪个方向决定。
 * 与 S19 之前写在 `Game.fitCamera()` 里的算式**逐字相同**，只是搬了个地方
 * （这样 `cabinet` 模式的截图构图不会因为 S22 而变）。
 */
export function fitCameraDistance(fovDeg: number, aspect: number): number {
  const halfTan = Math.tan((fovDeg * Math.PI) / 360);
  // `aspect` 有下限：竖屏极窄时 `distanceToFitWidth` 会趋向 0，那时该由高度接管。
  const safeAspect = Math.max(0.2, aspect);
  const distanceToFitWidth = (CAMERA_FIT.halfWidth * 2) / 2 / (halfTan * safeAspect);
  const distanceToFitHeight = CAMERA_FIT.verticalExtent / 2 / halfTan;
  return Math.max(distanceToFitWidth, distanceToFitHeight);
}

/** 按取景框把机位重置成默认视角（正对机台、俯角 26°）。 */
export function fitCameraRig(fovDeg: number, aspect: number, rig: CameraRig = cameraRig): void {
  rig.target.set(0, CAMERA_FIT.centerY, CAMERA_FIT.centerZ);
  rig.yaw = 0;
  rig.pitch = CAMERA_FIT.pitch;
  rig.distance = fitCameraDistance(fovDeg, aspect);
  placeCameraRig(rig);
}

/** 把机位落到相机上（只摆位置与朝向，不碰 FOV / 投影矩阵）。 */
export function applyCameraRig(camera: THREE.PerspectiveCamera, rig: CameraRig = cameraRig): void {
  camera.position.copy(rig.position);
  camera.lookAt(rig.target);
}

/** 机位读数（调试面板的状态行与验证钩子共用）。 */
export function cameraRigReport(rig: CameraRig = cameraRig): ThreeCameraRigReport {
  return {
    position: [rig.position.x, rig.position.y, rig.position.z],
    target: [rig.target.x, rig.target.y, rig.target.z],
    yawDeg: toDeg(rig.yaw),
    pitchDeg: toDeg(rig.pitch),
    distance: rig.distance,
  };
}
