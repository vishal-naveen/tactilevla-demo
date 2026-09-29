import { $, reduced, useMock, forceNoGL } from './ui/env.js';
import { createStageProxy } from './ui/stage-proxy.js';
import { probeGL, showHardwareNote } from './ui/gl-probe.js';
import { applyTheme, currentTheme, themeFromURL, initThemeSwitcher } from './ui/theme.js';
import { initLoader } from './ui/loader.js';
import { initScroll } from './ui/scroll.js';
import { initData } from './ui/data.js';
import { initResults } from './ui/results.js';
import { initPolicies } from './ui/policies.js';
import { initSandbox } from './ui/sandbox.js';
import { initPlaceHint } from './ui/place-hint.js';
import { initFilm } from './ui/film.js';
import { initClips } from './ui/media.js';
import { initFullscreen } from './ui/fullscreen.js';
import { initTelemetry } from './ui/telemetry.js';
import { initSafeArea } from './ui/safe-area.js';
import { initTour } from './ui/tour.js';
import { initTourFade } from './ui/tour-fade.js';

window.__booted = true;
const root = document.documentElement;
const themeName = applyTheme(themeFromURL()); // before anything paints or reads a colour token

// Every init step is independent: one failing must never take the others down.
const safe = (name, fn, fallback) => {
  try {
    const out = fn();
    if (out && typeof out.catch === 'function') out.catch((err) => console.warn(`${name} failed`, err));
    return out;
  } catch (err) {
    console.warn(`${name} failed`, err);
    return fallback;
  }
};

safe('scroll restore', () => { history.scrollRestoration = 'manual'; scrollTo(0, 0); });
if (reduced) root.classList.add('reduced');

const idleLoader = { progress() {}, reveal: async ({ onCue }) => onCue() };
const loader = safe('loader', initLoader, idleLoader) ?? idleLoader;

// --- The 3D stage -------------------------------------------------------------------------------
// The rest of the page talks to a proxy, so the real stage can attach at any time. On a busy machine it
// may take far longer than the page is willing to hold the loader: after a soft deadline the page reveals
// itself over the static poster background and the stage fades in whenever it arrives.
const SOFT_MS = 8000;       // reveal the page by then unless the stage is visibly still progressing
const SOFT_MAX_MS = 25000;  // ...but never hold the loader longer than this
const IDLE_MS = 2000;       // "still progressing" = onLoadProgress advanced within this window
const t0 = performance.now();
let lastProgress = t0;
let canvas = $('#stage'); // replaced by a fresh element if the stage has to be re-created after a dead WebGL context
const proxy = createStageProxy();
let scrollHandle = null;
let sandbox = null;

function startStage() {
  if (forceNoGL) return Promise.reject(new Error('WebGL disabled by ?nogl'));
  const gl = probeGL(); // software rendering: don't boot a 1 fps scene, explain instead
  if (!gl.ok) return Promise.reject(Object.assign(new Error(`no hardware WebGL2 (${gl.reason}: ${gl.renderer || 'n/a'})`), { hardware: true, renderer: gl.renderer }));
  const onLoadProgress = (f) => { lastProgress = performance.now(); loader.progress(f); };
  return (useMock ? import('./ui/mock-stage.js') : import('./stage/stage.js'))
    .then((mod) => mod.createStage(canvas, { onLoadProgress, theme: themeName }));
}

// Resolves with the stage, an error (real failure), or { slow: true } when the page should stop waiting.
function settleOrGiveUp(pending) {
  return new Promise((resolve) => {
    let done = false;
    pending.then((stage) => { if (!done) { done = true; resolve({ stage }); } }, (error) => { if (!done) { done = true; resolve({ error }); } });
    const check = () => {
      if (done) return;
      const now = performance.now();
      const waited = now - t0;
      if (waited >= SOFT_MAX_MS || (waited >= SOFT_MS && now - lastProgress >= IDLE_MS)) { done = true; resolve({ slow: true }); return; }
      setTimeout(check, 250);
    };
    setTimeout(check, 250);
  });
}

// Reveal the ring without the hero camera dolly (the visitor is already deeper in the page).
function igniteWithoutDolly(real) {
  if (reduced) return; // reduced motion already revealed instantly
  safe('ignite', () => { real.setReducedMotion(true); real.setReducedMotion(false); });
}

function attachLate(real) {
  proxy.attach(real);
  safe('theme', () => real.setTheme?.(currentTheme()));
  safe('telemetry', () => telemetry?.resync());
  safe('reduced motion', () => real.setReducedMotion(reduced));
  const atHero = (scrollHandle?.currentChapter() ?? 'hero') === 'hero';
  safe('policy', () => proxy.setPolicy($('.seg-btn[aria-pressed="true"]')?.dataset.policy ?? 'act'));
  safe('resync', () => scrollHandle?.resync());          // current chapter and scrub progress, not hero
  safe('reveal', () => (atHero ? real.reveal?.() : igniteWithoutDolly(real)));
  if (!atHero) safe('resync', () => scrollHandle?.resync());
  safe('sandbox', () => sandbox?.enable());

  // Crossfade: the poster stays underneath while the canvas fades in (CSS transition on #stage).
  root.classList.add('stage-fading');
  root.classList.remove('no-stage');
  setTimeout(() => root.classList.remove('stage-fading'), 1200);
}

