// User zoom preferences per region — keyed by the region's PDF fontSize so
// the same on-screen reading size carries across pages and masechtos.

const LAST_LOC_KEY = 'talmud:last_location';
const REGION_CACHE_KEY = 'talmud:regions:v14';
const SESSION_KEY = 'talmud:session:v1';
const REGION_ZOOM_KEY = 'talmud:region_zoom_px:v1';

// ── Per-fontSize preferred on-screen size (CSS pixels) ──
//
// Stored as { "<fontSize.toFixed(2)>": preferredPx }. Two regions are
// considered the same "type" if their fontSizes differ by less than 25%
// (Gemara ≈ 12pt, Rashi/Tosfos ≈ 9pt, side meforshim ≈ 7pt — those bands
// are well separated). Saves on pinch end, looks up on double-tap zoom.

function loadRegionZoomMap() {
  try { return JSON.parse(localStorage.getItem(REGION_ZOOM_KEY) || '{}'); }
  catch { return {}; }
}

function saveRegionZoomMap(map) {
  try { localStorage.setItem(REGION_ZOOM_KEY, JSON.stringify(map)); }
  catch { /* quota — ignore */ }
}

export function getRegionZoomPx(fontSize) {
  if (!Number.isFinite(fontSize) || fontSize <= 0) return null;
  const map = loadRegionZoomMap();
  let best = null, bestDist = Infinity;
  for (const k of Object.keys(map)) {
    const fs = parseFloat(k);
    if (!Number.isFinite(fs) || fs <= 0) continue;
    const d = Math.abs(fs - fontSize) / fontSize;
    if (d < 0.25 && d < bestDist) { bestDist = d; best = map[k]; }
  }
  return Number.isFinite(best) && best > 0 ? best : null;
}

export function setRegionZoomPx(fontSize, px) {
  if (!Number.isFinite(fontSize) || fontSize <= 0) return;
  if (!Number.isFinite(px) || px <= 0) return;
  const map = loadRegionZoomMap();
  // Replace existing entries within 10% similarity so we don't accumulate
  // many slightly-different fontSize keys for what's really one type.
  for (const k of Object.keys(map)) {
    const fs = parseFloat(k);
    if (!Number.isFinite(fs)) { delete map[k]; continue; }
    if (Math.abs(fs - fontSize) / fontSize < 0.1) delete map[k];
  }
  map[fontSize.toFixed(2)] = px;
  saveRegionZoomMap(map);
}

// Last viewed location (legacy — kept for migration)
export function getLastLocation() {
  try { return JSON.parse(localStorage.getItem(LAST_LOC_KEY) || 'null'); }
  catch { return null; }
}

export function setLastLocation(slug, daf, amud) {
  localStorage.setItem(LAST_LOC_KEY, JSON.stringify({ slug, daf, amud }));
}

// ── Session state: open masechtos, current page per masechta, marks ──
//
// Shape:
//   {
//     open: ['berachos', 'shabbos'],        // open masechta slugs
//     current: 'berachos',                   // active slug
//     pages: { berachos: {daf, amud}, ... }, // current page per open masechta
//     marks: {
//       anchor: { slug, daf, amud } | null,
//       trail: [ { slug, daf, amud }, ... ],  // never includes anchor
//       anchorEnteredAt: number | null,       // ms when last entered anchor
//     }
//   }

const EMPTY_SESSION = {
  open: [],
  current: null,
  pages: {},
  // Masechtos that have been opened but not yet navigated within. Their
  // initial 2a position is a transient stopover and shouldn't drop a mark
  // when the user dives away from it.
  freshOpens: [],
  marks: { anchor: null, trail: [], anchorEnteredAt: null },
  // Saved zoom + center per visited page. Keyed by `${slug}:${daf}:${amud}`.
  // Cleared when a masechta closes or marks clear (10-min anchor timer).
  // Each entry is { effScale, centerX, centerY } in PDF-point coords.
  viewStates: {},
};

export function loadSession() {
  try {
    const raw = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
    if (!raw) return null;
    return {
      open: Array.isArray(raw.open) ? raw.open : [],
      current: raw.current || null,
      pages: raw.pages || {},
      freshOpens: Array.isArray(raw.freshOpens) ? raw.freshOpens : [],
      marks: {
        anchor: raw.marks?.anchor || null,
        trail: Array.isArray(raw.marks?.trail) ? raw.marks.trail : [],
        anchorEnteredAt: raw.marks?.anchorEnteredAt || null,
      },
      viewStates: raw.viewStates || {},
    };
  } catch { return null; }
}

export function saveSession(session) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export function clearSession() {
  localStorage.removeItem(SESSION_KEY);
}

export function emptySession() {
  return JSON.parse(JSON.stringify(EMPTY_SESSION));
}

// ── Region cache (column bounding boxes) ──

function loadRegionCache() {
  try { return JSON.parse(localStorage.getItem(REGION_CACHE_KEY) || '{}'); }
  catch { return {}; }
}

function saveRegionCache(cache) {
  try { localStorage.setItem(REGION_CACHE_KEY, JSON.stringify(cache)); }
  catch {
    const entries = Object.entries(cache);
    const trimmed = Object.fromEntries(entries.slice(-200));
    localStorage.setItem(REGION_CACHE_KEY, JSON.stringify(trimmed));
  }
}

export function getCachedRegions(slug, daf, amud) {
  const cache = loadRegionCache();
  return cache[`${slug}:${daf}:${amud}`] ?? null;
}

export function setCachedRegions(slug, daf, amud, regions) {
  const cache = loadRegionCache();
  cache[`${slug}:${daf}:${amud}`] = regions;
  saveRegionCache(cache);
}
