// Pick-and-place choreography: IK waypoints solved once per target, played back through a Hermite spline.
// Everything the scene shows for a task (arm pose, noodle, phase) is a pure function of the task time t, so the page
// can pause, scrub and replay it exactly.
import * as THREE from 'three'
import { JOINT_NAMES } from './robot.js'
import { cellCenter, noodleYaw, NOODLE, CUP, TABLE_Y } from './layout.js'
import { smoothDampInto } from './blend.js'

export const GRIP_OPEN = 0.95
export const HZ = 30
export const PHASE_NAMES = ['approach', 'descend', 'grasp', 'lift', 'carry', 'release', 'return']
// Phase windows (s), and the moment along the path each phase's marker is pinned to.
// Deliberate pacing (v6): a settle at the grasp, and a real release beat - jaws open, the noodle drops and settles in the
// cup, the arm waits for it - before the arm withdraws. Carry is pinned mid-arc so it sits clear of Release above the cup.
const PHASE_T = [[0, 1.05], [1.05, 1.85], [1.85, 2.5], [2.5, 3.45], [3.45, 4.25], [4.25, 5.3], [5.3, 6.7]]
const PHASE_PIN = [0.32, 1.45, 2.2, 2.85, 3.7, 4.65, 6.0]
const FALL_G = 3.6, FALL_XZ = 7, FALL_ROT = 9, FALL_REST = 0.28 // the noodle's drop into the cup
// Idle pose follower: critically damped with a per-joint speed cap, so a change of resting pose (or a task handing over to
// one) is a glide, never a whip. Caps in rad/s: shoulder pan/lift, elbow, wrist flex, wrist roll, gripper.
const IDLE_SMOOTH = 0.42
const IDLE_MAX = [1.1, 1.1, 1.25, 1.4, 1.6, 1.6]
// A loop task's authored choreography has a few fast swings (the wrist roll on the return, mostly). Loop tasks are never
// scrubbed, so the displayed joints are slew-limited to these rad/s: a whip becomes a slightly late, then caught-up, motion.
const AUTO_SLEW = [3.2, 3.2, 3.0, 3.4, 4.0, 5.0]
const GLIDE_RATE = 0.85 // rad/s: a task that starts away from its home pose glides in at no more than about this speed
const GRASP_KNOT = 4 // closed on the noodle
const SCRUB_RATE = 18 // how fast the displayed time chases a scrub target

function makeSpline(knots) {
  const n = knots.length
  const m = knots.map((k, i) => {
    if (k.stop || i === 0 || i === n - 1) return new Array(6).fill(0)
    const h = knots[i + 1].t - knots[i - 1].t
    return k.q.map((_, j) => (0.85 * (knots[i + 1].q[j] - knots[i - 1].q[j])) / h) // softer tangents: less snap
  })
  return function sample(t, out) {
    let i = 0
    while (i < n - 2 && t > knots[i + 1].t) i++
    const a = knots[i], b = knots[i + 1]
    const h = b.t - a.t
    const s = THREE.MathUtils.clamp((t - a.t) / h, 0, 1)
    const s2 = s * s, s3 = s2 * s
    const h00 = 2 * s3 - 3 * s2 + 1, h10 = s3 - 2 * s2 + s, h01 = -2 * s3 + 3 * s2, h11 = s3 - s2
    for (let j = 0; j < 6; j++) {
      out[j] = h00 * a.q[j] + h10 * h * m[i][j] + h01 * b.q[j] + h11 * h * m[i + 1][j]
    }
    return out
  }
}

/** Bump when the choreography (waypoints, timings, IK settings) changes: invalidates baked plans. */
export const PLAN_VERSION = 6

/** A pick target: a cell, or any table point. */
export function targetForCell(cell) {
  const c = cellCenter(cell)
  return { cell, x: c.x, z: c.z, yaw: noodleYaw(cell) }
}

/**
 * IK-solve every waypoint of a pick-and-place. A generator: it yields between waypoint solves so live planning can
 * spread the work over event-loop turns; solveTask() runs it to completion. Returns plain data (bakeable).
 */
