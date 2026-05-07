// Region detection by connected components on a closed text-occupancy mask.
//
// No assumptions about column structure, page-spanning channels, or any
// particular layout. Each region is whatever shape the whitespace defines
// locally.
//
// Pipeline:
//   1. Rasterize text-item bboxes onto a low-resolution occupancy grid
//      (≈ 2 PDF points per cell).
//   2. Morphologically close (dilate then erode) with a separable
//      rectangular kernel of size (2·closeRadiusX+1) × (2·closeRadiusY+1)
//      to bridge gaps narrower than the kernel. Independent X/Y radii so
//      we can reach across line gaps (Y) without bridging adjacent
//      columns (X).
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
const DEFAULT_CLOSE_RADIUS_X      = 0;     // cells: horizontal closing radius
const DEFAULT_CLOSE_RADIUS_Y      = 0;     // cells: vertical closing radius
const DEFAULT_MIN_REGION_FRAC     = 0.0005; // drop components < this fraction of grid area
const DEFAULT_MAX_ISOLATED_RUN    = 25;    // cells: max run length to count as catchword
const DEFAULT_MIN_ISOLATION_GAP   = 10;    // cells: min whitespace on each side
const DEFAULT_MIN_EMPTY_BELOW     = 0;     // cells: min empty rows directly below the run
const DEFAULT_HEADER_SPLIT_RATIO  = 1.4;   // ≤1 disables; otherwise items at ≥ratio×region-median are headers

