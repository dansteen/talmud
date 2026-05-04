// Drawer UI: peek, pull-up drawer, sliders view, picker view, welcome screen.
// All DOM concerns for the new chrome live here.

import {
  SEDARIM, getTractate,
  amudToIndex, indexToAmud, lastAmudIndex, dafLabel,
} from './tractates.js';
import {
  getState, subscribe, openMasechta, switchTo, closeMasechta,
  navigateTo, marksForMasechta, currentPosition,
} from './session.js';

let onNavigate = null; // (slug, daf, amud) — called when user picks a new page
let onShowWelcome = null; // () — called when no masechta is open
let onHideWelcome = null;

// ── DOM refs (resolved in init) ──
let peekEl, peekHandleEl, drawerEl, scrimEl;
let slidersViewEl, pickerViewEl;
let sliderStackEl, addBtn;
let pickerListEl, pickerBackBtn;
let welcomeEl, welcomeOpenBtn;

export function initDrawer({ navigate, showWelcome, hideWelcome }) {
  onNavigate = navigate;
  onShowWelcome = showWelcome;
  onHideWelcome = hideWelcome;

  peekEl = document.getElementById('peek');
  peekHandleEl = document.getElementById('peek-handle');
  drawerEl = document.getElementById('drawer');
  scrimEl = document.getElementById('drawer-scrim');
  slidersViewEl = document.getElementById('sliders-view');
  pickerViewEl = document.getElementById('picker-view');
  sliderStackEl = document.getElementById('slider-stack');
  addBtn = document.getElementById('add-masechta-btn');
  pickerListEl = document.getElementById('picker-list');
  pickerBackBtn = document.getElementById('picker-back-btn');
  welcomeEl = document.getElementById('welcome');
  welcomeOpenBtn = document.getElementById('welcome-open-btn');

  bindPeek();
  bindDrawer();
  bindPicker();
  bindWelcome();
  buildPickerList();

  subscribe(render);
  render(getState());
}

// ── Open / close ──

let isOpen = false;
let inPickerMode = false;

function open(picker = false) {
  // If nothing is open, force picker mode — empty sliders view is useless.
  if (getState().open.length === 0) picker = true;
  inPickerMode = picker;
  showView();
  drawerEl.classList.remove('hidden');
  scrimEl.classList.remove('hidden');
  // Force reflow so the slide-in transition runs
  void drawerEl.offsetHeight;
  drawerEl.classList.add('open');
  scrimEl.classList.add('visible');
  isOpen = true;
}

function close() {
  drawerEl.classList.remove('open');
  scrimEl.classList.remove('visible');
  isOpen = false;
  setTimeout(() => {
    if (!isOpen) {
      drawerEl.classList.add('hidden');
      scrimEl.classList.add('hidden');
    }
  }, 280);
}

function showView() {
  slidersViewEl.classList.toggle('hidden', inPickerMode);
  pickerViewEl.classList.toggle('hidden', !inPickerMode);
}

function showPicker() {
  inPickerMode = true;
  showView();
}

function showSliders() {
  inPickerMode = false;
  showView();
}

// ── Peek: tap to open, drag-up to open ──

function bindPeek() {
  let startY = null;
  let dragging = false;

  const releasePeek = () => {
    startY = null;
    peekEl.classList.remove('dragging');
  };

  peekEl.addEventListener('pointerdown', e => {
    e.preventDefault();
    peekEl.setPointerCapture(e.pointerId);
    startY = e.clientY;
    dragging = false;
    peekEl.classList.add('dragging');
  });

  peekEl.addEventListener('pointermove', e => {
    if (startY == null) return;
    const dy = e.clientY - startY;
    if (dy < -6) dragging = true;
    if (dragging && dy < -28) {
      // Pulled up far enough — commit
      releasePeek();
      open(false);
    }
  });

  peekEl.addEventListener('pointerup', () => {
    const wasDragging = dragging;
    if (startY != null) releasePeek();
    if (!wasDragging) {
      // Treat as tap → open
      open(false);
    }
  });
  peekEl.addEventListener('pointercancel', releasePeek);
}

// ── Drawer body: grip drag-down to close, scrim tap to close ──

function bindDrawer() {
  scrimEl.addEventListener('pointerdown', e => {
    e.preventDefault();
    close();
  });

  const grip = document.getElementById('drawer-grip');
  let startY = null;
  let dragOffset = 0;

  grip.addEventListener('pointerdown', e => {
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    startY = e.clientY;
    dragOffset = 0;
    drawerEl.classList.add('dragging');
  });

  grip.addEventListener('pointermove', e => {
    if (startY == null) return;
    dragOffset = Math.max(0, e.clientY - startY);
    drawerEl.style.transform = `translateY(${dragOffset}px)`;
  });

  const release = () => {
    if (startY == null) return;
    startY = null;
    drawerEl.classList.remove('dragging');
    drawerEl.style.transform = '';
    if (dragOffset > 80) close();
  };

  grip.addEventListener('pointerup', release);
  grip.addEventListener('pointercancel', release);

  addBtn.addEventListener('click', showPicker);
}

