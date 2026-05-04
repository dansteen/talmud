// User zoom preference per region type (gemara / commentary)
// Stored as the CSS viewScale the user last settled on for that region type.

const PREFS_KEY = 'talmud:zoom_prefs';
const LAST_LOC_KEY = 'talmud:last_location';
const REGION_CACHE_KEY = 'talmud:regions:v14';
const SESSION_KEY = 'talmud:session:v1';

function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}'); }
  catch { return {}; }
}

function savePrefs(prefs) {
  localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
}

// regionType: 'gemara' | 'commentary'
export function getZoomPref(regionType) {
  return loadPrefs()[regionType] ?? null;
}

export function setZoomPref(regionType, scale) {
  const prefs = loadPrefs();
  prefs[regionType] = scale;
  savePrefs(prefs);
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
