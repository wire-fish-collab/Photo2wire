// onestroke.js — 一筆書き化（グラフ＋中国人郵便配達方式）
// ポリライン群をグラフとして扱い、1本の連続した線に変換する。
//   1. 近接する端点をスナップ統合して頂点にする
//   2. 行き止まりの端点（内部線の端など）は、最寄りの他の線上へ短い接続線
//      （垂線）を追加して繋ぐ。接続先の線はその点で分割して分岐点にする
//   3. 離れた成分同士も最短の接続線で連結する
//   4. 奇数次数の頂点をペアにして最短経路を「二重化」（同じ場所を往復）し、
//      オイラー路が存在するグラフにする（中国人郵便配達問題の考え方）
//   5. Hierholzer 法でオイラー路を求め、1本の線として出力
//
// 戻り値: { segments: [{pts:[[x,y],...], bridge:boolean}], totalLengthPx, bridgeLengthPx }
// segments は連続（前セグメントの末尾点 = 次セグメントの先頭点）。
// bridge=true は追加した接続線と往復（二重）区間で、色分け表示に使う。

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

  const input = polylines.filter((p) => p.length >= 2);
  if (input.length === 0) {
    return { segments: [], totalLengthPx: 0, bridgeLengthPx: 0 };
  }

  const g = new StrokeGraph(snapRadius);
  for (const pts of input) g.addPolyline(pts);

  g.connectDanglingEnds();
  g.connectComponents();
  g.smooth(smoothing);
  g.eulerize();
  return g.traverse();
}

class StrokeGraph {
  constructor(snapRadius) {
    this.snapRadius = snapRadius;
    this.verts = [];   // [x, y]
    // { u, v, pts, len, kind }  kind: 'line' | 'connector' | 'retrace'
    this.edges = [];
  }

  // 既存頂点に snapRadius 以内で吸着、なければ新規作成
  getVert(p) {
    for (let i = 0; i < this.verts.length; i++) {
      if (dist(this.verts[i], p) <= this.snapRadius) return i;
    }
    this.verts.push([p[0], p[1]]);
    return this.verts.length - 1;
  }

  // 幾何の端点を頂点座標に一致させて連続性を保証する
  makeEdge(u, v, pts, kind = 'line') {
    const g = pts.map((p) => [p[0], p[1]]);
    g[0] = [this.verts[u][0], this.verts[u][1]];
    g[g.length - 1] = [this.verts[v][0], this.verts[v][1]];
    return { u, v, pts: g, len: pathLength(g), kind };
  }

  addEdge(u, v, pts, kind = 'line') {
    this.edges.push(this.makeEdge(u, v, pts, kind));
  }

  addPolyline(pts) {
    const u = this.getVert(pts[0]);
    const v = this.getVert(pts[pts.length - 1]);
    this.addEdge(u, v, pts);
  }

  degrees() {
    const deg = new Array(this.verts.length).fill(0);
    for (const e of this.edges) { deg[e.u]++; deg[e.v]++; }
    return deg;
  }

