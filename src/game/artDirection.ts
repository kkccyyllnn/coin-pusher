import type { RampBands } from '../render/RampLut';

/**
 * 美术方向常量（V2 起）。
 *
 * **与 `constants.ts` 的分工**：`constants.ts` 是物理/几何真源——改它必须重跑
 * `physics` 与 `economy`；这里是纯观感参数，改动**不需要**动物理验证，
 * 但需要截图 A/B。两者刻意分开放，免得调个颜色要跑一遍物理回归。
 */

/**
 * 彩色色带调色板。四段从**暗到亮**，色相刻意从冷走到暖——
 * 这是三渲二与「普通卡通渲染」的分界：阴影不是同一个色相压暗，而是**换到冷色阶**。
 *
 * ## ★ 取值是「实测 + 一次 bug 掩盖」的产物，改之前先读这段
 *
 * 色带是**乘**在 albedo 与灯光上的：最终 ≈ `albedo × palette(N·L) × 灯光 / π`。
 * 相邻两档的线性亮度比约 **1.6 倍**——这是「台阶看得见」的关键：
 * 太密没有色阶感，太疏暗部会压死。
 *
 * ⚠️ **历史坑**：`RampLut` 早期把颜色**转了两次** sRGB→线性
 * （`new THREE.Color()` 已经转过一次，又调了一次 `convertSRGBToLinear()`），
 * 于是色带最暗档从 0.26 掉到 **0.0585**（暗 4.5 倍）。
 * 当时是**靠把这四组调色板整体抬亮**掩盖过去的——所以「看起来对」的其实是
 * 一组被二次转换后的值。V4 挖出这个 bug 之后，这里的值**已经改回**
 * 按正确数学推导的那一组（也就是最初的那组）。
 *
 * 数值是 sRGB；`makeRampLut` 里 `THREE.Color` 会把它转成线性再写字节（**只转一次**）。
 */
export const RAMP_PALETTES = {
  /**
   * 机柜主体（背板 / 侧板 / 护栏 / 推板 / 地面）。
   * 暗部偏蓝紫、亮部偏暖奶油——本作底色是深绿机柜 + 铜币，
   * 冷暗部能把铜币的暖色推出来，不会与币抢色相。
   */
  cabinet: ['#3f4c6b', '#6b7899', '#aab3c8', '#fff2d6'],
  /** 金属件（钉阵 / 顶沿 / 老虎机框）：跨度更大，顶段更亮，做出金属的高光段。 */
  metal: ['#2f3a52', '#7d8aa6', '#d6dbe8', '#fffdf5'],
  /** 发光件（得分线 / 热区亮条 / 导槽）：主体靠自发光，色带只负责轻微压暗，保持中性。 */
  accent: ['#4a4460', '#8d86a6', '#d9d3e6', '#fff6e6'],
  /** 演出装置（币塔 / 喷泉 / 闸门 / 宝箱）：略偏紫，与机台本体的冷蓝拉开一点。 */
  device: ['#3b3355', '#6f6493', '#c3bbd8', '#fff0e0'],
  /**
   * 币（V4）。**比机柜硬**：金属的色阶本来就比木头/绒布分明，
   * 顶段更亮，让币面在 480p 下也有一眼可辨的高光段。
   *
   * 色相**接近中性、只带一丝冷**：币的 albedo 是 `COIN_SKINS[].palette[kind].base`
   * （铜/银/青瓷/黑曜各不相同），色带只负责「分段」。
   * 实测教训：色带明显偏冷会把暖 albedo 的铜币**去饱和成暗红**。
   */
  coin: ['#585a63', '#84868f', '#c0c2c9', '#fffdf6'],
} as const satisfies Record<string, RampBands>;

export type RampId = keyof typeof RAMP_PALETTES;

/**
 * 机台部件角色 → 色带。角色就是 `TableBuilder` 的 `userData.role`
 * （`floor/rail/panel/trim/pusherTop/pusherFace`）。
 *
 * 注意 `role ↔ 材质` 在机柜里是 1:1（`panelMaterial` 供背板 + 2 侧板、
 * `railMaterial` 供 2 护栏、`trimMaterial` 供顶沿、floor 独立），
 * 所以色带可以挂在材质上。**新增可换色部件时不要把两种角色合并到同一个材质**，
 * 否则它们会共用一条色带。
 */
export const ROLE_RAMP = {
  floor: 'cabinet',
  rail: 'metal',
  panel: 'cabinet',
  trim: 'metal',
  pusherTop: 'cabinet',
  pusherFace: 'metal',
} as const satisfies Record<string, RampId>;

