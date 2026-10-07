import { EFFECT_POOL, EFFECT_SPECS, COIN_EFFECT_SPECS, type CoinEffectId, type EffectId } from '../game/effects';
import { DRAFT_COST, waveTarget } from '../game/waves';
import { fineRatio, type FineQuote } from '../game/xixi';
import { createPixelTextSurface, type PixelTextSurface } from '../render/pixelText';
import type { MechanismId } from './Mechanisms';
import type { RunState } from './RunState';
import type { Mechanisms } from './Mechanisms';

/** 一次币种效果的结算记录（Stage 2d 的归因对账吃的是**逐事件**，不是总数）。 */
export type CoinEffectEvent = {
  id: CoinEffectId;
  /** 该扣多少（比例制算出来的名义额）。 */
  requested: number;
  applied: number;
  debtAdded: number;
  /**
   * 算 `requested` 时用的余额 —— 与老虎机那条罚款事件同一条理由：
   * 不带输入的话，判据只能退化成区间；带上它就能做逐事件恒等
   * `requested === round(balance × fineRatio(progress))`。
   */
  balance: number;
  progress: number;
  t: number;
};

/** 面板上一张候选的显示数据（`label` / `glyph` / `note` 全部来自 `effects.ts`，这里不重写文案）。 */
export type DraftChoice = { id: EffectId; label: string; glyph: string; note: string; cost: number };

export type CoinEffectsDeps = {
  run: () => RunState;
  mechanisms: () => Mechanisms;
  /** 抽候选用的 RNG：走游戏那颗种子，同一个种子要能复现同一组三选一。 */
  rng: () => number;
  /** HUD 归因文案（Stage 2d 的"触发计数 === 归因计数"就靠它，不另开一条通道）。 */
  notify: (message: string) => void;
  /** 选完/刷新之后推一次 HUD：票券与波次的读数都挂在 HUD 上。 */
  refresh: () => void;
  /** 罚款的比例表取值口（唯一真源在 `xixi.ts`，这里只把两个输入拿来）。 */
  fineQuote: () => FineQuote;
  /** 一次扣款的完整结算（实扣 + shortfall 转欠款），与老虎机罚款**同一条出口**。 */
  settleFine: (amount: number) => { applied: number; shortfall: number; debtAdded: number };
  now: () => number;
  root: ParentNode;
};

/**
 * 波间三选一（1c）+ 构筑奖励的落地编排（Stage 2 的表在 `game/effects.ts`）。
 *
 * ## 为什么单独一个系统
 *
 * `Game.ts` 只允许减少（计划 0d）。这里带着一整块 DOM 与四条 apply 分支，
 * 塞进 Game 就是又一次"什么都在那个文件里"。先例是 `CollectionPanel`：
 * 自己拿元素、自己听点击、只通过 deps 与游戏对话。
 *
 * ## 刻意**不暂停**仿真
 *
 * 破产窗（`#ruin-panel`）也不暂停 —— 沉降照常走。三选一要是暂停了游戏，
 * 就要新开一条"谁按了暂停"的状态机，而 `run.phase` 里并没有这个位置；
 * 更要紧的是：暂停会让 `probe` / `economy` 那批以循环计时的判据看到一段没有推板的空白。
 * 表现上的代价是"挑卡时盘面还在动"，这与这台机器的整体读感一致（一边掉币一边决定下一步）。
 *
 * ## 票券不够怎么办
 *
 * **不发明第三种状态**：按钮全部禁用、面板赖着不走，直到玩家把票券挣够或这一局沉降。
 * 半途"免费送一张"会让 `ticketSpent === draftCost × draftsTaken` 这条恒等式失去意义。
 */
