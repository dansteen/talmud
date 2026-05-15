// Drawer UI: peek, pull-up drawer, sliders view, picker view, welcome screen.
// All DOM concerns for the new chrome live here.

import {
  SEDARIM, getTractate,
  amudToIndex, indexToAmud, lastAmudIndex, dafLabel,
} from './tractates.js';
import {
  getState, subscribe, addMasechta, switchTo, closeMasechta,
  navigateTo, marksForMasechta, currentPosition,
} from './session.js';
import { t, LOCALES, getLocale, setLocale, onLocaleChange } from './i18n.js';
import { getDebugEnabled, setDebugEnabled } from './storage.js';
import { setDebugVisible } from './viewer.js';

let onNavigate = null; // (slug, daf, amud) — called when user picks a new page
let onShowWelcome = null; // () — called when no masechta is open
let onHideWelcome = null;

// ── DOM refs (resolved in init) ──
let peekEl, peekHandleEl, drawerEl, scrimEl;
let slidersViewEl, pickerViewEl, settingsViewEl;
let sliderStackEl, addBtn, settingsBtn;
let pickerListEl, pickerBackBtn;
let settingsBackBtn, settingsDebugToggle;
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
  settingsViewEl = document.getElementById('settings-view');
  sliderStackEl = document.getElementById('slider-stack');
  addBtn = document.getElementById('add-masechta-btn');
  settingsBtn = document.getElementById('settings-btn');
  pickerListEl = document.getElementById('picker-list');
  pickerBackBtn = document.getElementById('picker-back-btn');
  settingsBackBtn = document.getElementById('settings-back-btn');
  settingsDebugToggle = document.getElementById('settings-debug-toggle');
  welcomeEl = document.getElementById('welcome');
  welcomeOpenBtn = document.getElementById('welcome-open-btn');

  bindPeek();
  bindDrawer();
  bindPicker();
  bindSettings();
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

// ── Language dropdowns (welcome + drawer) ──
//
// Each dropdown is a host element containing:
//   - a toggle button showing the current flag + name
//   - a menu of <button data-code="..."> options, hidden by default
// Tapping the toggle opens the menu; tapping outside closes it.
// "Open upward" so the menu doesn't get cut off by the drawer/screen edge.

function buildLangPickers() {
  for (const id of ['welcome-lang', 'drawer-lang']) {
    const host = document.getElementById(id);
    if (!host) continue;
    host.innerHTML = '';

    const toggle = document.createElement('button');
    toggle.className = 'lang-dropdown-toggle';
    toggle.type = 'button';
    toggle.setAttribute('aria-haspopup', 'listbox');
    toggle.setAttribute('aria-expanded', 'false');

    const menu = document.createElement('div');
    menu.className = 'lang-dropdown-menu hidden';
    menu.setAttribute('role', 'listbox');
    for (const loc of LOCALES) {
      const opt = document.createElement('button');
      opt.type = 'button';
      opt.className = 'lang-option';
      opt.dataset.code = loc.code;
      opt.setAttribute('role', 'option');
      opt.innerHTML =
        `<span class="lang-flag">${loc.flag}</span>` +
        `<span class="lang-name">${loc.name}</span>`;
      opt.addEventListener('click', e => {
        e.stopPropagation();
        setLocale(loc.code);
        closeLangMenu(host);
      });
      menu.appendChild(opt);
    }

    toggle.addEventListener('click', e => {
      e.stopPropagation();
      const isOpen = host.classList.contains('open');
      closeAllLangMenus();
      if (!isOpen) openLangMenu(host);
    });

    host.appendChild(toggle);
    host.appendChild(menu);
  }

  // One global listener closes any open menu when the user taps outside.
  if (!document.body.dataset.langCloseBound) {
    document.body.dataset.langCloseBound = '1';
    document.addEventListener('pointerdown', e => {
      if (!e.target.closest('.lang-dropdown')) closeAllLangMenus();
    });
  }

  renderLangPickers();
}

function openLangMenu(host) {
  host.classList.add('open');
  host.querySelector('.lang-dropdown-toggle')?.setAttribute('aria-expanded', 'true');
  host.querySelector('.lang-dropdown-menu')?.classList.remove('hidden');
}

function closeLangMenu(host) {
  host.classList.remove('open');
  host.querySelector('.lang-dropdown-toggle')?.setAttribute('aria-expanded', 'false');
  host.querySelector('.lang-dropdown-menu')?.classList.add('hidden');
}

function closeAllLangMenus() {
  for (const host of document.querySelectorAll('.lang-dropdown.open')) {
    closeLangMenu(host);
  }
}

function renderLangPickers() {
  const cur = getLocale();
  const locale = LOCALES.find(l => l.code === cur) || LOCALES[0];
  for (const toggle of document.querySelectorAll('.lang-dropdown-toggle')) {
    toggle.innerHTML =
      `<span class="lang-flag">${locale.flag}</span>` +
      `<span class="lang-name">${locale.name}</span>` +
      `<span class="lang-chevron" aria-hidden="true">▾</span>`;
  }
  for (const opt of document.querySelectorAll('.lang-option')) {
    opt.classList.toggle('active', opt.dataset.code === cur);
  }
}

