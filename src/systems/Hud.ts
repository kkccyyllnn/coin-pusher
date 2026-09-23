import type { EndlessConfig } from '../game/endless';
import type { BetTier } from '../game/economy';
import { MECHANISM_COST } from './Mechanisms';
import type { RunSnapshot } from './RunState';
import { closingLine, tauntFor } from './Taunts';

export type MechanismSnapshot = {
  sweeper: number;
  grapple: number;
  reload: number;
  wheel: number;
};

/** 破产弹窗 / 本局结算卡片的内容。 */
export type RuinPayload = {
  /** 本局越线赚进的筹码（不含跪求赏赐）。 */
  earned: number;
  /** 结算瞬间的局内筹码余额。 */
  chips: number;
  /** 收工能回存钱包的筹码。破产弹窗（本局未结束）时为 undefined。 */
  cashOut?: number;
  /** 当前钱包余额；总结卡片上传的是**回存之后**的值。 */
  wallet: number;
  drops: number;
  chipsPeak: number;
  begs: number;
  totalBegs: number;
  best: number;
  runs: Array<{ earned: number; drops: number; begs: number }>;
  grant: number;
  /** true 表示这是「保留尊严，收工」后的总结，不再显示跪求按钮。 */
  summary?: boolean;
};

/** XIXI 四槽的字形（点亮面板与无障碍标签共用）。 */
const XIXI_GLYPHS = ['X', 'I', 'X', 'I'];

/**
 * HUD 只读快照并写 DOM，不持有任何游戏状态。
 *
 * v3 起只有无尽这一种玩法：没有目标进度条、星级与循环警告，
 * 破产弹窗（嘲讽 + 跪求 / 收工）是唯一的结算界面。
 */
export class Hud {
  private readonly levelLabel = this.el('#level-label');
  private readonly earnedValue = this.el('#earned-value');
  private readonly bestValue = this.el('#best-value');
  private readonly walletValue = this.el('#wallet-value');
  private readonly creditsValue = this.el('#credits-value');
  private readonly statusLine = this.el('#status-line');
  private readonly comboToast = this.el('#combo-toast');
  private readonly markNote = this.el('#mark-note');
  private readonly marks = Array.from(document.querySelectorAll<HTMLElement>('#xixi-marks .mark'));
  private readonly channelMarks = this.el('#xixi-marks');
  private readonly dropButton = this.el<HTMLButtonElement>('#drop-button');
  private readonly dropState = this.el('#drop-state');
  private readonly boostButton = this.el<HTMLButtonElement>('#boost-button');
  private readonly boostState = this.el('#boost-state');
  private readonly pauseButton = this.el<HTMLButtonElement>('#pause-button');
  private readonly pausePanel = this.el('#pause-panel');
  private readonly drainPrompt = this.el('#drain-prompt');
  private readonly climaxFlash = this.el('#climax-flash');
  private readonly hud = this.el('#hud');
  private readonly sweeperButton = this.el<HTMLButtonElement>('#sweeper-button');
  private readonly sweeperState = this.el('#sweeper-state');
  private readonly grappleButton = this.el<HTMLButtonElement>('#grapple-button');
  private readonly grappleState = this.el('#grapple-state');
  private readonly reloadButton = this.el<HTMLButtonElement>('#reload-button');
  private readonly reloadState = this.el('#reload-state');
  private readonly wheelButton = this.el<HTMLButtonElement>('#wheel-button');
  private readonly wheelState = this.el('#wheel-state');
  private readonly betButton = this.el<HTMLButtonElement>('#bet-button');
  private readonly betState = this.el('#bet-state');
  private readonly ruinPanel = this.el('#ruin-panel');
  private readonly ruinTitle = this.el('#ruin-title');
  private readonly ruinTaunt = this.el('#ruin-taunt');
  private readonly ruinStats = this.el('#ruin-stats');
  private readonly ruinBoard = this.el('#ruin-board');
  private readonly begButton = this.el<HTMLButtonElement>('#beg-button');

  private lastComboShown = 0;
  private lastMarks: boolean[] = [false, false, false, false];
  private lastBoostCharges = 0;

  bindPauseToggle(handler: () => void): void {
    const toggle = (event: Event) => {
      event.preventDefault();
      handler();
    };
    this.pauseButton.addEventListener('click', toggle);
    this.el('#resume-button').addEventListener('click', toggle);
  }

  /** 动效降级开关：读的是 <html data-motion>，与 CSS 同源。 */
  private get reducedMotion(): boolean {
    return document.documentElement.dataset.motion === 'reduced';
  }