export function* solveTaskSteps(ik, homeQ, target, fast = false) {
  const GRIP_HOLD = ik.rig.grasp.theta // jaw angle that closes on the tube (measured from the meshes, see grasp.js)
  const c = { x: target.x, z: target.z }
  const yaw = target.yaw
  const axis = new THREE.Vector3(Math.cos(yaw), 0, Math.sin(yaw))
  const gy = NOODLE.r // tube centre height: the jaws straddle it at mid-height
  const at = (p, y) => new THREE.Vector3(p.x, y, p.z)
  const F = fast ? { fast: true } : {}
  const bail = (why) => ({ knots: [], roll: 0, tilt: 9, ok: false, why })

  const graspT = at(c, gy)
  let g = ik.solve(graspT, { roll: 0, ...F })
  if (!g) return bail('grasp')
  let roll = ik.rollForAxis(g.q, axis)
  g = ik.solve(graspT, { roll, seed: g.q, ...F })
  if (!g) return bail('grasp')
  roll = ik.rollForAxis(g.q, axis, roll)
  yield

  const hover = ik.solve(at(c, gy + 0.075), { roll, seed: g.q, maxTilt: 0.85, ...F })
  const pre = ik.solve(at(c, gy + 0.012), { roll, seed: g.q, maxTilt: 0.6, ...F }) // 1 cm above the grasp: the arm slows into it
  yield
  const lift = ik.solve(at(c, gy + 0.12), { roll, seed: g.q, maxTilt: 0.85, weights: [0.1, 0.04], ...F })
  const cupC = new THREE.Vector3(CUP.x, TABLE_Y + CUP.h + 0.048, CUP.z)
  const mid = new THREE.Vector3((c.x + cupC.x) / 2, 0.17, (c.z + cupC.z) / 2)
  yield
  const midS = lift && ik.solve(mid, { roll, seed: lift.q, maxTilt: 1.0, weights: [0.06, 0.02], ...F })
  const cupS = midS && ik.solve(cupC, { roll, seed: midS.q, maxTilt: 1.2, weights: [0.1, 0.04, 0.015], ...F })
  yield
  const away = cupS && ik.solve(cupC.clone().add(new THREE.Vector3(-0.02, 0.05, 0)), { roll, seed: cupS.q, maxTilt: 1.2, weights: [0.1, 0.04, 0.015], ...F })
  if (![hover, pre, lift, midS, cupS, away].every(Boolean)) return bail('waypoint')

  const r4 = (v) => Math.round(v * 1e4) / 1e4
  const k = (t, s, grip, stop = false) => ({ t, q: [...s.q, roll, grip].map(r4), stop })
  const knots = [
    { t: 0, q: homeQ.map(r4), stop: true },
    k(1.05, hover, GRIP_OPEN),
    k(1.55, pre, GRIP_OPEN),
    k(1.85, g, GRIP_OPEN, true),
    k(2.4, g, GRIP_HOLD, true),
    k(3.0, lift, GRIP_HOLD),
    k(3.55, midS, GRIP_HOLD),
    k(4.25, cupS, GRIP_HOLD, true),
    k(4.75, cupS, GRIP_OPEN + 0.1, true), // jaws open (the noodle lets go at releaseT, halfway through)
    k(5.3, cupS, GRIP_OPEN + 0.1, true), // and the arm waits while it drops and settles
    k(5.95, away, GRIP_OPEN, false),
    // settle: overshoot home by a hair, then come to rest
    { t: 6.35, q: homeQ.map((v, i) => r4(i === 5 ? 0.45 : v + (i < 4 ? 0.02 * Math.sign(v - away.q[i] || 1) : 0))), stop: false },
    { t: 6.7, q: homeQ.map((v, i) => r4(i === 5 ? 0.45 : v)), stop: true },
  ]
  const errs = { g, hover, pre, lift, midS, cupS, away }
  const tol = { g: 4e-3, hover: 5e-3, pre: 5e-3 } // the transit waypoints only need to be roughly right
  const ok = Object.entries(errs).every(([k, s]) => s.posErr < (tol[k] ?? 15e-3))
  return { knots, roll: r4(roll), tilt: r4(g.tilt), ok, ...(ok ? {} : { why: 'posErr ' + Object.entries(errs).map(([k, s]) => k + '=' + (s.posErr * 1000).toFixed(1) + 'mm').join(' ') }) }
}

