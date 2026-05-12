import * as pdfjsLib from 'pdfjs-dist';
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { detectRegions } from './regions.js';
import { renderPdfToImageData, buildGridFromImageData, detectGutters, detectRegionBoxes } from './regionsPixel.js';

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
  const cs  = num('cellSize');         if (cs  !== null) opts.cellSize = cs;
  const crx = num('closeRadiusX');     if (crx !== null) opts.closeRadiusX = crx;
  const cry = num('closeRadiusY');     if (cry !== null) opts.closeRadiusY = cry;
  const crys = num('closeRadiusYSide');if (crys!== null) opts.closeRadiusYSide = crys;
  const szf = num('sideZoneFraction'); if (szf !== null) opts.sideZoneFraction = szf;
  const mir = num('maxIsolatedRun');   if (mir !== null) opts.maxIsolatedRun = mir;
  const mig = num('minIsolationGap');  if (mig !== null) opts.minIsolationGap = mig;
  const meb = num('minEmptyBelow');    if (meb !== null) opts.minEmptyBelow = meb;
  const mf  = num('minRegionFrac');    if (mf  !== null) opts.minRegionFraction = mf;
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
// Fed to detectRegions() each time we re-tune detection knobs.
let textItems = [];

// Region detection result: { regions, labels, gridW, gridH, cellSize } or null
// before any page has loaded. The labeled grid drives O(1) hit-testing.
let regionsData = null;

// Off-screen render result for the current page. Cached so darkThreshold
// slider tweaks can rebuild the grid without re-rendering the PDF.
let pixelImageData = null;

// Set per page during loadPage from computeTextData. Drives the auto-tuner's
// expected region count (perek-end pages have ~double the regions).
let pageIsPerekEnd = false;

// Diagnostics from the most recent auto-tune attempt — surfaced in the debug
// panel.
let lastTuneInfo = null;

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
  const empty = { textBbox: fullPage, items: [], perekEnd: false };

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
  let allText = '';

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
      str: item.str,
    });
    allText += item.str + ' ';

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

  // "הדרן עלך …" marks the end of a perek. These pages typically have ~2x the
  // usual region count (the page splits between the closing perek and the
  // opening of the next). The phrase is unique enough that a substring match
  // on the concatenated text content is reliable.
  const perekEnd = allText.includes('הדרן');

  return {
    textBbox: { x: xMin, y: yMin, w: xMax - xMin, h: yMax - yMin },
    items,
    perekEnd,
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
  pageIsPerekEnd = data.perekEnd;

  // Pixel-based region detection: render the page off-screen at scale 1
  // and build an occupancy grid from the actual rendered ink (text glyphs,
  // rule lines, decorative borders). Connected components on this grid
  // produces regions whose shapes match what's visible, with no auto-tune
  // ladder, no target count, and no font-name guessing. textItems are
  // still passed in so each region can be labeled with median fontSize
  // and item count.
  // Render the PDF off-screen once per page; the grid is rebuilt later
  // (in drawRegionOverlay) using whatever darkThreshold the slider is at,
  // so re-tuning doesn't require re-rendering.
  ({ imageData: pixelImageData } = await renderPdfToImageData(currentPdfPage));
  applyPixelDetection(regionTuneFromUrl());

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
  applyPixelDetection(opts);
}

// Just rebuild the overlay. drawRegionOverlay rebuilds the cell grid
// from the cached pixel data using the current slider settings, then
// paints gutter cells. No region detection on this branch — gutters
// only.
function applyPixelDetection(opts) {
  if (opts) regionOpts = { ...regionOpts, ...opts };
  regionsData = null;
  regions = null;
  if (DEBUG_REGIONS) {
    syncDebugPanelSliders();
    updateDebugPanelStatus();
  }
  drawRegionOverlay();
}

