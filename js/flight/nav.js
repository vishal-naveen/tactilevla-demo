// ROUND 10 (2026-10-31): the DEFAULT is now the scroll-spring model (see "round 10: SCROLL-SPRING" below): the camera follows a
// smoothed scroll position along one continuous path that loops 13 -> 01. What follows describes round 9's intent model, kept
// behind `?nav=intent` for A/B (and still used for fly-to jumps and reduced-motion cuts).
// Flight navigation, Igloo's model (owner, 2026-10-30: "a LOT smoother. igloo.inc level smooth"). Scroll, trackpad, touch and
// keys only express INTENT (next / previous stop). Each intent starts a TIME-BASED flight to the neighbouring stop: a fixed
// eased duration (smootherstep: zero velocity AND acceleration at both ends), gently scaled with the camera distance and
// clamped, so a hard fling flies exactly as fast as a gentle nudge. Input during a flight queues at most ONE more stop.
// Flights are re-parameterised by camera arc length (position + half the look-at travel), so the camera's speed follows the
// ease curve no matter how unevenly the path's keys are spaced in p; a little p-linear share keeps pure state changes (no
// camera motion) moving too. Between flights a sub-threshold scroll only nudges a tiny dolly (the page still breathes).
// `?nav=scroll` keeps the old scroll-scrubbed model in director.js for A/B measurements (render/flight_smooth.mjs).
import { SCENES, sample, resolveKeys, KEYS, ORBIT_C, LOOP_R, LOOP_H } from './path.js'

// The stops (flight p). `dur` = the flight INTO this stop from its neighbour (either direction) when the content needs time
// (the 160 landing, the scrubbed B2 pick); `lin` = time-linear in p (the count runs evenly; the camera barely moves there).
export const STOPS = [
  // round 13 CAMERA (plan ../tactilevla-redesign/render/PLAN-camera.md): ONE stop per chapter, two where a macro is reached
  // by dollying in (02 servo, 04 dive, 07 lift): 16 fixed shots round one orbit (path.js KEYS, same p's)
  { p: 0.0 }, // 01 establishing (the halo's copy merged in)
  { p: 0.108 }, { p: 0.17 }, // 02 exploded arm, servo inspection
  { p: 0.3 }, // 03 the job + the grid (one job's copy merged in)
  { p: 0.45, dur: 4.2, lin: true, tx: 0.25 }, { p: 0.515 }, // 04 the 160 land (counted), the dive
  { p: 0.615 }, // 05 what it sees (the jaw's copy merged in)
  { p: 0.68 }, // 06 policies
  { p: 0.775 }, { p: 0.905, dur: 2.6 }, // 07 B2: the test, the lift (the pick is scrubbed by p between them; grasp copy merged)
  { p: 1.04 }, { p: 1.19 }, { p: 1.32 }, { p: 1.45 }, { p: 1.61 }, { p: 1.8 }, // 08-13
]
// round 12: text / panel / pin weights as pure functions of where the camera is (nav.mix): a stop's text is whole within
// ~30 % of the segment either side of it and gone 3 % before the segment's crossover, the next one starts 3 % after it, so
// two texts never share the screen and a fast scroll never flashes one (no clock, no "settled" gate). `tx` on a stop =
// the crossover of the segment INTO it (default the middle; the counted landing hands its text over early). Stops that
// show the same text (same = true) keep it whole across the segment. Pins use a tighter window round the stop itself.
const _w = [0, 0]
const sm01 = (x) => { x = Math.min(1, Math.max(0, x)); return x * x * (3 - 2 * x) }
export function mixWeights(m, same = false, pin = false) {
  if (m.a === m.b) { _w[0] = 1; _w[1] = 0; return _w }
  if (same) { _w[0] = _w[1] = 1; return _w }
  const u = m.u
  if (pin) { _w[0] = 1 - sm01((u - 0.07) / 0.11); _w[1] = sm01((u - 0.82) / 0.11); return _w }
  const c = STOPS[m.b]?.tx ?? 0.5
  _w[0] = 1 - sm01((u - (c - 0.2)) / 0.17); _w[1] = sm01((u - (c + 0.03)) / 0.17)
  return _w
}
export const sceneOfStop = (i) => SCENES.findIndex((s) => STOPS[i].p >= s.p0 && STOPS[i].p < s.p1 + 1e-6)
/** The stop a jump to scene si lands on (its first stop). */
export function sceneStop(si) {
  if (si === 0) return 0
  const i = STOPS.findIndex((s) => s.p >= SCENES[si].p0 - 1e-6)
  return i < 0 ? STOPS.length - 1 : i
}

const smoother = (t) => t * t * t * (t * (t * 6 - 15) + 10)
const WHEEL_INTENT = 34 // px of accumulated wheel delta in one gesture (a mouse notch is ~100; trackpad noise stays under it)
const GESTURE_GAP = 220 // ms without wheel events = the gesture ended (trackpad momentum keeps firing, so it is one gesture)
const TOUCH_INTENT = 38 // px of vertical swipe
const PEAK = 0.95 // m/s (measured peaks land <= 1.0): a flight's camera peak never passes this (round 6; the duration stretches, the path is unchanged)

/** Elements whose wheel / touch belongs to themselves (drawers, the sandbox panel, video controls, the reel strip, index). */
const OWNED = '[data-lenis-prevent], .vc, .strip, .fl-index, .fl-explore, .fls-drawer, input, textarea, select'
/** Touch ownership (round 8): vertical swipes navigate from the reel strip (it only scrolls sideways) and from the sandbox panel,
 *  its canvas and the gaps in its picker; only the picker's own buttons, video controls, drawers and the index keep theirs. */
const OWNED_TOUCH = '[data-lenis-prevent]:not(.fls-main--sandbox), .vc, .fl-index, .fl-explore, .fls-drawer, input, textarea, select, .picker button, .fl-sbrow button, #save-frame'

