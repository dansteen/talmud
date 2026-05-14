import * as pdfjsLib from 'pdfjs-dist';
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { detectRegions as detectTextRegions } from './regions.js';
import {
  renderPdfToImageData,
  buildGridFromImageData,
  detectGutters,
  detectRegions as detectPixelRegions,
} from './regionsPixel.js';

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

// Hybrid pipeline config: which methods to apply and in what order. Each
// method either runs on the full page (first pass) or refines the regions
// produced by the previous pass (second pass).
const HYBRID_KEY = 'regionHybridConfig';
const HYBRID_DEFAULTS  = { pixel: true, text: true, order: 'text,pixel', sideMerge: true };
const OVERLAY_DEFAULTS = { mask: false, boxes: true, colors: true, ids: true };
const hybrid = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem(HYBRID_KEY) || 'null');
    if (saved && typeof saved === 'object') {
      return {
        pixel:     saved.pixel !== false,
        text:      !!saved.text,
        order:     saved.order === 'text,pixel' ? 'text,pixel' : 'pixel,text',
        sideMerge: saved.sideMerge !== false,
      };
    }
  } catch {}
  return { ...HYBRID_DEFAULTS };
})();
function persistHybrid() {
  try { localStorage.setItem(HYBRID_KEY, JSON.stringify(hybrid)); } catch {}
}

// Diagnostic counters from the most recent side-column merge attempt.
let lastMergeStats = null;

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

  // Render the PDF off-screen once per page; the binary grid is rebuilt
  // by the hybrid driver each time a slider changes.
  ({ imageData: pixelImageData } = await renderPdfToImageData(currentPdfPage));
  applyHybrid(regionTuneFromUrl());

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
  applyHybrid(opts);
}

// ── Hybrid region detection (pixel + text, sequential refinement) ───────
//
// Each enabled method runs in order. The first method runs on the whole
// page; the second refines each first-pass region by running restricted
// to that region's pixel mask. A refinement that yields fewer than two
// sub-regions leaves the parent unchanged (no narrowing).

function fullPageMask(N) {
  const m = new Uint8Array(N);
  m.fill(1);
  return m;
}

function bboxFromMask(mask, gridW, gridH) {
  let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity, area = 0;
  for (let y = 0; y < gridH; y++) {
    const base = y * gridW;
    for (let x = 0; x < gridW; x++) {
      if (!mask[base + x]) continue;
      area++;
      if (x < xMin) xMin = x;
      if (x > xMax) xMax = x;
      if (y < yMin) yMin = y;
      if (y > yMax) yMax = y;
    }
  }
  if (area === 0) return null;
  return {
    bbox: { x: xMin, y: yMin, w: xMax - xMin + 1, h: yMax - yMin + 1 },
    area,
  };
}

