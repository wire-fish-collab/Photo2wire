// vectorize.js — 2値エッジマップをポリライン配列に変換する

// 8近傍のオフセット（dx, dy）
const DX = [-1, 0, 1, -1, 1, -1, 0, 1];
const DY = [-1, -1, -1, 0, 0, 1, 1, 1];

/**
 * Zhang-Suen細線化アルゴリズム
 * 入力binを破壊せずコピーして処理し、1px幅の骨格を返す
 * @param {Uint8Array} bin
 * @param {number} W
 * @param {number} H
 * @returns {Uint8Array}
 */
function zhangSuenThin(bin, W, H) {
  // 0=背景、1=前景 で処理（コピーして変換）
  const g = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) g[i] = bin[i] ? 1 : 0;

  // P2..P9 の並び（時計回り、P2=上）
  // P9 P2 P3
  // P8 P1 P4
  // P7 P6 P5
  const offsets = [-W, -W + 1, 1, W + 1, W, W - 1, -1, -W - 1];

  let changed = true;
  while (changed) {
    changed = false;
    // サブイテレーション1・2 の削除候補を収集してから一括削除
    for (let sub = 0; sub < 2; sub++) {
      const toDelete = [];
      for (let y = 1; y < H - 1; y++) {
        for (let x = 1; x < W - 1; x++) {
          const i = y * W + x;
          if (g[i] === 0) continue;

          // P2..P9
          const p = offsets.map((o) => g[i + o] ? 1 : 0);
          const [p2, p3, p4, p5, p6, p7, p8, p9] = p;

          // 条件A: 2 <= B(P1) <= 6（前景近傍の数）
          const B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
          if (B < 2 || B > 6) continue;

          // 条件B: A(P1) == 1（0→1の遷移回数）
          const seq = [p2, p3, p4, p5, p6, p7, p8, p9, p2];
          let A = 0;
          for (let k = 0; k < 8; k++) if (seq[k] === 0 && seq[k + 1] === 1) A++;
          if (A !== 1) continue;

          if (sub === 0) {
            // 条件C: p2*p4*p6 == 0 かつ p4*p6*p8 == 0
            if (p2 * p4 * p6 !== 0) continue;
            if (p4 * p6 * p8 !== 0) continue;
          } else {
            // 条件C: p2*p4*p8 == 0 かつ p2*p6*p8 == 0
            if (p2 * p4 * p8 !== 0) continue;
            if (p2 * p6 * p8 !== 0) continue;
          }

          toDelete.push(i);
        }
      }
      if (toDelete.length > 0) {
        changed = true;
        for (const i of toDelete) g[i] = 0;
      }
    }
  }

  const result = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) result[i] = g[i] ? 255 : 0;
  return result;
}

/**
 * 指定画素の8近傍エッジ画素数を返す
 * @param {Uint8Array} g
 * @param {number} x
 * @param {number} y
 * @param {number} W
 * @param {number} H
 * @returns {number}
 */
function countNeighbors(g, x, y, W, H) {
  let count = 0;
  for (let k = 0; k < 8; k++) {
    const nx = x + DX[k], ny = y + DY[k];
    if (nx >= 0 && nx < W && ny >= 0 && ny < H && g[ny * W + nx]) count++;
  }
  return count;
}

/**
 * 画素インデックスをエンコードするユーティリティ
 * エッジ（2画素間の移動）の訪問管理に使う
 * @param {number} fromIdx
 * @param {number} toIdx
 * @returns {number} 小さい方 * (W*H) + 大きい方
 */
function edgeKey(a, b, N) {
  return a < b ? a * N + b : b * N + a;
}

/**
 * 指定点から未訪問の8近傍を辿ってポリラインを1本抽出する
 * @param {Uint8Array} g
 * @param {number} startIdx
 * @param {Set<number>} visitedEdges
 * @param {Set<number>} junctions
 * @param {number} W
 * @param {number} H
 * @returns {Array<[number,number]>} 点列
 */
function traceLine(g, startIdx, visitedEdges, junctions, W, H) {
  const N = W * H;
  const pts = [[startIdx % W, (startIdx / W) | 0]];
  let cur = startIdx;

  for (;;) {
    const cx = cur % W, cy = (cur / W) | 0;
    let nextIdx = -1;

    for (let k = 0; k < 8; k++) {
      const nx = cx + DX[k], ny = cy + DY[k];
      if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
      const ni = ny * W + nx;
      if (!g[ni]) continue;
      const ek = edgeKey(cur, ni, N);
      if (visitedEdges.has(ek)) continue;
      // 未訪問エッジを発見
      nextIdx = ni;
      break;
    }

    if (nextIdx === -1) break; // 行き止まり

    const ek = edgeKey(cur, nextIdx, N);
    visitedEdges.add(ek);
    pts.push([nextIdx % W, (nextIdx / W) | 0]);
    cur = nextIdx;

    // 分岐点に到達したら打ち切る
    if (junctions.has(cur)) break;
  }

  return pts;
}

