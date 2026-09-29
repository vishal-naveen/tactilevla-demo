// Guided tour ("presentation" mode): a hybrid of continuous scrolling and short holds.
//
// The page always glides: every frame it moves by speed(y) * dt along a speed curve, with the real velocity following the curve
// through a low-pass filter, so nothing ever steps or teleports. The curve is a smoothstep ramp toward every hold point (the
// page starts slowing about 0.6 viewport before a hold and accelerates away just as gently), so between holds it cruises.
// At each hold the page stands still for about 1.2 s plus the time its words take to read, once the 3D camera has settled.
// Hold positions are computed from live geometry (when the tour starts and whenever the layout changes): each is where the
// section's heading and all of its body are fully visible between the top bar and the pill, and every scrub-driven beat that
// belongs to the moment is fully opaque. Two holds are special: the B2 clip plays, and the sandbox B2 task runs to completion.
//
// window.scrollTo is driven from the tour's own rAF loop with a float position. Lenis is stopped for the whole tour and started
// again the moment the visitor takes over. Any wheel, touch, pointer-down on content, or navigation key pauses at once.
// No claim is added anywhere: everything shown is page copy.
//
// Test hooks: ?tourspeed=N multiplies the speed. Events on document: tour:plan, tour:hold, tour:arrive, tour:acted, tour:start,
// tour:pause, tour:resume, tour:stop, tour:done, tour:glide.
import { $, $$, clamp, reduced } from './env.js';

const params = new URLSearchParams(location.search);
const HOOK_SPEED = Math.min(12, Math.max(0.25, Number(params.get('tourspeed')) || 1));
const PRESETS = [0.5, 1, 1.5, 2];
const PREF_KEY = 'tvla.tourSpeed';
const TARGET_SECONDS = 112;             // whole tour at 1x, holds included
const REDUCED_GENTLE = 0.7;             // reduced motion: same continuous scroll, just gentler
const TAU = 0.32;                       // seconds: how fast the real velocity follows the speed curve
const SAMPLE = 4;                       // px per speed-curve sample
const GLIDE_SECONDS = 1.2;              // Left / Right
const FILM_HOLD = 4.3;                  // seconds the B2 clip plays, at 1x (camera settle included)
const HOLD_BASE = 1.2, HOLD_WPM = 300, HOLD_MIN = 2, HOLD_MAX = 6;   // hold = base + reading time, clamped, at 1x
const RAMP = 0.6;                       // viewports: slowing into a hold starts this far before it
const V_MIN = 0.1;                      // fraction of cruise speed left right at a hold (the brake finishes the job)
const CANCEL = Symbol('tour-cancelled');

const smooth = (t) => t * t * (3 - 2 * t);
const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const narrowQ = matchMedia('(max-width: 820px), (orientation: portrait) and (max-width: 1100px)');
const wordsIn = (el) => (el?.innerText || '').trim().split(/\s+/).filter(Boolean).length;

