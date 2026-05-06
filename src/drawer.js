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
import { t, LOCALES, getLocale, setLocale, onLocaleChange } from './i18n.js';

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
  buildLangPickers();
  buildPickerList();
  applyStaticI18n();
  syncDocumentLang();

  subscribe(render);
  onLocaleChange(() => {
    applyStaticI18n();
    buildPickerList();
    renderLangPickers();
    syncDocumentLang();
    // Re-render dynamic content (slider rows etc.) since strings may change
    render(getState());
  });

  render(getState());
}

function syncDocumentLang() {
  // Reflect locale in the html lang attribute. We keep dir="rtl" globally
  // because the slider conventions and page-number labels are inherently
  // right-to-left; non-Hebrew UI text relies on Unicode bidi within RTL
  // containers, which is acceptable for the tightly-scoped UI strings here.
  document.documentElement.setAttribute('lang', getLocale());
}

// Apply translations to any element marked with data-i18n / data-i18n-aria.
function applyStaticI18n() {
  for (const el of document.querySelectorAll('[data-i18n]')) {
    el.textContent = t(el.dataset.i18n);
  }
  for (const el of document.querySelectorAll('[data-i18n-aria]')) {
    el.setAttribute('aria-label', t(el.dataset.i18nAria));
  }
}

// ── Language pickers (welcome + drawer) ──

function buildLangPickers() {
  for (const id of ['welcome-lang', 'drawer-lang']) {
    const host = document.getElementById(id);
    if (!host) continue;
    host.innerHTML = '';
    for (const loc of LOCALES) {
      const btn = document.createElement('button');
      btn.className = 'lang-btn';
      btn.dataset.code = loc.code;
      btn.innerHTML =
        `<span class="lang-flag">${loc.flag}</span>` +
        `<span class="lang-name">${loc.name}</span>`;
      btn.addEventListener('click', () => setLocale(loc.code));
      host.appendChild(btn);
    }
  }
  renderLangPickers();
}

function renderLangPickers() {
  const cur = getLocale();
  for (const btn of document.querySelectorAll('.lang-btn')) {
    btn.classList.toggle('active', btn.dataset.code === cur);
  }
}

// ── Open / close ──

let isOpen = false;
let inPickerMode = false;

// Slider list's vertical scroll position, captured at close time and
// restored on the next open. The drawer's display:none toggle would
// otherwise reset scrollTop on the inner overflow container.
let savedSliderScroll = 0;

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

  // Restore the slider list's scroll to where it was on the last close.
  // requestAnimationFrame waits for layout so scrollTop assignments take.
  if (!inPickerMode && sliderStackEl) {
    requestAnimationFrame(() => {
      sliderStackEl.scrollTop = savedSliderScroll;
    });
  }
}

function close() {
  // Capture the slider list's scroll position before the drawer hides — the
  // browser resets scrollTop when the element transitions to display:none,
  // so we'll restore from this on the next open.
  if (sliderStackEl) savedSliderScroll = sliderStackEl.scrollTop;
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
    // Seder names stay in Hebrew/Aramaic; the prefix word ("Seder", "Седер"...)
    // is translated.
    header.textContent = `${t('picker.sederPrefix')} ${seder.he}`;
    pickerListEl.appendChild(header);

    const grid = document.createElement('div');
    grid.className = 'picker-seder-grid';
    for (const slug of seder.slugs) {
      const tractate = getTractate(slug);
      if (!tractate) continue;
      const tile = document.createElement('div');
      tile.className = 'picker-tile';
      tile.dataset.slug = slug;
      tile.textContent = tractate.he;
      tile.addEventListener('click', () => onPickTractate(slug));
      grid.appendChild(tile);
    }
    pickerListEl.appendChild(grid);
  }
}

