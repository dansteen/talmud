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

// Track whether any pointer has moved significantly (distinguishes tap from drag)
let gestureStartPointers = new Map();
let hasMoved = false;
const MOVE_THRESHOLD = 8;

// Previous two-finger state for pinch/pan calculation
let prevMidX = 0, prevMidY = 0, prevDist = 0;

// Whether we're currently in a "zoomed to region" state
let zoomedRegion = null;

function isPalm(e) {
  // Touch events with a large contact area are likely palms
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
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  gestureStartPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  hasMoved = false;

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

  const prev = pointers.get(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  // Track movement to distinguish tap from drag
  const start = gestureStartPointers.get(e.pointerId);
  if (start) {
    const dx = e.clientX - start.x, dy = e.clientY - start.y;
    if (Math.sqrt(dx*dx + dy*dy) > MOVE_THRESHOLD) hasMoved = true;
  }

  const count = pointers.size;

  if (count === 1) {
    // Single finger: no pan, no zoom — reading mode
    return;
  }

  if (count >= 2) {
    const state = twoFingerState();

    const dScale = prevDist > 0 ? state.dist / prevDist : 1;
    const dx = state.midX - prevMidX;
    const dy = state.midY - prevMidY;

    applyDelta(dx, dy, dScale, state.midX, state.midY);

    prevDist = state.dist;
    prevMidX = state.midX;
    prevMidY = state.midY;
  }
}

function onPointerUp(e) {
  if (!pointers.has(e.pointerId)) return;
  e.preventDefault();

  const wasOneFinger = pointers.size === 1;
  pointers.delete(e.pointerId);
  gestureStartPointers.delete(e.pointerId);

  if (wasOneFinger && !hasMoved) {
    handleTap(e.clientX, e.clientY);
  }

  if (pointers.size < 2) {
    // Pinch ended — save zoom pref if we have a zoomed region
    if (zoomedRegion && pointers.size === 0) {
      setZoomPref(zoomedRegion.type, view.scale);
    }
    if (pointers.size === 0) {
      scheduleQualityRender();
    }
    prevDist = 0;
  }
}

function handleTap(clientX, clientY) {
  const now = Date.now();
  const dx = clientX - doubleTap.x;
  const dy = clientY - doubleTap.y;
  const dist = Math.sqrt(dx*dx + dy*dy);

  if (now - doubleTap.time < DOUBLE_TAP_MS && dist < DOUBLE_TAP_PX) {
    // Double tap
    doubleTap.time = 0;
    handleDoubleTap(clientX, clientY);
  } else {
    doubleTap.time = now;
    doubleTap.x = clientX;
    doubleTap.y = clientY;
    // Single tap — toggle nav chrome after a short delay
    // (cancel if a second tap comes in within double-tap window)
    setTimeout(() => {
      if (Date.now() - doubleTap.time >= DOUBLE_TAP_MS) {
        toggleNavChrome();
      }
    }, DOUBLE_TAP_MS + 20);
  }
}

function handleDoubleTap(clientX, clientY) {
  // Convert screen point to canvas-local coordinates
  const canvasRect = canvas.getBoundingClientRect();
  const localX = (clientX - canvasRect.left) / view.scale;
  const localY = (clientY - canvasRect.top) / view.scale;

  if (!regions || regions.length === 0) {
    // No regions yet: toggle between home and a 2x zoom at tap point
    if (zoomedRegion) {
      goHome();
    } else {
      const s = 2.5;
      animateTo(
        window.innerWidth / 2 - localX * s,
        window.innerHeight / 2 - localY * s,
        s
      );
      zoomedRegion = { type: 'gemara' }; // synthetic
    }
    return;
  }

  const region = regionAtPoint(regions, localX, localY, view.cssW, view.cssH);

  if (!region || zoomedRegion) {
    // Tapped outside regions or already zoomed → go home
    goHome();
    return;
  }

  // Zoom to the tapped region
  const prefScale = getZoomPref(region.type);
  const target = transformForRegion(region, prefScale);

  zoomedRegion = region;
  animateTo(target.x, target.y, target.scale, () => {
    // Save the settled scale as the new preference
    setZoomPref(region.type, view.scale);
  });
}

function goHome() {
  zoomedRegion = null;
  const { x, y, scale } = transformForHome();
  animateTo(x, y, scale);
}

let navVisible = false;
function toggleNavChrome() {
  navVisible = !navVisible;
  document.getElementById('nav-chrome').classList.toggle('hidden', !navVisible);
}

// Public: programmatically go home (e.g. from home button)
export function returnHome() {
  goHome();
}

export function isZoomed() {
  return zoomedRegion !== null;
}

export function initGestures() {
  canvas.addEventListener('pointerdown', onPointerDown, { passive: false });
  canvas.addEventListener('pointermove', onPointerMove, { passive: false });
  canvas.addEventListener('pointerup', onPointerUp, { passive: false });
  canvas.addEventListener('pointercancel', onPointerUp, { passive: false });

  // Prevent default touch behaviors (scroll, pinch-zoom by browser)
  document.addEventListener('touchstart', e => e.preventDefault(), { passive: false });
  document.addEventListener('touchmove', e => e.preventDefault(), { passive: false });
}
