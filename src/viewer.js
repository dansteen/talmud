import * as pdfjsLib from 'pdfjs-dist';
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { detectRegions } from './regions.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

const canvas = document.getElementById('page-canvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true });
const overlay = document.getElementById('region-overlay');

// Region overlay is shown when ?debug=1 is in the URL or after pressing 'd'.
const DEBUG_REGIONS = new URLSearchParams(location.search).has('debug');
if (DEBUG_REGIONS) {
  overlay.classList.add('visible');
  // Defer panel creation so the DOM is ready and module state is set up.
  queueMicrotask(createRegionDebugPanel);
}
window.addEventListener('keydown', e => {
  if (e.key === 'd' || e.key === 'D') overlay.classList.toggle('visible');
});

// Read ?cellSize=&closeRadius=&minRegionFrac= so the detection knobs can be
// tuned in the URL while we dial them in.
function regionTuneFromUrl() {
  const p = new URLSearchParams(location.search);
  const opts = {};
  const num = (key) => {
    const v = parseFloat(p.get(key));
    return Number.isFinite(v) ? v : null;
  };
  const cs = num('cellSize');         if (cs !== null) opts.cellSize = cs;
  const cr = num('closeRadius');      if (cr !== null) opts.closeRadius = cr;
  const nm = num('noiseMinCells');    if (nm !== null) opts.noiseMinCells = nm;
  const sl = num('singleLineMaxX');   if (sl !== null) opts.singleLineMaxX = sl;
  const mf = num('minRegionFrac');    if (mf !== null) opts.minRegionFraction = mf;
  return opts;
}

// Page geometry (set once per loaded page)
let pageW = 1;       // natural PDF width (PDF points)
let pageH = 1;       // natural PDF height (PDF points)
let renderScale = 1; // scale at which the canvas was last rendered

// Bounding box of all text on the current page in viewport-coordinate units
// (y top-down). Tight to the text — drives "fit" scale and the pan/zoom
// constraint so the empty bottom of the daf stays off-screen during pinch/pan.
let textBbox = null;

// Per-item rectangles + font size in viewport-coordinate units (y top-down).
// Used by findItemAtPoint() for smart double-tap zoom.
let textItems = [];

// Region detection result: { regions, labels, gridW, gridH, cellSize } or null
// before any page has loaded. The labeled grid drives O(1) hit-testing.
let regionsData = null;

// Visual transform applied to the canvas via CSS
export const view = {
  scale: 1,  // visual scale on top of the canvas's natural CSS size
  x: 0,
  y: 0,
  cssW: 0,   // canvas natural CSS width (= pageW * renderScale)
  cssH: 0,
};

// `regions` exposes the latest detection result for gestures.js / debug.
// Null until the first page loads.
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
// Whitespace breathing room (in screen pixels) between the text bbox edge
// and the screen edge when zoomed in (bbox wider than the viewport). Sized
// to roughly match the natural margin that the 0.98-of-screen fitScale
// gives at full zoom-out — keeps a small consistent strip of whitespace
// at the screen edge instead of pushing text flush against it. At full
// zoom-out constrainView ignores this and forces exact centering.
const EDGE_MARGIN_PX = 8;

// Last `marginPx` passed to constrainView — used as the default for callers
// that don't pass one explicitly (e.g., scheduleQualityRender, which fires
// after a settled gesture and shouldn't undo whatever margin was in effect).
let lastConstrainMargin = EDGE_MARGIN_PX;

// Clamp view.scale (no-pinch-out-past-fit) and view.x/view.y so the visible
// viewport stays within the bbox. `marginPx` allows that many screen pixels
// of empty area beyond the bbox edge.
function constrainView(marginPx) {
  if (marginPx === undefined) marginPx = lastConstrainMargin;
  else lastConstrainMargin = marginPx;
  if (!textBbox) return;

  const minViewScale = fitScale() / renderScale;
  if (view.scale < minViewScale) view.scale = minViewScale;

  const eff = renderScale * view.scale; // PDF-points → screen-pixels
  const bL = textBbox.x * eff;
  const bR = (textBbox.x + textBbox.w) * eff;
  const bT = textBbox.y * eff;
  const bB = (textBbox.y + textBbox.h) * eff;

  // Two phases per axis:
  //   - bbox narrower than viewport (zoomed out): center the bbox, ignore
  //     margin. This avoids leftover pan slack at full zoom-out.
  //   - bbox wider than viewport (zoomed in): clamp with the margin so
  //     pan/zoom near the page edge keeps a sliver of whitespace between
  //     the text and the screen edge.
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

  // Render to a temporary off-DOM canvas first. The visible canvas keeps its
  // current bitmap during the render — without this, setting canvas.width
  // before render would clear the bitmap and the user would see a blank
  // canvas for the 100–300ms it takes pdf.js to paint (the "blink").
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

  // Atomic swap. Resizing canvas.width clears the bitmap; immediately
  // drawImage'ing the new bitmap before yielding back to the browser means
  // the browser only paints once with the final state — no blank frame.
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

// After a gesture settles, re-render at higher resolution. Short debounce so
// the user only stares at the CSS-upscaled (blurry) bitmap briefly before the
// crisp re-render replaces it. clearTimeout cancels any in-flight schedule
// when a new gesture starts.
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
  }, 80);
}

