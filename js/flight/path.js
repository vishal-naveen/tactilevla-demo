// Flight M1 path: hand-written keys (M2 replaces them with Blender-authored ones on the matched Cycles camera).
// World metres, arm base at the origin, +x forward, +z = the A side; B2 = (0.2225, 0, 0), cup = (0.2, 0, 0.245).
// Round 13: keys are FIXED rig shots (no functions of live subjects). sample() (capture stills, reduced-motion cuts, fly-to
// targets) is a monotone cubic per component in p; the scroll flight itself is nav.js's periodic rig spline.
const B2 = [0.2225, 0, 0]
const M1F1 = new URLSearchParams(location.search).get('off')?.split(',').includes('intro2') // INTRO: S0/F1 A/B switch

// ROUND 13 CAMERA (2026-11-01; owner: "too much random camera movements ... it has to make sense"; plan
// ../tactilevla-redesign/render/PLAN-camera.md). The flight is ONE orbit round the island. Every key is a FIXED shot of a
// camera rig: look pivot `look`, azimuth `th` (deg, atan2(z, x) of the camera about its pivot, UNWRAPPED: it only ever
// increases along the flight, +360 over the loop), elevation `ph` (deg), distance `r` (m). nav.js splines these rig
// channels (so the view direction is a function of th / ph alone: the look pivot moving only trucks the camera) and the
// camera never follows a live subject: the arm animating can not move it. Keys that read ctx.shot() (the stage's fitted
// sandbox / close shots) are fixed per viewport. One key per chapter, three chapters two (servo, dive, B2 lift: macros
// reached by dollying in on the same azimuth).
// (SUPERSEDED by ROUND 14 FRONT below) ROUND 13b ORBIT (integrator: "make it a LITERAL orbit about ONE fixed centre"): every stop is a camera on one orbit about
// the island centre ORBIT_C: azimuth `th` (deg, atan2(z, x) about ORBIT_C, unwrapped, FALLING one full turn over the loop),
// radius `r` and height `h` (camera y), looking at the chapter's pivot `look`. nav.js advances th at a constant rate and
// blends r / h / look / lens between stops with smootherstep over whole segments. Radius and height stay at the orbit's
// base (F1's: r 1.165, h 0.32) except the close-ups (dolly in and out over the neighbouring segments) and one rise for the
// overhead grid. Order round the table (th): 01 -49, 02 -62 / servo -74 (C side), 03 -88, 04 -104 (rise) / dive -116,
// 05 -142 and 06 -170 (behind the arm, over its shoulder), 07 -205 / lift -245 (A side behind, close: the ring stands at
// -224, r 1.03, so the orbit is pulled in there), the long sweep round the A side, 08 -330 (the screens line up only
// from the front), 09 -344, 10 -357, 11 -370, 12 -383, 13 -396 (front), -> 01 -409.
// ROUND 14 FRONT (owner on 13b: "why r we showing the back of the arm?? thats so shi"): NO full orbit any more. The arm's
// front, measured from the URDF in the page (render/out/r14_path.png): base_link X = world +x, the gripper at home points
// along +x, the shoulder_pan axis stands at (0.0388, 0) (FRONT_O); front angle = atan2(z, x - 0.0388) of the camera. Every
// stop and every in-between frame stays within FRONT_MAX of it. The flight SWEEPS the front arc once, from the C side to
// the A side, `th` (deg about ORBIT_C) RISING: 01 -49 (F1, fixed: the opening lands on it, the ring behind the arm),
// 02 -42 / servo, 03 -31, 04 -23 (rise) / dive, 05 -8, 06 0, 07 +7 / lift, 08 +20 (the screens line up from the front),
// 09 cup, 10 +36, 11 touch macro on the jaw servo (straight dolly-in from 10), 12 sandbox, 13 +70. 01 and 13 are rest
// points of the sweep (its rate eases from / to 0); the loop 13 -> 01 is a crane: up and out over the front of the table
// (r + LOOP_R, h + LOOP_H at the top), back across the front, down onto F1 (nav.js). Close-ups are keys with a fixed
// `pos` (their orbit params are derived) placed so the sweep stays monotone.
export const ORBIT_C = [0.15, 0, 0.05]
export const FRONT_O = [0.0388, 0] // shoulder_pan axis (x, z), measured: shoulder_link world pos at every pose
export const FRONT_MAX = 75 // deg off +x
export const LOOP_R = 0.32, LOOP_H = 0.62 // the loop crane's extra radius / height at its top (m)
const RAD = Math.PI / 180
const orbPos = (th, r, h) => [ORBIT_C[0] + r * Math.cos(th * RAD), h, ORBIT_C[2] + r * Math.sin(th * RAD)]
/** A camera position's orbit params about ORBIT_C (th unwrapped near `hint`). */
export function orbOf(pos, hint = 0) {
  const x = pos[0] - ORBIT_C[0], z = pos[2] - ORBIT_C[2]
  let th = Math.atan2(z, x) / RAD; th += 360 * Math.round((hint - th) / 360)
  return { th, r: Math.hypot(x, z), h: pos[1] }
}
/** A position at distance d from point c, at bearing b (deg, atan2(z, x)) and elevation e (deg). */
const around = (c, b, e, d) => [c[0] + d * Math.cos(e * RAD) * Math.cos(b * RAD), c[1] + d * Math.sin(e * RAD), c[2] + d * Math.cos(e * RAD) * Math.sin(b * RAD)]
// the inspection: the elbow servo (exploded arm, explode 0.5) lifts SERVO_LIFT toward the inspection camera's bearing
// SERVO_TH; the camera sits on that line, a little below the lifted part (round 14: from the front-left, was the C side)
const SV_BASE = [-0.0575, 0.2518, 0.0277]
export const SERVO_TH = -20 // deg, bearing from the servo to the inspection camera
export const SERVO_LIFT = 0.08 // m, horizontal (+ 1.2 cm up)
const SERVO_LIFTED = [SV_BASE[0] + SERVO_LIFT * Math.cos(SERVO_TH * RAD), SV_BASE[1] + 0.012, SV_BASE[2] + SERVO_LIFT * Math.sin(SERVO_TH * RAD)]
const SV_CAM = around(SERVO_LIFTED, SERVO_TH, -9, 0.42)
// 11 touch: the gripper's jaw servo, where load sensing would happen (measured: its mesh centre in the touch pose, which
// is static; the arm holds the noodle). Camera fixed on it: a macro reached by a straight dolly-in from 10's camera.
export const JAW = [0.177, 0.194, -0.001]
// a stage-fitted shot's camera (sandbox: it must BE the stage's shot, the orbit adopts its th / r / h)
const shotOrb = (id, th) => (c) => { const s = c.shot(id), O = orbOf(s.pos, th); return { look: s.look, th: O.th, r: O.r, h: O.h, fov: s.fov ?? 30, dx: s.dx ?? 0 } }
const R0 = 1.165, H0 = 0.323 // the sweep's base = F1's camera about ORBIT_C
// the base stops' look pivots sit within ~9 cm of their neighbours: a pivot shift is a pan on top of the sweep's turn
// 10 -> 11: one straight line from the limits shot down onto the jaw servo (bearing TB from it, TE above level): `line` =
// the segment INTO the key is a straight line in space; `rest` = the sweep eases to / from rest at the key, so the line
// meets the sweep at zero speed. (About ORBIT_C the line's azimuth dips 9 deg on the way in: a push-in, not a turn back.)
const TB = 40, TE = 15
const C10 = around(JAW, TB, TE, 1.2), C11 = around(JAW, TB, TE, 0.36)

