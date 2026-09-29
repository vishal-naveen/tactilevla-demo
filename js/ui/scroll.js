import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import Lenis from 'lenis';
import { $, $$, clamp, reduced } from './env.js';

gsap.registerPlugin(ScrollTrigger);

const scrubListeners = new Map(); // chapter id -> [(p) => void]
export function onScrub(id, fn) {
  if (!scrubListeners.has(id)) scrubListeners.set(id, []);
  scrubListeners.get(id).push(fn);
}

// data-scrub-in="inStart,inEnd[,outStart,outEnd]": fades in over the first pair, out over the second.
function parseRange(el) {
  const [a, b, c, d] = el.dataset.scrubIn.split(',').map(Number);
  return { el, a, b, c, d };
}

// Touch devices (iPad Safari reports a Macintosh UA, so ask the input media queries, not the UA string).
const coarse = matchMedia('(pointer: coarse), (hover: none)').matches;
const touchCapable = coarse || navigator.maxTouchPoints > 0;

// ScrollTrigger must not re-measure the page for browser chrome (iOS toolbar collapse = a height-only resize). Its own resize
// listener is dropped and every refresh is requested through requestRefresh() below, which defers it until scrolling is idle.
ScrollTrigger.config({ ignoreMobileResize: true, autoRefreshEvents: 'visibilitychange,DOMContentLoaded,load' });

// What decides the active chapter and the camera blend is LIVE geometry (getBoundingClientRect on the chapter elements every
// frame the page scrolls), never positions cached at refresh time. Cached positions go stale on iPad whenever the document
// height changes after `load` (web fonts, media metadata, the stage attaching, text re-wrapping) because Safari's URL bar
// makes height-only resizes untrustworthy, so refreshes are rare there. ScrollTrigger is kept only for the touch bars and the
// rail ticks, which tolerate a late refresh.
const READ = 0.55;        // the reading line, as a fraction of the viewport height
const ZONE_BEFORE = 0.4;  // the stage starts moving toward chapter B when B's top is this far (x viewport) below the reading line...
const ZONE_AFTER = 0.2;   // ...and has arrived when B's top is this far above it
const HYST = 24;          // px the reading line must be inside a chapter before it takes over (no flicker on a boundary)
const REFRESH_IDLE_MS = 150;