export class CoinEffects {
  private readonly panel: HTMLElement | null;
  private readonly choices: HTMLElement | null;
  private readonly meta: HTMLElement | null;
  private current: DraftChoice[] = [];
  visible = false;
  /** 币种效果：触发过几次（只增）。 */
  private triggers = 0;
  /** 其中留下 HUD 归因的有几条 —— 与 `triggers` 相等才说明"发生了且看得见"。 */
  private attributed = 0;
  private coinEffectEvents: CoinEffectEvent[] = [];
  /** 每张候选的像素徽章面（Stage 3b 的 pixelText 消费者；面板关掉后会被 dispose）。 */
  private badges: PixelTextSurface[] = [];
  /** 催债币注入：尝试次数与其中真正拿到池位次数的读数（缺席要能归因）。 */
  hazardAttempts = 0;
  hazardSpawned = 0;

  constructor(private readonly deps: CoinEffectsDeps) {
    this.panel = (deps.root.querySelector('#draft-panel') as HTMLElement | null) ?? null;
    this.choices = (deps.root.querySelector('#draft-choices') as HTMLElement | null) ?? null;
    this.meta = (deps.root.querySelector('#draft-meta') as HTMLElement | null) ?? null;
    // 面板存在与否不该决定游戏能不能跑（模型模式 / 截图模式可能没有这块 DOM）。
    // ⚠️ 拿不到元素时 `visible` 永远 false ⇒ `tick()` 会每帧重试渲染，所以有下面那个哨兵。
    this.missingDom = this.panel === null || this.choices === null;
  }

  private readonly missingDom: boolean;

  /** 每帧看一眼待办：`run.pendingDraft` 一立起来就把面板摆上（只摆一次，靠 `visible` 挡住重绘）。 */
  tick(): void {
    if (this.missingDom) return;
    if (!this.visible) {
      if (!this.deps.run().pendingDraft) return;
      this.open();
      return;
    }
    // 面板立着的时候玩家**还在玩**（这张面板不暂停仿真），票券数与波次会继续变。
    // 所以每帧只同步读数与可买状态，不重建按钮 —— 重建会把焦点与 hover 一起抹掉。
    this.sync();
  }

  /** 组一批候选并显示。抽法 = 洗牌后取前 `DRAFT_CHOICES` 个（池子 ≤ 3 时就是全摆出来）。 */
  private open(): void {
    this.current = this.draw();
    if (this.panel) this.panel.hidden = false;
    this.visible = true;
    this.render();
  }

  private draw(): DraftChoice[] {
    // 洗牌走游戏 RNG（可复现），并且**不动** EFFECT_POOL 本身 —— 那是导出的只读名单，
    // 判据按它互证"池里没有死项"，被洗过一次就再也不是那份名单了。
    const pool = [...EFFECT_POOL];
    for (let i = pool.length - 1; i > 0; i -= 1) {
      const j = Math.floor(this.deps.rng() * (i + 1));
      const swap = pool[i];
      pool[i] = pool[j];
      pool[j] = swap;
    }
    return pool.slice(0, 3).map((id) => ({
      id,
      label: EFFECT_SPECS[id].label,
      glyph: EFFECT_SPECS[id].glyph,
      note: EFFECT_SPECS[id].note,
      cost: DRAFT_COST,
    }));
  }

  private render(): void {
    if (!this.choices) return;
    this.choices.replaceChildren();
    this.badges.length = 0;
    this.current.forEach((choice, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.effect = choice.id;
      button.dataset.price = String(choice.cost);
      // 铭牌上的图案走**像素字**（Stage 3b：与招牌屏同一套"小画布 fillText + 整数倍放大"），
      // 名字与价格留作 DOM 文本 —— 无障碍树与判据都要能读到文字，全画布等于把信息藏进像素里。
      const badge = createPixelTextSurface({ width: 36, height: 36, scale: 3 });
      badge.canvas.className = 'draft-badge';
      badge.draw({ text: choice.glyph, fontPx: 11, fill: '#e0b061' });
      this.badges.push(badge);
      const label = document.createElement('span');
      label.textContent = `${choice.label} — ${choice.note}（${choice.cost} 券）`;
      button.append(badge.canvas, label);
      button.addEventListener('click', () => this.pick(index));
      this.choices?.appendChild(button);
    });
    this.sync();
  }