export const KEYS = [
  // 01 F1 establishing (intro.js cranes down onto this pose; intro2 2026-10-30: 9 deg above the table). ?off=intro2 = M1 pose.
  M1F1 ? { p: 0.000, pos: [0.955, 0.521, -1.047], look: [0.02, 0.1, 0.14], th: -49, fov: 30, dx: 0, focus: 4, at: [0.1, 0.08, 0.12] }
    : { p: 0.000, pos: [0.909, 0.323, -0.834], look: [0.05, 0.12, 0.12], th: -49, fov: 30, dx: 0, focus: 3, at: [0.08, 0.14, 0.06] },
  // 02 the exploded arm from the front-left; then in onto the lifted elbow servo, a little below it
  { p: 0.108, th: -42, r: R0, h: H0, look: [0.03, 0.2, 0.05], fov: 28, dx: 0.1, focus: 3, at: [0.0, 0.24, 0.0] },
  { p: 0.170, pos: SV_CAM, th: -36, look: [SERVO_LIFTED[0], SERVO_LIFTED[1] + 0.004, SERVO_LIFTED[2]], fov: 16, dx: 0.06, focus: 10, at: SERVO_LIFTED },
  // 03 the job and the grid from the front-left: the cells in front, the arm behind them, the cup at the right
  { p: 0.300, th: -31, r: R0, h: 0.45, look: [0.16, 0.08, 0.05], fov: 26, dx: 0.08, focus: 3, at: [0.2225, 0, 0] },
  // 04 the counted landing: the one rise of the sweep, over the grid; then the dive: down and in, low across the lanes
  { p: 0.450, th: -23, r: R0, h: 0.65, look: [0.18, 0.04, 0.05], fov: 28, dx: 0.1, focus: 3, at: [0.2225, 0, 0] },
  { p: 0.515, th: -16, r: 0.62, h: 0.09, look: [0.2225, 0.0, 0.0], fov: 20, dx: 0.14, focus: 14, at: B2 },
  // 05 what it sees, from the front: the wrist camera reaching for A2, the overhead camera's cone over the grid
  { p: 0.615, th: -8, r: R0, h: 0.36, look: [0.15, 0.15, 0.05], fov: 26, dx: 0.08, focus: 2, at: [0.2, 0.1, 0.05] },
  // 06 two policies: the chunk trail, the arm facing the camera
  { p: 0.680, th: 0, r: R0, h: H0, look: [0.12, 0.15, 0.04], fov: 26, dx: 0.06, focus: 5, at: [0.2, 0.1, 0.0] },
  // 07 the test: the gripper comes down onto B2 toward the camera (the pick is scrubbed on the way in), then in onto the lift
  { p: 0.775, th: 7, r: 0.86, h: 0.36, look: [0.18, 0.11, 0.0], fov: 28, dx: 0.1, focus: 9, at: [0.2225, 0.01, 0] },
  { p: 0.905, th: 13, r: 0.7, h: 0.3, look: [0.18, 0.16, 0.06], fov: 30, dx: 0.1, focus: 13, at: [0.2147, 0.1731, 0.1021] },
  // --- FULL SITE scenes 08-13 (p past 1, PMAX)
  // 08 real runs: the four screens in front of the grid (props_runs.js turns them to the camera), the arm behind them;
  // round 14 (ARM agent's request): ~25 deg down and pulled back, so the lit cells and the arm's reach read above the screens
  { p: 1.040, th: 16, r: 1.35, h: 0.68, look: [0.25, 0.1, 0.02], fov: 26, dx: 0.1, focus: 4, at: [0.405, 0.07, 0.0] },
  // 09 results: in onto the cup (the success criterion), the whole arm soft behind it
  { p: 1.190, th: 28, r: 0.9, h: 0.16, look: [0.13, 0.13, 0.13], fov: 28, dx: 0.08, focus: 7, at: [0.2, 0.04, 0.245] },
  // 10 limits: the whole arm standing at home (director.js; it was folded at rest), room round it for the pins
  { p: 1.320, pos: C10, th: 37, rest: true, look: [0.1, 0.15, 0.04], fov: 26, dx: 0.12, focus: 4, at: [0.05, 0.14, 0.0] },
  // 11 touch: a macro on the jaw servo holding the noodle (the pin's bench number beside it), shallow focus
  { p: 1.450, pos: C11, th: 30, rest: true, line: true, look: [JAW[0] - 0.005, JAW[1] + 0.004, JAW[2] + 0.01], fov: 20, dx: 0.06, focus: 16, at: JAW },
  // 12 sandbox: the stage's own fitted sandbox shot, aimed from this slot (SANDBOX_DIR): its lens and lens shift must be the
  // rig's or the hand-over to the stage's orbit pops, and the fit keeps the grid framed on phones
  { p: 1.610, rig: shotOrb('sandbox', 55), focus: 0 },
  // 13 what I built: the whole arm from the A side, pulled back (the ring comes in on the loop's crane, behind the arm at F1)
  { p: 1.800, th: 70, r: R0, h: H0, look: [0.1, 0.15, 0.06], fov: 30, dx: 0.14, focus: 3, at: [0.06, 0.17, 0] },
]
/** The sandbox shot's direction for this sweep (director.js overrides SHOTS.sandbox.dir with it): round 14 azimuth +50 (the A
 *  side, between touch and the close), 30 deg up (round 13b: -23). */
