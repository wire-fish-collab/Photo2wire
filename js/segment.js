// segment.js — AI被写体切り抜き（onnxruntime-web + U2-Netp / Apache-2.0）
// ort はグローバル（index.html で CDN から読み込み済み）

const MODEL_URL = new URL('../models/u2netp.onnx', import.meta.url).href;
const ORT_CDN = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.19.2/dist/';
const INPUT_SIZE = 320;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

let sessionPromise = null;

export function loadModel() {
  if (!sessionPromise) {
    ort.env.wasm.wasmPaths = ORT_CDN;
    sessionPromise = ort.InferenceSession.create(MODEL_URL, {
      executionProviders: ['wasm'],
    });
  }
  return sessionPromise;
}

// srcCanvas の主要被写体を判定し、同サイズの 0/255 マスクを返す
export async function segmentSubject(srcCanvas) {
  const session = await loadModel();
  const W = srcCanvas.width, H = srcCanvas.height;

  const tmp = document.createElement('canvas');
  tmp.width = INPUT_SIZE;
  tmp.height = INPUT_SIZE;
  const tctx = tmp.getContext('2d');
  tctx.drawImage(srcCanvas, 0, 0, INPUT_SIZE, INPUT_SIZE);
  const { data } = tctx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE);

  const n = INPUT_SIZE * INPUT_SIZE;
  const input = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) {
      input[c * n + i] = (data[i * 4 + c] / 255 - MEAN[c]) / STD[c];
    }
  }

  const tensor = new ort.Tensor('float32', input, [1, 3, INPUT_SIZE, INPUT_SIZE]);
  const results = await session.run({ [session.inputNames[0]]: tensor });
  const out = results[session.outputNames[0]].data; // d0: 1x1x320x320

  // min-max 正規化して 0..1 に
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < n; i++) {
    if (out[i] < mn) mn = out[i];
    if (out[i] > mx) mx = out[i];
  }
  const range = mx - mn || 1;

  // バイリニア補間で W×H に拡大しつつ 2値化
  const mask = new Uint8Array(W * H);
  const sx = (INPUT_SIZE - 1) / Math.max(W - 1, 1);
  const sy = (INPUT_SIZE - 1) / Math.max(H - 1, 1);
  for (let y = 0; y < H; y++) {
    const fy = y * sy;
    const y0 = Math.floor(fy), y1 = Math.min(y0 + 1, INPUT_SIZE - 1);
    const wy = fy - y0;
    for (let x = 0; x < W; x++) {
      const fx = x * sx;
      const x0 = Math.floor(fx), x1 = Math.min(x0 + 1, INPUT_SIZE - 1);
      const wx = fx - x0;
      const v =
        out[y0 * INPUT_SIZE + x0] * (1 - wx) * (1 - wy) +
        out[y0 * INPUT_SIZE + x1] * wx * (1 - wy) +
        out[y1 * INPUT_SIZE + x0] * (1 - wx) * wy +
        out[y1 * INPUT_SIZE + x1] * wx * wy;
      mask[y * W + x] = (v - mn) / range >= 0.5 ? 255 : 0;
    }
  }

  keepLargestComponent(mask, W, H);
  fillHoles(mask, W, H);
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

// 外周から到達できない背景（穴）を塗りつぶす
function fillHoles(mask, W, H) {
  const outside = new Uint8Array(W * H);
  const stack = [];
  for (let x = 0; x < W; x++) {
    if (!mask[x]) stack.push(x);
    if (!mask[(H - 1) * W + x]) stack.push((H - 1) * W + x);
  }
  for (let y = 0; y < H; y++) {
    if (!mask[y * W]) stack.push(y * W);
    if (!mask[y * W + W - 1]) stack.push(y * W + W - 1);
  }
  while (stack.length > 0) {
    const p = stack.pop();
    if (outside[p] || mask[p]) continue;
    outside[p] = 1;
    const x = p % W, y = (p / W) | 0;
    if (x > 0) stack.push(p - 1);
    if (x < W - 1) stack.push(p + 1);
    if (y > 0) stack.push(p - W);
    if (y < H - 1) stack.push(p + W);
  }
  for (let i = 0; i < W * H; i++) {
    if (!mask[i] && !outside[i]) mask[i] = 255;
  }
}