const pending = startStage();
const outcome = await settleOrGiveUp(pending);
let stageError = null;
if (outcome.stage) {
  proxy.attach(outcome.stage);
  safe('theme', () => outcome.stage.setTheme?.(themeName));
  safe('reduced motion', () => outcome.stage.setReducedMotion(reduced));
} else {
  root.classList.add('no-stage');
  if (outcome.error) {
    stageError = outcome.error;
    console.info('3D stage unavailable, using the static background.', outcome.error.message);
    if (outcome.error.hardware) safe('gl note', () => showHardwareNote(outcome.error.renderer));
  } else {
    console.info('3D stage is slow to load: showing the page now, the scene will fade in when ready.');
    pending.then((real) => attachLate(real), (err) => {
      console.info('3D stage failed to load.', err?.message);
      safe('sandbox', () => sandbox?.disable('The 3D reconstruction needs WebGL, which isn’t available here.'));
    });
  }
}
const stage = proxy;

// --- Stage lifecycle: context loss, fullscreen video, visibility ----------------------------------------------------
// iOS Safari kills a tab's WebGL context under GPU-memory pressure. The stage tells us on its canvas:
//   stage:lost      -> show the static poster (page stays fully usable) until the browser hands the context back
//   stage:restored  -> the stage rebuilt its GPU-only resources; fade the canvas back in
//   stage:dead      -> no restore came: dispose it and create a brand-new stage on a fresh canvas (a lost canvas can never
//                      yield a new context), then re-sync chapter / theme / policy exactly like a late attach.
let rebuilding = false, rebuilds = 0;
async function rebuildStage() {
  if (rebuilding || rebuilds >= 3) return;
  rebuilding = true; rebuilds++;
  root.classList.add('no-stage');
  safe('dispose dead stage', () => proxy.real?.dispose());
  proxy.detach();
  const fresh = canvas.cloneNode(false);
  canvas.replaceWith(fresh);
  canvas = fresh;
  try {
    attachLate(await startStage());
    console.info('3D stage re-created after the WebGL context was lost.');
  } catch (err) {
    console.info('3D stage could not be re-created; keeping the static background.', err?.message);
    safe('sandbox', () => sandbox?.disable('The 3D reconstruction stopped because the browser reclaimed the GPU. Reload the page to bring it back.'));
  } finally { rebuilding = false; }
}
document.addEventListener('stage:lost', () => root.classList.add('no-stage'));
document.addEventListener('stage:restored', () => {
  root.classList.add('stage-fading');
  root.classList.remove('no-stage');
  setTimeout(() => root.classList.remove('stage-fading'), 1200);
});
document.addEventListener('stage:dead', () => { rebuildStage(); });

// Rendering pauses for any of several reasons; it runs only when none applies. A video in native fullscreen owns the GPU.
const pauseReasons = new Set();
const setPaused = (reason, on) => { on ? pauseReasons.add(reason) : pauseReasons.delete(reason); pauseReasons.size ? stage.pause() : stage.resume(); };
const isVideoFullscreen = () => {
  const el = document.fullscreenElement || document.webkitFullscreenElement;
  return !!el && (el.tagName === 'VIDEO' || !!el.querySelector?.('video'));
};
document.addEventListener('webkitbeginfullscreen', () => setPaused('video-fullscreen', true), true);  // iOS: the video element itself
document.addEventListener('webkitendfullscreen', () => setPaused('video-fullscreen', false), true);
['fullscreenchange', 'webkitfullscreenchange'].forEach((ev) => document.addEventListener(ev, () => setPaused('video-fullscreen', isVideoFullscreen())));

safe('results', initResults);
safe('film', initFilm);
safe('clips', initClips);
safe('fullscreen', initFullscreen);
safe('policies', () => initPolicies(stage));
sandbox = safe('sandbox', () => initSandbox(stage), null);
if (stageError) safe('sandbox', () => sandbox?.disable(stageError.hardware ? 'The 3D reconstruction needs hardware acceleration.' : 'The 3D reconstruction needs WebGL, which isn’t available here.'));
safe('place hint', () => initPlaceHint(stage));
safe('data', initData);
safe('safe area', () => initSafeArea(stage));
const telemetry = safe('telemetry', () => initTelemetry(stage), null);
if (new URLSearchParams(location.search).has('themes')) {
  safe('theme switcher', () => initThemeSwitcher((name) => { stage.setTheme(name); }));
}
safe('visibility', () => document.addEventListener('visibilitychange', () => setPaused('hidden', document.hidden)));

let cued = false;
const cue = () => {
  if (cued) return;
  cued = true;
  safe('stage hero', () => stage.setChapter('hero'));
  scrollHandle = safe('scroll', () => initScroll({ stage }), null);
};
window.__revealed = true; // tells the head failsafe the page is being revealed
try {
  await loader.reveal({ onCue: cue, stage });
} catch (err) {
  console.warn('reveal failed', err);
  root.classList.remove('is-loading');
  $('#loader')?.remove();
}
cue();
safe('tour', () => initTour({ stage, getScroll: () => scrollHandle }));
safe('tour fade', initTourFade);