export const SANDBOX_DIR = (() => { const t = 50 * RAD, f = 30 * RAD; return [Math.cos(f) * Math.cos(t), Math.sin(f), Math.cos(f) * Math.sin(t)] })()

/** Round 13: no designed loop waypoints any more (the orbit's own spline carries 13 -> 01). Kept for old callers. */
export function loopKeys() { return [] }

/** Last p of the flight (the old opening is p 0..0.917, unchanged). */
export const PMAX = 1.86

// Scenes (vh of the 1200 vh opening -> p). Index shown in the HUD.
export const SCENES = [
  { id: 'S1', name: 'HALO', p0: 0.0, p1: 0.067 },
  { id: 'S2', name: 'PARTS', p0: 0.067, p1: 0.2 },
  { id: 'S3', name: 'ONE RULE', p0: 0.2, p1: 0.3005 }, // round 13: the stop at 0.3 belongs to 03 (its HUD label read 04)
  { id: 'S4', name: '160', p0: 0.3005, p1: 0.517 },
  { id: 'S5', name: 'SEES', p0: 0.517, p1: 0.633 },
  { id: 'S6', name: 'TWO POLICIES', p0: 0.633, p1: 0.7 },
  { id: 'S7', name: 'B2', p0: 0.7, p1: 0.917 },
  // FULL SITE: the old S8 hand-off became six scenes; `hash` = the index.html chapter id it carries (deep links match),
  // `hold` = where a jump / a reduced-motion cut lands
  { id: 'S8', name: 'REAL RUNS', p0: 0.917, p1: 1.1 },
  { id: 'S9', name: 'RESULTS', p0: 1.1, p1: 1.255 },
  { id: 'S10', name: 'LIMITS', p0: 1.255, p1: 1.37 },
  { id: 'S11', name: 'TOUCH', p0: 1.37, p1: 1.5 },
  { id: 'S12', name: 'SANDBOX', p0: 1.5, p1: 1.7 },
  { id: 'S13', name: 'WHAT I BUILT', p0: 1.7, p1: 1.86 },
]
const HASH = ['hero', 'arm', 'task', 'data', 'sees', 'policies', 'test', 'film', 'results', 'limits', 'touch', 'sandbox', 'built']
const HOLD = [0.0, 0.17, 0.29, 0.44, 0.6, 0.68, 0.9, 1.04, 1.19, 1.32, 1.45, 1.61, 1.8]
SCENES.forEach((s, i) => { s.hash = HASH[i]; s.hold = HOLD[i] })

