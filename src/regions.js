// Region detection from text-item geometry.
//
// Approach:
//   1. Rasterize each text item's bbox onto a low-resolution occupancy grid
//      (≈ 4 PDF points per cell — fine enough to preserve the inter-region
//      whitespace channels, coarse enough to be cheap).
//   2. Morphologically close the grid: dilate then erode by a small radius.
//      Bridges intra-region gaps (line spacing, paragraph breaks) without
//      bridging the wider channels that separate Gemara from Rashi/Tosfos.
//   3. Connected-components label the closed mask. Each component is a
//      candidate region; the actual shape (L's, T's, etc.) is preserved in
//      the labeled grid for hit-testing.
//   4. Drop tiny components (page numbers, isolated glyphs).
//   5. For each surviving region: compute bbox, count items, take median
//      font size from the items whose centers fall inside the region.
//
// Output:
//   {
//     regions: [{ id, bbox, fontSize, itemCount, pixelCount }, …],
//     labels:  Uint16Array(gridW * gridH)  // 0 = background, 1..N = region id
//     gridW, gridH, cellSize  // grid metadata for hit-tests + visualization
//   }

const DEFAULT_CELL_SIZE_PT = 4;        // PDF points per grid cell
const DEFAULT_CLOSE_RADIUS = 1;        // cells; bridges ≤ 2*r*cellSize PDF pt
const DEFAULT_MIN_REGION_FRAC = 0.002; // drop components < 0.2% of grid area
const DEFAULT_NOISE_MIN_CELLS = 5;     // drop raw-grid components < this many cells
const DEFAULT_SINGLE_LINE_MAX_X = 0;   // PDF pt; disabled — see notes below

// Bridging math: a closing of radius `r` cells fills any whitespace channel
// up to `2*r` cells wide. With cellSize=4 and r=1 that's 8 PDF pt — wide
// enough to bridge inter-line gaps (typically 3–5 pt) and intra-region
// paragraph breaks, narrow enough to leave the inter-region channels (5–15
// pt on a Vilna daf) intact. Tunable via ?closeRadius=&cellSize= in the URL.
//
// `noiseMinCells` runs an extra connected-components pass on the *raw* grid
// (before closing) and drops any component smaller than this. Catches stray
// glyphs and other small isolated marks before they can bridge real regions.
//
// `singleLineMaxX` (PDF pt) drops items that are alone on their y-line: no
// other item shares their y-band within this many points horizontally.
// Default 0 (disabled) — the motivating case (catchword between a shorter
// column's main text and a longer column's wrap-around) puts the catchword
// next to wrap-around items at the same y, so the filter doesn't catch it
// AND it accidentally chops legitimate line-end items elsewhere. Kept as
// an option for experimentation.

export function detectRegions(items, pageW, pageH, opts = {}) {
  const cellSize        = opts.cellSize          ?? DEFAULT_CELL_SIZE_PT;
  const closeRadius     = opts.closeRadius       ?? DEFAULT_CLOSE_RADIUS;
  const minFrac         = opts.minRegionFraction ?? DEFAULT_MIN_REGION_FRAC;
  const noiseMinCells   = opts.noiseMinCells     ?? DEFAULT_NOISE_MIN_CELLS;
  const singleLineMaxX  = opts.singleLineMaxX    ?? DEFAULT_SINGLE_LINE_MAX_X;

  const gridW = Math.max(1, Math.ceil(pageW / cellSize));
  const gridH = Math.max(1, Math.ceil(pageH / cellSize));

  // Drop catchwords and other "alone on their y-line" items before they can
  // contribute to the occupancy grid and bridge real regions during closing.
  const filteredItems = singleLineMaxX > 0
    ? filterSingleItemLines(items, singleLineMaxX)
    : items;

  let grid = buildOccupancyGrid(filteredItems, gridW, gridH, cellSize);
  // Pre-closing noise filter: drop tiny isolated components (catchwords,
  // page numbers, stray glyphs) on the raw grid before they can bridge to
  // anything during the closing step.
  if (noiseMinCells > 0) {
    grid = removeTinyComponents(grid, gridW, gridH, noiseMinCells);
  }
  // Closing = dilate then erode. Bridges within-region gaps; preserves
  // between-region channels wider than `closeRadius`.
  grid = dilate(grid, gridW, gridH, closeRadius);
  grid = erode (grid, gridW, gridH, closeRadius);

  const { labels, count } = connectedComponents(grid, gridW, gridH);
  let regions = computeRegionStats(labels, gridW, gridH, cellSize, filteredItems, count);

  const minCells = Math.max(8, Math.round(minFrac * gridW * gridH));
  regions = filterAndRelabel(regions, labels, minCells);

  return { regions, labels, gridW, gridH, cellSize };
}

