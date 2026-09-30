import * as THREE from 'three';

/**
 * 顶部招牌的**实时显示屏**（R3-U4）。
 *
 * ## 为什么是一块独立的小 mesh，而不是把数字画进招牌贴图
 *
 * 招牌画布是 1024×512。往它上面每帧写一次数字 = 每帧重传 ≈2 MB 纹理，
 * 而 `perf` 闸门的预算里没有这笔带宽（帧时间会被一次纹理上传吃掉半帧）。
 * 所以静态构图烘焙一次，会变的数字单独一块 LED 小屏（高 64 纹素、宽按面板比例算），
 * 贴在檐板正前 2 mm —— 更新代价 ≈64 KB，而且只在**内容真的变了**的时候传。
 *
 * ## 刷新是事件驱动 + 节流的
 *
 * `pushLedger()` / `subtitle()` 只置脏位；`tick()` 每帧被调用，但最多
 * 每 125 ms（8 fps）重画一次。LED 招牌本来就是这个刷新率 —— 60 fps 的
 * 数字滚动在 0.24 米高的点阵上只会糊成一片。
 *
 * 滚动**不重画纹理**：改 `texture.offset.x` 让采样窗口滑过整张图，
 * 代价是一个 uniform。所以 `wrapS` 必须是 `RepeatWrapping`。
 *
 * ## 材质侧的约束（`TableBuilder` 负责，这里只把纹理交出去）
 *
 * `map` 与 `emissiveMap` 挂同一张纹理、`detailKind` 与侧板那份一致 ——
 * defines 一字不差才能复用同一个 program（`perf` 的 program 预算不让步）。
 * 自发光是必须的：三渲二的 `color × map` 里，暗底色带永远乘不出亮像素。
 */

/**
 * 面板的**纵向**纹素数固定，横向由 `setAspect()` 按实际面板宽高比算出来。
 *
 * 为什么不再是写死的 256×64：屏「做满」之后面板是 4.997:1，而纹理一直是 4:1 ⇒
 * 字被横向白拉 **24.9 %**（实测，见 `marqueeReport()` 的 textureWidth/Height）。
 * 只把 256 改成 320 也能对上，但对不上 `?model` —— 檐板尺寸一改，比例就又错开，
 * 而且这次连「4:1」这个锚都没了，没人会想起来再修。所以**从几何反推**是唯一
 * 不会过期的写法。
 *
 * 高度不动是有意的：字号、基线、扫描线周期全挂在纵向纹素数上，
 * 改它会同时动三样，而拉伸这件事只需要动宽度。
 */
const H = 64;
/** 宽度取到 4 的整数倍：扫描线周期是 4，非整倍会让最后一道线被截断。 */
const WIDTH_STEP = 4;
/** 未设比例时的兜底宽度（与改造前一致，保证旧截图可比）。 */
const DEFAULT_WIDTH = 256;
/** 重画节流：8 fps 封顶。 */
const MIN_INTERVAL = 0.125;
/** 滚动速度（`texture.offset.x` 单位/秒）。 */
const SCROLL_SPEED = 0.07;
/** 字幕停留时长（秒）；到期回到常态行。 */
const SUBTITLE_SECONDS = 6;

const FONT = 'bold 20px "Courier New", monospace';
/**
 * 文字二值化的 alpha 阈值（0~255）。取 **128 = 覆盖率过半**：
 * 20px 粗体的笔画只有 2~3 纹素宽，再高会断笔（尤其「钱包」的细钩），再低等于没做。
 * 调它只需要看一个数：`marqueeReport().distinctColors` 是否仍是调色板那么大。
 */
const CRISP_ALPHA = 128;
const LED_OFF = '#05090a';
/** 扫描线：只压暗横行，**不画纵缝**（纵横都压就是网格）。 */
const SCANLINE = 'rgba(0, 0, 0, 0.35)';
const BRASS = '#ffd88a';
const DIM = '#7f8a76';