  // 点 p から線分列 pts への最近接点（線分上への垂線の足）
  static nearestOnPolyline(p, pts) {
    let best = null;
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
      const dx = bx - ax, dy = by - ay;
      const l2 = dx * dx + dy * dy;
      const t = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / l2)) : 0;
      const q = [ax + t * dx, ay + t * dy];
      const d = dist(p, q);
      if (!best || d < best.d) best = { d, seg: i, t, q };
    }
    return best;
  }

  // 辺 ei を線分 seg 上の位置 t で分割し、分割点の頂点番号を返す。
  // 分割点が辺の端に十分近い場合は分割せず既存の端点を返す。
  // 既存の辺番号がずれないよう、前半は ei の位置に置き換え、後半を末尾に追加する
  splitEdge(ei, seg, t, q) {
    const e = this.edges[ei];
    if (dist(q, this.verts[e.u]) <= this.snapRadius) return e.u;
    if (dist(q, this.verts[e.v]) <= this.snapRadius) return e.v;
    this.verts.push([q[0], q[1]]);
    const w = this.verts.length - 1;
    const ptsA = e.pts.slice(0, seg + 1).concat([[q[0], q[1]]]);
    const ptsB = [[q[0], q[1]]].concat(e.pts.slice(seg + 1));
    this.edges[ei] = this.makeEdge(e.u, w, ptsA, e.kind);
    this.edges.push(this.makeEdge(w, e.v, ptsB, e.kind));
    return w;
  }

  // 頂点 vi から最寄りの他の辺への接続線（垂線）を追加する
  connectVertToNearestEdge(vi, excludeSelf = true) {
    const p = this.verts[vi];
    let best = null;
    for (let ei = 0; ei < this.edges.length; ei++) {
      const e = this.edges[ei];
      if (excludeSelf && (e.u === vi || e.v === vi)) continue;
      const n = StrokeGraph.nearestOnPolyline(p, e.pts);
      if (n && (!best || n.d < best.d)) best = { ...n, ei };
    }
    if (!best) return false;
    const w = this.splitEdge(best.ei, best.seg, best.t, best.q);
    if (w === vi) return true; // 分割点が自分自身に吸着された（実質接続済み）
    this.addEdge(vi, w, [p, best.q], 'connector');
    return true;
  }

  // 行き止まり（次数1）の端点をすべて最寄りの線に接続する
  connectDanglingEnds() {
    if (this.edges.length < 2) return;
    const dangling = [];
    const deg = this.degrees();
    for (let i = 0; i < this.verts.length; i++) if (deg[i] === 1) dangling.push(i);
    for (const vi of dangling) {
      // 別の接続で次数が変わっていたらスキップ
      if (this.degrees()[vi] !== 1) continue;
      this.connectVertToNearestEdge(vi);
    }
  }

  components() {
    const parent = this.verts.map((_, i) => i);
    const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
    for (const e of this.edges) parent[find(e.u)] = find(e.v);
    const comp = this.verts.map((_, i) => find(i));
    return comp;
  }

  // 連結成分が複数あれば、近い成分から順に接続線で結んで1つにする。
  // 毎回サンプルを取り直すことで、辺の分割による参照ずれを起こさない。
  // 「最大成分に最も近い成分」から併合していくので（Prim法）、
  // 絵を横切る長いつなぎ線が生まれにくい
  connectComponents() {
    for (let guard = 0; guard < 2000; guard++) {
      const comp = this.components();
      const samples = new Map(); // root -> [{p, ei, seg, t}]（約12px間隔）
      for (let ei = 0; ei < this.edges.length; ei++) {
        const e = this.edges[ei];
        const root = comp[e.u];
        if (!samples.has(root)) samples.set(root, []);
        const list = samples.get(root);
        for (let i = 0; i < e.pts.length - 1; i++) {
          const a = e.pts[i], b = e.pts[i + 1];
          const steps = Math.max(1, Math.round(dist(a, b) / 12));
          for (let s = 0; s <= steps; s++) {
            const t = s / steps;
            list.push({ p: [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])], ei, seg: i, t });
          }
        }
      }
      if (samples.size <= 1) return;

      let main = null;
      for (const root of samples.keys()) {
        if (main === null || samples.get(root).length > samples.get(main).length) main = root;
      }
      const grid = new SampleGrid(48);
      for (const s of samples.get(main)) grid.add(s);

      let best = null;
      for (const [root, list] of samples) {
        if (root === main) continue;
        for (const sb of list) {
          const near = grid.nearest(sb.p, null);
          if (near && (!best || near.d < best.d)) best = { d: near.d, sa: near.s, sb };
        }
      }
      if (!best) return;
      const pair = [best.sa, best.sb].sort((a, b) => b.ei - a.ei);
      const w1 = this.splitEdge(pair[0].ei, pair[0].seg, pair[0].t, pair[0].p);
      const w2 = this.splitEdge(pair[1].ei, pair[1].seg, pair[1].t, pair[1].p);
      if (w1 !== w2) this.addEdge(w1, w2, [this.verts[w1], this.verts[w2]], 'connector');
      // w1===w2 の場合も頂点共有で成分は併合されるので次の反復で解消する
    }
  }

  // Chaikin 法（端点保持）で各辺をなめらかに。往復区間も同一幾何になる
  smooth(iterations) {
    for (const e of this.edges) {
      let cur = e.pts;
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
      e.pts = cur;
      e.len = pathLength(cur);
    }
  }

  adjacency() {
    const adj = this.verts.map(() => []);
    for (let ei = 0; ei < this.edges.length; ei++) {
      const e = this.edges[ei];
      adj[e.u].push({ ei, other: e.v });
      adj[e.v].push({ ei, other: e.u });
    }
    return adj;
  }

  // src から全頂点への最短経路（距離と直前辺）。二分ヒープで O(E log V)
  dijkstra(src, adj) {
    const n = this.verts.length;
    const distArr = new Array(n).fill(Infinity);
    const prevEdge = new Array(n).fill(-1);
    const prevVert = new Array(n).fill(-1);
    const visited = new Array(n).fill(false);
    distArr[src] = 0;
    const heap = new MinHeap();
    heap.push(0, src);
    while (heap.size > 0) {
      const [d, u] = heap.pop();
      if (visited[u]) continue;
      visited[u] = true;
      for (const { ei, other } of adj[u]) {
        const nd = d + this.edges[ei].len;
        if (nd < distArr[other]) {
          distArr[other] = nd;
          prevEdge[other] = ei;
          prevVert[other] = u;
          heap.push(nd, other);
        }
      }
    }
    return { dist: distArr, prevEdge, prevVert };
  }

  // 奇数次数頂点をペアリングし、最短経路上の辺を二重化してオイラー路を可能にする
  eulerize() {
    const deg = this.degrees();
    let odd = [];
    for (let i = 0; i < this.verts.length; i++) if (deg[i] % 2 === 1) odd.push(i);
    if (odd.length <= 2) return;

    const adj = this.adjacency();
    const sp = new Map(); // 奇数頂点 -> dijkstra結果
    for (const o of odd) sp.set(o, this.dijkstra(o, adj));

    // 最も遠いペアを一筆書きの始点・終点として残す（二重化を最小にする）
    let far = null;
    for (let i = 0; i < odd.length; i++) {
      for (let j = i + 1; j < odd.length; j++) {
        const d = sp.get(odd[i]).dist[odd[j]];
        if (!far || d > far.d) far = { d, a: odd[i], b: odd[j] };
      }
    }
    const rest = odd.filter((o) => o !== far.a && o !== far.b);

    // 全ペアを距離昇順に並べ、未使用同士のペアから順に採用する
    // （毎回全ペアを走査し直す方式は頂点数の3乗になり固まるため）
    const pairs = [];
    for (let i = 0; i < rest.length; i++) {
      for (let j = i + 1; j < rest.length; j++) {
        pairs.push([sp.get(rest[i]).dist[rest[j]], rest[i], rest[j]]);
      }
    }
    pairs.sort((a, b) => a[0] - b[0]);
    const used = new Set();
    for (const [, a, b] of pairs) {
      if (used.has(a) || used.has(b)) continue;
      used.add(a);
      used.add(b);
      // 針金を節約するため、長い経路を往復（二重化）するより
      // 2点を直接短い直線で結ぶ方が十分短ければそちらを選ぶ
      const dPath = sp.get(a).dist[b];
      const dLine = dist(this.verts[a], this.verts[b]);
      if (dLine < dPath * 0.7) {
        this.addEdge(a, b, [this.verts[a], this.verts[b]], 'connector');
        continue;
      }
      // a→b の最短経路を復元して二重化（retrace）
      const { prevEdge, prevVert } = sp.get(a);
      let cur = b;
      while (cur !== a && prevEdge[cur] !== -1) {
        const e = this.edges[prevEdge[cur]];
        this.edges.push({ u: e.u, v: e.v, pts: e.pts, len: e.len, kind: 'retrace' });
        cur = prevVert[cur];
      }
    }
  }

  // Hierholzer 法でオイラー路を求め、segments に変換する
  traverse() {
    const n = this.verts.length;
    const adj = this.verts.map(() => []);
    for (let ei = 0; ei < this.edges.length; ei++) {
      const e = this.edges[ei];
      adj[e.u].push({ ei, other: e.v });
      adj[e.v].push({ ei, other: e.u });
    }
    const deg = this.degrees();
    let start = 0;
    for (let i = 0; i < n; i++) if (deg[i] % 2 === 1) { start = i; break; }
    if (deg.every((d) => d % 2 === 0)) {
      for (let i = 0; i < n; i++) if (deg[i] > 0) { start = i; break; }
    }

    const usedEdge = new Array(this.edges.length).fill(false);
    const ptr = new Array(n).fill(0);
    const route = []; // {ei, forward} を逆順で積む
    const vertStack = [start];
    const edgeStack = [];
    while (vertStack.length > 0) {
      const v = vertStack[vertStack.length - 1];
      let advanced = false;
      while (ptr[v] < adj[v].length) {
        const { ei, other } = adj[v][ptr[v]];
        ptr[v]++;
        if (usedEdge[ei]) continue;
        usedEdge[ei] = true;
        vertStack.push(other);
        edgeStack.push({ ei, forward: this.edges[ei].u === v });
        advanced = true;
        break;
      }
      if (!advanced) {
        vertStack.pop();
        if (edgeStack.length > 0 && vertStack.length > 0) {
          route.push(edgeStack.pop());
        }
      }
    }
    route.reverse();

    // 幾何を組み立て
    const segments = [];
    let totalLengthPx = 0;
    let bridgeLengthPx = 0;
    for (const { ei, forward } of route) {
      const e = this.edges[ei];
      const pts = forward ? e.pts : e.pts.slice().reverse();
      const bridge = e.kind !== 'line';
      segments.push({ pts, bridge });
      totalLengthPx += e.len;
      if (bridge) bridgeLengthPx += e.len;
    }
    return { segments, totalLengthPx, bridgeLengthPx };
  }
}