// Merge regions whose centroid falls in the leftmost or rightmost
// `sideFrac` strip of the page. Talmud pages have side meforshim
// (Tosafot, Mesores HaShas) that wrap vertically into multiple
// fragments; this collapses them back into a single column per side.
// Middle-of-page regions are left alone.
//
// After OR'ing fragment masks together, vertical gaps are filled within
// the merged bbox: at each x column, every pixel between the topmost and
// bottommost ink pixel becomes part of the region. Without this fill,
// the merged region is logically one (shared label) but visually still
// shows per-fragment outlines, because gutter pixels (label 0) between
// fragments form a boundary on every fragment edge.
function mergeSideColumns(regions, gridW, gridH, sideFrac) {
  if (sideFrac <= 0 || regions.length < 2) {
    if (DEBUG_REGIONS) {
      // eslint-disable-next-line no-console
      console.log('[merge] skipped', { sideFrac, regions: regions.length });
    }
    return regions;
  }

  // Anchor the side columns to the extreme detected content edges, not
  // the raw page width. Then classify each region by whether its LEFT
  // edge is anchored (left column) or RIGHT edge is anchored (right
  // column). This catches wraparounds where a side column spreads
  // inward — e.g. the leftmost column extending under the main column
  // at the bottom has bbox.x == leftAnchorX but extends well past the
  // narrow side band, so a centroid check would miss it. A region whose
  // bbox spans the full content width (anchored on both sides) is left
  // alone.
  let leftAnchorX = Infinity, rightAnchorX = -Infinity;
  for (const r of regions) {
    if (r.bbox.x < leftAnchorX) leftAnchorX = r.bbox.x;
    if (r.bbox.x + r.bbox.w > rightAnchorX) rightAnchorX = r.bbox.x + r.bbox.w;
  }
  const activeW = rightAnchorX - leftAnchorX;
  const tol = sideFrac * activeW;
  const leftIdx = [], rightIdx = [], otherIdx = [];
  regions.forEach((r, idx) => {
    const startsAtLeft = r.bbox.x                   <= leftAnchorX  + tol;
    const endsAtRight  = (r.bbox.x + r.bbox.w)      >= rightAnchorX - tol;
    if (startsAtLeft && !endsAtRight)      leftIdx.push(idx);
    else if (endsAtRight && !startsAtLeft) rightIdx.push(idx);
    else                                   otherIdx.push(idx);
  });

  // Second pass: for each region that landed in `otherIdx` (anchors to
  // both edges, or to neither), do a top-scan reclassification. Look at
  // the region's topmost row of ink; if any of that row's ink overlaps
  // a side strip (taken from the narrowest already-anchored fragment),
  // move the region to that side bucket. Left first when the topmost
  // row touches both strips. This catches L-shaped regions that start
  // narrow inside a side strip and then widen out lower on the page —
  // e.g. on megillah 18b, region #5 starts as a thin strip on the
  // right edge at y=427 and only broadens to full width below y=691.
  // Safe because Talmud pages don't extend the gemara into the side
  // strips, so only genuinely side-column-derived regions overlap a
  // side strip at their top.
  const narrowRange = (indices) => {
    if (indices.length === 0) return null;
    let narrowest = regions[indices[0]];
    for (const i of indices) {
      if (regions[i].bbox.w < narrowest.bbox.w) narrowest = regions[i];
    }
    return { x0: narrowest.bbox.x, x1: narrowest.bbox.x + narrowest.bbox.w };
  };
  const leftStrip  = narrowRange(leftIdx);
  const rightStrip = narrowRange(rightIdx);

  const trueMiddle = [];
  for (const idx of otherIdx) {
    const r = regions[idx];
    // Topmost ink row in the region's mask.
    let yTop = -1;
    for (let y = r.bbox.y; y < r.bbox.y + r.bbox.h; y++) {
      for (let x = r.bbox.x; x < r.bbox.x + r.bbox.w; x++) {
        if (r.mask[y * gridW + x]) { yTop = y; break; }
      }
      if (yTop >= 0) break;
    }
    if (yTop < 0) { trueMiddle.push(idx); continue; }
    // Does any ink at yTop fall inside a side strip?
    let overlapsLeft = false, overlapsRight = false;
    for (let x = r.bbox.x; x < r.bbox.x + r.bbox.w; x++) {
      if (!r.mask[yTop * gridW + x]) continue;
      if (leftStrip  && x >= leftStrip.x0  && x < leftStrip.x1)  overlapsLeft  = true;
      if (rightStrip && x >= rightStrip.x0 && x < rightStrip.x1) overlapsRight = true;
      if (overlapsLeft && overlapsRight) break;
    }
    if (overlapsLeft)       leftIdx.push(idx);
    else if (overlapsRight) rightIdx.push(idx);
    else                    trueMiddle.push(idx);
  }

  if (DEBUG_REGIONS) {
    // eslint-disable-next-line no-console
    console.log('[merge]', {
      leftAnchorX,
      rightAnchorX,
      sideFrac,
      tol,
      leftStrip,
      rightStrip,
      regions: regions.map((r, i) => ({
        idx: i,
        bbox: r.bbox,
        bucket: leftIdx.includes(i) ? 'left' : rightIdx.includes(i) ? 'right' : 'middle',
      })),
      groups: { left: leftIdx.length, right: rightIdx.length, middle: trueMiddle.length },
    });
  }
  lastMergeStats = { pre: regions.length, left: leftIdx.length, right: rightIdx.length, middle: trueMiddle.length };

  const N = gridW * gridH;
  const mergeGroup = (indices) => {
    if (indices.length === 0) return [];
    if (indices.length === 1) return [regions[indices[0]]];
    const mask = new Uint8Array(N);
    for (const i of indices) {
      const src = regions[i].mask;
      for (let p = 0; p < N; p++) if (src[p]) mask[p] = 1;
    }
    const info = bboxFromMask(mask, gridW, gridH);
    // Vertical-gap fill within the bbox.
    const x0 = info.bbox.x, x1 = info.bbox.x + info.bbox.w;
    const y0 = info.bbox.y, y1 = info.bbox.y + info.bbox.h;
    for (let x = x0; x < x1; x++) {
      let topY = -1, bottomY = -1;
      for (let y = y0; y < y1; y++) {
        if (mask[y * gridW + x]) {
          if (topY < 0) topY = y;
          bottomY = y;
        }
      }
      if (topY >= 0) {
        for (let y = topY; y <= bottomY; y++) mask[y * gridW + x] = 1;
      }
    }
    const filled = bboxFromMask(mask, gridW, gridH);
    return [{ mask, bbox: filled.bbox, area: filled.area }];
  };

  return [
    ...mergeGroup(rightIdx),                  // rightmost (highest x) first
    ...trueMiddle.map(i => regions[i]),       // middle regions, original order
    ...mergeGroup(leftIdx),                   // leftmost last
  ];
}

