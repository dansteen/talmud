// Pixel-grid construction + 2D gutter detection.
//
// Render the PDF page to an offscreen canvas at scale 1 (1 PDF point = 1 px),
// binarize the bitmap, downsample into a cell grid. From there we compute
// "gutters" — every cell that has no text (or only an isolated bit of
// text) within a thickness-sized neighborhood is gutter.

// ── Pixel-grid construction ─────────────────────────────────────────────

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
  // 200 (out of 255) counts as ink.
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

// ── 2D gutter detection ─────────────────────────────────────────────────
//
// A cell is "gutter" if it has no text in it OR if the text in it is an
// isolated intrusion small enough that the surrounding empty space
// engulfs it. We compute this via morphological closing of the
// empty-cell mask: dilate by `thickness` (so empty cells expand into
// adjacent text), then erode by `thickness` (so they shrink back).
// The net effect is that small isolated text features (single words,
// stray marks) get absorbed into the surrounding empty area, while
// large text columns retain their boundaries.
//
// Returns a Uint8Array (gridW × gridH) where 1 = gutter, 0 = text.

// A cell is part of a gutter iff it sits inside an unbroken run of empty
// cells (horizontal or vertical) at least `minLength` cells long. This
// matches the user's intuition: "a gutter is a large contiguous set of
// whitespace; an inter-word gap is not." Long runs catch full-page-width
// horizontal gutters AND tall narrow vertical inter-column gutters
// regardless of how narrow they are; short runs (sub-letter, inter-letter,
// inter-word) never qualify no matter how many of them sit next to each
// other.
//
// Pre-step: close the empty mask vertically by a small radius so a single
// word dipping down into a tall gutter still counts as gutter. The word's
// cells are surrounded by empty above and below; vertical closing fills
// them. Sub-letter empties (small 1-areas surrounded by text) are
// untouched by closing of the empty mask, so this doesn't bleed into
// columns.

export function detectGutters(grid, gridW, gridH, opts = {}) {
  const minLength = opts.thickness ?? 20;
  const wordAbsorbY = 4;

  // Empty mask: 1 where the page is empty, 0 where there's ink.
  const empty = new Uint8Array(gridW * gridH);
  for (let i = 0; i < grid.length; i++) {
    empty[i] = grid[i] ? 0 : 1;
  }

  // Vertical closing of the empty mask absorbs small text intrusions
  // (single words dipping into a gutter) into the surrounding empty
  // space, so the run-detection below sees them as part of the gutter.
  let mask = empty;
  if (wordAbsorbY > 0) {
    mask = dilateY(mask, gridW, gridH, wordAbsorbY);
    mask = erodeY (mask, gridW, gridH, wordAbsorbY);
  }

  if (minLength <= 0) return mask;

  // Output mask: cell = 1 iff it's inside any horizontal OR vertical
  // empty run of length >= minLength.
  const out = new Uint8Array(gridW * gridH);

  // Horizontal runs.
  for (let y = 0; y < gridH; y++) {
    const base = y * gridW;
    let runStart = -1;
    for (let x = 0; x < gridW; x++) {
      if (mask[base + x]) {
        if (runStart < 0) runStart = x;
      } else if (runStart >= 0) {
        if (x - runStart >= minLength) {
          for (let xx = runStart; xx < x; xx++) out[base + xx] = 1;
        }
        runStart = -1;
      }
    }
    if (runStart >= 0 && gridW - runStart >= minLength) {
      for (let xx = runStart; xx < gridW; xx++) out[base + xx] = 1;
    }
  }

  // Vertical runs.
  for (let x = 0; x < gridW; x++) {
    let runStart = -1;
    for (let y = 0; y < gridH; y++) {
      if (mask[y * gridW + x]) {
        if (runStart < 0) runStart = y;
      } else if (runStart >= 0) {
        if (y - runStart >= minLength) {
          for (let yy = runStart; yy < y; yy++) out[yy * gridW + x] = 1;
        }
        runStart = -1;
      }
    }
    if (runStart >= 0 && gridH - runStart >= minLength) {
      for (let yy = runStart; yy < gridH; yy++) out[yy * gridW + x] = 1;
    }
  }

  return out;
}

// 1-D dilation/erosion along Y only.
function dilateY(grid, gridW, gridH, r) {
  if (r <= 0) return new Uint8Array(grid);
  const out = new Uint8Array(gridW * gridH);
  for (let x = 0; x < gridW; x++) {
    for (let y = 0; y < gridH; y++) {
      let any = false;
      const lo = Math.max(0, y - r), hi = Math.min(gridH - 1, y + r);
      for (let yy = lo; yy <= hi; yy++) {
        if (grid[yy * gridW + x]) { any = true; break; }
      }
      if (any) out[y * gridW + x] = 1;
    }
  }
  return out;
}

function erodeY(grid, gridW, gridH, r) {
  if (r <= 0) return new Uint8Array(grid);
  const out = new Uint8Array(gridW * gridH);
  for (let x = 0; x < gridW; x++) {
    for (let y = 0; y < gridH; y++) {
      const lo = y - r, hi = y + r;
      if (lo < 0 || hi >= gridH) continue;
      let all = true;
      for (let yy = lo; yy <= hi; yy++) {
        if (!grid[yy * gridW + x]) { all = false; break; }
      }
      if (all) out[y * gridW + x] = 1;
    }
  }
  return out;
}

// Square structuring element of radius `r`, separated into X then Y passes.
function dilateSquare(grid, gridW, gridH, r) {
  const tmp = new Uint8Array(gridW * gridH);
  // X pass.
  for (let y = 0; y < gridH; y++) {
    const base = y * gridW;
    for (let x = 0; x < gridW; x++) {
      let any = false;
      const xLo = Math.max(0, x - r);
      const xHi = Math.min(gridW - 1, x + r);
      for (let xx = xLo; xx <= xHi; xx++) {
        if (grid[base + xx]) { any = true; break; }
      }
      if (any) tmp[base + x] = 1;
    }
  }
  // Y pass.
  const out = new Uint8Array(gridW * gridH);
  for (let x = 0; x < gridW; x++) {
    for (let y = 0; y < gridH; y++) {
      let any = false;
      const yLo = Math.max(0, y - r);
      const yHi = Math.min(gridH - 1, y + r);
      for (let yy = yLo; yy <= yHi; yy++) {
        if (tmp[yy * gridW + x]) { any = true; break; }
      }
      if (any) out[y * gridW + x] = 1;
    }
  }
  return out;
}

function erodeSquare(grid, gridW, gridH, r) {
  const tmp = new Uint8Array(gridW * gridH);
  // X pass.
  for (let y = 0; y < gridH; y++) {
    const base = y * gridW;
    for (let x = 0; x < gridW; x++) {
      let all = true;
      const xLo = x - r;
      const xHi = x + r;
      if (xLo < 0 || xHi >= gridW) { all = false; }
      else {
        for (let xx = xLo; xx <= xHi; xx++) {
          if (!grid[base + xx]) { all = false; break; }
        }
      }
      if (all) tmp[base + x] = 1;
    }
  }
  // Y pass.
  const out = new Uint8Array(gridW * gridH);
  for (let x = 0; x < gridW; x++) {
    for (let y = 0; y < gridH; y++) {
      let all = true;
      const yLo = y - r;
      const yHi = y + r;
      if (yLo < 0 || yHi >= gridH) { all = false; }
      else {
        for (let yy = yLo; yy <= yHi; yy++) {
          if (!tmp[yy * gridW + x]) { all = false; break; }
        }
      }
      if (all) out[y * gridW + x] = 1;
    }
  }
  return out;
}