// 二分ヒープ（キー昇順）
class MinHeap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) {
    const k = this.k, v = this.v;
    k.push(key); v.push(val);
    let i = k.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= k[i]) break;
      [k[p], k[i]] = [k[i], k[p]];
      [v[p], v[i]] = [v[i], v[p]];
      i = p;
    }
  }
  pop() {
    const k = this.k, v = this.v;
    const top = [k[0], v[0]];
    const lk = k.pop(), lv = v.pop();
    if (k.length > 0) {
      k[0] = lk; v[0] = lv;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < k.length && k[l] < k[m]) m = l;
        if (r < k.length && k[r] < k[m]) m = r;
        if (m === i) break;
        [k[m], k[i]] = [k[i], k[m]];
        [v[m], v[i]] = [v[i], v[m]];
        i = m;
      }
    }
    return top;
  }
}

// サンプル点の近傍探索用グリッド（セル単位のリング拡張探索）
class SampleGrid {
  constructor(cellSize) {
    this.cell = cellSize;
    this.map = new Map(); // "cx,cy" -> sample[]
  }
  add(s) {
    const key = `${Math.floor(s.p[0] / this.cell)},${Math.floor(s.p[1] / this.cell)}`;
    if (!this.map.has(key)) this.map.set(key, []);
    this.map.get(key).push(s);
  }
  // p に最も近いサンプルを返す（staleEdges に含まれる辺のサンプルは除外）
  nearest(p, staleEdges) {
    if (this.map.size === 0) return null;
    const cx = Math.floor(p[0] / this.cell);
    const cy = Math.floor(p[1] / this.cell);
    let best = null;
    for (let r = 0; r <= 64; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; // リング上のみ
          const bucket = this.map.get(`${cx + dx},${cy + dy}`);
          if (!bucket) continue;
          for (const s of bucket) {
            if (staleEdges && staleEdges.has(s.ei)) continue;
            const d = Math.hypot(s.p[0] - p[0], s.p[1] - p[1]);
            if (!best || d < best.d) best = { d, s };
          }
        }
      }
      // これより外のリングに、今の最良より近い点は存在しない
      if (best && best.d <= r * this.cell) break;
    }
    return best;
  }
}
