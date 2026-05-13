import * as pdfjsLib from 'pdfjs-dist';
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import {
  renderPdfToImageData,
  buildGridFromImageData,
  detectGutters,
  detectRegions,
} from './regionsPixel.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

const canvas = document.getElementById('page-canvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true });
const overlay = document.getElementById('region-overlay');

// Debug overlay is shown when ?debug=1 is in the URL or after pressing 'd'.
const DEBUG_REGIONS = new URLSearchParams(location.search).has('debug');
if (DEBUG_REGIONS) {
  overlay.classList.add('visible');
  queueMicrotask(createDebugPanel);
}
window.addEventListener('keydown', e => {
  if (e.key === 'd' || e.key === 'D') overlay.classList.toggle('visible');
});

// ── Page state ─────────────────────────────────────────────────────────

// Page geometry (set once per loaded page).
let pageW = 1, pageH = 1;
let renderScale = 1; // scale at which the canvas was last rendered.

// Tight bbox of all text on the current page (viewport coords).
let textBbox = null;

// Per-text-item rects + font sizes (viewport coords). Used to compute
// each area's dominant font size.
let textItems = [];

// Cached off-screen render of the current page. Rebuilt only when a new
// page loads; slider tweaks re-derive the gutter mask from it without
// re-rendering.
let pixelImageData = null;

// Computed "areas" of the current page. An area is a connected component
// of NON-gutter pixels (i.e. contiguous text not crossing a gutter).
// Shape: { labels, areas: [{id, mask, bbox, area, fontSize}], gridW, gridH, gutterMask }
let areasData = null;

// CSS-transform applied to the canvas via the `view` object below.
export const view = { scale: 1, x: 0, y: 0, cssW: 0, cssH: 0 };

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

  // viewport.transform: [scaleX, skewY, skewX, scaleY, tx, ty] — converts
  // PDF user-space (y-up) to viewport (y-down).
  const v = viewport.transform;
  const items = [];
  let xMin = Infinity, yMin = Infinity, xMax = -Infinity, yMax = -Infinity;

  for (const item of text.items) {
    if (!item.str) continue;
    const ix = item.transform[4];
    const iy = item.transform[5];
    const iw = item.width;
    const ih = item.height;
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
      x: cx0, y: cy0,
      w: cx1 - cx0, h: cy1 - cy0,
      fontSize: cy1 - cy0,
      str: item.str,
    });
    if (cx0 < xMin) xMin = cx0;
    if (cx1 > xMax) xMax = cx1;
    if (cy0 < yMin) yMin = cy0;
    if (cy1 > yMax) yMax = cy1;
  }

  if (!isFinite(xMin)) return empty;
  if ((xMax - xMin) < viewport.width  * 0.25 ||
      (yMax - yMin) < viewport.height * 0.25) {
    return empty;
  }
  return {
    textBbox: { x: xMin, y: yMin, w: xMax - xMin, h: yMax - yMin },
    items,
  };
}

// ── View transform ──────────────────────────────────────────────────────

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

const EDGE_MARGIN_PX = 8;
let lastConstrainMargin = EDGE_MARGIN_PX;

function constrainView(marginPx) {
  if (marginPx === undefined) marginPx = lastConstrainMargin;
  else lastConstrainMargin = marginPx;
  if (!textBbox) return;

  const minViewScale = fitScale() / renderScale;
  if (view.scale < minViewScale) view.scale = minViewScale;

  const eff = renderScale * view.scale;
  const bL = textBbox.x * eff;
  const bR = (textBbox.x + textBbox.w) * eff;
  const bT = textBbox.y * eff;
  const bB = (textBbox.y + textBbox.h) * eff;

  const xStrictMax = -bL;
  const xStrictMin = window.innerWidth - bR;
  if (xStrictMin > xStrictMax) {
    view.x = (xStrictMin + xStrictMax) / 2;
  } else {
    const xMax = xStrictMax + marginPx;
    const xMin = xStrictMin - marginPx;
    view.x = Math.max(xMin, Math.min(xMax, view.x));
  }

  const yStrictMax = -bT;
  const yStrictMin = window.innerHeight - bB;
  if (yStrictMin > yStrictMax) {
    view.y = (yStrictMin + yStrictMax) / 2;
  } else {
    const yMax = yStrictMax + marginPx;
    const yMin = yStrictMin - marginPx;
    view.y = Math.max(yMin, Math.min(yMax, view.y));
  }
}