/** Run the generator to completion (bake tool, boot fallback). `target` may be a cell id. */
export function solveTask(ik, homeQ, target) {
  const it = solveTaskSteps(ik, homeQ, typeof target === 'string' ? targetForCell(target) : target)
  let r
  do r = it.next(); while (!r.done)
  return r.value
}

/** Point on a 30 Hz path (flat xyz) at time s. */
function pathPoint(path, s, out) {
  const last = path.length / 3 - 1
  const f = Math.min(last, Math.max(0, s * HZ))
  const i0 = Math.floor(f), i1 = Math.min(last, i0 + 1), u = f - i0
  return out.set(
    path[i0 * 3] + (path[i1 * 3] - path[i0 * 3]) * u,
    path[i0 * 3 + 1] + (path[i1 * 3 + 1] - path[i0 * 3 + 1]) * u,
    path[i0 * 3 + 2] + (path[i1 * 3 + 2] - path[i0 * 3 + 2]) * u,
  )
}

/** Closed-form drop into the cup (x/z relax to the cup centre, up to two damped bounces): a function of time only. */
function makeFall(p0, q0, qT) {
  const yb = TABLE_Y + CUP.wall + NOODLE.r
  const segs = []
  let t = 0
  let y = Math.max(p0.y, yb)
  let vy = 0
  for (let n = 0; n < 3; n++) {
    // flight from height y with initial vertical speed vy until it returns to yb
    const disc = vy * vy + 2 * FALL_G * (y - yb)
    const dur = (vy + Math.sqrt(Math.max(0, disc))) / FALL_G
    segs.push({ t0: t, dur, y0: y, v0: vy })
    t += dur
    const vImpact = FALL_G * dur - vy
    if (n < 2 && Math.abs(vImpact) > 0.25) { vy = vImpact * FALL_REST; y = yb } else break
  }
  return { x0: p0.x, z0: p0.z, q0: q0.clone(), qT, segs, end: t }
}

const _qa = new THREE.Quaternion()
/** Noodle pose while falling, tau seconds after release. Writes into `pos`/`quat`. */
export function fallPose(f, tau, pos, quat) {
  const ex = Math.exp(-FALL_XZ * tau)
  pos.x = CUP.x + (f.x0 - CUP.x) * ex
  pos.z = CUP.z + (f.z0 - CUP.z) * ex
  let y = TABLE_Y + CUP.wall + NOODLE.r
  for (const s of f.segs) {
    if (tau >= s.t0 && tau < s.t0 + s.dur) { const u = tau - s.t0; y = s.y0 + s.v0 * u - 0.5 * FALL_G * u * u; break }
  }
  pos.y = y
  quat.copy(f.q0).slerp(_qa.copy(f.qT), 1 - Math.exp(-FALL_ROT * tau))
}

