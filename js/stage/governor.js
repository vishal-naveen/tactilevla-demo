// Adaptive pixel ratio: keeps frame time inside budget by trading resolution, and slowly gives it back.
//
// The budget is measured against the display's real refresh period (estimated from the frame intervals themselves), so a
// 60 Hz phone holding 60 fps is "on budget", not slow. Resolution only drops after SUSTAINED misses (two windows in a row,
// or one window that is far over), never on load hitches (warm-up frames are ignored), never below `floor` (the soft
// floor, e.g. 1.5 on a DPR >= 2 screen) unless the device is genuinely struggling there for several more windows, and it
// climbs back after a cool-down that lengthens every time a level proved too expensive (no oscillation).
const WINDOW = 90
const WARMUP = 45 // frames ignored after start / reset(): shader uploads, first-use buffers, chapter switches
const STEP_DOWN = 0.15
const STEP_UP = 0.05
const HARD_FLOOR = 1.0
const REFRESH_RATES_MS = [1000 / 240, 1000 / 144, 1000 / 120, 1000 / 90, 1000 / 60] // anything slower is treated as 60 Hz
const STRUGGLE_WINDOWS = 4 // slow windows at the soft floor before we dip below it

export function createGovernor({ max, floor = HARD_FLOOR, onChange, onStruggle = () => {}, now = () => performance.now() }) {
  let dpr = max
  floor = Math.min(Math.max(floor, HARD_FLOOR), max)
  const buf = new Float32Array(WINDOW)
  const tmp = new Float32Array(WINDOW)
  let n = 0
  let skip = WARMUP
  let calm = 0
  let slowRun = 0
  let floorSlow = 0
  let period = 1000 / 60 // display refresh period estimate (ms); only ever tightens (a slow GPU cannot fake a fast display)
  let upBlockedUntil = 0
  let strikes = 0
  const log = [] // decisions, newest last (test hook)
  const note = (kind, extra) => { log.push({ t: Math.round(now()), kind, dpr, period: +period.toFixed(2), ...extra }); if (log.length > 60) log.shift() }

  const slowMs = () => (period < 12 ? 18.5 : Math.min(period * 1.17, 19.5))
  const fastMs = () => period * 1.1 // running flat out at the refresh rate

  function setDpr(d, kind, extra) {
    dpr = d; onChange(dpr); note(kind, extra)
  }

  return {
    get dpr() { return dpr },
    get period() { return period },
    get log() { return log },
    setMax(m) { max = m; floor = Math.min(floor, max); if (dpr > max) setDpr(max, 'clamp') },
    /** Feed the interval between two consecutive rendered frames (ms). Ignore stalls / mode switches via reset(). */
    sample(ms) {
      // A frame > 50 ms is a stall (tab switch, video decode, GC...), not GPU load: dropping resolution would not help
      // and every resize is itself a hitch, so such frames are ignored.
      if (ms > 50) return
      if (skip > 0) { skip--; return }
      buf[n++] = ms
      if (n < WINDOW) return
      n = 0
      let sum = 0
      for (let i = 0; i < WINDOW; i++) sum += buf[i]
      const avg = sum / WINDOW
      // display period: the 20th-percentile interval snapped to a real refresh rate (only when it is a plausible vsync gap)
      tmp.set(buf); tmp.sort()
      const p20 = tmp[Math.floor(WINDOW * 0.2)]
      let snapped = REFRESH_RATES_MS[REFRESH_RATES_MS.length - 1]
      for (const r of REFRESH_RATES_MS) if (Math.abs(p20 - r) < Math.abs(p20 - snapped)) snapped = r
      if (p20 < 20 && snapped < period - 0.2) { period = snapped; note('refresh', { p20: +p20.toFixed(2) }) }

      const t = now()
      const over = avg > slowMs()
      slowRun = over ? slowRun + 1 : 0
      if (over && (slowRun >= 2 || avg > slowMs() * 1.6)) {
        calm = 0
        if (dpr > floor + 1e-3) {
          const from = dpr
          strikes = Math.min(strikes + 1, 4)
          upBlockedUntil = t + 12000 * 2 ** (strikes - 1)
          setDpr(Math.max(floor, +(dpr - STEP_DOWN).toFixed(3)), 'down', { avg: +avg.toFixed(2), from })
          slowRun = 0
        } else if (dpr > HARD_FLOOR + 1e-3 && ++floorSlow >= STRUGGLE_WINDOWS) {
          floorSlow = 0
          setDpr(Math.max(HARD_FLOOR, +(dpr - STEP_DOWN).toFixed(3)), 'down-below-floor', { avg: +avg.toFixed(2) })
          onStruggle()
        }
      } else if (!over) {
        floorSlow = 0
        if (avg < fastMs() && dpr < max - 1e-3 && t >= upBlockedUntil) {
          if (++calm >= 3) { calm = 0; setDpr(Math.min(max, +(dpr + STEP_UP).toFixed(3)), 'up', { avg: +avg.toFixed(2) }) }
        } else calm = 0
      }
    },
    reset() { n = 0; skip = Math.max(skip, WARMUP >> 1); slowRun = 0 },
  }
}
