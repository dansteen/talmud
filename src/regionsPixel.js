// Pixel-grid construction + 2D gutter detection via straight runs.
//
// The grid is 1:1 with the rendered image — one cell per pixel. A cell
// is "occupied" if its pixel's max-channel luminance is below
// `darkThreshold`. Gutters are pixels that lie inside BOTH a horizontal
// AND a vertical empty run whose length is sufficient: the long axis ≥
// minLong px (the gutter's length), the short axis ≥ minShort px (the
// gutter's thickness).

export async function renderPdfToImageData(pdfPage) {
  const viewport = pdfPage.getViewport({ scale: 1 });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await pdfPage.render({ canvasContext: ctx, viewport }).promise;
  return {
    imageData: ctx.getImageData(0, 0, canvas.width, canvas.height),
    pageW: viewport.width,
    pageH: viewport.height,
  };
}

// ── Ink cleanup (small isolated component removal) ──────────────────────
//
// Dilate the ink mask by `dilateRadius` pixels (Chebyshev), find 4-CCs
// in the dilated mask, and zero out any pixel whose component's area is
// below `minArea`. Dilation merges adjacent letters and lines into a
// single blob per word/paragraph/column, so a "small CC" is something
// like a catchword or a page number sitting alone in a margin —
// surrounded by enough empty space that even the dilation halo can't
// reach the next real text block.
//
// `dilateRadius` should be larger than the typical inter-line gap so
// neighboring lines of a real paragraph fuse into one CC.

// Chebyshev dilation, separable: O(N) per axis using a distance-from-
// last-ink tracker.
function dilateMask(grid, gridW, gridH, r) {
  const N = gridW * gridH;
  if (r <= 0) return new Uint8Array(grid);
  const horiz = new Uint8Array(N);
  for (let y = 0; y < gridH; y++) {
    const base = y * gridW;
    let lastInk = -Infinity;
    for (let x = 0; x < gridW; x++) {
      if (grid[base + x]) lastInk = x;
      if (x - lastInk <= r) horiz[base + x] = 1;
    }
    let nextInk = Infinity;
    for (let x = gridW - 1; x >= 0; x--) {
      if (grid[base + x]) nextInk = x;
      if (nextInk - x <= r) horiz[base + x] = 1;
    }
  }
  const out = new Uint8Array(N);
  for (let x = 0; x < gridW; x++) {
    let lastInk = -Infinity;
    for (let y = 0; y < gridH; y++) {
      if (horiz[y * gridW + x]) lastInk = y;
      if (y - lastInk <= r) out[y * gridW + x] = 1;
    }
    let nextInk = Infinity;
    for (let y = gridH - 1; y >= 0; y--) {
      if (horiz[y * gridW + x]) nextInk = y;
      if (nextInk - y <= r) out[y * gridW + x] = 1;
    }
  }
  return out;
}

// Return a copy of `grid` with pixels in small dilated components zeroed.
export function cleanIsolatedInk(grid, gridW, gridH, opts = {}) {
  const dilateRadius = opts.dilateRadius ?? 5;
  const minArea      = opts.minInkArea   ?? 2000;
  const N = gridW * gridH;
  if (dilateRadius <= 0 || minArea <= 0) return new Uint8Array(grid);

  const dilated = dilateMask(grid, gridW, gridH, dilateRadius);
  const labels = new Int32Array(N);
  const queue = new Int32Array(N);
  const areas = [0]; // areas[label] — index 0 unused (label ids start at 1)
  let label = 0;

  for (let i = 0; i < N; i++) {
    if (!dilated[i] || labels[i]) continue;
    label++;
    labels[i] = label;
    let head = 0, tail = 0;
    queue[tail++] = i;
    let area = 0;
    while (head < tail) {
      const cur = queue[head++];
      area++;
      const cy = (cur / gridW) | 0;
      const cx = cur - cy * gridW;
      if (cx > 0)         { const n = cur - 1;     if (dilated[n] && !labels[n]) { labels[n] = label; queue[tail++] = n; } }
      if (cx < gridW - 1) { const n = cur + 1;     if (dilated[n] && !labels[n]) { labels[n] = label; queue[tail++] = n; } }
      if (cy > 0)         { const n = cur - gridW; if (dilated[n] && !labels[n]) { labels[n] = label; queue[tail++] = n; } }
      if (cy < gridH - 1) { const n = cur + gridW; if (dilated[n] && !labels[n]) { labels[n] = label; queue[tail++] = n; } }
    }
    areas.push(area);
  }

  const cleaned = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    if (!grid[i]) continue;
    if (areas[labels[i]] >= minArea) cleaned[i] = 1;
  }
  return cleaned;
}

