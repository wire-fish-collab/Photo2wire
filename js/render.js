// render.js — SVG生成・ダウンロード・アニメーション

/**
 * 数値を小数1桁に丸める
 * @param {number} v
 * @returns {string}
 */
function r1(v) {
  return (Math.round(v * 10) / 10).toFixed(1);
}

/**
 * ストローク情報からSVG文字列を生成する
 * @param {{ segments: Array<{pts: Array<[number,number]>, bridge: boolean}>, totalLengthPx: number, bridgeLengthPx: number }} stroke
 * @param {number} W
 * @param {number} H
 * @param {{ strokeWidth?: number, showBridges?: boolean }} opts
 * @returns {string}
 */
export function buildSVG(stroke, W, H, opts = {}) {
  const strokeWidth = opts.strokeWidth ?? 2.5;
  const showBridges = opts.showBridges ?? true;

  // 全セグメントを連結した単一の d 属性を構築
  const wireParts = [];
  let firstPoint = true;
  for (const seg of stroke.segments) {
    for (let i = 0; i < seg.pts.length; i++) {
      const [x, y] = seg.pts[i];
      if (firstPoint) {
        wireParts.push(`M${r1(x)},${r1(y)}`);
        firstPoint = false;
      } else if (i === 0) {
        // 次セグメントの先頭点 (連続のためLで繋ぐ)
        wireParts.push(`L${r1(x)},${r1(y)}`);
      } else {
        wireParts.push(`L${r1(x)},${r1(y)}`);
      }
    }
  }
  const wireD = wireParts.join(' ');

  // bridge セグメントのオーバーレイ用 d 属性
  let bridgePathEl = '';
  if (showBridges) {
    const bridgeParts = [];
    for (const seg of stroke.segments) {
      if (!seg.bridge) continue;
      const [sx, sy] = seg.pts[0];
      bridgeParts.push(`M${r1(sx)},${r1(sy)}`);
      for (let i = 1; i < seg.pts.length; i++) {
        const [x, y] = seg.pts[i];
        bridgeParts.push(`L${r1(x)},${r1(y)}`);
      }
    }
    if (bridgeParts.length > 0) {
      const bridgeD = bridgeParts.join(' ');
      bridgePathEl = `<path id="bridge-path" d="${bridgeD}" fill="none" stroke="#c0392b" stroke-dasharray="6 4" stroke-linecap="round" stroke-linejoin="round" stroke-width="${strokeWidth}"/>`;
    }
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}">`,
    `<rect width="${W}" height="${H}" fill="#fff"/>`,
    `<path id="wire-path" d="${wireD}" fill="none" stroke="#444" stroke-linecap="round" stroke-linejoin="round" stroke-width="${strokeWidth}"/>`,
    bridgePathEl,
    `</svg>`,
  ].join('\n');
}

/**
 * テキストをファイルとしてダウンロードする
 * @param {string} filename
 * @param {string} text
 * @param {string} mime
 */
export function downloadText(filename, text, mime = 'image/svg+xml') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * SVG文字列をPNG Blobに変換する
 * @param {string} svgString
 * @param {number} W
 * @param {number} H
 * @param {number} scale
 * @returns {Promise<Blob>}
 */
export async function svgToPngBlob(svgString, W, H, scale = 2) {
  const blob = new Blob([svgString], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);

  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = W * scale;
      canvas.height = H * scale;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, W * scale, H * scale);
      URL.revokeObjectURL(url);
      canvas.toBlob((pngBlob) => {
        if (pngBlob) resolve(pngBlob);
        else reject(new Error('canvas.toBlob が失敗しました'));
      }, 'image/png');
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('SVG画像の読み込みに失敗しました'));
    };
    // SVGにwidth/heightが無いためdrawImage引数でサイズを明示
    img.width = W * scale;
    img.height = H * scale;
    img.src = url;
  });
}

/**
 * #wire-path に stroke-dashoffset アニメーションを適用する
 * @param {Element} container - #wire-path と #bridge-path を含む要素
 * @param {number} durationSec
 */
export function animate(container, durationSec) {
  const path = container.querySelector('#wire-path');
  if (!path) return;

  const bridgePath = container.querySelector('#bridge-path');

  // アニメーション開始前に bridge-path を非表示
  if (bridgePath) bridgePath.style.visibility = 'hidden';

  const total = path.getTotalLength();

  // transition を一旦 none にして即時リセット（reflow を挟む）
  path.style.transition = 'none';
  path.style.strokeDasharray = `${total}`;
  path.style.strokeDashoffset = `${total}`;

  // reflow を強制して transition リセットを確定させる
  // eslint-disable-next-line no-unused-expressions
  path.getBoundingClientRect();

  // アニメーション開始
  path.style.transition = `stroke-dashoffset ${durationSec}s linear`;
  path.style.strokeDashoffset = '0';

  // アニメーション終了後に bridge-path を再表示
  if (bridgePath) {
    const onEnd = () => {
      bridgePath.style.visibility = '';
      path.removeEventListener('transitionend', onEnd);
    };
    path.addEventListener('transitionend', onEnd);
  }
}
