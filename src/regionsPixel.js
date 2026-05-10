// Pixel-based region detection.
//
// Render the PDF page to an offscreen canvas at scale 1 (1 PDF point = 1 px),
// binarize the bitmap, downsample into our usual cell grid, and run 4-neighbor
// connected components. The bitmap sees everything text bboxes miss: actual
// rendered glyph extents (so the wide bridge text items go away), printed
// rule lines, decorative borders, and any other graphics. The whitespace
// around section separators creates real empty cells in the grid, which
// 4-neighbor CC naturally treats as a barrier — no font logic, no auto-tuner.
//
// Closing is intentionally light (a small Y radius, just enough to bridge
// inter-line glyph gaps) so we don't accidentally bridge across the
// whitespace margins around printed rule lines.

// ── Pixel-grid construction ─────────────────────────────────────────────

// Render the page to an offscreen canvas at scale 1 (1 px = 1 PDF point) and
// build an occupancy grid: a cell is occupied if any pixel in its area is
// dark enough. Returns the grid plus geometry. Caller uses textItems to
// label regions with font-size and item-count after CC.
export async function buildPixelGridFromPdfPage(pdfPage, cellSize = 1.5) {
  const viewport = pdfPage.getViewport({ scale: 1 });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d');
  // PDF.js renders on transparent — fill white so unrendered area is clean
  // background, not transparent black.
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await pdfPage.render({ canvasContext: ctx, viewport }).promise;

  const imgW = canvas.width;
  const imgH = canvas.height;
  const pixels = ctx.getImageData(0, 0, imgW, imgH).data;

  const gridW = Math.max(1, Math.ceil(imgW / cellSize));
  const gridH = Math.max(1, Math.ceil(imgH / cellSize));
  const grid = new Uint8Array(gridW * gridH);

  // Threshold tuned for printed talmud pages: anything with luminance below
  // 200 (out of 255) counts as ink. The pages are pure black-on-white so
  // anything in between is a partially-rendered glyph edge — still ink.
  const threshold = 200;

  for (let cy = 0; cy < gridH; cy++) {
    const y0 = Math.floor(cy * cellSize);
    const y1 = Math.min(imgH, Math.ceil((cy + 1) * cellSize));
    for (let cx = 0; cx < gridW; cx++) {
      const x0 = Math.floor(cx * cellSize);
      const x1 = Math.min(imgW, Math.ceil((cx + 1) * cellSize));
      let occupied = false;
      outer: for (let y = y0; y < y1; y++) {
        const rowBase = y * imgW * 4;
        for (let x = x0; x < x1; x++) {
          const i = rowBase + x * 4;
          // Use max(R,G,B) as a luminance proxy: any dark channel = ink.
          const lum = Math.max(pixels[i], pixels[i + 1], pixels[i + 2]);
          if (lum < threshold) {
            occupied = true;
            break outer;
          }
        }
      }
      if (occupied) grid[cy * gridW + cx] = 1;
    }
  }

  return {
    grid,
    gridW,
    gridH,
    cellSize,
    pageW: viewport.width,
    pageH: viewport.height,
  };
}

// ── Horizontal gutter detection ─────────────────────────────────────────
//
// Find horizontal bands where the page is empty. A row counts as "empty"
// even if a single word dips down into it — we tolerate up to a small
// fraction of the row being occupied. A band of consecutive empty rows
// becomes a gutter only if it's at least `minThickness` cells tall, so
// thin inter-line gaps inside a paragraph don't count.
//
// Returns: array of { y0, y1 } in cell coordinates (half-open).

