import type { EndlessConfig } from '../game/endless';
import type { BetTier } from '../game/economy';
import type { ClimaxTone } from '../game/kinds';
import type { FlyTier } from '../game/feedback';
import { MECHANISM_COST, MECHANISM_USES } from './Mechanisms';
import { createPixelTextSurface } from '../render/pixelText';
import type { RunSnapshot } from './RunState';
import { closingLine, tauntFor } from './Taunts';

export type MechanismSnapshot = {
  sweeper: number;
  grapple: number;
  reload: number;
};

/** 破产弹窗 / 本局结算卡片的内容。 */
export type RuinPayload = {
  /** 本局越线赚进的筹码（不含跪求赏赐）。 */
  earned: number;
  /**
   * 结算瞬间的余额。★ S4：它与 `balance` 是**同一个数**（合并账户之后没有「桌上的」与
   * 「钱包里的」之分了），保留两个字段只因为卡片要分别印「本局赚进/当前余额」与「峰值」，
   * 而 `chipsPeak` 是历史峰值、与余额不同源。
   */
  chips: number;
  /**
   * 当前余额。
   * ★ S4：`cashOut`（可回存额）这个字段**随「回存」这个动作一起删除** ——
   *   钱从头到尾都在同一个账户里，没有"能带走多少"这回事了。
   */
  balance: number;
  drops: number;
  chipsPeak: number;
  begs: number;
  totalBegs: number;
  best: number;
  runs: Array<{ earned: number; drops: number; begs: number }>;
  grant: number;
  /** true 表示这是「保留尊严，收工」后的总结，不再显示跪求按钮。 */
  summary?: boolean;
  /**
   * 贷款续玩的一笔报价（S3）。**缺省 = 不给贷款**（结算卡片就走这条：本局已经结束，
   * 借钱没有对象）。刻意传数据而不是加一个 `payload.mode` ——
   * 行级 gating 沿用上面 `summary` 的既有形状，不发明第二套分支轴。
   */
  loan?: { amount: number; available: boolean; debt: number; ceiling: number };
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
  private readonly creditsValue = this.el('#credits-value');
  private readonly statusLine = this.el('#status-line');
  private readonly comboToast = this.el('#combo-toast');
  private readonly markNote = this.el('#mark-note');
  private readonly debtLine = this.el('#debt-line');
  private readonly debtNote = this.el('#debt-note');
  /**
   * XIXI 集章的容器。
   *
   * ⚠️ **四槽的亮灭不在这里画。** 它们已经内嵌进 3D 模型（推板前缘的四段标牌，
   * 见 `Pusher.buildXixiLanes`），HUD 只负责一行进度文字。
   * 早先这里还有四个 DOM 圆点，与 3D 标牌叠在同一处屏幕上，两套同样的东西互相打架。
   */
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
  private readonly betButton = this.el<HTMLButtonElement>('#bet-button');
  private readonly betState = this.el('#bet-state');
  private readonly ruinPanel = this.el('#ruin-panel');
  private readonly ruinTitle = this.el('#ruin-title');
  private readonly ruinTaunt = this.el('#ruin-taunt');
  private readonly ruinStats = this.el('#ruin-stats');
  private readonly ruinBoard = this.el('#ruin-board');
  private readonly begButton = this.el<HTMLButtonElement>('#beg-button');
  private readonly loanButton = this.el<HTMLButtonElement>('#loan-button');

  private lastComboShown = 0;
  private lastBoostCharges = 0;
  /**
   * XIXI `aria-label` 的签名。四槽亮灭没变就不必重建那串 `X已亮 I未亮 …` ——
   * 它在每帧路径上做一次 `map` + `join`，而四槽平均几秒才变一次。
   */
  private lastXixiSignature = -1;
  /** 后装填的提示只跟配置走、不跟帧走 ⇒ 算一次，别每帧拼同一个模板。 */
  private readonly reloadHint = `花 ${MECHANISM_COST.reload} 筹码 · 注入 3 枚`;

  constructor() {
    this.mountNameplates();
  }

  /**
   * 铭牌（Stage 3b 的最后一格）：机关行每颗按钮的名字改走 `pixelText` 的**像素字**。
   *
   * 之前 HUD 是"像素机柜 + 抗锯齿正文"两种语言并排 —— 用户红框里"太简陋"的一半来源。
   * ★ 三个数都**从 DOM 现读**，不在这里抄第二份：
   *   文案 = `span.textContent`（`index.html` 是唯一真源，读屏也读它），
   *   颜色 = computed `color`（面板配色一改，铭牌自己跟上）。
   * ⚠️ DOM 那段文本**不删**，只收进 `.pixel-hidden`（画布里的字机器读不到，
   *   删掉等于把无障碍与"判据能读到字"一起丢）—— 这是 G-铭牌 第三条断言在守的东西。
   * ⚠️ 只在构造时挂一次：这些名字一局内不变，而 `update()` 每帧被调，
   *   不能让它每帧碰画布（同 `setLights` 的"变了才写"是同一条纪律）。
   */
  private mountNameplates(): void {
    const SCALE = 3;
    /** 小画布上的字号与格宽：整数倍放大后 = 27px 高、字与字 27px 宽，与按钮铭牌的尺寸吻合。 */
    const FONT_PX = 9;
    const CELL_PX = 9;
    for (const button of [...document.querySelectorAll('#mechanism-row button')]) {
      const name = button.querySelector('span');
      const text = name?.textContent?.trim() ?? '';
      if (!name || text.length === 0) continue;
      const surface = createPixelTextSurface({
        width: text.length * CELL_PX * SCALE,
        height: (FONT_PX + 2) * SCALE,
        scale: SCALE,
      });
      surface.canvas.className = 'nameplate';
      surface.canvas.setAttribute('aria-hidden', 'true');
      surface.draw({ text, fontPx: FONT_PX, fill: getComputedStyle(name).color });
      name.classList.add('pixel-hidden');
      button.insertBefore(surface.canvas, name);
    }
  }

  /**
   * 文本真的变了才写 DOM（沿用本文件既有的 `lastComboShown` / `lastBoostCharges` 脏检查范式）。
   *
   * `update()` 每帧被调用，而这些字符串在绝大多数帧里逐字不变；值仍然**全部**从传进来的
   * snapshot 现算 ⇒ 这不是"界面自己存了一份状态"的第二真源，只是省掉重复的 set。
   * ⚠️ 故意**不节流**：读 DOM 文本的判据（`save-migration.spec.ts:281-282`、
   *    `verify-game.mjs` 的 accept ① —— 它现读 `#credits-value` 的文本，行号会漂所以按门名指）
   *    要求"这一帧的值这一帧就能读到"。
   */
  private setText(node: { textContent: string | null }, text: string): void {
    if (node.textContent === text) return;
    node.textContent = text;
  }

  /**
   * 计数灯：把"还剩几次"画成一排亮点（Stage 3b），后面可以跟一句短语。
   *
   * ★ 只在**变化时**重建 DOM：这个方法每帧都被 `publishHud` 调到，
   *   照 `setText` 的"变了才写"同一条纪律，用 `dataset.lights` 当指纹。
   *   不这么做的话每帧 `replaceChildren` 会让按钮里的节点一直换身份，
   *   hover/focus 与将来的动画都会被抽走。
   */
  private setLights(
    node: HTMLElement | null,
    count: number,
    caption = '',
    cap = MECHANISM_USES.grapple,
  ): void {
    if (!node) return;
    const lit = Math.max(0, Math.floor(count));
    // 总位数取 `max(表的上限, 当前剩余)`：「机关充能」这类构筑奖励可以把次数**加到超过开局档位**，
    // 固定按表画就会少报（G-计数灯 就是这么抓到"亮 2 / 引擎 3"的 —— 灯少亮一盏是说谎的显示，
    // 不是可以接受的近似）。
    const total = Math.max(cap, lit);
    if (node.dataset.lights === `${lit}/${total}/${caption}`) return;
    node.dataset.lights = `${lit}/${total}/${caption}`;
    const children: Array<HTMLElement> = [];
    for (let i = 0; i < total; i += 1) {
      const light = document.createElement('i');
      light.className = i < lit ? 'light light-on' : 'light';
      children.push(light);
    }
    if (caption) {
      const label = document.createElement('span');
      label.className = 'light-caption';
      label.textContent = caption;
      children.push(label);
    }
    node.replaceChildren(...children);
  }

  private setAttribute(
    node: {
      getAttribute(qualifiedName: string): string | null;
      setAttribute(qualifiedName: string, value: string): void;
    },
    name: string,
    value: string,
  ): void {
    if (node.getAttribute(name) === value) return;
    node.setAttribute(name, value);
  }

  bindPauseToggle(handler: () => void): void {
    const toggle = (event: Event) => {
      event.preventDefault();
      handler();
    };
    this.pauseButton.addEventListener('click', toggle);
    this.el('#resume-button').addEventListener('click', toggle);
  }

  /**
   * 画质锁按钮（暂停面板里）。放在暂停面板而不是常驻 HUD：
   * 它是一次性决定，不是要占住游玩时的视线；而且用户发现画面变了的时候，
   * 手边正好就是那个面板。
   */
  bindQualityToggle(handler: () => void): void {
    this.el('#quality-lock-button').addEventListener('click', (event) => {
      event.preventDefault();
      handler();
    });
  }

  /** 按钮文案 = 玩家唯一能读到的状态，所以 `aria-pressed` 要一起写（读屏与判据都读它）。 */
  setQualityLock(locked: boolean, tier: string): void {
    const button = this.el<HTMLElement>('#quality-lock-button');
    button.textContent = locked
      ? `画质：已锁定（${tier}）`
      : `画质：自动（当前 ${tier}）`;
    button.setAttribute('aria-pressed', String(locked));
  }

  /** 动效降级开关：读的是 <html data-motion>，与 CSS 同源。 */
  private get reducedMotion(): boolean {
    return document.documentElement.dataset.motion === 'reduced';
  }

  bindRuinActions(onBeg: () => void, onQuit: () => void, onLoan: () => void): void {
    this.begButton.addEventListener('click', (event) => {
      event.preventDefault();
      onBeg();
    });
    this.el<HTMLButtonElement>('#loan-button').addEventListener('click', (event) => {
      event.preventDefault();
      onLoan();
    });
    this.el('#quit-button').addEventListener('click', (event) => {
      event.preventDefault();
      onQuit();
    });
  }

  /**
   * 触底报价面板 / 本局结算卡片。
   *
   * ★ S3 去局感：非总结态的标题从「破产」改成**「续玩报价」**——
   * 触底不再是终点，而是「用哪种方式继续」的岔口。面板里现在有三个真选择，
   * 按代价从轻到重排（DOM 顺序就是玩家看到的按钮顺序）：
   *   贷款（`#loan-button`：借钱进余额接着打，**盘面一动不动**）、
   *   跪求（`#beg-button`：脏钱——能继续玩但不能换永久进度，也保留盘面）、
   *   收工（`#quit-button`：清空盘面；★ S4 之后**不动余额**，钱本来就在同一个账户里）。
   *
   * ⚠️ 标题是**文案**，而本项目的纪律是「按文案断言 ⇒ 改一次措辞判据就假红」
   * （见 `setStatus` 上那段 `data-kind` 的说明）。所以本次**同步改了**
   * `visual.spec` 里那条按文案断言的闭环用例，而不是留着它红。
   * 反过来，DOM id（`#ruin-panel` / `#ruin-title` / `#ruin-taunt`）**刻意不改名**：
   * `endless.ruinVisible` 与一大片判据都挂在这些名字上，改一次名等于第二次爆炸。
   */
  showRuin(payload: RuinPayload): void {
    const summary = payload.summary === true;
    this.ruinTitle.textContent = summary ? '本局结束' : '续玩报价';
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
    // ★ S4：原来这里有一行「回存钱包 +N」（且只在总结态出现）。
    //   「回存」这个动作已随合并账户消失 ⇒ 整行删掉，不是改成显示 0。
    rows.push(['余额', `${payload.balance} 筹码`]);
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
    // 贷款按钮的显隐走**行级 gating**（与 `summary`、`回存钱包` 那几行同一形状）：
    // 到欠款上限时 `available=false` ⇒ **藏掉而不是留着可点**，
    // 留着会让人点了什么都没发生，那正是本项目最讨厌的静默失败。
    this.loanButton.hidden = summary || payload.loan?.available !== true;
    // ★ 只在**真的能贷**的时候写文案：到上限时 `amount` 是 0，
    // 于是隐藏状态下会留着一句「贷款续玩 +0 筹码」——按钮虽然看不见，
    // 但无障碍树与任何读 textContent 的判据都会读到这句假话。
    if (payload.loan?.available && !summary) {
      this.loanButton.textContent =
        `贷款续玩 +${payload.loan.amount} 筹码（欠款 ${payload.loan.debt} → ` +
        `${payload.loan.debt + payload.loan.amount}/${payload.loan.ceiling}）`;
    } else {
      this.loanButton.textContent = '';
    }
    this.el<HTMLButtonElement>('#quit-button').textContent = summary ? '再来一局' : '保留尊严，收工';
    this.ruinPanel.hidden = false;
  }

  hideRuin(): void {
    this.ruinPanel.hidden = true;
  }

  get ruinVisible(): boolean {
    return !this.ruinPanel.hidden;
  }

  /**
   * 集齐四槽：整条提示闪一下，并把一枚「充能」滑向加力按钮。
   *
   * 闪的是容器而不是四个圆点 —— 圆点已经搬进 3D 模型了（见 `channelMarks` 的说明），
   * 这里只保留「集齐了」这个瞬时反馈。
   */
  private playChannelComplete(): void {
    if (this.reducedMotion) return;
    this.channelMarks.animate(
      [
        { boxShadow: '0 0 0 rgba(224,176,97,0)' },
        { boxShadow: '0 0 22px rgba(224,176,97,0.95)' },
        { boxShadow: '0 0 0 rgba(224,176,97,0)' },
      ],
      { duration: 520, easing: 'ease-out' },
    );
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
   *
   * `tier` 由 `Game` 用 `flyTier()`（`feedback.ts` 的单一真源）算好传进来，
   * 所以「哪个数是大号」只有一份定义；这里只负责画。
   * 同时把档位写进 `#hud[data-last-fly-tier]`：飞字 420 毫秒后就自毁了，
   * 判据去 DOM 里抓它是**时序赌博**，读这个持久属性才是稳的。
   */
  flyScore(x: number, y: number, value: number, tier: FlyTier = 'normal'): void {
    this.hud.dataset.lastFlyTier = tier;
    this.hud.dataset.lastFlyValue = String(value);
    if (this.reducedMotion) return;
    const chip = document.createElement('span');
    chip.className = tier === 'big' ? 'fly-score big' : 'fly-score';
    chip.dataset.tier = tier;
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
      { duration: tier === 'big' ? 560 : 420, easing: 'cubic-bezier(0.4, 0.1, 0.6, 1)' },
    ).finished.then(
      () => chip.remove(),
      () => chip.remove(),
    );
  }

  update(
    snapshot: RunSnapshot,
    config: EndlessConfig,
    best: number,
    mechanisms: MechanismSnapshot = { sweeper: 0, grapple: 0, reload: 0 },
    bet: BetTier = { chips: 1, mul: 1, label: '1 投 · ×1' },
    /** XIXI 四槽亮灭（Game 持有，跨局持续；P5 起不再挂在 RunState 快照上）。 */
    xixi: boolean[] = [false, false, false, false],
  ): void {
    this.setText(this.levelLabel, config.name);
    // ★ S4 合并账户：这里原来有两个数 —— `walletValue`（钱包）与 `creditsValue`（局内筹码），
    //   分别读 `save.wallet` 与 `snapshot.chips`，中间靠「买入/回存」两笔转账来回搬。
    //   合并之后两者是同一个数 ⇒ **只剩一个读数**（参数 `wallet` 也一并删掉：
    //   留着一个永远等于另一个的入参，就是留给下一个人的歧义源）。
    //   现在显示的三个数分工仍然互不重叠：赚进 = 本段成绩，最高 = 历史成绩，余额 = 现在有多少钱。
    this.setText(this.earnedValue, String(snapshot.earned));
    this.setText(this.bestValue, String(Math.max(best, snapshot.earned)));
    this.setText(this.creditsValue, String(snapshot.chips));

    // XIXI 进度只出一行文字：四槽的亮灭**画在 3D 模型里**（推板前缘的四段标牌），
    // 这里不再重复画一遍圆点。进度仍按 `xixi` 数，与 3D 标牌同源。
    // 一次位运算同时拿到"亮了几槽"和"哪几槽亮"，顺便当签名用：
    // 原写法每帧要做 `filter` + `map().join()` 两次数组分配，而四槽平均几秒才变一次。
    let bits = 0;
    let litCount = 0;
    for (let index = 0; index < xixi.length; index += 1) {
      if (xixi[index]) {
        bits |= 1 << index;
        litCount += 1;
      }
    }
    this.setText(this.markNote, `XIXI 集章 ${litCount}/${xixi.length} · 投币点亮四槽，集齐摇老虎机`);
    // 签名没变 ⇒ 那串 `X已亮 I未亮 …` 不必重建（`setAttribute` 自己也会再比一次）。
    if (bits !== this.lastXixiSignature) {
      this.lastXixiSignature = bits;
      this.setAttribute(
        this.channelMarks,
        'aria-label',
        `XIXI 集章 ${litCount}/${xixi.length}（${xixi
          .map((lit, index) => `${XIXI_GLYPHS[index]}${lit ? '已亮' : '未亮'}`)
          .join(' ')}）`,
      );
    }
    // 加力进账（老虎机「力力力」）：整条提示闪一下并把一枚「充能」滑向加力按钮，
    // 把「摇中了」直接导向下一步该按哪个键。
    if (snapshot.boostCharges > this.lastBoostCharges) this.playChannelComplete();
    this.lastBoostCharges = snapshot.boostCharges;
    // 加力就绪时**顶掉**进度文字：此刻玩家该做的事从「继续集章」变成了「用加力」，
    // 两句话挤在同一行只会都读不清。上面的进度已写进 `aria-label`，信息没丢。
    if (snapshot.boostCharges > 0) this.setText(this.markNote, '加力已就绪，随时可用');

    // 加力未充能时**隐藏**，而不是置灰——没充能时这个按钮不该占位置。
    const boostReady =
      snapshot.boostEnabled && snapshot.boostCharges > 0 && snapshot.phase !== 'settled';
    this.boostButton.disabled = !boostReady;
    this.boostButton.hidden = !boostReady;
    this.setText(
      this.boostState,
      snapshot.boostCharges > 0 ? `就绪 ×${snapshot.boostCharges}` : `未充能 · 剩 ${snapshot.boostUsesLeft} 次`,
    );

    const canDrop = (snapshot.phase === 'ready' || snapshot.phase === 'playing') && snapshot.chips > 0;
    this.dropButton.disabled = !canDrop;
    this.setText(this.dropState, canDrop ? '普通铜币' : '筹码见底，等沉降');

    // 机关：每个都有明确的可用条件。不可用时**置灰**而不是隐藏——玩家得知道它存在。
    const settled = snapshot.phase === 'drainOut' && snapshot.plateStopped;
    const holdingBoost = snapshot.boostCharges > 0 && snapshot.boostUsesLeft > 0;
    // 扫板与加力互斥：同一次收尾只能选一个，否则扫板会变成无脑必点。
    const canSweep = settled && !holdingBoost;
    this.sweeperButton.disabled = !canSweep || mechanisms.sweeper <= 0;
    this.setText(
      this.sweeperState,
      mechanisms.sweeper <= 0
        ? '本局已用完'
        : canSweep
          ? '把贴线的币推过去'
          : holdingBoost
            ? '先决定加力'
            : '收尾停板后可用',
    );

    const canGrapple = snapshot.phase === 'playing' && snapshot.chips >= MECHANISM_COST.grapple;
    this.grappleButton.disabled = !canGrapple || mechanisms.grapple <= 0;
    // Stage 3b：**计数灯**而不是"剩 2 次 · 花 2 筹码"那行 0.6rem 小字。
    // 灯的个数本身就是信息（不用读字），它也顺手满足了 G-字号 那条"可见文本 ≥ 11px"——
    // 小字要么放大到占位、要么删掉，灯是第三条路。买不起时后面跟一句话说明原因，
    // 因为"为什么不亮"不能只靠灯的颜色猜。
    this.setLights(this.grappleState, mechanisms.grapple, `花 ${MECHANISM_COST.grapple} 筹码`);

    const canReload =
      (snapshot.phase === 'ready' || snapshot.phase === 'playing') && snapshot.chips >= MECHANISM_COST.reload;
    this.reloadButton.disabled = !canReload;
    this.setText(this.reloadState, this.reloadHint);

    this.betButton.disabled = snapshot.phase === 'settled';
    this.setText(this.betState, bet.label);
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

  /**
   * 状态行。
   *
   * `kind` 会写到 `#status-line` 的 `data-kind` 上，**这是给判据用的**：
   * 「自动补币有没有给玩家反馈」如果靠匹配文案来判，改一次措辞判据就假红
   * ——那等于在测试里维护第二份文案。读 `data-kind` 问的是「这句话是谁说的」，
   * 与措辞无关。默认 `'info'`：任何后来的状态都会把它覆盖回去，这正是期望行为。
   */
  setStatus(text: string, kind = 'info'): void {
    this.statusLine.textContent = text;
    this.statusLine.dataset.kind = kind;
  }

  /**
   * 欠款一行小字（S2）。无债就整条隐藏 —— 「零」也要占一行会把玩家的注意力
   * 花在一条没有信息的话上。
   *
   * ★ 这里只**显示**，不持有数值：`debt` 的真源是 `SaveStore`，
   * 在 HUD 里存一份就是本项目反复清的那种第二份真源。
   */
  setDebt(debt: number, ceiling: number): void {
    if (!this.debtLine || !this.debtNote) return;
    if (debt <= 0) {
      this.debtLine.hidden = true;
      this.debtNote.textContent = '';
      return;
    }
    this.debtLine.hidden = false;
    this.debtNote.textContent = `欠款 ${debt} / ${ceiling} 筹码 · 产出会按比例自动抵债`;
  }

  /**
   * 自动补币的 HUD 反馈（P10 ⑦）。
   *
   * 独立成方法而不是就地拼一句 `setStatus(...)`，是为了让「补币有反馈」成为
   * **可判据的事实**：验证脚本读 `#status-line[data-kind="refill"]`，
   * 而不是去匹配「庄家补货」这四个字。
   */
  showRefill(bedCoins: number, promised: number, downgraded: boolean): void {
    this.setStatus(
      `台面见底（${bedCoins} 枚）：庄家补货 ${promised} 枚` +
        (downgraded ? '（余量不足，按实有交付）' : ''),
      'refill',
    );
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

  /**
   * 高潮反馈：屏幕边缘一次性闪一下，金色给高分币/连落，绿色给返币，
   * 白色给「连落 5 次」（与币种无关的那一档）。
   *
   * ★ `classList.remove(...)` 的名单必须与 `ClimaxTone`（`kinds.ts`）逐项一致：
   * 漏掉一个，上一个色调的 class 会赖在元素上——零报错的静默错
   * （下一次闪的其实是上一个颜色，因为 CSS 里两个动画规则同时命中，
   * 后定义的那条赢）。
   */
  flashClimax(tone: ClimaxTone): void {
    const element = this.climaxFlash;
    element.classList.remove('gold', 'green', 'blue', 'white');
    void element.offsetWidth;
    element.classList.add(tone);
  }

  private el<T extends HTMLElement = HTMLElement>(selector: string): T {
    const element = document.querySelector<T>(selector);
    if (!element) throw new Error(`缺少 HUD 元素: ${selector}`);
    return element;
  }
}
