// Region detection for typeset Talmud pages using PDF.js text content.
//
// Strategy: split items into three font-size tiers (gemara / commentary /
// reference) FIRST, then find columns within each tier independently. Items
// from different tiers don't interfere with each other's column detection,
// so the gaps between visual columns become visible.
//
// Algorithm:
//   1. Pick a "reference" font size: the largest substantial size (the Gemara
//      body text). Larger outliers like the Mishnah-opener decoration get
//      bucketed with gemara, which is fine — they live in the same column.
//   2. Sort items into three tiers by ratio to the reference size.
//   3. For each tier, build x-axis occupancy using inferred widths and find
//      runs separated by empty buckets.
//   4. Each run is a column. Bounding box uses the column's x range and the
//      items' y extents — never extends past the gap-detected boundaries.
//
// Output: regions in normalized [0..1] coords with a 'type' field.

const X_BUCKET = 4;             // PDF units per occupancy bucket
const MIN_GAP_BUCKETS = 3;      // 12 PDF units of empty space splits a column
const MIN_COLUMN_ITEMS = 5;     // narrower columns are dropped
const MIN_TIER_REF_ITEMS = 30;  // a font size needs this many items to be the gemara reference

const TIER_GEMARA = 0.92;       // fontSize / refSize ≥ this → gemara
const TIER_COMMENTARY = 0.65;   // ≥ this but < gemara → commentary
                                 // anything smaller → reference

const HEBREW_CHAR_WIDTH = 0.45; // average Hebrew glyph width as a fraction of font size

export const debugInfo = { items: null, pageW: 0, pageH: 0 };

export async function detectRegions(pdfPage) {
  const naturalViewport = pdfPage.getViewport({ scale: 1 });
  const pageW = naturalViewport.width;
  const pageH = naturalViewport.height;

  const textContent = await pdfPage.getTextContent();
  const items = extractItems(textContent.items);

  debugInfo.items = items;
  debugInfo.pageW = pageW;
  debugInfo.pageH = pageH;

  if (items.length === 0) return [];

  const tiers = splitByFontTier(items);

  const regions = [];
  for (const tier of tiers) {
    const columns = findColumnsByOccupancy(tier.items, pageW);
    for (const col of columns) {
      if (col.items.length < MIN_COLUMN_ITEMS) continue;
      const region = buildRegion(col, pageW, pageH);
      region.type = tier.type;
      regions.push(region);
    }
  }

  logDiagnostic(items, pageW, pageH, regions, tiers);
  return regions;
}

function extractItems(rawItems) {
  const items = [];
  for (const item of rawItems) {
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
  return items;
}

// Split items into three tiers by font size, anchored to the largest font
// size that has substantial item count (avoids letting Mishnah-opener
// outliers skew the threshold).
function splitByFontTier(items) {
  const sizeCount = new Map();
  for (const item of items) {
    const key = Math.round(item.fontSize * 10) / 10;
    sizeCount.set(key, (sizeCount.get(key) || 0) + 1);
  }
  const substantial = [...sizeCount.entries()]
    .filter(([, n]) => n >= MIN_TIER_REF_ITEMS)
    .sort((a, b) => b[0] - a[0]);

  if (substantial.length === 0) {
    return [{ type: 'gemara', items, refSize: items[0]?.fontSize ?? 0 }];
  }

  const refSize = substantial[0][0];
  const gemaraThreshold = refSize * TIER_GEMARA;
  const commentaryThreshold = refSize * TIER_COMMENTARY;

  const gemara = [], commentary = [], reference = [];
  for (const item of items) {
    if (item.fontSize >= gemaraThreshold) gemara.push(item);
    else if (item.fontSize >= commentaryThreshold) commentary.push(item);
    else reference.push(item);
  }

  const tiers = [];
  if (gemara.length) tiers.push({ type: 'gemara', items: gemara, refSize });
  if (commentary.length) tiers.push({ type: 'commentary', items: commentary, refSize });
  if (reference.length) tiers.push({ type: 'reference', items: reference, refSize });
  return tiers;
}

function findColumnsByOccupancy(items, pageW) {
  if (items.length === 0) return [];

  const numBuckets = Math.ceil(pageW / X_BUCKET);
  const occupancy = new Uint16Array(numBuckets);

  for (const item of items) {
    const itemW = item.str.length * item.fontSize * HEBREW_CHAR_WIDTH;
    const start = Math.max(0, Math.floor(item.x / X_BUCKET));
    const end = Math.min(numBuckets, Math.ceil((item.x + itemW) / X_BUCKET));
    for (let i = start; i < end; i++) occupancy[i]++;
  }

  // Find runs separated by MIN_GAP_BUCKETS empty buckets in a row
  const runs = [];
  let runStart = -1;
  let lastNonEmpty = -1;
  for (let i = 0; i < numBuckets; i++) {
    if (occupancy[i] > 0) {
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

  return runs.map(run => ({
    range: run,
    items: items.filter(item => {
      const itemW = item.str.length * item.fontSize * HEBREW_CHAR_WIDTH;
      const itemMid = item.x + itemW / 2;
      return itemMid >= run.startX && itemMid <= run.endX;
    }),
  }));
}

function buildRegion(col, pageW, pageH) {
  const { range, items } = col;

  let yMin = Infinity, yMax = -Infinity;
  for (const item of items) {
    const itemH = item.fontSize * 1.1;
    const top = pageH - item.yBaseline - itemH;
    const bottom = pageH - item.yBaseline;
    if (top < yMin) yMin = top;
    if (bottom > yMax) yMax = bottom;
  }

  const xMin = Math.max(0, range.startX);
  const xMax = Math.min(pageW, range.endX);
  yMin = Math.max(0, yMin);
  yMax = Math.min(pageH, yMax);

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

function logDiagnostic(items, pageW, pageH, regions, tiers) {
  console.log(
    `[regions] ${items.length} items → ${regions.length} regions, page ${pageW.toFixed(0)}×${pageH.toFixed(0)}`
  );
  console.log('[regions] tiers:', tiers.map(t => ({
    type: t.type, count: t.items.length, refSize: t.refSize,
  })));
  console.log('[regions] detected:', regions);
}

// Find the smallest region containing a point given in canvas-relative CSS coords.
// Smallest-area wins so a tap inside a commentary gets the commentary, not the
// surrounding gemara if they happen to overlap.
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
