import {
  view, regions, canvas,
  applyDelta, animateTo, scheduleQualityRender,
  transformForRegion, transformForHome,
} from './viewer.js';
import { regionAtPoint } from './regions.js';
import { getZoomPref, setZoomPref } from './storage.js';

// Active non-palm pointers: pointerId → {x, y}
const pointers = new Map();

// Double-tap tracking
const doubleTap = { time: 0, x: 0, y: 0 };
const DOUBLE_TAP_MS = 280;
const DOUBLE_TAP_PX = 35;

// Track movement to distinguish tap from drag and to detect swipes
let gestureStartPointers = new Map();
let gestureStartTime = 0;
let hasMoved = false;
const MOVE_THRESHOLD = 8;

// Three-finger swipe thresholds
const SWIPE_TIME_MS = 600;
const SWIPE_DISTANCE_PX = 60;

// Two-finger pinch/pan state
let prevMidX = 0, prevMidY = 0, prevDist = 0;

let zoomedRegion = null;

// External callbacks (set in initGestures)
let onPrev = null;
let onNext = null;

function isPalm(e) {
  return e.pointerType === 'touch' && (
    (e.width > 60 || e.height > 60) ||
    (e.radiusX !== undefined && (e.radiusX > 30 || e.radiusY > 30))
  );
}

function twoFingerState() {
  const pts = [...pointers.values()];
  const dx = pts[1].x - pts[0].x;
  const dy = pts[1].y - pts[0].y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const midX = (pts[0].x + pts[1].x) / 2;
  const midY = (pts[0].y + pts[1].y) / 2;
  return { dist, midX, midY };
}

function onPointerDown(e) {
  if (isPalm(e)) return;
  e.preventDefault();
  // Capture the pointer so subsequent move/up events keep flowing to the
  // canvas even if the finger drifts off it (common during pinch).
  try { canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  gestureStartPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  hasMoved = false;
  if (pointers.size === 1) gestureStartTime = Date.now();

  if (pointers.size === 2) {
    const state = twoFingerState();
    prevDist = state.dist;
    prevMidX = state.midX;
    prevMidY = state.midY;
  }
}

function onPointerMove(e) {
  if (!pointers.has(e.pointerId)) return;
  e.preventDefault();

  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  const start = gestureStartPointers.get(e.pointerId);
  if (start) {
    const dx = e.clientX - start.x, dy = e.clientY - start.y;
    if (Math.sqrt(dx * dx + dy * dy) > MOVE_THRESHOLD) hasMoved = true;
  }

  const count = pointers.size;

  if (count === 1) {
    // Single finger: no pan, no zoom — reading mode
    return;
  }

  if (count === 2) {
    const state = twoFingerState();
    const dScale = prevDist > 0 ? state.dist / prevDist : 1;
    const dx = state.midX - prevMidX;
    const dy = state.midY - prevMidY;
    applyDelta(dx, dy, dScale, state.midX, state.midY);
    prevDist = state.dist;
    prevMidX = state.midX;
    prevMidY = state.midY;
    return;
  }

  // 3+ fingers: don't pan/zoom — wait for release to detect swipe
}

function onPointerUp(e) {
  if (!pointers.has(e.pointerId)) return;
  e.preventDefault();

  const countBefore = pointers.size;
  const wasOneFinger = countBefore === 1;
  const wasThreeFinger = countBefore === 3;

  // Detect 3-finger swipe at the moment the third finger lifts
  if (wasThreeFinger) {
    detectThreeFingerSwipe();
  }

  pointers.delete(e.pointerId);
  gestureStartPointers.delete(e.pointerId);

  if (wasOneFinger && !hasMoved) {
    handleTap(e.clientX, e.clientY);
  }

  if (pointers.size < 2) {
    if (zoomedRegion && pointers.size === 0) {
      setZoomPref(zoomedRegion.type, view.scale);
    }
    if (pointers.size === 0) {
      scheduleQualityRender();
    }
    prevDist = 0;
  }
}

function detectThreeFingerSwipe() {
  // Compute average dx across the 3 active pointers vs. their start positions
  const elapsed = Date.now() - gestureStartTime;
  if (elapsed > SWIPE_TIME_MS) return;

  let sumDx = 0, sumDy = 0, n = 0;
  for (const [id, cur] of pointers) {
    const start = gestureStartPointers.get(id);
    if (!start) continue;
    sumDx += cur.x - start.x;
    sumDy += cur.y - start.y;
    n++;
  }
  if (n < 3) return;
  const dx = sumDx / n;
  const dy = sumDy / n;

  // Require dominantly horizontal motion
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
    // Single tap: no chrome toggle. Drawer is summoned via the peek.
  }
}