export function initScroll({ stage }) {
  let lenis = null;
  if (!reduced) {
    // Lenis smooths wheel / trackpad only. Touch scrolling stays 100 % native (iOS momentum, rubber band, toolbar collapse).
    lenis = new Lenis({ lerp: 0.09, wheelMultiplier: 0.9, smoothWheel: true, syncTouch: false });
    lenis.on('scroll', ScrollTrigger.update);
    gsap.ticker.add((t) => lenis.raf(t * 1000));
    gsap.ticker.lagSmoothing(0);
    if (touchCapable) {
      // Lenis registers window-level NON-passive touchstart/move/end listeners even with syncTouch off. On iOS a non-passive
      // touch listener makes scrolling wait on the main thread, so every WebGL frame that overruns stutters the scroll
      // ("cuts", then a late jump). Remove them; a passive touchstart just cancels a wheel glide that is still running.
      const vs = lenis.virtualScroll;
      const off = { passive: false };
      vs.element.removeEventListener('touchstart', vs.onTouchStart, off);
      vs.element.removeEventListener('touchmove', vs.onTouchMove, off);
      vs.element.removeEventListener('touchend', vs.onTouchEnd, off);
      addEventListener('touchstart', () => { if (lenis.isScrolling === 'smooth') lenis.scrollTo(window.scrollY, { immediate: true, force: true }); }, { passive: true });
    }
  }

  if (!reduced) document.documentElement.classList.add('beats-on'); // reduced motion: beats read as plain paragraphs
  // What the stage should be showing right now; lets a late-arriving stage catch up (see resync).
  const state = { chapter: 'hero', progress: {}, ring: 0 };
  const chapters = $$('main [data-chapter]').map((el) => ({ el, id: el.dataset.chapter, top: 0, bottom: 0 })); // document order = visual order
  const enter = (id) => { state.chapter = id; document.body.dataset.chapter = id; stage.setChapter(id); document.dispatchEvent(new CustomEvent('chapterchange', { detail: id })); };

  // Scrubbed chapters: stage progress plus any text that phases in with it. Progress = where the viewport is between the
  // chapter's top reaching the viewport top and its bottom reaching the viewport bottom (ScrollTrigger's 'top top' -> 'bottom bottom').
  const scrubs = $$('main [data-scrub]').map((sec) => {
    const id = sec.dataset.chapter;
    const phased = reduced ? [] : $$('[data-scrub-in]', sec).map(parseRange);
    const entry = chapters.find((c) => c.el === sec);
    const apply = (p) => {
      state.progress[id] = p;
      stage.setProgress(id, p);
      scrubListeners.get(id)?.forEach((fn) => fn(p));
      phased.forEach(({ el, a, b, c, d }) => {
        const tin = clamp((p - a) / (b - a));
        const tout = c === undefined ? 1 : 1 - clamp((p - c) / (d - c));
        el.style.opacity = String(tin * tout);
        el.style.transform = reduced ? '' : `translateY(${(1 - tin) * 14 - (1 - tout) * 10}px)`;
      });
    };
    return { entry, apply, last: NaN };
  });

  // Whole-page progress drives the ring light's bright arc.
  const rail = $('#rail');
  const railFill = $('#rail-fill');
  const buildTicks = () => {
    if (!rail) return;
    rail.querySelectorAll('b').forEach((b) => b.remove());
    const span = document.documentElement.scrollHeight - innerHeight;
    if (span <= 0) return;
    chapters.forEach(({ el }) => {
      const b = document.createElement('b');
      b.style.top = `${Math.min(99.5, ((el.getBoundingClientRect().top + window.scrollY) / span) * 100)}%`;
      rail.append(b);
    });
  };
  ScrollTrigger.addEventListener('refresh', buildTicks);

  let active = 0;                 // index into `chapters` of the chapter under the reading line
  const sent = { from: '', to: '', t: -1 };
  let lastRing = NaN;

  // Which chapter owns the reading line: the last one whose top is above it, with hysteresis at the boundaries.
  const pickActive = (line) => {
    let i = active;
    while (i + 1 < chapters.length && chapters[i + 1].top + HYST <= line) i++;      // moved forward past the next top
    if (chapters[i].top - line > HYST) {                                            // moved back above the active top
      i = 0;
      while (i + 1 < chapters.length && chapters[i + 1].top <= line) i++;
    }
    return i;
  };

  // Fractional position along the chapter list: each boundary contributes 0..1 across its transition zone, so the value is
  // continuous and monotonic even where zones of short chapters overlap. floor -> the pair, fraction -> t.
  const sendBlend = (line, H, force) => {
    if (reduced || chapters.length < 2) return;
    const span = (ZONE_BEFORE + ZONE_AFTER) * H;
    let x = 0;
    for (let i = 1; i < chapters.length; i++) x += clamp((line - chapters[i].top + ZONE_BEFORE * H) / span);
    const k = Math.min(chapters.length - 2, Math.floor(x));
    const t = clamp(x - k);
    const from = chapters[k].id, to = chapters[k + 1].id;
    if (!force && from === sent.from && to === sent.to && Math.abs(t - sent.t) < 4e-4) return;
    sent.from = from; sent.to = to; sent.t = t;
    stage.setChapterBlend(from, to, t);
  };

  function measure(force = false) {
    const H = innerHeight, line = READ * H, y = window.scrollY;
    for (const c of chapters) { const r = c.el.getBoundingClientRect(); c.top = r.top; c.bottom = r.bottom; }
    const next = pickActive(line);
    sendBlend(line, H, force); // before enter(): the stage must know the blend is in use when setChapter arrives
    if (next !== active || force) {
      const changed = chapters[next].id !== state.chapter || force;
      active = next;
      if (changed) enter(chapters[next].id);
    }
    for (const sc of scrubs) {
      const { top, bottom } = sc.entry;
      const p = clamp(-top / Math.max(1, bottom - top - H));
      if (force || Math.abs(p - sc.last) > 1e-5 || Number.isNaN(sc.last)) { sc.last = p; sc.apply(p); }
    }
    const max = document.documentElement.scrollHeight - H;
    const ring = max > 0 ? clamp(y / max) : 0;
    if (force || Math.abs(ring - lastRing) > 1e-5 || Number.isNaN(lastRing)) {
      lastRing = ring; state.ring = ring; stage.setRingProgress(ring); railFill?.style.setProperty('--p', ring.toFixed(4));
    }
  }

  // Layout changes (fonts, media metadata, the stage attaching, wrapping) only need to mark the live measurement dirty; the
  // ScrollTrigger refresh for the bars/ticks then waits until scrolling has been idle, so it can never cancel a momentum fling.
  let lastY = NaN, lastCheck = 0, dirty = true, lastScrollAt = 0, refreshDue = false;
  const requestRefresh = () => { refreshDue = true; dirty = true; };
  const tick = () => {
    const y = window.scrollY, now = performance.now();
    if (y !== lastY) { lastY = y; lastScrollAt = now; dirty = true; }
    if (dirty || now - lastCheck > 250) { dirty = false; lastCheck = now; measure(); }
    if (refreshDue && now - lastScrollAt > REFRESH_IDLE_MS) { refreshDue = false; ScrollTrigger.refresh(); dirty = true; }
  };
  gsap.ticker.add(tick);
  measure(true);

  // Touch chart bars grow with the scroll, not on a timer.
  const bars = $$('.b-bar i');
  if (bars.length && !reduced) {
    bars.forEach((el) => el.style.setProperty('--grow', '0'));
    ScrollTrigger.create({
      trigger: '.bars', start: 'top 85%', end: 'bottom 55%',
      onUpdate: (self) => bars.forEach((el, i) => {
        const t = clamp(self.progress * 1.6 - i * 0.08);
        el.style.setProperty('--grow', String(1 - Math.pow(1 - t, 3)));
      }),
    });
  }

  // Top bar turns into a blurred strip once the page moves.
  const bar = $('#topbar');
  const syncBar = () => bar.classList.toggle('is-scrolled', window.scrollY > 40);
  addEventListener('scroll', syncBar, { passive: true }); syncBar();

  // In-page anchors.
  $$('a[data-scroll]').forEach((a) => a.addEventListener('click', (e) => {
    const target = $(a.getAttribute('href'));
    if (!target) return;
    e.preventDefault();
    if (lenis) lenis.scrollTo(target, { duration: 2.2, easing: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2), onComplete: () => target.focus({ preventScroll: true }) });
    else { target.scrollIntoView(); target.focus({ preventScroll: true }); }
  }));

  // Real viewport changes (rotation, Split View, a window resize): a width change or, on touch, a height change > 25 %. An iOS toolbar
  // collapse is a small height-only change and never refreshes anything.
  {
    let w = innerWidth, h = innerHeight, t = 0;
    addEventListener('resize', () => {
      clearTimeout(t);
      t = setTimeout(() => {
        const dw = innerWidth !== w, dh = Math.abs(innerHeight - h);
        if (dw || dh > (coarse ? 0.25 * h : 0)) { w = innerWidth; h = innerHeight; requestRefresh(); }
        dirty = true;
      }, 220);
    }, { passive: true });
  }
  // Anything that changes the document height after `load`: the body's own size (text wrapping, lazy media, late attaches),
  // web fonts, media metadata. A height change that coincides with the viewport height changing a little on touch is the iOS
  // toolbar moving the vh-based sections, not layout, and is skipped.
  if (typeof ResizeObserver === 'function') {
    let roH = innerHeight, roW = innerWidth;
    new ResizeObserver(() => {
      dirty = true;
      const toolbar = touchCapable && innerWidth === roW && innerHeight !== roH && Math.abs(innerHeight - roH) <= 0.25 * roH;
      roH = innerHeight; roW = innerWidth;
      if (!toolbar) requestRefresh();
    }).observe(document.body);
  }
  if (document.readyState === 'complete') requestRefresh(); else addEventListener('load', requestRefresh, { once: true });
  document.fonts?.ready.then(requestRefresh);
  document.fonts?.addEventListener?.('loadingdone', requestRefresh);
  document.addEventListener('loadedmetadata', requestRefresh, true); // media events do not bubble; capture sees every <video>
  document.addEventListener('loadeddata', () => { dirty = true; }, true);
  // Push the current scroll state to the stage (used when it attaches after the page is already live).
  const resync = () => {
    measure(); // fresh geometry first
    sendBlend(READ * innerHeight, innerHeight, true);
    stage.setChapter(state.chapter);
    scrubs.forEach((sc) => { if (!Number.isNaN(sc.last)) sc.apply(sc.last); });
    stage.setRingProgress(state.ring);
    requestRefresh(); // the stage attaching can change the layout (canvas, poster fade)
  };
  const refresh = () => { requestRefresh(); ScrollTrigger.refresh(); };
  return { lenis, refresh, resync, currentChapter: () => state.chapter };
}
