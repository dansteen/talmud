import * as pdfjsLib from 'pdfjs-dist';
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

const canvas = document.getElementById('page-canvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true });
const overlay = document.getElementById('region-overlay');

// Page geometry (set once per loaded page)
let pageW = 1;       // natural PDF width (PDF points)
let pageH = 1;       // natural PDF height (PDF points)
let renderScale = 1; // scale at which the canvas was last rendered

// Bounding box of all text on the current page in viewport-coordinate units
// (i.e., PDF points with y running top-down). Drives "fit" scale and the
// pan/zoom constraint so the empty region of the page stays off-screen.
// Falls back to the full page when computation fails.
let textBbox = null;

// Visual transform applied to the canvas via CSS
export const view = {
  scale: 1,  // visual scale on top of the canvas's natural CSS size
  x: 0,
  y: 0,
  cssW: 0,   // canvas natural CSS width (= pageW * renderScale)
  cssH: 0,
};

// Region detection is currently disabled (the algorithm needs reworking).
// Exporting `regions` as null keeps gestures.js's "no regions" fallback path
// active so double-tap zoom still does a generic 2.5x zoom.
export let regions = null;

let currentPdfPage = null;
let renderTask = null;

// ── Text-bbox computation ────────────────────────────────────────────────

async function computeTextBbox(pdfPage) {
  const viewport = pdfPage.getViewport({ scale: 1 });
  const fullPage = { x: 0, y: 0, w: viewport.width, h: viewport.height };

  let text;
  try { text = await pdfPage.getTextContent(); }
  catch { return fullPage; }
  if (!text?.items?.length) return fullPage;

  // viewport.transform: [scaleX, skewY, skewX, scaleY, tx, ty] — converts PDF
  // user-space coords (y-up) to viewport coords (y-down).
  const v = viewport.transform;
  let xMin = Infinity, yMin = Infinity, xMax = -Infinity, yMax = -Infinity;

  for (const item of text.items) {
    if (!item.str) continue;
    const x = item.transform[4];
    const y = item.transform[5];
    const w = item.width;
    const h = item.height;
    // Transform all four corners and take the AABB — handles rotation safely.
    const corners = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
    for (const [px, py] of corners) {
      const vx = v[0] * px + v[2] * py + v[4];
      const vy = v[1] * px + v[3] * py + v[5];
      if (vx < xMin) xMin = vx;
      if (vx > xMax) xMax = vx;
      if (vy < yMin) yMin = vy;
      if (vy > yMax) yMax = vy;
    }
  }

  if (!isFinite(xMin)) return fullPage;

  // Sanity: bbox must span at least a quarter of the page in each dimension.
  // If not (broken metadata, decorative-only page, etc.), fall back.
  if ((xMax - xMin) < viewport.width * 0.25 ||
      (yMax - yMin) < viewport.height * 0.25) {
    return fullPage;
  }

  return { x: xMin, y: yMin, w: xMax - xMin, h: yMax - yMin };
}

// ── Scale + transform helpers ────────────────────────────────────────────

// Scale that fits the text bbox (or the full page if no bbox) within the viewport.
function fitScale() {
  const w = textBbox?.w ?? pageW;
  const h = textBbox?.h ?? pageH;
  return Math.min(window.innerWidth / w, window.innerHeight / h) * 0.98;
}

function applyTransform(animated = false) {
  const t = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
  canvas.classList.toggle('animating', animated);
  canvas.style.transform = t;
  if (overlay) {
    overlay.classList.toggle('animating', animated);
    overlay.style.transform = t;
  }
}

// Clamp view.scale to a minimum and view.x/view.y so the visible viewport
// stays inside the text bbox at the current zoom. Works in canvas-CSS coords:
//   visible_left   = -view.x / view.scale
//   visible_right  = (window.innerWidth  - view.x) / view.scale
//   bbox_left      = textBbox.x * renderScale
//   bbox_right     = (textBbox.x + textBbox.w) * renderScale
// Constraint: bbox_left ≤ visible_left  AND  visible_right ≤ bbox_right.
function constrainView() {
  if (!textBbox) return;

  // Minimum view.scale = the scale at which the bbox just fills the screen.
  // Pinching out below this would otherwise reveal blank page area.
  const minViewScale = fitScale() / renderScale;
  if (view.scale < minViewScale) view.scale = minViewScale;

  const eff = renderScale * view.scale; // PDF-points → screen-pixels
  const bL = textBbox.x * eff;
  const bR = (textBbox.x + textBbox.w) * eff;
  const bT = textBbox.y * eff;
  const bB = (textBbox.y + textBbox.h) * eff;

  // x bounds. xMax: tightest "you can't pan further right" position.
  //          xMin: tightest "you can't pan further left" position.
  const xMax = -bL;
  const xMin = window.innerWidth - bR;
  view.x = (xMin > xMax)
    ? (xMin + xMax) / 2  // bbox narrower than viewport — center it
    : Math.max(xMin, Math.min(xMax, view.x));

  const yMax = -bT;
  const yMin = window.innerHeight - bB;
  view.y = (yMin > yMax)
    ? (yMin + yMax) / 2
    : Math.max(yMin, Math.min(yMax, view.y));
}

async function renderAtScale(s) {
  if (renderTask) { renderTask.cancel(); renderTask = null; }
  if (!currentPdfPage) return;

  const dpr = window.devicePixelRatio || 1;
  const viewport = currentPdfPage.getViewport({ scale: s * dpr });

  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  canvas.style.width = (pageW * s) + 'px';
  canvas.style.height = (pageH * s) + 'px';

  view.cssW = pageW * s;
  view.cssH = pageH * s;
  renderScale = s;

  if (overlay) {
    overlay.style.width = view.cssW + 'px';
    overlay.style.height = view.cssH + 'px';
  }

  renderTask = currentPdfPage.render({ canvasContext: ctx, viewport });
  try {
    await renderTask.promise;
  } catch (e) {
    if (e?.name !== 'RenderingCancelledException') throw e;
    return;
  }
  renderTask = null;
}

// After a gesture settles, re-render at higher resolution if needed
let qualityTimer = null;
export function scheduleQualityRender() {
  clearTimeout(qualityTimer);
  qualityTimer = setTimeout(async () => {
    if (!currentPdfPage) return;
    if (Math.abs(view.scale - 1) < 0.25) return;

    const newRenderScale = renderScale * view.scale;
    const prevX = view.x;
    const prevY = view.y;

    await renderAtScale(newRenderScale);

    // Canvas natural CSS size is now equal to its previous visual size,
    // so we reset the visual scale to 1 and keep the same translation.
    view.scale = 1;
    view.x = prevX;
    view.y = prevY;
    constrainView();
    applyTransform(false);
  }, 350);
}

export async function loadPage(url, slug, daf, amud, onRegionsReady) {
  regions = null;
  // No region detection right now — keep the pending-dot indicator hidden.
  document.getElementById('region-pending').classList.add('hidden');

  const pdfDoc = await pdfjsLib.getDocument({
    url,
    withCredentials: false,
    standardFontDataUrl: '/pdfjs/standard_fonts/',
    cMapUrl: '/pdfjs/cmaps/',
    cMapPacked: true,
    // Draw glyphs directly to canvas instead of using @font-face. The browser's
    // font metric calculations don't match the PDF's embedded Hebrew fonts,
    // which spreads letters within words apart. Canvas drawing uses the PDF's
    // own metrics and lays out words correctly.
    disableFontFace: true,
  }).promise;
  currentPdfPage = await pdfDoc.getPage(1);

  const natural = currentPdfPage.getViewport({ scale: 1 });
  pageW = natural.width;
  pageH = natural.height;

  // Compute text bbox before the first render so we can render at the
  // bbox-fit scale (instead of full-page-fit). getTextContent is fast —
  // typically a few ms.
  textBbox = await computeTextBbox(currentPdfPage);

  await renderAtScale(fitScale());

  // Position so the text bbox is centered in the viewport. Constraint then
  // snaps any drift (no-op in practice when scale=1).
  view.scale = 1;
  view.x = window.innerWidth  / 2 - (textBbox.x + textBbox.w / 2) * renderScale;
  view.y = window.innerHeight / 2 - (textBbox.y + textBbox.h / 2) * renderScale;
  constrainView();
  applyTransform(false);

  // Region detection callback is no-op for now; gestures fall back to a
  // generic double-tap zoom.
  onRegionsReady?.(null);
}

export function animateTo(targetX, targetY, targetScale, onDone) {
  view.x = targetX;
  view.y = targetY;
  view.scale = targetScale;
  constrainView();
  applyTransform(true);

  canvas.addEventListener('transitionend', function handler() {
    canvas.removeEventListener('transitionend', handler);
    canvas.classList.remove('animating');
    scheduleQualityRender();
    onDone?.();
  }, { once: true });
}

export function transformForRegion(region, preferredScale) {
  // region coords are normalized [0..1] relative to the canvas at renderScale
  const regionCssX = region.x * view.cssW;
  const regionCssY = region.y * view.cssH;
  const regionCssW = region.w * view.cssW;
  const regionCssH = region.h * view.cssH;

  const scale = preferredScale ?? (window.innerHeight * 0.9 / regionCssH);

  const cx = regionCssX + regionCssW / 2;
  const cy = regionCssY + regionCssH / 2;

  return {
    x: window.innerWidth / 2 - cx * scale,
    y: window.innerHeight / 2 - cy * scale,
    scale,
  };
}

export function transformForHome() {
  // Centered on the text bbox at fit-screen scale.
  const fit = fitScale();
  const visualScale = fit / renderScale;
  const w = textBbox?.w ?? pageW;
  const h = textBbox?.h ?? pageH;
  const x0 = textBbox?.x ?? 0;
  const y0 = textBbox?.y ?? 0;
  return {
    x: window.innerWidth  / 2 - (x0 + w / 2) * fit,
    y: window.innerHeight / 2 - (y0 + h / 2) * fit,
    scale: visualScale,
  };
}

export function applyDelta(dx, dy, dScale, originX, originY) {
  if (dScale !== 1) {
    view.x = originX + (view.x - originX) * dScale;
    view.y = originY + (view.y - originY) * dScale;
    view.scale *= dScale;
  }
  view.x += dx;
  view.y += dy;
  constrainView();
  applyTransform(false);
}

export { canvas };
