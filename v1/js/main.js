// main.js — UI制御・パイプライン統括
import { loadModel, segmentSubject } from './segment.js';
import { detectEdges, maskOutline } from './edge.js';
import { posterizeEdges } from './posterize.js';
import { computeDepth, depthEdges } from './depth.js';
import { vectorize } from './vectorize.js';
import { makeOneStroke } from './onestroke.js';
import { buildSVG, downloadText, svgToPngBlob, animate } from './render.js';

const MAX_SIDE = 1024;

const $ = (id) => document.getElementById(id);
const els = {
  fileInput: $('file-input'),
  dropZone: $('drop-zone'),
  canvasOriginal: $('canvas-original'),
  svgContainer: $('svg-container'),
  toggleCutout: $('toggle-cutout'),
  modelSelect: $('model-select'),
  detailMode: $('detail-mode'),
  toggleDepth: $('toggle-depth'),
  toggleBridges: $('toggle-bridges'),
  sliderSimplify: $('slider-simplify'),
  sliderDetail: $('slider-detail'),
  sliderThickness: $('slider-thickness'),
  valSimplify: $('val-simplify'),
  valDetail: $('val-detail'),
  valThickness: $('val-thickness'),
  inputWidthCm: $('input-width-cm'),
  inputMargin: $('input-margin'),
  wireLengthOutput: $('wire-length-output'),
  strokeInfo: $('stroke-info'),
  btnSvg: $('btn-download-svg'),
  btnPng: $('btn-download-png'),
  btnAnimate: $('btn-animate'),
  status: $('status'),
};

const state = {
  canvas: null,      // 作業キャンバス（長辺 MAX_SIDE 以下）
  imageData: null,
  mask: null,        // Uint8Array | null
  depth: null,       // Float32Array | null（画像ごとに1回だけ計算）
  stroke: null,      // makeOneStroke の結果
  svg: '',
  busy: false,
};

function setStatus(msg, isError = false) {
  els.status.textContent = msg;
  els.status.classList.toggle('error', isError);
}

// ───────── 画像読み込み ─────────

function acceptFile(file) {
  if (!file || !file.type.startsWith('image/')) {
    setStatus('画像ファイルを選択してください', true);
    return;
  }
  const img = new Image();
  img.onload = () => {
    URL.revokeObjectURL(img.src);
    const scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
    const W = Math.round(img.width * scale);
    const H = Math.round(img.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    canvas.getContext('2d').drawImage(img, 0, 0, W, H);
    state.canvas = canvas;
    state.imageData = canvas.getContext('2d').getImageData(0, 0, W, H);
    state.depth = null;

    els.canvasOriginal.width = W;
    els.canvasOriginal.height = H;
    els.canvasOriginal.getContext('2d').drawImage(canvas, 0, 0);

    runSegmentationAndProcess();
  };
  img.onerror = () => setStatus('画像を読み込めませんでした', true);
  img.src = URL.createObjectURL(file);
}

async function runSegmentationAndProcess() {
  if (!state.canvas) return;
  state.busy = true;
  try {
    if (els.toggleCutout.checked) {
      const model = els.modelSelect.value;
      setStatus(model === 'isnet'
        ? '被写体を判定しています…（高精度モデル。初回は170MBの読み込みと数十秒の処理があります）'
        : '被写体を判定しています…（初回はモデル読み込みに少し時間がかかります）');
      state.mask = await segmentSubject(state.canvas, model);
    } else {
      state.mask = null;
    }
    await ensureDepth();
    reprocess();
  } catch (e) {
    console.error(e);
    setStatus('被写体判定に失敗しました。「切り抜き」をオフにして試してください', true);
  } finally {
    state.busy = false;
  }
}

// 奥行きマップは画像ごとに1回だけ計算してキャッシュする
async function ensureDepth() {
  if (!els.toggleDepth.checked || state.depth || !state.canvas) return;
  setStatus('奥行きを推定しています…（初回は27MBの読み込みがあります）');
  try {
    state.depth = await computeDepth(state.canvas);
  } catch (e) {
    console.error(e);
    setStatus('奥行き推定に失敗しました。「立体の境界」をオフにして続行します', true);
    els.toggleDepth.checked = false;
  }
}

// ───────── パイプライン（スライダー変更で再実行） ─────────

function params() {
  const simplify = Number(els.sliderSimplify.value);   // 1..10
  const detail = Number(els.sliderDetail.value);       // 0..10
  const thickness = Number(els.sliderThickness.value); // 1..8
  return {
    epsilon: 0.6 * simplify,
    minLength: 6 + simplify * 2,
    snapRadius: 4 + simplify,
    smoothing: 2,
    dogThreshold: 10 - detail * 0.9, // 小さいほど内部線が増える
    posterLevels: Math.min(8, 2 + Math.round(detail * 0.6)), // 色数 2〜8
    detail,
    thickness,
  };
}

function reprocess() {
  if (!state.imageData) return;
  const t0 = performance.now();
  const p = params();
  const { width: W, height: H } = state.imageData;

  const edges = new Uint8Array(W * H);
  const mode = els.detailMode.value; // 'poster' | 'dog' | 'both'
  if (p.detail > 0 && (mode === 'dog' || mode === 'both')) {
    const dog = detectEdges(state.imageData, {
      sigma: 1.4,
      k: 1.6,
      threshold: p.dogThreshold,
      mask: state.mask,
    });
    for (let i = 0; i < edges.length; i++) if (dog[i]) edges[i] = 255;
  }
  if (p.detail > 0 && (mode === 'poster' || mode === 'both')) {
    const poster = posterizeEdges(state.imageData, {
      levels: p.posterLevels,
      mask: state.mask,
    });
    for (let i = 0; i < edges.length; i++) if (poster[i]) edges[i] = 255;
  }
  if (els.toggleDepth.checked && state.depth) {
    const dep = depthEdges(state.depth, W, H, { threshold: 0.04, mask: state.mask });
    for (let i = 0; i < edges.length; i++) if (dep[i]) edges[i] = 255;
  }
  if (state.mask) {
    const outline = maskOutline(state.mask, W, H);
    for (let i = 0; i < edges.length; i++) if (outline[i]) edges[i] = 255;
  }

  let polylines = vectorize(edges, W, H, {
    epsilon: p.epsilon,
    minLength: p.minLength,
  });
  // 線が多すぎると一筆書き計算が破綻する（し、下絵としても使えない）ため、
  // 長い順に上限本数まで絞る
  const MAX_LINES = 400;
  const totalFound = polylines.length;
  if (polylines.length > MAX_LINES) {
    const len = (pts) => {
      let l = 0;
      for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      return l;
    };
    polylines.sort((a, b) => len(b) - len(a));
    polylines = polylines.slice(0, MAX_LINES);
  }
  if (polylines.length === 0) {
    setStatus('線が検出できませんでした。「内部線の量」を上げるか「単純化」を下げてください', true);
    els.svgContainer.innerHTML = '';
    state.stroke = null;
    return;
  }
  state.stroke = makeOneStroke(polylines, {
    snapRadius: p.snapRadius,
    smoothing: p.smoothing,
  });
  redrawSVG();
  updateWireLength();

  const nBridges = state.stroke.segments.filter((s) => s.bridge).length;
  const capNote = totalFound > polylines.length
    ? `検出線 ${totalFound} 本から長い順に ${polylines.length} 本を使用`
    : `検出線 ${polylines.length} 本`;
  els.strokeInfo.textContent =
    `${capNote} → 一筆書き（つなぎ ${nBridges} 箇所） / 処理 ${Math.round(performance.now() - t0)}ms`;
  setStatus('変換完了。スライダーで調整できます');
}

// 線の太さ・つなぎ表示の変更は SVG 再構築のみ（再計算しない）
function redrawSVG() {
  if (!state.stroke || !state.imageData) return;
  const { width: W, height: H } = state.imageData;
  state.svg = buildSVG(state.stroke, W, H, {
    strokeWidth: params().thickness,
    showBridges: els.toggleBridges.checked,
  });
  els.svgContainer.innerHTML = state.svg;
}

function updateWireLength() {
  if (!state.stroke || !state.imageData) {
    els.wireLengthOutput.textContent = '—';
    return;
  }
  const widthCm = Number(els.inputWidthCm.value) || 0;
  const marginPct = Number(els.inputMargin.value) || 0;
  const pxToCm = widthCm / state.imageData.width;
  const cm = state.stroke.totalLengthPx * pxToCm * (1 + marginPct / 100);
  els.wireLengthOutput.textContent = cm > 0 ? `約 ${cm.toFixed(1)} cm` : '—';
}

// ───────── イベント ─────────

function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}
const reprocessDebounced = debounce(reprocess, 200);

