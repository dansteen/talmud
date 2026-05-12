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
//
// `inkBudget` lets a run tolerate up to that many dark pixels without
// breaking — bridges small obstructions like the catchword (the first
// word of the next page that's dropped into the bottom margin). A
// catchword is ~20–60 px wide; a real column is 200+ px, so a budget
// well below column width skips catchwords without fusing columns.
export function detectGutters(grid, gridW, gridH, opts = {}) {
  const minShort  = Math.max(1, opts.minShort  ?? 1);
  const minLong   = Math.max(1, opts.minLong   ?? 50);
  const inkBudget = Math.max(0, opts.inkBudget ?? 0);

  // Step 1a: hMark[i] = 1 iff cell i is inside a "mostly empty" horizontal
  // run whose span (first-empty..last-empty) is ≥ minLong px and which
  // contains ≤ inkBudget dark pixels. Tolerated dark pixels inside the
  // span are marked too (so the gutter visually flows through them).
  const hMark = new Uint8Array(gridW * gridH);
  for (let y = 0; y < gridH; y++) {
    const base = y * gridW;
    let runStart = -1, lastEmpty = -1, darkInRun = 0;
    for (let x = 0; x <= gridW; x++) {
      const inBounds = x < gridW;
      const isEmpty = inBounds && grid[base + x] === 0;
      if (isEmpty) {
        if (runStart < 0) { runStart = x; darkInRun = 0; }
        lastEmpty = x;
      } else if (runStart >= 0) {
        if (inBounds) darkInRun++;
        if (!inBounds || darkInRun > inkBudget) {
          if (lastEmpty - runStart + 1 >= minLong) {
            for (let xx = runStart; xx <= lastEmpty; xx++) hMark[base + xx] = 1;
          }
          runStart = -1;
        }
      }
    }
  }

  // Step 1b: same for vertical runs.
  const vMark = new Uint8Array(gridW * gridH);
  for (let x = 0; x < gridW; x++) {
    let runStart = -1, lastEmpty = -1, darkInRun = 0;
    for (let y = 0; y <= gridH; y++) {
      const inBounds = y < gridH;
      const isEmpty = inBounds && grid[y * gridW + x] === 0;
      if (isEmpty) {
        if (runStart < 0) { runStart = y; darkInRun = 0; }
        lastEmpty = y;
      } else if (runStart >= 0) {
        if (inBounds) darkInRun++;
        if (!inBounds || darkInRun > inkBudget) {
          if (lastEmpty - runStart + 1 >= minLong) {
            for (let yy = runStart; yy <= lastEmpty; yy++) vMark[yy * gridW + x] = 1;
          }
          runStart = -1;
        }
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