// ── Picker ──

function bindPicker() {
  pickerBackBtn.addEventListener('click', showSliders);
}

function buildPickerList() {
  pickerListEl.innerHTML = '';
  for (const seder of SEDARIM) {
    const header = document.createElement('div');
    header.className = 'picker-seder-header';
    header.textContent = `סדר ${seder.he}`;
    pickerListEl.appendChild(header);

    const grid = document.createElement('div');
    grid.className = 'picker-seder-grid';
    for (const slug of seder.slugs) {
      const t = getTractate(slug);
      if (!t) continue;
      const tile = document.createElement('div');
      tile.className = 'picker-tile';
      tile.dataset.slug = slug;
      tile.textContent = t.he;
      tile.addEventListener('click', () => onPickTractate(slug));
      grid.appendChild(tile);
    }
    pickerListEl.appendChild(grid);
  }
}

function onPickTractate(slug) {
  const state = getState();
  if (state.open.includes(slug)) {
    // Already open — just switch to it (no page change)
    if (state.current !== slug) switchTo(slug);
    const page = getState().pages[slug];
    onNavigate?.(slug, page.daf, page.amud);
  } else {
    // Adds at 2a, switches to it, navigates
    openMasechta(slug);
    onNavigate?.(slug, 2, 'a');
  }
  showSliders();
  close();
}

// ── Welcome screen ──

function bindWelcome() {
  welcomeOpenBtn.addEventListener('click', () => {
    open(true);
  });
}

// ── Render: sliders + picker tile selection state ──

function render(state) {
  // Welcome vs. viewer
  if (state.open.length === 0) {
    welcomeEl.classList.remove('hidden');
    onShowWelcome?.();
  } else {
    welcomeEl.classList.add('hidden');
    onHideWelcome?.();
  }

  renderSliders(state);
  renderPickerSelection(state);
}

function renderSliders(state) {
  if (state.open.length === 0) {
    sliderStackEl.innerHTML = '<div class="slider-empty">בחר מסכת לפתיחה</div>';
    return;
  }

  // Remove rows for masechtos no longer open
  const wantSlugs = new Set(state.open);
  const existing = new Map();
  for (const row of [...sliderStackEl.querySelectorAll('.slider-row')]) {
    const slug = row.dataset.slug;
    if (!wantSlugs.has(slug)) {
      row.remove();
    } else {
      existing.set(slug, row);
    }
  }

  // Add or re-render in current `open` order
  const fragment = document.createDocumentFragment();
  for (const slug of state.open) {
    let row = existing.get(slug);
    if (!row) row = createSliderRow(slug);
    updateSliderRow(row, slug, state);
    fragment.appendChild(row);
  }
  sliderStackEl.appendChild(fragment);
}

function renderPickerSelection(state) {
  for (const tile of pickerListEl.querySelectorAll('.picker-tile')) {
    tile.classList.toggle('open', state.open.includes(tile.dataset.slug));
  }
}

// ── Slider row ──

function createSliderRow(slug) {
  const t = getTractate(slug);
  const row = document.createElement('div');
  row.className = 'slider-row';
  row.dataset.slug = slug;
  row.innerHTML = `
    <div class="slider-row-header">
      <div>
        <span class="slider-name">${t.he}</span>
        <span class="slider-name-current"></span>
      </div>
      <button class="slider-close" aria-label="Close">×</button>
    </div>
    <div class="slider-track-wrap">
      <div class="slider-track">
        <div class="slider-knob"></div>
        <div class="slider-bubble"></div>
      </div>
    </div>
    <div class="slider-bounds">
      <span class="slider-min">${dafLabel(2, 'a')}</span>
      <span class="slider-max">${dafLabel(t.lastDaf, t.lastAmud)}</span>
    </div>
  `;

  row.querySelector('.slider-close').addEventListener('click', e => {
    e.stopPropagation();
    handleCloseSlider(slug);
  });

  attachSliderInteraction(row, slug);
  return row;
}

