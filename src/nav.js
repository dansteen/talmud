import {
  TRACTATES, getTractate, nextAmud, prevAmud,
  locationLabel, clampLocation,
} from './tractates.js';

// Current location state
let state = { slug: 'berachos', daf: 2, amud: 'a' };
let onNavigate = null; // callback(slug, daf, amud)
let onHome = null;

export function initNav(navigateCallback, homeCallback) {
  onNavigate = navigateCallback;
  onHome = homeCallback;

  buildTractateList();
  bindButtons();
  bindDafPicker();
  bindKeyboard();
}

// RTL convention: pressing left-arrow turns the page leftward = forward.
function bindKeyboard() {
  window.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const t = getTractate(state.slug);
    if (!t) return;

    if (e.key === 'ArrowLeft') {
      const next = nextAmud(t, state.daf, state.amud);
      if (next) navigate(state.slug, next.daf, next.amud);
      e.preventDefault();
    } else if (e.key === 'ArrowRight') {
      const prev = prevAmud(t, state.daf, state.amud);
      if (prev) navigate(state.slug, prev.daf, prev.amud);
      e.preventDefault();
    }
  });
}

export function setLocation(slug, daf, amud) {
  state = { slug, daf, amud };
  updateLocationDisplay();
}

function navigate(slug, daf, amud) {
  const t = getTractate(slug);
  if (!t) return;
  const clamped = clampLocation(t, daf, amud);
  setLocation(slug, clamped.daf, clamped.amud);
  onNavigate?.(slug, clamped.daf, clamped.amud);
}

function updateLocationDisplay() {
  const t = getTractate(state.slug);
  if (!t) return;
  const el = document.getElementById('current-location');
  if (el) el.textContent = locationLabel(t, state.daf, state.amud);
}

// ── Tractate list ──

function buildTractateList() {
  const list = document.getElementById('tractate-list');
  list.innerHTML = '';
  TRACTATES.forEach(t => {
    const item = document.createElement('div');
    item.className = 'tractate-item';
    item.dataset.slug = t.slug;
    item.innerHTML = `<span>${t.he}</span><span class="tractate-en">${t.en}</span>`;
    item.addEventListener('click', () => showDafPicker(t.slug));
    list.appendChild(item);
  });
}

// ── Drawer open/close ──

function openDrawer() {
  document.getElementById('nav-overlay').classList.remove('hidden');
  document.getElementById('nav-drawer').classList.remove('hidden');
  document.getElementById('tractate-list').classList.remove('hidden');
  document.getElementById('daf-picker').classList.add('hidden');
  document.getElementById('nav-drawer-title').textContent = 'בחר מסכת';
}

function closeDrawer() {
  document.getElementById('nav-overlay').classList.add('hidden');
  document.getElementById('nav-drawer').classList.add('hidden');
  document.getElementById('nav-chrome').classList.add('hidden');
}

// ── Daf picker ──

let pickerSlug = null;

function showDafPicker(slug) {
  pickerSlug = slug;
  const t = getTractate(slug);
  document.getElementById('tractate-list').classList.add('hidden');
  document.getElementById('daf-picker').classList.remove('hidden');
  document.getElementById('nav-drawer-title').textContent = '';
  document.getElementById('daf-picker-tractate').textContent = t.he;

  const input = document.getElementById('daf-input');
  input.max = t.lastDaf;
  input.value = (slug === state.slug) ? state.daf : 2;

  const amud = (slug === state.slug) ? state.amud : 'a';
  setAmudToggle(amud);
}

function setAmudToggle(amud) {
  document.getElementById('amud-a-btn').classList.toggle('active', amud === 'a');
  document.getElementById('amud-b-btn').classList.toggle('active', amud === 'b');
}

function getSelectedAmud() {
  return document.getElementById('amud-a-btn').classList.contains('active') ? 'a' : 'b';
}

// ── Button wiring ──

function bindButtons() {
  document.getElementById('nav-menu-btn').addEventListener('click', openDrawer);
  document.getElementById('nav-overlay').addEventListener('click', closeDrawer);
  document.getElementById('nav-close-btn').addEventListener('click', closeDrawer);

  document.getElementById('prev-btn').addEventListener('click', () => {
    const t = getTractate(state.slug);
    const prev = prevAmud(t, state.daf, state.amud);
    if (prev) navigate(state.slug, prev.daf, prev.amud);
  });

  document.getElementById('next-btn').addEventListener('click', () => {
    const t = getTractate(state.slug);
    const next = nextAmud(t, state.daf, state.amud);
    if (next) navigate(state.slug, next.daf, next.amud);
  });

  document.getElementById('home-btn').addEventListener('click', () => onHome?.());
}

function bindDafPicker() {
  document.getElementById('amud-a-btn').addEventListener('click', () => setAmudToggle('a'));
  document.getElementById('amud-b-btn').addEventListener('click', () => setAmudToggle('b'));

  document.getElementById('daf-back-btn').addEventListener('click', () => {
    document.getElementById('tractate-list').classList.remove('hidden');
    document.getElementById('daf-picker').classList.add('hidden');
    document.getElementById('nav-drawer-title').textContent = 'בחר מסכת';
  });

  document.getElementById('go-btn').addEventListener('click', () => {
    if (!pickerSlug) return;
    const daf = parseInt(document.getElementById('daf-input').value, 10);
    const amud = getSelectedAmud();
    closeDrawer();
    navigate(pickerSlug, daf, amud);
  });

  // Allow Enter key in daf input
  document.getElementById('daf-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('go-btn').click();
  });
}

// ── URL state ──

export function readUrlLocation() {
  const params = new URLSearchParams(window.location.search);
  const slug = params.get('m');
  const daf = parseInt(params.get('d') || '', 10);
  const amud = params.get('a') === 'b' ? 'b' : 'a';
  if (slug && getTractate(slug) && daf >= 2) {
    return { slug, daf, amud };
  }
  return null;
}

export function pushUrlLocation(slug, daf, amud) {
  const url = new URL(window.location.href);
  url.searchParams.set('m', slug);
  url.searchParams.set('d', daf);
  url.searchParams.set('a', amud);
  window.history.pushState({}, '', url);
}
