// Detects column regions on a typeset Talmud page using PDF.js text content.
//
// Three tiers based on font size:
//   gemara     — largest font (main center text)
//   commentary — medium font (Rashi, Tosafot)
//   reference  — smallest font (Masoret HaShas, Ein Mishpat, etc.)
//
// Algorithm:
//   1. Pull every text item — keep only x/yBaseline/fontSize, ignore width.
//   2. Bucket items by their start x and find empty-bucket gaps to split columns.
//   3. For each column, estimate a bounding box from item positions + an inferred
//      width based on string length and font size (PDF item widths are unreliable).
//   4. Classify regions by font size into the three tiers.
//
// Output coordinates are normalized [0..1] relative to natural page size.

const X_BUCKET = 4;            // PDF units per column-detection bucket
const MIN_GAP_BUCKETS = 2;     // empty buckets needed to split a column
const MIN_COLUMN_ITEMS = 3;    // columns with fewer items are dropped

const TIER_GEMARA = 0.80;      // fontSize / maxFontSize ≥ this → gemara
const TIER_COMMENTARY = 0.55;  // ≥ this but below gemara → commentary
                                // anything smaller → reference

const DEBUG = typeof location !== 'undefined'
  && new URLSearchParams(location.search).has('debug');

// Exposed for the debug overlay to draw item dots
export const debugInfo = { items: null, pageW: 0, pageH: 0 };

export async function detectRegions(pdfPage) {
  const naturalViewport = pdfPage.getViewport({ scale: 1 });
  const pageW = naturalViewport.width;
  const pageH = naturalViewport.height;

  const textContent = await pdfPage.getTextContent();
  const items = [];

  for (const item of textContent.items) {
    if (!item.str?.trim()) continue;
    const fontSize = Math.abs(item.transform[0]);
    if (fontSize < 1) continue;

    items.push({
      x: item.transform[4],
      yBaseline: item.transform[5],
      str: item.str,
      fontSize,
      fontName: item.fontName,
      dir: item.dir,
    });
  }

  debugInfo.items = items;
  debugInfo.pageW = pageW;
  debugInfo.pageH = pageH;

  if (items.length === 0) return [];

  const columns = findColumnsByStartX(items, pageW);
  const regions = columns
    .filter(col => col.length >= MIN_COLUMN_ITEMS)
    .map(col => buildRegion(col, pageW, pageH));

  const classified = classifyByTier(regions);

  if (DEBUG) logDiagnostic(items, pageW, pageH, classified);

  return classified;
}

function logDiagnostic(items, pageW, pageH, regions) {
  const buckets = 60;
  const bucketSize = pageW / buckets;
  const histo = new Array(buckets).fill(0);
  for (const item of items) {
    const b = Math.min(buckets - 1, Math.floor(item.x / bucketSize));
    if (b >= 0) histo[b]++;
  }

  const dirs = {};
  for (const item of items) {
    dirs[item.dir || '?'] = (dirs[item.dir || '?'] || 0) + 1;
  }

  const peak = Math.max(...histo, 1);

  console.group(`detectRegions: ${items.length} items, ${regions.length} regions`);
  console.log(`page: ${pageW.toFixed(0)} × ${pageH.toFixed(0)}`);
  console.log('directions:', dirs);
  console.log('first items:', items.slice(0, 8).map(i => ({
    x: +i.x.toFixed(1), y: +i.yBaseline.toFixed(1),
    fs: +i.fontSize.toFixed(1), s: i.str, d: i.dir,
  })));
  console.log(
    'x histogram (60 buckets):\n' +
    histo.map((c, i) => {
      const x = (i * bucketSize).toFixed(0).padStart(5);
      const bar = '█'.repeat(Math.ceil((c / peak) * 40));
      return `${x} | ${bar} (${c})`;
    }).join('\n')
  );
  console.log('regions:', regions);
  console.groupEnd();
}

function findColumnsByStartX(items, pageW) {
  // Use only item start positions — text widths from PDF.js are unreliable
  // and cause columns to overlap when used directly.
  const numBuckets = Math.ceil(pageW / X_BUCKET);
  const counts = new Uint16Array(numBuckets);
  for (const item of items) {
    const b = Math.floor(item.x / X_BUCKET);
    if (b >= 0 && b < numBuckets) counts[b]++;
  }

  const runs = [];
  let runStart = -1;
  let lastNonEmpty = -1;
  for (let i = 0; i < numBuckets; i++) {
    if (counts[i] > 0) {
      if (runStart === -1) runStart = i;
      lastNonEmpty = i;
    } else if (runStart !== -1 && i - lastNonEmpty >= MIN_GAP_BUCKETS) {
      runs.push({ startX: runStart * X_BUCKET, endX: (lastNonEmpty + 1) * X_BUCKET });
      runStart = -1;
    }
  }
  if (runStart !== -1) {
    runs.push({ startX: runStart * X_BUCKET, endX: (lastNonEmpty + 1) * X_BUCKET });
  }

  return runs.map(run =>
    items.filter(item => item.x >= run.startX && item.x < run.endX)
  );
}

function buildRegion(items, pageW, pageH) {
  let xMin = Infinity, xMax = -Infinity;
  let yMin = Infinity, yMax = -Infinity;

  for (const item of items) {
    // Hebrew average character width is roughly 0.55 × font size
    const itemW = item.str.length * item.fontSize * 0.55;
    const itemH = item.fontSize * 1.1;

    // For RTL (Hebrew), transform[4] is the right edge — text extends leftward
    const isRTL = item.dir === 'rtl';
    const left = isRTL ? item.x - itemW : item.x;
    const right = isRTL ? item.x : item.x + itemW;

    // PDF y is bottom-up; flip to top-down
    const top = pageH - item.yBaseline - itemH;
    const bottom = pageH - item.yBaseline;

    if (left < xMin) xMin = left;
    if (right > xMax) xMax = right;
    if (top < yMin) yMin = top;
    if (bottom > yMax) yMax = bottom;
  }

  // Clamp to page bounds — guards against outliers
  xMin = Math.max(0, xMin);
  yMin = Math.max(0, yMin);
  xMax = Math.min(pageW, xMax);
  yMax = Math.min(pageH, yMax);

  // Median font size — robust to occasional outliers
  const sizes = items.map(i => i.fontSize).sort((a, b) => a - b);
  const fontSize = sizes[Math.floor(sizes.length / 2)];

  return {
    x: xMin / pageW,
    y: yMin / pageH,
    w: (xMax - xMin) / pageW,
    h: (yMax - yMin) / pageH,
    fontSize,
    itemCount: items.length,
  };
}

function classifyByTier(regions) {
  if (regions.length === 0) return [];
  const maxSize = Math.max(...regions.map(r => r.fontSize));

  return regions.map(r => {
    const ratio = r.fontSize / maxSize;
    let type;
    if (ratio >= TIER_GEMARA) type = 'gemara';
    else if (ratio >= TIER_COMMENTARY) type = 'commentary';
    else type = 'reference';
    return { ...r, type };
  });
}

// Find the smallest region containing a point given in canvas-relative CSS coords
export function regionAtPoint(regions, px, py, canvasCssW, canvasCssH) {
  const nx = px / canvasCssW;
  const ny = py / canvasCssH;
  let best = null;
  let bestArea = Infinity;
  for (const r of regions) {
    if (nx < r.x || nx > r.x + r.w) continue;
    if (ny < r.y || ny > r.y + r.h) continue;
    const area = r.w * r.h;
    if (area < bestArea) { best = r; bestArea = area; }
  }
  return best;
}