// ── Auto-tuner ──────────────────────────────────────────────────────────
//
// After a page loads, run the detector with a small ladder of overrides on
// top of the base options (URL params, if any) and pick the attempt whose
// significant-region count best matches expectations. "Significant" means
// the region isn't a stray catchword / running head / page number — those
// are filtered before counting (they still appear in the result).
//
// Expected counts:
//   - normal page:    4-5 regions (target 5; bias toward 5)
//   - perek-end page: 8-10 regions (target 9)
//
// Strategy: try defaults first, then increasing closeRadiusY (bridges
// line gaps within a column without bridging columns), then variants that
// drop side closing (separates side meforshim from gemara). Selection is
// tiered: clean in-range > overmerged in-range > clean out-of-range >
// overmerged out-of-range, ties broken by closeness to target. We never
// invent a synthetic single-region result — the natural detection output
// is always more useful than collapsing the page into one region.

// Sweep every integer Y from 1..10 (Y=0 is the default = attempt 1) and
// every integer YSide reduction from 4..0 (YSide=5 is the default).
// Skipping values misses pages whose sweet spot lands on the skipped
// integer; the cost of a few extra detectRegions calls is small and the
// auto-tuner early-exits the moment it finds a perfect match.
function buildTuningAttempts() {
  const attempts = [null];                                 // defaults (Y=0, YSide=5)
  for (let y = 1; y <= 10; y++) attempts.push({ closeRadiusY: y });
  for (let s = 4; s >= 0; s--) attempts.push({ closeRadiusYSide: s });
  attempts.push({ closeRadiusY: 0, closeRadiusYSide: 0 });  // drop everything
  return attempts;
}
const TUNING_ATTEMPTS = buildTuningAttempts();

// Extra attempts run only when the basic ladder shows side-over-segmentation
// (a side column split into multiple non-stray pieces). We bump
// closeRadiusYSide above the default to bridge wider line gaps inside the
// side column. The overmerge-width check protects us from picking a value
// so large that the left and right columns fuse via a vertical strip.
const SIDE_ESCALATION_ATTEMPTS = [
  { closeRadiusYSide: 6 },
  { closeRadiusYSide: 7 },
  { closeRadiusYSide: 8 },
  { closeRadiusYSide: 10 },
  { closeRadiusYSide: 12 },
  { closeRadiusYSide: 15 },
  { closeRadiusYSide: 20 },
];

// A region is "stray" if it's almost certainly noise we don't want to count
// against the target — page numbers, running heads, catchwords, and thin
// fragmentary slivers. Cases:
//   - very thin (< ~2% of page height) — single-line slivers anywhere on
//     the page; legitimate columns are always many lines tall
//   - small blob (narrow AND short) — page numbers, marginal marks
//   - thin line near the top or bottom edge — running heads, catchwords
// Tall narrow regions are NOT stray: side meforshim (Tosafot, Mesores
// HaShas, Ein Mishpat) sit in narrow columns and are full-height.
function isStrayRegion(r) {
  const wRel = r.bbox.w / pageW;
  const hRel = r.bbox.h / pageH;
  const yCenter = (r.bbox.y + r.bbox.h / 2) / pageH;
  if (hRel < 0.02) return true;
  if (wRel < 0.08 && hRel < 0.20) return true;
  if (hRel < 0.04 && (yCenter < 0.10 || yCenter > 0.90)) return true;
  return false;
}

function countSignificantRegions(regs) {
  let n = 0;
  for (const r of regs) if (!isStrayRegion(r)) n++;
  return n;
}

// Reject a tuning result that contains a non-stray region wider than this
// fraction of the page — the legitimate gemara column tops out around ~50%
// of page width on a 3-column daf, so anything wider is almost certainly a
// gemara+rashi (or gemara+tosafot) merge.
const OVERMERGED_WIDTH_FRAC = 0.55;

function isOvermerged(regs) {
  for (const r of regs) {
    if (isStrayRegion(r)) continue;
    if (r.bbox.w / pageW > OVERMERGED_WIDTH_FRAC) return true;
  }
  return false;
}

// A side column is "over-segmented" when more than one non-stray region's
// centroid sits in the leftmost or rightmost ~15% of the page. Side
// commentary text (Tosafot, Mesores HaShas, etc.) often has wider line
// spacing than the gemara, so the default closing radius can leave each
// physical paragraph as its own component. When this happens we want to
// try higher closeRadiusYSide values to bridge those line gaps.
const SIDE_BAND_FRAC = 0.15;