// Drop regions that look like the masechta-title text at the top of
// the page. A title region is at the very top AND has a fontSize
// notably larger than the median — both signals together are reliable
// (position alone catches the first line of any region; large font
// alone catches headers that aren't at the top). If the title is
// already filtered out by minArea (its per-word fragments are usually
// too small to survive), this is a no-op.
function filterTitleRegions(regions, gridH) {
  if (regions.length < 2) return regions;
  const sizes = regions.map(r => r.fontSize).filter(s => s > 0).sort((a, b) => a - b);
  if (sizes.length < 2) return regions;
  const medianFs = sizes[sizes.length >> 1];
  return regions.filter(r => {
    const atTop   = r.bbox.y     < 0.05 * gridH;
    const bigFont = r.fontSize   > 1.5  * medianFs;
    return !(atTop && bigFont);
  });
}

function medianFontSizeInside(mask, gridW, gridH, items) {
  const sizes = [];
  for (const it of items) {
    const cx = Math.floor(it.x + it.w / 2);
    const cy = Math.floor(it.y + it.h / 2);
    if (cx < 0 || cx >= gridW || cy < 0 || cy >= gridH) continue;
    if (mask[cy * gridW + cx] && it.fontSize > 0) sizes.push(it.fontSize);
  }
  if (!sizes.length) return 0;
  sizes.sort((a, b) => a - b);
  return sizes[sizes.length >> 1];
}

// Pixel detection restricted to `parentMask`: pre-mask the grid so cells
// outside the parent are treated as ink (gutters can't extend out), then
// run gutter detection and CC. The CC pass also treats outside-parent as
// gutter so components don't leak outward.
function detectPixelWithin(parentMask, grid, gridW, gridH, opts) {
  const N = gridW * gridH;
  const restrictedGrid = new Uint8Array(N);
  for (let i = 0; i < N; i++) restrictedGrid[i] = parentMask[i] ? grid[i] : 1;
  const gutterMask = detectGutters(restrictedGrid, gridW, gridH, opts);
  const ccBlock = new Uint8Array(N);
  for (let i = 0; i < N; i++) ccBlock[i] = (gutterMask[i] || !parentMask[i]) ? 1 : 0;
  const { labels, regions: regs } = detectPixelRegions(ccBlock, gridW, gridH);
  const out = [];
  for (const r of regs) {
    const mask = new Uint8Array(N);
    for (let i = 0; i < N; i++) if (labels[i] === r.id) mask[i] = 1;
    out.push({ mask });
  }
  return out;
}

