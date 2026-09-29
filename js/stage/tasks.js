// Pick-and-place choreography: IK waypoints solved once per target, played back through a Hermite spline.
// Everything the scene shows for a task (arm pose, noodle, phase) is a pure function of the task time t, so the page
// can pause, scrub and replay it exactly.
import * as THREE from 'three'
import { JOINT_NAMES } from './robot.js'
import { cellCenter, noodleYaw, NOODLE, CUP, TABLE_Y } from './layout.js'

export const GRIP_OPEN = 0.95
export const HZ = 30
export const PHASE_NAMES = ['approach', 'descend', 'grasp', 'lift', 'carry', 'release', 'return']
// Phase windows (s), and the moment along the path each phase's marker is pinned to.
// Deliberate pacing (v6): a settle at the grasp, and a real release beat - jaws open, the noodle drops and settles in the
// cup, the arm waits for it - before the arm withdraws. Carry is pinned mid-arc so it sits clear of Release above the cup.
const PHASE_T = [[0, 1.05], [1.05, 1.85], [1.85, 2.5], [2.5, 3.45], [3.45, 4.25], [4.25, 5.3], [5.3, 6.7]]
const PHASE_PIN = [0.32, 1.45, 2.2, 2.85, 3.7, 4.65, 6.0]
const FALL_G = 3.6, FALL_XZ = 7, FALL_ROT = 9, FALL_REST = 0.28 // the noodle's drop into the cup
const OMEGA_IDLE = 4.2
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
      this.cur = { plan, resolve: () => {}, auto: false, blend: this.last.blend }
      this.t = plan.duration
    }
    this.paused = true
    this.scrubTo = THREE.MathUtils.clamp(u, 0, 1) * plan.duration
    return true
  }

  setTarget(q, snap = false) {
    this.target = q.slice()
    if (snap && !this.cur) { this.q = q.slice(); this._apply() }
  }

  atTarget(eps = 0.02) { return !this.cur && this.q.every((v, i) => Math.abs(v - this.target[i]) < eps) }

  /** speed: playback rate. loopCell: () => cell|null called when idle. */
  update(dt, { speed = 1, loopCell = null } = {}) {
    if (!this.cur && !this.queue.length && loopCell) {
      const next = loopCell()
      if (next && this.plans[next]) this.queue.push({ plan: this.plans[next], resolve: () => {}, auto: true })
    }
    if (!this.cur && this.queue.length) this._start(this.queue.shift())
    if (this.cur) {
      const plan = this.cur.plan
      if (this.scrubTo !== null) { // chase the scrub target (fast critically-damped glide, exact once close)
        const d = this.scrubTo - this.t
        this.t = Math.abs(d) < 2e-3 ? this.scrubTo : this.t + d * (1 - Math.exp(-dt * SCRUB_RATE))
      } else if (!this.paused) {
        this.t += dt * speed
        if (this.t >= plan.duration) { this._finish(false); return }
      }
      this._pose(plan, this.t, this.scrubTo === null && !this.paused)
    } else if (this.snap) {
      this.q = this.target.slice()
    } else {
      // critically damped return: eases out of motion, settles without a pop
      const e = Math.exp(-OMEGA_IDLE * dt)
      for (let i = 0; i < 6; i++) {
        const d = this.q[i] - this.target[i]
        const tt = (this.qv[i] + OMEGA_IDLE * d) * dt
        this.q[i] = this.target[i] + (d + tt) * e
        this.qv[i] = (this.qv[i] - OMEGA_IDLE * tt) * e
      }
    }
    this._apply()
  }

  _pose(plan, t, playing) {
    plan.spline(Math.min(t, plan.duration), this._q)
    const b = this.cur.blend
    if (b) { // glide in from wherever the arm was parked (a function of t, so it scrubs too)
      const w = Math.max(0, 1 - t / 1.1)
      const e = w * w * (3 - 2 * w)
      for (let i = 0; i < 6; i++) this._q[i] += b[i] * e
    }
    for (let i = 0; i < 6; i++) this.q[i] = this._q[i]
    this.noodle.applyPlan(plan, t, playing)
  }

  /** End the active task: `cancel` resolves it immediately (a paused task replaced by a new one). */
  _finish(cancel) {
    const done = this.cur
    if (!done) return
    if (!cancel) {
      done.plan.spline(done.plan.duration, this._q)
      this.q = this._q.slice()
      this.noodle.applyPlan(done.plan, done.plan.duration, false)
    }
    this.last = { plan: done.plan, blend: done.blend }
    this.cur = null
    this.paused = false
    this.scrubTo = null
    this.qv.fill(0)
    this._apply()
    done.resolve()
  }

  _start(job) {
    const plan = job.plan
    const h = plan.knots[0].q
    let blend = this.q.map((v, i) => v - h[i])
    if (blend.every((v) => Math.abs(v) < 0.01)) blend = null
    this.cur = { plan, resolve: job.resolve, auto: !!job.auto, blend }
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
