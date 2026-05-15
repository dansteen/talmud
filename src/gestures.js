import {
  canvas,
  applyDelta, animateTo, scheduleQualityRender,
  transformForHome, transformForRegion,
  findRegionAtTap, effectiveScale, isFullyZoomedOut,
} from './viewer.js';
import { getRegionZoomPx, setRegionZoomPx } from './storage.js';

// Default on-screen reading size (CSS px) used the first time the
// user double-taps a fontSize without a saved preference. Tuned for
// comfortable Hebrew reading on a phone.
const DEFAULT_READING_FONT_PX = 32;

// Pinch is a fine adjustment to the active fontSize's preferred
// reading size — we damp the raw finger-distance change so it feels
// tunable rather than swingy.
const PINCH_SENSITIVITY = 0.5;

// How long after a zoom event (double-tap or pinch) a subsequent
// pinch is still considered "tuning" that should update the saved
// reading-size preference for the most-recently double-tapped
// fontSize. Each pinch resets the timer so a continuous string of
// pinches keeps the window open.
const ZOOM_TUNE_WINDOW_MS = 4000;

// Touch tracking ────────────────────────────────────────────────────
const touches = new Map();
const touchStarts = new Map();
let gestureStartTime = 0;
let hasMoved = false;
const MOVE_THRESHOLD = 8;

// Single-finger drag state — incremental pan when zoomed.
let prevSingleX = 0, prevSingleY = 0;
// Per-gesture direction lock for single-finger pan. Set on the first
// move that crosses PAN_DECISION_PX from the touch's start position:
//   'v'    → only vertical movement passes (kills horizontal jitter
//            during vertical reading scrolls)
//   'h'    → only horizontal movement passes
//   'free' → both axes pass (diagonal intent)
// Reset to null on every touchstart.
let panDirection = null;
let panStartX = 0, panStartY = 0;
const PAN_DECISION_PX = 12;   // distance from start before we decide
const PAN_LOCK_RATIO = 2;     // one axis must exceed the other by this

// Double-tap detection
const doubleTap = { time: 0, x: 0, y: 0 };
const DOUBLE_TAP_MS = 280;
const DOUBLE_TAP_PX = 35;

// Three-finger swipe (prev/next page)
const SWIPE_TIME_MS = 600;
const SWIPE_DISTANCE_PX = 60;

// Two-finger pinch state
let prevMidX = 0, prevMidY = 0, prevDist = 0;
let didPinch = false;

// Interaction state ────────────────────────────────────────────────
//
// `currentFontSize` is the active fontSize the user has zoomed into
// (null when home / fully zoomed out). It's set on a double-tap and
// cleared when the user lands fully zoomed out via pinch.
//
// `lastZoomEventTime` resets on every zoom event (double-tap OR end
// of pinch). A pinch whose start is within ZOOM_TUNE_WINDOW_MS of
// this time persists its result as the new preferred reading size
// for `currentFontSize`.
let currentFontSize = null;
let lastZoomEventTime = 0;
// Most recent findRegionAtTap result — populated only on double-tap,
// so the debug panel can show what area is currently focused.
let currentTap = null;

let onPrev = null;
let onNext = null;

// Notify any listeners (the debug panel) that the interaction state
// changed. Keep this lean — the listener pulls saved settings etc.
// from storage on its own.
function emitZoomState() {
  document.dispatchEvent(new CustomEvent('regionzoom', {
    detail: {
      currentFontSize,
      lastZoomEventTime,
      tuneWindowMs: ZOOM_TUNE_WINDOW_MS,
      currentTap: currentTap ? {
        regionId: currentTap.region?.id ?? null,
        bbox:     currentTap.region?.bbox ?? null,
        fontSize: currentTap.fontSize,
        pdfX:     currentTap.pdfX,
        pdfY:     currentTap.pdfY,
      } : null,
    },
  }));
}

function twoTouchState() {
  const pts = [...touches.values()];
  const dx = pts[1].x - pts[0].x;
  const dy = pts[1].y - pts[0].y;
  return {
    dist: Math.sqrt(dx * dx + dy * dy),
    midX: (pts[0].x + pts[1].x) / 2,
    midY: (pts[0].y + pts[1].y) / 2,
  };
}

