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

// Bounding box used for "fit" scale and the pan/zoom constraint. This is the
// text bbox extended out to the natural page margins on top/left/right, with
// the bottom capped so the page's anomalous empty area stays off-screen.
let viewBbox = null;

// Per-item rectangles + font size in viewport-coordinate units (y top-down).
// Used by findItemAtPoint() for smart double-tap zoom.
let textItems = [];

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

// ── Text-bbox + per-item computation ────────────────────────────────────

async function computeTextData(pdfPage) {
  const viewport = pdfPage.getViewport({ scale: 1 });
  const fullPage = { x: 0, y: 0, w: viewport.width, h: viewport.height };
  const empty = { textBbox: fullPage, items: [] };

  let text;
  try { text = await pdfPage.getTextContent(); }
  catch { return empty; }
  if (!text?.items?.length) return empty;

  // viewport.transform: [scaleX, skewY, skewX, scaleY, tx, ty] — converts PDF
  // user-space coords (y-up) to viewport coords (y-down). Assuming no rotation
  // here (per design), scaleY < 0 so y flips.
  const v = viewport.transform;
  const items = [];
  let xMin = Infinity, yMin = Infinity, xMax = -Infinity, yMax = -Infinity;

  for (const item of text.items) {
    if (!item.str) continue;
    const ix = item.transform[4];
    const iy = item.transform[5];
    const iw = item.width;
    const ih = item.height;

    // Transform all four corners → viewport AABB for this item.
    const corners = [[ix, iy], [ix + iw, iy], [ix + iw, iy + ih], [ix, iy + ih]];
    let cx0 = Infinity, cy0 = Infinity, cx1 = -Infinity, cy1 = -Infinity;
    for (const [px, py] of corners) {
      const vx = v[0] * px + v[2] * py + v[4];
      const vy = v[1] * px + v[3] * py + v[5];
      if (vx < cx0) cx0 = vx;
      if (vx > cx1) cx1 = vx;
      if (vy < cy0) cy0 = vy;
      if (vy > cy1) cy1 = vy;
    }
    items.push({
      x: cx0, y: cy0, w: cx1 - cx0, h: cy1 - cy0,
      // Item height in viewport space ≈ font size in CSS px at scale 1.
      fontSize: cy1 - cy0,
    });

    if (cx0 < xMin) xMin = cx0;
    if (cx1 > xMax) xMax = cx1;
    if (cy0 < yMin) yMin = cy0;
    if (cy1 > yMax) yMax = cy1;
  }

  if (!isFinite(xMin)) return empty;

  // Sanity: bbox must span at least a quarter of the page in each dimension.
  if ((xMax - xMin) < viewport.width * 0.25 ||
      (yMax - yMin) < viewport.height * 0.25) {
    return empty;
  }

  return {
    textBbox: { x: xMin, y: yMin, w: xMax - xMin, h: yMax - yMin },
    items,
  };
}

// Extend the tight text bbox to include natural page margins. Top/left/right
// expand to the full page (since users want to see the natural whitespace
// around the text). Bottom is capped at "text bottom + margin equal to top
// margin" so the daf's anomalous empty region at the bottom stays cropped.
function computeViewBbox(textBbox, pageW, pageH) {
  if (!textBbox) return { x: 0, y: 0, w: pageW, h: pageH };

  // If text-bbox already covers the page (the fallback path returns full
  // page), nothing to extend.
  if (textBbox.w >= pageW * 0.99 && textBbox.h >= pageH * 0.99) {
    return { x: 0, y: 0, w: pageW, h: pageH };
  }

  const topMargin = Math.max(0, textBbox.y);
  // Match top margin on the bottom; floor at 5% of pageH so very small top
  // margins don't leave the bottom edge crowding the text.
  const bottomMargin = Math.max(topMargin, pageH * 0.05);
  const h = Math.min(pageH, textBbox.y + textBbox.h + bottomMargin);

  return { x: 0, y: 0, w: pageW, h };
}

// ── Scale + transform helpers ────────────────────────────────────────────

