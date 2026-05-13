import {
  canvas,
  applyDelta, animateTo, scheduleQualityRender,
  transformForHome, transformForArea,
  findAreaAtPoint, effectiveScale,
} from './viewer.js';
import { getRegionZoomPx, setRegionZoomPx } from './storage.js';

// On-screen reading size (CSS px) used the first time the user
// double-taps an area whose fontSize has no saved preference.
const DEFAULT_READING_FONT_PX = 32;

// Pinch is a fine adjustment to the per-fontSize reading size, not the
// primary zoom. We damp the raw finger-distance change so it feels
// tunable rather than swingy.
const PINCH_SENSITIVITY = 0.5;

// How long after a double-tap a pinch is still considered "tuning"
// that should update the saved preference for the active fontSize.
const PINCH_SAVE_WINDOW_MS = 4000;

// Active touches: identifier → {x, y}
const touches = new Map();
const touchStarts = new Map();
let gestureStartTime = 0;
let hasMoved = false;

const MOVE_THRESHOLD = 8;

// Double-tap detection
const doubleTap = { time: 0, x: 0, y: 0 };
const DOUBLE_TAP_MS = 280;
const DOUBLE_TAP_PX = 35;

// 3-finger swipe (prev/next page)
const SWIPE_TIME_MS = 600;
const SWIPE_DISTANCE_PX = 60;

// 2-finger pinch state
let prevMidX = 0, prevMidY = 0, prevDist = 0;
let didPinch = false;

// The current "active" fontSize — set on a zoom-in double-tap, cleared
// on a zoom-out double-tap (same fontSize tapped again). null = home /
// zoomed-out / no active area. Drives the "same vs different fontSize"
// branch in handleDoubleTap and gates pinch behavior.
let currentFontSize = null;
// Timestamp of the most recent double-tap. Pinches that *start* within
// PINCH_SAVE_WINDOW_MS of this time will save the resulting zoom as
// the new preference for `currentFontSize`.
let lastDoubleTapTime = 0;

let onPrev = null;
let onNext = null;

function twoTouchState() {
  const pts = [...touches.values()];
  const dx = pts[1].x - pts[0].x;
  const dy = pts[1].y - pts[0].y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const midX = (pts[0].x + pts[1].x) / 2;
  const midY = (pts[0].y + pts[1].y) / 2;
  return { dist, midX, midY };
}

function onTouchStart(e) {
  e.preventDefault();
  for (const t of e.changedTouches) {
    touches.set(t.identifier, { x: t.clientX, y: t.clientY });
    touchStarts.set(t.identifier, { x: t.clientX, y: t.clientY });
  }
  hasMoved = false;
  if (touches.size >= 1 && gestureStartTime === 0) gestureStartTime = Date.now();
  if (touches.size === 2) {
    const s = twoTouchState();
    prevDist = s.dist;
    prevMidX = s.midX;
    prevMidY = s.midY;
  }
}

function onTouchMove(e) {
  e.preventDefault();
  for (const t of e.changedTouches) {
    if (!touches.has(t.identifier)) continue;
    touches.set(t.identifier, { x: t.clientX, y: t.clientY });
    const start = touchStarts.get(t.identifier);
    if (start) {
      const dx = t.clientX - start.x, dy = t.clientY - start.y;
      if (Math.sqrt(dx * dx + dy * dy) > MOVE_THRESHOLD) hasMoved = true;
    }
  }

  const count = touches.size;

  // Single finger never pans or zooms — reading mode.
  if (count === 1) return;

  // Pinch only works when zoomed into an area. Zoomed-out: no effect.
  if (count === 2 && currentFontSize !== null) {
    const s = twoTouchState();
    const rawDScale = prevDist > 0 ? s.dist / prevDist : 1;
    const dScale = 1 + (rawDScale - 1) * PINCH_SENSITIVITY;
    const dx = s.midX - prevMidX;
    const dy = s.midY - prevMidY;
    applyDelta(dx, dy, dScale, s.midX, s.midY);
    prevDist = s.dist;
    prevMidX = s.midX;
    prevMidY = s.midY;
    didPinch = true;
    return;
  }
  // 3+ fingers: wait for release to check for a swipe.
}

function onTouchEnd(e) {
  e.preventDefault();

  const countBefore = touches.size;
  const wasOneFinger = countBefore === 1;
  const wasThreeFingers = countBefore === 3;

  if (wasThreeFingers) detectThreeFingerSwipe();

  let liftedX = 0, liftedY = 0;
  for (const t of e.changedTouches) {
    if (touches.has(t.identifier)) {
      liftedX = t.clientX;
      liftedY = t.clientY;
    }
    touches.delete(t.identifier);
    touchStarts.delete(t.identifier);
  }

  if (wasOneFinger && !hasMoved) {
    handleTap(liftedX, liftedY);
  }

  if (touches.size === 0) {
    // If the pinch started shortly after a double-tap, persist the new
    // zoom as the preferred reading size for the active fontSize. This
    // is the "tune-after-double-tap" window the user described: tap to
    // zoom, then pinch within 4 sec to dial it in.
    if (didPinch && currentFontSize !== null) {
      const sinceTap = Date.now() - lastDoubleTapTime;
      if (sinceTap <= PINCH_SAVE_WINDOW_MS) {
        setRegionZoomPx(currentFontSize, currentFontSize * effectiveScale());
      }
      didPinch = false;
    }
    scheduleQualityRender();
    prevDist = 0;
    gestureStartTime = 0;
  } else if (touches.size === 1) {
    prevDist = 0;
  }
}

