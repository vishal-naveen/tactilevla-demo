// Is the 3D scene actually usable here? A GPU can pass the hardware probe and still crawl (old integrated graphics,
// a blocklisted driver, a busy machine) or stop drawing outright, which leaves a blank or 1 fps page. This samples
// the stage's own frame counter while it is supposed to be running and calls onUnhealthy once if it can't keep up.
// Time is wall-clock, not timer ticks: on a crawling GPU every frame blocks the main thread and timers fire late.
const TICK_MS = 250;
const WARMUP_MS = 1500;  // active time ignored after start: shader warm-up, first-use buffers, the reveal dolly
const WINDOW_MS = 2000;  // active time per measurement
const FLOOR_FPS = 6;     // one window under this = unusable (or not drawing at all)
const SLOW_FPS = 15;     // two windows in a row under this = too slow to scroll through

export function watchStageHealth({ getFrames, isActive, onUnhealthy }) {
  let warmFrom = null, base = null, baseAt = 0, slow = 0, timer = 0;
  const reset = () => { warmFrom = null; base = null; slow = 0; };
  const stop = () => { clearInterval(timer); timer = 0; };
  const tick = () => {
    const frames = getFrames();
    const now = performance.now();
    if (frames == null || !isActive()) { reset(); return; } // no stage (yet), or paused / hidden: not meant to draw
    if (warmFrom == null) { warmFrom = now; return; }
    if (now - warmFrom < WARMUP_MS) return;
    if (base == null || frames < base) { base = frames; baseAt = now; return; } // (re)start; a re-created stage counts from 0
    if (now - baseAt < WINDOW_MS) return;
    const fps = ((frames - base) * 1000) / (now - baseAt);
    base = frames; baseAt = now;
    slow = fps < SLOW_FPS ? slow + 1 : 0;
    if (fps < FLOOR_FPS || slow >= 2) { stop(); onUnhealthy(fps); }
  };
  timer = setInterval(tick, TICK_MS);
  return { stop };
}
