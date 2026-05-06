import {
  view, canvas,
  applyDelta, animateTo, scheduleQualityRender,
  transformForHome, transformForFontSize, transformForCentering,
  findItemAtPoint, effectiveScale,
} from './viewer.js';
import { getReadingFontPx, setReadingFontPx } from './storage.js';

// Default on-screen font size (CSS px) used by smart double-tap zoom when
// the user hasn't pinched yet. Comfortable Hebrew reading size on a phone.
const DEFAULT_READING_FONT_PX = 32;
const DOUBLE_TAP_HIT_RADIUS_PX = 30;

// "Same size" tolerance: two PDF font sizes are considered the same if they
// agree within this fraction. 25% covers natural per-glyph variation while
// still distinguishing Gemara from Rashi/commentary.
const SAME_SIZE_TOLERANCE = 0.25;

// Center region of the screen for the 9-region double-tap model. A tap is
// "center" if it's within the middle third of the screen on both axes.
const CENTER_REGION_FRAC = 1 / 3;

// Active touches: identifier → {x, y}
//
// We use touch events instead of pointer events because, despite the spec,
// pointer events on the canvas don't reliably fire on Android Chrome with
// `touch-action: none`. Touch events do fire reliably and carry all the
// information we need.
const touches = new Map();
// Initial position of each touch (for tap-vs-drag and swipe detection)
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
// Last 2-finger midpoint seen — used at pinch end to read the font size at
// the user's pinch center and persist their preferred reading size.
let lastPinchMidX = 0, lastPinchMidY = 0;
let didPinch = false;

let zoomed = false;

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
  e.preventDefault(); // prevents native pinch/scroll on this touch sequence

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

  if (count === 1) {
    // Single finger: no pan, no zoom — reading mode
    return;
  }

  if (count === 2) {
    const s = twoTouchState();
    const dScale = prevDist > 0 ? s.dist / prevDist : 1;
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

  // 3+ fingers: don't pan/zoom — wait for release to detect a swipe
}

function onTouchEnd(e) {
  e.preventDefault();

  const countBefore = touches.size;
  const wasOneFinger = countBefore === 1;
  const wasThreeFingers = countBefore === 3;

  // Detect 3-finger swipe at the moment any of the three fingers lifts
  if (wasThreeFingers) detectThreeFingerSwipe();

  // Capture the lifted touch's position before we delete it (for tap location)
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
    // Pinch settled — record the user's preferred on-screen reading size.
    // We base it on the font of whatever was under the pinch midpoint at
    // release, so "I pinched until Gemara was this size" or "I pinched
    // until Rashi was this size" both translate cleanly to a single
    // target screen size for future smart zooms.
    if (didPinch) {
      const item = findItemAtPoint(lastPinchMidX, lastPinchMidY, 60);
      if (item) {
        setReadingFontPx(item.fontSize * effectiveScale());
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
  const item = findItemAtPoint(clientX, clientY, DOUBLE_TAP_HIT_RADIUS_PX);
  if (!item) {
    // Tap landed off any text — preserve the old escape: home if zoomed,
    // no-op when already at home.
    if (zoomed) goHome();
    return;
  }

  const targetPx = getReadingFontPx() ?? DEFAULT_READING_FONT_PX;
  const intendedFontPdf = currentIntendedFontPdf(targetPx);
  const sameSize = isSameFontSize(item.fontSize, intendedFontPdf);
  const inCenter = isCenterTap(clientX, clientY);

  // Center + same size = "I'm done with this dive, zoom out"
  if (sameSize && inCenter) {
    goHome();
    return;
  }

  // Same size, off-center = scroll in the direction of the tap (re-center on
  // tapped point, keep scale). Different size = zoom to the new font's
  // preferred screen size, also re-centered on the tap.
  const target = sameSize
    ? transformForCentering(clientX, clientY)
    : transformForFontSize(clientX, clientY, item.fontSize, targetPx);
  if (!target) return;

  zoomed = true;
  animateTo(target.x, target.y, target.scale);
}

// Given the current view, what PDF font size would be displayed at the user's
// preferred on-screen reading size? Tells us "the font size this zoom is
// calibrated for", which we can then compare against a tapped item's font.
function currentIntendedFontPdf(targetPx) {
  const eff = effectiveScale();
  if (eff <= 0) return Infinity;
  return targetPx / eff;
}

function isSameFontSize(a, b) {
  if (!a || !b || !isFinite(a) || !isFinite(b)) return false;
  return Math.abs(a / b - 1) < SAME_SIZE_TOLERANCE;
}

function isCenterTap(clientX, clientY) {
  const w = window.innerWidth, h = window.innerHeight;
  const dx = Math.abs(clientX - w / 2);
  const dy = Math.abs(clientY - h / 2);
  return dx < w * CENTER_REGION_FRAC / 2 && dy < h * CENTER_REGION_FRAC / 2;
}

function goHome() {
  zoomed = false;
  const { x, y, scale } = transformForHome();
  animateTo(x, y, scale);
}

export function returnHome() {
  goHome();
}

export function isZoomed() {
  return zoomed;
}

export function initGestures({ prev, next } = {}) {
  onPrev = prev;
  onNext = next;

  canvas.addEventListener('touchstart', onTouchStart, { passive: false });
  canvas.addEventListener('touchmove', onTouchMove, { passive: false });
  canvas.addEventListener('touchend', onTouchEnd, { passive: false });
  canvas.addEventListener('touchcancel', onTouchEnd, { passive: false });

  // Diagnostic mode: ?debugGestures=1 adds a status box that updates with
  // each touch event the canvas receives.
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