// Round 6: one hot element per frame and colour reserved for events. Per stop: ring = stage.setRingLevel target (the ring
// is hot only where it is the subject: the opening, the halo, the close); teal / held = the grid's trained-cell and B2
// colour (js/stage/grid.js setGridTone: 0 = thin warm-white light at rest). Smoothstepped in p between stops, so a flight
// carries the change through its own ease.
export const LOOK = [
  { p: 0.0, ring: 1, teal: 0, held: 0 }, { p: 0.04, ring: 1, teal: 0, held: 0 }, // the opening's subject, then the halo
  { p: 0.108, ring: 0.25, teal: 0, held: 0 }, { p: 0.17, ring: 0.2, teal: 0, held: 0 }, // parts; the servo is the subject
  { p: 0.235, ring: 0.3, teal: 0, held: 0.25 }, { p: 0.3, ring: 0.25, teal: 1, held: 1 }, // eight cells teach, B2 empty: colour
  { p: 0.45, ring: 0.3, teal: 1, held: 0.5 }, { p: 0.515, ring: 0.3, teal: 0.3, held: 1 }, // the landing; the dive into B2
  { p: 0.56, ring: 0.4, teal: 0, held: 0 }, { p: 0.615, ring: 0.45, teal: 0, held: 0 },
  { p: 0.68, ring: 0.3, teal: 0, held: 0 },
  { p: 0.775, ring: 0.6, teal: 0, held: 1 }, { p: 0.905, ring: 0.6, teal: 0, held: 1 }, // the test: B2's light is the event
  { p: 1.04, ring: 0.5, teal: 0.55, held: 0.55 }, // real runs: the leaders land on coloured cells (trained vs held out)
  { p: 1.19, ring: 0.22, teal: 0, held: 0 }, { p: 1.32, ring: 0.4, teal: 0, held: 0 },
  { p: 1.45, ring: 0.2, teal: 0, held: 0 }, // touch: the servo glow is the only warm thing
  { p: 1.61, ring: 0.6, teal: 1, held: 1 }, // sandbox: the cells are buttons
  { p: 1.8, ring: 1, teal: 0, held: 0 }, // the close: the ring sweeps its last gap
]
/** The LOOK values at p (smoothstep between neighbouring stops). */
export function lookAt(p, out = { ring: 1, teal: 0, held: 0 }) {
  let i = 0
  while (i < LOOK.length - 2 && p > LOOK[i + 1].p) i++
  const a = LOOK[i], b = LOOK[i + 1]
  let t = Math.min(1, Math.max(0, (p - a.p) / (b.p - a.p)))
  t = t * t * (3 - 2 * t)
  out.ring = a.ring + (b.ring - a.ring) * t; out.teal = a.teal + (b.teal - a.teal) * t; out.held = a.held + (b.held - a.held) * t
  return out
}

