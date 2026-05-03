// Region detection for typeset Talmud pages using PDF.js text content.
//
// The pipeline:
//   1. Extract items, convert PDF coords to viewport coords.
//   2. Tag each item by tier (gemara / commentary / reference) based on font
//      size relative to the dominant body-text size.
//   3. Tag each item primary or secondary by fontName frequency at its size.
//      The most common fontName at each size is the regular weight; others
//      are likely bold/italic variants like Gemara quotes inside commentary.
//   4. Per tier, cluster columns:
//      - Use only primary items within the body y-range to avoid the page
//        header (top) and footnotes (bottom) — those span the page width and
//        would close every gap in the histogram.
//      - Histogram start-x positions, find runs separated by empty buckets.
//      - Merge adjacent runs separated by less than SAME_TIER_MERGE_GAP to
//        handle within-column sub-clusters (indented lines, dropcaps, etc.).
//   5. Bounding box uses items in the body y-range so a margin column doesn't
//      stretch down into the footnote area.

const X_BUCKET = 4;
const MIN_GAP_BUCKETS = 3;
const MIN_COLUMN_ITEMS = 8;
const SAME_TIER_MERGE_GAP = 30; // PDF units
const MIN_TIER_REF_ITEMS = 30;
const TIER_GEMARA = 0.92;
const TIER_COMMENTARY = 0.65;
const HEBREW_CHAR_WIDTH = 0.45;
const Y_BODY_TOP = 0.05;
const Y_BODY_BOTTOM = 0.85;
const MIN_REF_STR_LENGTH = 2;  // single-char references are usually inline footnote markers
const MAX_ITEM_WIDTH_RATIO = 0.30;  // items wider than this are likely page-spanning footnote lines

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

  const regions = [];
  for (const tierType of ['gemara', 'commentary', 'reference']) {
    const tierItems = items.filter(i => i._tier === tierType);
    if (tierItems.length < MIN_COLUMN_ITEMS) continue;

    let cols = findColumnsByStartX(tierItems, pageW, pageH, tierType);
    cols = mergeAdjacent(cols, SAME_TIER_MERGE_GAP);
    cols.sort((a, b) => a.range.startX - b.range.startX);

    for (let i = 0; i < cols.length; i++) {
      if (cols[i].items.length < MIN_COLUMN_ITEMS) continue;
      const nextStart = cols[i + 1]?.range.startX ?? pageW;
      const region = buildRegion(cols[i], pageW, pageH, nextStart);
      region.type = tierType;
      regions.push(region);
    }
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

    // Convert width into viewport space too. PDF.js gives item.width in user
    // space; at viewport scale=1 it's the same, but we go through the viewport
    // transform anyway to be safe.
    let width = 0;
    if (item.width > 0) {
      const [vx2] = viewport.convertToViewportPoint(
        item.transform[4] + item.width,
        item.transform[5]
      );
      width = Math.abs(vx2 - vx);
    }

    items.push({
      x: vx,
      yBaseline: vy,
      width,
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

function findColumnsByStartX(items, pageW, pageH, tierType) {
  if (items.length === 0) return [];

  // Cluster only on items that are (a) primary at their font size and
  // (b) within the body y-range. Page headers and footnotes span page-wide
  // and would close every histogram gap.
  const yMin = pageH * Y_BODY_TOP;
  const yMax = pageH * Y_BODY_BOTTOM;
  const inBody = items.filter(i =>
    i.yBaseline >= yMin && i.yBaseline <= yMax
  );
  let primary = inBody.filter(i => i._isPrimary);

  // Reference tier includes inline footnote markers (often single Hebrew
  // letters) scattered through Rashi/Tosafot. They fill the histogram
  // between the left and right margins, hiding the real gap. Drop them
  // for clustering — they'll still be assigned to whichever cluster their
  // x-position lands in.
  if (tierType === 'reference') {
    primary = primary.filter(i => i.str.trim().length >= MIN_REF_STR_LENGTH);
  }

  // Drop anomalously wide items (page-spanning footnote/header lines) from
  // clustering. They start at x≈page-left and have wide widths, which fills
  // every histogram bucket and prevents margin columns from separating.
  primary = primary.filter(i => {
    const w = i.width > 0 ? i.width : i.str.length * i.fontSize * HEBREW_CHAR_WIDTH;
    return w <= pageW * MAX_ITEM_WIDTH_RATIO;
  });

  const clusterItems =
    primary.length >= 5 ? primary
    : inBody.length >= 5 ? inBody
    : items;

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

  // Assign every tier item whose x-position falls inside the run, regardless
  // of whether it was used in clustering.
  return runs.map(run => ({
    range: { ...run },
    items: items.filter(item => item.x >= run.startX && item.x < run.endX),
  }));
}

function mergeAdjacent(cols, maxGap) {
  if (cols.length === 0) return [];
  const sorted = [...cols].sort((a, b) => a.range.startX - b.range.startX);
  const merged = [{ range: { ...sorted[0].range }, items: [...sorted[0].items] }];
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i];
    const last = merged[merged.length - 1];
    if (cur.range.startX - last.range.endX < maxGap) {
      last.range.endX = Math.max(last.range.endX, cur.range.endX);
      last.items.push(...cur.items);
    } else {
      merged.push({ range: { ...cur.range }, items: [...cur.items] });
    }
  }
  return merged;
}

function buildRegion(col, pageW, pageH, nextColumnStart) {
  const { items } = col;
  const yBodyMin = pageH * Y_BODY_TOP;
  const yBodyMax = pageH * Y_BODY_BOTTOM;

  let xMin = Infinity, xMax = -Infinity;
  let yMin = Infinity, yMax = -Infinity;
  let primaryCount = 0;

  for (const item of items) {
    // Bounding box only counts items within the body y-range so a margin
    // column doesn't stretch down to capture footnote text at the same x.
    if (item.yBaseline < yBodyMin || item.yBaseline > yBodyMax) continue;

    const itemW = item.width > 0 ? item.width : item.str.length * item.fontSize * HEBREW_CHAR_WIDTH;
    // Skip page-spanning lines that would inflate the bbox horizontally
    if (itemW > pageW * MAX_ITEM_WIDTH_RATIO) continue;

    const top = item.yBaseline - item.fontSize;
    const bottom = item.yBaseline + item.fontSize * 0.25;
    if (top < yMin) yMin = top;
    if (bottom > yMax) yMax = bottom;

    if (item._isPrimary) {
      primaryCount++;
      if (item.x < xMin) xMin = item.x;
      if (item.x + itemW > xMax) xMax = item.x + itemW;
    }
  }

  if (primaryCount === 0) {
    // Fallback: use all items if no primary fell inside body y range
    for (const item of items) {
      const itemW = item.width > 0 ? item.width : item.str.length * item.fontSize * HEBREW_CHAR_WIDTH;
      if (item.x < xMin) xMin = item.x;
      if (item.x + itemW > xMax) xMax = item.x + itemW;
      const top = item.yBaseline - item.fontSize;
      const bottom = item.yBaseline + item.fontSize * 0.25;
      if (top < yMin) yMin = top;
      if (bottom > yMax) yMax = bottom;
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