function onTouchStart(e) {
  e.preventDefault();
  for (const t of e.changedTouches) {
    touches.set(t.identifier, { x: t.clientX, y: t.clientY });
    touchStarts.set(t.identifier, { x: t.clientX, y: t.clientY });
  }
  hasMoved = false;
  if (touches.size >= 1 && gestureStartTime === 0) gestureStartTime = Date.now();
  if (touches.size === 1) {
    const t = touches.values().next().value;
    prevSingleX = t.x;
    prevSingleY = t.y;
    panStartX = t.x;
    panStartY = t.y;
    panDirection = null;
  }
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

  // Single finger: pan only when zoomed; reading-mode no-op at home.
  if (count === 1) {
    if (currentFontSize !== null) {
      const t = touches.values().next().value;

      // Decide a direction lock the first time the finger has moved
      // PAN_DECISION_PX from where it touched down. The lock kills
      // small horizontal jitter while reading vertically (and vice
      // versa). A diagonal-intent gesture (neither axis dominates by
      // PAN_LOCK_RATIO) goes "free" and pans on both axes.
      if (panDirection === null) {
        const totalDx = t.x - panStartX;
        const totalDy = t.y - panStartY;
        if (totalDx * totalDx + totalDy * totalDy >= PAN_DECISION_PX * PAN_DECISION_PX) {
          const adx = Math.abs(totalDx);
          const ady = Math.abs(totalDy);
          if (ady > PAN_LOCK_RATIO * adx)      panDirection = 'v';
          else if (adx > PAN_LOCK_RATIO * ady) panDirection = 'h';
          else                                 panDirection = 'free';
          // Flush the accumulated delta from the dead-zone period in
          // the chosen direction, then continue incrementally below.
          let dx = totalDx, dy = totalDy;
          if (panDirection === 'v') dx = 0;
          else if (panDirection === 'h') dy = 0;
          if (dx !== 0 || dy !== 0) applyDelta(dx, dy, 1, 0, 0);
          prevSingleX = t.x;
          prevSingleY = t.y;
        }
        return;
      }

      let dx = t.x - prevSingleX;
      let dy = t.y - prevSingleY;
      if (panDirection === 'v') dx = 0;
      else if (panDirection === 'h') dy = 0;
      if (dx !== 0 || dy !== 0) applyDelta(dx, dy, 1, 0, 0);
      prevSingleX = t.x;
      prevSingleY = t.y;
    }
    return;
  }

  // Two fingers: pinch only when zoomed. At home, ignore.
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
  // 3+ fingers: wait for release to detect a swipe.
}

function onTouchEnd(e) {
  e.preventDefault();
  const countBefore = touches.size;
  const wasOneFinger = countBefore === 1;
  const wasThreeFingers = countBefore >= 3;

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
    if (didPinch) {
      const now = Date.now();
      const withinWindow = now - lastZoomEventTime <= ZOOM_TUNE_WINDOW_MS;
      const zoomedOut = isFullyZoomedOut();
      if (zoomedOut) {
        // Pinch landed fully zoomed out — drop the active fontSize.
        // (Per-rule exception: don't persist this as a saved level.)
        currentFontSize = null;
        currentTap = null;
      } else if (withinWindow && currentFontSize !== null) {
        setRegionZoomPx(currentFontSize, currentFontSize * effectiveScale());
      }
      lastZoomEventTime = now;
      didPinch = false;
      emitZoomState();
    }
    scheduleQualityRender();
    prevDist = 0;
    gestureStartTime = 0;
  } else if (touches.size === 1) {
    prevDist = 0;
    // Anchor incremental pan on the remaining finger so the next
    // move doesn't compute a delta from a stale position, and reset
    // the direction lock — the remaining finger starts a fresh
    // single-finger gesture.
    const t = touches.values().next().value;
    prevSingleX = t.x;
    prevSingleY = t.y;
    panStartX = t.x;
    panStartY = t.y;
    panDirection = null;
  }
}

// Three-finger swipe — direction is taken from the sign of the
// average horizontal delta. Diagonals count (vertical component
// is ignored as long as the horizontal travel exceeds the threshold).
function detectThreeFingerSwipe() {
  const elapsed = Date.now() - gestureStartTime;
  if (elapsed > SWIPE_TIME_MS) return;
  let sumDx = 0, n = 0;
  for (const [id, cur] of touches) {
    const start = touchStarts.get(id);
    if (!start) continue;
    sumDx += cur.x - start.x;
    n++;
  }
  if (n < 3) return;
  const dx = sumDx / n;
  if (Math.abs(dx) < SWIPE_DISTANCE_PX) return;
  // RTL convention: swiping right = previous, left = next.
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
    // Single tap is a no-op.
  }
}

function handleDoubleTap(clientX, clientY) {
  const tap = findRegionAtTap(clientX, clientY);
  // No usable text item to resolve the tap → no-op.
  if (!tap || !(tap.fontSize > 0)) return;

  // Re-tap with the same fontSize → return home.
  if (currentFontSize !== null && tap.fontSize === currentFontSize) {
    goHome();
    return;
  }

  // Zoom in from home, or hop to a different-fontSize region.
  const targetPx = getRegionZoomPx(tap.fontSize) ?? DEFAULT_READING_FONT_PX;
  const target = transformForRegion(tap.region, tap.pdfX, tap.pdfY, tap.fontSize, targetPx);
  if (!target) return;
  currentFontSize = tap.fontSize;
  currentTap = tap;
  lastZoomEventTime = Date.now();
  emitZoomState();
  animateTo(target.x, target.y, target.scale);
}

function goHome() {
  currentFontSize = null;
  currentTap = null;
  lastZoomEventTime = 0;
  emitZoomState();
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
  canvas.addEventListener('touchstart',  onTouchStart, { passive: false });
  canvas.addEventListener('touchmove',   onTouchMove,  { passive: false });
  canvas.addEventListener('touchend',    onTouchEnd,   { passive: false });
  canvas.addEventListener('touchcancel', onTouchEnd,   { passive: false });

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
