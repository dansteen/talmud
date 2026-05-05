import {
  view, regions, canvas,
  applyDelta, animateTo, scheduleQualityRender,
  transformForRegion, transformForHome,
} from './viewer.js';
import { regionAtPoint } from './regions.js';
import { getZoomPref, setZoomPref } from './storage.js';

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

let zoomedRegion = null;

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
    if (zoomedRegion) setZoomPref(zoomedRegion.type, view.scale);
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