export async function loadPage(url, savedViewState = null) {
  regions = null;
  regionsData = null;
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
  const data = await computeTextData(currentPdfPage);
  textItems = data.items;
  textBbox = data.textBbox;

  // Detect regions from the per-item rects: low-res occupancy grid,
  // morphological closing, connected components. Tunable via URL params
  // ?cellSize=&closeRadius=&minRegionFrac= and live via the debug panel.
  recomputeRegions(regionTuneFromUrl());

  // If we have a saved zoom/center for this page, render at that scale and
  // place the saved center at the screen center. Otherwise default to home
  // (text bbox fit).
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

// Current detection options — initial values come from the URL, can be
// updated live via the debug panel sliders.
let regionOpts = {};

function recomputeRegions(opts) {
  if (opts) regionOpts = { ...regionOpts, ...opts };
  if (!textItems.length) {
    regionsData = null;
    regions = null;
    drawRegionOverlay();
    return;
  }
  regionsData = detectRegions(textItems, pageW, pageH, regionOpts);
  regions = regionsData.regions;
  if (DEBUG_REGIONS) {
    const { gridW, gridH, cellSize, regions: regs } = regionsData;
    // eslint-disable-next-line no-console
    console.log(
      `[regions] cell=${cellSize}pt grid=${gridW}x${gridH}`,
      `→ ${regs.length} regions`,
      regs.map(r => `#${r.id} fs=${r.fontSize.toFixed(1)} cells=${r.pixelCount} items=${r.itemCount}`),
    );
    updateDebugPanelStatus();
  }
  drawRegionOverlay();
}

// ── Debug controls (?debug=1) ───────────────────────────────────────────

const PANEL_CONTROLS = [
  { key: 'cellSize',          label: 'cellSize (pt)',     min: 1,  max: 10,   step: 0.5,    def: 4 },
  { key: 'closeRadius',       label: 'closeRadius',       min: 0,  max: 6,    step: 1,      def: 1 },
  { key: 'noiseMinCells',     label: 'noiseMinCells',     min: 0,  max: 50,   step: 1,      def: 5 },
  { key: 'singleLineMaxX',    label: 'singleLine maxX pt', min: 0,  max: 200,  step: 5,      def: 0 },
  { key: 'minRegionFraction', label: 'minRegionFrac',     min: 0,  max: 0.02, step: 0.0005, def: 0.002 },
];

let panelStatusEl = null;

function createRegionDebugPanel() {
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
  title.textContent = 'region tuning';
  title.style.cssText = 'font-weight:600;margin-bottom:6px;opacity:0.7;';
  panel.appendChild(title);

  for (const c of PANEL_CONTROLS) {
    const initial = (regionOpts[c.key] ?? regionTuneFromUrl()[c.key]) ?? c.def;
    regionOpts[c.key] = initial;

    const row = document.createElement('label');
    row.style.cssText = 'display:flex;align-items:center;gap:8px;margin:4px 0;';

    const name = document.createElement('span');
    name.textContent = c.label;
    name.style.cssText = 'flex:0 0 110px;';
    row.appendChild(name);

    const input = document.createElement('input');
    input.type = 'range';
    input.min = c.min; input.max = c.max; input.step = c.step;
    input.value = initial;
    input.style.cssText = 'flex:1;min-width:60px;';
    row.appendChild(input);

    const val = document.createElement('span');
    val.textContent = formatVal(initial, c.step);
    val.style.cssText = 'flex:0 0 50px;text-align:right;';
    row.appendChild(val);

    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      val.textContent = formatVal(v, c.step);
      recomputeRegions({ [c.key]: v });
    });

    panel.appendChild(row);
  }

  panelStatusEl = document.createElement('div');
  panelStatusEl.style.cssText = 'margin-top:6px;opacity:0.75;font-size:10px;line-height:1.4;';
  panel.appendChild(panelStatusEl);

  document.body.appendChild(panel);
  updateDebugPanelStatus();
}

function formatVal(v, step) {
  // Show appropriate decimal places based on the step size.
  if (step >= 1)    return String(v);
  if (step >= 0.1)  return v.toFixed(1);
  if (step >= 0.01) return v.toFixed(2);
  return v.toFixed(4);
}

function updateDebugPanelStatus() {
  if (!panelStatusEl || !regionsData) return;
  const { gridW, gridH, regions: regs } = regionsData;
  panelStatusEl.textContent = `${gridW}×${gridH} grid · ${regs.length} regions`;
}

