// posterize.js — ポスタリゼーション（k-means色量子化）による領域境界抽出

import { maskOutline, dilateMask } from './edge.js';

/**
 * k-means色量子化で領域を分割し、その境界線を返す
 * @param {ImageData} imageData - 入力画像
 * @param {{ levels?: number, mask?: Uint8Array|null, minRegionFrac?: number }} opts
 * @returns {Uint8Array} 領域境界マップ（境界画素=255、他=0）
 */
export function posterizeEdges(imageData, opts = {}) {
  const levels       = opts.levels       ?? 4;
  const mask         = opts.mask         ?? null;
  const minRegionFrac = opts.minRegionFrac ?? 0.002;

  const { data, width: W, height: H } = imageData;
  const N = W * H;

  // 対象画素インデックスを収集
  const targets = [];
  for (let i = 0; i < N; i++) {
    if (mask === null || mask[i] > 0) {
      targets.push(i);
    }
  }
  const numTargets = targets.length;
  if (numTargets === 0) return new Uint8Array(N);

  // --- k-means 色量子化 ---

  // 最大20000画素を等間隔サンプリング（再現性のため Math.random 不使用）
  const maxSamples = 20000;
  const sampleStep = numTargets <= maxSamples ? 1 : Math.floor(numTargets / maxSamples);
  const samples = [];
  for (let s = 0; s < numTargets; s += sampleStep) {
    const idx = targets[s];
    const b = idx * 4;
    samples.push([data[b], data[b + 1], data[b + 2]]);
  }
  const numSamples = samples.length;

  // 初期重心: 輝度順に並べたサンプルの等分位点から取る
  const sortedByLuma = samples.slice().sort((a, b) => {
    const la = 0.299 * a[0] + 0.587 * a[1] + 0.114 * a[2];
    const lb = 0.299 * b[0] + 0.587 * b[1] + 0.114 * b[2];
    return la - lb;
  });
  const k = Math.max(1, Math.min(levels, numSamples));
  // Float64Array で重心を管理（centroids: k×3）
  const centroids = new Float64Array(k * 3);
  for (let c = 0; c < k; c++) {
    // 等分位点のインデックス
    const si = Math.floor((c + 0.5) * numSamples / k);
    centroids[c * 3]     = sortedByLuma[si][0];
    centroids[c * 3 + 1] = sortedByLuma[si][1];
    centroids[c * 3 + 2] = sortedByLuma[si][2];
  }

  // k-means 反復（10回）
  const assign = new Int32Array(numSamples);
  for (let iter = 0; iter < 10; iter++) {
    // 割り当て
    for (let s = 0; s < numSamples; s++) {
      const [r, g, b] = samples[s];
      let bestC = 0;
      let bestD = Infinity;
      for (let c = 0; c < k; c++) {
        const dr = r - centroids[c * 3];
        const dg = g - centroids[c * 3 + 1];
        const db = b - centroids[c * 3 + 2];
        const d = dr * dr + dg * dg + db * db;
        if (d < bestD) { bestD = d; bestC = c; }
      }
      assign[s] = bestC;
    }

    // 重心更新
    const sumR = new Float64Array(k);
    const sumG = new Float64Array(k);
    const sumB = new Float64Array(k);
    const cnt  = new Int32Array(k);
    for (let s = 0; s < numSamples; s++) {
      const c = assign[s];
      sumR[c] += samples[s][0];
      sumG[c] += samples[s][1];
      sumB[c] += samples[s][2];
      cnt[c]++;
    }

    // 空クラスタは最遠点で再初期化
    for (let c = 0; c < k; c++) {
      if (cnt[c] > 0) {
        centroids[c * 3]     = sumR[c] / cnt[c];
        centroids[c * 3 + 1] = sumG[c] / cnt[c];
        centroids[c * 3 + 2] = sumB[c] / cnt[c];
      } else {
        // 全サンプルの中で現在の重心群から最も遠い点を探す
        let maxD = -1;
        let farIdx = 0;
        for (let s = 0; s < numSamples; s++) {
          const [r, g, b] = samples[s];
          let minDist = Infinity;
          for (let cc = 0; cc < k; cc++) {
            if (cc === c) continue;
            const dr = r - centroids[cc * 3];
            const dg = g - centroids[cc * 3 + 1];
            const db = b - centroids[cc * 3 + 2];
            const d = dr * dr + dg * dg + db * db;
            if (d < minDist) minDist = d;
          }
          if (minDist > maxD) { maxD = minDist; farIdx = s; }
        }
        centroids[c * 3]     = samples[farIdx][0];
        centroids[c * 3 + 1] = samples[farIdx][1];
        centroids[c * 3 + 2] = samples[farIdx][2];
      }
    }
  }

  // 全対象画素にラベルを割り当て（対象外=-1）
  const labels = new Int32Array(N).fill(-1);
  for (let t = 0; t < numTargets; t++) {
    const i = targets[t];
    const b = i * 4;
    const r = data[b], g = data[b + 1], bl = data[b + 2];
    let bestC = 0;
    let bestD = Infinity;
    for (let c = 0; c < k; c++) {
      const dr = r - centroids[c * 3];
      const dg = g - centroids[c * 3 + 1];
      const db = bl - centroids[c * 3 + 2];
      const d = dr * dr + dg * dg + db * db;
      if (d < bestD) { bestD = d; bestC = c; }
    }
    labels[i] = bestC;
  }

  // --- ラベル平滑化: 3x3 多数決フィルタを2回（対象画素のみ） ---
  for (let pass = 0; pass < 2; pass++) {
    const newLabels = labels.slice();
    for (let t = 0; t < numTargets; t++) {
      const i = targets[t];
      const y = Math.floor(i / W);
      const x = i % W;
      // 近傍の対象画素のラベルを数える
      const votes = new Int32Array(k);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const ny = y + dy, nx = x + dx;
          if (ny < 0 || ny >= H || nx < 0 || nx >= W) continue;
          const ni = ny * W + nx;
          if (labels[ni] >= 0) votes[labels[ni]]++;
        }
      }
      let maxV = -1, bestL = labels[i];
      for (let c = 0; c < k; c++) {
        if (votes[c] > maxV) { maxV = votes[c]; bestL = c; }
      }
      newLabels[i] = bestL;
    }
    for (let t = 0; t < numTargets; t++) {
      const i = targets[t];
      labels[i] = newLabels[i];
    }
  }

  // --- 小領域の併合: 連結成分（4近傍・同ラベル）を洗い出す ---
  const compId = new Int32Array(N).fill(-1);
  // 各連結成分の情報
  const compLabel = []; // 成分のラベル
  const compSize  = []; // 成分の画素数
  let numComps = 0;

  // Union-Find（BFS）で連結成分を列挙
  const queue = new Int32Array(numTargets);
  for (let t = 0; t < numTargets; t++) {
    const i = targets[t];
    if (compId[i] >= 0) continue;
    // BFS
    const cid = numComps++;
    compLabel.push(labels[i]);
    compSize.push(0);
    let head = 0, tail = 0;
    queue[tail++] = i;
    compId[i] = cid;
    while (head < tail) {
      const cur = queue[head++];
      compSize[cid]++;
      const cy = Math.floor(cur / W);
      const cx = cur % W;
      // 4近傍
      const neighbors = [
        cy > 0     ? cur - W : -1,
        cy < H - 1 ? cur + W : -1,
        cx > 0     ? cur - 1 : -1,
        cx < W - 1 ? cur + 1 : -1,
      ];
      for (let n = 0; n < 4; n++) {
        const ni = neighbors[n];
        if (ni < 0 || compId[ni] >= 0 || labels[ni] < 0) continue;
        if (labels[ni] === labels[cur]) {
          compId[ni] = cid;
          queue[tail++] = ni;
        }
      }
    }
  }

  // 小成分の隣接成分で最多ラベルへ塗り替え（1パス）
  const minSize = minRegionFrac * numTargets;
  for (let cid = 0; cid < numComps; cid++) {
    if (compSize[cid] >= minSize) continue;
    // この成分の画素を走査し、隣接する別ラベルの画素を数える
    const neighborVotes = new Map();
    for (let t = 0; t < numTargets; t++) {
      const i = targets[t];
      if (compId[i] !== cid) continue;
      const cy = Math.floor(i / W);
      const cx = i % W;
      const neighbors = [
        cy > 0     ? i - W : -1,
        cy < H - 1 ? i + W : -1,
        cx > 0     ? i - 1 : -1,
        cx < W - 1 ? i + 1 : -1,
      ];
      for (let n = 0; n < 4; n++) {
        const ni = neighbors[n];
        if (ni < 0 || labels[ni] < 0 || labels[ni] === compLabel[cid]) continue;
        const lbl = labels[ni];
        neighborVotes.set(lbl, (neighborVotes.get(lbl) ?? 0) + 1);
      }
    }
    if (neighborVotes.size === 0) continue;
    // 最多ラベルを選択
    let bestLbl = compLabel[cid], bestVote = -1;
    for (const [lbl, v] of neighborVotes) {
      if (v > bestVote) { bestVote = v; bestLbl = lbl; }
    }
    // 塗り替え
    for (let t = 0; t < numTargets; t++) {
      const i = targets[t];
      if (compId[i] === cid) labels[i] = bestLbl;
    }
  }

  // --- 境界抽出: 右または下の隣接対象画素とラベルが異なる画素を255に ---
  const boundary = new Uint8Array(N);
  for (let t = 0; t < numTargets; t++) {
    const i = targets[t];
    const y = Math.floor(i / W);
    const x = i % W;
    // 右隣
    if (x < W - 1 && labels[i + 1] >= 0 && labels[i + 1] !== labels[i]) {
      boundary[i] = 255;
    }
    // 下隣
    if (y < H - 1 && labels[i + W] >= 0 && labels[i + W] !== labels[i]) {
      boundary[i] = 255;
    }
  }

  // --- mask がある場合は外形線帯の中を0にする ---
  if (mask !== null) {
    const outline = maskOutline(mask, W, H);
    const band    = dilateMask(outline, W, H, 2);
    for (let i = 0; i < N; i++) {
      if (band[i] !== 0) boundary[i] = 0;
    }
  }

  return boundary;
}