function detectThreeFingerSwipe() {
  const elapsed = Date.now() - gestureStartTime;
  if (elapsed > SWIPE_TIME_MS) return;

  let sumDx = 0, sumDy = 0, n = 0;
  for (const [id, cur] of touches) {
    const start = touchStarts.get(id);
    if (!start) continue;
    sumDx += cur.x - start.x;
    sumDy += cur.y - start.y;
    n++;
  }
  if (n < 3) return;
  const dx = sumDx / n;
  const dy = sumDy / n;

  if (Math.abs(dx) < SWIPE_DISTANCE_PX) return;
  if (Math.abs(dy) > Math.abs(dx) * 0.7) return;

  // RTL: swiping right = previous, left = next
  if (dx > 0) onPrev?.();
  else onNext?.();
}

function handleTap(clientX, clientY) {
  const now = Date.now();
  const dx = clientX - doubleTap.x;
  const dy = clientY - doubleTap.y;
  const dist = Math.sqrt(dx * dx + dy * dy);

  if (now - doubleTap.time < DOUBLE_TAP_MS && dist < DOUBLE_TAP_PX) {
    doubleTap.time = 0;
    handleDoubleTap(clientX, clientY);
  } else {
    doubleTap.time = now;
    doubleTap.x = clientX;
    doubleTap.y = clientY;
    // Single tap: no-op.
  }
}

function handleDoubleTap(clientX, clientY) {
  const area = findAreaAtPoint(clientX, clientY);
  // Tap on a gutter pixel (no area underneath, even with leeway) is
  // a no-op regardless of zoom state.
  if (!area || !(area.fontSize > 0)) return;

  // Already zoomed and the user tapped an area of the same fontSize
  // as the active one → return to home.
  if (currentFontSize !== null && area.fontSize === currentFontSize) {
    goHome();
    return;
  }

  // Either zooming in from home, or moving between areas of different
  // fontSize. In both cases, set the new active fontSize, start the
  // pinch-save window, and animate to the area at its stored (or
  // default) reading size.
  const targetPx = getRegionZoomPx(area.fontSize) ?? DEFAULT_READING_FONT_PX;
  const target = transformForArea(area, clientX, clientY, targetPx);
  if (!target) return;
  currentFontSize = area.fontSize;
  lastDoubleTapTime = Date.now();
  animateTo(target.x, target.y, target.scale);
}

function goHome() {
  currentFontSize = null;
  lastDoubleTapTime = 0;
  const { x, y, scale } = transformForHome();
  animateTo(x, y, scale);
}

export function returnHome() {
  goHome();
}

export function isZoomed() {
  return currentFontSize !== null;
}

export function initGestures({ prev, next } = {}) {
  onPrev = prev;
  onNext = next;

  canvas.addEventListener('touchstart', onTouchStart, { passive: false });
  canvas.addEventListener('touchmove', onTouchMove, { passive: false });
  canvas.addEventListener('touchend', onTouchEnd, { passive: false });
  canvas.addEventListener('touchcancel', onTouchEnd, { passive: false });

  if (new URLSearchParams(location.search).has('debugGestures')) {
    enableGestureDebug();
  }
}

function enableGestureDebug() {
  const log = document.createElement('div');
  log.id = 'gesture-debug';
  log.style.cssText = `
    position: fixed; top: 8px; left: 8px; z-index: 9999;
    pointer-events: none; font: 11px ui-monospace, monospace;
    color: white; background: rgba(0,0,0,0.7);
    padding: 4px 8px; border-radius: 4px;
    max-width: 90vw; word-break: break-all;
  `;
  log.textContent = 'gesture-debug ready';
  document.body.appendChild(log);

  let n = 0;
  const note = (label, color) => {
    n++;
    log.textContent = `${n}: ${label} fs=${currentFontSize ?? '-'}`;
    log.style.borderLeft = `4px solid ${color}`;
  };

  canvas.addEventListener('touchstart', e => note(
    `start n=${e.touches.length} tr=${touches.size}`, '#0af'
  ), { passive: true });
  canvas.addEventListener('touchmove', e => note(
    `move n=${e.touches.length} moved=${hasMoved}`, '#0a8'
  ), { passive: true });
  canvas.addEventListener('touchend', e => note(
    `end remaining=${e.touches.length}`, '#0af'
  ), { passive: true });
}
