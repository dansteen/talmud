import {
  canvas,
  applyDelta, animateTo, scheduleQualityRender,
  transformForHome, transformForRegion, transformForScroll,
  findRegionAtPoint, effectiveScale, regionExtendsBeyondViewport,
} from './viewer.js';
import { getRegionZoomPx, setRegionZoomPx } from './storage.js';

// Default on-screen font size (CSS px) used when the user double-taps a
// region whose font size has no saved preference yet. Comfortable Hebrew
// reading size on a phone.
const DEFAULT_READING_FONT_PX = 32;

// Pinch sensitivity. Pinches are used as a *fine adjustment* to a region's
// preferred reading size, not as a primary zoom — so we damp the raw
// finger-distance change. 0.5 = half the natural responsiveness.
const PINCH_SENSITIVITY = 0.5;

// Fraction of the viewport to pan when double-tapping the focused region
// off-centre. Same fraction applies to both axes.
const SCROLL_FRAC = 0.7;

// Fraction of the viewport (each axis) treated as the "centre" zone for
// same-region double-tap. A tap whose offset from centre is smaller than
// this on both axes counts as a centre tap → home.
const CENTER_DEAD_ZONE = 0.10;

// Active touches: identifier → {x, y}
//
// We use touch events instead of pointer events because, despite the spec,
// pointer events on the canvas don't reliably fire on Android Chrome with
// `touch-action: none`. Touch events do fire reliably and carry all the
// information we need.
const touches = new Map();
const touchStarts = new Map();
let gestureStartTime = 0;
let hasMoved = false;

const MOVE_THRESHOLD = 8;

// Double-tap tracking
const doubleTap = { time: 0, x: 0, y: 0 };
const DOUBLE_TAP_MS = 280;
const DOUBLE_TAP_PX = 35;

// Three-finger swipe thresholds
const SWIPE_TIME_MS = 600;
const SWIPE_DISTANCE_PX = 60;

// Two-finger pinch/pan state
let prevMidX = 0, prevMidY = 0, prevDist = 0;
let lastPinchMidX = 0, lastPinchMidY = 0;
let didPinch = false;

// The region the user has zoomed into via double-tap or pinch. Drives the
// "same vs different region" branch in handleDoubleTap and is also the
// region we apply directional taps to when the user taps whitespace. Both
// cleared when the user goes home.
let currentRegion = null;
let currentRegionId = null;

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

  // Single finger: never pans, never zooms — reading mode.
  if (count === 1) return;

  if (count === 2) {
    const s = twoTouchState();
    // Damp the scale ratio so pinches feel like fine adjustment.
    const rawDScale = prevDist > 0 ? s.dist / prevDist : 1;
    const dScale = 1 + (rawDScale - 1) * PINCH_SENSITIVITY;
    const dx = s.midX - prevMidX;
    const dy = s.midY - prevMidY;
    applyDelta(dx, dy, dScale, s.midX, s.midY);
    prevDist = s.dist;
    prevMidX = s.midX;
    prevMidY = s.midY;
    lastPinchMidX = s.midX;
    lastPinchMidY = s.midY;
    didPinch = true;
    return;
  }

  // 3+ fingers: don't pan/zoom — wait for release to detect a swipe.
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
    if (didPinch) {
      // Save the pinch result as the preferred on-screen size for the
      // region under the pinch midpoint, so future double-taps on regions
      // of similar font size land at this zoom level.
      const region = findRegionAtPoint(lastPinchMidX, lastPinchMidY);
      if (region && region.fontSize > 0) {
        setRegionZoomPx(region.fontSize, region.fontSize * effectiveScale());
        currentRegion = region;
        currentRegionId = region.id;
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

  // RTL convention: swiping right = previous, swiping left = next
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
    // Single tap is a no-op — the drawer is summoned via the peek.
  }
}

function handleDoubleTap(clientX, clientY) {
  const tapped = findRegionAtPoint(clientX, clientY);

  // Tap on the focused region OR on whitespace while focused — both apply
  // the directional model to the focused column. Whitespace doesn't drop
  // us back to home; it scrolls/homes based on tap direction relative to
  // the column we're already in.
  const focusedTap = tapped
    ? (tapped.id === currentRegionId)
    : (currentRegion !== null);
  if (focusedTap) {
    handleFocusedTap(currentRegion, clientX, clientY);
    return;
  }

  // Whitespace tap with nothing focused — no-op.
  if (!tapped) return;

  // Different region — zoom to it at its saved preferred size, centred on
  // the tap so the user picks which part of the region they're zooming to.
  const targetPx = getRegionZoomPx(tapped.fontSize) ?? DEFAULT_READING_FONT_PX;
  const target = transformForRegion(tapped, clientX, clientY, targetPx);
  if (!target) return;
  currentRegion = tapped;
  currentRegionId = tapped.id;
  animateTo(target.x, target.y, target.scale);
}

function handleFocusedTap(region, clientX, clientY) {
  // Direction relative to viewport centre picks scroll axis. If the focused
  // column doesn't extend off-screen in that direction, there's nothing to
  // scroll to, so fall back to home.
  const w = window.innerWidth, h = window.innerHeight;
  const dx = clientX - w / 2, dy = clientY - h / 2;
  const dxN = Math.abs(dx) / w, dyN = Math.abs(dy) / h;
  if (dxN < CENTER_DEAD_ZONE && dyN < CENTER_DEAD_ZONE) {
    goHome();
    return;
  }
  const horizontal = dxN > dyN;
  const direction = horizontal ? (dx < 0 ? 'left' : 'right')
                               : (dy < 0 ? 'up'   : 'down');
  if (regionExtendsBeyondViewport(region, direction)) {
    scrollFocused(direction);
  } else {
    goHome();
  }
}

function scrollFocused(direction) {
  // To reveal content in `direction`, the canvas slides the opposite way.
  let dx = 0, dy = 0;
  switch (direction) {
    case 'up':    dy = +window.innerHeight * SCROLL_FRAC; break;
    case 'down':  dy = -window.innerHeight * SCROLL_FRAC; break;
    case 'left':  dx = +window.innerWidth  * SCROLL_FRAC; break;
    case 'right': dx = -window.innerWidth  * SCROLL_FRAC; break;
  }
  const target = transformForScroll(dx, dy);
  animateTo(target.x, target.y, target.scale);
}

function goHome() {
  currentRegion = null;
  currentRegionId = null;
  const { x, y, scale } = transformForHome();
  animateTo(x, y, scale);
}

export function returnHome() {
  goHome();
}

export function isZoomed() {
  return currentRegionId !== null;
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
    log.textContent = `${n}: ${label}`;
    log.style.borderLeft = `4px solid ${color}`;
  };

  const radii = ts => [...ts].map(t => `r${t.radiusX|0}x${t.radiusY|0}`).join(' ');

  canvas.addEventListener('touchstart', e => note(
    `start n=${e.touches.length} tr=${touches.size} ${radii(e.changedTouches)}`, '#0af'
  ), { passive: true });
  canvas.addEventListener('touchmove', e => note(
    `move n=${e.touches.length} moved=${hasMoved}`, '#0a8'
  ), { passive: true });
  canvas.addEventListener('touchend', e => note(
    `end remaining=${e.touches.length}`, '#0af'
  ), { passive: true });
}
