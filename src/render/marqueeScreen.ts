import * as THREE from 'three';

/**
 * 顶部招牌的**实时显示屏**（R3-U4）。
 *
 * ## 为什么是一块独立的小 mesh，而不是把数字画进招牌贴图
 *
 * 招牌画布是 1024×512。往它上面每帧写一次数字 = 每帧重传 ≈2 MB 纹理，
 * 而 `perf` 闸门的预算里没有这笔带宽（帧时间会被一次纹理上传吃掉半帧）。
 * 所以静态构图烘焙一次，会变的数字单独一块 256×64 的 LED 小屏，
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

/** LED 点阵的物理分辨率（256×64 都是 2 的幂 ⇒ mipmap 与 RepeatWrapping 都合法）。 */
const W = 256;
const H = 64;
/** 一个 LED 像素占 4×4 texel ⇒ 点阵 64×16 颗。 */
const CELL = 4;
/** 重画节流：8 fps 封顶。 */
const MIN_INTERVAL = 0.125;
/** 滚动速度（`texture.offset.x` 单位/秒）。 */
const SCROLL_SPEED = 0.07;
/** 字幕停留时长（秒）；到期回到常态行。 */
const SUBTITLE_SECONDS = 6;

const FONT = 'bold 20px "Courier New", monospace';
const LED_OFF = '#05090a';
const LED_SEAM = 'rgba(0, 0, 0, 0.85)';
const BRASS = '#ffd88a';
const DIM = '#7f8a76';
/** 压圈色 = `--brass-deep`。屏面是黑的，不给边框就会被读成招牌上的一块洞。 */
const BEZEL = '#a9762c';

export type MarqueeLedger = { wallet: number; earned: number };

export class MarqueeScreen {
  readonly texture: THREE.CanvasTexture;

  private readonly ctx: CanvasRenderingContext2D;
  private ledger: MarqueeLedger = { wallet: 0, earned: 0 };
  private subtitleText = '';
  private subtitleLeft = 0;
  private repaintLeft = 0;
  private dirty = true;
  /** 上一次真正画出去的两行，用来判断「有没有变」——变了才传纹理。 */
  private painted = ['', ''];

  constructor() {
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法创建 2D 画布：招牌显示屏需要 CanvasRenderingContext2D');
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
    return this.ctx.measureText(text).width > W - 8;
  }

  private paint(top: string, bottom: string): void {
    const ctx = this.ctx;
    ctx.fillStyle = LED_OFF;
    ctx.fillRect(0, 0, W, H);
    ctx.textBaseline = 'middle';
    ctx.fillStyle = BRASS;
    ctx.fillText(top, 8, 18);
    ctx.fillStyle = DIM;
    ctx.fillText(bottom, 8, 44);
    // 边框：没有它，这块黑面在彩绘招牌上读成一个**洞**而不是一个**器件**。
    // 描在纹理里而不是加几何 —— 一像素的铜色内沿就足以让眼睛把它当成金属压圈。
    ctx.strokeStyle = BEZEL;
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, W - 2, H - 2);
    this.paintSeams();
    this.painted = [top, bottom];
    this.dirty = false;
    this.texture.needsUpdate = true;
  }

  /** 点阵缝隙：每颗 LED 之间压一道暗线，把「文字」变成「灯点」。 */
  private paintSeams(): void {
    const ctx = this.ctx;
    ctx.fillStyle = LED_SEAM;
    for (let x = CELL - 1; x < W; x += CELL) ctx.fillRect(x, 0, 1, H);
    for (let y = CELL - 1; y < H; y += CELL) ctx.fillRect(0, y, W, 1);
  }
}

let singleton: MarqueeScreen | null = null;

/**
 * 模块单例。
 *
 * `?model` 模型模式每改一次参数就重建外壳（见 `disposeCabinetShell`），
 * 屏的**几何**跟着重建，但这块画布与纹理只有一份 ——
 * 否则每拖一次滑块就多一张 256×64 的常驻纹理，而且旧数字还会在
 * 新网格上闪一帧。
 */
export function marqueeScreen(): MarqueeScreen {
  if (!singleton) singleton = new MarqueeScreen();
  return singleton;
}
