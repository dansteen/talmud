// Region detection by connected components on a closed text-occupancy mask.
//
// No assumptions about column structure, page-spanning channels, or any
// particular layout. Each region is whatever shape the whitespace defines
// locally.
//
// Pipeline:
//   1. Rasterize text-item bboxes onto a low-resolution occupancy grid
//      (≈ 2 PDF points per cell).
//   2. Morphologically close (dilate then erode by `closeRadius`) to bridge
//      gaps narrower than the closing width. Picks up inter-line gaps and
//      word gaps within a region; doesn't reach across the wider whitespace
//      between regions.
//   3. 4-neighbor connected-components label the closed mask. Each
//      component is a region — any shape, any topology.
//   4. Drop tiny components (page numbers, isolated marks).
//   5. For each surviving region: bbox, item count, median fontSize.
//
// Output:
//   {
//     regions: [{ id, bbox, fontSize, itemCount, pixelCount }, …],
//     labels:  Uint32Array(gridW * gridH)  // 0 = background, 1..N = region id
//     grid:    Uint8Array(gridW * gridH)   // raw text occupancy (visualization)
//     gridW, gridH, cellSize
//   }

const DEFAULT_CELL_SIZE_PT        = 2;     // PDF points per grid cell
const DEFAULT_CLOSE_RADIUS        = 1;     // cells; bridges ≤ 2*r*cellSize PDF pt
const DEFAULT_MIN_REGION_FRAC     = 0.002; // drop components < 0.2% of grid area
const DEFAULT_MAX_ISOLATED_RUN    = 25;    // cells: max run length to count as catchword
const DEFAULT_MIN_ISOLATION_GAP   = 10;    // cells: min whitespace on each side

export function detectRegions(items, pageW, pageH, opts = {}) {
  const cellSize          = opts.cellSize          ?? DEFAULT_CELL_SIZE_PT;
  const closeRadius       = opts.closeRadius       ?? DEFAULT_CLOSE_RADIUS;
  const minRegionFraction = opts.minRegionFraction ?? DEFAULT_MIN_REGION_FRAC;
  const maxIsolatedRun    = opts.maxIsolatedRun    ?? DEFAULT_MAX_ISOLATED_RUN;
  const minIsolationGap   = opts.minIsolationGap   ?? DEFAULT_MIN_ISOLATION_GAP;

  const gridW = Math.max(1, Math.ceil(pageW / cellSize));
  const gridH = Math.max(1, Math.ceil(pageH / cellSize));

  let rawGrid = buildOccupancyGrid(items, gridW, gridH, cellSize);

  // Pre-pass: if a short run of occupied cells in a row has substantial
  // whitespace on both sides, it's almost certainly a catchword (the
  // next-page word printed alone at the bottom of a column). Demote those
  // cells to whitespace before they can bridge real regions during closing.
  if (maxIsolatedRun > 0 && minIsolationGap > 0) {
    rawGrid = demoteIsolatedRuns(rawGrid, gridW, gridH, maxIsolatedRun, minIsolationGap);
  }

  // Closing bridges intra-region gaps without reaching across the wider
  // inter-region whitespace. The result is what we connected-components on.
  let workGrid = rawGrid;
  if (closeRadius > 0) {
    workGrid = dilate(rawGrid, gridW, gridH, closeRadius);
    workGrid = erode (workGrid, gridW, gridH, closeRadius);
  }

  const { labels, count } = connectedComponents(workGrid, gridW, gridH);
  let regions = computeRegionStats(labels, gridW, gridH, cellSize, items, count);

  const minCells = Math.max(8, Math.round(minRegionFraction * gridW * gridH));
  regions = filterAndRelabel(regions, labels, minCells);

  // Visualization paints `rawGrid` cells (so the colored fill follows the
  // actual text shape, not the dilated mask).
  return { regions, labels, grid: rawGrid, gridW, gridH, cellSize };
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

// ── Pre-pass: demote isolated short runs (catchword filter) ──
//
// For every row, find runs of occupied cells. A run that's short
// (≤ maxRunLen cells) AND surrounded by whitespace of at least `minGap`
// cells on both sides is almost certainly a catchword sitting alone on
// its line — demote it to whitespace so it can't act as a bridge between
// real regions during the closing pass.
//
// "Whitespace on both sides" matches the user's description of what
// catchwords look like: a single short word with the rest of the row
// empty around it. Normal in-line words have neighbouring text within
// a couple of cells, so they don't trigger this filter.

function demoteIsolatedRuns(grid, gridW, gridH, maxRunLen, minGap) {
  const out = new Uint8Array(grid);
  for (let y = 0; y < gridH; y++) {
    const rowBase = y * gridW;
    // Find runs of occupied cells in this row.
    const runs = [];
    let i = 0;
    while (i < gridW) {
      if (grid[rowBase + i]) {
        const start = i;
        while (i < gridW && grid[rowBase + i]) i++;
        runs.push({ start, end: i }); // half-open: [start, end)
      } else {
        i++;
      }
    }
    // Demote any short run with substantial gap on both sides.
    for (let j = 0; j < runs.length; j++) {
      const r = runs[j];
      if (r.end - r.start > maxRunLen) continue;
      const leftGap  = j > 0                  ? r.start - runs[j - 1].end : r.start;
      const rightGap = j < runs.length - 1    ? runs[j + 1].start - r.end : gridW - r.end;
      if (leftGap >= minGap && rightGap >= minGap) {
        for (let x = r.start; x < r.end; x++) out[rowBase + x] = 0;
      }
    }
  }
  return out;
}

// ── Morphological dilation / erosion (separable, square kernel) ──

function dilate(grid, gridW, gridH, radius) {
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

// ── Per-region statistics ──

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