export type MarqueeLedger = { wallet: number; earned: number };

export class MarqueeScreen {
  readonly texture: THREE.CanvasTexture;

  private readonly ctx: CanvasRenderingContext2D;
  private readonly canvas: HTMLCanvasElement;
  /**
   * 文字专用的离屏层（B：硬边化）。
   *
   * 直接 `fillText` 到主画布上，浏览器会按灰度抗锯齿画边；这块屏最终被**放大 1.36 倍**
   * 显示，灰边就被 Nearest 采样拉成 1~2 像素的软块 —— 用户看到的「糊」有一半是这个。
   * 所以文字先画进这张透明层，按 alpha 阈值二值化（非 0 即 255）再合成：
   * 每个纹素只有「亮 / 灭」两态，正是 LED 点阵该有的样子。
   */
  private readonly scratch: HTMLCanvasElement;
  private readonly scratchCtx: CanvasRenderingContext2D;
  /** 1×1 探针画布：只用来问「这个 CSS 颜色会被写成哪三个整数」。 */
  private readonly probeCtx: CanvasRenderingContext2D;
  /** 当前纹素宽度（高度固定为 `H`，宽度由面板实际宽高比反推）。 */
  private width = DEFAULT_WIDTH;
  private ledger: MarqueeLedger = { wallet: 0, earned: 0 };
  private subtitleText = '';
  private subtitleLeft = 0;
  private repaintLeft = 0;
  private dirty = true;
  /** 上一次真正画出去的两行，用来判断「有没有变」——变了才传纹理。 */
  private painted = ['', ''];