// Text-bbox detection restricted to `parentMask`: filter text items to
// those whose centroid sits inside the parent, run regions.js on that
// subset, then rasterize each text region into a pixel mask AND'd with
// the parent.
function detectTextWithin(parentMask, items, gridW, gridH, opts) {
  const inside = [];
  for (const it of items) {
    const cx = Math.floor(it.x + it.w / 2);
    const cy = Math.floor(it.y + it.h / 2);
    if (cx < 0 || cx >= gridW || cy < 0 || cy >= gridH) continue;
    if (parentMask[cy * gridW + cx]) inside.push(it);
  }
  if (inside.length === 0) return [];

  const result = detectTextRegions(inside, pageW, pageH, opts);
  if (!result.regions.length) return [];

  const { labels: tLabels, gridW: tW, gridH: tH, cellSize: cs } = result;
  const out = [];
  for (const r of result.regions) {
    const mask = new Uint8Array(gridW * gridH);
    let hits = 0;
    for (let y = 0; y < gridH; y++) {
      const base = y * gridW;
      const ty = Math.min(tH - 1, Math.floor(y / cs));
      const tBase = ty * tW;
      for (let x = 0; x < gridW; x++) {
        if (!parentMask[base + x]) continue;
        const tx = Math.min(tW - 1, Math.floor(x / cs));
        if (tLabels[tBase + tx] === r.id) { mask[base + x] = 1; hits++; }
      }
    }
    if (hits > 0) out.push({ mask });
  }
  return out;
}

function detectHybrid() {
  if (!pixelImageData) {
    return { regions: [], labels: null, gridW: 0, gridH: 0, cellSize: 1, grid: null, gutterMask: null };
  }
  const darkThreshold = regionOpts.darkThreshold ?? 150;
  const minShort      = regionOpts.minShort      ?? 7;
  const minLong       = regionOpts.minLong       ?? 50;

  const { grid, gridW, gridH } = buildGridFromImageData(pixelImageData, darkThreshold);
  const N = gridW * gridH;

  // Gutter mask of the whole page, kept for the 'mask' visualization
  // layer. Independent of which methods are enabled.
  const gutterMask = detectGutters(grid, gridW, gridH, { minShort, minLong });

  const order = hybrid.order === 'text,pixel' ? ['text', 'pixel'] : ['pixel', 'text'];
  const enabled = order.filter(m => hybrid[m]);

  if (enabled.length === 0) {
    return { regions: [], labels: new Int32Array(N), gridW, gridH, cellSize: 1, grid, gutterMask };
  }

  let regionList = [{ mask: fullPageMask(N) }];
  let firstPass = true;
  for (const method of enabled) {
    const next = [];
    for (const parent of regionList) {
      const sub = method === 'pixel'
        ? detectPixelWithin(parent.mask, grid, gridW, gridH, { minShort, minLong })
        : detectTextWithin (parent.mask, textItems, gridW, gridH, regionOpts);
      const minToSplit = firstPass ? 1 : 2;
      if (sub.length >= minToSplit) next.push(...sub);
      else next.push(parent);
    }
    regionList = next;
    firstPass = false;
  }

  // Compute bbox/area for each region so the side-column merge can use
  // centroid positions.
  const withBbox = [];
  for (const r of regionList) {
    const info = bboxFromMask(r.mask, gridW, gridH);
    if (info) withBbox.push({ mask: r.mask, bbox: info.bbox, area: info.area });
  }

  // Post-process: collapse fragmented side-column pieces into one region
  // per side. Gated by the `merge sides` checkbox; `sideFrac` is the
  // centroid threshold (slider).
  lastMergeStats = null;
  const sideFrac = hybrid.sideMerge ? (regionOpts.sideFrac ?? 0.05) : 0;
  const merged = mergeSideColumns(withBbox, gridW, gridH, sideFrac);

  // Attach fontSize to each merged region — needed for the title filter
  // (which compares each region's fontSize to the page median).
  for (const r of merged) {
    r.fontSize = medianFontSizeInside(r.mask, gridW, gridH, textItems);
  }
  const filtered = filterTitleRegions(merged, gridH);

  // Assign sequential ids; build the unified labels grid.
  const labels = new Int32Array(N);
  const finalRegions = filtered.map((r, i) => {
    const id = i + 1;
    for (let p = 0; p < N; p++) if (r.mask[p]) labels[p] = id;
    return {
      id,
      mask: r.mask,
      bbox: r.bbox,
      area: r.area,
      fontSize: r.fontSize,
    };
  });

  return { regions: finalRegions, labels, gridW, gridH, cellSize: 1, grid, gutterMask };
}