function onPickTractate(slug) {
  const state = getState();
  if (state.open.includes(slug)) {
    // Already open — just switch to it (no page change). For an existing
    // masechta the user knows where they are, so close the drawer.
    if (state.current !== slug) switchTo(slug);
    const page = getState().pages[slug];
    onNavigate?.(slug, page.daf, page.amud);
    showSliders();
    close();
  } else {
    // Newly opened masechtos almost always need a page chosen — leave the
    // drawer in sliders view so the user can scrub the new slider.
    openMasechta(slug);
    onNavigate?.(slug, 2, 'a');
    showSliders();
    // Bring the new slider into view so the user can immediately scrub it
    // without hunting through a long stack.
    scrollSliderIntoView(slug);
  }
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
    sliderStackEl.innerHTML = `<div class="slider-empty">${t('drawer.empty')}</div>`;
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

function scrollSliderIntoView(slug) {
  // render() runs synchronously via the session subscriber, so the row exists
  // by the time we get here. Defer one frame so the layout/scroll height is
  // settled before scrolling.
  requestAnimationFrame(() => {
    const row = sliderStackEl.querySelector(`.slider-row[data-slug="${slug}"]`);
    row?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
}

function renderPickerSelection(state) {
  for (const tile of pickerListEl.querySelectorAll('.picker-tile')) {
    tile.classList.toggle('open', state.open.includes(tile.dataset.slug));
  }
}

// ── Slider row ──

function createSliderRow(slug) {
  const tractate = getTractate(slug);
  const row = document.createElement('div');
  row.className = 'slider-row';
  row.dataset.slug = slug;
  row.innerHTML = `
    <div class="slider-row-header">
      <div>
        <span class="slider-name">${tractate.he}</span>
        <span class="slider-name-current"></span>
      </div>
      <button class="slider-close" aria-label="${t('a11y.close')}">×</button>
    </div>
    <div class="slider-track-wrap">
      <div class="slider-track">
        <div class="slider-knob"></div>
        <span class="slider-knob-label"></span>
        <div class="slider-bubble"></div>
      </div>
    </div>
    <div class="slider-bounds">
      <span class="slider-min">${dafLabel(2, 'a')}</span>
      <span class="slider-max">${dafLabel(tractate.lastDaf, tractate.lastAmud)}</span>
    </div>
  `;

  row.querySelector('.slider-close').addEventListener('click', e => {
    e.stopPropagation();
    handleCloseSlider(slug);
  });

  // Tapping the row (anywhere outside the knob, marks, or close button) switches
  // to this masechta at its current page. Useful for jumping back to where you
  // are in another open masechta without scrubbing.
  row.addEventListener('click', e => {
    if (e.target.closest('.slider-knob, .slider-mark, .slider-close')) return;
    const state = getState();
    if (state.current === slug) return;
    const page = state.pages[slug];
    if (!page) return;
    switchTo(slug);
    onNavigate?.(slug, page.daf, page.amud);
    close();
  });

  attachSliderInteraction(row, slug);
  return row;
}

function updateSliderRow(row, slug, state) {
  const tractate = getTractate(slug);
  const page = state.pages[slug];
  const isCurrent = state.current === slug;

  row.classList.toggle('active', isCurrent);

  const last = lastAmudIndex(tractate);
  const idx = amudToIndex(page.daf, page.amud);
  const pct = last === 0 ? 0 : idx / last;
  const pctStr = (pct * 100) + '%';

  row.querySelector('.slider-name-current').textContent = dafLabel(page.daf, page.amud);

  const knob = row.querySelector('.slider-knob');
  // RTL: page progress runs right→left, so 0% on the right, 100% on the left
  knob.style.insetInlineStart = pctStr;

  // Label under the knob mirrors the mark labels — current page is always
  // visually "marked" the same way past positions are.
  const knobLabel = row.querySelector('.slider-knob-label');
  knobLabel.textContent = dafLabel(page.daf, page.amud);
  knobLabel.style.insetInlineStart = pctStr;

  // Marks (anchor + trail entries for this slug). Each mark's diamond stays
  // on the track; only its *label* is staggered above or below to avoid
  // collisions. The knob's own label always sits below the track and is
  // included in the stagger calculation, so a mark sitting at the knob's
  // position simply puts its label on the opposite side rather than being
  // hidden — the user can see it the moment they arrive at the page.
  for (const m of [...row.querySelectorAll('.slider-mark, .slider-mark-label')]) {
    m.remove();
  }
  const track = row.querySelector('.slider-track');
  const marks = marksForMasechta(slug);
  const labelOverlapPct = labelOverlapThreshold(track);

  // Build a single sorted list of "label positions": each mark plus the knob.
  // The knob is anchored to "below" (its label position never moves). Each
  // mark then takes the opposite side of its predecessor whenever close.
  const positions = [
    { kind: 'knob', pct },
    ...marks.map(m => ({
      kind: 'mark',
      mark: m,
      pct: last === 0 ? 0 : amudToIndex(m.daf, m.amud) / last,
    })),
  ].sort((a, b) => a.pct - b.pct);

  let lastSide = null;
  let lastPct = -Infinity;
  // If a mark at the knob's position ends up "above", we mirror the knob's
  // own label to the same side. Otherwise the user would see the knob's
  // label below and the mark's identical label above — visually redundant.
  let knobLabelAbove = false;
  for (const item of positions) {
    if (item.kind === 'knob') {
      lastSide = 'below';
      lastPct = item.pct;
      continue;
    }
    const m = item.mark;
    const mPct = item.pct;
    const pctStr = (mPct * 100) + '%';
    const close = (mPct - lastPct) < labelOverlapPct;
    const side = close
      ? (lastSide === 'below' ? 'above' : 'below')
      : 'below';

    if (side === 'above' && Math.abs(mPct - pct) < 1e-6) {
      knobLabelAbove = true;
    }

    const dot = document.createElement('div');
    dot.className = 'slider-mark';
    dot.style.insetInlineStart = pctStr;
    dot.addEventListener('pointerdown', e => e.stopPropagation());
    dot.addEventListener('click', e => {
      e.stopPropagation();
      jumpTo(slug, m.daf, m.amud);
    });

    const lbl = document.createElement('span');
    lbl.className = side === 'above'
      ? 'slider-mark-label label-above'
      : 'slider-mark-label';
    lbl.style.insetInlineStart = pctStr;
    lbl.textContent = dafLabel(m.daf, m.amud);
    // Tapping the label is the same as tapping the diamond — easier target.
    lbl.addEventListener('pointerdown', e => e.stopPropagation());
    lbl.addEventListener('click', e => {
      e.stopPropagation();
      jumpTo(slug, m.daf, m.amud);
    });

    track.insertBefore(dot, knob);
    track.insertBefore(lbl, knob);

    lastSide = side;
    lastPct = mPct;
  }

  // Mirror the knob's label to the same side as a coincident "above" mark
  // so the two labels stack on the same side instead of one above + one
  // below the track.
  knobLabel.classList.toggle('label-above', knobLabelAbove);
}

// Returns the minimum percent-of-track distance below which two labels would
// overlap. ~30px of label width is a reasonable rule of thumb; we measure the
// track's actual width and convert. Falls back to 5% if the track hasn't been
// laid out yet.
function labelOverlapThreshold(track) {
  const w = track.getBoundingClientRect().width;
  if (w <= 0) return 0.05;
  return 30 / w;
}

// ── Slider interaction ──
//
// Knob behavior is intentionally drag-only:
//   - pointerdown on knob: arm; do NOT move the knob or show the bubble yet.
//   - pointermove past a small threshold: enter drag mode (bubble appears,
//     knob follows finger).
//   - pointerup before threshold: no-op. The knob stays put. (This means
//     a stray tap on the knob — say while reaching for a mark right next
//     to it — doesn't accidentally jump the page.)
//   - pointerup after threshold: navigate to the held index.

const DRAG_THRESHOLD_PX = 6;

function attachSliderInteraction(row, slug) {
  const wrap = row.querySelector('.slider-track-wrap');
  const knob = row.querySelector('.slider-knob');
  const bubble = row.querySelector('.slider-bubble');

  let armed = false;       // pointerdown landed on knob, awaiting movement
  let dragging = false;    // movement exceeded threshold, knob now follows
  let startX = 0;
  let pendingIdx = null;

  function trackBounds() {
    const trackEl = row.querySelector('.slider-track');
    return trackEl.getBoundingClientRect();
  }

  function indexAt(clientX, tractate) {
    const rect = trackBounds();
    if (rect.width <= 0) return 0;
    // RTL: right edge = index 0, left edge = last
    let pct = (rect.right - clientX) / rect.width;
    pct = Math.max(0, Math.min(1, pct));
    const last = lastAmudIndex(tractate);
    return Math.round(pct * last);
  }

  function showBubble(idx, tractate) {
    const last = lastAmudIndex(tractate);
    const pct = last === 0 ? 0 : idx / last;
    const { daf, amud } = indexToAmud(idx);
    bubble.textContent = dafLabel(daf, amud);
    bubble.style.insetInlineStart = (pct * 100) + '%';
    knob.style.insetInlineStart = (pct * 100) + '%';
  }

  function snapBackToCurrent() {
    const page = getState().pages[slug];
    if (!page) return;
    const last = lastAmudIndex(getTractate(slug));
    const pct = last === 0 ? 0 : amudToIndex(page.daf, page.amud) / last;
    knob.style.insetInlineStart = (pct * 100) + '%';
  }

  knob.addEventListener('pointerdown', e => {
    e.preventDefault();
    e.stopPropagation();
    knob.setPointerCapture(e.pointerId);
    armed = true;
    dragging = false;
    startX = e.clientX;
    pendingIdx = null;
  });

  knob.addEventListener('pointermove', e => {
    if (!armed) return;
    const tractate = getTractate(slug);
    if (!dragging) {
      if (Math.abs(e.clientX - startX) < DRAG_THRESHOLD_PX) return;
      dragging = true;
      wrap.classList.add('dragging');
    }
    pendingIdx = indexAt(e.clientX, tractate);
    showBubble(pendingIdx, tractate);
  });

  function release() {
    const wasDragging = dragging;
    armed = false;
    dragging = false;
    wrap.classList.remove('dragging');
    if (wasDragging && pendingIdx != null) {
      const { daf, amud } = indexToAmud(pendingIdx);
      pendingIdx = null;
      jumpTo(slug, daf, amud);
    } else {
      // Tap on knob — no-op. Snap back in case anything moved.
      pendingIdx = null;
      snapBackToCurrent();
    }
  }

  knob.addEventListener('pointerup', release);
  knob.addEventListener('pointercancel', () => {
    armed = false;
    dragging = false;
    pendingIdx = null;
    wrap.classList.remove('dragging');
    snapBackToCurrent();
  });
}

// ── Slider actions ──

function jumpTo(slug, daf, amud) {
  navigateTo(slug, daf, amud);
  onNavigate?.(slug, daf, amud);
  // The user has committed to a specific page — get the drawer out of the
  // way so they can see the result immediately.
  close();
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
