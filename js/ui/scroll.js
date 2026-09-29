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
const debounce = (fn, ms) => { let t = 0; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); }; };

export function initScroll({ stage }) {
  let lenis = null;
  if (!reduced) {
    lenis = new Lenis({ lerp: 0.09, wheelMultiplier: 0.9, touchMultiplier: 1.4, smoothWheel: true });
    lenis.on('scroll', ScrollTrigger.update);
    gsap.ticker.add((t) => lenis.raf(t * 1000));
    gsap.ticker.lagSmoothing(0);
  }

  // Chapter changes, in both directions. Debounced so a fast fling doesn't queue camera moves.
  if (!reduced) document.documentElement.classList.add('beats-on'); // reduced motion: beats read as plain paragraphs
  // What the stage should be showing right now; lets a late-arriving stage catch up (see resync).
  const state = { chapter: 'hero', progress: {}, ring: 0 };
  const setChapter = debounce((id) => stage.setChapter(id), 80);
  const enter = (id) => { state.chapter = id; document.body.dataset.chapter = id; setChapter(id); document.dispatchEvent(new CustomEvent('chapterchange', { detail: id })); };
  $$('[data-chapter]').forEach((sec) => {
    const id = sec.dataset.chapter;
    ScrollTrigger.create({
      trigger: sec, start: 'top 62%', end: 'bottom 62%',
      onEnter: () => enter(id), onEnterBack: () => enter(id),
    });
  });

  // Scrubbed chapters: stage progress plus any text that phases in with it.
  $$('[data-scrub]').forEach((sec) => {
    const id = sec.dataset.chapter;
    const phased = reduced ? [] : $$('[data-scrub-in]', sec).map(parseRange);
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
    apply(0);
    ScrollTrigger.create({
      trigger: sec, start: 'top top', end: 'bottom bottom',
      onUpdate: (self) => apply(self.progress),
      onRefresh: (self) => apply(self.progress),
    });
  });

  // Whole-page progress drives the ring light's bright arc.
  const rail = $('#rail');
  const railFill = $('#rail-fill');
  const buildTicks = () => {
    if (!rail) return;
    rail.querySelectorAll('b').forEach((b) => b.remove());
    const span = document.documentElement.scrollHeight - innerHeight;
    if (span <= 0) return;
    $$('[data-chapter]').forEach((sec) => {
      const b = document.createElement('b');
      b.style.top = `${Math.min(99.5, (sec.offsetTop / span) * 100)}%`;
      rail.append(b);
    });
  };
  ScrollTrigger.create({
    start: 0, end: 'max',
    onUpdate: (self) => { state.ring = self.progress; stage.setRingProgress(self.progress); railFill?.style.setProperty('--p', self.progress.toFixed(4)); },
  });
  ScrollTrigger.addEventListener('refresh', buildTicks);

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

  const refresh = () => ScrollTrigger.refresh();
  if (document.readyState === 'complete') refresh(); else addEventListener('load', refresh, { once: true });
  document.fonts?.ready.then(refresh);
  // Push the current scroll state to the stage (used when it attaches after the page is already live).
  const resync = () => {
    stage.setChapter(state.chapter);
    Object.entries(state.progress).forEach(([id, p]) => stage.setProgress(id, p));
    stage.setRingProgress(state.ring);
  };
  return { lenis, refresh, resync, currentChapter: () => state.chapter };
}
