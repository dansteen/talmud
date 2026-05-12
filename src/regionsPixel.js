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