/** Turn solved knots into a playable plan (spline, 30 Hz tcp path, noodle transforms, phase pins). FK only. */
export function buildPlan(rig, ik, targetOrCell, spec) {
  const target = typeof targetOrCell === 'string' ? targetForCell(targetOrCell) : targetOrCell
  const c = { x: target.x, z: target.z }
  const yaw = target.yaw
  const { knots } = spec
  const spline = makeSpline(knots)
  const duration = knots[knots.length - 1].t

  const saved = JOINT_NAMES.map((nme) => rig.joints[nme].angle)
  const n = Math.ceil(duration * HZ) + 1
  const tcpPath = new Float32Array(n * 3)
  const q = new Array(6).fill(0)
  const scratch = {}
  for (let i = 0; i < n; i++) {
    spline(Math.min(i / HZ, duration), q)
    ik.fk(q, scratch)
    tcpPath[i * 3] = scratch.p.x; tcpPath[i * 3 + 1] = scratch.p.y; tcpPath[i * 3 + 2] = scratch.p.z
  }

  const tablePose = {
    p: new THREE.Vector3(c.x, TABLE_Y + NOODLE.r, c.z),
    q: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -yaw),
  }
  // where the noodle sits in the tcp frame at the grasp instant (for held placement, no pop)
  const gq = knots[GRASP_KNOT].q
  JOINT_NAMES.forEach((nme, i) => rig.joints[nme].setJointValue(gq[i]))
  rig.robot.updateMatrixWorld(true)
  const local = new THREE.Matrix4().copy(rig.tcp.matrixWorld).invert().multiply(new THREE.Matrix4().compose(tablePose.p, tablePose.q, new THREE.Vector3(1, 1, 1)))
  const heldLocal = { p: new THREE.Vector3(), q: new THREE.Quaternion() }
  local.decompose(heldLocal.p, heldLocal.q, new THREE.Vector3())

  // where the noodle is when the jaws let go (world), and the closed-form drop from there
  const grabT = 2.4, releaseT = 4.5
  spline(releaseT, q)
  JOINT_NAMES.forEach((nme, i) => rig.joints[nme].setJointValue(q[i]))
  rig.robot.updateMatrixWorld(true)
  const rel = new THREE.Matrix4().multiplyMatrices(rig.tcp.matrixWorld, new THREE.Matrix4().compose(heldLocal.p, heldLocal.q, new THREE.Vector3(1, 1, 1)))
  const rp = new THREE.Vector3(), rq = new THREE.Quaternion()
  rel.decompose(rp, rq, new THREE.Vector3())
  JOINT_NAMES.forEach((nme, i) => rig.joints[nme].setJointValue(saved[i]))
  rig.robot.updateMatrixWorld(true)
  const ax = new THREE.Vector3(1, 0, 0).applyQuaternion(rq).setY(0).normalize()
  const fall = makeFall(rp, rq, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(-ax.z, ax.x)))

  // phase windows + the world point each phase word is pinned to (a point on the TCP path)
  const phases = PHASE_NAMES.map((name, i) => ({ phase: name, s0: PHASE_T[i][0], s1: Math.min(PHASE_T[i][1], duration), pin: PHASE_PIN[i] }))
  const timeline = phases.map((p) => ({ phase: p.phase, t0: p.s0 / duration, t1: p.s1 / duration }))
  const phasePts = phases.map((p) => pathPoint(tcpPath, p.pin, new THREE.Vector3()))

  return {
    cell: target.cell ?? null, target, knots, duration, spline, tcpPath, heldLocal, roll: spec.roll,
    grabT, releaseT, tablePose, fall, phases, timeline, phasePts,
    graspQ: knots[GRASP_KNOT].q.slice(), liftQ: knots[GRASP_KNOT + 1].q.slice(), hoverQ: knots[1].q.slice(),
    ok: spec.ok, tilt: spec.tilt,
  }
}

/** Plays queued tasks and loops, holds/scrubs the current one, and eases toward a resting pose otherwise. */
export class ArmController {
  constructor({ rig, noodle, homeQ, plans }) {
    this.rig = rig
    this.noodle = noodle
    this.plans = plans
    this.q = homeQ.slice()
    this.target = homeQ.slice()
    this.queue = []
    this.cur = null // { plan, resolve, auto, blend }: the running (or paused / scrubbed) task
    this.last = null // the most recently finished task: still scrubbable until the next one starts
    this.t = 0 // displayed task time (s)
    this.paused = false
    this.scrubTo = null // seconds; while set, t chases it
    this.snap = false
    this.qv = new Array(6).fill(0)
    this._q = new Array(6).fill(0)
    // round 14 (flight only; null = the default page's behaviour, unchanged): { v, a, grip } in rad/s, rad/s^2. Every
    // task (loop, explicit, scrubbed) is then TIME-SCALED so no joint passes v or a (the pose stays exactly on the plan,
    // so the noodle never pops), and a job waits for the arm to glide to its start pose with continuous velocity.
    this.calm = null
    this.sv = 0 // calm: displayed task-time velocity (task s per s, signed)
    this._apply()
  }