function updateSliderRow(row, slug, state) {
  const t = getTractate(slug);
  const page = state.pages[slug];
  const isCurrent = state.current === slug;

  row.classList.toggle('active', isCurrent);

  const last = lastAmudIndex(t);
  const idx = amudToIndex(page.daf, page.amud);
  const pct = last === 0 ? 0 : idx / last;

  row.querySelector('.slider-name-current').textContent = dafLabel(page.daf, page.amud);

  const knob = row.querySelector('.slider-knob');
  // RTL: page progress runs right→left, so 0% on the right, 100% on the left
  knob.style.insetInlineStart = (pct * 100) + '%';

  // Marks (anchor + trail entries for this slug)
  const marks = marksForMasechta(slug);
  // Remove old mark elements
  for (const m of [...row.querySelectorAll('.slider-mark')]) m.remove();
  const track = row.querySelector('.slider-track');
  for (const m of marks) {
    const mIdx = amudToIndex(m.daf, m.amud);
    const mPct = last === 0 ? 0 : mIdx / last;
    const dot = document.createElement('div');
    dot.className = 'slider-mark';
    dot.style.insetInlineStart = (mPct * 100) + '%';
    dot.dataset.daf = String(m.daf);
    dot.dataset.amud = m.amud;
    dot.title = dafLabel(m.daf, m.amud);
    dot.addEventListener('pointerdown', e => e.stopPropagation());
    dot.addEventListener('click', e => {
      e.stopPropagation();
      jumpTo(slug, m.daf, m.amud);
    });
    // Insert before the knob so knob renders on top
    track.insertBefore(dot, knob);
  }
}

// ── Slider interaction (knob drag only — tap-on-track is intentionally
// disabled to avoid accidental jumps when reaching for a mark) ──

function attachSliderInteraction(row, slug) {
  const wrap = row.querySelector('.slider-track-wrap');
  const knob = row.querySelector('.slider-knob');
  const bubble = row.querySelector('.slider-bubble');

  let dragging = false;
  let pendingIdx = null;

  function trackBounds() {
    const trackEl = row.querySelector('.slider-track');
    return trackEl.getBoundingClientRect();
  }

  function indexAt(clientX, t) {
    const rect = trackBounds();
    if (rect.width <= 0) return 0;
    // RTL: right edge = index 0, left edge = last
    let pct = (rect.right - clientX) / rect.width;
    pct = Math.max(0, Math.min(1, pct));
    const last = lastAmudIndex(t);
    return Math.round(pct * last);
  }

  function showBubble(idx, t) {
    const last = lastAmudIndex(t);
    const pct = last === 0 ? 0 : idx / last;
    const { daf, amud } = indexToAmud(idx);
    bubble.textContent = dafLabel(daf, amud);
    bubble.style.insetInlineStart = (pct * 100) + '%';
    knob.style.insetInlineStart = (pct * 100) + '%';
  }

  // Drag must start on the knob itself. The track doesn't capture taps.
  knob.addEventListener('pointerdown', e => {
    e.preventDefault();
    e.stopPropagation();
    knob.setPointerCapture(e.pointerId);
    const t = getTractate(slug);
    dragging = true;
    wrap.classList.add('dragging');
    pendingIdx = indexAt(e.clientX, t);
    showBubble(pendingIdx, t);
  });

  knob.addEventListener('pointermove', e => {
    if (!dragging) return;
    const t = getTractate(slug);
    pendingIdx = indexAt(e.clientX, t);
    showBubble(pendingIdx, t);
  });

  function release() {
    if (!dragging) return;
    dragging = false;
    wrap.classList.remove('dragging');
    if (pendingIdx != null) {
      const { daf, amud } = indexToAmud(pendingIdx);
      pendingIdx = null;
      jumpTo(slug, daf, amud);
    }
  }

  knob.addEventListener('pointerup', release);
  knob.addEventListener('pointercancel', () => {
    dragging = false;
    pendingIdx = null;
    wrap.classList.remove('dragging');
    // Snap knob back to current position
    const state = getState();
    const page = state.pages[slug];
    if (page) {
      const last = lastAmudIndex(getTractate(slug));
      const pct = last === 0 ? 0 : amudToIndex(page.daf, page.amud) / last;
      knob.style.insetInlineStart = (pct * 100) + '%';
    }
  });
}

// ── Slider actions ──

function jumpTo(slug, daf, amud) {
  navigateTo(slug, daf, amud);
  onNavigate?.(slug, daf, amud);
}

function handleCloseSlider(slug) {
  const wasCurrent = getState().current === slug;
  closeMasechta(slug);
  if (wasCurrent) {
    const cur = currentPosition();
    if (cur) onNavigate?.(cur.slug, cur.daf, cur.amud);
    // If no current (last masechta closed), render() will show welcome
  }
}

// ── External controls ──

export function openPicker() {
  open(true);
}