function handleDoubleTap(clientX, clientY) {
  const canvasRect = canvas.getBoundingClientRect();
  const localX = (clientX - canvasRect.left) / view.scale;
  const localY = (clientY - canvasRect.top) / view.scale;

  if (!regions || regions.length === 0) {
    if (zoomedRegion) {
      goHome();
    } else {
      const s = 2.5;
      animateTo(
        window.innerWidth / 2 - localX * s,
        window.innerHeight / 2 - localY * s,
        s
      );
      zoomedRegion = { type: 'gemara' };
    }
    return;
  }

  const region = regionAtPoint(regions, localX, localY, view.cssW, view.cssH);

  if (!region || zoomedRegion) {
    goHome();
    return;
  }

  const prefScale = getZoomPref(region.type);
  const target = transformForRegion(region, prefScale);

  zoomedRegion = region;
  animateTo(target.x, target.y, target.scale, () => {
    setZoomPref(region.type, view.scale);
  });
}

function goHome() {
  zoomedRegion = null;
  const { x, y, scale } = transformForHome();
  animateTo(x, y, scale);
}

export function returnHome() {
  goHome();
}

export function isZoomed() {
  return zoomedRegion !== null;
}

export function initGestures({ prev, next } = {}) {
  onPrev = prev;
  onNext = next;

  canvas.addEventListener('pointerdown', onPointerDown, { passive: false });
  canvas.addEventListener('pointermove', onPointerMove, { passive: false });
  canvas.addEventListener('pointerup', onPointerUp, { passive: false });
  canvas.addEventListener('pointercancel', onPointerUp, { passive: false });

  // Native browser gestures (pinch, pan, scroll) are suppressed via
  // `touch-action: none` in CSS on html/body/#app/#viewer/#page-canvas.
  //
  // We deliberately do NOT add document-level touchstart/touchmove
  // preventDefault listeners. Per the Pointer Events spec, calling
  // preventDefault on a touch event can cancel the corresponding pointer
  // event on some browsers (Android Chrome historically had this behavior),
  // which would prevent the canvas's pointerdown handler from firing at all
  // — manifesting as gestures intermittently or never being detected.

  // Diagnostic mode: ?debugGestures=1 in the URL adds an on-screen indicator
  // that flashes color-coded dots for every touch / pointer event the canvas
  // receives, so we can see whether events are reaching JS at all.
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

  canvas.addEventListener('pointerdown', e => note(
    `pointerdown #${pointers.size + 1} type=${e.pointerType} w=${e.width|0} h=${e.height|0}`, '#0f0'
  ));
  canvas.addEventListener('pointerup', () => note(`pointerup, count=${pointers.size}`, '#0f0'));
  canvas.addEventListener('touchstart', e => note(
    `touchstart fingers=${e.touches.length}`, '#0af'
  ), { passive: true });
  canvas.addEventListener('touchend', e => note(
    `touchend fingers=${e.touches.length}`, '#0af'
  ), { passive: true });

  // Also catch events that bubble up to body, in case canvas isn't getting them
  document.body.addEventListener('touchstart', e => {
    if (e.target !== canvas) {
      note(`touchstart on ${e.target?.id || e.target?.tagName}`, '#fa0');
    }
  }, { passive: true, capture: true });
}
