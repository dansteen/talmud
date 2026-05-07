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
const DEFAULT_CLOSE_RADIUS        = 0;     // cells, Euclidean (fractional ok)
const DEFAULT_MIN_REGION_FRAC     = 0.0005; // drop components < this fraction of grid area
const DEFAULT_MAX_ISOLATED_RUN    = 25;    // cells: max run length to count as catchword
const DEFAULT_MIN_ISOLATION_GAP   = 10;    // cells: min whitespace on each side
const DEFAULT_MIN_EMPTY_BELOW     = 0;     // cells: min empty rows directly below the run

export function detectRegions(items, pageW, pageH, opts = {}) {
  const cellSize          = opts.cellSize          ?? DEFAULT_CELL_SIZE_PT;
  const closeRadius       = opts.closeRadius       ?? DEFAULT_CLOSE_RADIUS;
  const minRegionFraction = opts.minRegionFraction ?? DEFAULT_MIN_REGION_FRAC;
  const maxIsolatedRun    = opts.maxIsolatedRun    ?? DEFAULT_MAX_ISOLATED_RUN;
  const minIsolationGap   = opts.minIsolationGap   ?? DEFAULT_MIN_ISOLATION_GAP;
  const minEmptyBelow     = opts.minEmptyBelow     ?? DEFAULT_MIN_EMPTY_BELOW;

  const gridW = Math.max(1, Math.ceil(pageW / cellSize));
  const gridH = Math.max(1, Math.ceil(pageH / cellSize));

  let rawGrid = buildOccupancyGrid(items, gridW, gridH, cellSize);

  // Pre-pass: catchwords are short single-word runs that sit in broad
  // horizontal whitespace — short, with whitespace on both sides AND
  // empty rows directly below. Demote them so they can't bridge real
  // regions during the closing pass.
  if (maxIsolatedRun > 0 && minIsolationGap > 0) {
    rawGrid = demoteIsolatedRuns(rawGrid, gridW, gridH, maxIsolatedRun, minIsolationGap, minEmptyBelow);
  }

  // Closing bridges intra-region gaps without reaching across the wider
  // inter-region whitespace. closeRadius is a Euclidean distance in cells
  // and accepts fractional values (1.0, 1.5, 2.0, …).
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
// A catchword is a short single-word run that "dips down into broad
// horizontal whitespace". We test three conditions per run:
//   1. Run length ≤ maxRunLen cells (short — typically one Hebrew word).
//   2. Whitespace on both sides ≥ minGap cells (no in-line neighbours
//      within typical word-spacing distance).
//   3. At least minEmptyBelow consecutive empty rows directly below the
//      run's x-range (broad horizontal whitespace below — the catchword
//      sits at the bottom of its column with empty space underneath
//      before any other text).
//
// Conditions 2 and 3 distinguish the catchword from a normal short
// last-line of a paragraph (which has text immediately above, below, or
// in nearby columns at the same y).

function demoteIsolatedRuns(grid, gridW, gridH, maxRunLen, minGap, minEmptyBelow) {
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
    for (let j = 0; j < runs.length; j++) {
      const r = runs[j];
      if (r.end - r.start > maxRunLen) continue;
      const leftGap  = j > 0               ? r.start - runs[j - 1].end : r.start;
      const rightGap = j < runs.length - 1 ? runs[j + 1].start - r.end : gridW - r.end;
      if (leftGap < minGap || rightGap < minGap) continue;

      // Count consecutive empty rows directly below the run's x-range.
      if (minEmptyBelow > 0) {
        let emptyBelow = 0;
        for (let yy = y + 1; yy < gridH; yy++) {
          let rowEmpty = true;
          const yBase = yy * gridW;
          for (let xx = r.start; xx < r.end; xx++) {
            if (grid[yBase + xx]) { rowEmpty = false; break; }
          }
          if (!rowEmpty) break;
          emptyBelow++;
          if (emptyBelow >= minEmptyBelow) break; // got enough
        }
        if (emptyBelow < minEmptyBelow) continue;
      }

      for (let x = r.start; x < r.end; x++) out[rowBase + x] = 0;
    }
  }
  return out;
}

// ── Morphological dilation / erosion via squared Euclidean distance ──
//
// Built on Felzenszwalb-Huttenlocher's exact O(N) squared-distance
// transform. Dilation = "cells whose distance to the nearest occupied
// cell is ≤ radius"; erosion = the dual operation on the inverted mask.
// Because the test is `d² ≤ r²`, the radius can be any non-negative
// real number — fractional values produce a real change in coverage,
// not just an integer rounding.

function dilate(grid, gridW, gridH, radius) {
  if (radius <= 0) return new Uint8Array(grid);
  const d2 = sedt(grid, gridW, gridH);
  const r2 = radius * radius;
  const out = new Uint8Array(gridW * gridH);
  for (let i = 0; i < d2.length; i++) {
    if (d2[i] <= r2) out[i] = 1;
  }
  return out;
}

function erode(grid, gridW, gridH, radius) {
  if (radius <= 0) return new Uint8Array(grid);
  const inv = new Uint8Array(gridW * gridH);
  for (let i = 0; i < grid.length; i++) inv[i] = grid[i] ? 0 : 1;
  const d2 = sedt(inv, gridW, gridH);
  const r2 = radius * radius;
  const out = new Uint8Array(gridW * gridH);
  for (let i = 0; i < d2.length; i++) {
    if (d2[i] > r2) out[i] = 1;
  }
  return out;
}

// Squared Euclidean distance transform (Felzenszwalb-Huttenlocher 2004).
// For each cell, returns the squared distance to the nearest occupied
// cell. Two passes of the 1-D parabolic-envelope DT — once over rows,
// once over columns — together give the exact 2-D answer in O(N).
function sedt(mask, gridW, gridH) {
  const INF = 1e20;
  const out = new Float64Array(gridW * gridH);
  for (let i = 0; i < out.length; i++) out[i] = mask[i] ? 0 : INF;

  // Row pass: 1-D SEDT along each row, written back into `out`.
  const rowF = new Float64Array(gridW);
  const rowD = new Float64Array(gridW);
  for (let y = 0; y < gridH; y++) {
    const base = y * gridW;
    for (let x = 0; x < gridW; x++) rowF[x] = out[base + x];
    sedt1d(rowF, rowD, gridW);
    for (let x = 0; x < gridW; x++) out[base + x] = rowD[x];
  }

  // Column pass: 1-D SEDT along each column.
  const colF = new Float64Array(gridH);
  const colD = new Float64Array(gridH);
  for (let x = 0; x < gridW; x++) {
    for (let y = 0; y < gridH; y++) colF[y] = out[y * gridW + x];
    sedt1d(colF, colD, gridH);
    for (let y = 0; y < gridH; y++) out[y * gridW + x] = colD[y];
  }

  return out;
}

// 1-D distance transform of an arbitrary sampled function f, computing
// d[q] = min over p of (q - p)² + f[p]. O(n) using the lower-envelope
// of parabolas. (See Felzenszwalb-Huttenlocher 2004 §2.)
function sedt1d(f, d, n) {
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s;
    while (true) {
      const vk = v[k];
      s = ((f[q] + q * q) - (f[vk] + vk * vk)) / (2 * (q - vk));
      if (s > z[k]) break;
      k--;
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dq = q - v[k];
    d[q] = dq * dq + f[v[k]];
  }
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
