// Frame pacing for the flight (round 12 CADENCE). Installed by boot.js before anything schedules a frame.
//
// The owner's own Chrome (M3 Pro, 120 Hz) presented the flight at a cadence that kept flipping between 120 and 60 fps
// (rec.js: 12 % of frames > 10 ms while scrolling, 1-2-1-2 vsync alternation for tens of seconds at rest): each frame's
// work sat right at the 8.3 ms budget, so some made the vsync and some did not. An uneven cadence reads as judder; a
// steady 60 does not. So:
//   - window.requestAnimationFrame is replaced: every per-frame consumer (the stage frame with the director inside it,
//     rec.js, the UI's one-off frames) runs in ONE batch per presented frame, in request order, with the native vsync
//     timestamp (motion stays continuous: dt is always a whole number of vsyncs).
//   - The batch runs on every vsync (120 mode) or on every second vsync (60 mode, evenly spaced; a late callback shifts
//     the phase once instead of waiting a third vsync). Video, CSS transitions and audio do not go through rAF: unaffected.
//   - 120 -> 60: 3 missed vsyncs within the last 120 frames (1 s), or 2 during a trial. Stalls (>= 4 vsyncs: GC, tab
//     switch, first-use uploads) are not counted.
//   - 60 -> 120 (a trial): no in-page signal tells whether a frame WOULD fit a 120 Hz vsync while it runs at 60 (measured
//     in headless Chrome on the M3 Pro: a WebGL fence reads as done only ~10 ms after the batch even with no load, and
//     Chrome delivers the off vsync's callback whether or not 120 would hold). So the probe is a short trial at 120, and
//     it is made invisible: only while the flight is quiet (camera at rest per stage.js trackMotion, no wheel / touch / key
//     for 0.6 s), only after the batches' CPU time stayed < 55 % of a vsync for 2 s, and it fails fast (2 misses in its
//     90 frames). Every return to 60 within 20 s of going up doubles the wait before the next trial (3 s .. 96 s);
//     20 s at 120 without a drop forgives one strike. Rest is the heavier frame in the flight (32 DoF taps vs 16 moving),
//     so a pass at rest is a fair test for motion too; a miss mid-scroll still drops within ~3 missed vsyncs.
//   - On screens slower than ~90 Hz there is no halving (60 -> 30 would be worse): the batch runs on every vsync.
// Switches: ?pace=off (native rAF), ?pace=120 | ?pace=60 (forced). Debug load for tests: ?gpuload=N (a heavy fragment
// pass of N loop iterations on a separate offscreen WebGL2 context, once per batch) and ?cpuload=ms (busy-wait per batch).
const q = new URLSearchParams(location.search)
const ARG = q.get('pace')
const GPULOAD = +(q.get('gpuload') || 0)
const CPULOAD = +(q.get('cpuload') || 0)
const REFRESH_MS = [1000 / 240, 1000 / 165, 1000 / 144, 1000 / 120, 1000 / 90, 1000 / 75, 1000 / 60, 1000 / 50, 1000 / 30]

const WIN = 120 // frames in the miss window (120 mode) and the evidence window (60 mode)
const DROP = 3 // misses in WIN that drop 120 -> 60
const TRIAL = 90 // frames a trial lasts (0.75 s at 120)
const TRIAL_DROP = 2 // misses during a trial
const FIT_NEED = 117 // of WIN 60 Hz batches whose CPU time must fit (CPU_FIT) before a trial
const CPU_FIT = 0.55 // batch CPU time as a share of one vsync
const QUIET_MS = 600 // no input for this long (and the camera at rest) before a trial
const BACKOFF_MS = 3000
const FORGIVE_MS = 20000

