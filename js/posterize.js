// posterize.js — ポスタリゼーション（色量子化）による領域境界抽出
//
// 素のRGBでk-meansすると明るさの変化（影・ハイライト）が色の違いより
// 大きく扱われ、「明るい肌と影の肌」が別領域になってしまう。そこで
//   1. YCbCr に変換し、輝度Yの重みを下げ色味Cb/Crの重みを上げる
//      （同じ素材は影でも色味が同じ → 同じ領域になる）
//   2. 輝度を「大きくぼかした局所平均」で割って正規化する（Retinex方式）。
//      なだらかな明暗＝照明は消え、急な変化＝素材の境界だけが残る
//   3. クラスタリング前に各チャンネルをぼかす（皺の影・小さなハイライトを消す。
//      色味は強めに、輝度は目・眉の形が残る程度に弱く）
// ことで、肌・髪・服・目といった「物の色」の境界を取り出す。

import { maskOutline, dilateMask } from './edge.js';

const W_Y = 0.5;  // 輝度の重み（影・ハイライトの影響を抑える）
const W_C = 2.0;  // 色味の重み（素材の違いを優先する）
const SIGMA_Y = 2; // 輝度のぼかし（皺を消しつつ目・眉は残す）
const SIGMA_C = 4; // 色味のぼかし

/**
 * 色量子化で領域を分割し、その境界線を返す
 * @param {ImageData} imageData
 * @param {{ levels?: number, mask?: Uint8Array|null, minRegionFrac?: number }} opts
 * @returns {Uint8Array} 領域境界マップ（境界画素=255、他=0）
 */
