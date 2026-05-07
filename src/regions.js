// Region detection by recursive whitespace-channel decomposition (X-Y cut).
//
// Approach: rasterize text-item bboxes onto an occupancy grid. Then split
// the page recursively — at each level, find candidate channels on both
// axes (rows that are ≥ 90 % whitespace, and columns that are ≥ 90 %
// whitespace within the current sub-region) and apply the axis with the
// most cuts. Continue recursing on each resulting sub-rectangle until no
// channels are found on either axis.
//
// Two thresholds:
//   - `channelDensity`: a row/column counts as whitespace if its occupied
//     fraction is at most this value (default 0.10 → ≥ 90 % whitespace).
//   - `channelMinThickness`: how many consecutive whitespace rows/cols are
//     needed to count as a real channel (default 3 cells). Filters out
//     individual inter-line gaps that happen to be sparse.
//
// Densities are recomputed *within the sub-region* at each recursion level
// — a horizontal channel that spans Rashi's column but not Gemara's gets
// detected once we've already cut down to Rashi (because the density
// numerator no longer includes Gemara's text).
//
// Output:
//   {
//     regions: [{ id, bbox, fontSize, itemCount, pixelCount }, …],
//     labels:  Uint32Array(gridW * gridH)  // 0 = whitespace, 1..N = region id
//     grid:    Uint8Array(gridW * gridH)   // raw occupancy (for visualization)
//     gridW, gridH, cellSize
//   }

const DEFAULT_CELL_SIZE_PT          = 4;
const DEFAULT_CHANNEL_DENSITY       = 0.10;  // ≤ 10% occupied = whitespace
const DEFAULT_CHANNEL_MIN_THICKNESS = 3;     // cells
const DEFAULT_MIN_REGION_FRAC       = 0.002; // drop rectangles < 0.2% of grid
const DEFAULT_MAX_DEPTH             = 8;     // X-Y cut recursion depth cap

export function detectRegions(items, pageW, pageH, opts = {}) {
  const cellSize             = opts.cellSize             ?? DEFAULT_CELL_SIZE_PT;
  const channelDensity       = opts.channelDensity       ?? DEFAULT_CHANNEL_DENSITY;
  const channelMinThickness  = opts.channelMinThickness  ?? DEFAULT_CHANNEL_MIN_THICKNESS;
  const minRegionFraction    = opts.minRegionFraction    ?? DEFAULT_MIN_REGION_FRAC;
  const maxDepth             = opts.maxDepth             ?? DEFAULT_MAX_DEPTH;

  const gridW = Math.max(1, Math.ceil(pageW / cellSize));
  const gridH = Math.max(1, Math.ceil(pageH / cellSize));
  const grid  = buildOccupancyGrid(items, gridW, gridH, cellSize);

  const root = { x: 0, y: 0, w: gridW, h: gridH };
  const rectangles = xyCut(grid, gridW, root, maxDepth, channelDensity, channelMinThickness);

  // Per rectangle: occupied cells + item stats; filter tiny.
  const minCells = Math.max(8, Math.round(minRegionFraction * gridW * gridH));
  const regions = [];
  let nextId = 1;
  for (const r of rectangles) {
    const occupied = countOccupied(grid, gridW, r);
    if (occupied < minCells) continue;
    const { itemCount, fontSize } = itemStats(items, cellSize, r);
    regions.push({
      id: nextId++,
      bbox: {
        x: r.x * cellSize, y: r.y * cellSize,
        w: r.w * cellSize, h: r.h * cellSize,
      },
      pixelCount: occupied,
      itemCount,
      fontSize,
    });
  }

  // Build labeled grid: every cell inside a region's rectangle gets that
  // region's id. Cells outside any region (channels, sub-threshold rects)
  // stay 0 (background).
  const labels = new Uint32Array(gridW * gridH);
  for (const reg of regions) {
    const rx = Math.round(reg.bbox.x / cellSize);
    const ry = Math.round(reg.bbox.y / cellSize);
    const rw = Math.round(reg.bbox.w / cellSize);
    const rh = Math.round(reg.bbox.h / cellSize);
    for (let y = ry; y < ry + rh; y++) {
      const row = y * gridW;
      for (let x = rx; x < rx + rw; x++) labels[row + x] = reg.id;
    }
  }

  return { regions, labels, grid, gridW, gridH, cellSize };
}

// ── Recursive X-Y cut ──

