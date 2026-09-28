/**
 * 音效预处理：裁切 → 淡入淡出 → 响度对齐 → 编码。
 *
 * 输入：`../音效/*.wav`（生成工具产出的原始素材，**只读，绝不修改**）
 * 输出：`public/audio/*.ogg`（48000Hz 单声道 Ogg Vorbis）
 *
 * 为什么要预处理：
 *   1. 生成工具最低只能出 0.5 秒，且把声音"撑满"整个时长——很多文件的尾静音
 *      占了一半体积，个别文件头部还有 70~100ms 的无效前摇（触发后先静音才出声，
 *      手感像输入延迟）。
 *   2. 17 个素材的响度差到 21 dB：最轻的提示音几乎听不见，最响的加力释放会炸耳。
 *   3. 部分文件结尾是硬截断（振幅还在 0.2 时突然归零），一次性播放会"咔"一声。
 *
 * ★ 关于响度归一化的选型（与初版计划不同，这里是修正后的做法）：
 *   原计划用 ffmpeg 的 `loudnorm`（EBU R128）。但 loudnorm 的测量窗口是 3 秒，
 *   而这些素材大多只有 0.3~0.5 秒——在这么短的片段上它的读数不可靠，单遍模式
 *   还会做动态压缩、在短音效上产生抽吸感。所以改用**确定性增益法**：
 *     增益 = min(目标RMS - 实测RMS, 峰值天花板 - 实测峰值)
 *   既把响度拉到同一基准，又保证任何文件都不削波。逐事件的分层音量交给
 *   AudioSystem 的 gain 参数去做（引擎侧可调，比压在资产里更灵活）。
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ffmpegPath from 'ffmpeg-static';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(HERE, '..');
const SRC_DIR = resolve(PROJECT, '..', '音效');
const OUT_DIR = join(PROJECT, 'public', 'audio');

/** 目标 RMS（dBFS）。所有素材拉齐到同一响度，分层由 AudioSystem 的 gain 决定。 */
const TARGET_RMS_DB = -20;
/**
 * 峰值天花板（dBFS）。
 *
 * ★ 取 -2.5 而不是 -1.5，是因为踩过一个坑：第一版把天花板设成 -1.5dB，
 * 结果 `slot_spin` 输出峰值冲到 **1.2006（+1.59dB，超满刻度 20%）**，硬削波。
 *
 * 根因是**采样率转换的过冲**：我按 48kHz 立体声测峰值算增益，但输出要转成
 * 44.1kHz 单声道——重采样的 sinc 插值会在原始采样点之间产生更高的新峰值
 * （intersample peak），所以"按输入峰值留的余量"在输出侧并不成立。
 *
 * 修法见 `conversionChain()`：把 pan → aresample 放进**测量链**里，让增益
 * 基于真实的输出信号计算。额外多留 1dB 给 Vorbis 有损编码的振铃余量。
 */
const PEAK_CEILING_DB = -2.5;
/**
 * 编码器余量（dB）。
 *
 * 峰值天花板是**编码后**要满足的指标，而增益是在编码**前**施加的——
 * Vorbis 是有损编码，振铃会让解码后的峰值比输入高出零点几 dB（实测约 0.6dB）。
 * 所以算增益时要多留这一截，否则每个文件都会贴着天花板、自检每次都报超限。
 */
const ENCODER_MARGIN_DB = 0.8;
/** 统一淡入时长（秒）。多数素材从 0ms 就是高幅起音，不淡入会有爆音。 */
const FADE_IN = 0.005;

/**
 * 输出规格。
 *
 * ★ 采样率取 48000 而不是 44100，是实测纠正过来的：浏览器的
 * `decodeAudioData` 会把结果**重采样到 AudioContext 的采样率**（通常就是硬件率
 * 48000）。如果资产是 44100，信号就会走「48k → 44.1k（本脚本）→ 48k（浏览器）」
 * 两次重采样——既多一次失真，也正是第一版削波的来源（重采样插值过冲）。
 * 资产直接用 48000 时这一段 `aresample` 退化为恒等变换，链路上没有重采样。
 */
const OUT_RATE = 48000;
const OUT_CHANNELS = 1;

/**
 * 逐文件处理表。
 *
 * `start` / `end` 单位秒，对应**原始文件**的时间轴；`end` 取了实测的
 * 「能量衰减到 -30dB 以下」的位置再留一点尾巴，砍掉的全是静音或不可闻的杂音。
 * `fadeOut` 用来吃掉普遍存在的末尾咔哒杂音；`slot_spin` 是硬截断，需要长淡出。
 */