async function renderAtScale(s) {
  if (renderTask) { renderTask.cancel(); renderTask = null; }
  if (!currentPdfPage) return;

  const dpr = window.devicePixelRatio || 1;
  const viewport = currentPdfPage.getViewport({ scale: s * dpr });
  const newWidth = Math.round(viewport.width);
  const newHeight = Math.round(viewport.height);

  const tempCanvas = document.createElement('canvas');
  tempCanvas.width = newWidth;
  tempCanvas.height = newHeight;
  const tempCtx = tempCanvas.getContext('2d');

  renderTask = currentPdfPage.render({ canvasContext: tempCtx, viewport });
  try {
    await renderTask.promise;
  } catch (e) {
    if (e?.name !== 'RenderingCancelledException') throw e;
    return;
  }
  renderTask = null;

  canvas.width = newWidth;
  canvas.height = newHeight;
  canvas.style.width = (pageW * s) + 'px';
  canvas.style.height = (pageH * s) + 'px';
  ctx.drawImage(tempCanvas, 0, 0);

  view.cssW = pageW * s;
  view.cssH = pageH * s;
  renderScale = s;

  if (overlay) {
    overlay.style.width = view.cssW + 'px';
    overlay.style.height = view.cssH + 'px';
  }
}

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
    view.scale = 1;
    view.x = prevX;
    view.y = prevY;
    constrainView();
    applyTransform(false);
  }, 80);
}

// ── Page load + area computation ───────────────────────────────────────

export async function loadPage(url, savedViewState = null) {
  areasData = null;
  document.getElementById('region-pending').classList.add('hidden');

  const pdfDoc = await pdfjsLib.getDocument({
    url,
    withCredentials: false,
    standardFontDataUrl: '/pdfjs/standard_fonts/',
    cMapUrl: '/pdfjs/cmaps/',
    cMapPacked: true,
    disableFontFace: true,
  }).promise;
  currentPdfPage = await pdfDoc.getPage(1);

  const natural = currentPdfPage.getViewport({ scale: 1 });
  pageW = natural.width;
  pageH = natural.height;

  const data = await computeTextData(currentPdfPage);
  textItems = data.items;
  textBbox = data.textBbox;

  ({ imageData: pixelImageData } = await renderPdfToImageData(currentPdfPage));
  recomputeAreas();

  if (savedViewState && savedViewState.effScale > 0) {
    await renderAtScale(savedViewState.effScale);
    view.scale = 1;
    view.x = window.innerWidth  / 2 - savedViewState.centerX * renderScale;
    view.y = window.innerHeight / 2 - savedViewState.centerY * renderScale;
  } else {
    await renderAtScale(fitScale());
    view.scale = 1;
    view.x = window.innerWidth  / 2 - (textBbox.x + textBbox.w / 2) * renderScale;
    view.y = window.innerHeight / 2 - (textBbox.y + textBbox.h / 2) * renderScale;
  }
  constrainView();
  applyTransform(false);
}

// Detection knobs — tweakable from the debug panel.
const PANEL_CONTROLS = [
  { key: 'minShort',      label: 'minShort (px)', min: 0, max: 50,   step: 1, def: 7 },
  { key: 'minLong',       label: 'minLong (px)',  min: 0, max: 1000, step: 1, def: 50 },
  { key: 'darkThreshold', label: 'darkThreshold', min: 0, max: 255,  step: 1, def: 150 },
];
const regionOpts = Object.fromEntries(PANEL_CONTROLS.map(c => [c.key, c.def]));

