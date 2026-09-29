// Adaptive pixel ratio: keeps frame time inside budget by trading resolution, and slowly gives it back.
const WINDOW = 90
const SLOW_MS = 18
const FAST_MS = 12
const STEP_DOWN = 0.15
const STEP_UP = 0.05

export function createGovernor({ max, min = 1.0, onChange }) {
  let dpr = max
  const buf = new Float32Array(WINDOW)
  let n = 0
  let calm = 0
  return {
    get dpr() { return dpr },
    setMax(m) { max = m; if (dpr > max) { dpr = max; onChange(dpr) } },
    /** Feed the interval between two consecutive rendered frames (ms). Ignore stalls / mode switches via reset(). */
    sample(ms) {
      // A frame > 50 ms is a stall (tab switch, video decode, GC...), not GPU load: dropping resolution would not help
      // and every resize is itself a hitch, so such frames are ignored.
      if (ms > 50) return
      buf[n++] = ms
      if (n < WINDOW) return
      n = 0
      let sum = 0
      for (let i = 0; i < WINDOW; i++) sum += buf[i]
      const avg = sum / WINDOW
      if (avg > SLOW_MS && dpr > min + 1e-3) {
        dpr = Math.max(min, +(dpr - STEP_DOWN).toFixed(3)); calm = 0; onChange(dpr)
      } else if (avg < FAST_MS && dpr < max - 1e-3) {
        if (++calm >= 3) { dpr = Math.min(max, +(dpr + STEP_UP).toFixed(3)); calm = 0; onChange(dpr) }
      } else calm = 0
    },
    reset() { n = 0 },
  }
}
