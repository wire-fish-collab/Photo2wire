// main.js — UI制御・パイプライン統括
import { loadModel, segmentSubject } from './segment.js';
import { maskOutline, dilateMask } from './edge.js';
import { binarize } from './threshold.js';
import { traceContours } from './contour.js';
import { makeOneStroke } from './onestroke.js';
import { buildSVG, buildAnimatedSVG, downloadText, svgToPngBlob, animate } from './render.js';

const MAX_SIDE = 1024;

const $ = (id) => document.getElementById(id);
const els = {
  fileInput: $('file-input'),
  dropZone: $('drop-zone'),
  canvasOriginal: $('canvas-original'),
  svgContainer: $('svg-container'),
  toggleCutout: $('toggle-cutout'),
  modelSelect: $('model-select'),
  photoMode: $('photo-mode'),
  toggleBinPreview: $('toggle-bin-preview'),
  toggleBridges: $('toggle-bridges'),
  sliderThreshold: $('slider-threshold'),
  sliderSimplify: $('slider-simplify'),
  sliderThickness: $('slider-thickness'),
  valThreshold: $('val-threshold'),
  valSimplify: $('val-simplify'),
  valThickness: $('val-thickness'),
  inputWidthCm: $('input-width-cm'),
  inputMargin: $('input-margin'),
  wireLengthOutput: $('wire-length-output'),
  strokeInfo: $('stroke-info'),
  btnSvg: $('btn-download-svg'),
  btnPng: $('btn-download-png'),
  btnAnimSvg: $('btn-anim-svg'),
  btnAnimate: $('btn-animate'),
  status: $('status'),
};

const state = {
  canvas: null,      // 作業キャンバス（長辺 MAX_SIDE 以下）
  imageData: null,
  mask: null,        // Uint8Array | null
  bin: null,         // 二値化マップ（プレビュー用に保持）
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
    state.bin = null;

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
    reprocess();
  } catch (e) {
    console.error(e);
    setStatus('被写体判定に失敗しました。「切り抜き」をオフにして試してください', true);
  } finally {
    state.busy = false;
  }
}

// ───────── パイプライン（スライダー変更で再実行） ─────────

function params() {
  const simplify = Number(els.sliderSimplify.value);   // 1..10
  const threshold = Number(els.sliderThreshold.value); // 1..254
  const thickness = Number(els.sliderThickness.value); // 1..8
  return {
    // Visvalingam-Whyatt: この面積(px^2)未満の凸凹を取り除く
    epsilonArea: 0.5 + simplify * simplify * 0.4,
    minPerimeter: 12 + simplify * 4,
    snapRadius: 4 + simplify,
    smoothing: 2,
    threshold,
    thickness,
  };
}

function reprocess() {
  if (!state.imageData) return;
  const t0 = performance.now();
  const p = params();
  const { width: W, height: H } = state.imageData;

  // しきい値で白黒2色化 → 各ブロックの輪郭を「閉じたループ」として抽出
  state.bin = binarize(state.imageData, {
    threshold: p.threshold,
    mode: els.photoMode.value, // 'standard' | 'face'
    mask: state.mask,
  });
  drawBinPreview();

  let polylines = [];
  let clipBand = null;
  if (state.mask) {
    // 被写体の外形（隙間・穴も含めて閉ループで。外形は必ず残す）
    polylines.push(...traceContours(state.mask, W, H, {
      epsilonArea: p.epsilonArea,
      minPerimeter: 0,
    }));
    // 外形と重なる暗部輪郭は外形線に任せて除く（帯で切り分け、
    // 内側の区間だけを外形に接続する鎖として残す）
    clipBand = dilateMask(maskOutline(state.mask, W, H), W, H, 2);
  }
  polylines.push(...traceContours(state.bin, W, H, {
    epsilonArea: p.epsilonArea,
    minPerimeter: p.minPerimeter,
    clipBand,
  }));
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
    setStatus('線が検出できませんでした。しきい値や単純化を調整してください', true);
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
  els.valThreshold.textContent = els.sliderThreshold.value;
  els.valSimplify.textContent = els.sliderSimplify.value;
  els.valThickness.textContent = els.sliderThickness.value;
}

// 元写真キャンバスに白黒2色プレビューを重ねる（チェックオフなら元写真に戻す）
function drawBinPreview() {
  if (!state.canvas) return;
  const ctx = els.canvasOriginal.getContext('2d');
  if (!els.toggleBinPreview.checked || !state.bin) {
    ctx.drawImage(state.canvas, 0, 0);
    return;
  }
  const { width: W, height: H } = state.imageData;
  const img = ctx.createImageData(W, H);
  for (let i = 0; i < W * H; i++) {
    let v;
    if (state.mask && state.mask[i] === 0) v = 210;      // マスク外はグレー
    else v = state.bin[i] ? 30 : 255;                     // 暗部=黒、明部=白
    img.data[i * 4] = v;
    img.data[i * 4 + 1] = v;
    img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
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

  for (const s of [els.sliderSimplify, els.sliderThreshold]) {
    s.addEventListener('input', () => { updateSliderLabels(); reprocessDebounced(); });
  }
  els.sliderThickness.addEventListener('input', () => { updateSliderLabels(); redrawSVG(); });
  els.toggleBridges.addEventListener('change', redrawSVG);
  els.toggleCutout.addEventListener('change', runSegmentationAndProcess);
  els.modelSelect.addEventListener('change', runSegmentationAndProcess);
  els.photoMode.addEventListener('change', reprocess);
  els.toggleBinPreview.addEventListener('change', drawBinPreview);
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
  els.btnAnimSvg.addEventListener('click', () => {
    if (!state.stroke || !state.imageData) return;
    const { width: W, height: H } = state.imageData;
    const sec = Math.min(12, Math.max(3, state.stroke.totalLengthPx / 800));
    const svg = buildAnimatedSVG(state.stroke, W, H, {
      strokeWidth: params().thickness,
      durationSec: sec,
    });
    downloadText('photo2wire_anime.svg', svg, 'image/svg+xml');
  });

  updateSliderLabels();
  setStatus('写真を選ぶと変換が始まります');
  // モデルは裏で先読みしておく（初回変換を速くする）
  loadModel().catch(() => { /* 変換時に改めてエラー表示 */ });
}

init();