  bindRuinActions(onBeg: () => void, onQuit: () => void): void {
    this.begButton.addEventListener('click', (event) => {
      event.preventDefault();
      onBeg();
    });
    this.el('#quit-button').addEventListener('click', (event) => {
      event.preventDefault();
      onQuit();
    });
  }

  /**
   * 破产弹窗 / 本局结算卡片。
   *
   * 破产不是失败状态，是这个模式的核心产出：所以标题、嘲讽、赏赐都在这里，
   * 两个按钮是**真实选择**——跪求保留盘面（沉没价值是拉力来源），收工清空盘面。
   */
  showRuin(payload: RuinPayload): void {
    const summary = payload.summary === true;
    this.ruinTitle.textContent = summary ? '本局结束' : '破产';
    // 破产嘲讽的是手气与决策；收工是玩家主动离场，只做收束，不该被嘲。
    this.ruinTaunt.textContent = summary ? closingLine() : tauntFor(payload.totalBegs, payload.drops);

    this.ruinStats.innerHTML = '';
    const rows: Array<[string, string]> = [
      ['本局赚进', `${payload.earned} 筹码`],
      ['存活投数', String(payload.drops)],
      ['筹码峰值', String(payload.chipsPeak)],
      ['本局跪求', `${payload.begs} 次`],
      ['历史最高赚进', `${Math.max(payload.best, payload.earned)} 筹码`],
      ['累计跪求', `${payload.totalBegs} 次`],
    ];
    // 「回存」只在收工时出现：破产弹窗里本局还没结束，能带走多少是未知的。
    if (summary && payload.cashOut !== undefined) {
      rows.push(['回存钱包', `+${payload.cashOut} 筹码`]);
    }
    rows.push(['钱包', `${payload.wallet} 筹码`]);
    for (const [label, value] of rows) {
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      dd.textContent = value;
      this.ruinStats.append(dt, dd);
    }

    // 本地排行榜三列：赚进筹码 / 存活投数 / 跪求次数。
    const top = payload.runs.slice(0, 3);
    this.ruinBoard.textContent =
      top.length === 0
        ? ''
        : `本机排行榜：${top
            .map((run, index) => `${index + 1}. ${run.earned} 筹 · ${run.drops} 投 · ${run.begs} 跪`)
            .join('　')}`;

    this.begButton.hidden = summary;
    this.begButton.textContent = summary
      ? ''
      : `跪求 xixi 大王大赏（+${payload.grant} 筹码）`;
    this.el<HTMLButtonElement>('#quit-button').textContent = summary ? '再来一局' : '保留尊严，收工';
    this.ruinPanel.hidden = false;
  }

  hideRuin(): void {
    this.ruinPanel.hidden = true;
  }

  get ruinVisible(): boolean {
    return !this.ruinPanel.hidden;
  }

  /** 印记点亮：弹跳放大一次。 */
  private popMark(element: HTMLElement): void {
    if (this.reducedMotion) return;
    element.animate(
      [
        { transform: 'scale(1)' },
        { transform: 'scale(1.3)' },
        { transform: 'scale(1)' },
      ],
      { duration: 250, easing: 'ease-out' },
    );
  }

  /** 集齐三路：三点同闪，并把一枚「充能」滑向加力按钮。 */
  private playChannelComplete(): void {
    if (this.reducedMotion) return;
    this.marks.forEach((element, index) => {
      element.animate(
        [
          { boxShadow: '0 0 0 rgba(224,176,97,0)' },
          { boxShadow: '0 0 22px rgba(224,176,97,0.95)' },
          { boxShadow: '0 0 0 rgba(224,176,97,0)' },
        ],
        { duration: 520, delay: index * 60, easing: 'ease-out' },
      );
    });
    this.flyChip(this.channelMarks, this.boostButton, '加力就绪');
  }

