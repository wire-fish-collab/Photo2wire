// segment.js — AI被写体切り抜き（onnxruntime-web / どちらのモデルも Apache-2.0）
// ort はグローバル（index.html で CDN から読み込み済み）

const ORT_CDN = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/';

const MODELS = {
  // 軽量・標準（U2-Netp 4.6MB）
  u2netp: {
    url: new URL('../models/u2netp.onnx', import.meta.url).href,
    inputSize: 320,
    mean: [0.485, 0.456, 0.406],
    std: [0.229, 0.224, 0.225],
  },
  // 高精度・影に強い（ISNet general use 170MB。GitHubの100MB制限のため2分割で同梱）
  isnet: {
    parts: [
      new URL('../models/isnet-general-use.onnx.partaa', import.meta.url).href,
      new URL('../models/isnet-general-use.onnx.partab', import.meta.url).href,
    ],
    inputSize: 1024,
    mean: [0.5, 0.5, 0.5],
    std: [1, 1, 1],
  },
};

// WebGPU が一度失敗したら以後は wasm を使う（無駄な再試行と
// 失敗セッションのメモリ滞留を防ぐ）。depth.js とも共有する
let preferredEP = 'webgpu';
export function getPreferredEP() { return preferredEP; }
export function notePreferWasm() { preferredEP = 'wasm'; }

// モデルを取得して Uint8Array で返す。分割ファイルは結合し、
// Cache Storage に保存して再訪時の再ダウンロードを防ぐ
export async function fetchBuffers(urls) {
  let cache = null;
  try {
    cache = await caches.open('photo2wire-models');
  } catch (e) { /* Cache Storage が使えない環境では毎回取得 */ }

  const buffers = [];
  for (const u of urls) {
    let resp = cache ? await cache.match(u) : null;
    if (!resp) {
      resp = await fetch(u);
      if (!resp.ok) throw new Error(`モデルの取得に失敗しました: ${u}`);
      if (cache) await cache.put(u, resp.clone());
    }
    buffers.push(new Uint8Array(await resp.arrayBuffer()));
  }
  if (buffers.length === 1) return buffers[0];
  const total = buffers.reduce((s, b) => s + b.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const b of buffers) { out.set(b, off); off += b.length; }
  return out;
}

const sessions = new Map(); // `${name}:${ep}` -> Promise<InferenceSession>

export function loadModel(name = 'u2netp', ep = preferredEP) {
  const key = `${name}:${ep}`;
  if (!sessions.has(key)) {
    ort.env.wasm.wasmPaths = ORT_CDN;
    const urls = MODELS[name].parts ?? [MODELS[name].url];
    sessions.set(key, fetchBuffers(urls).then((buf) =>
      ort.InferenceSession.create(buf, { executionProviders: [ep] })
    ));
  }
  return sessions.get(key);
}

// WebGPU は一部の演算（ceil_mode の MaxPool 等）が未対応でモデル作成後の
// 実行時に失敗することがあるため、実行段階でも wasm へフォールバックする
async function runWithFallback(modelName, session, tensor) {
  try {
    const results = await session.run({ [session.inputNames[0]]: tensor });
    return results[session.outputNames[0]].data;
  } catch (e) {
    console.warn(`webgpu実行に失敗、wasmで再試行します: ${e.message}`);
    notePreferWasm();
    // 失敗した webgpu セッションは解放してメモリ滞留を防ぐ
    try { session.release(); } catch (_) { /* 解放失敗は無視 */ }
    sessions.delete(`${modelName}:webgpu`);
    const s = await loadModel(modelName, 'wasm');
    const results = await s.run({ [s.inputNames[0]]: tensor });
    return results[s.outputNames[0]].data;
  }
}