function sideOverSegmented(regs) {
  let left = 0, right = 0;
  for (const r of regs) {
    if (isStrayRegion(r)) continue;
    const cx = (r.bbox.x + r.bbox.w / 2) / pageW;
    if (cx < SIDE_BAND_FRAC) left++;
    else if (cx > 1 - SIDE_BAND_FRAC) right++;
  }
  return left > 1 || right > 1;
}

function autoTuneAndApply(baseOpts) {
  if (!textItems.length) {
    regionOpts = { ...regionOpts, ...baseOpts };
    regionsData = null;
    regions = null;
    lastTuneInfo = null;
    if (DEBUG_REGIONS) {
      syncDebugPanelSliders();
      updateDebugPanelStatus();
    }
    drawRegionOverlay();
    return;
  }

  const target = pageIsPerekEnd ? 9 : 5;
  const minOk  = pageIsPerekEnd ? 8 : 4;
  const maxOk  = pageIsPerekEnd ? 10 : 5;

  const tries = [];
  let chosen = null;

  const runAttempt = (adj, idx) => {
    const opts = adj === null ? { ...regionOpts, ...baseOpts }
                              : { ...regionOpts, ...baseOpts, ...adj };
    const data = detectRegions(textItems, pageW, pageH, opts);
    const sig = countSignificantRegions(data.regions);
    const overmerged = isOvermerged(data.regions);
    const sideOver = sideOverSegmented(data.regions);
    tries.push({ opts, data, sig, overmerged, sideOver, idx });
    return tries[tries.length - 1];
  };

  for (let i = 0; i < TUNING_ATTEMPTS.length; i++) {
    const t = runAttempt(TUNING_ATTEMPTS[i], i);
    // Early exit on a "perfect" hit — exact target, no overmerge, sides not
    // over-segmented.
    if (t.sig === target && !t.overmerged && !t.sideOver) {
      chosen = { ...t, status: 'matched-target', attempts: i + 1 };
      break;
    }
  }

  // If any basic-ladder attempt showed side-over-segmentation, escalate by
  // bumping closeRadiusYSide. This bridges the wider line gaps in a side
  // commentary column without affecting the inner zone. Stop early on a
  // perfect hit, same as the basic ladder.
  if (!chosen && tries.some(t => t.sideOver)) {
    const baseIdx = tries.length;
    for (let i = 0; i < SIDE_ESCALATION_ATTEMPTS.length; i++) {
      const t = runAttempt(SIDE_ESCALATION_ATTEMPTS[i], baseIdx + i);
      if (t.sig === target && !t.overmerged && !t.sideOver) {
        chosen = { ...t, status: 'matched-target', attempts: baseIdx + i + 1 };
        break;
      }
    }
  }

  if (!chosen) {
    // Tiered preference, all over the same set of attempts. We never fall
    // back to a synthetic single region — the natural detection result is
    // always more useful than collapsing the page into one region, even
    // when nothing fits the expected count cleanly. Within a tier, prefer
    // attempts without side-over-segmentation, then closer-to-target.
    const sortByCloseness = (a, b) => {
      if (a.sideOver !== b.sideOver) return (a.sideOver ? 1 : 0) - (b.sideOver ? 1 : 0);
      const da = Math.abs(a.sig - target);
      const db = Math.abs(b.sig - target);
      return da - db || a.idx - b.idx;
    };
    const pickBest = (filter, status) => {
      const pool = tries.filter(filter);
      if (!pool.length) return null;
      pool.sort(sortByCloseness);
      return { ...pool[0], status, attempts: tries.length };
    };
    chosen =
      pickBest(t => t.sig >= minOk && t.sig <= maxOk && !t.overmerged, 'matched-range') ||
      pickBest(t => t.sig >= minOk && t.sig <= maxOk,                  'matched-range-overmerged') ||
      pickBest(t => !t.overmerged,                                      'out-of-range') ||
      pickBest(() => true,                                              'out-of-range-overmerged');
  }

  regionOpts = { ...regionOpts, ...chosen.opts };
  regionsData = chosen.data;
  regions = chosen.data.regions;
  lastTuneInfo = {
    status: chosen.status,
    attempts: chosen.attempts,
    sigCount: chosen.sig,
    perekEnd: pageIsPerekEnd,
  };

  if (DEBUG_REGIONS) {
    // eslint-disable-next-line no-console
    console.log(
      `[regions] auto-tune: ${chosen.status} · ${chosen.attempts} tries · sig=${chosen.sig}`,
      pageIsPerekEnd ? '(perek-end)' : '',
      `→ ${regions.length} raw regions`,
      regions.map(r => `#${r.id} fs=${r.fontSize.toFixed(1)} cells=${r.pixelCount} items=${r.itemCount}${isStrayRegion(r) ? ' [stray]' : ''}`),
    );
    syncDebugPanelSliders();
    updateDebugPanelStatus();
  }
  drawRegionOverlay();
}

