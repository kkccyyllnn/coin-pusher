import * as THREE from 'three';
import GUI from 'lil-gui';
import {
  CABINET_SHELL_PARTS,
  WALL_OUTLINE_BINDING,
  beginCabinetOverride,
  cabinetShapeDiff,
  cloneCabinetShape,
  endCabinetOverride,
  type CabinetShape,
  type CabinetShellPart,
  type CabinetWallSegment,
} from '../game/cabinetShape';
import { cameraRig, placeCameraRig, toDeg, toRad } from '../render/cameraRig';

/**
 * 模型模式（`?model`）：在浏览器里直接调机柜造型。
 *
 * ## 为什么要有它
 *
 * 用户的原话是「**我没办法准确说出修改的需求**」。滑块 + 实时重建把这句话
 * 变成可执行的：拖 → 看 → 「导出改动」→ 那一份 diff **就是需求本身**。
 * 所以这个模式的产出物不是「一个能调的面板」，是**可交付的数值差异**。
 *
 * ## 边界：只改视觉，绝不碰碰撞
 *
 * 用户明确要求「不打算动碰撞边界，只改模型细节」。这不是靠自觉遵守的，
 * 是**结构上做不到**：
 *   - 这个类只写 `cabinetShape.ts` 的覆盖层，而所有 `ColliderDesc.cuboid`
 *     都在 `buildTable(world)` 里手写、读的是 `constants.ts` 的 `TABLE`；
 *   - 面板里没有一个字段能改到 `TABLE`。
 *
 * ⚠️ 但**有一条看不见的接口**必须盯着：`wall.innerX` 必须等于 `TABLE.halfWidth`
 * （0.80）。它同时是侧墙内表面与侧壁碰撞体内表面 —— 调走之后币会停在
 * 离可视墙一条缝的地方。面板把它标了警告，`cabinet` 判据也断言了它。
 *
 * ## 为什么覆盖层只在 `?model` 下存在
 *
 * 见 `cabinetShape.ts` 的覆盖层注释：判据比的是「场景实测盒 vs 解析盒」，
 * 两边都走 `cabinetShape()`。若覆盖在判据下也生效，两边会**一起变** ⇒ 全绿，
 * 于是一个只活在 localStorage 里、从没落进代码的尺寸会被当成已提交的。
 *
 * ## 交互
 *
 * | 操作 | 结果 |
 * | --- | --- |
 * | 左键**点**一下机柜件 | 选中（高亮它的边线），面板跳到驱动它的那一组参数 |
 * | 左键**拖** | 轨道旋转 |
 * | 滚轮 | 推拉 |
 * | 侧墙被选中时选一条折线段 | 高亮那条边 + 显示它的**角度** + 直接调它的两个端点 |
 *
 * 「点」与「拖」靠位移阈值区分（< 4 像素算点）。
 */
export type ModelModeHooks = {
  /**
   * 重建外壳并**返回新的一具**。
   *
   * 由 `Game` 实现：它知道父节点是谁、也知道重建后要把皮肤色刷回去
   * （材质是模块单例，所以只需刷颜色，不必重生成贴图 —— 见
   * `TableBuilder.cabinetMaterials()`）。
   */
  rebuild: () => THREE.Object3D;
  /** 机位改完：把 `cameraRig` 落到相机上并记账（`Game.applyCameraRigFromPanel()`）。 */
  applyCamera: () => void;
};

const STORAGE_KEY = 'coin-pusher:model-shape';
const MIN_DISTANCE = 0.6;
const MAX_DISTANCE = 9;
/** 按下与抬起的位移小于它就算「点」而不是「拖」。 */
const CLICK_SLOP = 4;

/** 分组标题。 */
const GROUP_LABELS: Record<'wall' | 'hood' | 'back', string> = {
  wall: '侧墙 wall',
  hood: '顶板 / 檐板 hood',
  back: '背板 back',
};

/**
 * 字段的中文名。
 *
 * ⚠️ 这张表是**纯显示**的：它只决定滑块旁边写什么字，不参与任何几何推导。
 * 所以它漏一个字段的后果是「那行显示英文原名」，不是「几何算错」——
 * 与 `WALL_OUTLINE_BINDING` 那种「漏了就少一条边」的表性质完全不同。
 */
