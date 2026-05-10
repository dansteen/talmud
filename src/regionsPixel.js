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

export function detectGutters(grid, gridW, gridH, opts = {}) {
  const thickness = opts.thickness ?? 4;

  // Step 1: solidify the text mask. At our cell resolution, individual
  // Hebrew letters have lots of negative space inside them (between
  // strokes), so a raw text column reads as ~30% occupied cells, not
  // a solid mass. A small fixed closing on the text mask fills those
  // sub-letter and inter-glyph gaps so a column reads as solid before
  // we look for gutters around it.
  const PRE_SOLIDIFY_R = 3;
  const textSolid = morphClose(grid, gridW, gridH, PRE_SOLIDIFY_R);

  // Step 2: invert to get the empty mask.
  const empty = new Uint8Array(gridW * gridH);
  for (let i = 0; i < grid.length; i++) {
    empty[i] = textSolid[i] ? 0 : 1;
  }
  if (thickness <= 0) return empty;

  // Step 3: close the empty mask by `thickness`. This absorbs small
  // isolated text intrusions (single words dipping into a gutter,
  // marginal marks) into the surrounding gutter, while leaving solid
  // text columns intact since they're wider than 2*thickness on every
  // side.
  return morphClose(empty, gridW, gridH, thickness);
}

function morphClose(mask, gridW, gridH, r) {
  if (r <= 0) return new Uint8Array(mask);
  const dil = dilateSquare(mask, gridW, gridH, r);
  return erodeSquare(dil, gridW, gridH, r);
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