function applyHybrid(opts) {
  if (opts) regionOpts = { ...regionOpts, ...opts };
  regionsData = detectHybrid();
  regions = regionsData.regions;
  currentGrid = { gridW: regionsData.gridW, gridH: regionsData.gridH };
  if (DEBUG_REGIONS) {
    syncDebugPanelSliders();
    updateDebugPanelStatus();
  }
  drawRegionOverlay();
}


// ── Debug controls (?debug=1) ───────────────────────────────────────────

const PANEL_CONTROLS = [
  // Pixel method
  { key: 'minShort',         label: 'minShort (px)',   min: 0,    max: 50,   step: 1,    def: 7 },
  { key: 'minLong',          label: 'minLong (px)',    min: 0,    max: 1000, step: 1,    def: 50 },
  { key: 'darkThreshold',    label: 'darkThreshold',   min: 0,    max: 255,  step: 1,    def: 150 },
  // Text method
  { key: 'cellSize',         label: 'text cellSize',   min: 0.5,  max: 6,    step: 0.5,  def: 1.5 },
  { key: 'closeRadiusX',     label: 'closeRadiusX',    min: 0,    max: 20,   step: 1,    def: 0 },
  { key: 'closeRadiusY',     label: 'closeRadiusY',    min: 0,    max: 20,   step: 1,    def: 0 },
  { key: 'closeRadiusYSide', label: 'closeRadiusYSide',min: 0,    max: 20,   step: 1,    def: 5 },
  // Side-column merge
  { key: 'sideFrac',         label: 'sideFrac',        min: 0,    max: 0.3,  step: 0.01, def: 0.05 },
];

let panelStatusEl = null;
let mouseCoordEl = null;
// Last computed grid geometry, updated by drawRegionOverlay so the mouse
// position can be reported in pixel coordinates.
let currentGrid = { gridW: 1, gridH: 1 };
const sliderRefs = new Map(); // key → { input, val, step }
const toggleRefs = new Map(); // key → checkbox input element
let orderSelRef = null;       // the order <select> element
const overlayDisplay = { ...OVERLAY_DEFAULTS };
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

  const titleRow = document.createElement('div');
  titleRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;';
  const title = document.createElement('div');
  title.textContent = '⠿ region tuning';
  title.style.cssText = 'font-weight:600;opacity:0.7;cursor:move;flex:1;';
  titleRow.appendChild(title);

  const resetBtn = document.createElement('button');
  resetBtn.textContent = 'reset';
  resetBtn.style.cssText =
    'background:rgba(40,30,20,0.9);color:inherit;' +
    'border:1px solid rgba(255,230,170,0.3);border-radius:3px;' +
    'padding:1px 6px;font:inherit;cursor:pointer;';
  resetBtn.addEventListener('click', resetPanelToDefaults);
  titleRow.appendChild(resetBtn);

  panel.appendChild(titleRow);
  enablePanelDrag(panel, title);

  // Method selection: which detectors to apply and in what order.
  const methodRow = document.createElement('div');
  methodRow.style.cssText = 'display:flex;gap:10px;align-items:center;margin:2px 0 6px;';
  methodRow.appendChild(makeToggle('pixel',       hybrid.pixel,     v => { hybrid.pixel     = v; persistHybrid(); applyHybrid(); }, 'pixel'));
  methodRow.appendChild(makeToggle('text',        hybrid.text,      v => { hybrid.text      = v; persistHybrid(); applyHybrid(); }, 'text'));
  methodRow.appendChild(makeToggle('merge sides', hybrid.sideMerge, v => { hybrid.sideMerge = v; persistHybrid(); applyHybrid(); }, 'sideMerge'));
  const orderSel = document.createElement('select');
  orderSel.style.cssText = 'margin-left:auto;background:rgba(40,30,20,0.9);color:inherit;border:1px solid rgba(255,230,170,0.3);border-radius:3px;padding:1px 4px;font:inherit;';
  for (const [val, lbl] of [['pixel,text', 'pixel → text'], ['text,pixel', 'text → pixel']]) {
    const o = document.createElement('option');
    o.value = val; o.textContent = lbl;
    if (hybrid.order === val) o.selected = true;
    orderSel.appendChild(o);
  }
  orderSel.addEventListener('change', () => {
    hybrid.order = orderSel.value === 'text,pixel' ? 'text,pixel' : 'pixel,text';
    persistHybrid();
    applyHybrid();
  });
  methodRow.appendChild(orderSel);
  orderSelRef = orderSel;
  panel.appendChild(methodRow);

  // Overlay visibility toggles. Grouped on one row to keep the panel compact.
  const toggleRow = document.createElement('div');
  toggleRow.style.cssText = 'display:flex;gap:12px;margin:2px 0 8px;';
  toggleRow.appendChild(makeToggle('mask',   overlayDisplay.mask,   v => { overlayDisplay.mask   = v; drawRegionOverlay(); }, 'mask'));
  toggleRow.appendChild(makeToggle('boxes',  overlayDisplay.boxes,  v => { overlayDisplay.boxes  = v; drawRegionOverlay(); }, 'boxes'));
  toggleRow.appendChild(makeToggle('colors', overlayDisplay.colors, v => { overlayDisplay.colors = v; drawRegionOverlay(); }, 'colors'));
  toggleRow.appendChild(makeToggle('ids',    overlayDisplay.ids,    v => { overlayDisplay.ids    = v; drawRegionOverlay(); }, 'ids'));
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

