import * as THREE from 'three';
import { COLORS, type CoinKind } from '../game/constants';
import { COIN_SKINS, type CoinSkin, type Motif } from '../game/cosmetics';

/**
 * 程序化生成币面贴图：外圈滚边 + 主题纹样 + 中心压印。
 * 圆柱端面的 UV 是径向映射，因此纹样会自然落在币面上，中心图案正对币心。
 *
 * **币面不许印面值。** v3 的返值是「基数 × 热度 × 热区 × 加注 × 闸门概率」，
 * 铜币还有 63% 的概率一分不返——任何数字印在币面上都是骗人的。
 * 所以这里只印**身份符号**：花纹筹码「花」、返币筹码「＋」、大赏币「赏」，
 * 普通铜币不印字（纹样本身就是它的脸）。具体返多少由飞字与 HUD 说。
 *
 * 花纹筹码与返币筹码的颜色是玩法信息（奶白 = 稳定返值、绿色 = 复活），
 * 所以只有普通铜币跟随外观，另两种始终保持原色。
 */
export function createCoinTexture(kind: CoinKind, skin: CoinSkin, size = 256): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建币面贴图上下文。');

  const half = size / 2;
  const palette = skin.palette[kind];
  const mark = { bronze: '', pattern: '花', payout: '＋', bounty: '赏' }[kind];

  ctx.fillStyle = palette.base;
  ctx.fillRect(0, 0, size, size);

  // 外圈滚边
  ctx.strokeStyle = palette.dark;
  ctx.lineWidth = size * 0.045;
  ctx.beginPath();
  ctx.arc(half, half, half * 0.9, 0, Math.PI * 2);
  ctx.stroke();

  drawMotif(ctx, skin.motif, half, size, palette.dark, palette.ink);

  if (mark) {
    ctx.fillStyle = palette.ink;
    ctx.font = `600 ${Math.round(size * 0.24)}px Georgia, serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(mark, half, half + size * 0.01);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

function drawMotif(
  ctx: CanvasRenderingContext2D,
  motif: Motif,
  half: number,
  size: number,
  dark: string,
  ink: string,
): void {
  switch (motif) {
    case 'rings': {
      ctx.strokeStyle = dark;
      ctx.lineWidth = size * 0.012;
      for (let i = 1; i <= 3; i += 1) {
        ctx.beginPath();
        ctx.arc(half, half, half * (0.42 + i * 0.11), 0, Math.PI * 2);
        ctx.stroke();
      }
      return;
    }
    case 'hex': {
      ctx.strokeStyle = dark;
      ctx.lineWidth = size * 0.014;
      for (let ring = 1; ring <= 2; ring += 1) {
        const radius = half * (0.36 + ring * 0.16);
        ctx.beginPath();
        for (let i = 0; i <= 6; i += 1) {
          const angle = (i / 6) * Math.PI * 2 - Math.PI / 2;
          const x = half + Math.cos(angle) * radius;
          const y = half + Math.sin(angle) * radius;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      return;
    }
    case 'waves': {
      ctx.strokeStyle = dark;
      ctx.lineWidth = size * 0.016;
      for (let row = -1; row <= 1; row += 1) {
        ctx.beginPath();
        for (let x = 0; x <= size; x += 4) {
          const y = half + row * half * 0.26 + Math.sin((x / size) * Math.PI * 4) * half * 0.07;
          if (x === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      return;
    }
    case 'petals': {
      ctx.fillStyle = ink;
      ctx.globalAlpha = 0.5;
      for (let i = 0; i < 8; i += 1) {
        const angle = (i / 8) * Math.PI * 2;
        ctx.beginPath();
        ctx.ellipse(
          half + Math.cos(angle) * half * 0.55,
          half + Math.sin(angle) * half * 0.55,
          half * 0.13,
          half * 0.07,
          angle,
          0,
          Math.PI * 2,
        );
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      return;
    }
    default:
      return;
  }
}

export function createCoinMaterial(kind: CoinKind, skin: CoinSkin): THREE.MeshStandardMaterial {
  const map = createCoinTexture(kind, skin);
  const glow = kind === 'payout' ? COLORS.payout : kind === 'bounty' ? COLORS.bounty : null;
  return new THREE.MeshStandardMaterial({
    map,
    color: '#ffffff',
    metalness: skin.metalness,
    roughness: skin.roughness,
    emissive: new THREE.Color(glow ?? '#000000'),
    // 大赏币比返币筹码更亮一档：它是方差的主杠杆，得让人一眼看见。
    emissiveIntensity: kind === 'bounty' ? 0.34 : kind === 'payout' ? 0.12 : 0,
  });
}

export function defaultCoinSkin(): CoinSkin {
  return COIN_SKINS[0];
}