  /** Current phase name from the displayed time (allocation-free); 'idle' when no task is active. */
  phase() {
    if (!this.cur) return 'idle'
    return this.phaseAt(this.cur.plan, this.t)
  }
  phaseAt(plan, t) {
    const ph = plan.phases
    for (let i = ph.length - 1; i > 0; i--) if (t >= ph[i].s0) return ph[i].phase
    return ph[0].phase
  }

  get busy() { return !!this.cur || this.queue.length > 0 }
  get playing() { return this.cur }
  /** The plan currently shown by the timeline: the active task, else the last finished one. */
  get plan() { return this.cur?.plan ?? this.last?.plan ?? null }

  runTask(cell) {
    if (!this.plans[cell]) return Promise.reject(new Error(`Unknown cell "${cell}"`))
    return this.runPlan(this.plans[cell])
  }

  /** Queue an already-planned task (cell plan, or one planned live for a table point). */
  runPlan(plan, auto = false) {
    return new Promise((resolve) => {
      if (!auto && this.cur && this.paused) this._finish(true) // a paused task gives way to an explicit new one
      this.queue.push({ plan, resolve, auto })
    })
  }

  clearQueue() { this.queue.length = 0 }

  /** Drop a running loop task (used when reduced motion turns on); explicit tasks are left alone. */
  abortAuto() {
    this.queue = this.queue.filter((j) => !j.auto)
    if (this.cur?.auto) { this.cur = null; this.paused = false; this.scrubTo = null }
  }

  pause() { if (this.cur) this.paused = true }
  resume() {
    this.paused = false
    this.scrubTo = null
  }
  /** u in 0..1 within the current / last task. Implies pause. */
  scrub(u) {
    const plan = this.plan
    if (!plan) return false
    if (!this.cur) { // bring the finished task back on stage, starting from its end
      this.cur = { plan, resolve: () => {}, auto: false, blend: this.last.blend, blendDur: this.last.blendDur ?? 1.1 }
      this.t = plan.duration
      if (this.calm) { this.cur.prof = this._profile(plan, this.cur.blend, this.cur.blendDur); this.sv = 0 }
    }
    this.paused = true
    this.scrubTo = THREE.MathUtils.clamp(u, 0, 1) * plan.duration
    return true
  }

  setTarget(q, snap = false) {
    for (let i = 0; i < 6; i++) this.target[i] = q[i]
    if (snap && !this.cur) { this.q = q.slice(); this.qv.fill(0); this._apply() }
  }

  atTarget(eps = 0.02) { return !this.cur && this.q.every((v, i) => Math.abs(v - this.target[i]) < eps) }

