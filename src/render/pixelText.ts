/**
 * 像素字的通用小件（Stage 3b）：把「scratch 小画布 fillText + 整数倍放大」抽出来。
 *
 * ## 为什么要抽
 *
 * `marqueeScreen.ts` 里那套做法（先在 1 倍的小画布上写字，再 `drawImage` 整数倍放大）
 * 是本项目"像素中文不需要字体资产"这条结论的唯一执行点：**任何系统字体**在小画布上
 * 栅格化之后再放大，出来的都是像素字。HUD 的数字与标签当时没走这条路，
 * 于是画面上是「像素机柜 + 抗锯齿正文」两种语言并排 —— 用户红框里那句"太简陋"的一半来源。
 *
 * ## 用法与守卫
 *
 * 调用方自己决定**什么时候**重画：`changed()` 比较本次与上一次的绘制请求，
 * 只有变了才真画。沿用 `marqueeScreen` 的「变了才写」纪律 ——
 * 每帧重画会让 canvas 上传持续占用显存带宽，而数字一秒变几十次是常态。
 *
 * ⚠️ 不接 DPR：这套字的定义就是**整数倍**放大，混进 2/3 倍 DPR 会退化成
 * 又一层抗锯齿灰边（正是 `distinctColors` 那条门在抓的东西）。
 */

/** 一次绘制请求：文字、字号（小画布上的像素高）、颜色。 */
export type PixelTextRequest = {
  text: string;
  /** 小画布上的字号（px）。放大倍率由 `scale` 决定，所以这个数就是"笔画高度"。 */
  fontPx: number;
  fill: string;
  /** 可选：与上一次不同才重画（默认比较 `text|fontPx|fill` 整串）。 */
  tag?: string;
};

export type PixelTextSurface = {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  /** 小画布上的绘制面（字就写在这里，1 倍）。 */
  scratch: HTMLCanvasElement;
  scratchContext: CanvasRenderingContext2D;
  /** 整数放大倍率。 */
  scale: number;
  /** 最近一次真正重画时的请求指纹（判据与调试都读它）。 */
  lastKey: () => string;
  /** 重画一次；**没变就什么都不做**，返回 false。 */
  draw: (request: PixelTextRequest) => boolean;
  /** 面板尺寸变了要重铺：清空缓存键，下一次 draw 一定真画。 */
  invalidate: () => void;
  dispose: () => void;
};

const DEFAULT_STACK = '"PingFang SC", "Hiragino Sans GB", system-ui, sans-serif';

export function createPixelTextSurface(options: {
  width: number;
  height: number;
  scale?: number;
  /** 小画布的底色（null = 透明，交给 CSS 的面板底）。 */
  background?: string | null;
  fontStack?: string;
}): PixelTextSurface {
  const scale = Math.max(1, Math.floor(options.scale ?? 4));
  const canvas = document.createElement('canvas');
  canvas.width = options.width;
  canvas.height = options.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('canvas 2d 上下文拿不到（无 GPU / 内存压力）');
  const scratch = document.createElement('canvas');
  // 小画布按**逻辑尺寸 / 倍率**开：字在上面是一个像素一个像素排出来的。
  scratch.width = Math.max(1, Math.round(options.width / scale));
  scratch.height = Math.max(1, Math.round(options.height / scale));
  const scratchContext = scratch.getContext('2d');
  if (!scratchContext) throw new Error('canvas 2d 上下文拿不到（scratch）');
  const fontStack = options.fontStack ?? DEFAULT_STACK;
  let lastKey = '';

  const paint = (request: PixelTextRequest): void => {
    scratchContext.clearRect(0, 0, scratch.width, scratch.height);
    if (options.background) {
      scratchContext.fillStyle = options.background;
      scratchContext.fillRect(0, 0, scratch.width, scratch.height);
    }
    scratchContext.font = `${Math.max(1, Math.round(request.fontPx))}px ${fontStack}`;
    scratchContext.textBaseline = 'middle';
    scratchContext.textAlign = 'center';
    scratchContext.fillStyle = request.fill;
    scratchContext.fillText(request.text, scratch.width / 2, scratch.height / 2);
    // 关键：放大时**不许**插值。这一行就是"像素字"与"糊字"的分界。
    context.imageSmoothingEnabled = false;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(scratch, 0, 0, canvas.width, canvas.height);
  };

  return {
    canvas,
    context,
    scratch,
    scratchContext,
    scale,
    lastKey: () => lastKey,
    draw: (request) => {
      const key = `${request.tag ?? ''}|${request.text}|${request.fontPx}|${request.fill}`;
      if (key === lastKey) return false;
      lastKey = key;
      paint(request);
      return true;
    },
    invalidate: () => {
      lastKey = '';
    },
    dispose: () => {
      scratch.width = 0;
      scratch.height = 0;
      canvas.width = 0;
      canvas.height = 0;
    },
  };
}