export function detectHorizontalGutters(grid, gridW, gridH, opts = {}) {
  const minThickness = opts.minThickness ?? 4;
  // A row is "empty enough" if at most this fraction of its cells is
  // occupied. ~5% ≈ one word's worth of glyphs at typical Hebrew font
  // sizes, which lets a single word dip down without disqualifying the
  // band as a gutter.
  const sparsityFrac = opts.sparsityFrac ?? 0.05;
  const sparseMax = Math.floor(gridW * sparsityFrac);

  // Per-row occupancy count.
  const rowOcc = new Uint16Array(gridH);
  for (let y = 0; y < gridH; y++) {
    let count = 0;
    const base = y * gridW;
    for (let x = 0; x < gridW; x++) {
      if (grid[base + x]) count++;
    }
    rowOcc[y] = count;
  }

  const gutters = [];
  let inBand = false;
  let bandStart = 0;
  for (let y = 0; y < gridH; y++) {
    const empty = rowOcc[y] <= sparseMax;
    if (empty && !inBand) {
      inBand = true;
      bandStart = y;
    } else if (!empty && inBand) {
      const thickness = y - bandStart;
      if (thickness >= minThickness) gutters.push({ y0: bandStart, y1: y });
      inBand = false;
    }
  }
  if (inBand) {
    const thickness = gridH - bandStart;
    if (thickness >= minThickness) gutters.push({ y0: bandStart, y1: gridH });
  }
  return gutters;
}

// ── Region detection on a pre-built occupancy grid ──────────────────────

export function detectRegionsFromGrid(rawGrid, gridW, gridH, cellSize, textItems, opts = {}) {
  const closeRadiusY      = opts.closeRadiusY      ?? 2;
  // Side bands need a larger Y radius: small side-meforshim fonts have wider
  // inter-line gaps than block-letter gemara. Falls back to closeRadiusY if
  // not specified.
  const closeRadiusYSide  = opts.closeRadiusYSide  ?? closeRadiusY;
  const sideZoneFraction  = opts.sideZoneFraction  ?? 0.13;
  const minRegionFraction = opts.minRegionFraction ?? 0.0005;

  // Per-x closing radius: the leftmost/rightmost sideZoneFraction of the
  // grid uses closeRadiusYSide; everywhere else uses closeRadiusY.
  const edgeBand = Math.round(sideZoneFraction * gridW);
  const ryAt = (closeRadiusYSide === closeRadiusY)
    ? closeRadiusY
    : (x) => (x < edgeBand || x >= gridW - edgeBand) ? closeRadiusYSide : closeRadiusY;

  let workGrid = rawGrid;
  const anyClose = closeRadiusY > 0 || closeRadiusYSide > 0;
  if (anyClose) {
    workGrid = vertDilate(workGrid, gridW, gridH, ryAt);
    workGrid = vertErode (workGrid, gridW, gridH, ryAt);
  }

  const { labels, count } = connectedComponents(workGrid, gridW, gridH);
  let regions = computeRegionStats(labels, gridW, gridH, cellSize, textItems, count);

  const minCells = Math.max(8, Math.round(minRegionFraction * gridW * gridH));
  regions = filterAndRelabel(regions, labels, minCells);

  return { regions, labels, grid: rawGrid, gridW, gridH, cellSize };
}

// ── Morphological operations (Y-direction only) ─────────────────────────

// `radius` may be a number (uniform) or a function (x) → number for per-x
// radius. The latter lets us close more aggressively in the side bands.
function vertDilate(grid, gridW, gridH, radius) {
  const out = new Uint8Array(gridW * gridH);
  for (let x = 0; x < gridW; x++) {
    const r = typeof radius === 'function' ? radius(x) : radius;
    if (r <= 0) {
      for (let y = 0; y < gridH; y++) {
        if (grid[y * gridW + x]) out[y * gridW + x] = 1;
      }
      continue;
    }
    for (let y = 0; y < gridH; y++) {
      let any = false;
      for (let dy = -r; dy <= r; dy++) {
        const yy = y + dy;
        if (yy >= 0 && yy < gridH && grid[yy * gridW + x]) {
          any = true;
          break;
        }
      }
      if (any) out[y * gridW + x] = 1;
    }
  }
  return out;
}

function vertErode(grid, gridW, gridH, radius) {
  const out = new Uint8Array(gridW * gridH);
  for (let x = 0; x < gridW; x++) {
    const r = typeof radius === 'function' ? radius(x) : radius;
    if (r <= 0) {
      for (let y = 0; y < gridH; y++) {
        if (grid[y * gridW + x]) out[y * gridW + x] = 1;
      }
      continue;
    }
    for (let y = 0; y < gridH; y++) {
      let all = true;
      for (let dy = -r; dy <= r; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= gridH || !grid[yy * gridW + x]) {
          all = false;
          break;
        }
      }
      if (all) out[y * gridW + x] = 1;
    }
  }
  return out;
}