export function posterizeEdges(imageData, opts = {}) {
  const levels = opts.levels ?? 4;
  const mask = opts.mask ?? null;
  const minRegionFrac = opts.minRegionFrac ?? 0.002;

  const { data, width: W, height: H } = imageData;
  const N = W * H;

  // 対象画素インデックス
  const targets = [];
  for (let i = 0; i < N; i++) {
    if (mask === null || mask[i] > 0) targets.push(i);
  }
  const numTargets = targets.length;
  if (numTargets === 0) return new Uint8Array(N);

  // --- 特徴量: ぼかした YCbCr に重みを掛けたもの ---
  const fy = new Float32Array(N);
  const fcb = new Float32Array(N);
  const fcr = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const b = i * 4;
    const r = data[b], g = data[b + 1], bl = data[b + 2];
    const y = 0.299 * r + 0.587 * g + 0.114 * bl;
    fy[i] = y;
    fcb[i] = 128 + (bl - y) * 0.564;
    fcr[i] = 128 + (r - y) * 0.713;
  }
  // マスク対応ぼかし（背景の色が滲み込まないよう blur(F*m)/blur(m) で正規化）
  const m = new Float32Array(N);
  if (mask) {
    for (let i = 0; i < N; i++) m[i] = mask[i] ? 1 : 0;
  } else {
    m.fill(1);
  }
  // 照明正規化（Retinex方式）: 大きな半径の局所平均輝度で割る
  const illumRadius = Math.max(24, Math.round(Math.min(W, H) / 6));
  const fyM = new Float32Array(N);
  for (let i = 0; i < N; i++) fyM[i] = fy[i] * m[i];
  const illumNum = boxBlurLarge(fyM, W, H, illumRadius);
  const illumDen = boxBlurLarge(m, W, H, illumRadius);
  const yNorm = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const illum = illumDen[i] > 1e-6 ? illumNum[i] / illumDen[i] : fy[i];
    const v = 128 * (fy[i] + 4) / (illum + 4);
    yNorm[i] = Math.max(0, Math.min(255, v));
  }

  const featY = maskedBlur(yNorm, m, W, H, SIGMA_Y);
  const featCb = maskedBlur(fcb, m, W, H, SIGMA_C);
  const featCr = maskedBlur(fcr, m, W, H, SIGMA_C);
  for (let i = 0; i < N; i++) {
    featY[i] *= W_Y;
    featCb[i] *= W_C;
    featCr[i] *= W_C;
  }

  // --- k-means ---
  const maxSamples = 20000;
  const sampleStep = numTargets <= maxSamples ? 1 : Math.floor(numTargets / maxSamples);
  const sampleIdx = [];
  for (let s = 0; s < numTargets; s += sampleStep) sampleIdx.push(targets[s]);
  const numSamples = sampleIdx.length;

  // 初期重心: 輝度順の等分位点（再現性のため乱数は使わない）
  const sorted = sampleIdx.slice().sort((a, b) => featY[a] - featY[b]);
  const k = Math.max(1, Math.min(levels, numSamples));
  const cen = new Float64Array(k * 3);
  for (let c = 0; c < k; c++) {
    const si = sorted[Math.floor((c + 0.5) * numSamples / k)];
    cen[c * 3] = featY[si];
    cen[c * 3 + 1] = featCb[si];
    cen[c * 3 + 2] = featCr[si];
  }

  const nearest = (i) => {
    let bestC = 0, bestD = Infinity;
    for (let c = 0; c < k; c++) {
      const d0 = featY[i] - cen[c * 3];
      const d1 = featCb[i] - cen[c * 3 + 1];
      const d2 = featCr[i] - cen[c * 3 + 2];
      const d = d0 * d0 + d1 * d1 + d2 * d2;
      if (d < bestD) { bestD = d; bestC = c; }
    }
    return bestC;
  };

  const assign = new Int32Array(numSamples);
  for (let iter = 0; iter < 10; iter++) {
    for (let s = 0; s < numSamples; s++) assign[s] = nearest(sampleIdx[s]);
    const sum = new Float64Array(k * 3);
    const cnt = new Int32Array(k);
    for (let s = 0; s < numSamples; s++) {
      const c = assign[s], i = sampleIdx[s];
      sum[c * 3] += featY[i];
      sum[c * 3 + 1] += featCb[i];
      sum[c * 3 + 2] += featCr[i];
      cnt[c]++;
    }
    for (let c = 0; c < k; c++) {
      if (cnt[c] > 0) {
        cen[c * 3] = sum[c * 3] / cnt[c];
        cen[c * 3 + 1] = sum[c * 3 + 1] / cnt[c];
        cen[c * 3 + 2] = sum[c * 3 + 2] / cnt[c];
      } else {
        // 空クラスタは既存重心から最も遠いサンプルで再初期化
        let maxD = -1, far = sampleIdx[0];
        for (let s = 0; s < numSamples; s++) {
          const i = sampleIdx[s];
          let minD = Infinity;
          for (let cc = 0; cc < k; cc++) {
            if (cc === c) continue;
            const d0 = featY[i] - cen[cc * 3];
            const d1 = featCb[i] - cen[cc * 3 + 1];
            const d2 = featCr[i] - cen[cc * 3 + 2];
            const d = d0 * d0 + d1 * d1 + d2 * d2;
            if (d < minD) minD = d;
          }
          if (minD > maxD) { maxD = minD; far = i; }
        }
        cen[c * 3] = featY[far];
        cen[c * 3 + 1] = featCb[far];
        cen[c * 3 + 2] = featCr[far];
      }
    }
  }

  // 全対象画素にラベル割り当て（対象外=-1）
  const labels = new Int32Array(N).fill(-1);
  for (let t = 0; t < numTargets; t++) {
    const i = targets[t];
    labels[i] = nearest(i);
  }

  // --- 3x3 多数決フィルタ 2回 ---
  for (let pass = 0; pass < 2; pass++) {
    const next = labels.slice();
    for (let t = 0; t < numTargets; t++) {
      const i = targets[t];
      const y = (i / W) | 0, x = i % W;
      const votes = new Int32Array(k);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const ny = y + dy, nx = x + dx;
          if (ny < 0 || ny >= H || nx < 0 || nx >= W) continue;
          const l = labels[ny * W + nx];
          if (l >= 0) votes[l]++;
        }
      }
      let maxV = -1, bestL = labels[i];
      for (let c = 0; c < k; c++) if (votes[c] > maxV) { maxV = votes[c]; bestL = c; }
      next[i] = bestL;
    }
    labels.set(next);
  }

  // --- 小領域の併合（成分ごとの画素リストを保持して1パス） ---
  const compId = new Int32Array(N).fill(-1);
  const comps = []; // { label, pixels: Int32Array }
  const queue = new Int32Array(numTargets);
  for (let t = 0; t < numTargets; t++) {
    const start = targets[t];
    if (compId[start] >= 0) continue;
    const cid = comps.length;
    let head = 0, tail = 0;
    queue[tail++] = start;
    compId[start] = cid;
    const lbl = labels[start];
    const pixels = [];
    while (head < tail) {
      const cur = queue[head++];
      pixels.push(cur);
      const cy = (cur / W) | 0, cx = cur % W;
      const nb = [cy > 0 ? cur - W : -1, cy < H - 1 ? cur + W : -1, cx > 0 ? cur - 1 : -1, cx < W - 1 ? cur + 1 : -1];
      for (const ni of nb) {
        if (ni < 0 || compId[ni] >= 0 || labels[ni] !== lbl) continue;
        compId[ni] = cid;
        queue[tail++] = ni;
      }
    }
    comps.push({ label: lbl, pixels });
  }
  const minSize = minRegionFrac * numTargets;
  for (const comp of comps) {
    if (comp.pixels.length >= minSize) continue;
    const votes = new Map();
    for (const i of comp.pixels) {
      const cy = (i / W) | 0, cx = i % W;
      const nb = [cy > 0 ? i - W : -1, cy < H - 1 ? i + W : -1, cx > 0 ? i - 1 : -1, cx < W - 1 ? i + 1 : -1];
      for (const ni of nb) {
        if (ni < 0 || labels[ni] < 0 || labels[ni] === comp.label) continue;
        votes.set(labels[ni], (votes.get(labels[ni]) ?? 0) + 1);
      }
    }
    if (votes.size === 0) continue;
    let bestL = comp.label, bestV = -1;
    for (const [l, v] of votes) if (v > bestV) { bestV = v; bestL = l; }
    for (const i of comp.pixels) labels[i] = bestL;
  }

  // --- 境界抽出 ---
  const boundary = new Uint8Array(N);
  for (let t = 0; t < numTargets; t++) {
    const i = targets[t];
    const y = (i / W) | 0, x = i % W;
    if (x < W - 1 && labels[i + 1] >= 0 && labels[i + 1] !== labels[i]) boundary[i] = 255;
    if (y < H - 1 && labels[i + W] >= 0 && labels[i + W] !== labels[i]) boundary[i] = 255;
  }

  // 外形線帯の中は除外
  if (mask !== null) {
    const band = dilateMask(maskOutline(mask, W, H), W, H, 2);
    for (let i = 0; i < N; i++) if (band[i] !== 0) boundary[i] = 0;
  }
  return boundary;
}

