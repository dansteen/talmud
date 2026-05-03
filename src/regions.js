// Region detection by shape analysis on the rendered canvas.
//
// Pipeline:
//   1. Downsample the rendered canvas to a fixed analysis width.
//   2. Threshold to a binary ink-mask (dark pixels = ink, light = paper).
//   3. Apply anisotropic morphological dilation: small horizontal radius
//      (don't merge across columns), larger vertical radius (do merge
//      across line breaks within a column).
//   4. Find 4-connected components — each is a contiguous text block.
//   5. Filter components by area to drop noise / individual punctuation.
//   6. Look up text items whose center falls inside each component's
//      bbox and classify the component by dominant font tier.

const TARGET_WIDTH = 400;            // analysis canvas width in pixels
const H_DILATE = 3;                  // horizontal merge radius (within column)
const V_DILATE = 8;                  // vertical merge radius (across lines)
const MIN_COMPONENT_AREA_RATIO = 0.004;  // drop components smaller than 0.4% of page
const BAND_WIDTH_RATIO = 0.30;       // rows merge into the same band if widths are within this fraction
const BAND_SMOOTH_WINDOW = 10;       // smooth per-row x-range over ±N rows before banding
const MIN_BAND_HEIGHT_RATIO = 0.05;  // bands shorter than this fraction of region height merge into neighbor

const MIN_TIER_REF_ITEMS = 30;
const TIER_GEMARA = 0.92;
const TIER_COMMENTARY = 0.65;

export const debugInfo = { items: null, pageW: 0, pageH: 0 };

export async function detectRegions(canvas, pdfPage) {
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

  const mask = buildMaskFromCanvas(canvas);
  const dilated = dilate(mask.data, mask.width, mask.height, H_DILATE, V_DILATE);
  const components = findComponents(dilated, mask.width, mask.height);

  const minArea = mask.width * mask.height * MIN_COMPONENT_AREA_RATIO;
  const significant = components.filter(c => c.area >= minArea);

  const regions = significant.map(comp => {
    // Reduce the per-pixel mask to a series of axis-aligned bands. Each band
    // is a rectangle covering rows where the component's x-range is roughly
    // stable. Stacked bands form a stair-step polygon.
    const bands = extractBands(comp, mask.width, mask.height);

    // Recompute bbox from bands (slightly tighter than raw component bbox)
    let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
    for (const b of bands) {
      if (b.xMin < xMin) xMin = b.xMin;
      if (b.xMax > xMax) xMax = b.xMax;
      if (b.yStart < yMin) yMin = b.yStart;
      if (b.yEnd > yMax) yMax = b.yEnd;
    }

    const r = {
      x: xMin,
      y: yMin,
      w: xMax - xMin,
      h: yMax - yMin,
      bands,
    };

    const inside = items.filter(item => {
      const nx = item.x / pageW;
      const ny = item.yBaseline / pageH;
      return nx >= r.x && nx <= r.x + r.w && ny >= r.y && ny <= r.y + r.h;
    });

    r.type = dominantTier(inside);
    r.itemCount = inside.length;
    r.fontSize = medianFontSize(inside);
    return r;
  });

  console.log(
    `[regions] ${components.length} components → ${significant.length} significant → ${regions.length} regions, page ${pageW.toFixed(0)}×${pageH.toFixed(0)}`
  );
  console.log('[regions] detected:', regions);

  return regions;
}

function buildMaskFromCanvas(canvas) {
  const scale = TARGET_WIDTH / canvas.width;
  const w = Math.round(canvas.width * scale);
  const h = Math.round(canvas.height * scale);

  const tmp = document.createElement('canvas');
  tmp.width = w;
  tmp.height = h;
  const tmpCtx = tmp.getContext('2d', { willReadFrequently: true });
  tmpCtx.imageSmoothingEnabled = true;
  tmpCtx.imageSmoothingQuality = 'high';
  tmpCtx.drawImage(canvas, 0, 0, w, h);
  const imageData = tmpCtx.getImageData(0, 0, w, h);
  const pixels = imageData.data;

  const data = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const r = pixels[i * 4];
    const g = pixels[i * 4 + 1];
    const b = pixels[i * 4 + 2];
    const lum = r * 0.299 + g * 0.587 + b * 0.114;
    data[i] = lum < 128 ? 1 : 0;
  }
  return { data, width: w, height: h };
}

