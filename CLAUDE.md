# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev      # dev server (http://localhost:5173)
npm run build    # production build → dist/
npm run preview  # serve dist/ locally
```

## Architecture

**Stack:** Vite + vanilla JS (ES modules), PDF.js, PWA with Service Worker.

**Page source:** `https://www.shas.org/daf-pdf/api/?masechta={slug}&daf={n}&amud={a|b}` — returns a single-page PDF. This is a public developer API; no CORS proxy needed.

**Module layout:**

| File | Role |
|---|---|
| `src/main.js` | Entry point — wires modules, SW registration, initial navigation |
| `src/viewer.js` | PDF.js loading, canvas rendering, CSS-transform pan/zoom state |
| `src/gestures.js` | Pointer event handling — palm rejection, semantic zoom, pan |
| `src/regions.js` | Canvas pixel analysis to detect Gemara/commentary column bounding boxes |
| `src/nav.js` | URL state, tractate/daf picker UI, prev/next navigation |
| `src/tractates.js` | All 37 tractates: slugs, Hebrew names, last daf/amud, URL builder |
| `src/storage.js` | localStorage — user zoom preferences per region type, region cache, last location |
| `public/sw.js` | Service Worker — cache-first for shas.org PDFs, prefetch-tractate message handler |

## Key design decisions

**Gesture model (touch):**
- Single finger drag: **no action** — deliberate, so users can trace text without triggering anything
- Single finger tap: toggle nav chrome
- Double tap: zoom to the column region under the tap point (Gemara / commentary)
- Pinch (2 fingers): free zoom; saves zoom preference per region type on release
- 2-3 finger drag: pan
- Large touch radius: treated as palm and ignored

**Semantic zoom:** `regions.js` detects column boundaries via horizontal ink-density projection on the rendered canvas. Results are cached in localStorage. Double-tap finds the region at the tap point and animates (`transform: translate/scale` with CSS transition) to fit that region at the user's saved zoom level for that region type (`gemara` or `commentary`).

**Rendering strategy:** PDF.js renders to a `<canvas>` at `fitWidth * devicePixelRatio` quality. CSS `transform` handles all pan/zoom during interaction. After a gesture settles, `scheduleQualityRender()` (debounced 350ms) re-renders at the new zoom level for sharpness.

**Offline:** Service Worker caches all shas.org PDF responses (cache-first). A `PREFETCH_TRACTATE` message triggers batch pre-fetch of an entire tractate (4 concurrent requests). Region data and user prefs are stored in localStorage.

**URL state:** `?m={slug}&d={daf}&a={amud}` — supports bookmarking and browser back/forward.

## Repository

- GitHub: https://github.com/dansteen/talmud
