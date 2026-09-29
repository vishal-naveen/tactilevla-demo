// Measured text safe area. The 3D phase words must never sit on the page's text, and "where the text ends" is not a
// viewport fraction: it differs per chapter, per breakpoint, and it moves while a panel scrolls or a beat fades in.
// So this module measures the real thing (text line boxes, buttons, figures and the like inside every chapter that is on
// screen) in viewport CSS px, and hands it to the stage: stage.setTextSafeArea({ left, top, right, bottom, rects } | null), where
// left..bottom is the union and `rects` the separate blocks it is made of (text column, a floating readout card, ...): items
// less than GAP px apart are merged into one block, so the free space between distant blocks stays usable for the 3D.
// Sent on chapter change, resize / rotation, font load, the loader handing off, and (one rAF at most) on scroll.
import { $$ } from './env.js';

const BLOCKS = 'img, video, svg, canvas, button, input, select, textarea, .btn, figure, .picker, .sandbox-hud, .glance, .disclaimer, .clip';
const SKIP = '.stage-phases, .stage-label, #loader, #stage, .stage-badge, .rail, #topbar, script, style, noscript, [hidden]';
const MIN_OPACITY = 0.05;
const GAP = 40; // px: items closer than this belong to the same block

// Cache per chapter element: the text nodes and block elements to measure, and the scrub gate (inline opacity) each sits under.
function collect(chapter) {
  const items = [];
  const gateOf = (el) => el.closest('[data-scrub-in]');
  const tw = document.createTreeWalker(chapter, NodeFilter.SHOW_TEXT);
  for (let n; (n = tw.nextNode());) {
    const host = n.parentElement;
    if (!host || !n.nodeValue.trim() || host.closest(SKIP)) continue;
    items.push({ text: n, gate: gateOf(host), host });
  }
  for (const el of chapter.querySelectorAll(BLOCKS)) {
    if (el.closest(SKIP)) continue;
    items.push({ el, gate: gateOf(el), host: el });
  }
  return items;
}

const visibleNow = (host) => {
  // display:none / visibility:hidden ancestors (e.g. a [hidden] button, a collapsed block) have no boxes at all
  return host.getClientRects().length > 0;
};

export function initSafeArea(stage) {
  const cache = new WeakMap();
  const range = document.createRange();
  let last = null;
  let raf = 0;

  const itemsFor = (chapter) => {
    let items = cache.get(chapter);
    if (!items) { items = collect(chapter); cache.set(chapter, items); }
    return items;
  };

  function measure() {
    const vw = innerWidth, vh = innerHeight;
    const boxes = [];
    for (const chapter of $$('[data-chapter]')) {
      const cr = chapter.getBoundingClientRect();
      if (cr.bottom < 0 || cr.top > vh) continue;
      for (const it of itemsFor(chapter)) {
        if (it.text ? !it.text.isConnected : !it.el.isConnected) continue;
        if (it.gate && +(it.gate.style.opacity || 1) < MIN_OPACITY) continue; // a beat that has not faded in (or has faded out)
        if (!visibleNow(it.host)) continue;
        const hq = it.host.getBoundingClientRect();
        if (hq.width <= 2 || hq.height <= 2) continue; // visually-hidden (sr-only) text
        let q;
        if (it.text) { range.selectNodeContents(it.text); q = range.getBoundingClientRect(); } else q = hq;
        if (q.width < 1 || q.height < 1 || q.bottom <= 0 || q.top >= vh || q.right <= 0 || q.left >= vw) continue;
        boxes.push({ left: Math.max(0, q.left), top: Math.max(0, q.top), right: Math.min(vw, q.right), bottom: Math.min(vh, q.bottom) });
      }
    }
    if (!boxes.length) return null;
    // merge boxes that touch or lie within GAP px of each other, until stable
    let blocks = boxes;
    for (let merged = true; merged;) {
      merged = false;
      const out = [];
      for (const bx of blocks) {
        const hit = out.find((o) => bx.left < o.right + GAP && bx.right > o.left - GAP && bx.top < o.bottom + GAP && bx.bottom > o.top - GAP);
        if (hit) { hit.left = Math.min(hit.left, bx.left); hit.top = Math.min(hit.top, bx.top); hit.right = Math.max(hit.right, bx.right); hit.bottom = Math.max(hit.bottom, bx.bottom); merged = true; }
        else out.push({ ...bx });
      }
      blocks = out;
    }
    const u = blocks.reduce((a, o) => ({ left: Math.min(a.left, o.left), top: Math.min(a.top, o.top), right: Math.max(a.right, o.right), bottom: Math.max(a.bottom, o.bottom) }), { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity });
    return { ...u, rects: blocks };
  }

  const near = (a, b) => ['left', 'top', 'right', 'bottom'].every((k) => Math.abs(a[k] - b[k]) < 0.5);
  const same = (a, b) => (!a && !b) || (a && b && near(a, b) && a.rects.length === b.rects.length && a.rects.every((r, i) => near(r, b.rects[i])));
  function send() {
    raf = 0;
    const rect = measure();
    if (same(rect, last)) return;
    last = rect;
    stage.setTextSafeArea(rect);
  }
  const soon = () => { if (!raf) raf = requestAnimationFrame(send); };
  const rebuild = () => { $$('[data-chapter]').forEach((c) => cache.delete(c)); soon(); };

  document.addEventListener('chapterchange', rebuild);
  addEventListener('scroll', soon, { passive: true });
  addEventListener('resize', rebuild, { passive: true });
  addEventListener('orientationchange', rebuild);
  addEventListener('load', rebuild, { once: true });
  window.visualViewport?.addEventListener('resize', rebuild, { passive: true });
  document.fonts?.ready.then(rebuild);
  document.fonts?.addEventListener?.('loadingdone', rebuild);
  // the loader handing off / the reduced and no-stage classes change layout without any of the events above
  new MutationObserver(rebuild).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  rebuild();
  return { measure, refresh: rebuild };
}