export function createNav({ ctx, isReduced, isLive, onWarp, onIntent }) {
  const N = { p: STOPS[0].p, idx: 0, flight: null, queued: 0, moved: false, nudge: 0, nudgeV: 0, nudgeT: 0, warp: null, tour: null,
    veil: 0, vtint: 'ink', vdolly: 0, arriveT: 9, cam: null, camT: 0, vel: new Float64Array(6) } // round 7: veil level 0..1, its tint, the drift dolly (fraction of distance)
  const tmp = { pos: [0, 0, 0], look: [0, 0, 0], fov: 0, dx: 0, focus: 0, at: [0, 0, 0] }

  // --- round 9 flight engine ---------------------------------------------------------------------------------------
  // A flight is ONE curve: a clamped uniform cubic B-spline (C2) whose control points are the flight's start state, every
  // path key strictly between the two stops (path.js: the designed waypoints) and the destination's live pose. 13 channels
  // ride the same curve: pos, look, fov, dx, focus, focus point, p. It is parameterised by a metric arc length (camera metres
  // + WANG metres per radian of view turn + a little p, so rotation and state changes are paced too), and travelled on a C2
  // ease with a cruise (zero velocity and acceleration at both ends). The duration is the shortest that keeps the measured
  // peaks under VMAX m/s and WMAX deg/s (2.2 s at least). Orientation = lookAt(look) with world up: no roll, ever.
  const VMAX = 0.8, WMAX = 34, DMIN = 2.2, DMAX = 5.6, WANG = 1.4, EAN = 0.33 // EAN: ramp share at each end of the ease
  const NCH = 13
  const rampI = (x) => x * x * x * x * (x * (x - 3) + 2.5) // integral of smootherstep on [0, x]
  function makeEase(v0n, EA = EAN) { // velocity: v0n -> 1 over EA (smootherstep blend), cruise, 1 -> 0 over EA
    const A = EA * (0.5 + 0.5 * v0n) + (1 - 2 * EA) + 0.5 * EA
    return (t) => {
      t = Math.min(1, Math.max(0, t))
      let I
      if (t < EA) { const x = t / EA; I = EA * (v0n * x + (1 - v0n) * rampI(x)) }
      else if (t <= 1 - EA) I = EA * (0.5 + 0.5 * v0n) + (t - EA)
      else I = A - EA * rampI((1 - t) / EA)
      return I / A
    }
  }
  const pack = (o, p, out = new Float64Array(NCH)) => { out.set(o.pos, 0); out.set(o.look, 3); out[6] = o.fov; out[7] = o.dx; out[8] = o.focus; out.set(o.at || o.look, 9); out[12] = p; return out }
  function bspline(cps, u, out) { // clamped uniform cubic B-spline, de Boor; cps: Float64Array[] (>= 4)
    const n = cps.length - 1, segs = n - 2, x = Math.min(segs - 1e-9, Math.max(0, u * segs)), k = Math.floor(x) + 3
    const kn = (i) => Math.min(segs, Math.max(0, i - 3)) // knot i of [0,0,0,0,1,..,segs-1,segs,segs,segs,segs]
    const d = [cps[k - 3], cps[k - 2], cps[k - 1], cps[k]].map((c) => Float64Array.from(c))
    for (let r = 1; r <= 3; r++) for (let j = 3; j >= r; j--) {
      const i = j + k - 3, a = (x - kn(i)) / Math.max(1e-9, kn(i + 4 - r) - kn(i))
      for (let c = 0; c < NCH; c++) d[j][c] = (1 - a) * d[j - 1][c] + a * d[j][c]
    }
    out.set(d[3]); return out
  }
  const _o = { pos: [0, 0, 0], look: [0, 0, 0], fov: 30, dx: 0, focus: 0, at: [0, 0, 0] }
  const dirOf = (v, o = 0) => { const x = v[o + 3] - v[o], y = v[o + 4] - v[o + 1], z = v[o + 5] - v[o + 2], l = Math.hypot(x, y, z) || 1; return [x / l, y / l, z / l] }
  // --- round 9b: FLY-TO, far jumps (index, deep links, hash, Home / End). No veil: the camera eases up and back off the
  // current shot into a high, wide establishing view over the island (the misty world and the whole set), traverses at
  // altitude, descends and pushes into the target's pose. Same engine: one C2 B-spline over every channel, a metric clock,
  // zero velocity + acceleration at both ends, momentum handed over on a retarget. The metric is TIME AT THE CAPS:
  // hypot(metres / vcap, radians / w), vcap 0.75 m/s within 0.6 m of either end rising (C2) to 2.4 m/s from 1.0 m out,
  // w 33 deg/s; so the duration that holds every cap falls out of the curve's length. The scene state switches once, at the
  // highest point (pv: the island's p-driven light eases across it instead).
  const FLY = { vNear: 0.75, vFar: 2.4, dNear: 0.6, dFar: 1.0, w: 33 * Math.PI / 180, ea: 0.18, dmin: 3.2, R: 1.3, H: 1.05, lb: 0.7, ly: 0.1, sp: 0.25, spMin: 0.24 }
  const ISL = [0.2, 0.0, 0.05] // the island's centre (the grid)
  const FLY_FA = 72 * Math.PI / 180
  const lerpCp = (a, b, u) => a.map((x, c) => x + (b[c] - x) * u)
  function flyCps(from, toP, v0) {
    const s = Float64Array.from(from), t = pack(sample(toP, ctx, _o), toP)
    const fromP = s[12]
    const back = (v) => { const x = v[0] - v[3], z = v[2] - v[5], l = Math.hypot(x, z); return l > 1e-3 ? [x / l, z / l] : [0.6, -0.8] }
    const az = (v) => { const x = v[0] - ISL[0], z = v[2] - ISL[2]; return Math.hypot(x, z) > 0.15 ? Math.atan2(z, x) : -0.8 } // overhead shots: the front-left
    const a0 = az(s), a1 = az(t); let d = a1 - a0; if (d > Math.PI) d -= 2 * Math.PI; if (d < -Math.PI) d += 2 * Math.PI
    const am = a0 + d / 2
    const steep = (v) => { // 0 for a level shot .. 1 looking straight down (the overhead stops)
      const x = v[3] - v[0], y = v[4] - v[1], z = v[5] - v[2], pt = Math.atan2(-y, Math.hypot(x, z)) * 180 / Math.PI
      const u = Math.min(1, Math.max(0, (pt - 50) / 35)); return u * u * (3 - 2 * u)
    }
    const high = (a, src, k) => { // an establishing pose at azimuth a, looking over the island (a little toward src)
      a = Math.max(-FLY_FA, Math.min(FLY_FA, a)) // round 14: the traverse stays over the arm's front (+-72 deg about the island = +-66 about the base)
      const o = new Float64Array(NCH), st = steep(src), R = FLY.R * (1 - 0.4 * st) // a top-down end: its side of the traverse is steeper
      o[0] = ISL[0] + R * Math.cos(a); o[1] = FLY.H + 0.1 * st; o[2] = ISL[2] + R * Math.sin(a)
      const lb = (FLY.lb ?? 0) * (1 - st) // look past the island's centre: a shallower view (more of the misty world, less turn)
      for (let c = 0; c < 3; c++) o[3 + c] = ISL[c] + (src[3 + c] - ISL[c]) * k + (c === 1 ? 0 : (ISL[c] - o[c]) * lb)
      o[4] += FLY.ly ?? 0.04; o[6] = 38; o[7] = 0; o[8] = 0; o.set(ISL, 9); o[12] = src[12]
      return o
    }
    const off = (src, b, dist, up) => { // the source shot moved back along its own view and up, still looking at its subject
      const o = Float64Array.from(src)
      o[0] += b[0] * dist; o[1] += up; o[2] += b[1] * dist
      return o
    }
    const D = off(t, back(t), 0.3, 0.24)
    if (v0) { // a retarget mid-flight: the new curve heads straight for one high pose (no lift: it may lie behind the motion,
      // which would fold the curve into a cusp); the old momentum rides the carry (plan) and fades, velocity-continuous
      const E = high(am, t, 0.2); E[12] = toP
      if (s[1] > E[1] - 0.25 || Math.hypot(E[0] - s[0], E[1] - s[1], E[2] - s[2]) < 0.7) return [s, D, D, t].map((v, i) => (i === 1 ? lerpCp(s, D, 0.33) : i === 2 ? lerpCp(s, D, 0.67) : v)) // already up there / near it
      return [s, E, D, t]
    }
    const L = off(s, back(s), 0.24, 0.2)
    // the traverse: two high poses either side of the mean azimuth, never closer than ~0.6 m (coincident ones fold the curve
    // into a near-cusp at the top: up, then straight back down)
    const sp = (d < 0 ? -1 : 1) * Math.max(Math.abs(d) * (FLY.sp ?? 0.25), FLY.spMin ?? 0.24)
    const E1 = high(am - sp, s, 0.2), E2 = high(am + sp, t, 0.2)
    E1[12] = fromP; E2[12] = toP
    return [s, L, E1, E2, D, t]
  }
  function padCps(cps) { // to >= 4 control points: split the longest span (a straight span stays straight)
    while (cps.length < 4) {
      let bi = 0, bl = -1
      for (let i = 0; i < cps.length - 1; i++) { const l = Math.hypot(cps[i + 1][0] - cps[i][0], cps[i + 1][1] - cps[i][1], cps[i + 1][2] - cps[i][2]) + Math.abs(cps[i + 1][12] - cps[i][12]); if (l > bl) { bl = l; bi = i } }
      cps.splice(bi + 1, 0, cps[bi].map((v, c) => (v + cps[bi + 1][c]) / 2))
    }
    return cps
  }
  /** Plan a flight from a state (camera channels + p) to stop toIdx. v0 = { pos, look } current velocities (m/s) or null. */
  function plan(from, toIdx, v0 = null, fly = false) {
    const toP = STOPS[toIdx].p, fromP = from[12], dir = Math.sign(toP - fromP) || 1
    const lin = !fly && ((STOPS[toIdx].lin && toP > fromP) || (STOPS[N.idx]?.lin && toP < fromP))
    const durOverride = fly ? null : toP > fromP ? STOPS[toIdx].dur : (STOPS[N.idx]?.dur ?? null)
    const EA = fly ? FLY.ea : EAN
    const mids = fly ? [] : KEYS.map((k) => k.p).filter((kp) => (kp - fromP) * dir > 1e-6 && (toP - kp) * dir > 1e-6).sort((a, b) => (a - b) * dir)
    const cps = fly ? flyCps(from, toP, v0) : [Float64Array.from(from), ...mids.map((kp) => pack(sample(kp, ctx, _o), kp)), pack(sample(toP, ctx, _o), toP)]
    const P0 = cps[0], P1 = cps[cps.length - 1]
    const vcap = (v) => { // fly-to: the linear cap near the start / target vs at altitude (C2 in the distance)
      const k = (d) => { const x = Math.min(1, Math.max(0, (d - FLY.dNear) / (FLY.dFar - FLY.dNear))); return x * x * x * (x * (x * 6 - 15) + 10) }
      // a product, not min(): min() kinks where the two distances cross (a jerk spike when start and target are close)
      // (a retarget starts in the air, moving: only the target end is slow)
      return FLY.vNear + (FLY.vFar - FLY.vNear) * (v0 ? 1 : k(Math.hypot(v[0] - P0[0], v[1] - P0[1], v[2] - P0[2]))) * k(Math.hypot(v[0] - P1[0], v[1] - P1[1], v[2] - P1[2]))
    }
    padCps(cps)
    // metric arc-length table
    const n = fly ? 960 : 240, us = new Float64Array(n + 1), ms = new Float64Array(n + 1), tmpv = new Float64Array(NCH)
    let prev = null, M = 0, pd = null
    for (let i = 0; i <= n; i++) {
      const u = i / n; us[i] = u
      const v = bspline(cps, u, tmpv), dv = dirOf(v)
      if (prev) {
        const dpos = Math.hypot(v[0] - prev[0], v[1] - prev[1], v[2] - prev[2])
        const dang = Math.acos(Math.min(1, dv[0] * pd[0] + dv[1] * pd[1] + dv[2] * pd[2]))
        M += lin ? Math.abs(v[12] - prev[12]) : fly ? Math.hypot(dpos / vcap(v), dang / FLY.w) : dpos + WANG * dang + 0.4 * Math.abs(v[12] - prev[12])
      }
      ms[i] = M; prev = Float64Array.from(v); pd = dv
    }
    if (M < 1e-6) { M = 1; for (let i = 0; i <= n; i++) ms[i] = i / n }
    const f = { from: fromP, to: toP, toIdx, fromIdx: N.idx, cps, us, ms, M, n, t: 0, dur: 1, ease: null, out: new Float64Array(NCH), carry: null, fly }
    // initial speed along the new curve (a chained / reversed intent keeps its momentum); the rest is carried and decays
    const probe = (ease, dur, tt) => evalAt(f, ease(tt / dur), new Float64Array(NCH))
    let v0n = 0
    const unitPeaks = (ease) => { // peaks over a unit duration (m/s and deg/s per unit time)
      let vp = 0, wp = 0, a = probe(ease, 1, 0); const K = 120
      for (let k = 1; k <= K; k++) { const b = probe(ease, 1, k / K), da = dirOf(a), db = dirOf(b)
        vp = Math.max(vp, Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) * K)
        wp = Math.max(wp, Math.acos(Math.min(1, da[0] * db[0] + da[1] * db[1] + da[2] * db[2])) * 180 / Math.PI * K); a = b }
      return [vp, wp]
    }
    let ease = makeEase(0, EA), [vp, wp] = unitPeaks(ease)
    // fly-to: the metric is already in seconds at the caps, so M / (1 - EA) holds them at the ease's cruise; the measured
    // view-turn peak is checked too (the linear peak varies along the curve, the metric carries it)
    let dur = fly ? Math.max(FLY.dmin, M / (1 - EA), wp / WMAX) : durOverride ?? Math.min(DMAX, Math.max(DMIN, vp / VMAX, wp / WMAX))
    if (v0 && !lin && durOverride == null) {
      // the new curve's first direction and its metres-per-metric ratio there; the momentum along it sets the ease's start
      const c0 = bspline(cps, 0, new Float64Array(NCH)), c1 = bspline(cps, us[1], new Float64Array(NCH))
      const tx = c1[0] - c0[0], ty = c1[1] - c0[1], tz = c1[2] - c0[2], tl = Math.hypot(tx, ty, tz), r0 = tl / Math.max(1e-9, ms[1])
      if (tl > 1e-7 && r0 > 1e-3) {
        const along = (v0.pos[0] * tx + v0.pos[1] * ty + v0.pos[2] * tz) / tl // m/s
        const k = Math.max(0, along) * dur / (M * r0) // = v0n / A
        v0n = Math.min(1.2, k * (1 - EA) / Math.max(0.3, 1 - 0.5 * EA * k))
        ease = makeEase(v0n, EA)
      }
    }
    f.ease = ease; f.dur = dur
    if (fly) { // the scene switches where the camera is highest (the widest view); the island's light blends round it
      let hy = -1e9; f.eSw = 0.5
      for (let i = 0; i <= n; i += 4) { const v = bspline(cps, us[i], tmpv); if (v[1] > hy) { hy = v[1]; f.eSw = ms[i] / M } }
    }
    if (v0) { // residual velocity (what the new curve does not already carry), faded out over CARRY seconds
      const a = probe(ease, dur, 0), b = probe(ease, dur, 1 / 240)
      const nv = [0, 1, 2].map((c) => (b[c] - a[c]) * 240), nl = [3, 4, 5].map((c) => (b[c] - a[c]) * 240)
      f.carry = { pos: v0.pos.map((x, c) => x - nv[c]), look: v0.look.map((x, c) => x - nl[c]) }
    }
    return f
  }
  /** Curve state at eased fraction e (metric share 0..1) -> out (Float64Array NCH). */
  function evalAt(f, e, out) {
    const target = e * f.ms[f.n]
    let lo = 0, hi = f.n
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (f.ms[mid] < target) lo = mid; else hi = mid }
    const span = f.ms[hi] - f.ms[lo], s = span > 1e-12 ? (target - f.ms[lo]) / span : 0
    return bspline(f.cps, f.us[lo] + (f.us[hi] - f.us[lo]) * s, out)
  }
  const CARRY = 0.7, carryG = (t) => (t >= CARRY ? 0 : t * (1 - t / CARRY) ** 3) // g(0)=0, g'(0)=1: velocity-continuous fade
  /** The camera state now (curve + carried momentum), for chaining / reversing mid-flight. */
  function stateNow() { return N.cam ? pack(N.cam, N.p) : pack(sample(N.p, ctx, _o), N.p) }

  // --- round 10: SCROLL-SPRING (owner: "the scroll animations and transitions are not smooth at all"; default model,
  // `?nav=intent` = round 9's stop-to-stop flights for A/B). The camera is a pure function of one scroll coordinate q:
  //  - Path (round 10b): ONE closed C2 cubic spline through every stop, the designed waypoints between them and the loop's
  //    (13 -> 01's F1, path.js loopKeys), paced by ONE global metric (see buildGlobal). q is measured in SECONDS AT THE
  //    CAPS (hypot(m / 0.8, rad / 30 deg, dp / PR) per s), so dq/dt <= 1 means the camera never passes ~0.8 m/s or
  //    ~30 deg/s however hard the flick, and a steady scroll keeps one pace straight through every stop.
  //  - Input -> target -> spring: wheel / trackpad / touch add to a desired q (gain px -> q, at most LEAD ahead of the camera);
  //    the target follows it at <= 1 q/s; the rendered q follows the target through a critically damped spring, stepped
  //    exactly in <= 1/240 s sub-steps (frame-rate independent). Keys / near index jumps set the desired q to a stop.
  //  - Soft snap: 250 ms after the last input (trackpad momentum keeps sending events, so it waits for them) the desired q
  //    goes to the nearest stop, or the next one in the travel direction past 35 % of the segment.
  //  - Loop: q wraps modulo the whole path (forward past 13 runs the loop segment into F1, no jump). Backward past 01
  //    wraps only after one full loop; before that it is a rubber band (a small dolly out, sprung back by the snap).
  const SCRUB = new URLSearchParams(location.search).get('nav') !== 'intent'
  // round 12 (owner: "kinda slow", "if I scroll through too quick it messes everything up"): the target no longer runs at a
  // flat 1 q/s. It is a second-order limiter: velocity toward the desired q, capped by RC(q) (rmax 2.4 q/s = 1.9 m/s and
  // 72 deg/s on open stretches, down to rmin near macro shots so they never whip), acceleration capped at amax, braking on
  // a sqrt profile so it never overshoots; then ONE critically damped spring (T 0.3 s). Measured in the sim (round 12,
  // scratchpad r12n/sim2.mjs): peak jerk 38 q/s^3 at 2.4 q/s (round 10: 70 at 1 q/s), steady lag 0.15 s (0.23), one stop
  // (2.3 q) in ~1.5 s (~2.7). `?nav=r10` keeps round 10's pacing (rate 1, lead 1.4, T 0.45) for A/B.
  // round 13 (owner after round 12: "this is way too fast bro and ts not smooth at all"; his rec.js log replayed by
  // render/replay.mjs): calmer. The pace is now measured in a separate PACING metric (pv m/s, pw deg/s, a 4-norm, so a
  // move that both travels and turns is not counted ~1.4x slower than its larger part, as the hypot did), and the target
  // runs at <= 1 q/s there = <= 1.0 m/s and <= 38 deg/s however hard the flick (round 12: 1.9 m/s, 72 deg/s), easing in
  // and out at 1.5 q/s^2 (round 12: 8: full speed in 0.16 s read as a surge), LEAD 1.2 q (a release coasts <= ~1 s), the
  // snap waits 0.4 s of quiet (0.25 s snapped between the bursts of one trackpad gesture). The SPLINE keeps round 10's
  // chord (vmax / wmax): the path's shape, stops and clearances are unchanged; only its pacing table changed.
  // The loop is 29.5 q long in the new metric (round 12: 44.5 q), so px -> q and the touch lead are scaled by 2/3: a
  // trackpad pixel or a swipe moves the camera about as far along the path as in round 12 (flight_touch: one swipe = one
  // stop). `?nav=r12` = round 12's pacing, `?nav=r10` = round 10's, for A/B.
  const NAVQ = new URLSearchParams(location.search).get('nav')
  const R10 = NAVQ === 'r10', R12 = NAVQ === 'r12'
  const SC = R10 ? { T: 0.45, gain: 0.012, gainTouch: 0.02, lead: 1.4, leadTouch: 0.9, idle: 0.25, past: 0.35, vmax: 0.8, wmax: 30 * Math.PI / 180, rmax: 1, rmin: 1, amax: 0, K: 0, dRef: 1 }
    : R12 ? { T: 0.3, gain: 0.012, gainTouch: 0.02, lead: 2.4, leadTouch: 0.9, idle: 0.25, past: 0.35, vmax: 0.8, wmax: 30 * Math.PI / 180, rmax: 2.4, rmin: 1.1, amax: 8, K: 7, dRef: 0.55, dwell: 0.45 }
    : { T: 0.35, gain: 0.008, gainTouch: 0.0133, lead: 1.2, leadTouch: 0.6, idle: 0.4, past: 0.35, vmax: 0.8, wmax: 30 * Math.PI / 180, rmax: 1, rmin: 0.75, amax: 1.5, abrake: 2.5, K: 3, dRef: 0.55, dwell: 0.45, rfloor: 0.7,
      pv: 0.5, pw: 13 * Math.PI / 180, pn: 4, pc: 0.4, aw: 25 * Math.PI / 180, al: 0.35, at: 0.5 } // round 13b ORBIT: the orbit turns <= 13 deg/s (0.26 m/s at its base radius), dollies <= 0.5 m/s, accel caps
  const OM = 3.89 / SC.T // critically damped: 90 % of a step in T
  const NS = STOPS.length
  const Z = { G: null, Q: null, Qtot: 1, vp: '', active: false, q: 0, v: 0, tq: 0, tv: 0, dq: 0, lastIn: -1e9, dir: 1, snapped: true, touching: false,
    looped: false, moving: false, cur: -1, toIdx: 0, pv: null, content: false, seg: 0, x: 0, out: null, RC: null, rcStep: 0.02 }
  const vpNow = () => innerWidth + 'x' + innerHeight
  // round 10b (integrator: "continuous scrolling eases almost to rest at 18 of 20 stops ... Igloo flows straight through"):
  // ONE closed C2 cubic spline through every stop and the designed waypoints between them (round 9's control points, now
  // interpolated knots) and the loop's, on all 13 channels (pos, look, fov, dx, focus, focus point, p). Chord-length
  // parameter in the same metric as the pacing. Waypoints closer than KMIN to a kept neighbour are dropped (the old
  // hold-pair keys straddling a stop would put a hairpin there). p is unwrapped round the loop (F1 after it = PU_LOOP) and
  // splined as a periodic residual about its linear trend. Then ONE global metric over the whole loop: seconds at the caps,
  // hypot(m / 0.8, view turn / 30 deg, w(p) dp / PR); PR = 0.036 p per s (w = 1 on the content stretches only) makes the counted landing ~4.2 s and the B2 pick ~2.6 /
  // 1.7 s without any per-segment pacing, so a steady scroll moves the camera at a continuous pace everywhere, stops included.
  const PU_LOOP = 1.9, PR = 0.036
  // the full p term only where p itself is the content (the counted landing, the B2 pick), eased in and out over 0.02 p,
  // a quarter of it elsewhere (keeps near-static stretches from collapsing to zero length):
  // a global p term made stretches with a long p span but a short camera move (sandbox -> close) needlessly slow
  const CONTENT = [[0.3, 0.45], [0.775, 0.905]]
  // round 13: the content weight ramps INSIDE the content stretch (each is one whole segment now: 03 -> 04, 07 -> lift), over
  // 40 % of it from each end with a C2 ease, so the camera slows into the counted landing / the pick gradually (the old 0.02 p ramp outside the
  // stretch braked from ~0.9 m/s to a crawl in 0.36 q: the largest view-acceleration spikes of the loop)
  const contentW = (p) => { let w = 0; for (const [a, b] of CONTENT) { const x = Math.min(1, Math.max(0, Math.min(p - a, b - p) / (0.4 * (b - a)))); w = Math.max(w, smoother(x)) } return w }
  const chord = (A, B) => {
    const da = dirOf(A), db = dirOf(B), ang = Math.acos(Math.min(1, da[0] * db[0] + da[1] * db[1] + da[2] * db[2]))
    return Math.hypot(Math.hypot(B[0] - A[0], B[1] - A[1], B[2] - A[2]) / SC.vmax, ang / SC.wmax, Math.max(0.25, contentW((A[12] + B[12]) / 2)) * (B[12] - A[12]) / PR)
  }
  // round 13: the pacing metric (the q table, so the pace) apart from the spline's chord (the path's shape): per sample,
  // the 4-norm of (m / pv, view turn / pw, w(p) dp / PR); round 10-12 = chord (hypot at vmax / wmax)
  const paceD = !SC.pv ? chord : (A, B) => {
    const da = dirOf(A), db = dirOf(B), ang = Math.acos(Math.min(1, da[0] * db[0] + da[1] * db[1] + da[2] * db[2]))
    const a = Math.hypot(B[0] - A[0], B[1] - A[1], B[2] - A[2]) / SC.pv, b = ang / SC.pw, c = Math.abs(Math.max(0.25, contentW((A[12] + B[12]) / 2)) * (B[12] - A[12]) / PR) * SC.pc // pc: the content stretches (the counted landing, the B2 pick) at 1 / 0.65 of round 10's p pace
    return Math.pow(a ** SC.pn + b ** SC.pn + c ** SC.pn, 1 / SC.pn)
  }
  // round 13b ORBIT (integrator: "make it a LITERAL orbit about ONE fixed centre"; plan
  // ../tactilevla-redesign/render/PLAN-camera.md): the camera is C + (r cos th, h, r sin th) about the island centre
  // (path.js ORBIT_C). The loop parameter t (0..1) IS the azimuth: th = th0 - 360 t, so th advances at one constant rate in
  // t, exactly one turn per lap. Each stop sits at its azimuth's t; between two stops radius, height, look pivot, lens,
  // focus and p blend with smootherstep over the WHOLE segment (zero rate at both stops: a dolly in / out or a pivot shift
  // spreads over its neighbouring segments, never a quick dip; consecutive stops with equal r / h keep them constant).
  // Every stop is a FIXED camera (path.js resolveKeys, once per viewport): the arm moving never moves the camera.
  const ORB_C = ORBIT_C
  // ROUND 14 FRONT (owner: "why r we showing the back of the arm??"): no full turn. The stops' th RISE from 01 to 13 across
  // the arm's front (path.js); t is a sweep parameter: on the open stretches th is LINEAR in t (one rate, deg per t), at 01
  // and 13 it eases from / to rest (quintic Hermite, zero rate and acceleration there: their segments get twice the t of
  // their th change, so the ease averages half the rate), and the loop 13 -> 01 is one crane segment eased in TIME:
  // th back across the front on a ramp-cruise-ramp (LOOP_EA), r and h raised by LOOP_R / LOOP_H on a plateau, so the
  // camera rises over the front of the table and descends onto F1 without ever passing behind the arm.
  const LOOP_EA = 0.28, loopEase = makeEase(0, LOOP_EA)
  const plateau = (u) => smoother(Math.min(1, Math.min(u, 1 - u) / 0.42)) // 0 at both ends (C2), 1 over the middle
  const TN = 16000 // the q table's rows over the loop
  function buildGlobal() {
    const K = resolveKeys(ctx)
    const S = STOPS.map((s) => K.find((x) => Math.abs(x.p - s.p) < 1e-6))
    const m = S.length, T = 1
    const th = S.map((k) => k.orb.th)
    const rest = S.map((k, j) => j === 0 || j === m - 1 || k.rest), line = S.map((k, j) => j + 1 < m && S[j + 1].line) // line[j]: segment j is straight
    for (let j = 1; j < m; j++) if (!(th[j] > th[j - 1]) && !line[j - 1] && !line[j - 2]) console.warn('nav: the sweep is not monotone at stop', j, th[j - 1], th[j])
    // raw t: open segments dt = dth (slope 1 deg per raw t), the first and last forward segments 2 dth (ease from / to rest),
    // the loop as long as the sweep (resolution only: its pace comes from D)
    const raw = new Float64Array(m)
    for (let j = 0; j < m - 1; j++) { const d = Math.max(0.25, th[j + 1] - th[j]); raw[j] = line[j] ? 4 : rest[j] !== rest[j + 1] ? 2 * d : d }
    raw[m - 1] = th[m - 1] - th[0]
    const tot = raw.reduce((a, b) => a + b, 0)
    const t = new Float64Array(m + 1)
    let acc = 0; for (let j = 0; j < m; j++) { acc += raw[j] / tot; t[j + 1] = Math.round(acc * TN) / TN } // on the table's rows (TN): th runs on each segment's time share, a stop between rows left a flat step there
    t[m] = 1
    const sl = th.map((_, j) => (rest[j] ? 0 : 1)) // deg per raw t at each stop (0 = the sweep rests there)
    const P = S.map((k) => k.pos)
    // per stop: [r, h, look x y z, fov, dx, focus, at x y z, p]; the closing copy = stop 0 one lap on
    const V = S.map((k) => [k.orb.r, k.orb.h, ...k.look, k.fov[0], k.dx[0], k.focus[0], ...k.at, k.p])
    V.push(V[0].slice()); V[m][11] += PU_LOOP
    const G = { m, t, T, V, th, raw, sl, tot, line, P }
    Z.G = G
    // the global metric table over the whole loop (no seams: one pacing)
    const N = TN, us = new Float64Array(N + 1), ms = new Float64Array(N + 1), v = new Float64Array(NCH)
    // round 13b PACING: per segment, a duration D (q = seconds at full scroll) = the longest of: the orbit's turn at W
    // (pw deg/s), the dolly + crane at a peak of VD m/s (smootherstep peaks at 1.875x its mean), the view's own turn at 1.3 W
    // (a pivot shift on top of the orbit), and the content's minimum (the counted landing, the B2 pick). Inside a segment th,
    // the blends and the pace are all functions of t, so a dolly is eased in TIME (an arc-length pace undid that: 180 deg/s^2
    // and 2.5 m/s^2 spikes at the close-ups). The pace g (t per q) is constant on a segment; at a stop it takes the faster
    // neighbour's value and the slower segment eases to its own over its first / last half (smootherstep in log pace: C1 rate, zero
    // rate-change at both ends), so the open orbit keeps one constant pace and only the close-ups slow down.
    const VD = 0.4, WV = 1.3 * SC.pw, CMIN = { 3: 3.0, 8: 2.6 } // content minima: segment 3 = 03 -> 04 (landing), 8 = 07 -> lift
    const D = new Float64Array(m), g = new Float64Array(m), pa = new Float64Array(NCH), pb = new Float64Array(NCH)
    for (let j = 0; j < m; j++) {
      const A = V[j], B = V[j + 1], dth = j === m - 1 || line[j] ? 0 : Math.abs(th[j + 1] - th[j]) * (rest[j] && rest[j + 1] ? 1.875 : rest[j] || rest[j + 1] ? 2 : 1) * Math.PI / 180 // the sweep at one rate (an ease from / to rest: 2x)
      let turn = 0; poseAtT(t[j], pa)
      for (let k = 1; k <= 64; k++) { poseAtT(t[j] + (t[j + 1] - t[j]) * k / 64, pb); const da = dirOf(pa), db = dirOf(pb); turn += Math.acos(Math.min(1, da[0] * db[0] + da[1] * db[1] + da[2] * db[2])); pa.set(pb) }
      let len = 0
      if (j === m - 1) { poseAtT(t[j], pa); for (let k = 1; k <= 64; k++) { poseAtT(t[j] + (t[j + 1] - t[j]) * k / 64, pb); len += Math.hypot(pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]); pa.set(pb) } }
      // the loop crane: its length at the cruise of a ramp-cruise-ramp ease (peak = mean / (1 - EA))
      // round 14: + acceleration floors (a smootherstep of size X over D peaks at 5.77 X / D^2): short segments with a pivot
      // shift or a crane (05 -> 06) otherwise reached 1.9 m/s^2 and 100 deg/s^2
      const lk = Math.hypot(B[2] - A[2], B[3] - A[3], B[4] - A[4])
      D[j] = Math.max(dth / SC.pw, 1.875 * Math.hypot(B[0] - A[0], B[1] - A[1]) / VD, turn / WV, len / (1 - LOOP_EA) / 0.48, CMIN[j] ?? 0, 0.4,
        Math.sqrt(5.77 * Math.hypot(B[0] - A[0], B[1] - A[1], lk) / 0.45), Math.sqrt(5.77 * turn / (32 * Math.PI / 180)))
      g[j] = (t[j + 1] - t[j]) / D[j]
    }
    // round 14: one pace per segment (no log blend between them): the sweep's RATE is continuous on its own (setW: each
    // stop's rate in deg per q is shared by both its segments and the th curve is a quintic Hermite in each segment's time)
    const gAt = (f) => { let j = 0; while (j < m - 1 && t[j + 1] <= f) j++; return g[j] }
    let M = 0
    const build = () => { M = 0; for (let i = 0; i <= N; i++) { us[i] = T * i / N; if (i) M += (T / N) / gAt((i - 0.5) / N); ms[i] = M }; setW() }
    // the sweep's rate at each stop (deg per q): 0 where it rests; else the most both neighbouring segments allow without
    // bulging (an open segment D long holds |dth| / D at each end, twice that against a rest end)
    const setW = () => {
      const Dq = new Float64Array(m), w = new Float64Array(m)
      for (let j = 0; j < m; j++) Dq[j] = ms[G.si[j + 1]] - ms[G.si[j]]
      const cap = (j, end) => { const other = end ? j : j + 1; return (rest[other] ? 2 : 1) * Math.abs(th[j + 1] - th[j]) / Math.max(1e-6, Dq[j]) }
      for (let j = 0; j < m; j++) w[j] = rest[j] ? 0 : Math.min(cap(j - 1, 1), cap(j, 0))
      G.Dq = Dq; G.w = w
    }
    G.N = N; G.si = Array.from(t, (x) => Math.round(x * N)) // the stops' table rows
    // the ramps make a slow segment shorter than its D, and the pans near a close-up subject turn the view faster than the
    // estimate: measure each segment's peaks on the built table and lengthen it until they hold (VMAX m/s, WMAX deg/s)
    const VMAX = 0.5, WMAX = 24 * Math.PI / 180, xa = new Float64Array(NCH), xb = new Float64Array(NCH)
    for (let it = 0; it < 4; it++) {
      build(); G.qs = ms
      let changed = false
      for (let j = 0; j < m; j++) {
        let vp = 0, wp = 0; const i0 = G.si[j], i1 = G.si[j + 1], st = Math.max(1, Math.floor((i1 - i0) / 160))
        poseAtT(i0 / N, xa)
        for (let i = i0 + st; i <= i1; i += st) {
          poseAtT(i / N, xb); const dqq = ms[i] - ms[i - st]
          if (dqq > 1e-9) { const da = dirOf(xa), db = dirOf(xb); vp = Math.max(vp, Math.hypot(xb[0] - xa[0], xb[1] - xa[1], xb[2] - xa[2]) / dqq); wp = Math.max(wp, Math.acos(Math.min(1, da[0] * db[0] + da[1] * db[1] + da[2] * db[2])) / dqq) }
          xa.set(xb)
        }
        const k = Math.max(vp / VMAX, wp / WMAX)
        if (k > 1.02) { g[j] /= Math.min(2.5, k * 1.03); changed = true }
      }
      if (!changed) break
    }
    build(); G.qs = ms
    G.D = D
    G.us = us; G.ms = ms; G.N = N
    const qAt = (tt) => { let lo = 0, hi = N; while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (us[mid] < tt) lo = mid; else hi = mid } const s = (tt - us[lo]) / Math.max(1e-12, us[hi] - us[lo]); return ms[lo] + (ms[hi] - ms[lo]) * s }
    Z.Q = []; G.tStop = []; for (let j = 0; j < m; j++) { Z.Q[j] = qAt(t[j]); G.tStop[j] = t[j] }
    Z.Qtot = M; Z.Q[NS] = M; Z.vp = vpNow(); Z.cur = -1
    buildRC()
  }
  // round 12: the target's rate cap along the loop. rmax where the camera is far from what it looks at, easing down to rmin
  // for macro shots (camera within ~dRef of its look point, scaled), then made reachable at amax both ways (rc^2 changes by at
  // most 2 amax per q), so the limiter can always brake into a slow stretch without overshooting the cap.
  function buildRC() {
    const n = Math.ceil(Z.Qtot / Z.rcStep), rc = new Float64Array(n + 1), v = new Float64Array(NCH), G = Z.G
    let k = 0
    for (let i = 0; i <= n; i++) {
      const qq = Math.min(Z.Qtot, i * Z.rcStep)
      while (k < G.N - 1 && G.ms[k + 1] < qq) k++
      const s = (qq - G.ms[k]) / Math.max(1e-12, G.ms[k + 1] - G.ms[k])
      poseAtT(G.us[k] + (G.us[k + 1] - G.us[k]) * s, v)
      const d = Math.hypot(v[3] - v[0], v[4] - v[1], v[5] - v[2]), x = Math.min(1, Math.max(0, (d - 0.12) / (SC.dRef - 0.12)))
      rc[i] = SC.rmin + (SC.rmax - SC.rmin) * x * x * (3 - 2 * x)
    }
    // a stop's text is whole for ~30 % of the segment either side of it (mixWeights): where the segments are short (01,
    // the halo, the loop, 09-10) the camera slows enough to keep that window >= DWELL s, or the text would only flash past
    if (SC.amax > 0) for (let i = 0; i < NS; i++) {
      const Lp = segL((i - 1 + NS) % NS), Ln = segL(i), cap = Math.max(SC.rfloor ?? 0.8, 0.3 * (Lp + Ln) / SC.dwell)
      const a = Math.floor((Z.Q[i] - 0.3 * Lp) / Z.rcStep), b = Math.ceil((Z.Q[i] + 0.3 * Ln) / Z.rcStep)
      for (let k = a; k <= b; k++) { const j = ((k % (n + 1)) + (n + 1)) % (n + 1); rc[j] = Math.min(rc[j], cap) }
    }
    if (SC.amax > 0) for (let pass = 0; pass < 2; pass++) { // cyclic: twice round each way
      for (let i = 1; i <= 2 * n; i++) { const a = i % (n + 1), b = (i - 1) % (n + 1); rc[a] = Math.min(rc[a], Math.sqrt(rc[b] * rc[b] + 2 * SC.amax * Z.rcStep)) }
      for (let i = 2 * n; i >= 1; i--) { const a = (i - 1) % (n + 1), b = i % (n + 1); rc[a] = Math.min(rc[a], Math.sqrt(rc[b] * rc[b] + 2 * SC.amax * Z.rcStep)) }
    }
    Z.RC = rc
  }
  function rcAt(q) {
    const rc = Z.RC; if (!rc) return SC.rmax
    const x = ((((q % Z.Qtot) + Z.Qtot) % Z.Qtot) / Z.rcStep), i = Math.min(rc.length - 2, Math.floor(x)), f = x - i
    return rc[i] + (rc[i + 1] - rc[i]) * f
  }
  function poseAtT(tt, out) { // the orbit at loop parameter tt (wrapped; laps add PU_LOOP to p) -> out (pose channels)
    const G = Z.G, m = G.m, t = G.t, V = G.V
    const lap = Math.floor(tt); let f = tt - lap
    let j = 0; while (j < m - 1 && t[j + 1] <= f) j++
    let u = Math.min(1, Math.max(0, (f - t[j]) / (t[j + 1] - t[j])))
    if (G.qs) { // once the pace exists, the blends run on the segment's TIME (its share of q), not its share of t: a dolly
      // eased in t was squeezed in time where the pace changes (the fast end): 1.6-2.4 m/s^2 at the close-ups' starts
      const N = G.N, x = f * N, i = Math.min(N - 1, Math.floor(x)), qf = G.qs[i] + (G.qs[i + 1] - G.qs[i]) * (x - i)
      u = Math.min(1, Math.max(0, (qf - G.qs[G.si[j]]) / (G.qs[G.si[j + 1]] - G.qs[G.si[j]])))
    }
    const e = smoother(u), A = V[j], B = V[j + 1]
    const bl = (i) => A[i] + (B[i] - A[i]) * e
    let thv, r = bl(0), hh = bl(1)
    if (j === m - 1) { // the loop crane (in time): back across the front, up and out on a plateau, down onto F1
      thv = G.th[m - 1] + (G.th[0] - G.th[m - 1]) * loopEase(u)
      const c = plateau(u); r += LOOP_R * c; hh += LOOP_H * c
    } else if (G.line[j]) { // round 14: a straight dolly (10 -> 11, the touch macro), both ends at rest
      const P0 = G.P[j], P1 = G.P[j + 1]
      for (let c = 0; c < 3; c++) out[c] = P0[c] + (P1[c] - P0[c]) * e
      for (let i = 0; i < 9; i++) out[3 + i] = bl(2 + i)
      out[12] = bl(11) + PU_LOOP * lap
      return out
    } else { // the sweep: a quintic Hermite per segment (zero acceleration at the stops; linear where both rates match):
      // in the segment's TIME with each stop's rate (G.w, deg per q) once the pace exists, in raw t before (pace estimate)
      const tq = !!(G.qs && G.w), w = tq ? u : Math.min(1, Math.max(0, (f - t[j]) / (t[j + 1] - t[j]))), w3 = w * w * w, w4 = w3 * w, w5 = w4 * w
      const m0 = tq ? G.w[j] * G.Dq[j] : G.sl[j] * G.raw[j], m1 = tq ? G.w[j + 1] * G.Dq[j] : G.sl[j + 1] * G.raw[j]
      thv = G.th[j] * (1 - 10 * w3 + 15 * w4 - 6 * w5) + G.th[j + 1] * (10 * w3 - 15 * w4 + 6 * w5)
        + m0 * (w - 6 * w3 + 8 * w4 - 3 * w5) + m1 * (-4 * w3 + 7 * w4 - 3 * w5)
    }
    const thr = thv * Math.PI / 180
    out[0] = ORB_C[0] + r * Math.cos(thr); out[1] = hh; out[2] = ORB_C[2] + r * Math.sin(thr)
    for (let i = 0; i < 9; i++) out[3 + i] = bl(2 + i)
    out[12] = bl(11) + PU_LOOP * lap
    return out
  }
  // (round 13: no per-frame knot refresh, no pitch cap / heading spline: every knot is fixed and no shot passes ~47 deg)
  function camAt(q, out) { // the camera state at scroll coordinate q -> out (NCH)
    let qq, over = 0
    if (!Z.looped && q < 0) { over = -q; qq = 0 } else qq = ((q % Z.Qtot) + Z.Qtot) % Z.Qtot
    const G = Z.G
    let lo = 0, hi = G.N; while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (G.ms[mid] < qq) lo = mid; else hi = mid }
    const s = (qq - G.ms[lo]) / Math.max(1e-12, G.ms[hi] - G.ms[lo])
    let tt = G.us[lo] + (G.us[hi] - G.us[lo]) * s
    for (let i = 0; i < NS; i++) if (Math.abs(qq - Z.Q[i]) < 1e-7) tt = G.tStop[i] // at rest on a stop: exactly its knot
    poseAtT(tt, out)
    const pu = out[12] - PU_LOOP * Math.floor(out[12] / PU_LOOP + 1e-9) // this lap's p
    const last = STOPS[NS - 1].p, mid = (last + PU_LOOP) / 2
    if (pu > last) { // the loop: the close's state holds to its middle, then 01's; the island's light eases across it
      out[12] = pu < mid ? last : 0
      Z.pv = pu < mid ? last : 0.3 * (1 - smoother((pu - mid) / (PU_LOOP - mid)))
    } else { out[12] = Math.max(0, pu); Z.pv = null }
    if (over > 0) { // rubber band at the very start (first visit): the path's own tangent at F1, saturating (C1 at q = 0:
      // F1 is no longer a rest point of the path, so a dolly would kink the velocity there), never a wrap
      const R = 0.25, f = R * (Math.exp(-over / R) - 1), v1 = new Float64Array(NCH)
      poseAtT(G.ms[1] > 0 ? G.us[1] : 1e-4, v1)
      const k = 1 / Math.max(1e-9, G.ms[1])
      for (let c = 0; c < 12; c++) out[c] += (v1[c] - out[c]) * k * f
    }
    let i = 0; while (i < NS - 1 && qq >= Z.Q[i + 1]) i++
    const b = (i + 1) % NS
    Z.content = !!(b > 0 && (STOPS[b].dur != null || STOPS[b].lin))
    Z.seg = i
    return out
  }
  const segL = (i) => Z.Q[i + 1] - Z.Q[i]
  const MIX = { a: 0, b: 0, u: 0 }
  const stopQ = (j) => Z.Q[j] // stop j sits at the start of segment j
  const nearQ = (j, ref) => { const base = stopQ(j); if (!Z.looped) return base; return base + Math.round((ref - base) / Z.Qtot) * Z.Qtot }
  function activate() {
    if (!Z.G || Z.vp !== vpNow()) buildGlobal()
    if (Z.active) return
    Z.active = true; Z.q = Z.tq = Z.dq = stopQ(N.idx); Z.v = 0; Z.tv = 0; Z.snapped = true
  }
  // ROUND 14 (owner: "if I scroll once at 13 it just goes to 2 instead of reseting to 1"): one gesture = one stop. A
  // trackpad swipe is 30-200 px in his log (0.25-1.6 q), longer than the short segments (13 -> 01 was 1.03 q, 01 -> 02 0.97),
  // and the target ran up to LEAD past the next stop, so the snap (35 % past the segment, or the stop the target could not
  // brake for) chose the stop after it. Now each gesture remembers where it began (the stop the target was resting on /
  // gliding to: Z.dq when the previous gesture had snapped) and its desired q is BOUNDED at the next stop from there; the
  // bound lets go only once the gesture's input runs GESTURE_FREE q past that stop (a long, continuous scroll travels on). A
  // deliberate gesture (>= GESTURE_MIN q) always lands at least on that next stop, however long the segment (the loop's crane).
  const GESTURE_MIN = 0.2, GESTURE_FREE = 1.0 // q (25 px / 125 px of trackpad at gain 0.008)
  const GESTURE = !new URLSearchParams(location.search).get('off')?.split(',').includes('gesture') // `?off=gesture` = round 13b input (A/B)
  /** The next stop from q0 in direction d (unwrapped q); null before the first loop going back past 01. */
  function nextStop(q0, d) {
    const qq = ((q0 % Z.Qtot) + Z.Qtot) % Z.Qtot, lap = q0 - qq
    let j = 0; while (j < NS - 1 && qq >= Z.Q[j + 1] - 1e-4) j++
    const at = Math.abs(qq - Z.Q[j]) < 1e-4
    const n = d > 0 ? lap + Z.Q[j + 1] : lap + (at ? Z.Q[j] - segL((j - 1 + NS) % NS) : Z.Q[j])
    return !Z.looped && n < -1e-6 ? null : n
  }
  function scrubIn(dIn, dir, lead = SC.lead) { // wheel / touch: add to the desired q (rubber at the start until one loop is done)
    if (N.flight) return // a fly-to is under way: it lands first
    activate(); N.moved = true; stopTour()
    if (Z.snapped || !Z.gest) Z.gest = { q0: Z.dq, sum: 0, free: false } // a new gesture (the last one had snapped)
    const G = Z.gest; G.sum += dIn
    let d = dIn
    if (!Z.looped && Z.dq + d < 0 && d < 0) d *= 0.35 * Math.exp(Math.min(0, Z.dq) / 0.25)
    // the target runs at most LEAD ahead of the camera (round 10b: no per-stop bound any more: it made a steady scroll
    // slow to half pace at every stop; one gesture still moves about one stop because LEAD is shorter than most stretches)
    Z.dq = Math.max(Z.looped ? -Infinity : -0.6, Math.min(Z.q + lead, Math.max(Z.q - lead, Z.dq + d)))
    const gd = Math.sign(G.sum)
    if (gd && !G.free && GESTURE) { // round 14: bounded at the next stop from the gesture's start until it is clearly a long scroll
      const nb = nextStop(G.q0, gd)
      if (nb == null) G.free = true
      else if ((G.q0 + G.sum - nb) * gd > GESTURE_FREE) G.free = true
      else Z.dq = gd > 0 ? Math.min(Z.dq, nb) : Math.max(Z.dq, nb)
    }
    Z.lastIn = performance.now(); Z.dir = dir; Z.snapped = false
  }
  function snapTarget() { // nearest stop, or the next one in the travel direction once past 35 % of the segment
    // round 14: a deliberate gesture still bounded (not yet a long scroll) lands exactly on the next stop from its start
    const G = Z.gest
    if (GESTURE && G && !G.free && Math.abs(G.sum) >= GESTURE_MIN && Math.sign(G.sum) === Z.dir) { const nb = nextStop(G.q0, Z.dir); if (nb != null) return nb }
    let q = Z.dq
    // round 12: never a stop the target cannot brake for (it would overshoot and come back): judge from the point it
    // would stop at under amax if it is further along than the desired q, and never land short of it
    let qs = null
    if (SC.amax > 0 && Z.tv * Z.dir > 0) { qs = Z.tq + Math.sign(Z.tv) * Z.tv * Z.tv / (2 * (SC.abrake ?? SC.amax)); q = Z.dir > 0 ? Math.max(q, qs) : Math.min(q, qs) }
    if (!Z.looped && q < 0) return 0
    const qq = ((q % Z.Qtot) + Z.Qtot) % Z.Qtot, lap = q - qq
    let i = 0; while (i < NS - 1 && qq >= Z.Q[i + 1]) i++
    const x = (qq - Z.Q[i]) / segL(i)
    const fwd = Z.dir > 0 ? x > SC.past : x > 1 - SC.past
    let t = lap + (fwd ? Z.Q[i + 1] : Z.Q[i])
    if (qs != null && Z.dir > 0 && t < qs - 1e-6) t = lap + Z.Q[i + 1]
    if (qs != null && Z.dir < 0 && t > qs + 1e-6) t = lap + Z.Q[i]
    return t
  }
  function scrubStep(dir) { // keys / tour: glide to the next stop in that direction from where the target is going
    activate(); N.moved = true
    const ref = Z.snapped ? Z.dq : Z.q
    const qq = ((ref % Z.Qtot) + Z.Qtot) % Z.Qtot, lap = ref - qq
    let j = 0; while (j < NS - 1 && qq >= Z.Q[j + 1] - 1e-6) j++
    const atStop = Math.abs(qq - Z.Q[j]) < 1e-3
    let t = dir > 0 ? lap + Z.Q[j + 1] : lap + (atStop ? Z.Q[j] - segL((j - 1 + NS) % NS) : Z.Q[j])
    if (!Z.looped && t < 0) t = 0
    Z.dq = t; Z.dir = dir; Z.snapped = true; Z.lastIn = performance.now()
  }
  function scrubGo(i) { activate(); N.moved = true; Z.dq = nearQ(i, Z.q); Z.dir = Math.sign(Z.dq - Z.q) || 1; Z.snapped = true; Z.lastIn = performance.now() }
  function scrubUpdate(dt) {
    if (!Z.active) return
    if (Z.vp !== vpNow()) { const xq = Z.q; buildGlobal(); Z.q = Z.tq = Z.dq = xq; Z.v = 0; Z.tv = 0 } // a resize refits the shots
    if (!Z.snapped && !Z.touching && performance.now() - Z.lastIn > SC.idle * 1000) { Z.dq = snapTarget(); Z.snapped = true }
    // sub-steps: the target follows the desired q at <= 1 q/s; the camera's q follows the target (exact critically damped step)
    let rest = Math.min(dt, 0.1)
    while (rest > 1e-7) {
      const h = Math.min(rest, 1 / 240); rest -= h
      if (SC.amax > 0) { // round 12: accel-limited target, rate cap RC(q), sqrt braking (no overshoot), linear in the last bit
        const g = Z.dq - Z.tq, ag = Math.abs(g)
        // round 14: the target lands within 2e-4 q (0.1 mm; was 1e-5): its last approach is exponential (tau 1 / K = 0.33 s),
        // so "at rest" (hash, index, held stop) came ~1 s after the camera had visibly stopped
        if (ag < 2e-4 && Math.abs(Z.tv) < 2e-3) { Z.tq = Z.dq; Z.tv = 0 } else {
          // round 13: speeding up at amax, slowing down at abrake (> amax): a gesture eases in, and the camera can still
          // settle on the stop it is passing instead of carrying on to the next (the spring rounds both corners)
          const AB = SC.abrake ?? SC.amax
          const need = Math.sign(g) * Math.min(rcAt(Z.tq), Math.sqrt(2 * AB * ag), SC.K * ag)
          const lim = need * Z.tv < 0 || Math.abs(need) < Math.abs(Z.tv) ? AB : SC.amax
          Z.tv += Math.max(-lim * h, Math.min(lim * h, need - Z.tv)); Z.tq += Z.tv * h
        }
      } else Z.tq += Math.max(-h, Math.min(h, Z.dq - Z.tq))
      const x = Z.q - Z.tq, e = Math.exp(-OM * h), qq = (Z.v + OM * x) * h
      Z.q = Z.tq + (x + qq) * e; Z.v = (Z.v - OM * qq) * e
    }
    if (Z.snapped && Z.tq === Z.dq && Math.abs(Z.q - Z.dq) < 2e-4 && Math.abs(Z.v) < 2e-3) { Z.q = Z.dq; Z.v = 0 }
    if (Z.q >= Z.Qtot) Z.looped = true
    Z.moving = Z.q !== Z.dq || Z.v !== 0 || Z.tq !== Z.dq || Z.tv !== 0
    const v = camAt(Z.q, Z.out || (Z.out = new Float64Array(NCH)))
    const cam = N.cam || (N.cam = { pos: [0, 0, 0], look: [0, 0, 0], fov: 30, dx: 0, focus: 0, at: [0, 0, 0] })
    for (let c = 0; c < 3; c++) {
      if (N.camT > 0 && dt > 0) { N.vel[c] = (v[c] - cam.pos[c]) / dt; N.vel[3 + c] = (v[3 + c] - cam.look[c]) / dt }
      cam.pos[c] = v[c]; cam.look[c] = v[3 + c]; cam.at[c] = v[9 + c]
    }
    cam.fov = v[6]; cam.dx = v[7]; cam.focus = v[8]; N.camT = 1
    N.p = v[12]
    // where the target is going (the HUD / panels read it); the held stop changes only at rest, like round 9's landings
    const qd = ((Z.dq % Z.Qtot) + Z.Qtot) % Z.Qtot
    let j = 0; while (j < NS - 1 && qd >= Z.Q[j + 1] - 1e-6) j++
    if (j + 1 < NS && qd - Z.Q[j] > Z.Q[j + 1] - qd) j++
    else if (j === NS - 1 && qd - Z.Q[j] > Z.Qtot - qd) j = 0
    Z.toIdx = Z.snapped ? j : (Z.dir > 0 ? (Z.seg + 1) % NS : Z.seg)
    if (!Z.moving) { N.idx = j; N.vel.fill(0) }
  }

  // round 7 veil timing (s): rise to a full wall by CUT (the shot keeps drifting in), hold, recede by VEIL_S on the new shot
  const CUT = 0.6, HOLD = 0.66, VEIL_S = 1.45, ARRIVE_S = 2.4
  const NOVEIL = new URLSearchParams(location.search).get('off')?.split(',').includes('veil') // A/B: every segment a fly-through
  const veilOf = (a, b) => { const hi = Math.max(a, b); return !NOVEIL && Math.abs(a - b) === 1 ? STOPS[hi].veil : null }
  function start(toIdx, fly = false) {
    toIdx = Math.max(0, Math.min(STOPS.length - 1, toIdx))
    if (toIdx === N.idx && !N.flight) return
    N.moved = true
    if (isReduced()) { N.flight = null; N.queued = 0; N.p = STOPS[toIdx].p; N.idx = toIdx; onWarp?.(); return } // calm cuts
    const v = !N.flight && !fly && veilOf(N.idx, toIdx)
    if (v) { N.flight = { veil: v, from: N.p, to: STOPS[toIdx].p, toIdx, fromIdx: N.idx, dur: VEIL_S, t: 0, cut: false, abort: false, a: 0 }; N.vtint = v; return }
    // round 9: a flight already under way hands over its momentum (chain or reversal: no restart from rest, no snap)
    const moving = (N.flight && !N.flight.veil) || (SCRUB && Z.active && Z.moving) // round 10: a scroll glide hands over too
    if (fly) onWarp?.() // a far jump skips the opening (the stage is revealed; the sandbox orbit waits on that)
    N.flight = plan(stateNow(), toIdx, moving ? { pos: N.vel.slice(0, 3), look: N.vel.slice(3, 6) } : null, fly)
    N.flight.chained = !!moving
  }

  /** dir +1 / -1. During a flight: queue at most one more stop in the flight's direction (a reversal turns back at once). */
  function step(dir) {
    if (SCRUB && !isReduced()) { if (!N.flight) { stopTourIfUser(); scrubStep(dir) } return }
    if (N.warp) return
    if (N.flight?.veil) { // a veil: reversing before the cut lets the wall sink back on the same shot; after it, queue
      const fd = Math.sign(N.flight.to - N.flight.from)
      if (dir !== fd && !N.flight.cut) { N.flight.abort = true; N.queued = 0; return }
      if (!N.queued) N.queued = dir
      return
    }
    if (N.flight?.fly) { // round 9b: an intent during a fly-to retargets it to the target's neighbour (once)
      const f = N.flight
      if (f.chained) return
      const to = Math.max(0, Math.min(STOPS.length - 1, f.toIdx + dir))
      if (to !== f.toIdx) start(to, true)
      return
    }
    if (N.flight) { // round 9: re-plan at once from the current state and velocity (at most one stop beyond the target)
      const f = N.flight, fd = Math.sign(f.to - f.from)
      if (dir !== fd) { const back = f.toIdx - fd; N.idx = f.toIdx; start(back); return } // turn back to the stop behind
      if (f.chained) return // one queued stop at most
      N.idx = f.toIdx; start(f.toIdx + dir); return
    }
    start(N.idx + dir)
  }

  /** Jump to a stop: neighbours fly through their keys; anything further than one scene away (or `warp`: deep links)
   *  FLIES-TO over the island (round 9b: no veil anywhere). A jump during a flight retargets it from its velocity. */
  function goStop(i, { warp } = {}) {
    i = Math.max(0, Math.min(STOPS.length - 1, i))
    const cur = N.flight ? N.flight.fromIdx : N.idx
    const far = Math.abs(sceneOfStop(i) - sceneOfStop(cur)) > 1 || (N.flight?.fly && i !== N.flight.toIdx)
    N.queued = 0
    if (i === N.idx && !N.flight && !(SCRUB && Z.moving)) return
    if (N.flight?.fly && i === N.flight.toIdx) return
    const fly = !!((warp && i !== N.idx) || far)
    if (SCRUB && !isReduced() && !fly && !N.flight) { scrubGo(i); return }
    start(i, fly)
  }

  function update(dtIn) {
    // round 13: a STALL (a frame > 50 ms: the owner's log has a 226 ms one at the film -> results crossing, no script in
    // it) advances the motion by one 60 Hz frame, not by the stall: the camera pauses with the picture instead of
    // jumping 10 cm when it comes back. Steady 30-60 Hz frames are not stalls and keep real time.
    const dt = dtIn > 0.05 ? 1 / 60 : dtIn
    // (round 9b: the round 7 warp, an ink veil with a cut, is gone: far jumps fly-to, see goStop)
    N.arriveT += dt
    const f = N.flight
    if (f?.veil) {
      f.t += dt
      const sm = (x) => smoother(Math.min(1, Math.max(0, x)))
      if (f.abort) { f.a = Math.max(0, f.a - dt / 0.45); if (f.a <= 0) { N.flight = null; N.veil = 0; N.vdolly = 0 } else { N.veil = f.a; N.vdolly *= Math.exp(-dt * 4) } }
      else {
        // eased so the wall is only whole for a breath: the old shot stays readable while it rises, the new one shows early as it sinks
        f.a = f.t < CUT ? sm(f.t / CUT) ** 1.7 : f.t < HOLD ? 1 : (1 - sm((f.t - HOLD) / (VEIL_S - HOLD))) ** 1.7
        N.veil = f.a
        if (!f.cut && f.t >= CUT) { f.cut = true; N.p = f.to; N.idx = f.toIdx; N.arriveT = 0 }
        if (!f.cut) N.vdolly = 0.035 * sm(f.t / CUT) // the old shot keeps drifting in while the wall rises
        if (f.t >= VEIL_S) { N.flight = null; N.veil = 0; if (N.queued) { const d = N.queued; N.queued = 0; start(N.idx + d) } }
      }
    } else if (!f && SCRUB) scrubUpdate(dt)
    else if (f) {
      f.t += dt
      pack(sample(f.to, ctx, _o), f.to, f.cps[f.cps.length - 1]) // the destination is live (subjects that breathe or lift)
      const v = evalAt(f, f.ease(f.t / f.dur), f.out)
      if (f.carry) { const g = carryG(f.t); for (let c = 0; c < 3; c++) { v[c] += f.carry.pos[c] * g; v[3 + c] += f.carry.look[c] * g } }
      const cam = N.cam || (N.cam = { pos: [0, 0, 0], look: [0, 0, 0], fov: 30, dx: 0, focus: 0, at: [0, 0, 0] })
      for (let c = 0; c < 3; c++) {
        if (N.camT > 0) { N.vel[c] = (v[c] - cam.pos[c]) / dt; N.vel[3 + c] = (v[3 + c] - cam.look[c]) / dt }
        cam.pos[c] = v[c]; cam.look[c] = v[3 + c]; cam.at[c] = v[9 + c]
      }
      cam.fov = v[6]; cam.dx = v[7]; cam.focus = v[8]; N.camT = 1
      if (f.fly) { // one switch at the top; pv = the p the island's light follows (eased across the high part)
        const e = f.ms[f.n] > 0 ? Math.min(1, f.t / f.dur) : 1, ee = f.ease(e)
        N.p = ee < f.eSw ? f.from : f.to
        const x = Math.min(1, Math.max(0, (ee - f.eSw) / 0.36 + 0.5))
        f.pv = f.from + (f.to - f.from) * smoother(x)
      } else N.p = v[12]
      if (f.t >= f.dur) {
        N.p = f.to; N.idx = f.toIdx; N.flight = null; N.cam = null; N.camT = 0; N.vel.fill(0)
        if (SCRUB) { activate(); Z.q = Z.tq = Z.dq = nearQ(f.toIdx, Z.q); Z.v = 0; Z.tv = 0; Z.snapped = true; Z.cur = -1 }
      }
    }
    // the new shot arrives already drifting: it starts 5 % further out and eases in (C1 at both ends)
    if (N.arriveT < ARRIVE_S) N.vdolly = -0.05 * (1 - smoother(N.arriveT / ARRIVE_S))
    else if (!N.flight?.veil) N.vdolly = 0
    // the breathing dolly: a critically damped spring toward the sub-threshold scroll offset, which itself relaxes to 0
    N.nudgeT *= Math.exp(-dt * 2.2)
    const om = 7, x = N.nudge - N.nudgeT, ee = Math.exp(-om * dt), qq = (N.nudgeV + om * x) * dt
    N.nudge = N.nudgeT + (x + qq) * ee; N.nudgeV = (N.nudgeV - om * qq) * ee
    if (N.tour) {
      N.tour.t += dt
      if (!N.flight && !N.warp && !(SCRUB && Z.moving) && N.tour.t > N.tour.next) {
        if (N.idx >= STOPS.length - 1) stopTour(); else { N.tour.next = N.tour.t + 6.5; touring = true; step(1); touring = false }
      }
    }
  }

  // --- input ----------------------------------------------------------------------------------------------------------
  const scrolls = (el) => !!el && el.scrollHeight > el.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(el).overflowY) // a panel that scrolls (phone sheets) owns its swipes
  const owned = (t) => t instanceof Element && (!!t.closest(OWNED) || scrolls(t.closest('.fls-main, .fls-card')))
  const ownedTouch = (t) => t instanceof Element && (!!t.closest(OWNED_TOUCH) || (!t.closest('.fls-main--sandbox') && scrolls(t.closest('.fls-main, .fls-card'))))
  let acc = 0, lastT = 0, lastMag = 0, fired = false, wLast = -1e9
  function onWheel(e) {
    if (!isLive() || e.ctrlKey || owned(e.target)) return
    let dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? innerHeight : 1)
    const dx = e.deltaX * (e.deltaMode === 1 ? 16 : 1)
    if (Math.abs(dx) > Math.abs(dy) * 1.2) return
    if (SCRUB && !isReduced()) { // round 10: trackpad pixels scrub the spring; a lone mouse-wheel notch glides one stop
      const now = e.timeStamp || performance.now(), lone = Math.abs(dy) >= 60 && now - wLast > 160
      wLast = now
      if (lone && !N.flight) { stopTour(); scrubStep(Math.sign(dy)) } else if (dy) scrubIn(dy * SC.gain, Math.sign(dy))
      return
    }
    const now = e.timeStamp || performance.now(), mag = Math.abs(dy)
    // a new gesture: a pause, or a fresh push while momentum was decaying (momentum only ever shrinks)
    if (now - lastT > GESTURE_GAP || (fired && mag > 24 && mag > lastMag * 1.8 && Math.sign(dy) === Math.sign(acc || dy))) { acc = 0; fired = false }
    lastT = now; lastMag = mag
    stopTour()
    if (fired) return // the rest of this gesture (momentum tail) is spent
    acc += dy
    N.nudgeT = Math.max(-1, Math.min(1, N.nudgeT + dy / 160))
    if (Math.abs(acc) >= WHEEL_INTENT) { fired = true; const d = Math.sign(acc); acc = 0; onIntent?.(d); step(d) }
  }
  let ty = null, tx = 0, tFired = false, tOrbit = false, tEng = false, tLast = 0, tVel = 0, tT = 0
  function onTouchStart(e) {
    if (!isLive() || e.touches.length !== 1 || ownedTouch(e.target)) { ty = null; return }
    // the sandbox canvas orbits under a finger: only a long, clearly vertical swipe there is an intent (below it, the drag orbits)
    tOrbit = e.target === ctx.canvas && !!ctx.interactive?.()
    ty = e.touches[0].clientY; tx = e.touches[0].clientX; tFired = false; tEng = false; tVel = 0
    tLast = ty; tT = e.timeStamp || performance.now()
  }
  function onTouchMove(e) {
    if (ty === null || tFired) return
    const dy = ty - e.touches[0].clientY, dx = tx - e.touches[0].clientX
    const need = tOrbit ? TOUCH_INTENT * 2.6 : TOUCH_INTENT, dom = tOrbit ? 2.2 : 1.2
    if (SCRUB && !isReduced()) { // round 10: the finger drives the same spring (engaged once the drag is clearly vertical)
      const y = e.touches[0].clientY, now = e.timeStamp || performance.now()
      if (!tEng) {
        const need2 = tOrbit ? need : 10
        if (Math.abs(dy) > need2 && Math.abs(dy) > Math.abs(dx) * dom) { tEng = true; Z.touching = true; tLast = y; tT = now }
        return
      }
      const d = tLast - y, ddt = Math.max(1, now - tT)
      tVel = 0.6 * tVel + 0.4 * (d / ddt) // px/ms, smoothed
      tLast = y; tT = now
      if (d) scrubIn(d * SC.gainTouch, Math.sign(d), SC.leadTouch)
      return
    }
    if (Math.abs(dy) > need && Math.abs(dy) > Math.abs(dx) * dom) { tFired = true; stopTour(); const d = Math.sign(dy); onIntent?.(d); step(d) }
  }
  function onTouchEnd() { // round 10: a flick carries on a little (the lead cap still bounds it), then the snap
    if (!tEng) return
    tEng = false; Z.touching = false
    if (Math.abs(tVel) > 0.15) scrubIn(tVel * 180 * SC.gainTouch, Math.sign(tVel), SC.leadTouch)
    Z.lastIn = performance.now()
  }
  function onKey(e) {
    if (!isLive() || e.defaultPrevented || e.altKey || e.metaKey || e.ctrlKey) return
    const t = e.target
    const field = t instanceof Element && (t.closest('input, textarea, select, [role="slider"], [contenteditable]'))
    if (field) return
    const control = t instanceof Element && t.closest('button, a, summary')
    let d = 0
    switch (e.key) {
      case 'ArrowDown': case 'ArrowRight': d = 1; break
      case 'ArrowUp': case 'ArrowLeft': d = -1; break
      case 'PageDown': goScene(sceneOfStop(N.idx) + 1); e.preventDefault(); stopTour(); return
      case 'PageUp': goScene(sceneOfStop(N.idx) - 1); e.preventDefault(); stopTour(); return
      case 'Home': goStop(0); e.preventDefault(); stopTour(); return
      case 'End': goStop(STOPS.length - 1); e.preventDefault(); stopTour(); return
      case ' ': if (control) return; d = e.shiftKey ? -1 : 1; break
      default: return
    }
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && t instanceof Element && t.closest('.seg, .picker, .strip')) return
    e.preventDefault(); stopTour(); step(d)
  }
  let touring = false
  function stopTourIfUser() { if (!touring) stopTour() }
  function goScene(si) { si = Math.max(0, Math.min(SCENES.length - 1, si)); goStop(sceneStop(si)) }
  function startTour() { N.tour = { t: 0, next: 0.2 }; document.dispatchEvent(new CustomEvent('flight:tour', { detail: { on: true } })) }
  function stopTour() { if (!N.tour) return; N.tour = null; document.dispatchEvent(new CustomEvent('flight:tour', { detail: { on: false } })) }

  function attach() {
    addEventListener('wheel', onWheel, { passive: true })
    addEventListener('touchstart', onTouchStart, { passive: true })
    addEventListener('touchmove', onTouchMove, { passive: true })
    addEventListener('touchend', onTouchEnd, { passive: true }); addEventListener('touchcancel', onTouchEnd, { passive: true })
    addEventListener('keydown', onKey)
  }

  return {
    N, STOPS, attach, update, step, goStop, goScene, startTour, stopTour,
    get p() { return N.p }, get flying() { return !!N.flight || !!N.warp || (SCRUB && Z.moving) }, get moved() { return N.moved },
    /** round 10: the scroll model's state for the director / HUD / tests */
    /** round 13: build the orbit's spline + pacing table now (~85 ms on the M3 at 1512x828; at load, not at the first wheel) */
    prebuild() { if (SCRUB && (!Z.G || Z.vp !== vpNow())) buildGlobal() },
    get scrub() { return SCRUB }, Z, camAt: (q) => (Z.G ? camAt(q, new Float64Array(NCH)) : null), // tests: the path at q
    /** where a move is going (stop p) while moving; null at rest */
    get toP() { const f = N.flight; if (f && !f.veil) return f.to; return SCRUB && Z.moving ? STOPS[Z.toIdx].p : null },
    get content() { const f = N.flight; if (f) return !f.veil && !f.fly && !!(f.to > f.from ? STOPS[f.toIdx]?.dur : STOPS[N.idx]?.dur); return SCRUB && Z.moving && Z.content },
    /** the p the island's p-driven light follows (eased across a fly-to's switch and the loop's) */
    get pv() { const f = N.flight; if (f?.fly) return f.pv ?? N.p; return SCRUB && Z.active && Z.pv != null ? Z.pv : N.p },
    /** 0..1 progress round the loop (the bar fades out into the wrap and back in after it) */
    get progress() { return SCRUB && Z.active ? (((Z.q % Z.Qtot) + Z.Qtot) % Z.Qtot) / Z.Qtot : null },
    get scene() { return sceneOfStop(N.idx) },
    /** round 12: where the RENDERED camera is between two stops: { a, b, u } = stop a, the next stop b, 0..1 along the
     *  segment (u 0 at rest on a). Text, panels and pins are pure functions of it (never of "the camera settled"). */
    get mix() {
      const m = MIX, f = N.flight
      if (f && !f.veil) { m.a = f.fromIdx; m.b = f.toIdx; m.u = Math.min(1, Math.max(0, f.dur > 0 ? f.ease(Math.min(1, f.t / f.dur)) : 1)); return m }
      if (SCRUB && Z.active && Z.G) {
        if (!Z.looped && Z.q < 0) { m.a = 0; m.b = 1; m.u = 0; return m }
        const qq = ((Z.q % Z.Qtot) + Z.Qtot) % Z.Qtot
        let i = 0; while (i < NS - 1 && qq >= Z.Q[i + 1]) i++
        m.a = i; m.b = (i + 1) % NS; m.u = Math.min(1, Math.max(0, (qq - Z.Q[i]) / segL(i))); return m
      }
      m.a = m.b = N.idx; m.u = 0; return m
    },
    /** round 12: the scroll rate cap at the camera (q/s) and the pace numbers for tests */
    get pace() { return { rc: rcAt(Z.q), tv: Z.tv, v: Z.v, Qtot: Z.Qtot, rmax: SC.rmax } },
    /** ?capture / tests: put the flight at p (the nearest stop becomes current). */
    setP(p) {
      N.p = p; N.flight = null; N.warp = null; N.cam = null; N.camT = 0; N.vel.fill(0); Z.active = false
      let best = 0
      STOPS.forEach((s, i) => { if (Math.abs(s.p - p) < Math.abs(STOPS[best].p - p)) best = i })
      N.idx = best
    },
  }
}
