import { gsap } from 'gsap';
import { $, $$, reduced } from './env.js';

const CIRC = 326.73; // 2 * PI * 52
const MIN_MS = 1500; // the ring always takes long enough to be seen drawing
const RING_FRAC = 104 / 120; // drawn circle diameter as a fraction of the svg box

export function initLoader() {
  const root = $('#loader');
  if (!root) return { progress() {}, reveal: async ({ onCue }) => onCue() };
  const fill = $('.loader-fill', root);
  const ring = $('.loader-ring', root);
  const word = $('.loader-word', root);
  const pct = $('#loader-pct', root);
  let target = 0, shown = 0, last = performance.now(), raf = 0, ready = false;

  const clear = `rgba(${getComputedStyle(document.documentElement).getPropertyValue('--wall-2-rgb').trim() || '21, 24, 26'}, 0)`;
  const paint = () => {
    fill.style.strokeDashoffset = String(CIRC * (1 - shown));
    if (pct) pct.textContent = `${Math.round(shown * 100)}%`;
  };
  const tick = (now) => {
    const dt = (now - last) / 1000; last = now;
    shown = Math.min(target, shown + dt * (1000 / MIN_MS));
    paint();
    if (shown < 1) raf = requestAnimationFrame(tick); else ready = true;
  };
  raf = requestAnimationFrame(tick);

  const settled = () => new Promise((res) => {
    const wait = () => (ready ? res() : setTimeout(wait, 30));
    wait();
  });

  // Ring hand-off: glide the loader ring onto the 3D ring's projected rect, tracking it while the stage dollies.
  function morphOntoStage(tl, stage, at) {
    const box = ring.getBoundingClientRect();
    const from = { cx: box.left + box.width / 2, cy: box.top + box.height / 2, d: box.width * RING_FRAC };
    const state = { p: 0 };
    tl.to(state, {
      p: 1, duration: 1.5, ease: 'power3.inOut',
      onUpdate() {
        const r = stage.getRingScreenRect?.();
        if (!r) return;
        const to = { cx: r.x + r.width / 2, cy: r.y + r.height / 2, d: r.width };
        const e = state.p;
        gsap.set(ring, {
          x: (to.cx - from.cx) * e, y: (to.cy - from.cy) * e,
          scale: 1 + (to.d / from.d - 1) * e, transformOrigin: '50% 50%',
        });
      },
    }, at);
    tl.to(ring, { opacity: 0, duration: 0.6, ease: 'power1.in' }, at + 0.9);
  }

  return {
    progress(f) { target = Math.max(target, Math.min(1, f)); },
    // onCue fires as the ring lets go: the page brings the hero chapter and scroll online, and the
    // stage (if it supports it) ignites its ring light.
    async reveal({ onCue, stage }) {
      if (window.__failsafe) { root.remove(); onCue(); return; } // page was already revealed by the failsafe
      this.progress(1);
      await settled();
      cancelAnimationFrame(raf);
      document.documentElement.classList.remove('is-loading');
      const lines = $$('.hero-title .line > span');
      const fades = $$('.hero-fade');
      const done = () => { root.remove(); fades.forEach((el) => (el.style.opacity = '')); };
      const canMorph = typeof stage?.getRingScreenRect === 'function' && !!stage.getRingScreenRect();

      if (reduced) {
        gsap.set(lines, { yPercent: 0 }); gsap.set(fades, { opacity: 1 });
        onCue(); stage?.reveal?.();
        gsap.to(root, { opacity: 0, duration: 0.4, onComplete: done });
        return;
      }
      gsap.set(lines, { yPercent: 118 });
      gsap.set(fades, { opacity: 0, y: 14 });
      await new Promise((resolve) => {
        const tl = gsap.timeline({ onComplete: () => { done(); resolve(); } });
        tl.to([word, pct], { opacity: 0, y: 8, duration: 0.45, ease: 'power2.in' }, 0)
          .call(() => { onCue(); if (typeof stage?.reveal === 'function') stage.reveal(); }, null, 0.25);
        if (canMorph) {
          morphOntoStage(tl, stage, 0.25);
          tl.to(root, { backgroundColor: clear, duration: 1.1, ease: 'power2.inOut' }, 0.5);
        } else {
          tl.to(ring, { scale: 26, duration: 1.7, ease: 'expo.in', transformOrigin: '50% 50%' }, 0.25)
            .to('.loader-fill, .loader-track', { strokeWidth: 0.12, duration: 1.7, ease: 'expo.in' }, 0.25)
            .to(ring, { opacity: 0, duration: 0.55, ease: 'power1.in' }, 1.35)
            .to(root, { backgroundColor: clear, duration: 1.25, ease: 'power2.inOut' }, 0.55);
        }
        tl.to(lines, { yPercent: 0, duration: 1.25, ease: 'power4.out', stagger: 0.12 }, 1.25)
          .to(fades, { opacity: 1, y: 0, duration: 0.9, ease: 'power3.out', stagger: 0.12, clearProps: 'transform' }, 1.75);
      });
    },
  };
}