  /** speed: playback rate. loopCell: () => cell|null called when idle. */
  update(dt, { speed = 1, loopCell = null } = {}) {
    if (!this.cur && !this.queue.length && loopCell) {
      const next = loopCell()
      if (next && this.plans[next]) this.queue.push({ plan: this.plans[next], resolve: () => {}, auto: true })
    }
    if (!this.cur && this.queue.length) {
      const job = this.queue[0]
      // A loop task begins from its home pose: glide there first (speed-capped) rather than blending a big offset into it.
      // round 14 (calm): every job does, so a task never starts with the arm still moving (velocity stays continuous);
      // its noodle is laid out once while the arm glides (the previous one shrinks away where it is: cup, gripper, air)
      if ((job.auto || this.calm) && !this.snap && !this._settledAt(job.plan.knots[0].q)) {
        if (this.calm && !job.preDone) { job.preDone = true; job.pre = this._preSpawn(job.plan) }
        this._glide(job.plan.knots[0].q, dt)
        this._apply()
        return
      }
      this._start(this.queue.shift())
    }
    if (this.cur && this.calm) { // round 14: time-scaled playback / scrub (see _calmStep)
      if (this._calmStep(dt, speed)) return
      this._pose(this.cur.plan, this.t, this.scrubTo === null && !this.paused, dt)
    } else if (this.cur) {
      const plan = this.cur.plan
      if (this.scrubTo !== null) { // chase the scrub target (fast critically-damped glide, exact once close)
        const d = this.scrubTo - this.t
        this.t = Math.abs(d) < 2e-3 ? this.scrubTo : this.t + d * (1 - Math.exp(-dt * SCRUB_RATE))
      } else if (!this.paused) {
        this.t += dt * speed
        if (this.t >= plan.duration) { this._finish(false); return }
      }
      this._pose(plan, this.t, this.scrubTo === null && !this.paused, dt)
    } else if (this.snap) {
      this.q = this.target.slice()
    } else {
      this._glide(this.target, dt)
    }
    this._apply()
  }

  /** Critically damped, speed-capped step of the displayed pose toward `q` (eases out of motion, settles without a pop). */
  _glide(q, dt) {
    for (let i = 0; i < 6; i++) smoothDampInto(this.q, this.qv, q[i], i, IDLE_SMOOTH, IDLE_MAX[i], dt)
  }

  _settledAt(q) {
    const e = this.calm ? 0.004 : 0.03, ev = this.calm ? 0.012 : 0.08 // calm: the glide lands at rest, the task starts at rest
    for (let i = 0; i < 6; i++) if (Math.abs(this.q[i] - q[i]) > e || Math.abs(this.qv[i]) > ev) return false
    return true
  }

  /**
   * Leave a running loop task early, while the noodle is still on the table (before the grasp): the arm simply glides on
   * from where it is, carrying its velocity. Returns true if it yielded. Later phases finish on their own (eased speed).
   */
  yieldAuto() {
    const c = this.cur
    if (!c || !c.auto || this.paused || this.scrubTo !== null || this.t >= c.plan.grabT - 0.35) return false
    this.last = { plan: c.plan, blend: c.blend, blendDur: c.blendDur }
    this.cur = null
    c.resolve()
    return true
  }

  _pose(plan, t, playing, dt = 0) {
    plan.spline(Math.min(t, plan.duration), this._q)
    const b = this.cur.blend
    if (b) { // glide in from wherever the arm was parked (a function of t, so it scrubs too)
      const w = Math.max(0, 1 - t / this.cur.blendDur)
      const e = w * w * (3 - 2 * w)
      for (let i = 0; i < 6; i++) this._q[i] += b[i] * e
    }
    if (this.cur.auto && dt > 0 && !this.calm) { // slew limit (loop tasks only: explicit / scrubbed tasks must stay exact)
      for (let i = 0; i < 6; i++) {
        const m = AUTO_SLEW[i] * dt, d = this._q[i] - this.q[i]
        if (d > m) this._q[i] = this.q[i] + m; else if (d < -m) this._q[i] = this.q[i] - m
      }
    }
    for (let i = 0; i < 6; i++) {
      if (dt > 1e-4) this.qv[i] += ((this._q[i] - this.q[i]) / dt - this.qv[i]) * Math.min(1, dt * 30) // velocity estimate, for handing over
      this.q[i] = this._q[i]
    }
    this.noodle.applyPlan(plan, t, playing && !this.cur.pre) // a pre-spawned noodle has already grown in
  }

  /** The plan's pose at task time t (spline + the glide-in blend), without the slew limit. */
  _poseAt(plan, b, bd, t, out) {
    plan.spline(Math.min(Math.max(t, 0), plan.duration), out)
    if (b) { const w = Math.max(0, 1 - t / bd), e = w * w * (3 - 2 * w); for (let i = 0; i < 6; i++) out[i] += b[i] * e }
    return out
  }