const FIELD_LABELS: Record<string, string> = {
  innerX: '内表面 |x|（★ 必须 = TABLE.halfWidth）',
  thickness: '板厚',
  backZ: '后缘 z',
  bottomY: '下沿 y',
  insetZ: '高段内收 z',
  hoodFrontZ: '檐板托前缘 z',
  miterFrontY: '斜接面前端 y',
  insetTopY: '内收面顶 y',
  lowRoofBackY: '低段斜顶·后端 y',
  lowRoofFrontY: '低段斜顶·前端 y',
  lowFrontZ: '低段前缘 z',
  tallTopY: '高段顶 y',
  halfWidth: '半宽',
  underY: '顶板下表面 y',
  topY: '上表面 y',
  valanceInnerZ: '檐板内表面 z',
  valanceFrontZ: '檐板外表面 z',
  valanceBottomY: '檐板下沿 y',
  frontZ: '前表面 z（★ 必须 = TABLE.backZ）',
};

function wallSegmentOf(part: CabinetShellPart): CabinetWallSegment | null {
  if (part.startsWith('sideWall.tall')) return 'tall';
  if (part.startsWith('sideWall.low')) return 'low';
  return null;
}

function shapeGroupOf(part: CabinetShellPart): 'wall' | 'hood' | 'back' {
  if (part.startsWith('sideWall')) return 'wall';
  if (part.startsWith('hood')) return 'hood';
  return 'back';
}

/** `(z, y)` 平面里 `a → b` 这条线段与 **+z 轴**的夹角（度）。 */
function segmentAngleDeg(
  a: readonly [number, number],
  b: readonly [number, number],
): number {
  return toDeg(Math.atan2(b[1] - a[1], b[0] - a[0]));
}

export class ModelMode {
  /** 是否处于 `?model`。`Game` 靠它决定要不要交出机位所有权。 */
  readonly enabled: boolean;

