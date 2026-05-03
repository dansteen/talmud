import { loadPage } from './viewer.js';
import { initGestures, returnHome } from './gestures.js';
import { initNav, setLocation, readUrlLocation, pushUrlLocation } from './nav.js';
import { getTractate, apiUrl } from './tractates.js';
import { getLastLocation, setLastLocation } from './storage.js';

const loading = document.getElementById('loading');

async function navigateTo(slug, daf, amud) {
  const t = getTractate(slug);
  if (!t) return;

  loading.classList.remove('hidden');
  setLocation(slug, daf, amud);
  pushUrlLocation(slug, daf, amud);
  setLastLocation(slug, daf, amud);

  try {
    const url = apiUrl(t, daf, amud);
    await loadPage(url, slug, daf, amud, () => {
      // Regions ready — gestures will use them automatically
    });
  } catch (err) {
    console.error('Failed to load page:', err);
    // TODO: show error state
  } finally {
    loading.classList.add('hidden');
  }
}

async function init() {
  // Register service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(console.warn);
  }

  initGestures();
  initNav(navigateTo, returnHome);

  // Determine initial location: URL → last visited → default
  const fromUrl = readUrlLocation();
  const fromStorage = getLastLocation();
  const start = fromUrl
    ?? (fromStorage && getTractate(fromStorage.slug) ? fromStorage : null)
    ?? { slug: 'berachos', daf: 2, amud: 'a' };

  await navigateTo(start.slug, start.daf, start.amud);

  // Browser back/forward
  window.addEventListener('popstate', () => {
    const loc = readUrlLocation();
    if (loc) navigateTo(loc.slug, loc.daf, loc.amud);
  });
}

init();
