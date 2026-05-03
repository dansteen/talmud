// User zoom preference per region type (gemara / commentary)
// Stored as the CSS viewScale the user last settled on for that region type.

const PREFS_KEY = 'talmud:zoom_prefs';
const LAST_LOC_KEY = 'talmud:last_location';
const REGION_CACHE_KEY = 'talmud:regions:v10';

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

// Last viewed location
export function getLastLocation() {
  try { return JSON.parse(localStorage.getItem(LAST_LOC_KEY) || 'null'); }
  catch { return null; }
}

export function setLastLocation(slug, daf, amud) {
  localStorage.setItem(LAST_LOC_KEY, JSON.stringify({ slug, daf, amud }));
}

// Per-page region cache (column bounding boxes)
// Key: `${slug}:${daf}:${amud}`
// Value: array of { x, y, w, h } in normalized [0..1] coords, plus type

function loadRegionCache() {
  try { return JSON.parse(localStorage.getItem(REGION_CACHE_KEY) || '{}'); }
  catch { return {}; }
}

function saveRegionCache(cache) {
  try { localStorage.setItem(REGION_CACHE_KEY, JSON.stringify(cache)); }
  catch {
    // Storage full — clear oldest entries (keep last 200)
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