// srcCanvas の主要被写体を判定し、同サイズの 0/255 マスクを返す
export async function segmentSubject(srcCanvas, modelName = 'u2netp') {
  const model = MODELS[modelName] ?? MODELS.u2netp;
  let session;
  try {
    session = await loadModel(modelName, preferredEP);
  } catch (e) {
    notePreferWasm();
    session = await loadModel(modelName, 'wasm');
  }
  const W = srcCanvas.width, H = srcCanvas.height;
  const S = model.inputSize;

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
      input[c * n + i] = (data[i * 4 + c] / 255 - model.mean[c]) / model.std[c];
    }
  }

  const tensor = new ort.Tensor('float32', input, [1, 3, S, S]);
  const out = await runWithFallback(modelName, session, tensor); // 1x1xSxS

  // min-max 正規化して 0..1 に
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < n; i++) {
    if (out[i] < mn) mn = out[i];
    if (out[i] > mx) mx = out[i];
  }
  const range = mx - mn || 1;

  // バイリニア補間で W×H に拡大しつつ 2値化
  const mask = new Uint8Array(W * H);
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
      mask[y * W + x] = (v - mn) / range >= 0.5 ? 255 : 0;
    }
  }

  keepLargestComponent(mask, W, H);
  fillSmallHoles(mask, W, H);
  return mask;
}

// 最大連結成分（4近傍）だけを残す
function keepLargestComponent(mask, W, H) {
  const label = new Int32Array(W * H); // 0=未訪問
  const stack = new Int32Array(W * H);
  let bestLabel = 0, bestSize = 0, cur = 0;

  for (let start = 0; start < W * H; start++) {
    if (mask[start] === 0 || label[start] !== 0) continue;
    cur++;
    let size = 0, top = 0;
    stack[top++] = start;
    label[start] = cur;
    while (top > 0) {
      const p = stack[--top];
      size++;
      const x = p % W, y = (p / W) | 0;
      if (x > 0 && mask[p - 1] && !label[p - 1]) { label[p - 1] = cur; stack[top++] = p - 1; }
      if (x < W - 1 && mask[p + 1] && !label[p + 1]) { label[p + 1] = cur; stack[top++] = p + 1; }
      if (y > 0 && mask[p - W] && !label[p - W]) { label[p - W] = cur; stack[top++] = p - W; }
      if (y < H - 1 && mask[p + W] && !label[p + W]) { label[p + W] = cur; stack[top++] = p + W; }
    }
    if (size > bestSize) { bestSize = size; bestLabel = cur; }
  }
  for (let i = 0; i < W * H; i++) {
    mask[i] = label[i] === bestLabel ? 255 : 0;
  }
}

// 小さな穴（ノイズ）だけを塗りつぶす。
// 脚の間・持ち手の内側など大きな「隙間」は被写体の形として残す
function fillSmallHoles(mask, W, H) {
  let maskArea = 0;
  for (let i = 0; i < W * H; i++) if (mask[i]) maskArea++;
  const maxHoleArea = Math.max(64, maskArea * 0.005);

  // 外周から到達できる背景を marked=1 にする
  const marked = new Uint8Array(W * H);
  const stack = [];
  for (let x = 0; x < W; x++) {
    stack.push(x, (H - 1) * W + x);
  }
  for (let y = 0; y < H; y++) {
    stack.push(y * W, y * W + W - 1);
  }
  while (stack.length > 0) {
    const p = stack.pop();
    if (marked[p] || mask[p]) continue;
    marked[p] = 1;
    const x = p % W, y = (p / W) | 0;
    if (x > 0) stack.push(p - 1);
    if (x < W - 1) stack.push(p + 1);
    if (y > 0) stack.push(p - W);
    if (y < H - 1) stack.push(p + W);
  }

  // 到達できなかった背景 = 穴。面積が小さいものだけ塗る
  for (let start = 0; start < W * H; start++) {
    if (mask[start] || marked[start]) continue;
    const hole = [];
    const st = [start];
    marked[start] = 1;
    while (st.length > 0) {
      const p = st.pop();
      hole.push(p);
      const x = p % W, y = (p / W) | 0;
      for (const q of [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, y > 0 ? p - W : -1, y < H - 1 ? p + W : -1]) {
        if (q >= 0 && !mask[q] && !marked[q]) { marked[q] = 1; st.push(q); }
      }
    }
    if (hole.length <= maxHoleArea) {
      for (const p of hole) mask[p] = 255;
    }
  }
}