export function detectRegions(items, pageW, pageH, opts = {}) {
  const cellSize          = opts.cellSize          ?? DEFAULT_CELL_SIZE_PT;
  const closeRadiusX      = Math.round(opts.closeRadiusX ?? DEFAULT_CLOSE_RADIUS_X);
  const closeRadiusY      = Math.round(opts.closeRadiusY ?? DEFAULT_CLOSE_RADIUS_Y);
  const minRegionFraction = opts.minRegionFraction ?? DEFAULT_MIN_REGION_FRAC;
  const maxIsolatedRun    = opts.maxIsolatedRun    ?? DEFAULT_MAX_ISOLATED_RUN;
  const minIsolationGap   = opts.minIsolationGap   ?? DEFAULT_MIN_ISOLATION_GAP;
  const minEmptyBelow     = opts.minEmptyBelow     ?? DEFAULT_MIN_EMPTY_BELOW;
  const headerSplitRatio  = opts.headerSplitRatio  ?? DEFAULT_HEADER_SPLIT_RATIO;

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

  // Closing with a separable rectangular kernel. closeRadiusY > closeRadiusX
  // bridges inter-line gaps within a column without bridging the wider
  // whitespace between columns.
  let workGrid = rawGrid;
  if (closeRadiusX > 0 || closeRadiusY > 0) {
    workGrid = dilateRect(rawGrid, gridW, gridH, closeRadiusX, closeRadiusY);
    workGrid = erodeRect (workGrid, gridW, gridH, closeRadiusX, closeRadiusY);
  }

  const { labels, count } = connectedComponents(workGrid, gridW, gridH);
  let regions = computeRegionStats(labels, gridW, gridH, cellSize, items, count);

  const minCells = Math.max(8, Math.round(minRegionFraction * gridW * gridH));
  regions = filterAndRelabel(regions, labels, minCells);

  // Post-pass: split regions that contain ≥2 outsized headers (much larger
  // font than the region's median). Targets the side meforshim columns,
  // where each meforesh starts with a name in big type.
  if (headerSplitRatio > 1) {
    regions = splitRegionsByHeaders(regions, labels, gridW, gridH, cellSize, items, headerSplitRatio);
    regions = filterAndRelabel(regions, labels, 0);
  }

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

// ── Morphological dilation / erosion: separable rectangular kernel ──
//
// Closing with kernel size (2·rx+1) × (2·ry+1). The horizontal and vertical
// passes are independent, so we get full anisotropy "for free" — useful
// because line-spacing gaps run vertically while column gaps run
// horizontally. Boundary cells use a truncated window (out-of-bounds cells
// are ignored), which slightly under-erodes near the page edge but text in
// our PDFs sits well inside the margins.

function dilateRect(grid, gridW, gridH, rx, ry) {
  let src = grid;
  if (rx > 0) {
    const out = new Uint8Array(gridW * gridH);
    for (let y = 0; y < gridH; y++) {
      const base = y * gridW;
      for (let x = 0; x < gridW; x++) {
        const x0 = Math.max(0, x - rx);
        const x1 = Math.min(gridW - 1, x + rx);
        for (let nx = x0; nx <= x1; nx++) {
          if (src[base + nx]) { out[base + x] = 1; break; }
        }
      }
    }
    src = out;
  }
  if (ry > 0) {
    const out = new Uint8Array(gridW * gridH);
    for (let x = 0; x < gridW; x++) {
      for (let y = 0; y < gridH; y++) {
        const y0 = Math.max(0, y - ry);
        const y1 = Math.min(gridH - 1, y + ry);
        for (let ny = y0; ny <= y1; ny++) {
          if (src[ny * gridW + x]) { out[y * gridW + x] = 1; break; }
        }
      }
    }
    src = out;
  }
  return src === grid ? new Uint8Array(grid) : src;
}

function erodeRect(grid, gridW, gridH, rx, ry) {
  let src = grid;
  if (rx > 0) {
    const out = new Uint8Array(gridW * gridH);
    for (let y = 0; y < gridH; y++) {
      const base = y * gridW;
      for (let x = 0; x < gridW; x++) {
        const x0 = Math.max(0, x - rx);
        const x1 = Math.min(gridW - 1, x + rx);
        let allOn = 1;
        for (let nx = x0; nx <= x1; nx++) {
          if (!src[base + nx]) { allOn = 0; break; }
        }
        out[base + x] = allOn;
      }
    }
    src = out;
  }
  if (ry > 0) {
    const out = new Uint8Array(gridW * gridH);
    for (let x = 0; x < gridW; x++) {
      for (let y = 0; y < gridH; y++) {
        const y0 = Math.max(0, y - ry);
        const y1 = Math.min(gridH - 1, y + ry);
        let allOn = 1;
        for (let ny = y0; ny <= y1; ny++) {
          if (!src[ny * gridW + x]) { allOn = 0; break; }
        }
        out[y * gridW + x] = allOn;
      }
    }
    src = out;
  }
  return src === grid ? new Uint8Array(grid) : src;
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

// ── Header-split post-pass ──
//
// Side-meforshim columns are detected as a single tall region by CC, but they
// internally consist of N independent commentaries each introduced by a
// large-font header (the מפרש's name). We split such regions horizontally
// at each header.
//
// We work in *rows*, not individual items: cluster a region's items into
// text lines by y-proximity, take each line's median fontSize, then
// compare against the region's body median (the median of all line
// medians). A "header row" is a line whose median fontSize is
// ≥ ratio × body. This way a single oversized item embedded in a
// normal-size line (e.g. an enlarged initial letter or a stray glyph)
// can't trigger a split — it gets outvoted by the rest of its row.
// A region is split only if it has ≥2 header rows; the first header
// stays with the existing region, each subsequent one opens a new
// sub-region whose top is that header row's top edge.

function splitRegionsByHeaders(regions, labels, gridW, gridH, cellSize, items, ratio) {
  const byRegion = new Map();
  for (const it of items) {
    const cx = Math.floor((it.x + it.w / 2) / cellSize);
    const cy = Math.floor((it.y + it.h / 2) / cellSize);
    if (cx < 0 || cy < 0 || cx >= gridW || cy >= gridH) continue;
    const lbl = labels[cy * gridW + cx];
    if (lbl === 0) continue;
    let arr = byRegion.get(lbl);
    if (!arr) { arr = []; byRegion.set(lbl, arr); }
    arr.push(it);
  }

  let nextId = regions.reduce((m, r) => Math.max(m, r.id), 0) + 1;
  const splitMap = new Map();   // oldId → { rows: number[], ids: number[] }

  for (const r of regions) {
    const its = byRegion.get(r.id);
    if (!its || its.length < 2) continue;

    const lines = clusterIntoLines(its);
    if (lines.length < 2) continue;

    const lineSizes = lines.map(line => median(line.map(it => it.fontSize)));
    const body = median(lineSizes);
    if (!body) continue;

    const threshold = ratio * body;
    const headerIdxs = [];
    for (let i = 0; i < lineSizes.length; i++) {
      if (lineSizes[i] >= threshold) headerIdxs.push(i);
    }
    if (headerIdxs.length < 2) continue;

    // Skip the first header — section 0 starts at the region top.
    // Subsequent header rows define split lines at their top y, snapped
    // to grid rows so a header lands cleanly in its own section.
    const rows = headerIdxs.slice(1).map(i => {
      const lineTop = Math.min(...lines[i].map(it => it.y));
      return Math.floor(lineTop / cellSize);
    });
    const ids = [r.id];
    for (let i = 0; i < rows.length; i++) ids.push(nextId++);
    splitMap.set(r.id, { rows, ids });
  }

  if (splitMap.size === 0) return regions;

  for (let y = 0; y < gridH; y++) {
    const row = y * gridW;
    for (let x = 0; x < gridW; x++) {
      const lbl = labels[row + x];
      if (lbl === 0) continue;
      const split = splitMap.get(lbl);
      if (!split) continue;
      let section = 0;
      for (let i = 0; i < split.rows.length; i++) {
        if (y >= split.rows[i]) section = i + 1;
      }
      labels[row + x] = split.ids[section];
    }
  }

  return computeRegionStats(labels, gridW, gridH, cellSize, items, nextId - 1);
}

// Group items into text lines by vertical proximity. Two consecutive
// items (sorted by vertical center) belong to the same line if the gap
// between their centers is less than half the smaller item's height.
function clusterIntoLines(items) {
  if (items.length === 0) return [];
  const sorted = items.slice().sort((a, b) => (a.y + a.h / 2) - (b.y + b.h / 2));
  const lines = [[sorted[0]]];
  for (let i = 1; i < sorted.length; i++) {
    const it = sorted[i];
    const cur = lines[lines.length - 1];
    const prev = cur[cur.length - 1];
    const itC = it.y + it.h / 2;
    const prevC = prev.y + prev.h / 2;
    const threshold = Math.min(it.h, prev.h) * 0.5;
    if (itC - prevC < threshold) cur.push(it);
    else lines.push([it]);
  }
  return lines;
}

function median(arr) {
  if (arr.length === 0) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  return s[s.length >> 1];
}