// ── Debug controls (?debug=1) ───────────────────────────────────────────

const PANEL_CONTROLS = [
  { key: 'minShort',      label: 'minShort (px)',  min: 0,    max: 50,   step: 1, def: 9 },
  { key: 'minLong',       label: 'minLong (px)',   min: 0,    max: 1000, step: 1, def: 50 },
  { key: 'darkThreshold', label: 'darkThreshold',  min: 0,    max: 255,  step: 1, def: 150 },
];

let panelStatusEl = null;
let mouseCoordEl = null;
// Last computed grid geometry, updated by drawRegionOverlay so the mouse
// position can be reported in pixel coordinates.
let currentGrid = { gridW: 1, gridH: 1 };
const sliderRefs = new Map(); // key → { input, val, step }
const overlayDisplay = { boxes: true, colors: true };
const PANEL_POS_KEY = 'regionDebugPanelPos';

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
  title.textContent = '⠿ region tuning';
  title.style.cssText = 'font-weight:600;margin-bottom:6px;opacity:0.7;cursor:move;';
  panel.appendChild(title);
  enablePanelDrag(panel, title);

  // Overlay visibility toggles. Grouped on one row to keep the panel compact.
  const toggleRow = document.createElement('div');
  toggleRow.style.cssText = 'display:flex;gap:12px;margin:2px 0 8px;';
  toggleRow.appendChild(makeToggle('boxes',  overlayDisplay.boxes,  v => { overlayDisplay.boxes  = v; drawRegionOverlay(); }));
  toggleRow.appendChild(makeToggle('colors', overlayDisplay.colors, v => { overlayDisplay.colors = v; drawRegionOverlay(); }));
  panel.appendChild(toggleRow);

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

    sliderRefs.set(c.key, { input, val, step: c.step });
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
  updateDebugPanelStatus();

  // Track mouse position and report it as pixel (x, y) coordinates in
  // the rendered image. Out-of-grid positions show as -.
  window.addEventListener('mousemove', (e) => {
    if (!mouseCoordEl) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const relX = e.clientX - rect.left;
    const relY = e.clientY - rect.top;
    const { gridW, gridH } = currentGrid;
    if (relX < 0 || relY < 0 || relX > rect.width || relY > rect.height) {
      mouseCoordEl.textContent = `px: - / ${gridW}×${gridH}`;
      return;
    }
    const px = Math.floor((relX / rect.width)  * pageW);
    const py = Math.floor((relY / rect.height) * pageH);
    mouseCoordEl.textContent = `px: (${px}, ${py}) / ${gridW}×${gridH}`;
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

function enablePanelDrag(panel, handle) {
  // Restore last saved position so the panel stays where the user put it.
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
    // Pin via top/left so the drag math is symmetric regardless of initial anchoring.
    panel.style.left  = rect.left + 'px';
    panel.style.top   = rect.top  + 'px';
    panel.style.right = 'auto';
    startX = point.clientX;
    startY = point.clientY;
    startLeft = rect.left;
    startTop  = rect.top;
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
        left: parseFloat(panel.style.left),
        top:  parseFloat(panel.style.top),
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

function formatVal(v, step) {
  // Show appropriate decimal places based on the step size.
  if (step >= 1)    return String(v);
  if (step >= 0.1)  return v.toFixed(1);
  if (step >= 0.01) return v.toFixed(2);
  return v.toFixed(4);
}

function updateDebugPanelStatus() {
  if (!panelStatusEl) return;
  const lines = [];
  if (regionsData) {
    const { gridW, gridH, regions: regs } = regionsData;
    lines.push(`${gridW}×${gridH} grid · ${regs.length} regions`);
  }
  if (lastTuneInfo) {
    const t = lastTuneInfo;
    const tag = t.perekEnd ? ' [perek-end]' : '';
    lines.push(`tune: ${t.status} · ${t.attempts} ${t.attempts === 1 ? 'try' : 'tries'} · sig=${t.sigCount}${tag}`);
  }
  panelStatusEl.style.whiteSpace = 'pre-line';
  panelStatusEl.textContent = lines.join('\n');
}

// Push current regionOpts values into the slider DOM so the panel reflects
// the auto-tuner's chosen settings after each page load.
function syncDebugPanelSliders() {
  for (const [key, ref] of sliderRefs) {
    const v = regionOpts[key];
    if (v === undefined || !Number.isFinite(v)) continue;
    ref.input.value = String(v);
    ref.val.textContent = formatVal(v, ref.step);
  }
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
  if (!pixelImageData) return;

  // The grid is 1:1 with the rendered image — one cell per pixel. The
  // darkThreshold slider controls which pixels count as "ink."
  const darkThreshold = regionOpts.darkThreshold ?? 150;
  const { grid, gridW, gridH } = buildGridFromImageData(pixelImageData, darkThreshold);
  currentGrid = { gridW, gridH };

  const minShort = regionOpts.minShort ?? 9;
  const minLong  = regionOpts.minLong  ?? 50;
  const gutterMask = detectGutters(grid, gridW, gridH, { minShort, minLong });

  // Paint gutter pixels onto an offscreen canvas at image resolution, then
  // scale up via CSS to cover the page.
  const mask = document.createElement('canvas');
  mask.width = gridW;
  mask.height = gridH;
  mask.style.cssText =
    'position:absolute;top:0;left:0;width:100%;height:100%;' +
    'image-rendering:pixelated;image-rendering:crisp-edges;' +
    'pointer-events:none;';
  const mctx = mask.getContext('2d');
  const img = mctx.createImageData(gridW, gridH);
  for (let i = 0; i < gridW * gridH; i++) {
    if (!gutterMask[i]) continue;
    const o = i * 4;
    img.data[o + 0] = 255;
    img.data[o + 1] = 80;
    img.data[o + 2] = 80;
    img.data[o + 3] = 100;
  }
  mctx.putImageData(img, 0, 0);
  overlay.appendChild(mask);

  // Region bboxes: 4-connected components of non-gutter pixels. The
  // gutter mask already includes the page margins, so the surviving
  // components are the demarcated content areas (gemara, Rashi, Tosafos,
  // …). Draw each as a green outline; sized in % so the overlay scales
  // with the page.
  if (overlayDisplay.boxes) {
    const boxes = detectRegionBoxes(gutterMask, gridW, gridH);
    for (const b of boxes) {
      const box = document.createElement('div');
      box.style.cssText =
        'position:absolute;box-sizing:border-box;pointer-events:none;' +
        'border:2px solid rgba(80,255,130,0.85);' +
        `left:${(b.x / gridW) * 100}%;top:${(b.y / gridH) * 100}%;` +
        `width:${(b.w / gridW) * 100}%;height:${(b.h / gridH) * 100}%;`;
      overlay.appendChild(box);
    }
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

// Compute a target view transform that:
//   • places the tap's y at the viewport centre (the user picks which
//     slice of a tall column they want to read),
//   • horizontally brings that section of the column into the centre of
//     the viewport — uses the region's labelled-cell extent in the row at
//     the tap's y, so an L-shaped region centres on whichever segment the
//     tap actually sits in (main column vs wrap-around line),
//   • scales so a glyph of the region's fontSize displays at `targetFontPx`
//     CSS pixels.
// animateTo() runs the result through constrainView() afterwards, so the
// page-edge constraint pulls things back if column-centring would push
// the visible bbox edge past the screen edge.
export function transformForRegion(region, clientX, clientY, targetFontPx) {
  if (!region || !(region.fontSize > 0) || !(targetFontPx > 0)) return null;
  const desiredEff = targetFontPx / region.fontSize;     // PDF → screen
  const visualScale = desiredEff / renderScale;
  const r = canvas.getBoundingClientRect();
  const tapPdfY = (clientY - r.top) / view.scale / renderScale;
  const colX = regionRowCenterX(region, tapPdfY);
  return {
    x: window.innerWidth  / 2 - colX    * desiredEff,
    y: window.innerHeight / 2 - tapPdfY * desiredEff,
    scale: visualScale,
  };
}

// Horizontal centre of the region's labelled cells in the grid row that
// contains `pdfY`. Returns a per-row centre, so a region whose shape
// differs at different y's (like an L-shape) gets centred on the bit
// near the tap, not on its overall centroid. Falls back to centroid →
// bbox centre when the tap row has no labelled cells of this region.
function regionRowCenterX(region, pdfY) {
  const fallback = region.centroid?.x ?? (region.bbox.x + region.bbox.w / 2);
  if (!regionsData) return fallback;
  const { labels, gridW, gridH, cellSize } = regionsData;
  const ty = Math.floor(pdfY / cellSize);
  if (ty < 0 || ty >= gridH) return fallback;
  let xMin = Infinity, xMax = -Infinity;
  const rowBase = ty * gridW;
  for (let x = 0; x < gridW; x++) {
    if (labels[rowBase + x] === region.id) {
      const px = x * cellSize;
      if (px < xMin) xMin = px;
      if (px + cellSize > xMax) xMax = px + cellSize;
    }
  }
  return xMin === Infinity ? fallback : (xMin + xMax) / 2;
}

// Whether the focused region extends past the viewport in `direction`
// ('up' | 'down' | 'left' | 'right'). Used by the directional double-tap:
// scroll if there's content to reveal, else fall through to home.
export function regionExtendsBeyondViewport(region, direction) {
  if (!region?.bbox) return false;
  const eff = effectiveScale();
  const left   = view.x + region.bbox.x * eff;
  const right  = view.x + (region.bbox.x + region.bbox.w) * eff;
  const top    = view.y + region.bbox.y * eff;
  const bottom = view.y + (region.bbox.y + region.bbox.h) * eff;
  const margin = 20; // px — anything tighter is effectively "at the edge"
  switch (direction) {
    case 'up':    return top    < -margin;
    case 'down':  return bottom > window.innerHeight + margin;
    case 'left':  return left   < -margin;
    case 'right': return right  > window.innerWidth  + margin;
    default:      return false;
  }
}

// Pan by (dx, dy) screen pixels, keep current scale. Used by double-tap
// scroll within the focused region.
export function transformForScroll(dx, dy) {
  return { x: view.x + dx, y: view.y + dy, scale: view.scale };
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

// Look up the region under a screen point via the labeled grid. If the
// tap lands directly on a labelled cell, return that region. Otherwise
// expand outward and snap to the nearest labelled cell within
// HIT_LEEWAY_CELLS — covers inter-line whitespace inside a column so a
// tap between two glyphs of Gemara still counts as a Gemara tap. Cells
// beyond that radius keep returning null (treated as whitespace).
const HIT_LEEWAY_CELLS = 8;
export function findRegionAtPoint(clientX, clientY) {
  if (!regionsData) return null;
  const { x: px, y: py } = screenToPdf(clientX, clientY);
  const { labels, gridW, gridH, cellSize, regions: regs } = regionsData;
  const cx = Math.floor(px / cellSize);
  const cy = Math.floor(py / cellSize);
  if (cx < 0 || cy < 0 || cx >= gridW || cy >= gridH) return null;

  let lbl = labels[cy * gridW + cx];
  if (lbl === 0) {
    let bestD2 = Infinity;
    const r = HIT_LEEWAY_CELLS;
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
  return regs.find(r => r.id === lbl) ?? null;
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
