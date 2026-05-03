// Region detection for typeset Talmud pages using PDF.js text content.
//
// The challenge: commentaries (Rashi/Tosafot) frequently quote the Gemara
// inline, using a different — often bold — variant of the gemara font. Those
// quote items have a 'gemara' font size but live spatially in commentary
// columns. If we cluster naively, the quotes scatter the gemara tier across
// commentary territory; if we merge to fix that, the merge cascades.
//
// Solution: separate "primary" items (the dominant font at each font size,
// i.e. the regular weight) from "secondary" items (less-common fonts at the
// same size, i.e. bolds/italics like Gemara quotes). Only primary items
// vote in column-boundary detection. Secondary items still count for
// y-bounds and tier classification, so a column with a bold quote still
// extends tall enough to cover it.
//
// Then classify each detected column by which tier (gemara / commentary /
// reference) contributes the most items to it.

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

  tagTier(items);
  tagPrimary(items);

  const cols = findColumnsByStartX(items, pageW);
  cols.sort((a, b) => a.range.startX - b.range.startX);

  const regions = [];
  for (let i = 0; i < cols.length; i++) {
    if (cols[i].items.length < MIN_COLUMN_ITEMS) continue;
    const nextStart = cols[i + 1]?.range.startX ?? pageW;
    const region = buildRegion(cols[i], pageW, pageH, nextStart);
    region.type = dominantTier(cols[i].items);
    regions.push(region);
  }

  logDiagnostic(items, pageW, pageH, regions);
  return regions;
}

function extractItems(rawItems, viewport) {
  const items = [];
  for (const item of rawItems) {
    if (!item.str?.trim()) continue;
    const fontSize = Math.abs(item.transform[0]);
    if (fontSize < 1) continue;

    const [vx, vy] = viewport.convertToViewportPoint(
      item.transform[4],
      item.transform[5]
    );

    items.push({
      x: vx,
      yBaseline: vy,
      str: item.str,
      fontSize,
      fontName: item.fontName,
      dir: item.dir,
      _tier: null,
      _isPrimary: true,
    });
  }
  return items;
}

function tagTier(items) {
  const sizeCount = new Map();
  for (const item of items) {
    const key = Math.round(item.fontSize * 10) / 10;
    sizeCount.set(key, (sizeCount.get(key) || 0) + 1);
  }
  const substantial = [...sizeCount.entries()]
    .filter(([, n]) => n >= MIN_TIER_REF_ITEMS)
    .sort((a, b) => b[0] - a[0]);

  if (substantial.length === 0) {
    for (const item of items) item._tier = 'gemara';
    return;
  }

  const refSize = substantial[0][0];
  const gemaraThreshold = refSize * TIER_GEMARA;
  const commentaryThreshold = refSize * TIER_COMMENTARY;

  for (const item of items) {
    if (item.fontSize >= gemaraThreshold) item._tier = 'gemara';
    else if (item.fontSize >= commentaryThreshold) item._tier = 'commentary';
    else item._tier = 'reference';
  }
}

// Mark items using a non-dominant fontName at their font size as secondary.
// This isolates likely bold variants (used for Gemara quotes within commentary)
// so they don't shift x-column boundaries.
function tagPrimary(items) {
  const sizeFontCounts = new Map();
  for (const item of items) {
    const key = Math.round(item.fontSize * 10) / 10;
    if (!sizeFontCounts.has(key)) sizeFontCounts.set(key, new Map());
    const fc = sizeFontCounts.get(key);
    fc.set(item.fontName, (fc.get(item.fontName) || 0) + 1);
  }

  const primaryFont = new Map();
  for (const [size, fc] of sizeFontCounts) {
    let best = null, max = 0;
    for (const [fn, count] of fc) {
      if (count > max) { best = fn; max = count; }
    }
    primaryFont.set(size, best);
  }

  for (const item of items) {
    const key = Math.round(item.fontSize * 10) / 10;
    item._isPrimary = item.fontName === primaryFont.get(key);
  }
}

function findColumnsByStartX(items, pageW) {
  if (items.length === 0) return [];

  // Build histogram from primary items only — secondary items (bold quotes)
  // don't contribute to column boundary detection.
  const primary = items.filter(i => i._isPrimary);
  const clusterItems = primary.length >= 10 ? primary : items;

  const numBuckets = Math.ceil(pageW / X_BUCKET);
  const counts = new Uint16Array(numBuckets);
  for (const item of clusterItems) {
    const b = Math.floor(item.x / X_BUCKET);
    if (b >= 0 && b < numBuckets) counts[b]++;
  }

  const runs = [];
  let runStart = -1, lastNonEmpty = -1;
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

  // Assign ALL items to clusters by x-range — secondary items (bolds, quotes)
  // come along for the ride so they'll affect y-bounds and tier classification.
  return runs.map(run => ({
    range: { ...run },
    items: items.filter(item => item.x >= run.startX && item.x < run.endX),
  }));
}

function dominantTier(items) {
  const counts = { gemara: 0, commentary: 0, reference: 0 };
  for (const item of items) counts[item._tier]++;
  if (counts.gemara >= counts.commentary && counts.gemara >= counts.reference) return 'gemara';
  if (counts.commentary >= counts.reference) return 'commentary';
  return 'reference';
}

function buildRegion(col, pageW, pageH, nextColumnStart) {
  const { items } = col;

  let xMin = Infinity, xMax = -Infinity;
  let yMin = Infinity, yMax = -Infinity;
  let primaryCount = 0;

  for (const item of items) {
    // Y always extends — bold quotes within a column extend its vertical reach
    const top = item.yBaseline - item.fontSize;
    const bottom = item.yBaseline + item.fontSize * 0.25;
    if (top < yMin) yMin = top;
    if (bottom > yMax) yMax = bottom;

    // X only extends from primary items (ignore bold quotes that may stick out)
    if (item._isPrimary) {
      primaryCount++;
      const itemW = item.str.length * item.fontSize * HEBREW_CHAR_WIDTH;
      if (item.x < xMin) xMin = item.x;
      if (item.x + itemW > xMax) xMax = item.x + itemW;
    }
  }

  // If somehow no primary items (shouldn't happen), fall back to all items
  if (primaryCount === 0) {
    for (const item of items) {
      const itemW = item.str.length * item.fontSize * HEBREW_CHAR_WIDTH;
      if (item.x < xMin) xMin = item.x;
      if (item.x + itemW > xMax) xMax = item.x + itemW;
    }
  }

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
    primaryCount,
  };
}

function logDiagnostic(items, pageW, pageH, regions) {
  const tierCounts = { gemara: 0, commentary: 0, reference: 0 };
  let primary = 0;
  for (const item of items) {
    tierCounts[item._tier]++;
    if (item._isPrimary) primary++;
  }

  console.log(
    `[regions] ${items.length} items (${primary} primary) → ${regions.length} regions, page ${pageW.toFixed(0)}×${pageH.toFixed(0)}`
  );
  console.log('[regions] tier counts:', tierCounts);
  console.log('[regions] detected:', regions);
}

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
