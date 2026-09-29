// Environment flags shared by the UI modules.
export const params = new URLSearchParams(location.search);
export const useMock = params.has('mock');
export const forceNoGL = params.has('nogl'); // test hook: behave as if WebGL were unavailable
export const reducedQuery = matchMedia('(prefers-reduced-motion: reduce)');
export const reduced = reducedQuery.matches;

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));

// Stand-in used when the real stage cannot start. Every call is a harmless no-op.
export const nullStage = Object.freeze({
  available: false,
  setChapter() {}, setProgress() {}, setPolicy() {}, setRingProgress() {},
  runTask: () => Promise.resolve(), onCellClick() {}, setReducedMotion() {},
  pause() {}, resume() {}, dispose() {},
});