  /**
   * round 14 (calm): the task's rate profile. On a 1/60 s grid of task time: cap(s) = the largest playback rate that keeps
   * every joint under calm.v (gripper calm.grip) and its path acceleration under calm.a (|q'| r <= v, |q''| r^2 <= a), and
   * ra(s) = the rate change allowed there (|q'| dr/dt <= a). fwd / bwd = cap made reachable with braking at ra in each
   * direction (phase plane: r_i^2 <= r_(i+1)^2 + 2 ra ds), so the playhead always slows BEFORE a fast stretch.
   */
  _profile(plan, b, bd) {
    const C = this.calm, G = 1 / 60, n = Math.ceil(plan.duration / G) + 1
    const P = new Float64Array(n * 6), tmp = new Array(6)
    for (let k = 0; k < n; k++) { this._poseAt(plan, b, bd, k * G, tmp); for (let i = 0; i < 6; i++) P[k * 6 + i] = tmp[i] }
    const cap = new Float64Array(n), ra = new Float64Array(n), fwd = new Float64Array(n), bwd = new Float64Array(n)
    for (let k = 0; k < n; k++) {
      const a = Math.max(0, k - 1), c = Math.min(n - 1, k + 1), h = (c - a) * G
      let r = 4, qd = 1e-6
      for (let i = 0; i < 6; i++) {
        const v = i === 5 ? C.grip : i === 4 ? (C.roll ?? C.v) : C.v // wrist roll may have its own cap (it turns the jaw in place)
        const d1 = Math.abs(P[c * 6 + i] - P[a * 6 + i]) / h
        const d2 = c - a === 2 ? Math.abs(P[c * 6 + i] - 2 * P[k * 6 + i] + P[a * 6 + i]) / (G * G) : 0
        if (d1 > 1e-6) r = Math.min(r, v / d1)
        if (d2 > 1e-6) r = Math.min(r, Math.sqrt((i === 5 ? 2 : 1) * C.a / d2))
        if (i < 5) qd = Math.max(qd, d1)
      }
      cap[k] = Math.max(0.02, r)
      ra[k] = Math.min(3, Math.max(0.15, C.a / qd))
    }
    fwd[n - 1] = cap[n - 1]
    for (let k = n - 2; k >= 0; k--) fwd[k] = Math.min(cap[k], Math.sqrt(fwd[k + 1] * fwd[k + 1] + 2 * ra[k] * G))
    bwd[0] = cap[0]
    for (let k = 1; k < n; k++) bwd[k] = Math.min(cap[k], Math.sqrt(bwd[k - 1] * bwd[k - 1] + 2 * ra[k] * G))
    return { G, n, ra, fwd, bwd }
  }

  /**
   * round 14 (calm): advance the displayed task time. Playing: toward `speed`, never above the profile; scrubbing: a
   * trapezoid toward the scrub target (either way) under the same profile; paused: brakes to rest. The task-time velocity
   * sv is carried across play / scrub / pause switches, so the arm never changes speed in one frame. Returns true when
   * the task finished (handled).
   */
  _calmStep(dt, speed) {
    const c = this.cur, plan = c.plan
    if (!c.prof) c.prof = this._profile(plan, c.blend, c.blendDur)
    const P = c.prof, k = Math.min(P.n - 1, Math.max(0, Math.round(this.t / P.G))), ra = P.ra[k]
    let want
    if (this.scrubTo !== null) {
      const d = this.scrubTo - this.t
      want = Math.abs(d) < 1e-4 ? 0 : Math.sign(d) * Math.min(d > 0 ? P.fwd[k] : P.bwd[k], Math.sqrt(2 * ra * Math.abs(d)))
    } else if (this.paused) want = 0
    else want = Math.min(Math.max(0, speed), P.fwd[k])
    let v = this.sv
    if (v > P.fwd[k]) v = P.fwd[k]; else if (v < -P.bwd[k]) v = -P.bwd[k] // the profile already braked toward this
    v += Math.max(-ra * dt, Math.min(ra * dt, want - v))
    let t = this.t + v * dt
    if (this.scrubTo !== null && (this.scrubTo - this.t) * (this.scrubTo - t) <= 0 && Math.abs(v) <= Math.sqrt(2 * ra * 1e-3) + ra * dt) { t = this.scrubTo; v = 0 }
    if (t < 0) { t = 0; v = Math.max(0, v) }
    this.sv = v
    if (this.scrubTo === null && !this.paused && t >= plan.duration) { this.t = plan.duration; this._finish(false); return true }
    this.t = Math.min(t, plan.duration)
    return false
  }