  constructor() {
    const canvas = document.createElement('canvas');
    canvas.width = this.width;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法创建 2D 画布：招牌显示屏需要 CanvasRenderingContext2D');
    this.canvas = canvas;
    this.ctx = ctx;
    const scratch = document.createElement('canvas');
    scratch.width = this.width;
    scratch.height = H;
    const scratchCtx = scratch.getContext('2d');
    if (!scratchCtx) throw new Error('无法创建 2D 画布：招牌文字二值化需要一张离屏层');
    this.scratch = scratch;
    this.scratchCtx = scratchCtx;
    const probe = document.createElement('canvas');
    probe.width = 1;
    probe.height = 1;
    const probeCtx = probe.getContext('2d', { willReadFrequently: true });
    if (!probeCtx) throw new Error('无法创建 2D 画布：颜色探针需要一张 1×1 离屏层');
    this.probeCtx = probeCtx;
    // 字体在构造时定一次，之后**不**在 paint 里设：绘制层（`drawCrispLine`）只设
    // 颜色与基线，字号由这里给。留在绘制里设的话，第一帧量到的是 10px 默认字体，
    // 而 `distinctColors` 那条判据会照实报出一个「看起来正常」的值 —— 查不到。
    ctx.font = FONT;
    scratchCtx.font = FONT;
    this.texture = new THREE.CanvasTexture(canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.magFilter = THREE.NearestFilter;
    this.texture.minFilter = THREE.NearestMipmapNearestFilter;
    // 滚动靠 offset 平移采样窗口，必须允许越界回绕。
    this.texture.wrapS = THREE.RepeatWrapping;
    this.texture.wrapT = THREE.ClampToEdgeWrapping;
  }

  /** 当前纹素尺寸，给判据比对「纹理宽高比 == 面板宽高比」。 */
  get texels(): { width: number; height: number } {
    return { width: this.width, height: H };
  }

  /**
   * 按面板的实际宽高比重算纹素宽度。返回**是否真的变了**。
   *
   * 由 `buildMarqueeScreenMesh()` 在每次建网格时调 —— `?model` 拖檐板尺寸会重建外壳，
   * 而这块画布是单例（见文件末尾），所以比例必须跟着走，不然拉伸会以新的比例回来。
   *
   * 宽度取到 `WIDTH_STEP` 的整数倍：扫描线周期是 4，非整倍会让最右一道线被截断；
   * 由此引入的比例残差 ≤ 2/宽度 ≈ 0.6 %，肉眼与判据都当作 0 处理。
   */
  setAspect(aspect: number): boolean {
    if (!(aspect > 0)) return false;
    const next = Math.max(
      WIDTH_STEP,
      Math.round((H * aspect) / WIDTH_STEP) * WIDTH_STEP,
    );
    if (next === this.width) return false;
    this.width = next;
    this.canvas.width = next;
    // ⚠️ 改 canvas 尺寸会**重置该 2D 上下文的全部状态**（含 font），所以两张画布都要
    // 重新设字体。漏掉的话 `?model` 一拖檐板，屏上的字就会退回 10px 默认字体 ——
    // 零报错，只是字变小，而 `distinctColors` 那条判据照样是干净的个位数。
    this.scratch.width = next;
    this.scratch.height = H;
    this.ctx.font = FONT;
    this.scratchCtx.font = FONT;
    // 改尺寸会清空画布，而 CanvasTexture 只有 `needsUpdate` 才会重传；
    // 两者都要，且 `painted` 必须作废 —— 否则「内容没变」这条快路径会让我们
    // 把一张刚被清空的黑纹理留在显存上（表现：屏闪一帧全黑）。
    this.painted = ['', ''];
    this.dirty = true;
    this.texture.needsUpdate = true;
    return true;
  }

  /**
   * 账本快照。由 `Game.publishHud()` 与 DOM HUD 同时喂 —— 同一个数据源，不可能对不上。
   *
   * 只有「现在能花多少」和「本局赚进」两项。**不带历史最高**：那个数在 HUD 里已经是
   * `Math.max(best, earned)`，屏上再算一遍就是第二份真源（改一处忘一处，且没有任何判据会红）。
   */
  pushLedger(ledger: MarqueeLedger): void {
    if (ledger.wallet === this.ledger.wallet && ledger.earned === this.ledger.earned) return;
    this.ledger = { ...ledger };
    this.dirty = true;
  }

  /** 播一条字幕（老虎机开奖、机关提示）。同一句话重复播会把计时续上，这是想要的。 */
  subtitle(text: string): void {
    if (!text) return;
    this.subtitleText = text;
    this.subtitleLeft = SUBTITLE_SECONDS;
    this.dirty = true;
  }

  /**
   * 每帧推进。
   *
   * @param delta 秒
   * @param attract 常态行（没有字幕时显示什么）—— 由调用方给，
   *   因为「这台机器现在该说什么」是玩法层的事，不是这块屏的事。
   */
  tick(delta: number, attract: string): void {
    if (this.subtitleLeft > 0) {
      this.subtitleLeft = Math.max(0, this.subtitleLeft - delta);
    }
    const line2 = this.subtitleLeft > 0 ? this.subtitleText : attract;

    // 循环滚动（E）：**一直滚**，不再只在「放不下」时才滚。
    //
    // 理由是遮挡，不是好看。实测默认游玩机位下，DOM 覆盖层压掉了这块屏的
    // **约 48%**（`#earned-block` 38.8% + 暂停/图鉴两个按钮各 4.6%），
    // 而且这个比例随视口变（移动 390×664 又是另一套）。把内容「挪到没被挡的一边」
    // 要跟着视口算，循环滚动不用 —— 内容自己会走到可见区。
    //
    // 代价说清楚：**会动的数字比静止的难读**。所以速度保持慢
    //（0.07 圈/秒 ⇒ 一圈约 14 秒，账本行在可见区里停留的时间远大于扫过的时间）。
    // 如果以后觉得账本行不该动，正确的改法是「账本行静止 + 只有字幕滚动」——
    // 那需要把两行拆成两张贴片（多一个 draw call），不是在这里加个 if 就完事。
    //
    // 滚动仍然是 `offset.x` 平移采样窗口，**不重画纹理**（代价一个 uniform），
    // 所以 `wrapS` 必须是 `RepeatWrapping`。
    this.texture.offset.x = (this.texture.offset.x + delta * SCROLL_SPEED) % 1;

    this.repaintLeft -= delta;
    if (!this.dirty || this.repaintLeft > 0) return;
    const top = this.line1();
    // 脏位可能只是「同一个数被重复推了一遍」——真传纹理前再比一次内容。
    if (top === this.painted[0] && line2 === this.painted[1]) {
      this.dirty = false;
      return;
    }
    this.paint(top, line2);
    this.repaintLeft = MIN_INTERVAL;
  }

  /** 第一行：钱包 / 本段赚进。数字用千分位以外的一致性格式——点阵上逗号会糊。 */
  private line1(): string {
    return `钱包 ${this.ledger.wallet}  本局 +${this.ledger.earned}`;
  }

  /**
   * 上一次重画之后，画布里**出现过的不同颜色数**。
   *
   * 这是「字为什么糊」的直接度量：一块只有开关两态的 LED 面板，颜色数应该等于
   * 调色板大小（底色、扫描线暗底、字色…个位数）。字体抗锯齿每多一档灰边，
   * 这个数就往上翻 —— 所以它能在肉眼看图之前先告诉我们「有没有中间灰」。
   */
  get distinctColors(): number {
    return this.paletteSize;
  }

  private paletteSize = 0;

  /** 数一遍画布上的不同颜色（含 alpha 通道，所以半透的 AA 边一定会被算进去）。 */
  private measurePalette(): void {
    const data = this.ctx.getImageData(0, 0, this.width, H).data;
    const seen = new Set<number>();
    for (let i = 0; i < data.length; i += 4) {
      seen.add(
        (data[i] << 24) | (data[i + 1] << 16) | (data[i + 2] << 8) | data[i + 3],
      );
      if (seen.size > 4096) break; // 只需要知道「已经爆了」，不必数完
    }
    this.paletteSize = seen.size;
  }

  /**
   * 把 CSS 颜色解析成**浏览器真正会写进画布**的整数 RGB（缓存）。
   *
   * 为什么不自己解析 `#rrggbb`：我们要的是「画出来的那个值」，而不是「我以为的值」——
   * 颜色字符串以后若改成 `rgb()`、命名色或带 alpha，手写解析就悄悄错了。
   * 1×1 画布问一次是最省事且永远正确的做法。
   *
   * ★ 探针必须是**独立的一张**，不能借 scratch：`save()/restore()` 只回滚上下文状态，
   *   **不回滚像素**，借用的话会在左上角留下一个 1×1 杂点（表现：屏角多一颗常亮 LED）。
   */
  private readonly rgbCache = new Map<string, [number, number, number]>();

  private exactRGB(color: string): [number, number, number] {
    const cached = this.rgbCache.get(color);
    if (cached) return cached;
    const ctx = this.probeCtx;
    ctx.globalCompositeOperation = 'copy';
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 1, 1);
    const data = ctx.getImageData(0, 0, 1, 1).data;
    ctx.clearRect(0, 0, 1, 1);
    const rgb: [number, number, number] = [data[0], data[1], data[2]];
    this.rgbCache.set(color, rgb);
    return rgb;
  }

