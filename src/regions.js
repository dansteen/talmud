// Region detection by whitespace-channel decomposition.
//
// Top-down approach: rasterize text-item bboxes onto an occupancy grid,
// then find horizontal "whitespace bands" (rows that are ≥ 90% empty) and
// vertical "whitespace bands" (columns that are ≥ 90% empty within a strip).
// The bands carve the page into rectangles; each non-empty rectangle is a
// region.
//
// Two thresholds:
//   - `channelDensity`: a row/column counts as whitespace if its occupied
//     fraction is at most this value (default 0.10 → ≥ 90% whitespace).
//   - `channelMinThickness`: how many consecutive whitespace rows/cols are
//     needed to count as a real channel (default 3 cells). Filters out
//     individual inter-line gaps that happen to be sparse.
//
// Vertical channels are recomputed *per horizontal strip* — different
// strips of the page have different column structures (e.g., the header
// band has no vertical channels; the middle has the Rashi/Gemara/Tosfos
// columns; the bottom may have its own column layout).
//
// Output shape matches the previous detector:
//   {
//     regions: [{ id, bbox, fontSize, itemCount, pixelCount }, …],
//     labels:  Uint32Array(gridW * gridH)  // 0 = whitespace, 1..N = region id
//     gridW, gridH, cellSize
//   }

const DEFAULT_CELL_SIZE_PT          = 4;
const DEFAULT_CHANNEL_DENSITY       = 0.10;  // ≤ 10% occupied = whitespace
const DEFAULT_CHANNEL_MIN_THICKNESS = 3;     // cells
const DEFAULT_MIN_REGION_FRAC       = 0.002; // drop rectangles < 0.2% of grid

export function detectRegions(items, pageW, pageH, opts = {}) {
  const cellSize             = opts.cellSize             ?? DEFAULT_CELL_SIZE_PT;
  const channelDensity       = opts.channelDensity       ?? DEFAULT_CHANNEL_DENSITY;
  const channelMinThickness  = opts.channelMinThickness  ?? DEFAULT_CHANNEL_MIN_THICKNESS;
  const minRegionFraction    = opts.minRegionFraction    ?? DEFAULT_MIN_REGION_FRAC;

  const gridW = Math.max(1, Math.ceil(pageW / cellSize));
  const gridH = Math.max(1, Math.ceil(pageH / cellSize));

  const grid = buildOccupancyGrid(items, gridW, gridH, cellSize);

  // Step 1: find horizontal channels → page splits into horizontal strips.
  const rowDensities = computeRowDensities(grid, gridW, gridH);
  const hStrips = stripsBetweenChannels(
    rowDensities, gridH, channelDensity, channelMinThickness,
  );

  // Step 2: within each h-strip, find vertical channels → strip splits
  // into rectangles. Each rectangle is a candidate region.
  const rectangles = [];
  for (const strip of hStrips) {
    const colDensities = computeColDensitiesInStrip(grid, gridW, strip);
    const vStrips = stripsBetweenChannels(
      colDensities, gridW, channelDensity, channelMinThickness,
    );
    for (const v of vStrips) {
      rectangles.push({ x: v.start, y: strip.start, w: v.end - v.start, h: strip.end - strip.start });
    }
  }

  // Step 3: per rectangle, compute occupied cells + item stats; filter tiny.
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

  return { regions, labels, gridW, gridH, cellSize };
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

// ── Density computation ──

function computeRowDensities(grid, gridW, gridH) {
  const out = new Float32Array(gridH);
  for (let y = 0; y < gridH; y++) {
    let count = 0;
    const row = y * gridW;
    for (let x = 0; x < gridW; x++) if (grid[row + x]) count++;
    out[y] = count / gridW;
  }
  return out;
}

function computeColDensitiesInStrip(grid, gridW, strip) {
  const stripH = strip.end - strip.start;
  const out = new Float32Array(gridW);
  if (stripH <= 0) return out;
  for (let x = 0; x < gridW; x++) {
    let count = 0;
    for (let y = strip.start; y < strip.end; y++) {
      if (grid[y * gridW + x]) count++;
    }
    out[x] = count / stripH;
  }
  return out;
}

// ── Channel / strip extraction ──
//
// Mark each index as a channel cell if its density is below the threshold.
// Group consecutive channel cells into channel bands; only bands that are at
// least `minThickness` wide count as real channels (filters single-row
// inter-line gaps that happen to be sparse). The strips returned are the
// non-channel ranges in between.

function stripsBetweenChannels(densities, len, threshold, minThickness) {
  const isChannelCell = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    isChannelCell[i] = densities[i] <= threshold ? 1 : 0;
  }

  const channels = [];
  let i = 0;
  while (i < len) {
    if (isChannelCell[i]) {
      const start = i;
      while (i < len && isChannelCell[i]) i++;
      const end = i;
      if (end - start >= minThickness) channels.push({ start, end });
    } else {
      i++;
    }
  }

  const strips = [];
  let prevEnd = 0;
  for (const ch of channels) {
    if (ch.start > prevEnd) strips.push({ start: prevEnd, end: ch.start });
    prevEnd = ch.end;
  }
  if (prevEnd < len) strips.push({ start: prevEnd, end: len });
  return strips;
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