  private readonly shape: CabinetShape;
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly controllers: Array<{ updateDisplay(): unknown }> = [];
  private readonly folders = new Map<string, GUI>();
  private gui: GUI | null = null;
  private statusEl: HTMLDivElement | null = null;
  private edgeFolder: GUI | null = null;
  private shell: THREE.Object3D | null = null;
  private selected: CabinetShellPart | null = null;
  private selectedEdge = 0;
  private outline: THREE.LineSegments | null = null;
  private edgeLine: THREE.Line | null = null;
  private saveTimer: number | null = null;
  private dragging = false;
  private dragMoved = 0;
  private lastX = 0;
  private lastY = 0;

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly domElement: HTMLElement,
    private readonly hooks: ModelModeHooks,
  ) {
    this.enabled = new URLSearchParams(window.location.search).has('model');
    // ★ 覆盖层必须在 `buildTable()` **之前**生效：`Game` 先构造本类、
    // 再建台面，否则第一具外壳读到的还是编译期默认值，localStorage 里
    // 存着的造型要等一次重建才出现（表现为「刷新之后造型弹回去了」）。
    this.shape = this.loadShape();
    if (!this.enabled) return;

    beginCabinetOverride(this.shape);
    this.buildGui();
    this.bindPointer();
  }

  // ── 外部接口 ────────────────────────────────────────────────────────────

  /** 绑到（新的一具）外壳上。重建之后由 `Game` 调。 */
  attach(shell: THREE.Object3D): void {
    this.shell = shell;
    if (this.selected) this.highlightPart(this.selected);
  }

  dispose(): void {
    if (!this.enabled) return;
    this.unbindPointer();
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.clearOutline();
    this.gui?.destroy();
    this.gui = null;
    // 覆盖层退出：判据与正常游玩从此读回编译期真值。
    endCabinetOverride();
  }

  // ── 测试钩子 ────────────────────────────────────────────────────────────
  //
  // 判据（`verify-game.mjs model`）必须走**与用户同一条路**：写形状 → 重建
  // → 读场景。它不去点 lil-gui 的 DOM（那测的是 lil-gui），也不自己造一具
  // 外壳（那测的是 `TableBuilder`）—— 这两条路一旦分叉，就会出现
  // 「面板上能用、判据红」这种没法解释的差异。

  /** 按 `'wall.insetZ'` 这样的路径写一个数并触发重建。 */
  setFieldForTest(path: string, value: number): void {
    const parts = path.split('.');
    let target = this.shape as unknown as Record<string, unknown>;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const next = target[parts[i]];
      if (typeof next !== 'object' || next === null) return;
      target = next as Record<string, unknown>;
    }
    target[parts[parts.length - 1]] = value;
    this.onShapeChanged();
  }

  /** 当前与编译期默认值的差异条数。 */
  diffCount(): number {
    return cabinetShapeDiff(this.shape).length;
  }

  /** 走与「重置为默认造型」按钮同一条路。 */
  resetForTest(): void {
    this.resetShape();
  }

  /** 当前选中件（没选中时为 null）。 */
  selectedPart(): string | null {
    return this.selected;
  }

  /**
   * 当前挂着几条选中指示线：0 = 没选中，1 = 只有件轮廓，2 = 件轮廓 + 边高亮。
   *
   * ★ 为什么要把它交出来：WebGL 里 `LineBasicMaterial.linewidth` 是**被忽略**的，
   * 高亮永远是 1 像素 —— 在一张 1280×720 的截图上「看得见 / 看不见」根本没法判。
   * 于是「高亮到底有没有加上」只能靠计数，截图只用来核**好不好看**。
   */
  outlineCount(): number {
    return (this.outline ? 1 : 0) + (this.edgeLine ? 1 : 0);
  }

  /**
   * 选中一个外壳件 —— 走的是与「点一下机柜件」**同一条** `select()`。
   *
   * 为什么钩子不复刻一遍选中逻辑：`select()` 里还牵着高亮、边文件夹重建、
   * 参数分组自动展开三件事。复刻一份的结果是「钩子选中了但面板没展开」，
   * 而那正是「面板上能用、判据红」的另一种写法。
   */
  selectForTest(part: string): boolean {
    if (!(CABINET_SHELL_PARTS as readonly string[]).includes(part)) return false;
    this.select(part as CabinetShellPart);
    return true;
  }

  // ── 存档 ────────────────────────────────────────────────────────────────

  /**
   * 从 localStorage 读回工作副本。
   *
   * 逐字段**合并**而不是整体替换：`CABINET` 以后加字段时，老存档里没有那一项，
   * 合并会保住新字段的默认值；整体替换会把它变成 `undefined`
   * —— 然后几何算出 `NaN`，而 `NaN` 的包围盒是 `±Infinity`，
   * 表现是「机柜整个消失」，非常难往回查。
   */
  private loadShape(): CabinetShape {
    const fresh = cloneCabinetShape();
    let raw: string | null = null;
    try {
      raw = window.localStorage.getItem(STORAGE_KEY);
    } catch {
      raw = null; // 隐私模式 / 禁用存储：当成没有存档。
    }
    if (!raw) return fresh;
    try {
      const saved = JSON.parse(raw) as Partial<CabinetShape>;
      for (const groupKey of ['wall', 'hood', 'back'] as const) {
        const target = fresh[groupKey] as Record<string, number>;
        const source = saved[groupKey] as Record<string, number> | undefined;
        if (!source) continue;
        for (const key of Object.keys(target)) {
          const value = source[key];
          if (typeof value === 'number' && Number.isFinite(value)) target[key] = value;
        }
      }
      const bevel = saved.bevel;
      if (bevel) {
        if (typeof bevel.radius === 'number' && Number.isFinite(bevel.radius)) {
          fresh.bevel.radius = bevel.radius;
        }
        if (typeof bevel.segments === 'number' && Number.isFinite(bevel.segments)) {
          fresh.bevel.segments = Math.round(bevel.segments);
        }
        if (bevel.perPart) fresh.bevel.perPart = { ...bevel.perPart };
      }
    } catch {
      // 存档坏了就用默认值。**不拦启动** —— 一个坏掉的 localStorage
      // 不该让页面打不开，而且用户没有任何手段清掉它。
    }
    return fresh;
  }

  /** 落盘（合并到 200 毫秒一次，拖滑块时不必每帧写）。 */
  private saveShape(): void {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(this.shape));
      } catch {
        // 写不进去（配额 / 隐私模式）只影响「刷新后还在不在」，不影响本次会话。
      }
    }, 200);
  }

  // ── 面板 ────────────────────────────────────────────────────────────────

  private buildGui(): void {
    const gui = new GUI({ title: '模型模式（?model）' });
    this.gui = gui;

    // ── 操作 ──
    const actions = gui.addFolder('操作');
    actions.add({ reset: () => this.resetShape() }, 'reset').name('重置为默认造型');
    actions.add({ export: () => this.exportDiff() }, 'export').name('导出改动 → 控制台 + 剪贴板');
    actions.add({ clear: () => this.clearSelection() }, 'clear').name('取消选中');
    this.statusEl = document.createElement('div');
    this.statusEl.className = 'cp-debug-note';
    actions.domElement.appendChild(this.statusEl);

    // ── 选中件 ──
    const pick = gui.addFolder('选中件');
    // ⚠️ 对象字面量里的 getter，其 `this` 指向**这个字面量本身**，不是类实例。
    // 写成 `this.selected` 拿到的是 `undefined`（这里 TS 会拦下来，算走运；
    // 换成 `any` 就会变成一个「面板永远显示 (点一下机柜件)」的静默缺陷）。
    const self = this;
    const pickProxy = {
      get part(): string {
        return self.selected ?? '(点一下机柜件)';
      },
    };
    pick.add(pickProxy, 'part').disable().listen();
    this.folders.set('pick', pick);

    // ── 选中的边（只有侧墙有）──
    this.edgeFolder = gui.addFolder('选中的边');
    this.rebuildEdgeFolder();

    // ── 倒角（全局）──
    const bevelFolder = gui.addFolder('倒角（直角盒件）');
    bevelFolder
      .add(this.shape.bevel, 'radius', 0, 0.06, 0.001)
      .name('圆角半径（米）')
      .onChange(() => this.onShapeChanged());
    bevelFolder
      .add(this.shape.bevel, 'segments', 1, 8, 1)
      .name('圆角分段（1=45° 倒角）')
      .onChange(() => this.onShapeChanged());
    this.folders.set('bevel', bevelFolder);

    // ── 三组尺寸（从真源自动生成，不手写控件列表）──
    //
    // ★ 手写 20 个滑块就是「第二份真源」：往 `CABINET` 加一个字段，
    // 滑块列表会静默漂移，而漂移的表现是「某个参数永远调不到」。
    // 递归生成不可能漏。
    for (const groupKey of ['wall', 'hood', 'back'] as const) {
      const folder = gui.addFolder(GROUP_LABELS[groupKey]);
      const group = this.shape[groupKey] as unknown as Record<string, number>;
      for (const key of Object.keys(group)) {
        const controller = folder
          .add(group, key)
          .name(FIELD_LABELS[key] ?? key)
          .onChange(() => this.onShapeChanged());
        this.controllers.push(controller);
      }
      this.folders.set(groupKey, folder);
    }

    for (const folder of this.folders.values()) folder.close();
    actions.open();
    this.refreshStatus();
  }

  /**
   * 重建「选中的边」文件夹。
   *
   * 之所以整块销毁重建而不是改显示值：段数随选中的墙段变化（高段 6 条 / 低段 4 条），
   * 控件的**数量**会变，lil-gui 没有「改数量」的接口。
   */
  private rebuildEdgeFolder(): void {
    const gui = this.gui;
    const folder = this.edgeFolder;
    if (!gui || !folder) return;

    // 清掉上一次加进去的控件（保留文件夹本身）。
    for (const child of [...folder.controllers, ...folder.folders]) child.destroy();

    const segment = this.selected ? wallSegmentOf(this.selected) : null;
    if (!segment) {
      folder.add({ hint: '(选中一块侧墙才有效)' }, 'hint').disable();
      return;
    }

    const binding = WALL_OUTLINE_BINDING[segment];
    // 同上：字面量 getter 的 `this` 不是类实例，必须显式接一份。
    const self = this;
    const proxy = {
      get edge(): string {
        const a = binding[self.selectedEdge % binding.length];
        const b = binding[(self.selectedEdge + 1) % binding.length];
        return `${self.selectedEdge}: ${a.label} → ${b.label}`;
      },
      get angleDeg(): number {
        const outline = binding.map(
          (p) => [self.shape.wall[p.z], self.shape.wall[p.y]] as const,
        );
        const a = outline[self.selectedEdge % binding.length];
        const b = outline[(self.selectedEdge + 1) % binding.length];
        return Math.round(segmentAngleDeg(a, b) * 10) / 10;
      },
    };

    folder
      .add(proxy, 'edge')
      .disable()
      .listen();
    folder
      .add({ index: this.selectedEdge }, 'index', 0, binding.length - 1, 1)
      .name('第几条边')
      .onChange((value: number) => {
        this.selectedEdge = Math.round(value);
        this.rebuildEdgeFolder();
        this.highlightEdge();
      });
    folder.add(proxy, 'angleDeg').name('角度（度，只读）').disable().listen();

    // 这条边的两个端点 —— 直接绑回 `wall` 的字段。
    //
    // ★ 端点可能**共用**字段（例如高段的 P0.z 与 P5.z 都是 `backZ`），
    // 所以这里按「字段」而不是按「端点」列控件，并且在名字里写出字段名。
    // 把端点当成独立可调量会造出「改了 P0 的 z，P5 没跟着动」的假象 ——
    // 而它们物理上就是同一条边。
    const seen = new Set<string>();
    for (const index of [this.selectedEdge % binding.length, (this.selectedEdge + 1) % binding.length]) {
      const point = binding[index];
      for (const axis of ['z', 'y'] as const) {
        const field = point[axis];
        const key = `${field}:${axis}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const label = axis === 'z' ? 'z' : 'y';
        folder
          .add(this.shape.wall as unknown as Record<string, number>, field)
          .name(`${point.label} ${label}（wall.${field}）`)
          .onChange(() => this.onShapeChanged());
      }
    }
    folder.open();
    this.highlightEdge();
  }

  private refreshStatus(): void {
    if (!this.statusEl) return;
    const count = cabinetShapeDiff(this.shape).length;
    const part = this.selected ?? '（未选中）';
    this.statusEl.textContent =
      `当前选中：${part}　|　与默认值的差异：${count} 项` +
      (count > 0 ? '（点「导出改动」拿到可粘贴的清单）' : '');
  }

  private refreshDisplays(): void {
    for (const controller of this.controllers) controller.updateDisplay();
    for (const folder of this.folders.values()) {
      // lil-gui 的 `.listen()` 控件是自刷的，但被 `disable()` 的代理控件
      // 在 `updateDisplay()` 里才会重算 getter —— 显式推一遍最省心。
      folder.controllers.forEach((controller) => controller.updateDisplay());
    }
    this.refreshStatus();
  }

  // ── 改动 ────────────────────────────────────────────────────────────────

  private onShapeChanged(): void {
    this.saveShape();
    // 重建整具外壳。7 个网格、几何总计几千个三角形 —— 直接重建比
    // 「逐件判断要不要重建」更简单，而且不可能漏件。
    this.attach(this.hooks.rebuild());
    this.refreshDisplays();
    this.refreshEdgeReadout();
  }

  private refreshEdgeReadout(): void {
    this.edgeFolder?.controllers.forEach((controller) => controller.updateDisplay());
    this.highlightEdge();
  }

  private resetShape(): void {
    const fresh = cloneCabinetShape();
    for (const groupKey of ['wall', 'hood', 'back'] as const) {
      const target = this.shape[groupKey] as unknown as Record<string, unknown>;
      const source = fresh[groupKey] as unknown as Record<string, unknown>;
      for (const key of Object.keys(target)) delete target[key];
      Object.assign(target, source);
    }
    this.shape.bevel.radius = fresh.bevel.radius;
    this.shape.bevel.segments = fresh.bevel.segments;
    // ★ 逐件倒角也要一起清：不清的话「重置」之后仍留着上一轮的逐件覆盖，
    // 而全局滑块显示的是默认值 —— 两个数对不上，且没有任何提示。
    for (const key of Object.keys(this.shape.bevel.perPart)) {
      delete this.shape.bevel.perPart[key as CabinetShellPart];
    }
    this.saveShape();
    this.attach(this.hooks.rebuild());
    this.rebuildEdgeFolder();
    this.refreshDisplays();
    this.hooks.rebuild();
  }

  /**
   * 导出与默认值的差异。
   *
   * ★ 这是整个模式的**产出物**。用户说不出需求，但拖完滑块之后这份清单
   * 就是需求本身 —— 拿到它就能逐条落回 `cabinetShape.ts`。
   */
  private exportDiff(): void {
    const diffs = cabinetShapeDiff(this.shape);
    const lines = diffs.map(
      (entry) =>
        `  ${entry.path.padEnd(38)} ${Number.isNaN(entry.from) ? '(默认无此项)' : entry.from}  →  ${entry.to}`,
    );
    const payload = [
      `[模型模式] 与编译期默认值差异 ${diffs.length} 项：`,
      ...(diffs.length ? lines : ['  （没有改动）']),
      '',
      '// 完整造型（可直接贴回来）：',
      JSON.stringify(this.shape, null, 2),
    ].join('\n');

    // eslint-disable-next-line no-console -- 这是这个模式的交付通道，不是调试残留。
    console.log(payload);
    const clipboard = navigator.clipboard;
    if (clipboard?.writeText) {
      void clipboard.writeText(payload).catch(() => {
        // 非安全上下文（http 且非 localhost）拿不到剪贴板权限；
        // 控制台那份已经打出来了，不额外报错。
      });
    }
    if (this.statusEl) {
      this.statusEl.textContent = `已导出 ${diffs.length} 项改动 → 控制台（并尝试复制到剪贴板）`;
    }
  }

  // ── 拾取 ────────────────────────────────────────────────────────────────

  private bindPointer(): void {
    // ★ 全部走**捕获阶段 + stopImmediatePropagation**：游戏输入（投币 / 点暂停）
    // 也挂在 canvas 上，不拦的话「点一下选件」会顺手投一枚币。
    // 只拦落在 canvas 上的事件 —— lil-gui 面板挂在 body 上，不受影响。
    const options = { capture: true, passive: false } as const;
    window.addEventListener('pointerdown', this.onPointerDown, options);
    window.addEventListener('pointermove', this.onPointerMove, options);
    window.addEventListener('pointerup', this.onPointerUp, options);
    window.addEventListener('wheel', this.onWheel, options);
    window.addEventListener('keydown', this.onKeyDown);
  }

  private unbindPointer(): void {
    const options = { capture: true } as const;
    window.removeEventListener('pointerdown', this.onPointerDown, options);
    window.removeEventListener('pointermove', this.onPointerMove, options);
    window.removeEventListener('pointerup', this.onPointerUp, options);
    window.removeEventListener('wheel', this.onWheel, options);
    window.removeEventListener('keydown', this.onKeyDown);
  }

  private isOverCanvas(event: Event): boolean {
    const target = event.target as Node | null;
    return target !== null && this.domElement.contains(target);
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (!this.isOverCanvas(event)) return;
    event.stopImmediatePropagation();
    event.preventDefault();
    this.dragging = true;
    this.dragMoved = 0;
    this.lastX = event.clientX;
    this.lastY = event.clientY;
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (!this.dragging) return;
    if (!this.isOverCanvas(event)) return;
    event.stopImmediatePropagation();
    const dx = event.clientX - this.lastX;
    const dy = event.clientY - this.lastY;
    this.lastX = event.clientX;
    this.lastY = event.clientY;
    this.dragMoved += Math.abs(dx) + Math.abs(dy);
    if (this.dragMoved < CLICK_SLOP) return;

    cameraRig.yaw -= dx * 0.008;
    cameraRig.pitch = Math.min(1.35, Math.max(-1.35, cameraRig.pitch + dy * 0.006));
    placeCameraRig();
    this.hooks.applyCamera();
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (!this.dragging) return;
    this.dragging = false;
    if (!this.isOverCanvas(event)) return;
    event.stopImmediatePropagation();
    if (this.dragMoved >= CLICK_SLOP) return;
    this.pickAt(event.clientX, event.clientY);
  };

  private readonly onWheel = (event: WheelEvent): void => {
    if (!this.isOverCanvas(event)) return;
    event.stopImmediatePropagation();
    event.preventDefault();
    const next = cameraRig.distance * Math.exp(event.deltaY * 0.0012);
    cameraRig.distance = Math.min(MAX_DISTANCE, Math.max(MIN_DISTANCE, next));
    placeCameraRig();
    this.hooks.applyCamera();
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    // `0` = 回到默认取景。面板拖到别处之后按一下就能回来，比手调四个数快。
    if (event.key !== '0') return;
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT')) return;
    cameraRig.yaw = 0;
    cameraRig.pitch = toRad(23.43);
    cameraRig.distance = 3.75;
    placeCameraRig();
    this.hooks.applyCamera();
  };

  private pickAt(clientX: number, clientY: number): void {
    if (!this.shell) return;
    const rect = this.domElement.getBoundingClientRect();
    this.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObject(this.shell, true);
    for (const hit of hits) {
      const part = hit.object.userData.part as CabinetShellPart | undefined;
      if (part && (CABINET_SHELL_PARTS as readonly string[]).includes(part)) {
        this.select(part);
        return;
      }
    }
  }

  private select(part: CabinetShellPart): void {
    this.selected = part;
    this.selectedEdge = 0;
    this.highlightPart(part);
    this.rebuildEdgeFolder();
    // 自动展开驱动这一件的那一组参数 —— 「选中 → 看到该改哪个数」。
    for (const folder of this.folders.values()) folder.close();
    this.folders.get('pick')?.open();
    this.folders.get(shapeGroupOf(part))?.open();
    if (wallSegmentOf(part)) this.edgeFolder?.open();
    this.refreshDisplays();
  }

  private clearSelection(): void {
    this.selected = null;
    this.clearOutline();
    this.rebuildEdgeFolder();
    this.refreshDisplays();
  }

  // ── 高亮 ────────────────────────────────────────────────────────────────

  private findMesh(part: CabinetShellPart): THREE.Mesh | null {
    let found: THREE.Mesh | null = null;
    this.shell?.traverse((child) => {
      if (found) return;
      const mesh = child as THREE.Mesh;
      if (mesh.isMesh === true && mesh.userData.part === part) found = mesh;
    });
    return found;
  }

  private clearOutline(): void {
    if (this.outline) {
      this.outline.removeFromParent();
      this.outline.geometry.dispose();
      (this.outline.material as THREE.Material).dispose();
      this.outline = null;
    }
    if (this.edgeLine) {
      this.edgeLine.removeFromParent();
      this.edgeLine.geometry.dispose();
      (this.edgeLine.material as THREE.Material).dispose();
      this.edgeLine = null;
    }
  }

  private highlightPart(part: CabinetShellPart): void {
    this.clearOutline();
    const mesh = this.findMesh(part);
    if (!mesh) return;
    // 挂成网格的子节点 ⇒ 自动继承它的变换，不必自己算世界矩阵。
    const outline = new THREE.LineSegments(
      new THREE.EdgesGeometry(mesh.geometry, 25),
      new THREE.LineBasicMaterial({ color: 0x22e6e9, depthTest: false, transparent: true }),
    );
    outline.renderOrder = 999;
    // ⚠️ 不挂 `userData.part`：挂上去 `cabinetReport()` 就会把它当成一件，
    // `cabinet` 判据的「件册完整性」当场红。判据只在非 `?model` 下跑，
    // 但把这条约束写死在这里更省事 —— 以后有人给模型模式加判据也不会踩。
    mesh.add(outline);
    this.outline = outline;
    this.highlightEdge();
  }

  /** 把选中的那条折线段画成一条粗线（叠在轮廓之上）。 */
  private highlightEdge(): void {
    if (this.edgeLine) {
      this.edgeLine.removeFromParent();
      this.edgeLine.geometry.dispose();
      (this.edgeLine.material as THREE.Material).dispose();
      this.edgeLine = null;
    }
    const segment = this.selected ? wallSegmentOf(this.selected) : null;
    if (!segment) return;
    const mesh = this.findMesh(this.selected as CabinetShellPart);
    if (!mesh) return;

    const binding = WALL_OUTLINE_BINDING[segment];
    const outline = binding.map((point) => [this.shape.wall[point.z], this.shape.wall[point.y]] as const);
    const a = outline[this.selectedEdge % binding.length];
    const b = outline[(this.selectedEdge + 1) % binding.length];

    // 折线活在 (z, y) 平面里，挤出方向是 ±x。这里把它画在**外表面**那一侧：
    // 几何是「先居中、再由网格位置搬到 side」，所以网格的局部 x=0 就是板的中面。
    const half = this.shape.wall.thickness / 2;
    const side = (this.selected as CabinetShellPart).endsWith('.L') ? -1 : 1;
    const x = side * (half + 0.004);
    const geometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(x, a[1], a[0]),
      new THREE.Vector3(x, b[1], b[0]),
    ]);
    const line = new THREE.Line(
      geometry,
      new THREE.LineBasicMaterial({ color: 0xffb13d, depthTest: false, transparent: true }),
    );
    line.renderOrder = 1000;
    mesh.add(line);
    this.edgeLine = line;
  }
}
