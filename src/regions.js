// Region detection for typeset Talmud pages using PDF.js text content.
//
// Two-stage approach:
//   1. Tier each item by font size (gemara / commentary / reference). Detect
//      columns separately within each tier — items from different tiers
//      don't interfere with each other's column gap detection.
//   2. Merge columns across tiers whose x-ranges overlap. Commentaries quote
//      the Gemara at its font size, so per-tier detection scatters those
//      quote items as tiny "gemara" sub-columns inside Rashi/Tosafot. After
//      merging, each merged column is typed by which tier has the most
//      items in it — the commentary column with a few quotes correctly
//      ends up as 'commentary'.

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

  // Detect columns within each tier
  const tierColumns = [];
  for (const tier of tiers) {
    const cols = findColumnsByStartX(tier.items, pageW);
    for (const col of cols) {
      if (col.items.length < MIN_COLUMN_ITEMS) continue;
      tierColumns.push(col);
    }
  }

  // Merge across tiers when x-ranges overlap (or are very close together)
  const merged = mergeOverlappingColumns(tierColumns);

  // Build regions, capping right edges at the next column's start
  merged.sort((a, b) => a.range.startX - b.range.startX);
  const regions = [];
  for (let i = 0; i < merged.length; i++) {
    const nextStart = merged[i + 1]?.range.startX ?? pageW;
    const region = buildRegion(merged[i], pageW, pageH, nextStart);
    region.type = dominantTier(merged[i].items);
    regions.push(region);
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
    for (const item of items) item._tier = 'gemara';
    return [{ type: 'gemara', items, refSize: items[0]?.fontSize ?? 0 }];
  }

  const refSize = substantial[0][0];
  const gemaraThreshold = refSize * TIER_GEMARA;
  const commentaryThreshold = refSize * TIER_COMMENTARY;

  const gemara = [], commentary = [], reference = [];
  for (const item of items) {
    if (item.fontSize >= gemaraThreshold) { item._tier = 'gemara'; gemara.push(item); }
    else if (item.fontSize >= commentaryThreshold) { item._tier = 'commentary'; commentary.push(item); }
    else { item._tier = 'reference'; reference.push(item); }
  }

  const tiers = [];
  if (gemara.length) tiers.push({ type: 'gemara', items: gemara, refSize });
  if (commentary.length) tiers.push({ type: 'commentary', items: commentary, refSize });
  if (reference.length) tiers.push({ type: 'reference', items: reference, refSize });
  return tiers;
}

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
    range: { ...run },
    items: items.filter(item => item.x >= run.startX && item.x < run.endX),
  }));
}

// Merge columns whose x-ranges overlap (or touch within MIN_GAP_BUCKETS).
// This collapses gemara-quote sub-columns inside commentary columns into
// the parent commentary column.
function mergeOverlappingColumns(cols) {
  if (cols.length === 0) return [];
  const sorted = [...cols].sort((a, b) => a.range.startX - b.range.startX);
  const merged = [{ range: { ...sorted[0].range }, items: [...sorted[0].items] }];

  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i];
    const last = merged[merged.length - 1];
    const tolerance = MIN_GAP_BUCKETS * X_BUCKET;
    if (cur.range.startX <= last.range.endX + tolerance) {
      last.range.endX = Math.max(last.range.endX, cur.range.endX);
      last.items.push(...cur.items);
    } else {
      merged.push({ range: { ...cur.range }, items: [...cur.items] });
    }
  }
  return merged;
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

  for (const item of items) {
    const itemW = item.str.length * item.fontSize * HEBREW_CHAR_WIDTH;
    const left = item.x;
    const right = item.x + itemW;
    const top = item.yBaseline - item.fontSize;
    const bottom = item.yBaseline + item.fontSize * 0.25;

    if (left < xMin) xMin = left;
    if (right > xMax) xMax = right;
    if (top < yMin) yMin = top;
    if (bottom > yMax) yMax = bottom;
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