/**
 * 程序化表面细节（V3）。
 *
 * `scale` 的语义是**每米多少个纹样单元**：坐标会先乘它再进纹样函数，
 * 所以 `fract(uv)` 得到的格子边长就是 `1 / scale` 米。
 *
 * ## ★ 频率上限由**像素率**决定，不是由「想多细」决定
 *
 * 第一版按「每厘米一条颗粒」定频率（felt 9.0 → 最细一层 99 条/米），
 * 结果币床上出现大片**对角条纹**——那是**摩尔纹**，不是纹样：
 * 480p 下币床约 300 像素/米，一个周期只落 3 个像素，采样不足就把高频拍成了低频道条。
 *
 * 现在的取值保证**最细一层 ≥ 8 像素**（300 px/m 时 ≤ 40 条/米），
 * 再叠加 `sdDetail2D` 里的 `fwidth` LOD 淡出兜住更远的表面。
 * 改这些值之前先算一遍「最细一层多少条/米 × 该表面的像素率」。
 *
 * 取值按**实际构件尺寸**定：
 * - `panelSeam` 1.5 → 0.67 米一格，1.66×1.9 米的背板约 2~3 格，接缝不密不疏。
 * - `brushedMetal` 1.8 → 最细一层 29 条/米（每 3.4 厘米一条）。
 * - `wood` 0.9 → 年轮约 8 条/米（每 12 厘米一圈），像一块宽板。
 * - `felt` 3.0 → 最细一层 33 条/米（每 3 厘米一条），刚好是「看得见的绒面」而不是噪点。
 *
 * 字段名与 `makeToonMaterial` 的入参**同名**，所以可以直接 `...ROLE_DETAIL.panel` 展开。
 */
export const DETAIL_SURFACE = {
  brushedMetal: { detailKind: 1, detailScale: 1.8 },
  wood: { detailKind: 2, detailScale: 0.9 },
  panelSeam: { detailKind: 3, detailScale: 1.5 },
  felt: { detailKind: 4, detailScale: 3.0 },
} as const;

/**
 * 机台部件角色 → 边缘光与 matcap-lite（R2-T1-1 / T1-2）。
 *
 * 与 `ROLE_RAMP` / `ROLE_DETAIL` 同键，所以同样可以 `...ROLE_RIM.rail` 直接展开。
 * 两个新参数都**默认恒等**（上缘色跟随下缘色、matcap 强度 0），没列进来的角色零变化。
 *
 * ## 为什么只给金属件
 *
 * 双色 rim 与 matcap-lite 都是零程序代价的通道（GLSL 无条件注入，生效与否由逐材质
 * uniform 表达）。但「零程序」≠「零风险」：rim 是加在 **albedo** 上的，强度一高会把
 * 色带顶到更亮一档，整件泛白（S16 的钻石就是这么变成白球的）。所以只开给**金属件**，
 * 漆面（panel / floor）与币保持 0。
 *
 * ## 为什么写死、不跟换肤走
 *
 * 下暖上冷表达的是**机台所处的环境光**（Arcane 的霓虹从下往上打），不是机台涂装。
 * 跟着皮肤变会让「同一间屋子」的每台风色温都不一样 —— 那才是错的复用。
 */
export const ROLE_RIM = {
  rail: {
    rimColor: '#ffd08a',
    rimColorHigh: '#8fd0ff',
    rimStrength: 0.3,
    rimPower: 2.6,
    matcapStrength: 0.18,
  },
  trim: {
    rimColor: '#ffd08a',
    rimColorHigh: '#8fd0ff',
    rimStrength: 0.26,
    rimPower: 3.2,
    matcapStrength: 0.14,
  },
} as const;

/**
 * 机台部件角色 → 表面细节。与 `ROLE_RAMP` 同键，便于一处改完。
 *
 * 注意 `role ↔ 材质` 在机柜里是 1:1，所以细节可以挂在材质上。
 * **新增可换色部件时不要把两种角色合并到同一个材质**，否则它们会共用同一种纹样。
 */
export const ROLE_DETAIL = {
  floor: DETAIL_SURFACE.felt,
  rail: DETAIL_SURFACE.brushedMetal,
  panel: DETAIL_SURFACE.panelSeam,
  trim: DETAIL_SURFACE.panelSeam,
  pusherTop: DETAIL_SURFACE.wood,
  pusherFace: DETAIL_SURFACE.brushedMetal,
} as const satisfies Record<string, { detailKind: number; detailScale: number }>;
