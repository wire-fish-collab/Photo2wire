// threshold.js — しきい値二値化による領域境界抽出
// 写真をしきい値で白黒2色に分け、その境界を線として取り出す。
// Photoshopの「2階調化」フィルターに相当。しきい値をスライダーで調整して
// 被写体の模様が適切に映る明るさを選ぶ使い方を想定。
//
// モード:
//   'standard' 動物・風景: 通常の輝度で二値化
//   'face'     似顔絵: 肌を明るく持ち上げ（ガンマ補正）、赤み（唇）を
//              暗く残すトーンカーブを通してから二値化

import { maskOutline, dilateMask } from './edge.js';

// 似顔絵モードの調整定数
const FACE_GAMMA = 0.65;   // 小さいほど肌（中間調）が明るく持ち上がる
const LIP_CR_BASE = 140;   // これを超える赤み（Cr）を暗くする
const LIP_DARKEN = 2.2;    // 赤みを暗くする強さ

const BLUR_SIGMA = 1.5;        // 二値化前のノイズ除去ぼかし
const MIN_SPECK_FRAC = 0.0008; // これ未満の白/黒の斑点は反転して消す

/**
 * 二値化マップを返す（255 = 暗い側 = 模様・線になる側）
 * @param {ImageData} imageData
 * @param {{ threshold?: number, mode?: 'standard'|'face', mask?: Uint8Array|null }} opts
 * @returns {Uint8Array} W*H、暗部=255、明部=0、マスク外=0
 */
export function binarize(imageData, opts = {}) {
  const threshold = opts.threshold ?? 128;
  const mode = opts.mode ?? 'standard';
  const mask = opts.mask ?? null;
  const { data, width: W, height: H } = imageData;
  const N = W * H;

  // モードに応じたグレースケール値
  const gray = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const b = i * 4;
    const r = data[b], g = data[b + 1], bl = data[b + 2];
    const y = 0.299 * r + 0.587 * g + 0.114 * bl;
    if (mode === 'face') {
      // 肌を明るく（ガンマ補正）
      let v = 255 * Math.pow(y / 255, FACE_GAMMA);
      // 赤み（唇など）は暗く残す
      const cr = 128 + (r - y) * 0.713;
      v -= Math.max(0, cr - LIP_CR_BASE) * LIP_DARKEN;
      gray[i] = Math.max(0, Math.min(255, v));
    } else {
      gray[i] = y;
    }
  }

  // 軽いぼかしでノイズを抑える
  const blurred = blurSep(gray, W, H, gaussKernel(BLUR_SIGMA));

  const bin = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    if (mask && mask[i] === 0) continue;
    if (blurred[i] < threshold) bin[i] = 255;
  }

  // 3x3 多数決フィルタ2回でギザつき・孤立画素を除去（マスク内のみ）
  for (let pass = 0; pass < 2; pass++) {
    const next = bin.slice();
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const i = y * W + x;
        if (mask && mask[i] === 0) continue;
        let dark = 0, total = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const ni = i + dy * W + dx;
            if (mask && mask[ni] === 0) continue;
            total++;
            if (bin[ni]) dark++;
          }
        }
        next[i] = dark * 2 > total ? 255 : 0;
      }
    }
    bin.set(next);
  }

  // 小さな斑点（白の中の黒、黒の中の白）を反転して消す
  removeSpecks(bin, mask, W, H);
  return bin;
}

/**
 * 二値化マップの境界線を返す
 * @param {Uint8Array} bin - binarize の結果
 * @param {number} W
 * @param {number} H
 * @param {{ mask?: Uint8Array|null }} opts
 * @returns {Uint8Array} 境界画素=255（マスク外形の2px帯は除外）
 */
export function thresholdEdges(bin, W, H, opts = {}) {
  const mask = opts.mask ?? null;
  const N = W * H;
  const boundary = new Uint8Array(N);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (mask && mask[i] === 0) continue;
      // 右・下の隣接（マスク内）と値が異なれば境界
      if (x < W - 1 && (!mask || mask[i + 1] !== 0) && bin[i] !== bin[i + 1]) boundary[i] = 255;
      if (y < H - 1 && (!mask || mask[i + W] !== 0) && bin[i] !== bin[i + W]) boundary[i] = 255;
    }
  }
  if (mask) {
    const band = dilateMask(maskOutline(mask, W, H), W, H, 2);
    for (let i = 0; i < N; i++) if (band[i]) boundary[i] = 0;
  }
  return boundary;
}

// 面積が MIN_SPECK_FRAC 未満の連結成分（4近傍・同値）を反転して消す
function removeSpecks(bin, mask, W, H) {
  const N = W * H;
  let numTargets = 0;
  for (let i = 0; i < N; i++) if (!mask || mask[i]) numTargets++;
  const minSize = Math.max(9, MIN_SPECK_FRAC * numTargets);

  const seen = new Uint8Array(N);
  const queue = new Int32Array(numTargets);
  for (let start = 0; start < N; start++) {
    if (seen[start] || (mask && mask[start] === 0)) continue;
    const val = bin[start];
    let head = 0, tail = 0;
    queue[tail++] = start;
    seen[start] = 1;
    const pixels = [];
    while (head < tail) {
      const cur = queue[head++];
      pixels.push(cur);
      const cy = (cur / W) | 0, cx = cur % W;
      const nb = [cy > 0 ? cur - W : -1, cy < H - 1 ? cur + W : -1, cx > 0 ? cur - 1 : -1, cx < W - 1 ? cur + 1 : -1];
      for (const ni of nb) {
        if (ni < 0 || seen[ni] || (mask && mask[ni] === 0) || bin[ni] !== val) continue;
        seen[ni] = 1;
        queue[tail++] = ni;
      }
    }
    if (pixels.length < minSize) {
      const inv = val ? 0 : 255;
      for (const i of pixels) bin[i] = inv;
    }
  }
}

function gaussKernel(sigma) {
  const radius = Math.ceil(3 * sigma);
  const kern = new Float32Array(2 * radius + 1);
  let sum = 0;
  for (let i = 0; i < kern.length; i++) {
    const x = i - radius;
    kern[i] = Math.exp(-(x * x) / (2 * sigma * sigma));
    sum += kern[i];
  }
  for (let i = 0; i < kern.length; i++) kern[i] /= sum;
  return kern;
}

function blurSep(src, W, H, kernel) {
  const radius = (kernel.length - 1) / 2;
  const tmp = new Float32Array(W * H);
  const dst = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let v = 0;
      for (let j = 0; j < kernel.length; j++) {
        const sx = Math.max(0, Math.min(W - 1, x + j - radius));
        v += src[y * W + sx] * kernel[j];
      }
      tmp[y * W + x] = v;
    }
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let v = 0;
      for (let j = 0; j < kernel.length; j++) {
        const sy = Math.max(0, Math.min(H - 1, y + j - radius));
        v += tmp[sy * W + x] * kernel[j];
      }
      dst[y * W + x] = v;
    }
  }
  return dst;
}
