// depth.js — 奥行き推定による立体境界の抽出
// Depth Anything V2 Small 量子化版（Apache-2.0）をブラウザで実行し、
// 奥行きが急に変わる場所（腕と体の重なりなど）を線として取り出す。

import { maskOutline, dilateMask } from './edge.js';
import { fetchBuffers, getPreferredEP, notePreferWasm } from './segment.js';

const MODEL_URL = new URL('../../models/depth-anything-v2-small-q8.onnx', import.meta.url).href;
const S = 518; // モデル入力サイズ（14の倍数）
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

const sessions = new Map(); // ep -> Promise<InferenceSession>

function loadDepthModel(ep) {
  if (!sessions.has(ep)) {
    sessions.set(ep, fetchBuffers([MODEL_URL]).then((buf) =>
      ort.InferenceSession.create(buf, { executionProviders: [ep] })
    ));
  }
  return sessions.get(ep);
}

// srcCanvas の奥行きマップ（W*H、0..1 に正規化。大きいほど手前）を返す
export async function computeDepth(srcCanvas) {
  const W = srcCanvas.width, H = srcCanvas.height;

  const tmp = document.createElement('canvas');
  tmp.width = S;
  tmp.height = S;
  const tctx = tmp.getContext('2d');
  tctx.drawImage(srcCanvas, 0, 0, S, S);
  const { data } = tctx.getImageData(0, 0, S, S);

  const n = S * S;
  const input = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) {
      input[c * n + i] = (data[i * 4 + c] / 255 - MEAN[c]) / STD[c];
    }
  }
  const tensor = new ort.Tensor('float32', input, [1, 3, S, S]);

  let session;
  try {
    session = await loadDepthModel(getPreferredEP());
  } catch (e) {
    notePreferWasm();
    session = await loadDepthModel('wasm');
  }
  let out;
  try {
    const results = await session.run({ [session.inputNames[0]]: tensor });
    out = results[session.outputNames[0]].data;
  } catch (e) {
    console.warn(`深度推定: webgpu実行に失敗、wasmで再試行します: ${e.message}`);
    notePreferWasm();
    try { session.release(); } catch (_) { /* 解放失敗は無視 */ }
    sessions.delete('webgpu');
    const s = await loadDepthModel('wasm');
    const results = await s.run({ [s.inputNames[0]]: tensor });
    out = results[s.outputNames[0]].data;
  }

  // min-max 正規化
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < n; i++) {
    if (out[i] < mn) mn = out[i];
    if (out[i] > mx) mx = out[i];
  }
  const range = mx - mn || 1;

  // バイリニア補間で W×H に拡大
  const depth = new Float32Array(W * H);
  const sx = (S - 1) / Math.max(W - 1, 1);
  const sy = (S - 1) / Math.max(H - 1, 1);
  for (let y = 0; y < H; y++) {
    const fy = y * sy;
    const y0 = Math.floor(fy), y1 = Math.min(y0 + 1, S - 1);
    const wy = fy - y0;
    for (let x = 0; x < W; x++) {
      const fx = x * sx;
      const x0 = Math.floor(fx), x1 = Math.min(x0 + 1, S - 1);
      const wx = fx - x0;
      const v =
        out[y0 * S + x0] * (1 - wx) * (1 - wy) +
        out[y0 * S + x1] * wx * (1 - wy) +
        out[y1 * S + x0] * (1 - wx) * wy +
        out[y1 * S + x1] * wx * wy;
      depth[y * W + x] = (v - mn) / range;
    }
  }
  return depth;
}

// 奥行きマップから「奥行きが急に変わる線」を抽出する
// depth: computeDepth の結果、opts: { threshold=0.04, mask=null }
export function depthEdges(depth, W, H, opts = {}) {
  const threshold = opts.threshold ?? 0.04;
  const mask = opts.mask ?? null;

  let boundaryBand = null;
  if (mask) {
    boundaryBand = dilateMask(maskOutline(mask, W, H), W, H, 2);
  }

  // Sobel 勾配の大きさ
  const g = new Float32Array(W * H);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      const gx =
        depth[i - W + 1] + 2 * depth[i + 1] + depth[i + W + 1] -
        depth[i - W - 1] - 2 * depth[i - 1] - depth[i + W - 1];
      const gy =
        depth[i + W - 1] + 2 * depth[i + W] + depth[i + W + 1] -
        depth[i - W - 1] - 2 * depth[i - W] - depth[i - W + 1];
      g[i] = Math.hypot(gx, gy);
    }
  }

  // 閾値 + リッジ細線化（DoG と同じ非最大抑制）
  const edges = new Uint8Array(W * H);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      if (mask && (mask[i] === 0 || boundaryBand[i] !== 0)) continue;
      if (g[i] <= threshold) continue;
      const isHorizMax = g[i] >= g[i - 1] && g[i] >= g[i + 1];
      const isVertMax = g[i] >= g[i - W] && g[i] >= g[i + W];
      if (isHorizMax || isVertMax) edges[i] = 255;
    }
  }
  return edges;
}