// Separable dilation: horizontal pass, then vertical. O(w * h * (hRadius + vRadius)).
function dilate(mask, w, h, hRadius, vRadius) {
  const hPass = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const yw = y * w;
    for (let x = 0; x < w; x++) {
      const xMin = Math.max(0, x - hRadius);
      const xMax = Math.min(w - 1, x + hRadius);
      let hit = 0;
      for (let nx = xMin; nx <= xMax; nx++) {
        if (mask[yw + nx]) { hit = 1; break; }
      }
      hPass[yw + x] = hit;
    }
  }

  const out = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      const yMin = Math.max(0, y - vRadius);
      const yMax = Math.min(h - 1, y + vRadius);
      let hit = 0;
      for (let ny = yMin; ny <= yMax; ny++) {
        if (hPass[ny * w + x]) { hit = 1; break; }
      }
      out[y * w + x] = hit;
    }
  }
  return out;
}

// 4-connected component labeling via BFS with a flat queue.
// Returns each component with its bbox AND its pixel mask cropped to bbox.
function findComponents(mask, w, h) {
  const visited = new Uint8Array(w * h);
  const components = [];
  const queue = new Int32Array(w * h);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (!mask[idx] || visited[idx]) continue;

      let head = 0, tail = 0;
      queue[tail++] = idx;
      visited[idx] = 1;

      let minX = x, minY = y, maxX = x, maxY = y, area = 0;
      const memberStart = tail - 1; // queue[memberStart..tail-1] holds all member indices

      while (head < tail) {
        const cur = queue[head++];
        const cx = cur % w;
        const cy = (cur - cx) / w;
        area++;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;

        if (cx > 0) {
          const n = cur - 1;
          if (mask[n] && !visited[n]) { visited[n] = 1; queue[tail++] = n; }
        }
        if (cx < w - 1) {
          const n = cur + 1;
          if (mask[n] && !visited[n]) { visited[n] = 1; queue[tail++] = n; }
        }
        if (cy > 0) {
          const n = cur - w;
          if (mask[n] && !visited[n]) { visited[n] = 1; queue[tail++] = n; }
        }
        if (cy < h - 1) {
          const n = cur + w;
          if (mask[n] && !visited[n]) { visited[n] = 1; queue[tail++] = n; }
        }
      }

      // Build cropped mask covering just this component's bbox
      const maskW = maxX - minX + 1;
      const maskH = maxY - minY + 1;
      const compMask = new Uint8Array(maskW * maskH);
      for (let i = memberStart; i < tail; i++) {
        const px = queue[i];
        const cx = px % w;
        const cy = (px - cx) / w;
        compMask[(cy - minY) * maskW + (cx - minX)] = 1;
      }

      components.push({
        minX, minY, maxX, maxY, area,
        mask: compMask, maskW, maskH,
      });
    }
  }
  return components;
}

