// Development stand-in for js/stage/stage.js. Loaded only with ?mock. Draws a flat 2D ring so the
// text/subject relationship can be judged, and logs every call to window.__stageCalls.
const calls = (window.__stageCalls = []);
const log = (name, ...args) => calls.push([name, ...args]);

export async function createStage(canvas, { onLoadProgress } = {}) {
  if (new URLSearchParams(location.search).has('nogl')) throw new Error('mock: no WebGL');
  const ctx = canvas.getContext('2d');
  const state = { chapter: 'hero', ring: 0, policy: 'act', bright: 0 };
  let clickCb = null;
  const draw = () => {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = (canvas.width = innerWidth * dpr), h = (canvas.height = innerHeight * dpr);
    ctx.clearRect(0, 0, w, h);
    const portrait = innerWidth < 820;
    const cx = portrait ? w * 0.5 : w * 0.72, cy = portrait ? h * 0.28 : h * 0.4;
    const r = Math.min(w, h) * (portrait ? 0.2 : 0.27);
    ctx.lineWidth = 14 * dpr;
    ctx.strokeStyle = `rgba(237,228,207,${0.12 + 0.2 * state.bright})`;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = '#f4c430'; ctx.globalAlpha = state.bright;
    ctx.beginPath(); ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + state.ring * Math.PI * 2); ctx.stroke();
    ctx.globalAlpha = 1; ctx.fillStyle = 'rgba(237,228,207,.5)'; ctx.font = `${13 * dpr}px Archivo, sans-serif`;
    ctx.textAlign = 'center'; ctx.fillText(`mock stage: ${state.chapter}, ${state.policy}`, cx, cy);
  };
  for (let i = 1; i <= 10; i++) { await new Promise((r) => setTimeout(r, 90)); onLoadProgress?.(i / 10); }
  draw();
  addEventListener('resize', draw);
  return {
    available: true,
    setChapter(id) { log('setChapter', id); state.chapter = id; state.bright = 1; draw(); },
    setProgress(id, p) { log('setProgress', id, +p.toFixed(3)); },
    setPolicy(w) { log('setPolicy', w); state.policy = w; draw(); },
    setRingProgress(p) { state.ring = p; draw(); },
    async runTask(cell) { log('runTask', cell); await new Promise((r) => setTimeout(r, 2200)); },
    onCellClick(cb) { clickCb = cb; window.__mockCellClick = (c) => clickCb?.(c); },
    setReducedMotion(on) { log('setReducedMotion', on); },
    pause() { log('pause'); }, resume() { log('resume'); }, dispose() {},
  };
}
