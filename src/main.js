import { loadPage } from './viewer.js';
import { initGestures, returnHome } from './gestures.js';
import {
  initNav, readUrlLocation, pushUrlLocation, clearUrlLocation,
  stepNext, stepPrev,
} from './nav.js';
import {
  getTractate, apiUrl, clampLocation, nextAmud, prevAmud,
} from './tractates.js';
import {
  getState, navigateTo as sessionNavigateTo, openMasechta, rehydrateTimers,
  currentPosition,
} from './session.js';
import { initDrawer } from './drawer.js';
import { getLastLocation, setLastLocation } from './storage.js';

const loading = document.getElementById('loading');
const viewerEl = document.getElementById('viewer');

let currentLoadKey = null;

// ── Page loader ──

async function loadCurrent() {
  const cur = currentPosition();
  if (!cur) {
    // No masechta open — show welcome (drawer handles this via subscriber)
    clearUrlLocation();
    return;
  }
  await loadAt(cur.slug, cur.daf, cur.amud);
}

async function loadAt(slug, daf, amud) {
  const t = getTractate(slug);
  if (!t) return;
  const c = clampLocation(t, daf, amud);

  const key = `${slug}:${c.daf}:${c.amud}`;
  if (key === currentLoadKey) return;
  currentLoadKey = key;

  pushUrlLocation(slug, c.daf, c.amud);
  setLastLocation(slug, c.daf, c.amud);

  // Only show the loading spinner if the load takes longer than this. Cache
  // hits (pdf.js parse + canvas render of a small PDF) typically settle in
  // 200-400ms, so this threshold avoids the spinner flickering on fast paths.
  // For slower (network) loads the user still gets feedback.
  const SPINNER_DELAY_MS = 600;
  const spinnerTimer = setTimeout(() => {
    loading.classList.remove('hidden');
  }, SPINNER_DELAY_MS);

  try {
    const url = apiUrl(t, c.daf, c.amud);
    await loadPage(url, slug, c.daf, c.amud, () => {});
  } catch (err) {
    console.error('Failed to load page:', err);
  } finally {
    clearTimeout(spinnerTimer);
    loading.classList.add('hidden');
  }

  // After the visible page settles, warm the SW cache with the immediate
  // neighbors so a swipe-prev / swipe-next is instant.
  prefetchNeighbors(t, c.daf, c.amud);
}

// Fetch ±1 amudim into the SW cache. Best-effort; failures are silent.
function prefetchNeighbors(tractate, daf, amud) {
  const targets = [
    nextAmud(tractate, daf, amud),
    prevAmud(tractate, daf, amud),
  ].filter(Boolean);
  for (const t of targets) {
    fetch(apiUrl(tractate, t.daf, t.amud), {
      // Hint the browser this is low-priority background work
      priority: 'low',
      credentials: 'omit',
    }).catch(() => {});
  }
}

// Called by the drawer/slider/picker UI when the user picks a new page.
// Session has already been mutated; we just need to load the new page.
function onUserNavigate(slug, daf, amud) {
  loadAt(slug, daf, amud);
}

// Called by gestures (3-finger swipe) and keyboard (arrows).
// Mutates session state, then loads the page. Sequential navigation does not
// drop marks — those are for intentional jumps only.
function onStepNavigate(slug, daf, amud) {
  sessionNavigateTo(slug, daf, amud, { skipMark: true });
  loadAt(slug, daf, amud);
}

// ── Initial state ──

function determineInitial() {
  // 1. URL takes precedence (deep links)
  const fromUrl = readUrlLocation();
  if (fromUrl) return fromUrl;

  // 2. Persisted session current
  const cur = currentPosition();
  if (cur) return cur;

  // 3. Legacy single last_location (one-time migration)
  const legacy = getLastLocation();
  if (legacy && getTractate(legacy.slug)) return legacy;

  // 4. Nothing → welcome screen
  return null;
}

async function init() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(console.warn);
  }

  // Read the URL BEFORE initialising the drawer, since the drawer's first
  // render runs synchronously and may toggle the welcome screen, which can
  // race with our URL handling.
  const initial = determineInitial();

  // If the URL referenced a masechta the session doesn't yet know about,
  // fold it into session state now (silently — no mark drops on init).
  if (initial) {
    const state = getState();
    if (!state.open.includes(initial.slug)) {
      openMasechta(initial.slug, { skipMark: true });
      sessionNavigateTo(initial.slug, initial.daf, initial.amud, { skipMark: true });
    } else if (state.current !== initial.slug ||
               state.pages[initial.slug]?.daf !== initial.daf ||
               state.pages[initial.slug]?.amud !== initial.amud) {
      sessionNavigateTo(initial.slug, initial.daf, initial.amud, { skipMark: true });
    }
  }

  initDrawer({
    navigate: onUserNavigate,
    showWelcome: () => {
      viewerEl.style.visibility = 'hidden';
      currentLoadKey = null;
      clearUrlLocation();
    },
    hideWelcome: () => { viewerEl.style.visibility = ''; },
  });

  initGestures({
    prev: () => stepPrev(),
    next: () => stepNext(),
  });

  initNav({
    navigate: onStepNavigate,
    current: () => currentPosition(),
  });

  rehydrateTimers();

  if (initial) {
    await loadAt(initial.slug, initial.daf, initial.amud);
  }
  // else: drawer's render() already showed welcome (open list is empty)

  window.addEventListener('popstate', () => {
    const loc = readUrlLocation();
    if (loc) onStepNavigate(loc.slug, loc.daf, loc.amud);
  });
}

init();
