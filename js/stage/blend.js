// Continuous chapter blending: the maths shared by the camera rig and the arm.
// Pure (no three.js, no DOM). A "pose" is the rig's base state [px,py,pz, lx,ly,lz, fov, dx,dy]; a "comps" vector is the
// same camera expressed around its look-at point in spherical form, so springs run along arcs, never through the arm.

export const smooth01 = (t) => { const x = t < 0 ? 0 : t > 1 ? 1 : t; return x * x * (3 - 2 * x) }
const easeOut2 = (t) => 1 - (1 - t) * (1 - t)
const lerp = (a, b, t) => a + (b - a) * t
const wrap = (d) => { while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d }

/** comps layout */
export const C = { LX: 0, LY: 1, LZ: 2, FOV: 3, DX: 4, DY: 5, R: 6, TH: 7, PH: 8, LIFT: 9, N: 10 }

/** Per-component speed caps (units per second): the camera can never whip, however fast the page scrolls. */
export const CAM_MAX_SPEED = [0.9, 0.9, 0.9, 18, 1.1, 1.1, 1.1, 1.0, 0.75, 0.5]
export const CAM_SMOOTH_TIME = 0.34 // s, critically damped

export function poseToComps(s, out = new Float64Array(C.N)) {
  const ox = s[0] - s[3], oy = s[1] - s[4], oz = s[2] - s[5]
  const r = Math.hypot(ox, oy, oz) || 1e-6
  out[C.LX] = s[3]; out[C.LY] = s[4]; out[C.LZ] = s[5]
  out[C.FOV] = s[6]; out[C.DX] = s[7]; out[C.DY] = s[8]
  out[C.R] = r; out[C.TH] = Math.atan2(oz, ox); out[C.PH] = Math.asin(Math.max(-1, Math.min(1, oy / r))); out[C.LIFT] = 0
  return out
}

export function compsToPose(c, s = new Array(9)) {
  const cp = Math.cos(c[C.PH])
  s[3] = c[C.LX]; s[4] = c[C.LY]; s[5] = c[C.LZ]
  s[0] = c[C.LX] + c[C.R] * cp * Math.cos(c[C.TH])
  s[1] = c[C.LY] + c[C.R] * Math.sin(c[C.PH]) + c[C.LIFT]
  s[2] = c[C.LZ] + c[C.R] * cp * Math.sin(c[C.TH])
  s[6] = c[C.FOV]; s[7] = c[C.DX]; s[8] = c[C.DY]
  return s
}

const _ca = new Float64Array(C.N), _cb = new Float64Array(C.N)

/**
 * Camera target for the transition a -> b at scroll fraction t (0..1). Same authored arc as the old fixed-time flight:
 * spherical blend around the moving look-at, a raised mid-waypoint, and a lens shift that leads so the subject clears the
 * text column early. `ref` (optional comps) picks the azimuth branch nearest to where the camera already is.
 */
export function blendTarget(a, b, t, out, ref = null) {
  poseToComps(a, _ca); poseToComps(b, _cb)
  const e = smooth01(t)
  const eShift = easeOut2(Math.min(1, t / 0.6))
  out[C.LX] = lerp(_ca[C.LX], _cb[C.LX], e); out[C.LY] = lerp(_ca[C.LY], _cb[C.LY], e); out[C.LZ] = lerp(_ca[C.LZ], _cb[C.LZ], e)
  out[C.FOV] = lerp(_ca[C.FOV], _cb[C.FOV], e)
  out[C.DX] = lerp(_ca[C.DX], _cb[C.DX], eShift); out[C.DY] = lerp(_ca[C.DY], _cb[C.DY], eShift)
  out[C.R] = lerp(_ca[C.R], _cb[C.R], e)
  out[C.PH] = lerp(_ca[C.PH], _cb[C.PH], e)
  let th = _ca[C.TH] + wrap(_cb[C.TH] - _ca[C.TH]) * e
  if (ref) th = ref[C.TH] + wrap(th - ref[C.TH]) // stay on the follower's unwrapped branch
  out[C.TH] = th
  const chord = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) + Math.hypot(a[3] - b[3], a[4] - b[4], a[5] - b[5])
  out[C.LIFT] = Math.min(0.28, 0.16 * chord) * Math.sin(Math.PI * e)
  return out
}

/**
 * Critically damped follower with a speed cap (Game Programming Gems 4 "SmoothDamp", exact exponential form).
 * State lives in the caller's arrays (x = value, v = velocity, both indexed by i) so the per-frame path allocates nothing.
 */
export function smoothDampInto(x, v, target, i, smoothTime, maxSpeed, dt) {
  const st = Math.max(1e-4, smoothTime)
  const omega = 2 / st
  const ex = Math.exp(-omega * dt)
  const maxChange = maxSpeed * st
  let change = x[i] - target
  const orig = target
  change = Math.max(-maxChange, Math.min(maxChange, change))
  const tgt = x[i] - change
  const temp = (v[i] + omega * change) * dt
  v[i] = (v[i] - omega * temp) * ex
  let out = tgt + (change + temp) * ex
  if ((orig - x[i] > 0) === (out > orig)) { out = orig; v[i] = 0 } // never overshoot the real target
  x[i] = out
}