  /**
   * 同步读数与可买状态（每帧调用，见 `tick()`）。
   *
   * ⚠️ 这条不是装饰：面板不暂停仿真，"能不能买"是会随着玩家继续挣票券而**变回来**的。
   * 只在 open 时算一次的话，会留下一张写着旧价格的卡 —— 本项目对"画面与账不一致"
   * 的容忍度是零（同 `coinTexture` 那条"币面不许印面值"的理由）。
   */
  private sync(): void {
    const run = this.deps.run();
    if (this.meta) {
      this.meta.textContent =
        `第 ${run.wave} 波 · 本波 ${run.waveTickets}/${waveTarget(run.wave)} 券 · ` +
        `票券 ${run.tickets}（挣 ${run.ticketEarned} / 花 ${run.ticketSpent}）`;
    }
    for (const button of this.choices?.querySelectorAll('button') ?? []) {
      const index = [...(this.choices?.children ?? [])].indexOf(button);
      const choice = this.current[index];
      if (choice) button.disabled = run.tickets < choice.cost;
    }
  }

  /**
   * 选第 `index` 张。返回 false = 什么都没发生（票券不够 / 面板没立着）。
   *
   * ★ 顺序是**先付票再生效**：反过来会留一条"拿了奖励但票券没扣"的路，
   * 而那条路在 `tickets === earned − spent` 上表现为凭空多一笔汇。
   */
  pick(index: number): boolean {
    if (!this.visible) return false;
    const choice = this.current[index];
    if (!choice) return false;
    const run = this.deps.run();
    if (!run.spendTickets(choice.cost)) return false;
    this.apply(choice.id);
    run.advanceWave();
    this.close();
    this.deps.refresh();
    return true;
  }

  /** 兑现一张候选。每条分支都不往筹码账里加东西 —— 这是 `effects.ts` 文件头的硬约束。 */
  private apply(id: EffectId): void {
    const spec = EFFECT_SPECS[id];
    const run = this.deps.run();
    switch (spec.act) {
      case 'boost': {
        const strokes = spec.payload.strokes ?? 0;
        let granted = 0;
        for (let i = 0; i < strokes; i += 1) if (run.grantBoost()) granted += 1;
        this.deps.notify(
          granted > 0
            ? `波间奖励：${spec.label} ⇒ 加力 +${granted} 发${granted < strokes ? '（存满了，剩下的没处放）' : ''}`
            : `波间奖励：${spec.label} —— 加力已经存满，这 ${strokes} 发没处放`,
        );
        return;
      }
      case 'mechanism': {
        // reload 本来就是无限次，给它加次数是空操作 ⇒ 候选只在扫板/抓斗里挑。
        const pool: Exclude<MechanismId, 'reload'>[] = ['sweeper', 'grapple'];
        const id2 = pool[Math.floor(this.deps.rng() * pool.length)] ?? 'sweeper';
        const added = this.deps.mechanisms().grantUses(id2, 1);
        this.deps.notify(
          added > 0
            ? `波间奖励：${spec.label} ⇒ ${id2 === 'sweeper' ? '扫板' : '抓斗'} +${added} 次`
            : `波间奖励：${spec.label} —— 这次没能充上电`,
        );
        return;
      }
      case 'ticketInterval': {
        const applied = run.tightenTicketInterval(spec.payload.step ?? 0);
        this.deps.notify(
          applied > 0
            ? `波间奖励：${spec.label} ⇒ 越线每 ${run.ticketEvery} 枚发一张（本局生效，不跨局）`
            : `波间奖励：${spec.label} —— 间隔已经到下限 ${run.ticketEvery} 枚`,
        );
        return;
      }
    }
  }

  close(): void {
    if (this.panel) this.panel.hidden = true;
    this.visible = false;
    // 面板收起来就别留着三块画布占内存：下一次 open 会重建（候选本来也是新的）。
    for (const badge of this.badges) badge.dispose();
    this.badges = [];
  }

