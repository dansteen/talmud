// Pixel-grid construction + 2D gutter detection via connected components.
//
// Each cell is `cellSize` PDF points square (caller decides the size; the
// natural choice for talmud pages is the page's smallest font, so a glyph
// of the smallest text occupies roughly 1 cell). A cell is "occupied" if
// any pixel inside its area is dark.
//
// Gutters are connected components of EMPTY cells (4-neighbor adjacency)
// whose bounding-box dimensions satisfy a min/max threshold: the shorter
// side ≥ minShort cells AND the longer side ≥ minLong cells. With the
// natural cellSize this picks out real gutters (tall narrow inter-column
// stripes, wide short inter-paragraph bands) while ignoring tiny
// connected-empties inside text (sub-letter holes, inter-letter gaps).

// ── Pixel-grid construction (split into render + grid build so that
//    cellSize and emptyFrac can be re-tuned without re-rendering the PDF) ──

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

// Find the right edge of the rightmost text column. For Hebrew/Aramaic
// RTL pages, every line starts at this same x, so the rightmost x where
// a meaningful fraction of rows has a dark pixel is the column's right
// edge. We scan from the page right inward.
export function findRightmostColumnEdge(imageData, darkThreshold = 130, minOccupiedFrac = 0.2) {
  const W = imageData.width;
  const H = imageData.height;
  const pixels = imageData.data;
  const minRows = Math.ceil(H * minOccupiedFrac);
  for (let x = W - 1; x >= 0; x--) {
    let darkRows = 0;
    for (let y = 0; y < H; y++) {
      const i = (y * W + x) * 4;
      const lum = Math.max(pixels[i], pixels[i + 1], pixels[i + 2]);
      if (lum < darkThreshold) {
        darkRows++;
        if (darkRows >= minRows) return x + 1;  // one past the rightmost dark pixel
      }
    }
  }
  return W;
}

// `emptyFrac` is the fraction of pixels in a cell that must be empty for
// the cell itself to count as empty. e.g. 0.75 means a cell is empty
// when at least 75% of its pixels are blank.
//
// `darkThreshold` is the per-pixel luminance below which the pixel counts
// as "dark." Default 130 — catches mid-gray (≥50% stroke coverage) and
// up. Lower values are stricter (only saturated ink counts).
//
// `xOffset` shifts the cell grid horizontally. With xOffset = anchor mod
// cellSize, one cell boundary lands exactly on `anchor` (the right edge
// of the rightmost text column). The leftmost sliver [0, xOffset) is
// excluded from the grid.
export function buildGridFromImageData(imageData, cellSize, emptyFrac, darkThreshold = 130, xOffset = 0) {
  const imgW = imageData.width;
  const imgH = imageData.height;
  const pixels = imageData.data;
  const usableW = Math.max(0, imgW - xOffset);
  const gridW = Math.max(1, Math.ceil(usableW / cellSize));
  const gridH = Math.max(1, Math.ceil(imgH / cellSize));
  const grid = new Uint8Array(gridW * gridH);

  const occupiedThreshold = 1 - emptyFrac;

  for (let cy = 0; cy < gridH; cy++) {
    const y0 = Math.floor(cy * cellSize);
    const y1 = Math.min(imgH, Math.ceil((cy + 1) * cellSize));
    for (let cx = 0; cx < gridW; cx++) {
      const x0 = Math.floor(xOffset + cx * cellSize);
      const x1 = Math.min(imgW, Math.ceil(xOffset + (cx + 1) * cellSize));
      if (x1 <= x0) continue;
      let dark = 0;
      let total = 0;
      for (let y = y0; y < y1; y++) {
        const rowBase = y * imgW * 4;
        for (let x = x0; x < x1; x++) {
          const i = rowBase + x * 4;
          const lum = Math.max(pixels[i], pixels[i + 1], pixels[i + 2]);
          if (lum < darkThreshold) dark++;
          total++;
        }
      }
      if (total > 0 && dark / total > occupiedThreshold) grid[cy * gridW + cx] = 1;
    }
  }

  return { grid, gridW, gridH, cellSize, xOffset };
}

// ── 2D gutter detection ─────────────────────────────────────────────────

export function detectGutters(grid, gridW, gridH, opts = {}) {
  const minShort = opts.minShort ?? 1;
  const minLong  = opts.minLong  ?? 10;

  // Step 1a: hMark[i] = 1 iff cell i is empty AND lies inside a horizontal
  // run of empty cells whose length ≥ minLong.
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
  // run of empty cells whose length ≥ minLong.
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

  // Step 2a: a cell is a horizontal gutter iff it's hMark AND lies inside
  // a column-wise vertical stack of at least minShort consecutive hMark
  // cells (so the long horizontal run has thickness ≥ minShort).
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

  // Step 2b: same for vertical gutters — vMark in a row-wise horizontal
  // stack of at least minShort consecutive vMark cells.
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

// Pick a cellSize from the page's text items: the smallest fontSize. We
// floor it so cellSize is at least 1pt (avoids degenerate grids if the
// page has no text or has unusable item heights).
export function smallestFontCellSize(textItems) {
  let min = Infinity;
  for (const it of textItems) {
    if (it.fontSize > 0 && it.fontSize < min) min = it.fontSize;
  }
  if (!isFinite(min) || min < 1) return 1.5;
  return min;
}