// Pick the most common (mode) font size of text items inside an area's
// pixel mask, rounded to 1pt buckets. Returns 0 if no text items land
// inside the area.
function dominantFontSize(mask, gridW, gridH, items) {
  const buckets = new Map();
  for (const it of items) {
    if (!(it.fontSize > 0)) continue;
    const cx = Math.floor(it.x + it.w / 2);
    const cy = Math.floor(it.y + it.h / 2);
    if (cx < 0 || cx >= gridW || cy < 0 || cy >= gridH) continue;
    if (!mask[cy * gridW + cx]) continue;
    const b = Math.round(it.fontSize);
    buckets.set(b, (buckets.get(b) || 0) + 1);
  }
  let best = 0, bestCount = 0;
  for (const [size, count] of buckets) {
    if (count > bestCount) { best = size; bestCount = count; }
  }
  return best;
}

// Compute the page's "areas" from the cached page render. Areas are
// 4-connected components of pixels NOT in the gutter mask. Each area
// carries a pixel mask, bbox, and the dominant font size of the text
// items that fall inside it.
function recomputeAreas() {
  if (!pixelImageData) { areasData = null; return; }

  const { darkThreshold, minShort, minLong } = regionOpts;
  const { grid, gridW, gridH } = buildGridFromImageData(pixelImageData, darkThreshold);
  const gutterMask = detectGutters(grid, gridW, gridH, { minShort, minLong });

  // detectRegions runs 4-connected CC on the non-gutter pixels and
  // returns {labels, regions: [{id, x, y, w, h, area}]}. We convert
  // each region into the richer "area" shape (mask + fontSize).
  const { labels, regions } = detectRegions(gutterMask, gridW, gridH);
  const N = gridW * gridH;
  const areas = regions.map(r => {
    const mask = new Uint8Array(N);
    for (let i = 0; i < N; i++) if (labels[i] === r.id) mask[i] = 1;
    return {
      id: r.id,
      mask,
      bbox: { x: r.x, y: r.y, w: r.w, h: r.h },
      area: r.area,
      fontSize: dominantFontSize(mask, gridW, gridH, textItems),
    };
  });

  areasData = { labels, areas, gridW, gridH, gutterMask };
  if (DEBUG_REGIONS) {
    drawDebugOverlay();
    updateDebugStatus();
  }
}

// ── View helpers exposed to gestures.js ────────────────────────────────

export function getViewState() {
  if (!textBbox) return null;
  const eff = renderScale * view.scale;
  if (eff <= 0) return null;
  return {
    effScale: eff,
    centerX: (window.innerWidth  / 2 - view.x) / eff,
    centerY: (window.innerHeight / 2 - view.y) / eff,
  };
}

export function animateTo(targetX, targetY, targetScale, onDone) {
  view.x = targetX;
  view.y = targetY;
  view.scale = targetScale;
  constrainView(EDGE_MARGIN_PX);
  applyTransform(true);

  canvas.addEventListener('transitionend', function handler() {
    canvas.removeEventListener('transitionend', handler);
    canvas.classList.remove('animating');
    scheduleQualityRender();
    onDone?.();
  }, { once: true });
}

export function effectiveScale() {
  return renderScale * view.scale;
}

function screenToPdf(clientX, clientY) {
  const r = canvas.getBoundingClientRect();
  return {
    x: (clientX - r.left) / view.scale / renderScale,
    y: (clientY - r.top)  / view.scale / renderScale,
  };
}

// Find the area under a screen point. Tap on a gutter pixel returns
// null. To make the interaction forgiving for taps that just barely
// miss text, we expand outward to find the nearest labeled pixel
// within HIT_LEEWAY_PX pixels.
const HIT_LEEWAY_PX = 8;
export function findAreaAtPoint(clientX, clientY) {
  if (!areasData) return null;
  const { labels, areas, gridW, gridH } = areasData;
  const { x: px, y: py } = screenToPdf(clientX, clientY);
  const cx = Math.floor(px);
  const cy = Math.floor(py);
  if (cx < 0 || cy < 0 || cx >= gridW || cy >= gridH) return null;

  let lbl = labels[cy * gridW + cx];
  if (lbl === 0) {
    let bestD2 = Infinity;
    const r = HIT_LEEWAY_PX;
    const x0 = Math.max(0, cx - r), x1 = Math.min(gridW - 1, cx + r);
    const y0 = Math.max(0, cy - r), y1 = Math.min(gridH - 1, cy + r);
    for (let yy = y0; yy <= y1; yy++) {
      const row = yy * gridW;
      const dy = yy - cy;
      for (let xx = x0; xx <= x1; xx++) {
        const l = labels[row + xx];
        if (l === 0) continue;
        const dx = xx - cx;
        const d2 = dx * dx + dy * dy;
        if (d2 < bestD2) { bestD2 = d2; lbl = l; }
      }
    }
  }
  if (lbl === 0) return null;
  return areas.find(a => a.id === lbl) ?? null;
}