// ── Open / close ──

const VIEW_SLIDERS = 'sliders';
const VIEW_PICKER = 'picker';
const VIEW_SETTINGS = 'settings';

let isOpen = false;
let currentView = VIEW_SLIDERS;

// Scroll positions per scrollable view, captured at close time and restored
// on the next open. The drawer's display:none toggle would otherwise reset
// scrollTop on the inner overflow containers.
let savedSliderScroll = 0;
let savedPickerScroll = 0;

function open(view = VIEW_SLIDERS) {
  // If nothing is open, force picker — empty sliders view is useless.
  if (getState().open.length === 0) view = VIEW_PICKER;
  currentView = view;
  showView();
  drawerEl.classList.remove('hidden');
  scrimEl.classList.remove('hidden');
  // Force reflow so the slide-in transition runs
  void drawerEl.offsetHeight;
  drawerEl.classList.add('open');
  scrimEl.classList.add('visible');
  isOpen = true;
  restoreScrollForView(currentView);
}

function close() {
  saveScrollForView(currentView);
  closeAllLangMenus();
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
  slidersViewEl.classList.toggle('hidden', currentView !== VIEW_SLIDERS);
  pickerViewEl.classList.toggle('hidden', currentView !== VIEW_PICKER);
  settingsViewEl.classList.toggle('hidden', currentView !== VIEW_SETTINGS);
}

function switchView(next) {
  if (currentView === next) return;
  saveScrollForView(currentView);
  currentView = next;
  showView();
  restoreScrollForView(currentView);
}

function showPicker()   { switchView(VIEW_PICKER); }
function showSliders()  { switchView(VIEW_SLIDERS); }
function showSettings() {
  // Re-sync from storage in case the setting changed via another path.
  if (settingsDebugToggle) settingsDebugToggle.checked = getDebugEnabled();
  switchView(VIEW_SETTINGS);
}

function saveScrollForView(view) {
  if (view === VIEW_SLIDERS && sliderStackEl) savedSliderScroll = sliderStackEl.scrollTop;
  else if (view === VIEW_PICKER && pickerListEl) savedPickerScroll = pickerListEl.scrollTop;
}

function restoreScrollForView(view) {
  // requestAnimationFrame waits for layout so scrollTop assignments take.
  requestAnimationFrame(() => {
    if (view === VIEW_SLIDERS && sliderStackEl) sliderStackEl.scrollTop = savedSliderScroll;
    else if (view === VIEW_PICKER && pickerListEl) pickerListEl.scrollTop = savedPickerScroll;
  });
}

// ── Peek: pull the drawer up with the finger ──
//
// No tap activation and no horizontal-swipe activation. The drawer
// follows the finger upward; on release we commit (open fully) if the
// drag crossed a fraction of the drawer height or if the release had
// enough upward velocity (a flick). Otherwise the drawer sinks back
// to closed.