// Build the binary pixel grid: one cell per pixel. Cell is "occupied"
// (grid[i] = 1) iff the pixel's max-channel luminance < darkThreshold.
// Default 130 — catches mid-gray (≥50% stroke coverage) and up, ignores
// antialiased edge pixels.
export function buildGridFromImageData(imageData, darkThreshold = 130) {
  const imgW = imageData.width;
  const imgH = imageData.height;
  const pixels = imageData.data;
  const grid = new Uint8Array(imgW * imgH);
  for (let y = 0; y < imgH; y++) {
    const rowBase = y * imgW * 4;
    const outBase = y * imgW;
    for (let x = 0; x < imgW; x++) {
      const i = rowBase + x * 4;
      const lum = Math.max(pixels[i], pixels[i + 1], pixels[i + 2]);
      if (lum < darkThreshold) grid[outBase + x] = 1;
    }
  }
  return { grid, gridW: imgW, gridH: imgH };
}

// ── 2D gutter detection ─────────────────────────────────────────────────
//
// Both X and Y are at pixel resolution, so all run lengths are direct
// pixel counts.
export function detectGutters(grid, gridW, gridH, opts = {}) {
  const minShort = Math.max(1, opts.minShort ?? 1);
  const minLong  = Math.max(1, opts.minLong  ?? 50);

  // Step 1a: hMark[i] = 1 iff cell i is empty AND lies inside a horizontal
  // empty run of ≥ minLong pixels.
  const hMark = new Uint8Array(gridW * gridH);
  for (let y = 0; y < gridH; y++) {
    const base = y * gridW;
    let runStart = -1;
    for (let x = 0; x <= gridW; x++) {
      const isEmpty = x < gridW && grid[base + x] === 0;
      if (isEmpty) {
        if (runStart < 0) runStart = x;
      } else if (runStart >= 0) {
        if (x - runStart >= minLong) {
          for (let xx = runStart; xx < x; xx++) hMark[base + xx] = 1;
        }
        runStart = -1;
      }
    }
  }

  // Step 1b: vMark[i] = 1 iff cell i is empty AND lies inside a vertical
  // empty run of ≥ minLong pixels.
  const vMark = new Uint8Array(gridW * gridH);
  for (let x = 0; x < gridW; x++) {
    let runStart = -1;
    for (let y = 0; y <= gridH; y++) {
      const isEmpty = y < gridH && grid[y * gridW + x] === 0;
      if (isEmpty) {
        if (runStart < 0) runStart = y;
      } else if (runStart >= 0) {
        if (y - runStart >= minLong) {
          for (let yy = runStart; yy < y; yy++) vMark[yy * gridW + x] = 1;
        }
        runStart = -1;
      }
    }
  }

  const out = new Uint8Array(gridW * gridH);

  // Step 2a: a cell is a horizontal gutter iff hMark AND vertical stack
  // of ≥ minShort consecutive hMark cells (i.e. ≥ minShort pixels tall).
  for (let x = 0; x < gridW; x++) {
    let runStart = -1;
    for (let y = 0; y <= gridH; y++) {
      const isMarked = y < gridH && hMark[y * gridW + x] === 1;
      if (isMarked) {
        if (runStart < 0) runStart = y;
      } else if (runStart >= 0) {
        if (y - runStart >= minShort) {
          for (let yy = runStart; yy < y; yy++) out[yy * gridW + x] = 1;
        }
        runStart = -1;
      }
    }
  }

  // Step 2b: a cell is a vertical gutter iff vMark AND horizontal stack
  // of ≥ minShort consecutive vMark cells (i.e. ≥ minShort pixels wide).
  for (let y = 0; y < gridH; y++) {
    const base = y * gridW;
    let runStart = -1;
    for (let x = 0; x <= gridW; x++) {
      const isMarked = x < gridW && vMark[base + x] === 1;
      if (isMarked) {
        if (runStart < 0) runStart = x;
      } else if (runStart >= 0) {
        if (x - runStart >= minShort) {
          for (let xx = runStart; xx < x; xx++) out[base + xx] = 1;
        }
        runStart = -1;
      }
    }
  }

  return out;
}