// Convert a component's pixel mask into a series of axis-aligned bands.
// Each band is a rectangle (yStart..yEnd, xMin..xMax) over rows whose
// x-range is similar within BAND_TOLERANCE_PX. Stacked together they form
// a stair-step polygon that approximates the column shape with straight
// horizontal and vertical edges.
//
// Per-row x-ranges are smoothed by a sliding window so single-line outliers
// (a short line in the middle of a paragraph) don't trigger a new band.
function extractBands(comp, canvasW, canvasH) {
  const rowRanges = new Array(comp.maskH);
  for (let dy = 0; dy < comp.maskH; dy++) {
    let rMin = -1, rMax = -1;
    for (let dx = 0; dx < comp.maskW; dx++) {
      if (comp.mask[dy * comp.maskW + dx]) {
        if (rMin === -1) rMin = dx;
        rMax = dx;
      }
    }
    rowRanges[dy] = rMin === -1 ? null : { min: rMin, max: rMax };
  }

  // Smooth: each row's x-range becomes the union of nearby rows' ranges,
  // so an outlier short line doesn't split a band.
  const smoothed = new Array(comp.maskH);
  for (let dy = 0; dy < comp.maskH; dy++) {
    let sMin = Infinity, sMax = -Infinity;
    const lo = Math.max(0, dy - BAND_SMOOTH_WINDOW);
    const hi = Math.min(comp.maskH - 1, dy + BAND_SMOOTH_WINDOW);
    for (let i = lo; i <= hi; i++) {
      const r = rowRanges[i];
      if (!r) continue;
      if (r.min < sMin) sMin = r.min;
      if (r.max > sMax) sMax = r.max;
    }
    smoothed[dy] = sMin === Infinity ? null : { min: sMin, max: sMax };
  }

  const bands = [];
  let cur = null;
  for (let dy = 0; dy < smoothed.length; dy++) {
    const r = smoothed[dy];
    if (!r) {
      if (cur) { bands.push(cur); cur = null; }
      continue;
    }
    const aMinX = comp.minX + r.min;
    const aMaxX = comp.minX + r.max;
    const ay = comp.minY + dy;

    if (!cur) {
      cur = { yStart: ay, yEnd: ay, xMin: aMinX, xMax: aMaxX };
      continue;
    }

    // New band only when the width changes by more than a sizeable fraction
    // — typical Talmud columns have at most 2-3 distinct widths and the
    // difference between them is substantial (>30%).
    const newWidth = aMaxX - aMinX;
    const curWidth = cur.xMax - cur.xMin;
    const widthRatio = Math.abs(newWidth - curWidth) / Math.max(newWidth, curWidth, 1);

    if (widthRatio < BAND_WIDTH_RATIO) {
      cur.yEnd = ay;
      cur.xMin = Math.min(cur.xMin, aMinX);
      cur.xMax = Math.max(cur.xMax, aMaxX);
    } else {
      bands.push(cur);
      cur = { yStart: ay, yEnd: ay, xMin: aMinX, xMax: aMaxX };
    }
  }
  if (cur) bands.push(cur);

  // Merge thin bands (single-line outliers) into the previous band
  if (bands.length > 1) {
    const totalH = bands[bands.length - 1].yEnd - bands[0].yStart;
    const minH = totalH * MIN_BAND_HEIGHT_RATIO;
    const merged = [];
    for (const b of bands) {
      const h = b.yEnd - b.yStart;
      if (h < minH && merged.length > 0) {
        const prev = merged[merged.length - 1];
        prev.yEnd = Math.max(prev.yEnd, b.yEnd);
        prev.xMin = Math.min(prev.xMin, b.xMin);
        prev.xMax = Math.max(prev.xMax, b.xMax);
      } else {
        merged.push({ ...b });
      }
    }
    bands.length = 0;
    bands.push(...merged);
  }

  // Normalize band coordinates to [0..1] page-relative
  return bands.map(b => ({
    yStart: b.yStart / canvasH,
    yEnd: (b.yEnd + 1) / canvasH,
    xMin: b.xMin / canvasW,
    xMax: (b.xMax + 1) / canvasW,
  }));
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
      _tier: null,
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

function dominantTier(items) {
  if (items.length === 0) return 'reference';
  const counts = { gemara: 0, commentary: 0, reference: 0 };
  for (const item of items) counts[item._tier]++;
  if (counts.gemara >= counts.commentary && counts.gemara >= counts.reference) return 'gemara';
  if (counts.commentary >= counts.reference) return 'commentary';
  return 'reference';
}

function medianFontSize(items) {
  if (items.length === 0) return 0;
  const sizes = items.map(i => i.fontSize).sort((a, b) => a - b);
  return sizes[Math.floor(sizes.length / 2)];
}

// Find the smallest region containing a point given in canvas-relative CSS coords.
// When a region has bands, the point must fall in the band whose y-range contains
// it AND within that band's x-range — so adjacent columns whose bboxes overlap
// don't claim taps that visually belong to the other column.
export function regionAtPoint(regions, px, py, canvasCssW, canvasCssH) {
  const nx = px / canvasCssW;
  const ny = py / canvasCssH;
  let best = null;
  let bestArea = Infinity;
  for (const r of regions) {
    if (nx < r.x || nx > r.x + r.w) continue;
    if (ny < r.y || ny > r.y + r.h) continue;

    if (r.bands && r.bands.length > 0) {
      let inBand = false;
      for (const b of r.bands) {
        if (ny >= b.yStart && ny <= b.yEnd && nx >= b.xMin && nx <= b.xMax) {
          inBand = true;
          break;
        }
      }
      if (!inBand) continue;
    }

    const area = r.w * r.h;
    if (area < bestArea) { best = r; bestArea = area; }
  }
  return best;
}