function xyCut(grid, gridW, region, depth, density, minThickness) {
  if (depth <= 0 || region.w < 2 * minThickness || region.h < 2 * minThickness) {
    return [region];
  }

  const hChannels = findChannels(grid, gridW, region, 'horizontal', density, minThickness);
  const vChannels = findChannels(grid, gridW, region, 'vertical',   density, minThickness);

  if (hChannels.length === 0 && vChannels.length === 0) {
    return [region];
  }

  // Vilna pages are fundamentally columnar — the inter-column gaps
  // (Rashi / Gemara / Tosfos) are the strongest division on the page.
  // Always prefer vertical splits when any are present; horizontal
  // splits (header bands, paragraph breaks within a column) are
  // secondary and get applied at the next recursion level.
  let axis, channels;
  if (vChannels.length > 0) {
    axis = 'vertical';   channels = vChannels;
  } else if (hChannels.length > 0) {
    axis = 'horizontal'; channels = hChannels;
  } else {
    return [region];
  }

  const subs = stripsFromChannels(region, axis, channels);
  const out = [];
  for (const sub of subs) {
    out.push(...xyCut(grid, gridW, sub, depth - 1, density, minThickness));
  }
  return out;
}

// Find runs of whitespace cells along an axis within a sub-region.
// `densities` are computed using only the cells inside `region`, so a
// channel that spans only part of the page (e.g., a horizontal break inside
// Rashi's column) is detectable once we've recursed down to that column.
function findChannels(grid, gridW, region, axis, threshold, minThickness) {
  const len = axis === 'horizontal' ? region.h : region.w;
  const densities = new Float32Array(len);

  if (axis === 'horizontal') {
    // Density per row, counting only cells in [region.x, region.x + region.w).
    if (region.w <= 0) return [];
    for (let dy = 0; dy < len; dy++) {
      const rowStart = (region.y + dy) * gridW + region.x;
      let count = 0;
      for (let dx = 0; dx < region.w; dx++) {
        if (grid[rowStart + dx]) count++;
      }
      densities[dy] = count / region.w;
    }
  } else {
    // Density per column, counting only cells in [region.y, region.y + region.h).
    if (region.h <= 0) return [];
    for (let dx = 0; dx < len; dx++) {
      const x = region.x + dx;
      let count = 0;
      for (let dy = 0; dy < region.h; dy++) {
        if (grid[(region.y + dy) * gridW + x]) count++;
      }
      densities[dx] = count / region.h;
    }
  }

  const channels = [];
  let i = 0;
  while (i < len) {
    if (densities[i] <= threshold) {
      const start = i;
      while (i < len && densities[i] <= threshold) i++;
      const end = i;
      if (end - start >= minThickness) channels.push({ start, end });
    } else {
      i++;
    }
  }
  return channels;
}

// Convert {start, end} channel intervals into the strips between them,
// expressed as absolute grid-coordinate sub-rectangles of `region`.
function stripsFromChannels(region, axis, channels) {
  const len = axis === 'horizontal' ? region.h : region.w;
  const ranges = [];
  let prevEnd = 0;
  for (const ch of channels) {
    if (ch.start > prevEnd) ranges.push({ start: prevEnd, end: ch.start });
    prevEnd = ch.end;
  }
  if (prevEnd < len) ranges.push({ start: prevEnd, end: len });

  return ranges.map(s => axis === 'horizontal'
    ? { x: region.x, y: region.y + s.start, w: region.w, h: s.end - s.start }
    : { x: region.x + s.start, y: region.y, w: s.end - s.start, h: region.h });
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

// ── Per-rectangle stats ──

function countOccupied(grid, gridW, r) {
  let count = 0;
  for (let y = r.y; y < r.y + r.h; y++) {
    const row = y * gridW;
    for (let x = r.x; x < r.x + r.w; x++) if (grid[row + x]) count++;
  }
  return count;
}

function itemStats(items, cellSize, r) {
  const fontSizes = [];
  let itemCount = 0;
  for (const it of items) {
    const cx = Math.floor((it.x + it.w / 2) / cellSize);
    const cy = Math.floor((it.y + it.h / 2) / cellSize);
    if (cx >= r.x && cx < r.x + r.w && cy >= r.y && cy < r.y + r.h) {
      fontSizes.push(it.fontSize);
      itemCount++;
    }
  }
  fontSizes.sort((a, b) => a - b);
  const fontSize = fontSizes.length > 0 ? fontSizes[fontSizes.length >> 1] : 0;
  return { itemCount, fontSize };
}