  /**
   * 一枚小徽标从 A 飞向 B。
   *
   * 集齐三路与赏赐到账都用它——两处都是「刚刚发生了什么 → 下一步看哪里」，
   * 让玩家不用自己找。
   */
  private flyChip(from: HTMLElement, to: HTMLElement, label: string): void {
    if (this.reducedMotion) return;
    const start = from.getBoundingClientRect();
    const end = to.getBoundingClientRect();
    if (start.width === 0 && start.height === 0) return;
    if (end.width === 0 && end.height === 0) return;
    const chip = document.createElement('span');
    chip.className = 'fly-chip';
    chip.textContent = label;
    chip.style.left = `${start.left + start.width / 2}px`;
    chip.style.top = `${start.top + start.height / 2}px`;
    this.hud.append(chip);
    const dx = end.left + end.width / 2 - (start.left + start.width / 2);
    const dy = end.top + end.height / 2 - (start.top + start.height / 2);
    chip
      .animate(
        [
          { transform: 'translate(-50%, -50%) scale(0.6)', opacity: 0 },
          { transform: 'translate(-50%, -50%) scale(1)', opacity: 1, offset: 0.2 },
          {
            transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(0.55)`,
            opacity: 0,
          },
        ],
        { duration: 620, easing: 'cubic-bezier(0.3, 0.1, 0.5, 1)' },
      )
      .finished.then(
        () => chip.remove(),
        () => chip.remove(),
      );
  }

  /**
   * 越线返值：从币的屏幕位置飘一个「+N」。
   * 坐标由 Game 投影世界坐标得到——飞字必须从**真的越线位置**起飞。
   */
  flyScore(x: number, y: number, value: number): void {
    if (this.reducedMotion) return;
    const chip = document.createElement('span');
    chip.className = 'fly-score';
    chip.textContent = `+${value}`;
    chip.style.left = `${x}px`;
    chip.style.top = `${y}px`;
    this.hud.append(chip);
    chip.animate(
      [
        { transform: 'translate(-50%, -50%) scale(0.85)', opacity: 0 },
        { transform: 'translate(-50%, -50%) scale(1.05)', opacity: 1, offset: 0.25 },
        { transform: 'translate(-50%, -50%) scale(0.7) translateY(-48px)', opacity: 0 },
      ],
      { duration: 420, easing: 'cubic-bezier(0.4, 0.1, 0.6, 1)' },
    ).finished.then(
      () => chip.remove(),
      () => chip.remove(),
    );
  }

  update(
    snapshot: RunSnapshot,
    config: EndlessConfig,
    best: number,
    mechanisms: MechanismSnapshot = { sweeper: 0, grapple: 0, reload: 0, wheel: 0 },
    bet: BetTier = { chips: 1, mul: 1, label: '1 投 · ×1' },
    wallet = 0,
    /** XIXI 四槽亮灭（Game 持有，跨局持续；P5 起不再挂在 RunState 快照上）。 */
    xixi: boolean[] = [false, false, false, false],
  ): void {
    this.levelLabel.textContent = config.name;
    // 三个数字分工明确，不能混：赚进 = 本局成绩，最高 = 历史成绩，筹码 = 现在能花多少。
    this.earnedValue.textContent = String(snapshot.earned);
    this.bestValue.textContent = String(Math.max(best, snapshot.earned));
    this.walletValue.textContent = String(wallet);
    this.creditsValue.textContent = String(snapshot.chips);

    this.marks.forEach((element, index) => {
      const lit = xixi[index] === true;
      if (lit && this.lastMarks[index] !== true) this.popMark(element);
      this.lastMarks[index] = lit;
      element.classList.toggle('lit', lit);
      element.setAttribute('aria-label', `XIXI 第 ${index + 1} 槽（${XIXI_GLYPHS[index]}）${lit ? '已点亮' : '未点亮'}`);
    });
    // 加力进账（老虎机「力力力」）：四点同闪并把一枚「充能」滑向加力按钮，
    // 把「摇中了」直接导向下一步该按哪个键。
    if (snapshot.boostCharges > this.lastBoostCharges) this.playChannelComplete();
    this.lastBoostCharges = snapshot.boostCharges;
    this.markNote.textContent =
      snapshot.boostCharges > 0 ? '加力已就绪，随时可用' : '投币点亮 XIXI 四槽，集齐摇老虎机';

    // 加力未充能时**隐藏**，而不是置灰——没充能时这个按钮不该占位置。
    const boostReady =
      snapshot.boostEnabled && snapshot.boostCharges > 0 && snapshot.phase !== 'settled';
    this.boostButton.disabled = !boostReady;
    this.boostButton.hidden = !boostReady;
    this.boostState.textContent =
      snapshot.boostCharges > 0 ? `就绪 ×${snapshot.boostCharges}` : `未充能 · 剩 ${snapshot.boostUsesLeft} 次`;

    const canDrop = (snapshot.phase === 'ready' || snapshot.phase === 'playing') && snapshot.chips > 0;
    this.dropButton.disabled = !canDrop;
    this.dropState.textContent = canDrop ? '普通铜币' : '筹码见底，等沉降';

    // 机关：每个都有明确的可用条件。不可用时**置灰**而不是隐藏——玩家得知道它存在。
    const settled = snapshot.phase === 'drainOut' && snapshot.plateStopped;
    const holdingBoost = snapshot.boostCharges > 0 && snapshot.boostUsesLeft > 0;
    // 扫板与加力互斥：同一次收尾只能选一个，否则扫板会变成无脑必点。
    const canSweep = settled && !holdingBoost;
    this.sweeperButton.disabled = !canSweep || mechanisms.sweeper <= 0;
    this.sweeperState.textContent =
      mechanisms.sweeper <= 0
        ? '本局已用完'
        : canSweep
          ? '把贴线的币推过去'
          : holdingBoost
            ? '先决定加力'
            : '收尾停板后可用';

    const canGrapple = snapshot.phase === 'playing' && snapshot.chips >= MECHANISM_COST.grapple;
    this.grappleButton.disabled = !canGrapple || mechanisms.grapple <= 0;
    this.grappleState.textContent =
      mechanisms.grapple <= 0
        ? '本局已用完'
        : `剩 ${mechanisms.grapple} 次 · 花 ${MECHANISM_COST.grapple} 筹码`;

    const canReload =
      (snapshot.phase === 'ready' || snapshot.phase === 'playing') && snapshot.chips >= MECHANISM_COST.reload;
    this.reloadButton.disabled = !canReload;
    this.reloadState.textContent = `花 ${MECHANISM_COST.reload} 筹码 · 注入 3 枚`;

    this.betButton.disabled = snapshot.phase === 'settled';
    this.betState.textContent = bet.label;

    const canWheel = snapshot.phase === 'drainOut' && snapshot.chips > 0;
    this.wheelButton.disabled = !canWheel || mechanisms.wheel <= 0;
    this.wheelState.textContent =
      mechanisms.wheel <= 0 ? '本局已用完' : `押 ${snapshot.chips} 筹码 · 收尾可用`;
  }

  /**
   * 把集章圆点贴到币床上缘。
   *
   * 位置由 Game 把世界坐标投影到屏幕像素后传进来——百分比定位在竖屏与横屏下
   * 会漂到别的地方去，贴在台面上必须是「真的贴着台面」。
   */
  setMarksAnchor(topPx: number): void {
    this.channelMarks.style.top = `${Math.round(topPx)}px`;
  }

  setStatus(text: string): void {
    this.statusLine.textContent = text;
  }

  /** 越线入账：本局赚进那一位数字弹一下，并把这次入账记在 data 上供测试读取。 */
  flashScore(value: number): void {
    this.earnedValue.classList.remove('bump');
    void this.earnedValue.offsetWidth;
    this.earnedValue.classList.add('bump');
    this.earnedValue.dataset.lastGain = `+${value}`;
  }

  showCombo(count: number, label: string): void {
    if (count < 3 || count === this.lastComboShown) return;
    this.lastComboShown = count;
    const text = count === 3 ? '三连落' : count === 5 ? '五连落' : `${count} 连落`;
    this.comboToast.textContent = `${text} · ${label}`;
    this.comboToast.animate(
      [
        { opacity: 0, transform: 'translateY(10px)' },
        { opacity: 1, transform: 'translateY(0)' },
        { opacity: 1, transform: 'translateY(0)' },
        { opacity: 0, transform: 'translateY(-10px)' },
      ],
      { duration: 1100, easing: 'ease-out' },
    );
  }

  resetCombo(): void {
    this.lastComboShown = 0;
  }

  showPause(paused: boolean): void {
    this.pausePanel.hidden = !paused;
    this.pauseButton.textContent = paused ? '继续' : '暂停';
  }

  /** 收尾时仍持有加力：提示玩家使用或放弃，不静默清空。 */
  showDrainPrompt(visible: boolean): void {
    this.drainPrompt.hidden = !visible;
  }

  /** 高潮反馈：屏幕边缘一次性闪一下，金色给高分币/连落，绿色给返币。 */
  flashClimax(kind: 'gold' | 'green'): void {
    const element = this.climaxFlash;
    element.classList.remove('gold', 'green');
    void element.offsetWidth;
    element.classList.add(kind);
  }

  private el<T extends HTMLElement = HTMLElement>(selector: string): T {
    const element = document.querySelector<T>(selector);
    if (!element) throw new Error(`缺少 HUD 元素: ${selector}`);
    return element;
  }
}
