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
    // 字体在构造时定一次：`isWide()` 用 `measureText` 量宽度，
    // 而量宽必须在**画之前**——字体留在 paint 里设的话，第一帧量的是 10px 默认字体。
    ctx.font = FONT;
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

    // 字幕超出一屏时滚动：offset 平移，不重画。
    if (this.isWide(line2)) {
      this.texture.offset.x = (this.texture.offset.x + delta * SCROLL_SPEED) % 1;
    } else if (this.texture.offset.x !== 0) {
      this.texture.offset.x = 0;
    }

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

  private isWide(text: string): boolean {
    return this.ctx.measureText(text).width > this.width - 8;
  }

  private paint(top: string, bottom: string): void {
    const ctx = this.ctx;
    ctx.fillStyle = LED_OFF;
    ctx.fillRect(0, 0, this.width, H);
    ctx.textBaseline = 'middle';
    // 屏现在铺满檐板 ⇒ 没有第二行时把唯一一行**垂直居中**，
    // 否则上半屏有字、下半屏一片空黑，看着像坏了一半。
    ctx.fillStyle = BRASS;
    ctx.fillText(top, 8, bottom ? 18 : H / 2);
    if (bottom) {
      ctx.fillStyle = DIM;
      ctx.fillText(bottom, 8, 44);
    }
    // 不再画压圈边框：屏已经铺满檐板的平坦区，檐板自己的倒角就是它的框。
    // （原先那条 2px 实线还被点阵缝隙横穿、切成了一段段的「虚线框」——
    //  缝隙去掉后它顶多变成实线，而实线也不是想要的。）
    this.paintScanlines();
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
