// edge.js — エッジ検出（DoG法）とマスク輪郭抽出

/**
 * グレースケール化して Float32Array を返す
 * @param {ImageData} imageData
 * @returns {Float32Array}
 */
function toGray(imageData) {
  const { data, width, height } = imageData;
  const n = width * height;
  const gray = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const b = i * 4;
    gray[i] = 0.299 * data[b] + 0.587 * data[b + 1] + 0.114 * data[b + 2];
  }
  return gray;
}

/**
 * 1次元ガウシアンカーネルを生成する
 * @param {number} sigma
 * @returns {Float32Array}
 */
function makeGaussKernel(sigma) {
  const radius = Math.ceil(3 * sigma);
  const size = 2 * radius + 1;
  const k = new Float32Array(size);
  let sum = 0;
  for (let i = 0; i < size; i++) {
    const x = i - radius;
    k[i] = Math.exp(-(x * x) / (2 * sigma * sigma));
    sum += k[i];
  }
  for (let i = 0; i < size; i++) k[i] /= sum;
  return k;
}

/**
 * 分離型ガウシアンぼかし（水平 → 垂直、境界はクランプ）
 * @param {Float32Array} src
 * @param {number} W
 * @param {number} H
 * @param {Float32Array} kernel
 * @returns {Float32Array}
 */
function gaussBlur(src, W, H, kernel) {
  const radius = (kernel.length - 1) / 2;
  const tmp = new Float32Array(W * H);
  const dst = new Float32Array(W * H);

  // 水平方向
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let v = 0;
      for (let k = 0; k < kernel.length; k++) {
        const sx = Math.max(0, Math.min(W - 1, x + k - radius));
        v += src[y * W + sx] * kernel[k];
      }
      tmp[y * W + x] = v;
    }
  }

  // 垂直方向
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let v = 0;
      for (let k = 0; k < kernel.length; k++) {
        const sy = Math.max(0, Math.min(H - 1, y + k - radius));
        v += tmp[sy * W + x] * kernel[k];
      }
      dst[y * W + x] = v;
    }
  }

  return dst;
}

/**
 * マスクを3x3正方形構造要素で侵食（erosion）する
 * @param {Uint8Array} mask
 * @param {number} W
 * @param {number} H
 * @param {number} iterations 侵食の回数
 * @returns {Uint8Array}
 */
function erodeMask(mask, W, H, iterations) {
  let src = mask.slice();
  const dst = new Uint8Array(W * H);
  for (let it = 0; it < iterations; it++) {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        // 3x3近傍のすべてが255のときのみ255を維持
        let ok = true;
        outer: for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const ny = y + dy, nx = x + dx;
            if (ny < 0 || ny >= H || nx < 0 || nx >= W || src[ny * W + nx] === 0) {
              ok = false;
              break outer;
            }
          }
        }
        dst[i] = ok ? 255 : 0;
      }
    }
    src = dst.slice();
  }
  return src;
}

/**
 * DoG（Difference of Gaussians）法でエッジを検出する
 * @param {ImageData} imageData - 入力画像
 * @param {{ sigma?: number, k?: number, threshold?: number, mask?: Uint8Array|null }} opts
 * @returns {Uint8Array} エッジマップ（エッジ画素=255、他=0）
 */
export function detectEdges(imageData, opts = {}) {
  const sigma = opts.sigma ?? 1.4;
  const k = opts.k ?? 1.6;
  const threshold = opts.threshold ?? 6;
  const mask = opts.mask ?? null;
  const { width: W, height: H } = imageData;

  const gray = toGray(imageData);
  const k1 = makeGaussKernel(sigma);
  const k2 = makeGaussKernel(k * sigma);
  const blur1 = gaussBlur(gray, W, H, k1);
  const blur2 = gaussBlur(gray, W, H, k2);

  // マスクがある場合は3px侵食して有効領域を縮める
  const eroded = mask ? erodeMask(mask, W, H, 3) : null;

  const edges = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    // maskが指定されていて侵食済み領域外の画素は無効
    if (eroded && eroded[i] === 0) continue;
    if (blur1[i] - blur2[i] > threshold) {
      edges[i] = 255;
    }
  }
  return edges;
}

/**
 * マスクの輪郭画素（エッジ）を抽出する
 * @param {Uint8Array} mask - 0|255 のマスク（W*H）
 * @param {number} W
 * @param {number} H
 * @returns {Uint8Array} 輪郭マップ（輪郭画素=255、他=0）
 */
export function maskOutline(mask, W, H) {
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (mask[i] === 0) continue;
      // 4近傍のいずれかが0または画像端なら輪郭画素
      const hasEdge =
        x === 0 || mask[i - 1] === 0 ||
        x === W - 1 || mask[i + 1] === 0 ||
        y === 0 || mask[i - W] === 0 ||
        y === H - 1 || mask[i + W] === 0;
      if (hasEdge) out[i] = 255;
    }
  }
  return out;
}
