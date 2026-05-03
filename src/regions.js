// Region detection for typeset Talmud pages using PDF.js text content.
//
// Strategy: split items into three font-size tiers (gemara / commentary /
// reference) FIRST, then find columns within each tier independently using
// start-x histogram clustering. Items from different tiers don't interfere,
// so the gaps between visual columns become visible.
//
// Algorithm:
//   1. Convert all item positions from PDF coords to viewport (display) coords.
//   2. Pick a "reference" font size: largest substantial size (the gemara body).
//   3. Sort items into three tiers by ratio to the reference.
//   4. For each tier, build a histogram of item *start-x* positions and find
//      runs separated by enough empty buckets. Don't use inferred widths for
//      occupancy — that bridges columns.
//   5. For each cluster, the bounding box uses the actual extent of items
//      (start-x to inferred-right), capped at the next within-tier column's
//      start so it can't overflow.

const X_BUCKET = 4;
const MIN_GAP_BUCKETS = 3;
const MIN_COLUMN_ITEMS = 5;
const MIN_TIER_REF_ITEMS = 30;

const TIER_GEMARA = 0.92;
const TIER_COMMENTARY = 0.65;

const HEBREW_CHAR_WIDTH = 0.45;

export const debugInfo = { items: null, pageW: 0, pageH: 0 };

export async function detectRegions(pdfPage) {
  const naturalViewport = pdfPage.getViewport({ scale: 1 });
  const pageW = naturalViewport.width;
  const pageH = naturalViewport.height;

  const textContent = await pdfPage.getTextContent();
  const items = extractItems(textContent.items, naturalViewport);

  debugInfo.items = items;
  debugInfo.pageW = pageW;
  debugInfo.pageH = pageH;

  if (items.length === 0) return [];

  const tiers = splitByFontTier(items);

  const regions = [];
  for (const tier of tiers) {
    const cols = findColumnsByStartX(tier.items, pageW);
    cols.sort((a, b) => a.range.startX - b.range.startX);

    for (let i = 0; i < cols.length; i++) {
      if (cols[i].items.length < MIN_COLUMN_ITEMS) continue;
      const nextStart = cols[i + 1]?.range.startX ?? pageW;
      const region = buildRegion(cols[i], pageW, pageH, nextStart);
      region.type = tier.type;
      regions.push(region);
    }
  }

  logDiagnostic(items, pageW, pageH, regions, tiers);
  return regions;
}

function extractItems(rawItems, viewport) {
  const items = [];
  for (const item of rawItems) {
    if (!item.str?.trim()) continue;
    const fontSize = Math.abs(item.transform[0]);
    if (fontSize < 1) continue;

    // Convert from PDF user space to viewport (top-down) coordinates.
    // Handles non-zero MediaBox origins, rotations, etc.
    const [vx, vy] = viewport.convertToViewportPoint(
      item.transform[4],
      item.transform[5]
    );

    items.push({
      x: vx,
      yBaseline: vy,  // top-down viewport coords
      str: item.str,
      fontSize,
      fontName: item.fontName,
      dir: item.dir,
    });
  }
  return items;
}

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

// Cluster items by start-x only. Inferred widths can bridge columns, so we
// keep occupancy point-based: each item contributes to one bucket.
function findColumnsByStartX(items, pageW) {
  if (items.length === 0) return [];

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

  return runs.map(run => ({
    range: run,
    items: items.filter(item => item.x >= run.startX && item.x < run.endX),
  }));
}

function buildRegion(col, pageW, pageH, nextColumnStart) {
  const { items } = col;

  let xMin = Infinity, xMax = -Infinity;
  let yMin = Infinity, yMax = -Infinity;

  for (const item of items) {
    const itemW = item.str.length * item.fontSize * HEBREW_CHAR_WIDTH;
    const left = item.x;
    const right = item.x + itemW;
    // Viewport coords: yBaseline is top-down. Text top sits above baseline by
    // ~font height; descent is small.
    const top = item.yBaseline - item.fontSize;
    const bottom = item.yBaseline + item.fontSize * 0.25;

    if (left < xMin) xMin = left;
    if (right > xMax) xMax = right;
    if (top < yMin) yMin = top;
    if (bottom > yMax) yMax = bottom;
  }

  // Cap the right edge at the start of the next column in this tier so the
  // bbox can't bleed into a neighboring column.
  xMax = Math.min(xMax, nextColumnStart - X_BUCKET);

  xMin = Math.max(0, xMin);
  xMax = Math.min(pageW, xMax);
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