  /**
   * 币种效果结算（Stage 2）：一枚带 `payout.mode === 'effect'` 的币越线时调用。
   *
   * 分派链从 `Game.settleCrossing` 进来，**币种名单不在那里写**（`kinds.ts` 的
   * `payout.effect` 才是真源）——那正是 S16 之前"币种能干什么"散在分派处的老毛病。
   *
   * ★ 两条硬规矩：
   *   ① 出账只走 `settleFine`（唯一扣减口）⇒ 三账本恒等式不需要为新币种改一个字；
   *   ② 每次触发**必须**留一条 HUD 归因，并且 `triggers` 与 `attributed` 一起计数 ——
   *      两者相等是 Stage 2d 的判据内容，不相等就是"发生了而玩家看不见"。
   */
  dispatchCoin(effect: CoinEffectId): void {
    const spec = COIN_EFFECT_SPECS[effect];
    this.triggers += 1;
    if (spec.act !== 'fine') {
      // 目前只有 `fine` 一种 act。走到没实现的分支要出声，不能静默当"已处理"。
      this.deps.notify(`币种效果 ${spec.label} 没有实现分支（不该发生）`);
      return;
    }
    const quote = this.deps.fineQuote();
    const { applied, debtAdded } = this.deps.settleFine(quote.amount);
    this.coinEffectEvents.push({
      id: effect,
      requested: quote.amount,
      applied,
      debtAdded,
      balance: quote.balance,
      progress: quote.progress,
      t: this.deps.now(),
    });
    const percent = Math.round(fineRatio(quote.progress) * 100);
    this.deps.notify(
      debtAdded > 0
        ? `催债币越线：不返筹码，扣余额 ${percent}%（${applied} 筹码），另 ${debtAdded} 记在账上`
        : `催债币越线：不返筹码，扣余额 ${percent}%（${applied} 筹码）`,
    );
    this.attributed += 1;
    this.deps.refresh();
  }

  /**
   * 记一次催债币注入尝试（`Game.spawnHazard` 调）。
   *
   * 为什么要把"尝试"和"成功"都记下来：批里报"0 次结算"有三种完全不同的原因 ——
   * ① 注入条件根本没满足（投数不够 / 取模没对上）；② 条件满足了但 `coins.acquire()`
   * 返回 null（池满）；③ 币注进去了但没走完台面（局先结束）。
   * 只报"结算 0 次"分不出这三条，而那三条的处置完全不同。这是"缺席要能归因"的最低配置。
   */
  noteHazardAttempt(spawned: boolean): void {
    this.hazardAttempts += 1;
    if (spawned) this.hazardSpawned += 1;
  }

  /** 判据读数：面板立着没、当前候选是谁、池子里有没有拿不到 DOM。 */
  report(): { visible: boolean; choices: EffectId[]; cost: number; missingDom: boolean } {
    return {
      visible: this.visible,
      choices: this.current.map((choice) => choice.id),
      cost: DRAFT_COST,
      missingDom: this.missingDom,
    };
  }

  /** 币种效果的逐事件与两侧计数（归因门吃 `triggers === attributed === events.length`），外加注入尝试的归因读数。 */
  coinEffectReport(): {
    triggers: number;
    attributed: number;
    events: CoinEffectEvent[];
    hazardAttempts: number;
    hazardSpawned: number;
  } {
    return {
      triggers: this.triggers,
      attributed: this.attributed,
      events: this.coinEffectEvents.map((event) => ({ ...event })),
      hazardAttempts: this.hazardAttempts,
      hazardSpawned: this.hazardSpawned,
    };
  }

  /** 每局开始清一次：币种效果的计数与事件都是**本局**口径。 */
  resetCoinEffects(): void {
    this.triggers = 0;
    this.attributed = 0;
    this.coinEffectEvents = [];
  }
}