// ---- Stops = holds -----------------------------------------------------------------------------------------------------
// kind 'panel': the chapter's panel framed in the free space. 'scrub': p (0..1) inside a pinned chapter, nudged so every element
// in `beats` (data-scrub-in) is fully opaque. words: selectors whose text sets the reading time (default: the panel). cap: max hold.
const BASE_STOPS = [
  { id: 'hero', name: 'Overview', chapter: 'hero', root: '#hero', kind: 'top' },
  { id: 'arm-1', name: 'The setup', chapter: 'arm', root: '#arm', kind: 'scrub', p: 0.24, beats: ['#arm .beat:not(.beat--stat)'], words: ['#arm h2', '#arm .beat:not(.beat--stat)'] },
  { id: 'arm-2', name: 'The setup', chapter: 'arm', root: '#arm', kind: 'scrub', p: 0.78, beats: ['#arm .beat--stat'], words: ['#arm h2', '#arm .beat--stat'] },
  { id: 'task', name: 'One job, one rule', chapter: 'data', root: '#task', kind: 'panel' },
  { id: 'data-1', name: 'How it learned', chapter: 'data', root: '#data', kind: 'scrub', p: 0.32, beats: ['#data .lapse'] },
  { id: 'data-2', name: 'How it learned', chapter: 'data', root: '#data', kind: 'scrub', p: 0.78, beats: ['#data .closing--quiet', '#data .lapse'], cap: 3.6 },
  { id: 'sees', name: 'Two cameras', chapter: 'sees', root: '#sees', kind: 'panel' },
  { id: 'policies', name: 'Two policies', chapter: 'policies', root: '#policies', kind: 'panel' },
  { id: 'test', name: 'The held-out cell', chapter: 'test', root: '#test', kind: 'panel' },
  { id: 'film', name: 'Real runs', chapter: 'film', root: '#film', kind: 'chapter', hold: 'film' },
  { id: 'results', name: 'Results', chapter: 'results', root: '#results', kind: 'panel' },
  { id: 'limits', name: 'What this doesn’t show', chapter: 'limits', root: '#limits', kind: 'panel' },
  { id: 'touch', name: 'What’s next', chapter: 'touch', root: '#touch', kind: 'panel' },
  { id: 'sandbox', name: 'Try it yourself', chapter: 'sandbox', root: '#sandbox', kind: 'panel', hold: 'sandbox', cap: 3.4 },
  { id: 'built', name: 'What I built', chapter: 'results', root: '#built', kind: 'panel' },
];

