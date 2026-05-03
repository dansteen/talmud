// Detects column regions on a rendered Talmud page canvas.
//
// A Vilna edition page has a center Gemara column flanked by narrower
// commentary columns (Rashi, Tosafot). We find column boundaries by
// projecting ink density onto the x-axis and locating whitespace valleys.
//
// Returns an array of region objects sorted left-to-right:
//   { x, y, w, h }  — normalized [0..1] relative to canvas CSS dimensions
//   type: 'gemara' | 'commentary'

const SMOOTH_WINDOW = 20;   // px — moving average window for ink density curve
const VALLEY_THRESHOLD = 0.03; // ink density below this = candidate gap
const MIN_GAP_PX = 8;      // minimum width of a real column gap
const MARGIN_TRIM = 0.03;  // trim this fraction from top/bottom to skip headers/footers

function movingAverage(arr, window) {
  const result = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    let sum = 0, count = 0;
    for (let j = Math.max(0, i - window); j <= Math.min(arr.length - 1, i + window); j++) {
      sum += arr[j]; count++;
    }
    result[i] = sum / count;
  }
  return result;
}

function computeInkDensityX(imageData, width, height) {
  const { data } = imageData;
  const trimTop = Math.floor(height * MARGIN_TRIM);
  const trimBot = Math.floor(height * (1 - MARGIN_TRIM));
  const span = trimBot - trimTop;

  const density = new Float32Array(width);
  for (let x = 0; x < width; x++) {
    let ink = 0;
    for (let y = trimTop; y < trimBot; y++) {
      const i = (y * width + x) * 4;
      // Luminance — dark pixel = ink
      const lum = (data[i] * 0.299 + data[i+1] * 0.587 + data[i+2] * 0.114) / 255;
      if (lum < 0.5) ink++;
    }
    density[x] = ink / span;
  }
  return density;
}

// Find contiguous runs of low-density columns (gaps between text columns)
function findGaps(smoothed, width) {
  const gaps = [];
  let gapStart = -1;

  for (let x = 0; x < width; x++) {
    if (smoothed[x] < VALLEY_THRESHOLD) {
      if (gapStart === -1) gapStart = x;
    } else {
      if (gapStart !== -1) {
        const gapWidth = x - gapStart;
        if (gapWidth >= MIN_GAP_PX) {
          gaps.push({ start: gapStart, end: x, mid: Math.round((gapStart + x) / 2) });
        }
        gapStart = -1;
      }
    }
  }
  if (gapStart !== -1 && (width - gapStart) >= MIN_GAP_PX) {
    gaps.push({ start: gapStart, end: width, mid: Math.round((gapStart + width) / 2) });
  }
  return gaps;
}

// Compute the y-extent of a column (trim blank rows at top/bottom)
function columnYExtent(imageData, width, height, colX, colW) {
  const { data } = imageData;
  let top = height, bottom = 0;

  for (let y = 0; y < height; y++) {
    for (let x = colX; x < colX + colW; x++) {
      const i = (y * width + x) * 4;
      const lum = (data[i] * 0.299 + data[i+1] * 0.587 + data[i+2] * 0.114) / 255;
      if (lum < 0.5) {
        if (y < top) top = y;
        if (y > bottom) bottom = y;
        break;
      }
    }
  }

  return top < bottom ? { top, bottom } : { top: 0, bottom: height };
}

export function detectRegions(canvas) {
  const { width, height } = canvas;
  const ctx = canvas.getContext('2d');
  const imageData = ctx.getImageData(0, 0, width, height);

  const density = computeInkDensityX(imageData, width, height);
  const smoothed = movingAverage(density, SMOOTH_WINDOW);
  const gaps = findGaps(smoothed, width);

  // Build column x-ranges from gaps
  const boundaries = [0, ...gaps.map(g => g.mid), width];
  const columns = [];

  for (let i = 0; i < boundaries.length - 1; i++) {
    const x = boundaries[i];
    const w = boundaries[i+1] - x;
    if (w < 10) continue; // skip slivers

    const { top, bottom } = columnYExtent(imageData, width, height, x, w);
    columns.push({ px: { x, y: top, w, h: bottom - top } });
  }

  if (columns.length === 0) return [];

  // Classify: widest column = gemara, others = commentary
  const maxW = Math.max(...columns.map(c => c.px.w));

  return columns.map(col => ({
    x: col.px.x / width,
    y: col.px.y / height,
    w: col.px.w / width,
    h: col.px.h / height,
    type: col.px.w === maxW ? 'gemara' : 'commentary',
  }));
}

// Return the region that contains the given point (canvas-relative coords)
export function regionAtPoint(regions, px, py, canvasCssW, canvasCssH) {
  const nx = px / canvasCssW;
  const ny = py / canvasCssH;

  return regions.find(r =>
    nx >= r.x && nx <= r.x + r.w &&
    ny >= r.y && ny <= r.y + r.h
  ) ?? null;
}
