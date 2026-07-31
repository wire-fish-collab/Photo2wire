// contour.js — 二値マップの領域輪郭を「閉じたループ」として抽出・単純化する
//
// 従来の「境界画素をバラバラの線分として追跡→短い線分を捨てる」方式は、
// 単純化の途中で囲い線が千切れて写真の特徴が失われてしまう。ここでは
//   1. クラック追跡: 暗画素と明画素の間の格子辺を、暗領域を左手に見ながら
//      一周たどり、各ブロック（穴も含む）の輪郭を閉じた多角形として得る
//   2. Visvalingam–Whyatt 法で単純化: 「隣り合う2辺を1辺にまとめる」＝
//      面積寄与が最小の頂点から順に取り除く。凸凹は徐々に減るが、
//      ループは閉じたまま決して途切れない
//   3. 周長が短すぎるループだけを丸ごと除去（部分的な欠けは起きない）
//
// clipBand を渡した場合（被写体の外形線と重なる部分の除去用）:
// ループのうち帯の中を通る区間は外形線に任せて取り除き、残りを
// 「両端が外形線のそばで終わる開いた鎖」として返す。ブロックの囲いは
// 外形線＋鎖で保たれ、千切れにはならない（端点は一筆書き化の段階で
// 外形線に接続される）。

// 方向: 0=右(+x) 1=下(+y) 2=左(-x) 3=上(-y)
const DX = [1, 0, -1, 0];
const DY = [0, 1, 0, -1];

/**
 * @param {Uint8Array} bin - W*H の 0|255 マップ（255=領域）
 * @param {number} W
 * @param {number} H
 * @param {{ epsilonArea?: number, minPerimeter?: number, clipBand?: Uint8Array|null }} opts
 * @returns {Array<Array<[number,number]>>} ポリライン配列
 *   （閉ループは先頭点=末尾点、開いた鎖はそうでない）
 */
export function traceContours(bin, W, H, opts = {}) {
  const epsilonArea = opts.epsilonArea ?? 4;
  const minPerimeter = opts.minPerimeter ?? 20;
  const clipBand = opts.clipBand ?? null;

  const rings = traceRawLoops(bin, W, H);
  const out = [];
  for (const ring of rings) {
    const pieces = clipBand ? clipRing(ring, clipBand, W, H) : [{ pts: ring, closed: true }];
    for (const piece of pieces) {
      const simp = simplifyPath(piece.pts, epsilonArea, piece.closed);
      if (piece.closed) {
        if (simp.length < 3 || pathLen(simp, true) < minPerimeter) continue;
        simp.push([simp[0][0], simp[0][1]]);
        out.push(simp);
      } else {
        if (simp.length < 2 || pathLen(simp, false) < minPerimeter) continue;
        out.push(simp);
      }
    }
  }
  return out;
}

// クラック追跡で全ループを取り出す（各ループは閉じているが末尾に始点は重複させない）
function traceRawLoops(bin, W, H) {
  const CW = W + 1;
  const out1 = new Int8Array(CW * (H + 1)).fill(-1);
  const out2 = new Int8Array(CW * (H + 1)).fill(-1);

  const addEdge = (cx, cy, dir) => {
    const c = cy * CW + cx;
    if (out1[c] < 0) out1[c] = dir;
    else out2[c] = dir;
  };

  // 暗画素の各辺のうち、隣が暗でないものを「暗を左手に見る向き」で登録
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!bin[i]) continue;
      if (y === 0 || !bin[i - W]) addEdge(x + 1, y, 2);         // 上辺: 左向き
      if (y === H - 1 || !bin[i + W]) addEdge(x, y + 1, 0);     // 下辺: 右向き
      if (x === 0 || !bin[i - 1]) addEdge(x, y, 1);             // 左辺: 下向き
      if (x === W - 1 || !bin[i + 1]) addEdge(x + 1, y + 1, 3); // 右辺: 上向き
    }
  }

  const takeEdge = (c, prevDir) => {
    // 同じ領域に沿い続けるため 左折 > 直進 > 右折 の順で選ぶ
    const prefs = prevDir < 0
      ? [0, 1, 2, 3]
      : [(prevDir + 3) % 4, prevDir, (prevDir + 1) % 4];
    for (const d of prefs) {
      if (out1[c] === d) { out1[c] = -1; return d; }
      if (out2[c] === d) { out2[c] = -1; return d; }
    }
    return -1;
  };

  const loops = [];
  for (let cy = 0; cy <= H; cy++) {
    for (let cx = 0; cx <= W; cx++) {
      if (out1[cy * CW + cx] < 0 && out2[cy * CW + cx] < 0) continue;
      const pts = [[cx, cy]];
      let x = cx, y = cy, dir = -1;
      for (;;) {
        dir = takeEdge(y * CW + x, dir);
        if (dir < 0) break; // 出発点に戻り閉じた
        x += DX[dir];
        y += DY[dir];
        // 直進の連続は中間点を作らない
        const n = pts.length;
        if (n >= 2 &&
            ((pts[n - 1][0] === pts[n - 2][0] && pts[n - 1][0] === x) ||
             (pts[n - 1][1] === pts[n - 2][1] && pts[n - 1][1] === y))) {
          pts[n - 1][0] = x;
          pts[n - 1][1] = y;
        } else {
          pts.push([x, y]);
        }
      }
      if (pts.length >= 4 &&
          pts[pts.length - 1][0] === pts[0][0] && pts[pts.length - 1][1] === pts[0][1]) {
        pts.pop();
      }
      if (pts.length >= 3) loops.push(pts);
    }
  }
  return loops;
}