// Scale that fits the view bbox (or the full page if no bbox) within the viewport.
function fitScale() {
  const w = viewBbox?.w ?? pageW;
  const h = viewBbox?.h ?? pageH;
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
  if (!viewBbox) return;

  // Minimum view.scale = the scale at which the bbox just fills the screen.
  // Pinching out below this would otherwise reveal blank page area.
  const minViewScale = fitScale() / renderScale;
  if (view.scale < minViewScale) view.scale = minViewScale;

  const eff = renderScale * view.scale; // PDF-points → screen-pixels
  const bL = viewBbox.x * eff;
  const bR = (viewBbox.x + viewBbox.w) * eff;
  const bT = viewBbox.y * eff;
  const bB = (viewBbox.y + viewBbox.h) * eff;

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

  // Compute text data (per-item rects + tight text bbox) before the first
  // render so we can render at the bbox-fit scale and have item info ready
  // for smart double-tap zoom. getTextContent is fast (typically <10ms).
  const { textBbox, items } = await computeTextData(currentPdfPage);
  textItems = items;
  viewBbox = computeViewBbox(textBbox, pageW, pageH);

  await renderAtScale(fitScale());

  // Position so the view bbox is centered in the viewport. Constraint then
  // snaps any drift (no-op in practice when scale=1).
  view.scale = 1;
  view.x = window.innerWidth  / 2 - (viewBbox.x + viewBbox.w / 2) * renderScale;
  view.y = window.innerHeight / 2 - (viewBbox.y + viewBbox.h / 2) * renderScale;
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
  // Centered on the view bbox at fit-screen scale.
  const fit = fitScale();
  const visualScale = fit / renderScale;
  const w = viewBbox?.w ?? pageW;
  const h = viewBbox?.h ?? pageH;
  const x0 = viewBbox?.x ?? 0;
  const y0 = viewBbox?.y ?? 0;
  return {
    x: window.innerWidth  / 2 - (x0 + w / 2) * fit,
    y: window.innerHeight / 2 - (y0 + h / 2) * fit,
    scale: visualScale,
  };
}

// ── Smart-zoom helpers (used by gestures.js) ────────────────────────────

// Effective PDF-points → screen-pixels factor at the current view.
export function effectiveScale() {
  return renderScale * view.scale;
}

// Convert a screen point to PDF/viewport coordinates (the space textItems
// live in).
function screenToPdf(clientX, clientY) {
  const r = canvas.getBoundingClientRect();
  // canvas-CSS coord → PDF coord: divide by renderScale.
  return {
    x: (clientX - r.left) / view.scale / renderScale,
    y: (clientY - r.top)  / view.scale / renderScale,
  };
}

// Find the text item whose rect is closest (in screen pixels) to the screen
// point. Returns null if no item is within `radiusPx` screen pixels.
export function findItemAtPoint(clientX, clientY, radiusPx = 30) {
  if (!textItems.length) return null;
  const { x: px, y: py } = screenToPdf(clientX, clientY);
  const eff = effectiveScale();
  if (eff <= 0) return null;
  const radiusPdf = radiusPx / eff;

  let best = null;
  let bestDist = Infinity;
  for (const item of textItems) {
    // Distance from point to item's AABB (0 if inside).
    const dx = Math.max(item.x - px, 0, px - (item.x + item.w));
    const dy = Math.max(item.y - py, 0, py - (item.y + item.h));
    const d = Math.hypot(dx, dy);
    if (d <= radiusPdf && d < bestDist) {
      bestDist = d;
      best = item;
    }
  }
  return best;
}

// Compute a target view transform that:
//   1. zooms so a piece of text of `fontSizePdf` PDF-units appears at
//      `targetFontPx` CSS pixels on screen, and
//   2. places the screen point (clientX, clientY) at the viewport center.
// constrainView() will pull the result inside the view bbox if the centering
// would otherwise push beyond it — so edges keep their margin visible.
export function transformForFontSize(clientX, clientY, fontSizePdf, targetFontPx) {
  if (!fontSizePdf || fontSizePdf <= 0) return null;
  const targetEff = targetFontPx / fontSizePdf;       // PDF → screen pixels
  const targetViewScale = targetEff / renderScale;     // applied via CSS transform

  // Convert tap to canvas-CSS coords at the *current* view.scale, then choose
  // view.x/y so that same canvas-CSS point ends up at the screen center after
  // applying targetViewScale.
  const r = canvas.getBoundingClientRect();
  const localX = (clientX - r.left) / view.scale;
  const localY = (clientY - r.top)  / view.scale;

  return {
    x: window.innerWidth  / 2 - localX * targetViewScale,
    y: window.innerHeight / 2 - localY * targetViewScale,
    scale: targetViewScale,
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