function bindPeek() {
  let startX = null;
  let startY = null;
  let dragging = false;   // drawer is currently following the finger
  let abandoned = false;  // gesture started horizontally; ignore for the rest
  let drawerH = 0;        // drawer height captured at the moment of activation
  let samples = [];       // recent {t, y} for velocity at release

  const ACTIVATION_PX = 8;             // upward travel before the drawer engages
  const VERTICAL_DOMINANCE_RATIO = 1.5;
  const COMMIT_FRACTION = 0.4;         // pulled at least this fraction of H → open
  const FLICK_VELOCITY = 0.6;          // px/ms upward → open regardless of distance
  const VELOCITY_WINDOW_MS = 120;

  const resetGestureState = () => {
    startX = null;
    startY = null;
    dragging = false;
    abandoned = false;
    drawerH = 0;
    samples = [];
  };

  peekEl.addEventListener('pointerdown', e => {
    e.preventDefault();
    startX = e.clientX;
    startY = e.clientY;
    dragging = false;
    abandoned = false;
    samples = [{ t: performance.now(), y: e.clientY }];
    try { peekEl.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  });

  peekEl.addEventListener('pointermove', e => {
    if (startY == null || abandoned) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    const adx = Math.abs(dx);
    const ady = Math.abs(dy);

    samples.push({ t: performance.now(), y: e.clientY });
    if (samples.length > 12) samples.shift();

    if (!dragging) {
      // A clearly-horizontal early move kills the gesture before activation.
      if (adx > 6 && adx > ady) {
        abandoned = true;
        return;
      }
      if (dy < -ACTIVATION_PX && ady > VERTICAL_DOMINANCE_RATIO * adx) {
        dragging = true;
        beginPull();
      } else {
        return;
      }
    }

    // Drawer follows the finger upward, clamped to its own height.
    const liftedBy = Math.max(0, Math.min(drawerH, -dy));
    drawerEl.style.transform = `translateY(${drawerH - liftedBy}px)`;
    scrimEl.style.opacity = (liftedBy / drawerH).toFixed(3);
  });

  function beginPull() {
    // Choose view, prep DOM, and restore scroll so it's correct by the time
    // the drawer is up. The .dragging class kills the CSS transition so
    // the drawer tracks the finger 1:1 instead of animating after each move.
    const view = getState().open.length === 0 ? VIEW_PICKER : VIEW_SLIDERS;
    currentView = view;
    showView();
    drawerEl.classList.remove('hidden');
    scrimEl.classList.remove('hidden');
    drawerEl.classList.add('dragging');
    drawerH = drawerEl.offsetHeight || window.innerHeight * 0.55;
    drawerEl.style.transform = `translateY(${drawerH}px)`;
    scrimEl.style.opacity = '0';
    restoreScrollForView(currentView);
  }

  function release(e) {
    if (!dragging) {
      resetGestureState();
      return;
    }

    const dy = (e?.clientY ?? startY) - startY;
    const liftedBy = Math.max(0, Math.min(drawerH, -dy));
    const fraction = drawerH > 0 ? liftedBy / drawerH : 0;

    // Velocity from samples within the trailing window.
    const now = performance.now();
    let velocity = 0;
    const recent = samples.filter(s => now - s.t <= VELOCITY_WINDOW_MS);
    if (recent.length >= 2) {
      const first = recent[0], last = recent[recent.length - 1];
      const dt = last.t - first.t;
      if (dt > 0) velocity = (last.y - first.y) / dt;
    }
    const flickedUp = velocity < -FLICK_VELOCITY;

    if (flickedUp || fraction > COMMIT_FRACTION) {
      commitOpen();
    } else {
      abortPull();
    }
    resetGestureState();
  }

  function commitOpen() {
    // Re-enable the transition and let CSS animate from the current
    // inline translateY to translateY(0) (.open). Clearing the inline
    // transform in the same tick as adding .open avoids a snap back to
    // closed before the open transition runs.
    drawerEl.classList.remove('dragging');
    drawerEl.style.transform = '';
    drawerEl.classList.add('open');
    scrimEl.style.opacity = '';
    scrimEl.classList.add('visible');
    isOpen = true;
  }

  function abortPull() {
    // Animate back to closed, then hide once the transition has settled.
    drawerEl.classList.remove('dragging');
    drawerEl.style.transform = '';
    scrimEl.style.opacity = '';
    scrimEl.classList.remove('visible');
    isOpen = false;
    setTimeout(() => {
      if (!isOpen) {
        drawerEl.classList.add('hidden');
        scrimEl.classList.add('hidden');
      }
    }, 280);
  }

  peekEl.addEventListener('pointerup', release);
  peekEl.addEventListener('pointercancel', e => {
    if (dragging) abortPull();
    resetGestureState();
  });
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
  settingsBtn.addEventListener('click', showSettings);
}

// ── Picker ──

function bindPicker() {
  pickerBackBtn.addEventListener('click', showSliders);
}

// ── Settings ──

function bindSettings() {
  settingsBackBtn.addEventListener('click', showSliders);

  settingsDebugToggle.checked = getDebugEnabled();
  settingsDebugToggle.addEventListener('change', () => {
    const v = settingsDebugToggle.checked;
    setDebugEnabled(v);
    setDebugVisible(v);
  });
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
    // Newly added masechtos wait for the user to pick a page — we add the
    // slider but don't switch/load anything. The user scrubs to commit;
    // jumpTo will then make it current and trigger the actual page load.
    addMasechta(slug);
    showSliders();
    // Bring the new slider into view so the user can immediately scrub it
    // without hunting through a long stack.
    scrollSliderIntoView(slug);
  }
}

// ── Welcome screen ──

function bindWelcome() {
  // open() defaults to VIEW_SLIDERS but auto-flips to VIEW_PICKER when
  // nothing is open. That gives us: first-time → picker; mid-session
  // (pending pick) → sliders to continue.
  welcomeOpenBtn.addEventListener('click', () => open());
}

// ── Render: sliders + picker tile selection state ──

function render(state) {
  // Welcome stays up until the user has actually committed to a page —
  // i.e., a masechta is current. A pending add (slider exists but no
  // current) leaves welcome up so closing the drawer without scrubbing
  // doesn't reveal a blank viewer.
  if (state.open.length === 0 || !state.current) {
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

  // Drop the empty-state placeholder if it's still in the DOM from a prior
  // render when nothing was open.
  sliderStackEl.querySelector('.slider-empty')?.remove();

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

  // Reconcile in place — walk state.open and only touch the DOM when a row
  // is missing or out of position. Re-appending every row via a fragment
  // would detach them all momentarily and reset sliderStackEl.scrollTop,
  // which we need to preserve across renders (e.g., on switchTo / jumpTo
  // when close() then captures the scroll position).
  let cursor = sliderStackEl.firstElementChild;
  for (const slug of state.open) {
    let row = existing.get(slug);
    if (!row) {
      row = createSliderRow(slug);
      sliderStackEl.insertBefore(row, cursor);
    } else if (row !== cursor) {
      sliderStackEl.insertBefore(row, cursor);
    } else {
      cursor = cursor.nextElementSibling;
    }
    updateSliderRow(row, slug, state);
  }
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
  open(VIEW_PICKER);
}
