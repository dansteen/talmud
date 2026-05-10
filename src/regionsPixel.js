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

// ── Pixel-grid construction ─────────────────────────────────────────────

export async function buildPixelGridFromPdfPage(pdfPage, cellSize) {
  const viewport = pdfPage.getViewport({ scale: 1 });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await pdfPage.render({ canvasContext: ctx, viewport }).promise;

  const imgW = canvas.width;
  const imgH = canvas.height;
  const pixels = ctx.getImageData(0, 0, imgW, imgH).data;

  const gridW = Math.max(1, Math.ceil(imgW / cellSize));
  const gridH = Math.max(1, Math.ceil(imgH / cellSize));
  const grid = new Uint8Array(gridW * gridH);

  // Threshold: anything with luminance below 200 (out of 255) counts as ink.
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

export function detectGutters(grid, gridW, gridH, opts = {}) {
  const minShort = opts.minShort ?? 2;
  const minLong  = opts.minLong  ?? 10;

  // 4-neighbor flood-fill labelling of empty cells. Each empty cell gets
  // a component id; we track each component's bbox as we go.
  const labels = new Int32Array(gridW * gridH);
  const compBBox = []; // index = id - 1; { xMin, xMax, yMin, yMax }
  let nextId = 0;
  const stack = [];

  for (let y = 0; y < gridH; y++) {
    for (let x = 0; x < gridW; x++) {
      const seed = y * gridW + x;
      if (grid[seed] !== 0 || labels[seed] !== 0) continue;
      nextId++;
      const id = nextId;
      let xMin = x, xMax = x, yMin = y, yMax = y;

      stack.length = 0;
      stack.push(seed);
      while (stack.length) {
        const i = stack.pop();
        if (labels[i] !== 0 || grid[i] !== 0) continue;
        labels[i] = id;
        const cx = i % gridW;
        const cy = (i - cx) / gridW;
        if (cx < xMin) xMin = cx;
        if (cx > xMax) xMax = cx;
        if (cy < yMin) yMin = cy;
        if (cy > yMax) yMax = cy;
        if (cx > 0)         stack.push(i - 1);
        if (cx < gridW - 1) stack.push(i + 1);
        if (cy > 0)         stack.push(i - gridW);
        if (cy < gridH - 1) stack.push(i + gridW);
      }
      compBBox.push({ xMin, xMax, yMin, yMax });
    }
  }

  // Each component qualifies as a gutter iff its bbox shorter side ≥
  // minShort AND its longer side ≥ minLong.
  const isGutter = new Uint8Array(nextId + 1); // index = id, id 0 = unused
  for (let id = 1; id <= nextId; id++) {
    const b = compBBox[id - 1];
    const w = b.xMax - b.xMin + 1;
    const h = b.yMax - b.yMin + 1;
    const lo = Math.min(w, h);
    const hi = Math.max(w, h);
    if (lo >= minShort && hi >= minLong) isGutter[id] = 1;
  }

  // Build output mask: 1 where cell is in a qualifying component.
  const out = new Uint8Array(gridW * gridH);
  for (let i = 0; i < labels.length; i++) {
    if (isGutter[labels[i]]) out[i] = 1;
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
