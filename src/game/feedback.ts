import type { ClimaxTone } from './kinds';

/**
 * 得分反馈分级（P10 ⑨）—— **阈值只在这里写一次**。
 *
 * ## 为什么单独一个文件
 *
 * 「筹码 ≥ 25 是大号飞字」「连落 3 出脉冲、5 出白闪」这类阈值有两个消费者：
 * ① 引擎（决定发什么反馈）；② 判据（核对边界点）。
 * 写两遍就变成了第二份真源——S11 标定时把 25 调到 30，判据还在按 25 断言，
 * 于是它测的根本不是线上那套数（纪律 2：判据不写第二份公式）。
 *
 * ## 为什么分级本身要做成**纯函数**
 *
 * 反馈的效果（震屏、脉冲、白闪）都要在真实物理里跑出来才看得见，
 * 而「连落 5 次」在盘面上很难确定性地凑出来。把「什么输入产生什么反馈」
 * 抽成纯函数之后，判据可以**枚举边界点**核对全部分支，
 * 剩下的只有「引擎有没有调用它」这一件事需要真实跑动去验。
 */

export const FEEDBACK = {
  /** 飞字大号（+描边）的筹码阈值。 */
  flyScoreBig: 25,
  /** 连落多少开始给「得分线脉冲 + 轻闪」。 */
  comboPulse: 3,
  /** 连落多少开始给「震屏 + 白闪」。 */
  comboClimax: 5,
} as const;

export type FlyTier = 'normal' | 'big';

/**
 * 一次对局里各档反馈各发生了多少次。
 *
 * 单独起一个类型（而不是 `typeof game.feedbackCounts`）是因为 `Game` 的
 * 返回值类型标注里不能用 `typeof this.x`——那会让 `this` 退化成 `any`。
 */
export type FeedbackCounts = {
  flyNormal: number;
  flyBig: number;
  comboPulse: number;
  comboClimax: number;
  hotHit: number;
  drainFlash: number;
};

/** 飞字档位：大号是给「一笔就有感觉」的入账（越线返值 ≥ 25）。 */
export function flyTier(chips: number): FlyTier {
  return chips >= FEEDBACK.flyScoreBig ? 'big' : 'normal';
}

/** 一次越线产生的全部反馈。`climax` 为 `null` 表示这次不出高潮特效。 */
export type CrossingFeedback = {
  flyTier: FlyTier;
  /** 得分线脉冲 + 轻闪（连落 ≥ `comboPulse`）。 */
  scoreLinePulse: boolean;
  /** 热区命中：高亮条爆闪 + 专属音效。 */
  hotFlash: boolean;
  /**
   * 高潮（HUD 全屏闪色）。
   *
   * `strength` 目前**只作为分级结果的公开契约存在**（判据核它：「连落白闪的强度是 1」）——
   * S16 起它不再驱动相机：中币的镜头抖动已按用户要求整体删除
   * （见 `Game.triggerClimax` 的注释）。
   */
  climax: { strength: number; tone: ClimaxTone; reason: 'combo' | 'kind' } | null;
};

/**
 * 一次越线该出什么反馈。**纯函数**，判据枚举它核对边界。
 *
 * 优先级：连落高潮**压过**币种自身的高潮定义。理由是连落是**玩家造成的**
 * （他连着把币推下去），币种只是运气；两者同时成立时该强调的是玩家的操作。
 * 这条优先级原先散在 `Game.settleCrossing` 的一行三元表达式里，
 * 现在提到这里，成为可枚举、可断言的事实。
 *
 * `kindClimax` 由调用方传 `kindSpec(kind).climax` —— 币种的高潮定义
 * **单一真源仍在 `kinds.ts`**，这里只是把它接进分级，不再抄一遍。
 *
 * ## ★ `blocked`：被概率闸门拦下的币种**不许闪自己的高潮**
 *
 * S13 §5 给花纹加上闸门之后，同一枚币有了两种命运：返钱（`chips > 0`）与返 0。
 * 而币种的高潮定义（花纹的金闪、强度 0.55）是「这枚币值钱」的表达，
 * 返 0 时还闪就是**画面在说谎**——玩家看到金闪却只拿到灰字 +0。
 *
 * 所以被拦下时压掉**币种**高潮。**连落白闪不受影响**：它表达的是
 * 「玩家连着把币推下去」，与这一枚币返没返钱无关，不该被闸门连坐。
 *
 * `blocked` 由 `crossingReturn()` 给出（见 `economy.ts`），**不在调用方推断**：
 * 「`chips === 0`」推不出 `blocked` —— `mode: 'effect'` 的币种本来就返 0，
 * 但它没被任何闸门拦下，该演出也该高潮。
 * （S16 起没有币种在用 `effect`：宝箱改成了 `fixed 50`。形态与分派刻意保留，
 * 这条推论仍然成立，见 `kinds.ts` 的 `KindPayout`。）
 */
export function crossingFeedback(input: {
  chips: number;
  combo: number;
  hot: boolean;
  kindClimax: { strength: number; tone: ClimaxTone } | null;
  /** 这次是否被概率闸门拦下（`crossingReturn().blocked`）。默认 `false`。 */
  blocked?: boolean;
}): CrossingFeedback {
  const comboClimax = input.combo >= FEEDBACK.comboClimax;
  return {
    flyTier: flyTier(input.chips),
    scoreLinePulse: input.combo >= FEEDBACK.comboPulse,
    hotFlash: input.hot,
    climax: comboClimax
      ? { strength: 1, tone: 'white', reason: 'combo' }
      : input.kindClimax && input.blocked !== true
        ? { strength: input.kindClimax.strength, tone: input.kindClimax.tone, reason: 'kind' }
        : null,
  };
}
