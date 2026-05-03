import * as pdfjsLib from 'pdfjs-dist';
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { detectRegions } from './regions.js';
import { getCachedRegions, setCachedRegions } from './storage.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

const canvas = document.getElementById('page-canvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true });

// Current view transform (CSS space)
export const view = {
  scale: 1,
  x: 0,
  y: 0,
  // Dimensions of the canvas in CSS pixels at scale=1
  cssW: 0,
  cssH: 0,
};

// Regions detected for the current page
export let regions = null;

let currentPdfPage = null;
let renderTask = null;
let pendingRenderScale = null;

// How many CSS pixels wide the canvas is at view.scale === 1
function baseCssWidth() {
  return Math.min(window.innerWidth, window.innerHeight * 0.75);
}

function applyTransform(animated = false) {
  if (animated) {
    canvas.classList.add('animating');
  } else {
    canvas.classList.remove('animating');
  }
  canvas.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
}

// Render (or re-render) the current page at renderScale * devicePixelRatio quality
async function renderAtScale(renderScale) {
  if (!currentPdfPage) return;
  if (renderTask) { renderTask.cancel(); renderTask = null; }

  const dpr = window.devicePixelRatio || 1;
  const viewport = currentPdfPage.getViewport({ scale: renderScale * dpr });

  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);

  // CSS dimensions stay at renderScale * natural page size
  const cssW = viewport.width / dpr;
  const cssH = viewport.height / dpr;
  canvas.style.width = cssW + 'px';
  canvas.style.height = cssH + 'px';

  view.cssW = cssW;
  view.cssH = cssH;

  renderTask = currentPdfPage.render({ canvasContext: ctx, viewport });
  try {
    await renderTask.promise;
  } catch (e) {
    if (e?.name !== 'RenderingCancelledException') throw e;
    return;
  }
  renderTask = null;
  return { cssW, cssH };
}

// Re-render at a higher quality when the user has zoomed in significantly.
// Debounced so we don't thrash during ongoing gestures.
let qualityTimer = null;
export function scheduleQualityRender() {
  clearTimeout(qualityTimer);
  qualityTimer = setTimeout(async () => {
    if (!currentPdfPage) return;
    const targetScale = view.scale;
    // Don't re-render if we're close to current render scale
    const cssW = view.cssW;
    const newCssW = baseCssWidth() * targetScale;
    if (Math.abs(newCssW / cssW - 1) < 0.25) return;

    const prevX = view.x;
    const prevY = view.y;

    await renderAtScale(targetScale);
    // After re-render, canvas CSS size changed; reset transform to scale=1 at same visual position
    view.scale = 1;
    view.x = prevX;
    view.y = prevY;
    applyTransform(false);
  }, 350);
}

// Load a new page from the shas.org API
export async function loadPage(url, slug, daf, amud, onRegionsReady) {
  regions = null;
  document.getElementById('region-pending').classList.remove('hidden');
  canvas.style.opacity = '0';

  const pdfDoc = await pdfjsLib.getDocument({ url, withCredentials: false }).promise;
  currentPdfPage = await pdfDoc.getPage(1);

  const naturalViewport = currentPdfPage.getViewport({ scale: 1 });

  // Scale to fit the page width to screen
  const fitScale = baseCssWidth() / naturalViewport.width;

  await renderAtScale(fitScale);

  // Center the page on screen
  view.scale = 1;
  view.x = (window.innerWidth - view.cssW) / 2;
  view.y = Math.max(0, (window.innerHeight - view.cssH) / 2);
  applyTransform(false);

  canvas.style.opacity = '1';

  // Run region detection asynchronously (doesn't block display)
  detectRegionsForPage(slug, daf, amud, onRegionsReady);
}

async function detectRegionsForPage(slug, daf, amud, onReady) {
  // Check cache first
  const cached = getCachedRegions(slug, daf, amud);
  if (cached) {
    regions = cached;
    document.getElementById('region-pending').classList.add('hidden');
    onReady?.(regions);
    return;
  }

  // Run detection (canvas already rendered)
  // Use a short setTimeout so the browser paints first
  await new Promise(r => setTimeout(r, 50));
  const detected = detectRegions(canvas);
  regions = detected;
  setCachedRegions(slug, daf, amud, detected);
  document.getElementById('region-pending').classList.add('hidden');
  onReady?.(regions);
}

// Animate to a target transform
export function animateTo(targetX, targetY, targetScale, onDone) {
  view.x = targetX;
  view.y = targetY;
  view.scale = targetScale;
  applyTransform(true);

  canvas.addEventListener('transitionend', function handler() {
    canvas.removeEventListener('transitionend', handler);
    canvas.classList.remove('animating');
    scheduleQualityRender();
    onDone?.();
  }, { once: true });
}

// Compute transform to fit a normalized region [0..1] centered on screen
// at the given viewScale. If viewScale is null, fit region to 90% of screen height.
export function transformForRegion(region, preferredScale) {
  const regionCssX = region.x * view.cssW;
  const regionCssY = region.y * view.cssH;
  const regionCssW = region.w * view.cssW;
  const regionCssH = region.h * view.cssH;

  const scale = preferredScale ?? (window.innerHeight * 0.9 / regionCssH);

  const cx = regionCssX + regionCssW / 2;
  const cy = regionCssY + regionCssH / 2;

  const x = window.innerWidth / 2 - cx * scale;
  const y = window.innerHeight / 2 - cy * scale;

  return { x, y, scale };
}

// Transform to fit the full page
export function transformForHome() {
  const scale = 1; // canvas is already rendered at fitScale (scale=1 in CSS)
  const x = (window.innerWidth - view.cssW) / 2;
  const y = Math.max(0, (window.innerHeight - view.cssH) / 2);
  return { x, y, scale };
}

// Apply a delta from gesture (no animation)
export function applyDelta(dx, dy, dScale, originX, originY) {
  if (dScale !== 1) {
    // Scale around the gesture origin
    view.x = originX + (view.x - originX) * dScale;
    view.y = originY + (view.y - originY) * dScale;
    view.scale *= dScale;
  }
  view.x += dx;
  view.y += dy;
  applyTransform(false);
}

export { canvas };
