// URL state + keyboard navigation.
// All chrome / drawer / picker logic lives in drawer.js.

import {
  getTractate, nextAmud, prevAmud, clampLocation,
} from './tractates.js';

let onNavigate = null; // (slug, daf, amud) — fired by keyboard
let getCurrent = null; // () → { slug, daf, amud } | null

export function initNav({ navigate, current }) {
  onNavigate = navigate;
  getCurrent = current;
  bindKeyboard();
}

// RTL convention: pressing left-arrow turns the page leftward = forward.
function bindKeyboard() {
  window.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const cur = getCurrent?.();
    if (!cur) return;
    const t = getTractate(cur.slug);
    if (!t) return;

    if (e.key === 'ArrowLeft') {
      const next = nextAmud(t, cur.daf, cur.amud);
      if (next) onNavigate?.(cur.slug, next.daf, next.amud);
      e.preventDefault();
    } else if (e.key === 'ArrowRight') {
      const prev = prevAmud(t, cur.daf, cur.amud);
      if (prev) onNavigate?.(cur.slug, prev.daf, prev.amud);
      e.preventDefault();
    }
  });
}

// Programmatic helpers used by main.js for 3-finger swipe + keyboard
export function stepNext() {
  const cur = getCurrent?.();
  if (!cur) return;
  const t = getTractate(cur.slug);
  if (!t) return;
  const n = nextAmud(t, cur.daf, cur.amud);
  if (n) onNavigate?.(cur.slug, n.daf, n.amud);
}

export function stepPrev() {
  const cur = getCurrent?.();
  if (!cur) return;
  const t = getTractate(cur.slug);
  if (!t) return;
  const p = prevAmud(t, cur.daf, cur.amud);
  if (p) onNavigate?.(cur.slug, p.daf, p.amud);
}

// ── URL state ──

export function readUrlLocation() {
  const params = new URLSearchParams(window.location.search);
  const slug = params.get('m');
  const daf = parseInt(params.get('d') || '', 10);
  const amud = params.get('a') === 'b' ? 'b' : 'a';
  if (slug && getTractate(slug) && daf >= 2) {
    const t = getTractate(slug);
    const c = clampLocation(t, daf, amud);
    return { slug, daf: c.daf, amud: c.amud };
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

export function clearUrlLocation() {
  const url = new URL(window.location.href);
  url.searchParams.delete('m');
  url.searchParams.delete('d');
  url.searchParams.delete('a');
  window.history.replaceState({}, '', url);
}