// ループを帯（band）で切り分ける。帯の外の区間を開いた鎖として返す。
// 全点が帯の外なら閉ループのまま返し、全点が帯の中なら空を返す
function clipRing(ring, band, W, H) {
  const n = ring.length;
  const near = new Uint8Array(n);
  let nearCount = 0;
  for (let i = 0; i < n; i++) {
    const x = Math.min(W - 1, Math.max(0, ring[i][0]));
    const y = Math.min(H - 1, Math.max(0, ring[i][1]));
    if (band[y * W + x]) { near[i] = 1; nearCount++; }
  }
  if (nearCount === 0) return [{ pts: ring, closed: true }];
  if (nearCount === n) return [];

  // near な点から歩き始め、far の連続区間を鎖として切り出す
  // （鎖の両端には隣接する near 点を1つずつ含め、外形線のそばまで届かせる）
  let s = 0;
  while (!near[s]) s++;
  const pieces = [];
  let i = s;
  let steps = 0;
  while (steps < n) {
    i = (i + 1) % n;
    steps++;
    if (!near[i]) {
      const chain = [ring[(i - 1 + n) % n]];
      while (!near[i] && steps < n + 1) {
        chain.push(ring[i]);
        i = (i + 1) % n;
        steps++;
      }
      chain.push(ring[i]);
      pieces.push({ pts: chain, closed: false });
    }
  }
  return pieces;
}

// Visvalingam–Whyatt 法:
// 「前後の頂点と作る三角形の面積」が最小の頂点を取り除く
// （＝隣り合う2辺を1辺にまとめる）。epsilonArea に達するまで繰り返す。
// closed=true ならループとして扱い最低4点残す。
// closed=false なら両端点は固定し、間だけを単純化する
function simplifyPath(pts, epsilonArea, closed) {
  const n = pts.length;
  const minCount = closed ? 4 : 2;
  if (n <= minCount) return pts.map((p) => [p[0], p[1]]);

  const prev = new Int32Array(n);
  const next = new Int32Array(n);
  const area = new Float64Array(n).fill(Infinity); // 端点は取り除かない
  const alive = new Uint8Array(n).fill(1);
  let count = n;

  for (let i = 0; i < n; i++) {
    prev[i] = (i - 1 + n) % n;
    next[i] = (i + 1) % n;
  }
  const triArea = (i) => {
    const a = pts[prev[i]], b = pts[i], c = pts[next[i]];
    return Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
  };
  const first = 0, last = n - 1;
  for (let i = 0; i < n; i++) {
    if (!closed && (i === first || i === last)) continue;
    area[i] = triArea(i);
  }

  for (;;) {
    if (count <= minCount) break;
    let min = Infinity, mi = -1;
    for (let i = 0; i < n; i++) {
      if (alive[i] && area[i] < min) { min = area[i]; mi = i; }
    }
    if (mi < 0 || min >= epsilonArea) break;
    alive[mi] = 0;
    count--;
    const p = prev[mi], q = next[mi];
    next[p] = q;
    prev[q] = p;
    if (alive[p] && (closed || (p !== first && p !== last))) area[p] = triArea(p);
    if (alive[q] && (closed || (q !== first && q !== last))) area[q] = triArea(q);
  }

  const out = [];
  if (closed) {
    let start = 0;
    while (!alive[start]) start++;
    let cur = start;
    do {
      out.push([pts[cur][0], pts[cur][1]]);
      cur = next[cur];
    } while (cur !== start);
  } else {
    let cur = first;
    for (;;) {
      out.push([pts[cur][0], pts[cur][1]]);
      if (cur === last) break;
      cur = next[cur];
    }
  }
  return out;
}

function pathLen(pts, closed) {
  let len = 0;
  for (let i = 1; i < pts.length; i++) {
    len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  }
  if (closed && pts.length > 1) {
    const a = pts[pts.length - 1], b = pts[0];
    len += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return len;
}
