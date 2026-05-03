// Detects column regions on a typeset Talmud page using PDF.js text content.
//
// We get exact glyph positions and font sizes from the PDF — far more reliable
// than pixel analysis. Algorithm:
//   1. Pull every text item with its position/width/font size.
//   2. Build an x-axis occupancy map; horizontal gaps split columns.
//   3. Group items into columns by which gap they fall between.
//   4. Compute each column's bounding box and median font size.
//   5. Classify regions: largest font sizes = gemara, smaller = commentary.
//
// All output coordinates are normalized [0..1] relative to the natural page size.

const COLUMN_GAP_TOLERANCE = 8;   // PDF units — gaps narrower than this don't split
const MIN_COLUMN_WIDTH = 15;      // PDF units — narrower runs are dropped
const MIN_ITEM_COUNT = 2;         // single-glyph artifacts ignored
const GEMARA_FONT_RATIO = 0.85;   // font size ≥ this fraction of max → gemara

export async function detectRegions(pdfPage) {
  const naturalViewport = pdfPage.getViewport({ scale: 1 });
  const pageW = naturalViewport.width;
  const pageH = naturalViewport.height;

  const textContent = await pdfPage.getTextContent();
  const items = [];

  for (const item of textContent.items) {
    if (!item.str?.trim()) continue;
    const fontSize = Math.abs(item.transform[0]);
    if (fontSize < 0.5) continue; // skip degenerate items
    const x = item.transform[4];
    const yBaseline = item.transform[5];
    const w = item.width || fontSize * item.str.length * 0.5;
    const h = item.height || fontSize;
    items.push({
      x,
      y: pageH - yBaseline - h,  // flip to top-down
      w,
      h,
      fontSize,
      fontName: item.fontName,
    });
  }

  if (items.length === 0) return [];

  const columns = findColumns(items, pageW);
  const regions = columns
    .filter(col => col.length >= MIN_ITEM_COUNT)
    .map(col => buildRegion(col, pageW, pageH))
    .filter(r => r.w * pageW >= MIN_COLUMN_WIDTH);

  if (regions.length === 0) return [];

  const maxFontSize = Math.max(...regions.map(r => r.fontSize));
  return regions.map(r => ({
    ...r,
    type: r.fontSize >= maxFontSize * GEMARA_FONT_RATIO ? 'gemara' : 'commentary',
  }));
}

function findColumns(items, pageW) {
  // Build per-x-unit occupancy
  const width = Math.ceil(pageW);
  const occupancy = new Uint16Array(width);
  for (const item of items) {
    const start = Math.max(0, Math.floor(item.x));
    const end = Math.min(width, Math.ceil(item.x + item.w));
    for (let x = start; x < end; x++) occupancy[x]++;
  }

  // Find runs of nonzero occupancy, merging across small gaps
  const runs = [];
  let runStart = -1;
  let lastNonZero = -1;
  for (let x = 0; x < width; x++) {
    if (occupancy[x] > 0) {
      if (runStart === -1) runStart = x;
      lastNonZero = x;
    } else if (runStart !== -1 && x - lastNonZero > COLUMN_GAP_TOLERANCE) {
      runs.push({ start: runStart, end: lastNonZero + 1 });
      runStart = -1;
    }
  }
  if (runStart !== -1) runs.push({ start: runStart, end: lastNonZero + 1 });

  // Assign each item to the run containing its horizontal center
  return runs.map(run =>
    items.filter(item => {
      const cx = item.x + item.w / 2;
      return cx >= run.start && cx <= run.end;
    })
  );
}

function buildRegion(items, pageW, pageH) {
  let xMin = Infinity, xMax = -Infinity;
  let yMin = Infinity, yMax = -Infinity;
  for (const i of items) {
    if (i.x < xMin) xMin = i.x;
    if (i.x + i.w > xMax) xMax = i.x + i.w;
    if (i.y < yMin) yMin = i.y;
    if (i.y + i.h > yMax) yMax = i.y + i.h;
  }
  const fontSizes = items.map(i => i.fontSize).sort((a, b) => a - b);
  const fontSize = fontSizes[Math.floor(fontSizes.length / 2)]; // median

  return {
    x: xMin / pageW,
    y: yMin / pageH,
    w: (xMax - xMin) / pageW,
    h: (yMax - yMin) / pageH,
    fontSize,
    itemCount: items.length,
  };
}

// Find the region containing a point given in canvas-relative CSS coords
export function regionAtPoint(regions, px, py, canvasCssW, canvasCssH) {
  const nx = px / canvasCssW;
  const ny = py / canvasCssH;
  // Prefer the region with smallest area when nested (so taps on commentary
  // inside the gemara's bounding box don't grab the gemara)
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