  /**
   * 画一行**硬边**文字（B）。
   *
   * 先画进离屏层 → 按 alpha 阈值二值化 → 合成回主画布。中间灰度全被抹掉，
   * 于是放大 1.36 倍之后每个纹素非亮即灭，不再有一圈被拉成块的软边。
   *
   * 为什么不在主画布上直接阈值整张图：那会连底噪、扫描线的半透明叠加一起量化，
   * 等于顺手改了别的层的效果；只处理文字层，改动面正好是被审的那一件事。
   *
   * ★ 保留下来的像素**连 RGB 一起钉成填充色**（不只是 alpha 二值化）：
   * 光栅化器在高覆盖率（≥ 阈值）的边上仍会给出与填充色差 ±1~2 的 RGB，
   * 只处理 alpha 的话这些像素会带着各自的色值留在画布里 ——
   * 实测那样画布上是 **9** 种颜色而不是 3 种。一层只有一个填充色，
   * 那就让它只有那一个颜色，`distinctColors` 也因此变成真正可断言的数。
   */
  private drawCrispLine(text: string, color: string, y: number): void {
    const scratch = this.scratchCtx;
    scratch.clearRect(0, 0, this.width, H);
    scratch.fillStyle = color;
    scratch.textBaseline = 'middle';
    scratch.fillText(text, 8, y);
    const [r, g, b] = this.exactRGB(color);
    const image = scratch.getImageData(0, 0, this.width, H);
    const data = image.data;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] >= CRISP_ALPHA) {
        data[i] = r;
        data[i + 1] = g;
        data[i + 2] = b;
        data[i + 3] = 255;
      } else {
        data[i + 3] = 0;
      }
    }
    scratch.putImageData(image, 0, 0);
    this.ctx.drawImage(this.scratch, 0, 0);
  }

  private paint(top: string, bottom: string): void {
    const ctx = this.ctx;
    ctx.fillStyle = LED_OFF;
    ctx.fillRect(0, 0, this.width, H);
    ctx.textBaseline = 'middle';
    // ★ C：扫描线**先画**，文字后画盖在它上面。
    //
    // 原来的顺序是文字 → 扫描线，于是每 4 行有一道 35% 的暗带**横切笔画**：
    // 在 1.36 倍放大下暗带约 1.36 像素高、周期 5.4 像素，正好把每一根竖向笔画
    // 锯成短截 —— B 辛苦去掉的灰边，被这一刀换成了「断续」。用户说的
    // 「扫描线我也觉得很模糊」指的就是它。
    //
    // 换顺序不是削弱效果：扫描线表达的是**发光面板**的横纹，它本该只作用在底色上 ——
    // LED 点亮的时候不会被自己面板的扫描线切掉。所以这一改同时修掉观感与物理含义。
    this.paintScanlines();
    // 屏现在铺满檐板 ⇒ 没有第二行时把唯一一行**垂直居中**，
    // 否则上半屏有字、下半屏一片空黑，看着像坏了一半。
    this.drawCrispLine(top, BRASS, bottom ? 18 : H / 2);
    if (bottom) this.drawCrispLine(bottom, DIM, 44);
    // 不再画压圈边框：屏已经铺满檐板的平坦区，檐板自己的倒角就是它的框。
    // （原先那条 2px 实线还被点阵缝隙横穿、切成了一段段的「虚线框」——
    //  缝隙去掉后它顶多变成实线，而实线也不是想要的。）
    this.measurePalette();
    this.painted = [top, bottom];
    this.dirty = false;
    this.texture.needsUpdate = true;
  }

  /** 扫描线：每隔一行压暗一道横纹，做出「发光面板」的条纹；**不画纵缝**（那就是网格）。 */
  private paintScanlines(): void {
    const ctx = this.ctx;
    ctx.fillStyle = SCANLINE;
    for (let y = 2; y < H; y += 4) ctx.fillRect(0, y, this.width, 1);
  }
}

let singleton: MarqueeScreen | null = null;

/**
 * 模块单例。
 *
 * `?model` 模型模式每改一次参数就重建外壳（见 `disposeCabinetShell`），
 * 屏的**几何**跟着重建，但这块画布与纹理只有一份 ——
 * 否则每拖一次滑块就多一张常驻纹理，而且旧数字还会在
 * 新网格上闪一帧。
 */
export function marqueeScreen(): MarqueeScreen {
  if (!singleton) singleton = new MarqueeScreen();
  return singleton;
}
