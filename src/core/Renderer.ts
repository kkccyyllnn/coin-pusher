import * as THREE from 'three';
import type { PixelScale } from '../render/PixelScale';

export function createRenderer(canvas: HTMLCanvasElement): THREE.WebGLRenderer {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: false,
    powerPreference: 'high-performance',
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  // ⚠️ **不要**为了「两遍出画要按帧累加」而把 `info.autoReset` 关掉 —— 那样
  // 峰值 draw call 会从 46 静默变成 56，而多出来的 10 次不是新开销。
  // 原因在 three 自己的顺序里：`WebGLRenderer.render()` 先跑 `shadowMap.render()`
  // （:1698）**再** `info.reset()`（:1704），所以历史上这个计数**从来不含阴影 pass**。
  // 关掉 autoReset 等于把阴影的绘制调用一起放进来 ⇒ 与所有历史读数不可比。
  // 分 pass 计数在 `Game.render()` 里做（那里能看见两遍各自的数量）。
  return renderer;
}

/**
 * 按 `PixelScale` 调整画布。
 *
 * 与旧版的区别：**DPR 不再参与分辨率计算**，改成 `setPixelRatio(1 / upscale)`。
 * 画布 backing store 变成「CSS 尺寸 ÷ 整数倍率」。倍率 > 1 时靠 CSS 放大回 CSS 尺寸：
 * `image-rendering: pixelated` 是最近邻（像素风），`auto` 是平滑（默认，画质分档降分辨率时用）。
 *
 * `updateStyle = false`：CSS 尺寸仍由 `#game-canvas { width:100vw; height:100vh }` 决定，
 * 所以我们只改 backing store，不动布局。
 *
 * `camera.aspect` 仍用 **CSS** 宽高：aspect 与倍率无关，而且 `toScreen()` 也是按
 * `canvas.clientWidth/Height` 投影的，两者必须同一口径——这是「零玩法扰动」的关键。
 */
export function resizeRenderer(
  renderer: THREE.WebGLRenderer,
  camera: THREE.PerspectiveCamera,
  pixel: PixelScale,
): boolean {
  const canvas = renderer.domElement;
  const width = Math.max(1, Math.floor(canvas.clientWidth));
  const height = Math.max(1, Math.floor(canvas.clientHeight));
  const bufferWidth = Math.max(1, Math.floor(width * pixel.pixelRatio));
  const bufferHeight = Math.max(1, Math.floor(height * pixel.pixelRatio));
  // 倍率变化也要触发重设（切档时 CSS 尺寸不变，但 backing store 要跟着变）。
  const needsResize =
    renderer.getPixelRatio() !== pixel.pixelRatio ||
    canvas.width !== bufferWidth ||
    canvas.height !== bufferHeight;

  if (needsResize) {
    renderer.setPixelRatio(pixel.pixelRatio);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }

  return needsResize;
}