  /** round 14 (calm): lay the next job's noodle out while the arm glides to the start pose (the old one shrinks away). */
  _preSpawn(plan) {
    const nd = this.noodle, m = nd.mesh
    if (!plan.cell || this.plans[plan.cell] !== plan) return false // a sandbox table point: its noodle grows in as before
    if (m.visible && (nd.state === 'held' || nd.state === 'falling')) { // the cup case is spawnAt's own
      m.getWorldPosition(nd.ghost.position); m.getWorldQuaternion(nd.ghost.quaternion)
      nd.ghost.visible = true; nd.ghostT = 1
      nd.state = 'hidden' // spawnAt below must not ghost it a second time
    }
    if (!(nd.state === 'table' && nd.cell === plan.cell)) nd.spawnAt(plan.cell, true)
    return true
  }

  /** round 14 (calm): let the current task go where it is (any kind); the arm glides on from its velocity. */
  dropTask() {
    const c = this.cur
    if (!c) return false
    this.last = { plan: c.plan, blend: c.blend, blendDur: c.blendDur }
    this.cur = null; this.paused = false; this.scrubTo = null; this.sv = 0 // qv (the joints' velocity) is kept: the glide carries it
    c.resolve()
    return true
  }

  /**
   * round 14 (calm): the running LOOP task becomes an explicit (scrubbable) one where it is, same plan, same time, same
   * velocity: the flight's B2 pick takes over the policies loop's own B2 pick instead of rewinding or restarting it.
   */
  adoptAuto() {
    const c = this.cur
    if (!c || !c.auto) return false
    this.queue = this.queue.filter((j) => !j.auto)
    c.auto = false
    return true
  }

  /** End the active task: `cancel` resolves it immediately (a paused task replaced by a new one). */
  _finish(cancel) {
    const done = this.cur
    if (!done) return
    if (!cancel) {
      done.plan.spline(done.plan.duration, this._q)
      if (!done.auto) this.q = this._q.slice() // a loop task hands over from wherever the (slew-limited) arm is; the glide finishes the job
      this.noodle.applyPlan(done.plan, done.plan.duration, false)
    }
    this.last = { plan: done.plan, blend: done.blend, blendDur: done.blendDur }
    this.cur = null
    this.paused = false
    this.scrubTo = null
    this.sv = 0
    if (!done.auto || cancel) this.qv.fill(0)
    this._apply()
    done.resolve()
  }

  _start(job) {
    const plan = job.plan
    const h = plan.knots[0].q
    let blend = this.q.map((v, i) => v - h[i])
    if (blend.every((v) => Math.abs(v) < 0.01)) blend = null
    // The glide-in lasts long enough that no joint moves faster than GLIDE_RATE (never shorter than the old 1.1 s).
    const blendDur = blend ? Math.max(1.1, 1.5 * Math.max(...blend.map(Math.abs)) / GLIDE_RATE) : 1.1
    this.cur = { plan, resolve: job.resolve, auto: !!job.auto, blend, blendDur, pre: !!job.pre, tag: job.tag || null }
    if (this.calm) { this.cur.prof = this._profile(plan, blend, blendDur); this.sv = 0 }
    this.t = 0
    this.paused = false
    this.scrubTo = null
    this.noodle.beginTask(plan)
  }

  _apply() {
    const J = this.rig.joints
    for (let i = 0; i < 6; i++) J[JOINT_NAMES[i]].setJointValue(this.q[i])
  }
}
