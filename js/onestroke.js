// onestroke.js — 一筆書き化
// ポリライン群を 1本の連続した線に連結する。
//   1. 近接する端点同士のポリラインを事前結合（つなぎ線を減らす）
//   2. 貪欲最近傍法で全ポリラインを順に連結（間は「つなぎ線」= bridge）
//   3. 2-opt でつなぎ線の総延長を改善
//   4. Chaikin 法で各線をなめらかに
//
// 戻り値: { segments: [{pts:[[x,y],...], bridge:boolean}], totalLengthPx, bridgeLengthPx }
// segments は連続（前セグメントの末尾点 = 次セグメントの先頭点）

function dist(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function pathLength(pts) {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += dist(pts[i - 1], pts[i]);
  return len;
}

export function makeOneStroke(polylines, opts = {}) {
  const snapRadius = opts.snapRadius ?? 6;
  const smoothing = opts.smoothing ?? 2;

  let strokes = polylines
    .filter((p) => p.length >= 2)
    .map((p) => p.map((pt) => [pt[0], pt[1]]));
  if (strokes.length === 0) {
    return { segments: [], totalLengthPx: 0, bridgeLengthPx: 0 };
  }

  strokes = joinNearbyStrokes(strokes, snapRadius);
  let seq = greedyChain(strokes);
  seq = twoOpt(seq);

  // 向きを解決した点列に変換してからスムージング
  const resolved = seq.map((s) => {
    const pts = s.flip ? s.pts.slice().reverse() : s.pts;
    return chaikin(pts, smoothing);
  });

  // つなぎ線を挟みつつセグメント列を構築（端点は完全一致させる）
  const segments = [];
  let totalLengthPx = 0;
  let bridgeLengthPx = 0;
  for (let i = 0; i < resolved.length; i++) {
    if (i > 0) {
      const prev = resolved[i - 1][resolved[i - 1].length - 1];
      const head = resolved[i][0];
      const d = dist(prev, head);
      if (d > 0.01) {
        segments.push({ pts: [prev, head], bridge: true });
        totalLengthPx += d;
        bridgeLengthPx += d;
      }
    }
    segments.push({ pts: resolved[i], bridge: false });
    totalLengthPx += pathLength(resolved[i]);
  }
  return { segments, totalLengthPx, bridgeLengthPx };
}

// 端点同士が snapRadius 以内のポリラインを結合して本数を減らす
function joinNearbyStrokes(strokes, snapRadius) {
  const list = strokes.slice();
  for (;;) {
    let best = null;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        const ends = [
          [a[a.length - 1], b[0], false, false],           // a末尾 → b先頭
          [a[a.length - 1], b[b.length - 1], false, true], // a末尾 → b末尾(反転)
          [a[0], b[0], true, false],                       // a先頭(反転) → b先頭
          [a[0], b[b.length - 1], true, true],
        ];
        for (const [pa, pb, flipA, flipB] of ends) {
          const d = dist(pa, pb);
          if (d <= snapRadius && (!best || d < best.d)) {
            best = { d, i, j, flipA, flipB };
          }
        }
      }
    }
    if (!best) return list;
    let a = list[best.i], b = list[best.j];
    if (best.flipA) a = a.slice().reverse();
    if (best.flipB) b = b.slice().reverse();
    // 端点間に隙間があれば b の先頭点をそのまま繋ぐ（線としては連続扱い）
    const joined = a.concat(dist(a[a.length - 1], b[0]) < 0.01 ? b.slice(1) : b);
    list.splice(best.j, 1);
    list.splice(best.i, 1);
    list.push(joined);
  }
}

// {pts, flip} の列。head/tail は向きを考慮した端点
function head(s) { return s.flip ? s.pts[s.pts.length - 1] : s.pts[0]; }
function tail(s) { return s.flip ? s.pts[0] : s.pts[s.pts.length - 1]; }

// 最長ポリラインから開始し、末尾に最も近い端点を持つ線を順に繋ぐ
function greedyChain(strokes) {
  const remaining = strokes.map((pts) => ({ pts, flip: false }));
  remaining.sort((a, b) => pathLength(b.pts) - pathLength(a.pts));
  const seq = [remaining.shift()];
  while (remaining.length > 0) {
    const cur = tail(seq[seq.length - 1]);
    let bestIdx = 0, bestFlip = false, bestD = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const s = remaining[i];
      const dHead = dist(cur, s.pts[0]);
      const dTail = dist(cur, s.pts[s.pts.length - 1]);
      if (dHead < bestD) { bestD = dHead; bestIdx = i; bestFlip = false; }
      if (dTail < bestD) { bestD = dTail; bestIdx = i; bestFlip = true; }
    }
    const next = remaining.splice(bestIdx, 1)[0];
    next.flip = bestFlip;
    seq.push(next);
  }
  return seq;
}

// 2-opt: 部分列 [i..j] を反転（順序と各線の向きを反転）してつなぎ線を短縮
function twoOpt(seq, maxPasses = 30) {
  const n = seq.length;
  if (n < 3) return seq;
  for (let pass = 0; pass < maxPasses; pass++) {
    let improved = false;
    for (let i = 1; i < n; i++) {
      for (let j = i; j < n; j++) {
        const leftOld = dist(tail(seq[i - 1]), head(seq[i]));
        const rightOld = j < n - 1 ? dist(tail(seq[j]), head(seq[j + 1])) : 0;
        // 反転後: seq[j] が向きを変えて i の位置に来る
        const leftNew = dist(tail(seq[i - 1]), tail(seq[j]));
        const rightNew = j < n - 1 ? dist(head(seq[i]), head(seq[j + 1])) : 0;
        if (leftNew + rightNew < leftOld + rightOld - 1e-6) {
          const sub = seq.slice(i, j + 1).reverse();
          for (const s of sub) s.flip = !s.flip;
          seq.splice(i, j - i + 1, ...sub);
          improved = true;
        }
      }
    }
    if (!improved) break;
  }
  return seq;
}

// Chaikin 法（端点保持・開いた線用）
function chaikin(pts, iterations) {
  let cur = pts;
  for (let it = 0; it < iterations; it++) {
    if (cur.length < 3) break;
    const out = [cur[0]];
    for (let i = 0; i < cur.length - 1; i++) {
      const p = cur[i], q = cur[i + 1];
      out.push([0.75 * p[0] + 0.25 * q[0], 0.75 * p[1] + 0.25 * q[1]]);
      out.push([0.25 * p[0] + 0.75 * q[0], 0.25 * p[1] + 0.75 * q[1]]);
    }
    out.push(cur[cur.length - 1]);
    cur = out;
  }
  return cur;
}