// ── Debug overlay (?debug=1 or 'd' key) ────────────────────────────────

// Distinct-but-readable hues for region IDs. Cycled if there are more
// regions than colors.
const REGION_COLORS = [
  [80, 255, 130],   // gemara-green
  [255, 200, 50],   // commentary-amber
  [150, 170, 255],  // reference-blue
  [255, 130, 200],  // pink
  [130, 255, 230],  // teal
  [255, 160, 90],   // orange
  [200, 130, 255],  // violet
];

// Render the labeled grid as a translucent pixel mask + per-region bbox
// outlines. The pixel mask shows the actual non-rectangular region shape
// (L's, T's, etc.); bbox outlines are useful for "this is what would be
// the zoom target".
function drawRegionOverlay() {
  if (!overlay) return;
  overlay.innerHTML = '';
  if (!regionsData) return;

  const { labels, gridW, gridH, cellSize, regions: regs } = regionsData;

  // Pixel mask via an offscreen canvas at grid resolution, scaled up via CSS.
  // image-rendering: pixelated keeps the cell boundaries crisp.
  const mask = document.createElement('canvas');
  mask.width = gridW;
  mask.height = gridH;
  mask.style.cssText =
    'position:absolute;inset:0;width:100%;height:100%;' +
    'image-rendering:pixelated;image-rendering:crisp-edges;' +
    'pointer-events:none;';
  const mctx = mask.getContext('2d');
  const img = mctx.createImageData(gridW, gridH);
  for (let i = 0; i < gridW * gridH; i++) {
    const lbl = labels[i];
    if (lbl === 0) continue;
    const [r, g, b] = REGION_COLORS[(lbl - 1) % REGION_COLORS.length];
    const o = i * 4;
    img.data[o + 0] = r;
    img.data[o + 1] = g;
    img.data[o + 2] = b;
    img.data[o + 3] = 70; // semi-transparent so the underlying text reads
  }
  mctx.putImageData(img, 0, 0);
  overlay.appendChild(mask);

  // Bbox outline + label per region.
  for (const reg of regs) {
    const [r, g, b] = REGION_COLORS[(reg.id - 1) % REGION_COLORS.length];
    const box = document.createElement('div');
    box.style.cssText =
      `position:absolute;` +
      `left:${(reg.bbox.x / pageW * 100)}%;` +
      `top:${(reg.bbox.y / pageH * 100)}%;` +
      `width:${(reg.bbox.w / pageW * 100)}%;` +
      `height:${(reg.bbox.h / pageH * 100)}%;` +
      `border:2px solid rgba(${r},${g},${b},0.9);` +
      `box-sizing:border-box;pointer-events:none;`;
    overlay.appendChild(box);

    const label = document.createElement('span');
    label.style.cssText =
      `position:absolute;` +
      `left:${(reg.bbox.x / pageW * 100)}%;` +
      `top:${(reg.bbox.y / pageH * 100)}%;` +
      `font:10px/1.2 ui-monospace,monospace;color:white;` +
      `background:rgba(0,0,0,0.75);padding:1px 4px;white-space:nowrap;` +
      `pointer-events:none;`;
    label.textContent = `#${reg.id} fs${reg.fontSize.toFixed(1)} n${reg.itemCount}`;
    overlay.appendChild(label);
  }
}

// Snapshot of the current view in PDF-coordinate units that survives the
// canvas being re-rendered at a different renderScale. Saved per-page so
// switching back restores the user's last zoom + position.
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

// Look up the region under a screen point via the labeled grid.
// Returns the region object (with bbox + fontSize + …) or null for whitespace.
export function findRegionAtPoint(clientX, clientY) {
  if (!regionsData) return null;
  const { x: px, y: py } = screenToPdf(clientX, clientY);
  const { labels, gridW, gridH, cellSize, regions: regs } = regionsData;
  const cx = Math.floor(px / cellSize);
  const cy = Math.floor(py / cellSize);
  if (cx < 0 || cy < 0 || cx >= gridW || cy >= gridH) return null;
  const lbl = labels[cy * gridW + cx];
  if (lbl === 0) return null;
  return regs.find(r => r.id === lbl) ?? null;
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

// Compute a target view transform that keeps the current scale and shifts so
// the screen point (clientX, clientY) ends up at viewport center. Used by
// double-tap "scroll" — same font size as current zoom, just re-center.
export function transformForCentering(clientX, clientY) {
  const r = canvas.getBoundingClientRect();
  const localX = (clientX - r.left) / view.scale;
  const localY = (clientY - r.top)  / view.scale;
  return {
    x: window.innerWidth  / 2 - localX * view.scale,
    y: window.innerHeight / 2 - localY * view.scale,
    scale: view.scale,
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
  // Same edge margin as animated transitions — keeps the visual feel
  // consistent whether the user is pinching or double-tap zooming.
  constrainView(EDGE_MARGIN_PX);
  applyTransform(false);
}

export { canvas };
