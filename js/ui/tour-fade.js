// While the tour runs (html.tour-on), a text panel that is only just entering from the bottom stays faded, and fades in
// continuously as it scrolls up. Opacity is a pure function of the panel's position (no timed fades), so nothing pops:
// a held stop shows only its own chapter, and the next heading arrives smoothly as the glide carries it up.
import { $$, clamp } from './env.js';

const smooth = (t) => t * t * (3 - 2 * t);
const IN_FROM = 0.85; // panel top at 85% of the viewport height: invisible
const IN_TO = 0.68;   // ...at 68%: fully visible
const OUT_TO = 0.07;  // panel bottom at 7% (under the top bar): invisible
const OUT_FROM = 0.2; // ...at 20%: fully visible

export function initTourFade() {
  const root = document.documentElement;
  let raf = 0;
  let panels = [];

  function frame() {
    raf = 0;
    if (!root.classList.contains('tour-on')) return;
    const h = innerHeight;
    for (const el of panels) {
      const r = el.getBoundingClientRect();
      const a = smooth(clamp((IN_FROM - r.top / h) / (IN_FROM - IN_TO))) * smooth(clamp((r.bottom / h - OUT_TO) / (OUT_FROM - OUT_TO)));
      const v = a > 0.995 ? '' : a.toFixed(3);
      if (el.style.opacity !== v) el.style.opacity = v;
    }
    raf = requestAnimationFrame(frame);
  }

  function sync() {
    if (root.classList.contains('tour-on')) {
      panels = $$('[data-chapter] .panel');
      if (!raf) raf = requestAnimationFrame(frame);
    } else {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      panels.forEach((el) => { el.style.opacity = ''; });
    }
  }

  new MutationObserver(sync).observe(root, { attributes: true, attributeFilter: ['class'] });
  sync();
}