// Compute the view transform that:
//   • puts the tap's y at the viewport centre
//   • centres horizontally on the area's pixel column at the tap's y
//     (so an L-shaped area centres on whichever arm the tap landed in)
//   • scales so a glyph of the area's fontSize displays at `targetFontPx`
//     screen pixels.
export function transformForArea(area, clientX, clientY, targetFontPx) {
  if (!area || !(area.fontSize > 0) || !(targetFontPx > 0)) return null;
  const desiredEff = targetFontPx / area.fontSize;
  const visualScale = desiredEff / renderScale;
  const r = canvas.getBoundingClientRect();
  const tapPdfY = (clientY - r.top) / view.scale / renderScale;
  const colX = areaRowCenterX(area, tapPdfY);
  return {
    x: window.innerWidth  / 2 - colX    * desiredEff,
    y: window.innerHeight / 2 - tapPdfY * desiredEff,
    scale: visualScale,
  };
}

function areaRowCenterX(area, pdfY) {
  const fallback = area.bbox.x + area.bbox.w / 2;
  if (!areasData) return fallback;
  const { labels, gridW, gridH } = areasData;
  const ty = Math.floor(pdfY);
  if (ty < 0 || ty >= gridH) return fallback;
  let xMin = Infinity, xMax = -Infinity;
  const rowBase = ty * gridW;
  for (let x = 0; x < gridW; x++) {
    if (labels[rowBase + x] === area.id) {
      if (x < xMin) xMin = x;
      if (x > xMax) xMax = x;
    }
  }
  return xMin === Infinity ? fallback : (xMin + xMax + 1) / 2;
}

export function transformForScroll(dx, dy) {
  return { x: view.x + dx, y: view.y + dy, scale: view.scale };
}

export function transformForHome() {
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
  constrainView(EDGE_MARGIN_PX);
  applyTransform(false);
}

export { canvas };

// ── Debug overlay (?debug=1 or 'd' key) ────────────────────────────────

const REGION_COLORS = [
  [80, 255, 130], [255, 200, 50], [150, 170, 255], [255, 130, 200],
  [130, 255, 230], [255, 160, 90], [200, 130, 255],
];

const debugDisplay = { mask: false, areas: true, ids: true };
let panelStatusEl = null;
let mouseCoordEl = null;
const sliderRefs = new Map();