/**
 * Douglas-Peucker法でポリラインを間引く
 * @param {Array<[number,number]>} pts
 * @param {number} epsilon 許容誤差（px）
 * @returns {Array<[number,number]>}
 */
function douglasPeucker(pts, epsilon) {
  if (pts.length <= 2) return pts;

  // 端点を結ぶ線分から最も遠い点を探す
  const [x1, y1] = pts[0];
  const [x2, y2] = pts[pts.length - 1];
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.hypot(dx, dy);

  let maxDist = 0, maxIdx = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, py] = pts[i];
    let d;
    if (len < 1e-10) {
      d = Math.hypot(px - x1, py - y1);
    } else {
      // 点から線分への垂線距離
      d = Math.abs(dy * px - dx * py + x2 * y1 - y2 * x1) / len;
    }
    if (d > maxDist) { maxDist = d; maxIdx = i; }
  }

  if (maxDist <= epsilon) {
    return [pts[0], pts[pts.length - 1]];
  }

  const left = douglasPeucker(pts.slice(0, maxIdx + 1), epsilon);
  const right = douglasPeucker(pts.slice(maxIdx), epsilon);
  return left.slice(0, -1).concat(right);
}

/**
 * ポリライン（折れ線）の総延長を計算する
 * @param {Array<[number,number]>} pts
 * @returns {number}
 */
function polylineLength(pts) {
  let len = 0;
  for (let i = 1; i < pts.length; i++) {
    len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  }
  return len;
}

/**
 * 2値エッジマップをポリライン配列に変換する
 * @param {Uint8Array} bin - 0|255 の2値エッジマップ（W*H）
 * @param {number} W
 * @param {number} H
 * @param {{ epsilon?: number, minLength?: number }} opts
 * @returns {Array<Array<[number,number]>>}
 */
export function vectorize(bin, W, H, opts = {}) {
  const epsilon = opts.epsilon ?? 2;
  const minLength = opts.minLength ?? 12;

  // Zhang-Suen細線化
  const thin = zhangSuenThin(bin, W, H);

  // 各画素の8近傍エッジ数を事前計算し、端点・分岐点を分類
  const neighbors = new Uint8Array(W * H);
  const edgePixels = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!thin[i]) continue;
      edgePixels.push(i);
      neighbors[i] = countNeighbors(thin, x, y, W, H);
    }
  }

  // 端点（近傍1以下）と分岐点（近傍3以上）を特定
  const endpoints = new Set();
  const junctions = new Set();
  for (const i of edgePixels) {
    const n = neighbors[i];
    if (n <= 1) endpoints.add(i);
    else if (n >= 3) junctions.add(i);
  }

  const visitedEdges = new Set();
  const polylines = [];

  // 端点および分岐点を起点にして線を追跡
  const startPoints = [...endpoints, ...junctions];
  for (const start of startPoints) {
    // 起点からの未訪問エッジがある間、繰り返し追跡
    for (;;) {
      const cx = start % W, cy = (start / W) | 0;
      let hasUnvisited = false;
      const N = W * H;
      for (let k = 0; k < 8; k++) {
        const nx = cx + DX[k], ny = cy + DY[k];
        if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
        const ni = ny * W + nx;
        if (!thin[ni]) continue;
        if (!visitedEdges.has(edgeKey(start, ni, N))) {
          hasUnvisited = true;
          break;
        }
      }
      if (!hasUnvisited) break;

      const pts = traceLine(thin, start, visitedEdges, junctions, W, H);
      if (pts.length >= 2) polylines.push(pts);
    }
  }

  // 残った未訪問画素（孤立閉ループ）を追跡
  for (const i of edgePixels) {
    if (endpoints.has(i) || junctions.has(i)) continue;
    // この画素から出る未訪問エッジが残っているか確認
    const N = W * H;
    const cx = i % W, cy = (i / W) | 0;
    let hasUnvisited = false;
    for (let k = 0; k < 8; k++) {
      const nx = cx + DX[k], ny = cy + DY[k];
      if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
      const ni = ny * W + nx;
      if (!thin[ni]) continue;
      if (!visitedEdges.has(edgeKey(i, ni, N))) {
        hasUnvisited = true;
        break;
      }
    }
    if (!hasUnvisited) continue;

    // 閉ループとして一周追跡（分岐点なしとして空Setを渡す）
    const pts = traceLine(thin, i, visitedEdges, new Set(), W, H);
    if (pts.length >= 2) {
      // 閉ループは始点と終点を同じにする
      pts.push(pts[0]);
      polylines.push(pts);
    }
  }

  // Douglas-Peucker 間引き＋最小長フィルタ
  const result = [];
  for (const pts of polylines) {
    const simplified = douglasPeucker(pts, epsilon);
    if (simplified.length >= 2 && polylineLength(simplified) >= minLength) {
      result.push(simplified);
    }
  }

  return result;
}
