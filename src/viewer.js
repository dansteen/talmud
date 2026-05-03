import * as pdfjsLib from 'pdfjs-dist';
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { detectRegions } from './regions.js';
import { getCachedRegions, setCachedRegions } from './storage.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

const canvas = document.getElementById('page-canvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true });

// Page geometry (set once per loaded page)
let pageW = 1;       // natural PDF width (PDF points)
let pageH = 1;       // natural PDF height (PDF points)
let renderScale = 1; // scale at which the canvas was last rendered

// Visual transform applied to the canvas via CSS
export const view = {
  scale: 1,  // visual scale on top of the canvas's natural CSS size
  x: 0,
  y: 0,
  cssW: 0,   // canvas natural CSS width (= pageW * renderScale)
  cssH: 0,
};

export let regions = null;

let currentPdfPage = null;
let renderTask = null;

// Scale that fits the whole page within the viewport (preserves aspect)
function fitScreenScale() {
  return Math.min(
    window.innerWidth / pageW,
    window.innerHeight / pageH,
  ) * 0.96;
}

function applyTransform(animated = false) {
  canvas.classList.toggle('animating', animated);
  canvas.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
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
    applyTransform(false);
  }, 350);
}

export async function loadPage(url, slug, daf, amud, onRegionsReady) {
  regions = null;
  document.getElementById('region-pending').classList.remove('hidden');
  canvas.style.opacity = '0';

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

  await renderAtScale(fitScreenScale());

  // Center the page in the viewport
  view.scale = 1;
  view.x = (window.innerWidth - view.cssW) / 2;
  view.y = (window.innerHeight - view.cssH) / 2;
  applyTransform(false);

  canvas.style.opacity = '1';

  detectRegionsForPage(slug, daf, amud, onRegionsReady);
}

async function detectRegionsForPage(slug, daf, amud, onReady) {
  const cached = getCachedRegions(slug, daf, amud);
  if (cached) {
    regions = cached;
    document.getElementById('region-pending').classList.add('hidden');
    onReady?.(regions);
    return;
  }

  await new Promise(r => setTimeout(r, 50));
  const detected = detectRegions(canvas);
  regions = detected;
  setCachedRegions(slug, daf, amud, detected);
  document.getElementById('region-pending').classList.add('hidden');
  onReady?.(regions);
}

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
  // Scale to display the canvas at fit-screen size, regardless of renderScale
  const fit = fitScreenScale();
  const visualScale = fit / renderScale;
  const visualW = pageW * fit;
  const visualH = pageH * fit;
  return {
    x: (window.innerWidth - visualW) / 2,
    y: (window.innerHeight - visualH) / 2,
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
  applyTransform(false);
}

export { canvas };