export const pace = (() => {
  if (ARG === 'off' || typeof window === 'undefined' || !window.requestAnimationFrame) return null
  const nRAF = window.requestAnimationFrame.bind(window)
  const nCAF = window.cancelAnimationFrame.bind(window)
  let cbs = new Map()
  let nextId = 0x40000000 // far above any native id handed out before install
  let pumpId = 0

  const S = {
    div: ARG === '60' ? 2 : 1, forced: ARG === '60' || ARG === '120',
    period: 0, // ms per vsync (0 until measured)
    lastT: 0, lastWorkT: 0, demand: false,
    gap: 1, // vsyncs since the previous batch (read by rec.js: 1 = every vsync, 2 = locked 60, more = a miss)
    cpu: 0, // previous batch's CPU time (ms)
    miss: new Uint8Array(WIN), mi: 0, missN: 0,
    fit: new Uint8Array(WIN), fi: 0, fitN: 0, fitCount: 0,
    trial: 0, strikes: 0, holdUntil: 0, since: 0, // since: when the current mode began (0 = load)
    batches: 0, log: [], // mode switches, newest last
  }
  const ints = new Float32Array(60); let ii = 0, inN = 0, pendP = 0
  const note = (kind, extra) => { S.log.push({ t: Math.round(performance.now()), kind, div: S.div, ...extra }); if (S.log.length > 80) S.log.shift() }

  function measurePeriod(dt) {
    if (dt < 3 || dt > 40) return
    ints[ii] = dt; ii = (ii + 1) % ints.length; inN++
    if (inN < 24 || (inN % (S.period ? 60 : 12) !== 0)) return
    const s = Array.from(ints.subarray(0, Math.min(inN, ints.length))).sort((a, b) => a - b)
    const p20 = s[Math.floor(s.length * 0.2)]
    let snap = REFRESH_MS[0]
    for (const r of REFRESH_MS) if (Math.abs(p20 - r) < Math.abs(p20 - snap)) snap = r
    if (!S.period) { if (p20 < 20) { S.period = snap; note('period', { ms: +snap.toFixed(2), p20: +p20.toFixed(2) }) } return } // load hitches are no refresh rate
    // only ever tightens (as the governor's estimate): a page that cannot keep up gets fewer native callbacks, which must
    // not read as a slower screen. On a slower screen a too-short period only makes every frame look one vsync late:
    // 120 mode drops to 60 mode, which then runs on every real vsync (the right outcome).
    if (snap >= S.period - 0.3) { pendP = 0; return }
    if (pendP && Math.abs(pendP - snap) < 0.3) { S.period = snap; pendP = 0; note('period', { ms: +snap.toFixed(2) }) } else pendP = snap
  }

  function setDiv(d, why) {
    if (S.div === d) return
    S.div = d; S.since = performance.now()
    S.miss.fill(0); S.missN = 0; S.mi = 0; S.fit.fill(0); S.fitN = 0; S.fi = 0; S.fitCount = 0
    note(why)
  }
  function pushMiss(m) { S.missN += m - S.miss[S.mi]; S.miss[S.mi] = m; S.mi = (S.mi + 1) % WIN; if (S.trial > 0) S.trial-- }
  function pushFit(f) { S.fitN += f - S.fit[S.fi]; S.fit[S.fi] = f; S.fi = (S.fi + 1) % WIN; S.fitCount++ }

  // --- quiet: the camera at rest (stage.js reports trackMotion) and no input for QUIET_MS ------------------------------
  let moving = true, lastInput = 0
  const onIn = () => { lastInput = performance.now() }
  for (const ty of ['wheel', 'touchstart', 'touchmove', 'keydown', 'pointerdown']) addEventListener(ty, onIn, { passive: true, capture: true })
  const quiet = (now) => !moving && now - lastInput > QUIET_MS

  // --- debug load (tests only) ------------------------------------------------------------------------------------
  let load = null, loadOn = true
  function makeLoad() {
    const c = document.createElement('canvas'); c.width = c.height = 1024
    const g = c.getContext('webgl2', { antialias: false, alpha: false, preserveDrawingBuffer: false })
    if (!g) return null
    const sh = (type, src) => { const s = g.createShader(type); g.shaderSource(s, src); g.compileShader(s); return s }
    const p = g.createProgram()
    g.attachShader(p, sh(g.VERTEX_SHADER, '#version 300 es\nvoid main(){vec2 v=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));gl_Position=vec4(v*2.-1.,0.,1.);}'))
    g.attachShader(p, sh(g.FRAGMENT_SHADER, `#version 300 es\nprecision highp float;uniform float uS;out vec4 o;void main(){vec2 u=gl_FragCoord.xy*0.001+uS;float a=0.;for(int i=0;i<${Math.max(1, GPULOAD | 0)};i++){a+=sin(u.x*1.3+a)*cos(u.y*0.7-a);u+=a*0.001;}o=vec4(a,u,1.);}`))
    g.linkProgram(p)
    return { g, p, uS: g.getUniformLocation(p, 'uS'), s: 0 }
  }
  function runLoad() {
    if (!loadOn) return
    if (CPULOAD > 0) { const e = performance.now() + CPULOAD; while (performance.now() < e) { /* busy */ } }
    if (!GPULOAD) return
    if (!load) load = makeLoad()
    if (!load) return
    const { g, p } = load
    g.useProgram(p); g.uniform1f(load.uS, (load.s = (load.s + 0.37) % 7)); g.drawArrays(g.TRIANGLES, 0, 3); g.flush()
  }

  // --- the pump: one native rAF per vsync while anyone wants frames -------------------------------------------------
  function pump(T) {
    pumpId = 0
    const P = S.period || 1000 / 120
    if (S.lastT) measurePeriod(T - S.lastT)
    S.lastT = T
    const n = S.lastWorkT ? Math.max(1, Math.round((T - S.lastWorkT) / P)) : S.div
    if (n < S.div) { // the off vsync of 60 mode
      if (cbs.size) pumpId = nRAF(pump)
      return
    }
    // a batch: score the frame that just ended (did it keep its slot?)
    if (S.demand && S.period) {
      const late = n - S.div // vsyncs later than the cadence asked for
      if (late >= 0 && n < S.div + 3) pushMiss(late > 0 ? 1 : 0) // >= 3 extra vsyncs = a stall, not pacing: not counted
      if (S.div === 2) pushFit(S.cpu < CPU_FIT * P ? 1 : 0)
    }
    S.gap = n
    decide()
    S.lastWorkT = T
    const list = cbs; cbs = new Map()
    const t0 = performance.now()
    runLoad()
    for (const cb of list.values()) {
      try { cb(T) } catch (e) { setTimeout(() => { throw e }) } // one consumer's error never starves the others
    }
    S.cpu = performance.now() - t0
    S.batches++
    S.demand = cbs.size > 0
    if (cbs.size && !pumpId) pumpId = nRAF(pump)
  }

  function decide() {
    if (S.forced || !S.period) return
    const now = performance.now()
    if (S.period > 12) { if (S.div !== 1) setDiv(1, 'slow-screen'); return }
    if (S.div === 1) {
      if (S.missN >= DROP || (S.trial > 0 && S.missN >= TRIAL_DROP)) {
        const short = now - S.since < FORGIVE_MS // 120 did not hold for long: a strike (the first drop after load is none)
        if (short && S.since > 0) S.strikes = Math.min(S.strikes + 1, 5)
        S.holdUntil = now + BACKOFF_MS * 2 ** S.strikes
        const kind = S.trial > 0 ? 'trial-failed' : 'drop'
        S.trial = 0
        setDiv(2, kind)
      } else if (S.strikes > 0 && now - S.since > FORGIVE_MS) { S.strikes--; S.since = now; note('forgive') }
    } else if (now >= S.holdUntil && S.fitCount >= WIN && S.fitN >= FIT_NEED && quiet(now)) {
      setDiv(1, 'trial'); S.trial = TRIAL
    }
  }

  window.requestAnimationFrame = function requestAnimationFrame(cb) {
    const id = ++nextId
    cbs.set(id, cb)
    if (!pumpId) pumpId = nRAF(pump)
    return id
  }
  window.cancelAnimationFrame = function cancelAnimationFrame(id) {
    if (!cbs.delete(id)) nCAF(id)
  }
  // a hidden tab gets no native frames: start the next visible stretch fresh (no stale miss / fit history)
  document.addEventListener('visibilitychange', () => { S.lastT = 0; S.lastWorkT = 0; S.demand = false })

  const api = {
    get hz() { return S.period ? Math.round(1000 / S.period / S.div) : 0 },
    get div() { return S.div },
    get gap() { return S.gap },
    get cpu() { return S.cpu },
    get moving() { return moving },
    get period() { return S.period },
    get state() { return { div: S.div, period: S.period, missN: S.missN, fitN: S.fitN, fitCount: S.fitCount, strikes: S.strikes, holdUntil: S.holdUntil, trial: S.trial, batches: S.batches } },
    get log() { return S.log },
    /** stage.js trackMotion (flight): is the camera travelling? Trials at 120 wait for rest. */
    setMoving(m) { moving = !!m },
    /** tests: force a mode (1 = every vsync, 2 = every second), or null to return to automatic */
    force(d) { if (d === 1 || d === 2) { S.forced = true; setDiv(d, 'forced') } else { S.forced = false; note('auto') } },
    /** tests: switch the ?gpuload / ?cpuload debug load on or off at runtime */
    set load(v) { loadOn = !!v },
    nativeRAF: nRAF,
  }
  window.__pace = api
  return api
})()
