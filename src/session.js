// Single source of truth for session state: open masechtos, current page per
// open masechta, and the marks (anchor + trail) used for "lookup dive"
// navigation.
//
// All mutations go through this module. Subscribers receive a snapshot when
// state changes so the UI can re-render.

import { loadSession, saveSession, emptySession } from './storage.js';
import { getTractate } from './tractates.js';

const ANCHOR_CLEAR_MS = 10 * 60 * 1000; // 10 minutes at anchor → clear marks

let state = loadSession() || emptySession();
const subscribers = new Set();

let anchorTimer = null;

export function getState() {
  return state;
}

export function subscribe(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

function notify() {
  saveSession(state);
  for (const fn of subscribers) fn(state);
}

function samePos(a, b) {
  return a && b && a.slug === b.slug && a.daf === b.daf && a.amud === b.amud;
}

// ── Public API ──

export function isOpen(slug) {
  return state.open.includes(slug);
}

export function currentPosition() {
  if (!state.current) return null;
  const page = state.pages[state.current];
  if (!page) return null;
  return { slug: state.current, daf: page.daf, amud: page.amud };
}

// Add a masechta and switch to it. If already open, just switch.
// Newly added masechtos always start at 2a (bookmarks → future feature).
export function openMasechta(slug, opts = {}) {
  const t = getTractate(slug);
  if (!t) return;

  const wasOpen = state.open.includes(slug);
  if (!wasOpen) {
    state.open = [...state.open, slug];
    state.pages = { ...state.pages, [slug]: { daf: 2, amud: 'a' } };
  }

  // Switching off the current masechta drops a mark at the prior position.
  // Adding a brand-new masechta also counts as a navigation.
  switchTo(slug, opts);
}

// Switch the active masechta to one already open (or just-opened).
// Drops a mark at the prior position if it differs.
export function switchTo(slug, opts = {}) {
  if (!state.open.includes(slug)) return;
  const prev = currentPosition();
  state.current = slug;
  const page = state.pages[slug];
  const next = { slug, daf: page.daf, amud: page.amud };
  recordNavigation(prev, next, opts);
  notify();
}

// Navigate within the current masechta (or a specified one) to a new page.
// Drops a mark at the prior position.
export function navigateTo(slug, daf, amud, opts = {}) {
  if (!state.open.includes(slug)) {
    // First time opening: add it
    state.open = [...state.open, slug];
  }
  const prev = currentPosition();
  state.current = slug;
  state.pages = { ...state.pages, [slug]: { daf, amud } };
  const next = { slug, daf, amud };
  recordNavigation(prev, next, opts);
  notify();
}

// Close a masechta. Removes its slider, page, and any marks belonging to it.
// If the closed masechta was current, switch to the most recent other open
// one (the previous entry in `open`). If none remain, current becomes null.
export function closeMasechta(slug) {
  if (!state.open.includes(slug)) return;

  const closingCurrent = state.current === slug;
  const idx = state.open.indexOf(slug);

  state.open = state.open.filter(s => s !== slug);
  const { [slug]: _, ...restPages } = state.pages;
  state.pages = restPages;

  // Drop marks belonging to the closed masechta (anchor included)
  if (state.marks.anchor?.slug === slug) {
    state.marks.anchor = null;
    state.marks.anchorEnteredAt = null;
    cancelAnchorTimer();
  }
  state.marks.trail = state.marks.trail.filter(m => m.slug !== slug);

  if (closingCurrent) {
    // Switch to the masechta that was before this one in the list
    // (or the next one if it was first)
    const fallback = state.open[idx - 1] ?? state.open[0] ?? null;
    state.current = fallback;
    if (state.current) startAnchorTimerIfAtAnchor();
  }

  notify();
}

// ── Marks logic ──

function recordNavigation(prev, next, opts) {
  if (!prev) return;
  if (samePos(prev, next)) return;

  const marks = state.marks;

  // Sequential reading (3-finger swipe / arrows) shouldn't drop marks.
  // Only jumps (slider, picker, mark tap) do.
  if (!opts.skipMark) {
    if (!marks.anchor) {
      marks.anchor = { ...prev };
    } else {
      const isAnchor = samePos(prev, marks.anchor);
      const inTrail = marks.trail.some(m => samePos(m, prev));
      if (!isAnchor && !inTrail) {
        marks.trail = [...marks.trail, { ...prev }];
      }
    }
  }

  // The anchor timer always tracks "am I currently at the anchor?", regardless
  // of how I got there — so a sequential swipe back to anchor should arm it.
  if (samePos(next, marks.anchor)) {
    marks.anchorEnteredAt = Date.now();
    startAnchorTimer();
  } else if (marks.anchor) {
    marks.anchorEnteredAt = null;
    cancelAnchorTimer();
  }
}

function startAnchorTimer() {
  cancelAnchorTimer();
  anchorTimer = setTimeout(() => {
    clearMarks();
  }, ANCHOR_CLEAR_MS);
}

function cancelAnchorTimer() {
  if (anchorTimer) {
    clearTimeout(anchorTimer);
    anchorTimer = null;
  }
}

function startAnchorTimerIfAtAnchor() {
  const cur = currentPosition();
  if (cur && state.marks.anchor && samePos(cur, state.marks.anchor)) {
    if (!state.marks.anchorEnteredAt) {
      state.marks.anchorEnteredAt = Date.now();
    }
    // Re-arm timer for the remaining time, or full duration if just entered
    const elapsed = Date.now() - state.marks.anchorEnteredAt;
    const remaining = Math.max(0, ANCHOR_CLEAR_MS - elapsed);
    cancelAnchorTimer();
    anchorTimer = setTimeout(clearMarks, remaining);
  }
}

export function clearMarks() {
  state.marks = { anchor: null, trail: [], anchorEnteredAt: null };
  cancelAnchorTimer();
  notify();
}

// Re-arm the timer on app load if we restored a session sitting at the anchor
export function rehydrateTimers() {
  startAnchorTimerIfAtAnchor();
}

// All marks for a specific masechta (anchor + trail entries that match).
// Returned in insertion order: anchor first, then trail.
export function marksForMasechta(slug) {
  const marks = state.marks;
  const out = [];
  if (marks.anchor && marks.anchor.slug === slug) out.push(marks.anchor);
  for (const m of marks.trail) {
    if (m.slug === slug) out.push(m);
  }
  return out;
}

export function hasAnyMarks() {
  return !!state.marks.anchor || state.marks.trail.length > 0;
}