const TRACKS = [
  // ── 投币下落：5 个变体，游戏内随机轮播 ────────────────────────────────
  // 第 1 个的前 70ms 只有 0.024 的低电平，真实起音在 80ms，必须裁掉否则像延迟。
  { src: 'A_single_coin_droppi_#1-1790223942995.wav', out: 'coin_drop_1.ogg', start: 0.070, end: 0.370, fadeOut: 0.020 },
  { src: 'A_single_coin_droppi_#1-1790224041746.wav', out: 'coin_drop_2.ogg', start: 0, end: 0.370, fadeOut: 0.020 },
  { src: 'A_single_coin_droppi_#1-1790224084755.wav', out: 'coin_drop_3.ogg', start: 0, end: 0.280, fadeOut: 0.020 },
  { src: 'A_single_coin_droppi_#2-1790224079846.wav', out: 'coin_drop_4.ogg', start: 0, end: 0.320, fadeOut: 0.020 },
  { src: 'A_single_coin_droppi_#4-1790224073839.wav', out: 'coin_drop_5.ogg', start: 0, end: 0.460, fadeOut: 0.050 },

  // ── 落定：轻（单币触台）/ 重（多币碰撞）──────────────────────────────
  { src: 'A_small_metal_coin_l_#4-1790224155723.wav', out: 'coin_land_light.ogg', start: 0, end: 0.360, fadeOut: 0.020 },
  // 前 100ms 才起音，裁掉；它同时兼作 payoutReturn（返币到账）的素材。
  { src: 'Several_metal_coins__#4-1790224204999.wav', out: 'coin_land_heavy.ogg', start: 0.080, end: 0.450, fadeOut: 0.030 },

  // ── 得分：中（花纹/返币）/ 大（金赏、老虎机中奖）─────────────────────
  { src: 'Two-note_rising_chim_#2-1790224280954.wav', out: 'score_mid_1.ogg', start: 0, end: 0.470, fadeOut: 0.030 },
  { src: 'Two-note_rising_chim_#3-1790224274619.wav', out: 'score_mid_2.ogg', start: 0, end: 0.350, fadeOut: 0.020 },
  { src: 'Bright_triumphant_wi_#1-1790224407947.wav', out: 'score_big_1.ogg', start: 0, end: 0.620, fadeOut: 0.030 },
  { src: 'Bright_triumphant_wi_#2-1790224398460.wav', out: 'score_big_2.ogg', start: 0, end: 0.670, fadeOut: 0.030 },

  // 连击上行：原长 420ms，连击时叠起来会糊，砍到 200ms。
  { src: 'Single_ascending_ton_#3-1790224486549.wav', out: 'combo_up.ogg', start: 0, end: 0.200, fadeOut: 0.020 },

  // ── 提示与机械 ────────────────────────────────────────────────────────
  // 最后 10ms 有 0.088 的可闻咔哒（-21dBFS），裁掉。
  { src: 'Soft_short_confirmat_#1-1790224525184.wav', out: 'mark.ogg', start: 0, end: 0.455, fadeOut: 0.030 },
  { src: 'Low_charging_hum_ris_#3-1790224557115.wav', out: 'boost_ready.ogg', start: 0, end: 0.430, fadeOut: 0.030 },
  // 峰值满载且有 2.2% 削波，靠响度对齐自然会把它压下来，另不再额外加增益。
  { src: 'Mechanical_whoosh_wi_#1-1790224636950.wav', out: 'boost_use.ogg', start: 0, end: 0.280, fadeOut: 0.030 },

  // ── 新增播放点 ────────────────────────────────────────────────────────
  // 硬截断（结尾振幅 0.2 时突然归零），淡出必须给足。
  { src: 'Slot_machine_reels_s_#1-1790224816562.wav', out: 'slot_spin.ogg', start: 0, end: 1.0, fadeOut: 0.080 },
  // 文件长 1000ms，但后 530ms 是纯静音，砍掉能省一半体积。
  { src: 'Short_soft_click,_UI_#3-1790224847203.wav', out: 'ui_click.ogg', start: 0, end: 0.470, fadeOut: 0.030 },
];