// ── Connected components (4-neighbor flood fill) ────────────────────────

function connectedComponents(mask, gridW, gridH) {
  const labels = new Uint32Array(gridW * gridH);
  let next = 1;
  const stack = [];

  for (let y = 0; y < gridH; y++) {
    for (let x = 0; x < gridW; x++) {
      const seed = y * gridW + x;
      if (mask[seed] !== 1 || labels[seed] !== 0) continue;
      stack.length = 0;
      stack.push(seed);
      while (stack.length) {
        const i = stack.pop();
        if (labels[i] !== 0 || mask[i] !== 1) continue;
        labels[i] = next;
        const cx = i % gridW;
        const cy = (i - cx) / gridW;
        if (cx > 0)         stack.push(i - 1);
        if (cx < gridW - 1) stack.push(i + 1);
        if (cy > 0)         stack.push(i - gridW);
        if (cy < gridH - 1) stack.push(i + gridW);
      }
      next++;
    }
  }
  return { labels, count: next - 1 };
}

// ── Per-region statistics ───────────────────────────────────────────────

function computeRegionStats(labels, gridW, gridH, cellSize, items, count) {
  const stats = new Array(count + 1);
  for (let i = 1; i <= count; i++) {
    stats[i] = {
      id: i,
      pixelCount: 0,
      xMin: Infinity, yMin: Infinity, xMax: -Infinity, yMax: -Infinity,
      fontSizes: [],
      itemCount: 0,
    };
  }
  for (let y = 0; y < gridH; y++) {
    const row = y * gridW;
    for (let x = 0; x < gridW; x++) {
      const lbl = labels[row + x];
      if (lbl === 0) continue;
      const s = stats[lbl];
      s.pixelCount++;
      const px = x * cellSize, py = y * cellSize;
      if (px < s.xMin) s.xMin = px;
      if (py < s.yMin) s.yMin = py;
      if (px + cellSize > s.xMax) s.xMax = px + cellSize;
      if (py + cellSize > s.yMax) s.yMax = py + cellSize;
    }
  }
  // textItems contribute fontSize + itemCount labels for each region. The
  // region SHAPES come from pixel CC; items just attach metadata.
  if (items) {
    for (const it of items) {
      const cx = Math.floor((it.x + it.w / 2) / cellSize);
      const cy = Math.floor((it.y + it.h / 2) / cellSize);
      if (cx < 0 || cy < 0 || cx >= gridW || cy >= gridH) continue;
      const lbl = labels[cy * gridW + cx];
      if (lbl === 0) continue;
      const s = stats[lbl];
      s.fontSizes.push(it.fontSize);
      s.itemCount++;
    }
  }
  const out = [];
  for (let i = 1; i <= count; i++) {
    const s = stats[i];
    if (!s || s.pixelCount === 0) continue;
    const fs = s.fontSizes.slice().sort((a, b) => a - b);
    const median = fs.length > 0 ? fs[fs.length >> 1] : 0;
    out.push({
      id: s.id,
      bbox: { x: s.xMin, y: s.yMin, w: s.xMax - s.xMin, h: s.yMax - s.yMin },
      pixelCount: s.pixelCount,
      itemCount: s.itemCount,
      fontSize: median,
    });
  }
  return out;
}

// Drop regions below the size threshold and renumber survivors so IDs are
// dense (1..N), updating the labels grid in place.
function filterAndRelabel(regions, labels, minCells) {
  const surviving = regions.filter(r => r.pixelCount >= minCells);
  const remap = new Map();
  surviving.forEach((r, i) => {
    remap.set(r.id, i + 1);
    r.id = i + 1;
  });
  for (let i = 0; i < labels.length; i++) {
    const old = labels[i];
    if (old !== 0) labels[i] = remap.get(old) ?? 0;
  }
  return surviving;
}