function createDebugPanel() {
  if (document.getElementById('region-debug-panel')) return;
  const panel = document.createElement('div');
  panel.id = 'region-debug-panel';
  panel.style.cssText = `
    position: fixed; top: 8px; right: 8px; z-index: 100;
    background: rgba(20, 12, 6, 0.92); color: rgba(255, 230, 170, 0.95);
    padding: 10px 12px; border-radius: 8px;
    font: 11px ui-monospace, monospace;
    pointer-events: auto; user-select: none;
    box-shadow: 0 2px 12px rgba(0,0,0,0.6);
    min-width: 220px;
  `;

  const title = document.createElement('div');
  title.textContent = '⠿ area tuning';
  title.style.cssText = 'font-weight:600;margin-bottom:6px;opacity:0.7;cursor:move;';
  panel.appendChild(title);
  enablePanelDrag(panel, title);

  const toggleRow = document.createElement('div');
  toggleRow.style.cssText = 'display:flex;gap:12px;margin:2px 0 8px;';
  toggleRow.appendChild(makeToggle('mask',  debugDisplay.mask,  v => { debugDisplay.mask  = v; drawDebugOverlay(); }));
  toggleRow.appendChild(makeToggle('areas', debugDisplay.areas, v => { debugDisplay.areas = v; drawDebugOverlay(); }));
  toggleRow.appendChild(makeToggle('ids',   debugDisplay.ids,   v => { debugDisplay.ids   = v; drawDebugOverlay(); }));
  panel.appendChild(toggleRow);

  for (const c of PANEL_CONTROLS) {
    const row = document.createElement('label');
    row.style.cssText = 'display:flex;align-items:center;gap:8px;margin:4px 0;';
    const name = document.createElement('span');
    name.textContent = c.label;
    name.style.cssText = 'flex:0 0 110px;';
    row.appendChild(name);
    const input = document.createElement('input');
    input.type = 'range';
    input.min = c.min; input.max = c.max; input.step = c.step;
    input.value = regionOpts[c.key];
    input.style.cssText = 'flex:1;min-width:60px;';
    row.appendChild(input);
    const val = document.createElement('span');
    val.textContent = String(regionOpts[c.key]);
    val.style.cssText = 'flex:0 0 50px;text-align:right;';
    row.appendChild(val);
    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      regionOpts[c.key] = v;
      val.textContent = String(v);
      recomputeAreas();
    });
    sliderRefs.set(c.key, { input, val });
    panel.appendChild(row);
  }

  panelStatusEl = document.createElement('div');
  panelStatusEl.style.cssText = 'margin-top:6px;opacity:0.75;font-size:10px;line-height:1.4;';
  panel.appendChild(panelStatusEl);

  mouseCoordEl = document.createElement('div');
  mouseCoordEl.style.cssText = 'margin-top:4px;opacity:0.75;font-size:10px;line-height:1.4;';
  mouseCoordEl.textContent = 'px: -';
  panel.appendChild(mouseCoordEl);

  document.body.appendChild(panel);
  updateDebugStatus();

  window.addEventListener('mousemove', (e) => {
    if (!mouseCoordEl || !areasData) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const relX = e.clientX - rect.left;
    const relY = e.clientY - rect.top;
    const { gridW, gridH, labels } = areasData;
    if (relX < 0 || relY < 0 || relX > rect.width || relY > rect.height) {
      mouseCoordEl.textContent = `px: - / ${gridW}×${gridH}`;
      return;
    }
    const px = Math.floor((relX / rect.width)  * pageW);
    const py = Math.floor((relY / rect.height) * pageH);
    const lbl = labels[py * gridW + px] || 0;
    mouseCoordEl.textContent = `px: (${px}, ${py}) area=${lbl || '-'} / ${gridW}×${gridH}`;
  });
}

function makeToggle(label, initial, onChange) {
  const wrap = document.createElement('label');
  wrap.style.cssText = 'display:flex;align-items:center;gap:4px;cursor:pointer;';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = initial;
  cb.style.cssText = 'margin:0;cursor:pointer;';
  cb.addEventListener('change', () => onChange(cb.checked));
  wrap.appendChild(cb);
  const text = document.createElement('span');
  text.textContent = label;
  wrap.appendChild(text);
  return wrap;
}

const PANEL_POS_KEY = 'regionDebugPanelPos';
function enablePanelDrag(panel, handle) {
  try {
    const saved = JSON.parse(localStorage.getItem(PANEL_POS_KEY) || 'null');
    if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
      panel.style.left = saved.left + 'px';
      panel.style.top  = saved.top  + 'px';
      panel.style.right = 'auto';
    }
  } catch {}
  let dragging = false;
  let startX = 0, startY = 0, startLeft = 0, startTop = 0;
  const onDown = (e) => {
    const point = e.touches ? e.touches[0] : e;
    dragging = true;
    const rect = panel.getBoundingClientRect();
    panel.style.left  = rect.left + 'px';
    panel.style.top   = rect.top  + 'px';
    panel.style.right = 'auto';
    startX = point.clientX; startY = point.clientY;
    startLeft = rect.left; startTop = rect.top;
    e.preventDefault();
  };
  const onMove = (e) => {
    if (!dragging) return;
    const point = e.touches ? e.touches[0] : e;
    const left = Math.max(0, Math.min(window.innerWidth  - panel.offsetWidth,  startLeft + (point.clientX - startX)));
    const top  = Math.max(0, Math.min(window.innerHeight - panel.offsetHeight, startTop  + (point.clientY - startY)));
    panel.style.left = left + 'px';
    panel.style.top  = top  + 'px';
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    try {
      localStorage.setItem(PANEL_POS_KEY, JSON.stringify({
        left: parseFloat(panel.style.left), top: parseFloat(panel.style.top),
      }));
    } catch {}
  };
  handle.addEventListener('mousedown',  onDown);
  window.addEventListener('mousemove',  onMove);
  window.addEventListener('mouseup',    onUp);
  handle.addEventListener('touchstart', onDown, { passive: false });
  window.addEventListener('touchmove',  onMove, { passive: false });
  window.addEventListener('touchend',   onUp);
}