// Drop items that are alone on their y-line within a horizontal radius.
// "Alone on their line" means: no other item has overlapping y-center
// (within half the smaller item's height) AND a horizontal-center distance
// of at most `maxX` PDF points. The threshold is calibrated so neighbors in
// the same column count, but neighbors in *other* columns (separated by a
// wide channel) don't — so a single-word catchword at the bottom of one
// column gets dropped even if the longer adjacent column happens to have
// text at the same y.
function filterSingleItemLines(items, maxX) {
  const n = items.length;
  if (n < 2) return items.slice();
  // Sort by y-center so we can prune the inner loop with a simple range
  // check. O(n²) worst case, near O(n*k) in practice for small k.
  const yc = new Float32Array(n);
  const xc = new Float32Array(n);
  const halfH = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const it = items[i];
    yc[i] = it.y + it.h / 2;
    xc[i] = it.x + it.w / 2;
    halfH[i] = it.h / 2;
  }
  const order = new Int32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  order.sort((a, b) => yc[a] - yc[b]);
  // Map original index → position in sorted order, so we can scan neighbors
  // in y-order without re-sorting.
  const pos = new Int32Array(n);
  for (let p = 0; p < n; p++) pos[order[p]] = p;

  const keep = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const ay = yc[i], ax = xc[i], ah = halfH[i];
    const p = pos[i];
    // Walk outward in y-sorted order until we leave the y-window.
    for (let dir = -1; dir <= 1; dir += 2) {
      let q = p + dir;
      while (q >= 0 && q < n) {
        const j = order[q];
        if (j !== i) {
          const dy = Math.abs(yc[j] - ay);
          const lim = Math.min(ah, halfH[j]);
          if (dy > lim) break; // sorted by y, so further neighbors are even farther
          if (Math.abs(xc[j] - ax) <= maxX) {
            keep[i] = 1;
            break;
          }
        }
        q += dir;
      }
      if (keep[i]) break;
    }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(items[i]);
  return out;
}

// ── Occupancy grid ──

function buildOccupancyGrid(items, gridW, gridH, cellSize) {
  const grid = new Uint8Array(gridW * gridH);
  for (const it of items) {
    const x0 = Math.max(0,     Math.floor(it.x / cellSize));
    const y0 = Math.max(0,     Math.floor(it.y / cellSize));
    const x1 = Math.min(gridW, Math.ceil((it.x + it.w) / cellSize));
    const y1 = Math.min(gridH, Math.ceil((it.y + it.h) / cellSize));
    for (let y = y0; y < y1; y++) {
      const row = y * gridW;
      for (let x = x0; x < x1; x++) grid[row + x] = 1;
    }
  }
  return grid;
}

// ── Morphological dilation / erosion (separable, square kernel) ──

function dilate(grid, gridW, gridH, radius) {
  // Horizontal pass: cell becomes 1 if any neighbor within `radius` cols is 1.
  const tmp = new Uint8Array(gridW * gridH);
  for (let y = 0; y < gridH; y++) {
    const row = y * gridW;
    for (let x = 0; x < gridW; x++) {
      const x0 = x - radius < 0 ? 0 : x - radius;
      const x1 = x + radius >= gridW ? gridW - 1 : x + radius;
      let v = 0;
      for (let xx = x0; xx <= x1; xx++) {
        if (grid[row + xx]) { v = 1; break; }
      }
      tmp[row + x] = v;
    }
  }
  // Vertical pass on tmp → out.
  const out = new Uint8Array(gridW * gridH);
  for (let x = 0; x < gridW; x++) {
    for (let y = 0; y < gridH; y++) {
      const y0 = y - radius < 0 ? 0 : y - radius;
      const y1 = y + radius >= gridH ? gridH - 1 : y + radius;
      let v = 0;
      for (let yy = y0; yy <= y1; yy++) {
        if (tmp[yy * gridW + x]) { v = 1; break; }
      }
      out[y * gridW + x] = v;
    }
  }
  return out;
}

function erode(grid, gridW, gridH, radius) {
  const tmp = new Uint8Array(gridW * gridH);
  for (let y = 0; y < gridH; y++) {
    const row = y * gridW;
    for (let x = 0; x < gridW; x++) {
      const x0 = x - radius < 0 ? 0 : x - radius;
      const x1 = x + radius >= gridW ? gridW - 1 : x + radius;
      let v = 1;
      for (let xx = x0; xx <= x1; xx++) {
        if (!grid[row + xx]) { v = 0; break; }
      }
      tmp[row + x] = v;
    }
  }
  const out = new Uint8Array(gridW * gridH);
  for (let x = 0; x < gridW; x++) {
    for (let y = 0; y < gridH; y++) {
      const y0 = y - radius < 0 ? 0 : y - radius;
      const y1 = y + radius >= gridH ? gridH - 1 : y + radius;
      let v = 1;
      for (let yy = y0; yy <= y1; yy++) {
        if (!tmp[yy * gridW + x]) { v = 0; break; }
      }
      out[y * gridW + x] = v;
    }
  }
  return out;
}

// ── Connected components (4-neighbor flood fill) ──
//
// Uint32 labels because raw-grid CC (used by the noise filter) can produce
// thousands of components — every word/line fragment before closing — and
// Uint16 (max 65535) is uncomfortably close to that ceiling on dense pages.

function connectedComponents(mask, gridW, gridH) {
  const labels = new Uint32Array(gridW * gridH);
  let next = 1;
  const stack = []; // reused across components

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

// Drop connected components smaller than `minCells` from the binary grid.
// Used as a pre-closing noise filter so isolated stray text (catchwords,
// page numbers, single glyphs) can't bridge into adjacent regions.
function removeTinyComponents(grid, gridW, gridH, minCells) {
  const { labels, count } = connectedComponents(grid, gridW, gridH);
  const sizes = new Uint32Array(count + 1);
  for (let i = 0; i < grid.length; i++) {
    const lbl = labels[i];
    if (lbl !== 0) sizes[lbl]++;
  }
  const out = new Uint8Array(gridW * gridH);
  for (let i = 0; i < grid.length; i++) {
    const lbl = labels[i];
    if (lbl !== 0 && sizes[lbl] >= minCells) out[i] = 1;
  }
  return out;
}

// ── Per-region statistics ──

function computeRegionStats(labels, gridW, gridH, cellSize, items, count) {
  // Slot 0 unused (background).
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

  // Bbox + pixel count from the labeled grid.
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

  // Font-size + item count from the underlying text items, attributed to
  // whichever region their *center* falls in.
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