function updateSliderLabels() {
  els.valSimplify.textContent = els.sliderSimplify.value;
  els.valDetail.textContent = els.sliderDetail.value;
  els.valThickness.textContent = els.sliderThickness.value;
}

function init() {
  els.fileInput.addEventListener('change', () => acceptFile(els.fileInput.files[0]));
  els.dropZone.addEventListener('click', () => els.fileInput.click());
  els.dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    els.dropZone.classList.add('dragover');
  });
  els.dropZone.addEventListener('dragleave', () => els.dropZone.classList.remove('dragover'));
  els.dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    els.dropZone.classList.remove('dragover');
    acceptFile(e.dataTransfer.files[0]);
  });

  for (const s of [els.sliderSimplify, els.sliderDetail]) {
    s.addEventListener('input', () => { updateSliderLabels(); reprocessDebounced(); });
  }
  els.sliderThickness.addEventListener('input', () => { updateSliderLabels(); redrawSVG(); });
  els.toggleBridges.addEventListener('change', redrawSVG);
  els.toggleCutout.addEventListener('change', runSegmentationAndProcess);
  els.modelSelect.addEventListener('change', runSegmentationAndProcess);
  els.detailMode.addEventListener('change', reprocess);
  els.toggleDepth.addEventListener('change', async () => {
    await ensureDepth();
    reprocess();
  });
  els.inputWidthCm.addEventListener('input', updateWireLength);
  els.inputMargin.addEventListener('input', updateWireLength);

  els.btnSvg.addEventListener('click', () => {
    if (state.svg) downloadText('photo2wire.svg', state.svg, 'image/svg+xml');
  });
  els.btnPng.addEventListener('click', async () => {
    if (!state.svg) return;
    const { width: W, height: H } = state.imageData;
    const blob = await svgToPngBlob(state.svg, W, H, 2);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'photo2wire.png';
    a.click();
    URL.revokeObjectURL(url);
  });
  els.btnAnimate.addEventListener('click', () => {
    if (!state.stroke) return;
    // 線の長さに応じた時間（3〜12秒）
    const sec = Math.min(12, Math.max(3, state.stroke.totalLengthPx / 800));
    animate(els.svgContainer, sec);
  });

  updateSliderLabels();
  setStatus('写真を選ぶと変換が始まります');
  // モデルは裏で先読みしておく（初回変換を速くする）
  loadModel().catch(() => { /* 変換時に改めてエラー表示 */ });
}

init();