export function initTour({ stage, getScroll }) {
  const pill = $('#tour-pill'), toggle = $('#tour-toggle'), label = $('.tour-toggle__t', pill), nameEl = $('#tour-name');
  const stopBtn = $('#tour-stop'), barFill = $('#tour-bar'), live = $('#tour-live'), startBtn = $('#tour-start');
  const speedBtns = $$('.tour-speed button', pill);
  if (!pill || !toggle || !startBtn) return null;
  const root = document.documentElement;

  let state = 'idle';            // idle | playing | paused | done
  let stops = [];
  let plan = null;               // { ys, slow[], yEnd, holds[] }
  let gen = 0;                   // bumped whenever the running flow is replaced; stale flows just stop
  let pos = 0, vel = 0;          // float scroll position and its velocity (px/s)
  let lastSetY = 0;              // what the browser reports right after our last write (user-move detection)
  let glide = null;              // { y0, y1, t, dur } while Left / Right glides
  let waiters = [];              // timers of a running hold, frozen while paused
  let holdRun = null;            // the hold in progress
  let nearIdx = -1;
  let startedAt = 0;
  let last = performance.now();
  let preset = 1;

  try { const v = Number(localStorage.getItem(PREF_KEY)); if (PRESETS.includes(v)) preset = v; } catch { /* storage blocked */ }
  const mul = () => preset * HOOK_SPEED * (reduced ? REDUCED_GENTLE : 1);

  const lenis = () => getScroll?.()?.lenis ?? null;
  const lock = (on) => { const l = lenis(); if (l) (on ? l.stop() : l.start()); };
  const emit = (type, detail) => document.dispatchEvent(new CustomEvent(type, { detail }));

  // ---- Geometry -------------------------------------------------------------------------------------------------------
  const topOf = (el) => el.getBoundingClientRect().top + window.scrollY;
  const topbarH = () => $('#topbar')?.getBoundingClientRect().height ?? 68;
  // The pill sits bottom-left over the text column: keep panels clear of it. Its resting offset is used (not its live rect, which
  // rides higher over the hero) so every stop is framed against the same space.
  const reserve = () => {
    const rem = parseFloat(getComputedStyle(root).fontSize) || 16;
    return (narrowQ.matches ? 2.9 : 1.1) * rem + pill.offsetHeight + 10;
  };
  const view = () => ({ top: topbarH(), bottom: innerHeight - reserve() });
  const panelOf = (s) => $('.panel', $(s.root)) || $(s.root);
  // The box around what is actually readable in a section (its headings, text, figures, controls), not its padding.
  const CONTENT = 'h1, h2, h3, p, li, figure, figcaption, dl, button, .counter, .giant-cell, .seg, .policies-hud, .sandbox-hud, .strip-progress';
  const NOT_CONTENT = '.sr-only, .stage-label, .clip-toggle, .clip-play, .reel-play, .hero-note, .swipe-hint, [hidden], .vc';
  function contentRect(s) {
    const el = $(s.root);
    let top = Infinity, bottom = -Infinity;
    for (const c of $$(CONTENT, el)) {
      if (c.closest(NOT_CONTENT)) continue;
      const r = c.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      top = Math.min(top, r.top); bottom = Math.max(bottom, r.bottom);
    }
    if (!Number.isFinite(top)) { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height }; }
    return { top, bottom, height: bottom - top };
  }
  const isTall = (s) => { const v = view(); return contentRect(s).height > v.bottom - v.top - 16; };
  const maxY = () => document.documentElement.scrollHeight - innerHeight;

  // p for a scrub stop, nudged so every data-scrub-in element listed in `beats` is >= 96 % in and (if it fades out) not yet 4 % out.
  function scrubP(s) {
    let lo = -Infinity, hi = Infinity;
    for (const sel of s.beats ?? []) {
      for (const el of $$(sel)) {
        const r = (el.dataset.scrubIn || '').split(',').map(Number);
        if (r.length >= 2 && r.every(Number.isFinite)) { lo = Math.max(lo, r[0] + 0.96 * (r[1] - r[0])); if (r.length >= 4) hi = Math.min(hi, r[2] + 0.04 * (r[3] - r[2])); }
      }
    }
    return lo + 0.01 < hi - 0.01 ? clamp(s.p, lo + 0.01, hi - 0.01) : s.p;
  }

  function yOf(s) {
    const el = $(s.root);
    let y;
    if (s.kind === 'top') y = 0;
    else if (s.kind === 'scrub') { const h = el.getBoundingClientRect().height; y = topOf(el) + scrubP(s) * Math.max(0, h - innerHeight); }
    else {
      const r = contentRect(s);
      const v = view();
      const room = v.bottom - v.top;
      if (r.height > room - 16 && s.part === 'bottom') y = r.bottom + window.scrollY - v.bottom + 8;
      else if (r.height > room - 16) y = r.top + window.scrollY - v.top - clamp(room + 6 - r.height, 2, 8);             // taller than the space: top-aligned, its second half is a second hold
      else y = r.top + window.scrollY + r.height / 2 - (v.top + v.bottom) / 2 + Math.min(innerHeight * 0.02, (room - r.height) / 2 - 6); // optical centre sits a little high
    }
    return clamp(y, 0, Math.max(0, maxY()));
  }

  // How long a hold lasts at 1x: about 1.2 s plus the reading time of its words, clamped.
  const holdSecondsOf = (s) => {
    if (s.hold === 'film') return FILM_HOLD;
    const words = s.words ? s.words.reduce((n, sel) => n + $$(sel).reduce((m, el) => m + wordsIn(el), 0), 0) : wordsIn(panelOf(s));
    return clamp(HOLD_BASE + (words / HOLD_WPM) * 60, HOLD_MIN, s.cap ?? HOLD_MAX);
  };

  function buildStops() {
    const out = [];
    for (const b of BASE_STOPS) {
      if (!$(b.root)) continue;
      out.push({ ...b });
      if (b.kind === 'panel' && !b.hold && isTall(b)) out.push({ ...b, id: `${b.id}-b`, part: 'bottom', cap: Math.min(b.cap ?? HOLD_MAX, 4) });
    }
    return out.map((st) => ({ ...st, y: yOf(st), holdSec: holdSecondsOf(st) })).filter((st, i, all) => !st.part || Math.abs(st.y - all[i - 1].y) > innerHeight * 0.25);
  }

  // ---- The speed curve ----------------------------------------------------------------------------------------------------
  // slowness (seconds per px) over the page, sampled every SAMPLE px: a smoothstep ramp of speed toward every hold (slowing starts
  // RAMP viewports out, gentle acceleration on the way back out), cruising in between. Cruise speed V is solved so the whole tour,
  // holds included, takes TARGET_SECONDS at 1x whatever the page height. Rebuilt (same V) when the layout moves the holds.
  function curve(V) {
    const H = innerHeight, R = RAMP * H;
    const n = Math.ceil(plan.yEnd / SAMPLE) + 2;
    const slow = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      const y = k * SAMPLE;
      let d = Infinity;
      for (const st of stops) d = Math.min(d, Math.abs(y - st.y));
      slow[k] = 1 / (V * (V_MIN + (1 - V_MIN) * smooth(clamp(d / R))));
    }
    return slow;
  }
  function buildPlan(from) {
    stops = buildStops();
    const yEnd = stops[stops.length - 1].y;
    plan = { slow: null, yEnd, holds: stops, from, V: 1, predicted: 0 };
    const unit = curve(1);
    const transit1 = unit.reduce((t, sl) => t + sl * SAMPLE, 0);
    const holdsEst = stops.reduce((t, st) => t + (st.hold === 'sandbox' ? st.holdSec + 10.5 : st.holdSec), 0);
    plan.V = clamp(transit1 / Math.max(15, TARGET_SECONDS - holdsEst), 0.55 * innerHeight, 3.2 * innerHeight);
    plan.slow = curve(plan.V);
    plan.predicted = transit1 / plan.V + holdsEst;
    stops.forEach((st) => { st.done = st.y < from - 1; st.passed = false; });
    emit('tour:plan', { seconds: plan.predicted, holdsSeconds: holdsEst, V: plan.V, stops: stops.map((st) => ({ id: st.id, y: Math.round(st.y), hold: +st.holdSec.toFixed(1) })) });
  }
  const speedAt = (y) => {
    const f = clamp(y / SAMPLE, 0, plan.slow.length - 2);
    const i = Math.floor(f);
    return 1 / (plan.slow[i] + (plan.slow[i + 1] - plan.slow[i]) * (f - i));
  };

  // Layout can move after the tour starts (fonts, media metadata, resize): the hold points follow it.
  let layoutDirty = false;
  const markDirty = () => { layoutDirty = true; };
  addEventListener('resize', markDirty, { passive: true });
  if (typeof ResizeObserver === 'function') new ResizeObserver(markDirty).observe(document.body);
  function refreshGeometry() {
    layoutDirty = false;
    let moved = false;
    for (const st of stops) { const y = yOf(st); if (Math.abs(y - st.y) > 0.5) { st.y = y; moved = true; } }
    if (!moved) return;
    plan.yEnd = stops[stops.length - 1].y;
    plan.slow = curve(plan.V);
  }

  // ---- Timers for the holds (frozen while paused) ------------------------------------------------------------------------
  const wait = (sec, g) => new Promise((resolve) => { waiters.push({ left: sec, resolve, g }); });
  const checked = (g) => { if (g !== gen) throw CANCEL; };
  const frames = (n) => new Promise((r) => { const f = (k) => (k <= 0 ? r() : requestAnimationFrame(() => f(k - 1))); f(n); });

  // The 3D camera has landed when a flight is over: it is still, or moving at a steady drift (some shots idle-drift slowly forever).
  // Read from the stage if it exposes its camera, else a fixed beat.
  async function settle(g) {
    const cam = stage.real?.debug?.camera?.position;
    if (!cam) { await wait(0.6, g); checked(g); return 0.6; }
    const STEP = 0.15;
    let steady = 0, elapsed = 0, prevD = Infinity, px = cam.x, py = cam.y, pz = cam.z;
    while (steady < 2 && elapsed < 1.6) {
      await wait(STEP, g); checked(g); elapsed += STEP;
      const d = Math.abs(cam.x - px) + Math.abs(cam.y - py) + Math.abs(cam.z - pz);
      const still = d < 0.0015 || (d < 0.03 && Math.abs(d - prevD) < 0.25 * d + 0.0008);
      steady = still ? steady + 1 : 0;
      prevD = d; px = cam.x; py = cam.y; pz = cam.z;
    }
    return elapsed;
  }

  // Every hold: let the camera land, then read for the rest of the hold's time. tour:hold marks its start (tests aim at its middle).
  async function dwell(s, g, seconds) {
    await frames(2); checked(g);
    const dur = seconds / mul();
    emit('tour:hold', { index: stops.indexOf(s), id: s.id, chapter: s.chapter, y: pos, target: s.y, dur, t0: performance.now() });
    const spent = await settle(g);
    await wait(Math.max(dur * 0.55, dur - spent), g); checked(g);
  }

  const holds = {
    async read(s, g) { await dwell(s, g, s.holdSec); },
    // The first reel is B2 (ACT). film.js already previews it muted while it is on screen; the tour just stands still on it.
    async film(s, g) {
      const strip = $('#strip');
      if (strip && strip.scrollLeft > 4) strip.scrollTo({ left: 0, behavior: 'instant' });
      await dwell(s, g, s.holdSec);
    },
    // Read the intro, then click the held-out cell B2 and wait for the reconstruction to finish its task.
    async sandbox(s, g) {
      await dwell(s, g, s.holdSec);
      const cell = $$('#picker button').find((b) => b.textContent.trim() === 'B2');
      const busy = () => $$('#picker button').some((b) => b.getAttribute('aria-disabled') === 'true');
      if (!cell || busy()) { await wait(1.5 / mul(), g); checked(g); return; }
      cell.click();
      emit('tour:acted', { id: 'sandbox', cell: 'B2' });
      for (let t = 0; !busy() && t < 30; t++) { await wait(0.05, g); checked(g); }   // the task has started
      let elapsed = 0;
      const running = () => busy() || !!stage.getTaskProgress?.()?.running;
      while (running() && elapsed < 30) { await wait(0.15, g); checked(g); elapsed += 0.15; }
      await wait(1.2 / mul(), g); checked(g);
    },
  };

  // ---- The loop -----------------------------------------------------------------------------------------------------------
  // Written at device-pixel resolution: a fractional write can be read back a pixel apart from the last one and look like a wobble.
  const setY = (y) => { const d = window.devicePixelRatio || 1; window.scrollTo({ top: Math.round(y * d) / d, left: 0, behavior: 'instant' }); lastSetY = window.scrollY; };

  function tick(ts) {
    requestAnimationFrame(tick);
    const dt = Math.min(0.05, Math.max(0, (ts - last) / 1000));
    last = ts;
    if (state !== 'playing' || !plan) return;

    if (holdRun) {                                             // standing still on a special stop
      for (const w of [...waiters]) { w.left -= dt; if (w.left <= 0) { waiters = waiters.filter((x) => x !== w); w.resolve(); } }
      return;
    }
    const before = pos;
    if (glide) {
      glide.t += dt;
      const k = clamp(glide.t / glide.dur);
      pos = glide.y0 + (glide.y1 - glide.y0) * easeInOutCubic(k);
      vel = 0;
      if (k >= 1) glide = null;
    } else {
      const target = speedAt(pos) * mul();
      vel += (target - vel) * (1 - Math.exp(-dt / TAU));
      if (layoutDirty) refreshGeometry();
      const nextHold = plan.holds.find((h) => !h.done);
      const stopY = nextHold ? nextHold.y : plan.yEnd;
      const d = stopY - pos;
      vel = Math.min(vel, 5 * d + 25);                         // brake into a hold (or the end) along an exponential
      pos = Math.min(stopY, pos + vel * dt);
      if (stopY - pos < 0.75) {
        pos = stopY; vel = 0;
        if (nextHold) { nextHold.done = true; startHold(nextHold); } else { setY(pos); finish(); return; }
      }
    }
    if (Math.abs(pos - before) > 1e-4) setY(pos);
    track(before);
  }

  function startHold(h) {
    const g = gen;
    const run = holds[h.hold ?? 'read'];
    holdRun = (async () => {
      try { await run(h, g); } catch (e) { if (e !== CANCEL) console.warn('tour hold failed', e); }
      if (g === gen) holdRun = null;
    })();
  }

  // Which stop is nearest (pill name, aria-live) and which centres have just been passed (events for tests).
  function track(before) {
    for (let i = 0; i < stops.length; i++) {
      const s = stops[i];
      if ((before < s.y && pos >= s.y) || (before === s.y && i === 0 && !s.passed)) { s.passed = true; emit('tour:arrive', { index: i, id: s.id, chapter: s.chapter, target: s.y, y: pos, count: stops.length }); }
    }
    let best = 0, bd = Infinity;
    stops.forEach((s, i) => { const d = Math.abs(s.y - pos); if (d < bd) { bd = d; best = i; } });
    if (best !== nearIdx) { nearIdx = best; setName(stops[best].name); announce(`${best + 1} of ${stops.length}: ${stops[best].name}`); }
    paintBar((pos - plan.from) / Math.max(1, plan.yEnd - plan.from));
  }

  function finish() {
    state = 'done';
    holdRun = null; waiters = []; glide = null;
    lock(false);
    root.classList.remove('tour-on');
    paintBar(1);
    announce('Tour finished');
    paint();
    emit('tour:done', { count: stops.length });
  }

  // ---- Controls -----------------------------------------------------------------------------------------------------------
  function begin(fromY) {
    gen++; holdRun = null; waiters = []; glide = null; vel = 0;
    pos = clamp(fromY, 0, maxY());
    buildPlan(pos);
    stops.forEach((s) => { s.passed = false; });
    nearIdx = -1;
    if (Math.abs(window.scrollY - pos) > 1) setY(pos); else lastSetY = window.scrollY;
  }
  function start(fromY = 0) {
    if (state === 'playing') return;
    state = 'playing';
    startedAt = performance.now();
    root.classList.add('tour-on');
    lock(true);
    begin(fromY);
    paint();
    emit('tour:start', { count: stops.length });
  }
  function pause() {
    if (state !== 'playing') return;
    state = 'paused';
    lock(false);
    paint();
    announce('Paused');
    emit('tour:pause', { y: pos });
  }
  function resume() {
    if (state !== 'paused') return;
    const moved = Math.abs(window.scrollY - lastSetY) > 4;
    state = 'playing';
    lock(true);
    if (moved) begin(window.scrollY);                            // the visitor scrolled: carry on gliding from where they are
    paint();
    emit('tour:resume', { moved });
  }
  function stop() {
    if (state === 'idle') return;
    gen++; holdRun = null; waiters = []; glide = null;
    state = 'idle';
    lock(false);
    root.classList.remove('tour-on');
    paintBar(0);
    paint();
    announce('Tour stopped');
    emit('tour:stop', {});
  }
  // Left / Right: a smooth glide to the previous / next chapter, then the tour carries on from there.
  function step(dir) {
    if (state !== 'playing' && state !== 'paused') return;
    const wasPaused = state === 'paused';
    const y = wasPaused ? window.scrollY : pos;
    const rootOf = (s) => s.root;
    let i = 0, bd = Infinity;
    stops.forEach((s, k) => { const d = Math.abs(s.y - y); if (d < bd) { bd = d; i = k; } });
    const cur = stops[i];
    const firstOf = (r) => stops.findIndex((s) => rootOf(s) === r);
    let target;
    if (dir > 0) target = stops.find((s) => s.y > y + 0.25 * innerHeight && rootOf(s) !== rootOf(cur)) ?? stops[stops.length - 1];
    else {
      const startCur = stops[firstOf(rootOf(cur))];
      if (y - startCur.y > 0.3 * innerHeight) target = startCur;
      else { const prev = [...stops].reverse().find((s) => s.y < startCur.y - 1); target = prev ? stops[firstOf(rootOf(prev))] : stops[0]; }
    }
    gen++; holdRun = null; waiters = [];
    if (wasPaused) { state = 'playing'; lock(true); paint(); }
    pos = y; vel = 0;
    plan.holds.forEach((h) => { h.done = h.y <= target.y - 1; });     // a hold ahead of the landing point is still to come
    glide = { y0: pos, y1: target.y, t: 0, dur: GLIDE_SECONDS };
    emit('tour:glide', { dir, to: target.id });
  }
  const primary = () => {
    if (state === 'playing') pause();
    else if (state === 'paused') resume();
    else start(state === 'done' ? 0 : window.scrollY < innerHeight * 0.5 ? 0 : window.scrollY);
  };

  // ---- UI -----------------------------------------------------------------------------------------------------------------
  const ICON_PLAY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z"/></svg>';
  const ICON_PAUSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/></svg>';
  function setName(n) { nameEl.textContent = n; }
  function announce(t) { live.textContent = t; }
  function paintBar(f) { barFill.style.transform = `scaleX(${clamp(f).toFixed(4)})`; }
  function paint() {
    label.textContent = state === 'playing' ? 'Pause' : state === 'paused' ? 'Resume' : state === 'done' ? 'Replay' : 'Play the tour';
    toggle.firstElementChild.outerHTML = state === 'playing' ? ICON_PAUSE : ICON_PLAY;
    toggle.setAttribute('aria-describedby', 'tour-name');
    stopBtn.hidden = state === 'idle' || state === 'done';
    pill.dataset.state = state;
    if (state === 'idle') setName('Guided tour');
    syncPill();
  }
  function syncPill() {
    const afterHero = (document.body.dataset.chapter || 'hero') !== 'hero';
    pill.classList.toggle('is-shown', state !== 'idle' || afterHero);
  }
  function paintSpeed() {
    speedBtns.forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.speed) === preset)));
  }
  speedBtns.forEach((b) => b.addEventListener('click', () => {
    preset = Number(b.dataset.speed);                // the velocity filter eases into the new speed: no jump
    try { localStorage.setItem(PREF_KEY, String(preset)); } catch { /* storage blocked */ }
    paintSpeed();
    announce(`Speed ${preset} times`);
  }));

  toggle.addEventListener('click', primary);
  stopBtn.addEventListener('click', stop);
  startBtn.addEventListener('click', () => { if (state === 'idle' || state === 'done') start(0); else primary(); });
  document.addEventListener('chapterchange', syncPill);

  // Any input on the content takes over. The tour's own scrolling never counts (scroll events are not listened to).
  const inPill = (e) => !!e.target?.closest?.('#tour-pill, #tour-start');
  const interrupt = (e) => { if (state === 'playing' && !inPill(e) && performance.now() - startedAt > 250) pause(); };
  addEventListener('wheel', interrupt, { passive: true, capture: true });
  addEventListener('touchstart', interrupt, { passive: true, capture: true });
  addEventListener('pointerdown', interrupt, { capture: true });
  const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End']);
  addEventListener('keydown', (e) => {
    if (state !== 'playing' && state !== 'paused') return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    const typing = t?.closest?.('input, textarea, select, [contenteditable="true"], [role="slider"]');
    if (e.key === 'Escape') { e.preventDefault(); stop(); return; }
    if (typing) return;
    const inControls = !!t?.closest?.('#tour-pill');
    if (e.key === ' ' || e.code === 'Space') {
      if (inControls) return;                                    // the focused button handles it
      if (t?.closest?.('button, a, summary')) { if (state === 'playing') pause(); return; }
      e.preventDefault(); primary(); return;
    }
    if (e.key === 'ArrowRight') { e.preventDefault(); step(1); return; }
    if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); return; }
    if (state === 'playing' && SCROLL_KEYS.has(e.key)) pause();
  }, true);

  paintSpeed();
  paint();
  paintBar(0);
  requestAnimationFrame(tick);
  return { start, pause, resume, stop, step, get state() { return state; }, get stops() { return stops; }, get plan() { return plan; } };
}