const COMPS = [['pos', 3], ['look', 3], ['fov', 1], ['dx', 1], ['focus', 1], ['at', 3]]

/** Resolve the keys' values (round 13b: every key is a fixed camera on the orbit; ctx.shot() is fitted per viewport). Each
 *  resolved key carries its orbit params `orb` { th, r, h } and the camera pos made from them. */
export function resolveKeys(ctx) {
  return KEYS.map((k) => {
    const r = { p: k.p }
    const rg = k.rig ? k.rig(ctx) : null
    const g = (n) => { let v = k[n] !== undefined ? k[n] : rg?.[n]; if (typeof v === 'function') v = v(ctx); return v }
    const look = g('look')
    let O = { th: g('th'), r: g('r'), h: g('h') }
    if (k.pos) O = orbOf(typeof k.pos === 'function' ? k.pos(ctx) : k.pos, O.th)
    r.orb = O
    r.pos = orbPos(O.th, O.r, O.h); r.look = look
    r.fov = [g('fov') ?? 30]; r.dx = [g('dx') ?? 0]; r.focus = [g('focus') ?? 0]
    r.at = g('at') ?? look
    r.rest = !!k.rest; r.line = !!k.line
    return r
  })
}

/** Monotone cubic interpolation of every key component at p. Returns {pos, look, fov, dx, focus, at}. */
export function sample(p, ctx, out = { pos: [0, 0, 0], look: [0, 0, 0], fov: 30, dx: 0, focus: 0, at: [0, 0, 0] }) {
  return sampleK(p, resolveKeys(ctx), out)
}
/** round 13: sample() on keys already resolved for this frame (nav.js samples every knot of the loop per frame). */
export function sampleK(p, K, out = { pos: [0, 0, 0], look: [0, 0, 0], fov: 30, dx: 0, focus: 0, at: [0, 0, 0] }) {
  const n = K.length
  p = Math.min(K[n - 1].p, Math.max(0, p)) // FULL SITE: the last key is PMAX, not 1
  let i = 0
  while (i < n - 2 && p > K[i + 1].p) i++
  const t0 = K[i].p, t1 = K[i + 1].p, h = t1 - t0, s = h > 0 ? (p - t0) / h : 0
  for (const [name, dim] of COMPS) {
    for (let c = 0; c < dim; c++) {
      const y = (k) => K[k][name][c]
      const slope = (k) => (y(k + 1) - y(k)) / (K[k + 1].p - K[k].p || 1e-6)
      const tan = (k) => {
        if (k === 0 || k === n - 1) return 0 // the path starts and ends at rest
        const a = slope(k - 1), b = slope(k)
        if (a * b <= 0) return 0
        const m = (a + b) / 2
        return Math.sign(m) * Math.min(Math.abs(m), 3 * Math.abs(a), 3 * Math.abs(b))
      }
      const m0 = tan(i) * h, m1 = tan(i + 1) * h, y0 = y(i), y1 = y(i + 1)
      const s2 = s * s, s3 = s2 * s
      const v = (2 * s3 - 3 * s2 + 1) * y0 + (s3 - 2 * s2 + s) * m0 + (-2 * s3 + 3 * s2) * y1 + (s3 - s2) * m1
      if (dim === 1) out[name] = v; else out[name][c] = v
    }
  }
  return out
}

export function sceneAt(p) {
  for (let i = 0; i < SCENES.length; i++) if (p < SCENES[i].p1) return i
  return SCENES.length - 1
}