function run(args) {
  return execFileSync(ffmpegPath, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * 裁切 + 声道/采样率转换链。
 *
 * ★ 这一段**测量与编码必须共用**。只测输入不算数：重采样会过冲，
 * 按输入峰值留的余量到输出侧就不成立了（见 PEAK_CEILING_DB 的注释）。
 */
function conversionChain(track) {
  return [
    `atrim=start=${track.start}:end=${track.end}`,
    'asetpts=PTS-STARTPTS',
    // 显式下混，不依赖 -ac 1 的默认权重，且保证测量链与编码链逐样本一致。
    `pan=${OUT_CHANNELS === 1 ? 'mono|c0=0.5*c0+0.5*c1' : 'stereo|c0=c0|c1=c1'}`,
    `aresample=${OUT_RATE}`,
  ].join(',');
}

/**
 * 用 volumedetect 测「走完整转换链之后」的 RMS 与峰值（dBFS）。
 *
 * volumedetect 把读数写进 **stderr**，所以必须用 spawnSync 取回 stderr——
 * execFileSync 在成功时不会把它返回给我们。
 */
function measure(inputPath, filter) {
  const result = spawnSync(
    ffmpegPath,
    [
      '-hide_banner',
      '-nostats',
      '-i', inputPath,
      '-af', `${filter},volumedetect`,
      '-f', 'null',
      '-',
    ],
    { encoding: 'utf8' },
  );
  const stderr = result.stderr ?? '';
  const mean = /mean_volume:\s*(-?[\d.]+)\s*dB/.exec(stderr);
  const max = /max_volume:\s*(-?[\d.]+)\s*dB/.exec(stderr);
  if (!mean || !max) {
    throw new Error(`volumedetect 无读数（stderr 末尾：${stderr.trim().split('\n').slice(-2).join(' | ')}）`);
  }
  return { meanDb: Number(mean[1]), maxDb: Number(max[1]) };
}

/** 淡入/淡出 + 增益。增益放最后，它是纯乘法，不会引入新过冲。 */
function buildFilter(track, gainDb) {
  const duration = track.end - track.start;
  const fadeOutStart = Math.max(0, duration - track.fadeOut);
  return [
    conversionChain(track),
    `afade=t=in:st=0:d=${FADE_IN}`,
    `afade=t=out:st=${fadeOutStart.toFixed(3)}:d=${track.fadeOut}`,
    `volume=${gainDb.toFixed(2)}dB`,
  ].join(',');
}

function main() {
  if (!existsSync(ffmpegPath)) {
    throw new Error('ffmpeg-static 未就绪，请先执行 npm install');
  }
  if (!existsSync(SRC_DIR)) {
    throw new Error(`素材目录不存在：${SRC_DIR}`);
  }
  mkdirSync(OUT_DIR, { recursive: true });

  console.log(`源素材：${SRC_DIR}`);
  console.log(`输出到：${OUT_DIR}`);
  console.log(`目标 RMS ${TARGET_RMS_DB} dBFS / 峰值上限 ${PEAK_CEILING_DB} dBFS\n`);

  const failures = [];
  const overCeiling = [];
  for (const track of TRACKS) {
    const src = join(SRC_DIR, track.src);
    const dst = join(OUT_DIR, track.out);
    if (!existsSync(src)) {
      failures.push(`${track.src}（源文件不存在）`);
      continue;
    }
    try {
      const before = statSync(src).size;
      // 测量走完整转换链（裁切 + 下混 + 重采样），增益才对输出有效。
      const { meanDb, maxDb } = measure(src, conversionChain(track));
      // 关键：同时受两个约束——既对齐 RMS，又绝不超过（编码前的）峰值上限。
      const peakLimitDb = PEAK_CEILING_DB - ENCODER_MARGIN_DB;
      const gainDb = Math.min(TARGET_RMS_DB - meanDb, peakLimitDb - maxDb);
      run([
        '-y',
        '-hide_banner',
        '-i', src,
        '-af', buildFilter(track, gainDb),
        '-ac', String(OUT_CHANNELS),
        '-ar', String(OUT_RATE),
        '-c:a', 'libvorbis',
        '-q:a', '5',
        dst,
      ]);
      // 自检：对**编码后**的文件复测。有损编码的振铃可能把峰值顶过天花板，
      // 这一步就是为了让这种问题当场暴露，而不是等到听感不对才发现。
      const check = measure(dst, 'anull');
      if (check.maxDb > PEAK_CEILING_DB + 0.5) {
        overCeiling.push(`${track.out}（${check.maxDb.toFixed(2)} dBFS）`);
      }
      const after = statSync(dst).size;
      const dur = (track.end - track.start).toFixed(3);
      console.log(
        `✓ ${track.out.padEnd(22)} ${dur}s  增益 ${gainDb >= 0 ? '+' : ''}${gainDb.toFixed(1)}dB  ` +
          `RMS ${check.meanDb.toFixed(1)} / 峰 ${check.maxDb.toFixed(1)}dB  ` +
          `${(before / 1024).toFixed(0)}KB → ${(after / 1024).toFixed(0)}KB`,
      );
    } catch (error) {
      failures.push(`${track.src}（${error.message.split('\n')[0]}）`);
    }
  }

  console.log(`\n完成：${TRACKS.length - failures.length}/${TRACKS.length}`);
  if (overCeiling.length > 0) {
    console.error(`\n⚠ 峰值超出天花板 ${PEAK_CEILING_DB}dB（需下调增益）：`);
    for (const item of overCeiling) console.error(`  ! ${item}`);
  }
  if (failures.length > 0) {
    console.error('\n失败项：');
    for (const item of failures) console.error(`  ✗ ${item}`);
    process.exitCode = 1;
  }
}

main();