// ── Region detection ────────────────────────────────────────────────────
//
// 4-connected components of non-gutter pixels. The gutter mask already
// includes the page margins (they're long empty runs), so the surviving
// components are the demarcated content areas.
//
// Returns:
//   labels  — Int32Array (gridW × gridH); 0 = gutter or filtered-out
//             component, otherwise the region's sequential id (1..N).
//   regions — [{ id, x, y, w, h, area }] — bbox + pixel area per region.
//
// Components smaller than `minArea` pixels are dropped (page numbers,
// stray marks). The labels grid is renumbered so surviving ids are
// contiguous (1..regions.length), so callers can use the id directly
// as a color index.
export function detectRegions(gutterMask, gridW, gridH, opts = {}) {
  const minArea = opts.minArea ?? 2000;
  const N = gridW * gridH;
  const tempLabels = new Int32Array(N);
  const queue = new Int32Array(N);
  const candidates = []; // {tempLabel, x, y, w, h, area}
  let nextLabel = 0;

  for (let y = 0; y < gridH; y++) {
    for (let x = 0; x < gridW; x++) {
      const startIdx = y * gridW + x;
      if (gutterMask[startIdx] || tempLabels[startIdx]) continue;

      nextLabel++;
      tempLabels[startIdx] = nextLabel;
      let head = 0, tail = 0;
      queue[tail++] = startIdx;

      let xMin = x, xMax = x, yMin = y, yMax = y, area = 0;

      while (head < tail) {
        const cur = queue[head++];
        area++;
        const cy = (cur / gridW) | 0;
        const cx = cur - cy * gridW;
        if (cx < xMin) xMin = cx;
        if (cx > xMax) xMax = cx;
        if (cy < yMin) yMin = cy;
        if (cy > yMax) yMax = cy;

        if (cx > 0) {
          const n = cur - 1;
          if (!gutterMask[n] && !tempLabels[n]) { tempLabels[n] = nextLabel; queue[tail++] = n; }
        }
        if (cx < gridW - 1) {
          const n = cur + 1;
          if (!gutterMask[n] && !tempLabels[n]) { tempLabels[n] = nextLabel; queue[tail++] = n; }
        }
        if (cy > 0) {
          const n = cur - gridW;
          if (!gutterMask[n] && !tempLabels[n]) { tempLabels[n] = nextLabel; queue[tail++] = n; }
        }
        if (cy < gridH - 1) {
          const n = cur + gridW;
          if (!gutterMask[n] && !tempLabels[n]) { tempLabels[n] = nextLabel; queue[tail++] = n; }
        }
      }

      candidates.push({
        tempLabel: nextLabel,
        x: xMin, y: yMin,
        w: xMax - xMin + 1, h: yMax - yMin + 1,
        area,
      });
    }
  }

  // Filter & renumber. remap[tempLabel] = final id (0 if filtered out).
  const remap = new Int32Array(nextLabel + 1);
  const regions = [];
  for (const c of candidates) {
    if (c.area < minArea) continue;
    const id = regions.length + 1;
    remap[c.tempLabel] = id;
    regions.push({ id, x: c.x, y: c.y, w: c.w, h: c.h, area: c.area });
  }

  // Build the final labels grid (in-place over tempLabels since we won't
  // need the originals again).
  for (let i = 0; i < N; i++) tempLabels[i] = remap[tempLabels[i]];

  return { labels: tempLabels, regions };
}