// マスク対応の分離型ガウシアンぼかし: blur(F*m) / blur(m)
function maskedBlur(src, m, W, H, sigma) {
  const kernel = gaussKernel(sigma);
  const fm = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) fm[i] = src[i] * m[i];
  const bf = blurSep(fm, W, H, kernel);
  const bm = blurSep(m, W, H, kernel);
  const out = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) out[i] = bm[i] > 1e-6 ? bf[i] / bm[i] : src[i];
  return out;
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

// 大半径用の高速ボックスぼかし（累積和方式・2回反復でガウシアン近似）
export function boxBlurLarge(src, W, H, radius, iters = 2) {
  let cur = Float32Array.from(src);
  for (let it = 0; it < iters; it++) {
    const tmp = new Float32Array(W * H);
    // 水平
    for (let y = 0; y < H; y++) {
      const row = y * W;
      let sum = 0;
      for (let x = -radius; x <= radius; x++) sum += cur[row + Math.max(0, Math.min(W - 1, x))];
      for (let x = 0; x < W; x++) {
        tmp[row + x] = sum / (2 * radius + 1);
        const addX = Math.max(0, Math.min(W - 1, x + radius + 1));
        const subX = Math.max(0, Math.min(W - 1, x - radius));
        sum += cur[row + addX] - cur[row + subX];
      }
    }
    // 垂直
    const dst = new Float32Array(W * H);
    for (let x = 0; x < W; x++) {
      let sum = 0;
      for (let y = -radius; y <= radius; y++) sum += tmp[Math.max(0, Math.min(H - 1, y)) * W + x];
      for (let y = 0; y < H; y++) {
        dst[y * W + x] = sum / (2 * radius + 1);
        const addY = Math.max(0, Math.min(H - 1, y + radius + 1));
        const subY = Math.max(0, Math.min(H - 1, y - radius));
        sum += tmp[addY * W + x] - tmp[subY * W + x];
      }
    }
    cur = dst;
  }
  return cur;
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