function makeToggle(label, initial, onChange, refKey) {
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
  if (refKey) toggleRefs.set(refKey, cb);
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

// Reset the entire debug panel to the defaults declared at the top of
// the module: hybrid config (pixel/text/order/sideMerge), overlay
// display toggles (mask/boxes/colors/ids), and every numeric slider.
// Updates both the in-memory state objects and the corresponding DOM
// controls, persists the hybrid config, then re-runs the pipeline.
function resetPanelToDefaults() {
  Object.assign(hybrid, HYBRID_DEFAULTS);
  persistHybrid();
  Object.assign(overlayDisplay, OVERLAY_DEFAULTS);
  for (const c of PANEL_CONTROLS) regionOpts[c.key] = c.def;

  for (const [key, cb] of toggleRefs) {
    if (key in hybrid)              cb.checked = hybrid[key];
    else if (key in overlayDisplay) cb.checked = overlayDisplay[key];
  }
  if (orderSelRef) orderSelRef.value = hybrid.order;
  syncDebugPanelSliders();

  applyHybrid();
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
    const order = hybrid.order === 'text,pixel' ? ['text', 'pixel'] : ['pixel', 'text'];
    const enabled = order.filter(m => hybrid[m]).join(' → ') || '(none)';
    lines.push(`${gridW}×${gridH} grid · ${regs.length} regions`);
    lines.push(`pipeline: ${enabled}`);
    if (lastMergeStats) {
      const s = lastMergeStats;
      lines.push(`merge: pre=${s.pre} L=${s.left} M=${s.middle} R=${s.right} → post=${regs.length}`);
    }
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

// Render the hybrid detection result. Three independent layers:
//   - mask:   translucent red on every gutter pixel (the raw output of
//             the pixel gutter detector; survives method toggles so it
//             always reflects what the pixel pass would see)
//   - boxes:  per-region outline (any pixel whose 4-neighbor has a
//             different label, including grid edges) at high alpha
//   - colors: per-region translucent fill at low alpha
// Each region cycles through REGION_COLORS by its id.
function drawRegionOverlay() {
  if (!overlay) return;
  overlay.innerHTML = '';
  if (!regionsData || !regionsData.labels) return;

  const { labels, gridW, gridH, gutterMask } = regionsData;
  const N = gridW * gridH;
  const overlayStyle =
    'position:absolute;top:0;left:0;width:100%;height:100%;' +
    'image-rendering:pixelated;image-rendering:crisp-edges;' +
    'pointer-events:none;';

  // Mask layer.
  if (overlayDisplay.mask && gutterMask) {
    const cvs = document.createElement('canvas');
    cvs.width = gridW;
    cvs.height = gridH;
    cvs.style.cssText = overlayStyle;
    const cctx = cvs.getContext('2d');
    const img = cctx.createImageData(gridW, gridH);
    for (let i = 0; i < N; i++) {
      if (!gutterMask[i]) continue;
      const o = i * 4;
      img.data[o + 0] = 255;
      img.data[o + 1] = 80;
      img.data[o + 2] = 80;
      img.data[o + 3] = 100;
    }
    cctx.putImageData(img, 0, 0);
    overlay.appendChild(cvs);
  }

  // Region layer (boxes + colors share one canvas).
  if (overlayDisplay.boxes || overlayDisplay.colors) {
    const cvs = document.createElement('canvas');
    cvs.width = gridW;
    cvs.height = gridH;
    cvs.style.cssText = overlayStyle;
    const cctx = cvs.getContext('2d');
    const img = cctx.createImageData(gridW, gridH);

    for (let y = 0; y < gridH; y++) {
      for (let x = 0; x < gridW; x++) {
        const idx = y * gridW + x;
        const lbl = labels[idx];
        if (!lbl) continue;
        const color = REGION_COLORS[(lbl - 1) % REGION_COLORS.length];

        const isBoundary =
          (x === 0)         || labels[idx - 1]     !== lbl ||
          (x === gridW - 1) || labels[idx + 1]     !== lbl ||
          (y === 0)         || labels[idx - gridW] !== lbl ||
          (y === gridH - 1) || labels[idx + gridW] !== lbl;

        let alpha = 0;
        if (isBoundary && overlayDisplay.boxes) alpha = 220;
        else if (!isBoundary && overlayDisplay.colors) alpha = 60;
        if (!alpha) continue;

        const o = idx * 4;
        img.data[o + 0] = color[0];
        img.data[o + 1] = color[1];
        img.data[o + 2] = color[2];
        img.data[o + 3] = alpha;
      }
    }

    cctx.putImageData(img, 0, 0);
    overlay.appendChild(cvs);
  }

  // Region ID labels — small colored badges centered on each region's
  // bbox. Lets us refer to regions by number when discussing detection.
  if (overlayDisplay.ids && regionsData.regions?.length) {
    for (const r of regionsData.regions) {
      const cx = (r.bbox.x + r.bbox.w / 2) / gridW * 100;
      const cy = (r.bbox.y + r.bbox.h / 2) / gridH * 100;
      const color = REGION_COLORS[(r.id - 1) % REGION_COLORS.length];
      const tag = document.createElement('div');
      tag.textContent = String(r.id);
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
//   • places (pdfX, pdfY) at the viewport centre vertically — the tap's
//     y becomes the viewport's vertical centre,
//   • horizontally anchors so that:
//      a) if the region's pixel-row width at pdfY fits within the
//         viewport at the new scale, the row is centred,
//      b) otherwise, if the row's right edge AND the tap point both
//         fit within the viewport at the new scale, the row's right
//         edge is pinned to the viewport's right edge (so RTL line
//         starts are visible),
//      c) otherwise, the tap point itself is centred,
//   • scales so a glyph of `fontSize` displays at `targetFontPx`
//     screen pixels.
// animateTo() runs the result through constrainView() afterwards.
export function transformForRegion(region, pdfX, pdfY, fontSize, targetFontPx) {
  if (!region || !(fontSize > 0) || !(targetFontPx > 0)) return null;
  const desiredEff = targetFontPx / fontSize;       // PDF → screen
  const visualScale = desiredEff / renderScale;
  const W = window.innerWidth;
  const row = regionRowRange(region, pdfY);

  let xView;
  if (row && row.w * desiredEff <= W) {
    // Full row fits — centre it.
    xView = W / 2 - row.center * desiredEff;
  } else if (row && (row.max - pdfX) * desiredEff <= W) {
    // Row doesn't fit, but tap → right edge fits. Pin the row's right
    // edge to the viewport's right edge.
    xView = W - row.max * desiredEff;
  } else {
    // Even tap + right edge can't fit. Centre on the tap.
    xView = W / 2 - pdfX * desiredEff;
  }
  return {
    x: xView,
    y: window.innerHeight / 2 - pdfY * desiredEff,
    scale: visualScale,
  };
}

// The x-range of the region's labelled cells in the grid row that
// contains `pdfY`. Used by transformForRegion's horizontal anchoring.
// Returns { min, max, w, center } in PDF coords; null when the tap row
// has no cells of this region (fall back to the bbox).
function regionRowRange(region, pdfY) {
  const fallback = region?.bbox && {
    min: region.bbox.x,
    max: region.bbox.x + region.bbox.w,
    w: region.bbox.w,
    center: region.bbox.x + region.bbox.w / 2,
  };
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
  if (xMin === Infinity) return fallback;
  return { min: xMin, max: xMax, w: xMax - xMin, center: (xMin + xMax) / 2 };
}

// True when the view is at (or very close to) the fit-the-page home
// scale — used by the pinch-save logic to avoid persisting a "zoomed
// all the way out" preference for the active fontSize.
export function isFullyZoomedOut() {
  if (!textBbox) return true;
  const minViewScale = fitScale() / renderScale;
  return view.scale <= minViewScale + 0.001;
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

// Mode of text-item heights within `radius` PDF px of (pdfX, pdfY),
// restricted to items whose centroid lies inside `region`'s pixel
// mask. Bucketed to 1pt. Returns 0 if no items qualify.
function localFontSize(region, pdfX, pdfY, radius) {
  if (!regionsData) return 0;
  const { labels, gridW, gridH, cellSize } = regionsData;
  const r2 = radius * radius;
  const buckets = new Map();
  for (const it of textItems) {
    if (!(it.fontSize > 0)) continue;
    const cx = it.x + it.w / 2;
    const cy = it.y + it.h / 2;
    const dx = cx - pdfX, dy = cy - pdfY;
    if (dx * dx + dy * dy > r2) continue;
    const ix = Math.floor(cx / cellSize), iy = Math.floor(cy / cellSize);
    if (ix < 0 || ix >= gridW || iy < 0 || iy >= gridH) continue;
    if (labels[iy * gridW + ix] !== region.id) continue;
    const b = Math.round(it.fontSize);
    buckets.set(b, (buckets.get(b) || 0) + 1);
  }
  let best = 0, bestCount = 0;
  for (const [size, count] of buckets) {
    if (count > bestCount) { best = size; bestCount = count; }
  }
  return best;
}

// Given tap coordinates, resolve to:
//   • `region`   — the region the tap is in (or the region containing
//                   the nearest text item if the tap is on a gutter),
//   • `fontSize` — the dominant text height in a small neighbourhood
//                   around the effective tap point, never crossing a
//                   region boundary (mask-gated),
//   • `pdfX/pdfY` — the effective tap point: the tap itself when it
//                   lands on text, or the nearest text item's centre
//                   when it lands on a gutter.
const LOCAL_FONT_RADII = [30, 60, 120]; // PDF px, tried in order
export function findRegionAtTap(clientX, clientY) {
  if (!regionsData) return null;
  const { labels, gridW, gridH, cellSize, regions: regs } = regionsData;
  const { x: px, y: py } = screenToPdf(clientX, clientY);
  let pdfX = px, pdfY = py;

  // Direct hit?
  let region = null;
  if (px >= 0 && py >= 0 && px < gridW * cellSize && py < gridH * cellSize) {
    const lbl = labels[Math.floor(py / cellSize) * gridW + Math.floor(px / cellSize)];
    if (lbl !== 0) region = regs.find(r => r.id === lbl) ?? null;
  }

  // Tap on a gutter (or off-page) — snap to the nearest text item.
  if (!region) {
    let nearest = null, bestD2 = Infinity;
    for (const it of textItems) {
      const icx = it.x + it.w / 2;
      const icy = it.y + it.h / 2;
      const dx = icx - px, dy = icy - py;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) { bestD2 = d2; nearest = it; }
    }
    if (!nearest) return null;
    pdfX = nearest.x + nearest.w / 2;
    pdfY = nearest.y + nearest.h / 2;
    const ix = Math.floor(pdfX / cellSize), iy = Math.floor(pdfY / cellSize);
    if (ix < 0 || ix >= gridW || iy < 0 || iy >= gridH) return null;
    const lbl = labels[iy * gridW + ix];
    if (lbl === 0) return null;
    region = regs.find(r => r.id === lbl) ?? null;
    if (!region) return null;
  }

  // Local fontSize — expanding radius so a tap on a sparse region
  // still resolves to a real font without pulling in items from too
  // far away.
  let fontSize = 0;
  for (const r of LOCAL_FONT_RADII) {
    fontSize = localFontSize(region, pdfX, pdfY, r);
    if (fontSize > 0) break;
  }
  return { region, fontSize, pdfX, pdfY };
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