function updateDebugStatus() {
  if (!panelStatusEl || !areasData) return;
  const { gridW, gridH, areas } = areasData;
  panelStatusEl.textContent = `${gridW}×${gridH} grid · ${areas.length} areas`;
}

// Paint the gutter mask (red) + each area in a cycling color. No
// merging, no filtering — areas are the raw CCs of the gutter mask.
function drawDebugOverlay() {
  if (!overlay || !areasData) return;
  overlay.innerHTML = '';
  const { gutterMask, labels, areas, gridW, gridH } = areasData;
  const N = gridW * gridH;
  const overlayStyle =
    'position:absolute;top:0;left:0;width:100%;height:100%;' +
    'image-rendering:pixelated;image-rendering:crisp-edges;' +
    'pointer-events:none;';

  if (debugDisplay.mask) {
    const cvs = document.createElement('canvas');
    cvs.width = gridW; cvs.height = gridH; cvs.style.cssText = overlayStyle;
    const cctx = cvs.getContext('2d');
    const img = cctx.createImageData(gridW, gridH);
    for (let i = 0; i < N; i++) {
      if (!gutterMask[i]) continue;
      const o = i * 4;
      img.data[o] = 255; img.data[o+1] = 80; img.data[o+2] = 80; img.data[o+3] = 100;
    }
    cctx.putImageData(img, 0, 0);
    overlay.appendChild(cvs);
  }

  if (debugDisplay.areas) {
    const cvs = document.createElement('canvas');
    cvs.width = gridW; cvs.height = gridH; cvs.style.cssText = overlayStyle;
    const cctx = cvs.getContext('2d');
    const img = cctx.createImageData(gridW, gridH);
    for (let y = 0; y < gridH; y++) {
      for (let x = 0; x < gridW; x++) {
        const i = y * gridW + x;
        const lbl = labels[i];
        if (!lbl) continue;
        const color = REGION_COLORS[(lbl - 1) % REGION_COLORS.length];
        const isBoundary =
          (x === 0)         || labels[i - 1]     !== lbl ||
          (x === gridW - 1) || labels[i + 1]     !== lbl ||
          (y === 0)         || labels[i - gridW] !== lbl ||
          (y === gridH - 1) || labels[i + gridW] !== lbl;
        if (!isBoundary) continue;
        const o = i * 4;
        img.data[o] = color[0]; img.data[o+1] = color[1]; img.data[o+2] = color[2]; img.data[o+3] = 220;
      }
    }
    cctx.putImageData(img, 0, 0);
    overlay.appendChild(cvs);
  }

  if (debugDisplay.ids) {
    for (const a of areas) {
      const cx = (a.bbox.x + a.bbox.w / 2) / gridW * 100;
      const cy = (a.bbox.y + a.bbox.h / 2) / gridH * 100;
      const color = REGION_COLORS[(a.id - 1) % REGION_COLORS.length];
      const tag = document.createElement('div');
      tag.textContent = `${a.id}${a.fontSize > 0 ? ' · ' + a.fontSize : ''}`;
      tag.style.cssText =
        'position:absolute;transform:translate(-50%,-50%);pointer-events:none;' +
        `left:${cx}%;top:${cy}%;` +
        'font:bold 11px ui-monospace,monospace;color:#000;' +
        'padding:1px 5px;border-radius:8px;' +
        `background:rgba(${color[0]},${color[1]},${color[2]},0.95);` +
        'box-shadow:0 0 3px rgba(0,0,0,0.7);';
      overlay.appendChild(tag);
    }
  }
}
