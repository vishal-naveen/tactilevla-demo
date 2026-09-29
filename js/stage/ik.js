// Damped-least-squares IK over shoulder_pan / lift / elbow / wrist_flex with a numeric Jacobian.
// TCP = the grasp point between the jaws (rig.tcp, see grasp.js); approach axis = tcp +Z (points from the wrist towards the jaw tips).
import * as THREE from 'three'
import { JOINT_NAMES } from './robot.js'

const DOWN = new THREE.Vector3(0, -1, 0)
const _v = new THREE.Vector3()
const _a = new THREE.Vector3()
const _rad = new THREE.Vector3()

// 4x4 symmetric solve via Gaussian elimination (small, allocation-light enough for offline use)
function solve4(A, b) {
  const n = 4
  const M = A.map((r, i) => [...r, b[i]])
  for (let i = 0; i < n; i++) {
    let p = i
    for (let r = i + 1; r < n; r++) if (Math.abs(M[r][i]) > Math.abs(M[p][i])) p = r
    ;[M[i], M[p]] = [M[p], M[i]]
    const d = M[i][i] || 1e-12
    for (let r = i + 1; r < n; r++) {
      const f = M[r][i] / d
      for (let c = i; c <= n; c++) M[r][c] -= f * M[i][c]
    }
  }
  const x = [0, 0, 0, 0]
  for (let i = n - 1; i >= 0; i--) {
    let s = M[i][n]
    for (let c = i + 1; c < n; c++) s -= M[i][c] * x[c]
    x[i] = s / (M[i][i] || 1e-12)
  }
  return x
}

export function makeIK(rig) {
  const { joints, tcp, robot, limits } = rig
  const lo = JOINT_NAMES.map((n) => limits[n][0])
  const hi = JOINT_NAMES.map((n) => limits[n][1])
  // keep clear of hard stops so poses look natural
  const margin = 0.06

  const saved = () => JOINT_NAMES.map((n) => joints[n].angle)
  const restore = (q) => JOINT_NAMES.forEach((n, i) => joints[n].setJointValue(q[i]))

  // Pose of the TCP for q = [pan, lift, elbow, wflex, roll]. Pure matrix chain (no scene-graph traversal, no side effects
  // on the rig): base * (origin_i * rot(axis_i, q_i)) ... * tcp. About 10x cheaper than updating the whole arm's meshes.
  robot.updateMatrixWorld(true)
  const ONE = new THREE.Vector3(1, 1, 1)
  const chain = JOINT_NAMES.slice(0, 5).map((n) => ({
    O: new THREE.Matrix4().compose(joints[n].origPosition, joints[n].origQuaternion, ONE),
    ax: joints[n].axis.clone(),
  }))
  const baseM = new THREE.Matrix4().copy(joints.shoulder_pan.parent.matrixWorld)
  const tcpM = new THREE.Matrix4().compose(tcp.position, tcp.quaternion, ONE)
  const _M = new THREE.Matrix4(), _R = new THREE.Matrix4()
  function fk(q, out = {}) {
    _M.copy(baseM)
    for (let i = 0; i < 5; i++) _M.multiply(chain[i].O).multiply(_R.makeRotationAxis(chain[i].ax, q[i]))
    _M.multiply(tcpM)
    const e = _M.elements
    out.p = (out.p || new THREE.Vector3()).set(e[12], e[13], e[14])
    out.a = (out.a || new THREE.Vector3()).set(e[8], e[9], e[10]) // tcp +z (approach axis)
    out.j = (out.j || new THREE.Vector3()).set(-e[0], -e[1], -e[2]) // jaw side (-x)
    return out
  }

  // pan sign: which way does +pan swing the TCP in world z?
  const base = saved()
  const panOrigin = new THREE.Vector3().setFromMatrixPosition(joints.shoulder_pan.matrixWorld)
  fk([0, 0.4, 0.8, 0.4, 0])
  const p0 = fk([0.2, 0.4, 0.8, 0.4, 0]).p.clone()
  const panSign = p0.z > 0 ? 1 : -1
  restore(base)

  const cur = { p: new THREE.Vector3(), a: new THREE.Vector3(), j: new THREE.Vector3() }
  const cur2 = { p: new THREE.Vector3(), a: new THREE.Vector3(), j: new THREE.Vector3() }

  function iterate(q, target, w, roll, maxIter, lambda0) {
    let lambda = lambda0
    let best = Infinity
    for (let it = 0; it < maxIter; it++) {
      const qq = [q[0], q[1], q[2], q[3], roll]
      fk(qq, cur)
      const ep = _v.copy(target).sub(cur.p)
      const ea = _a.copy(DOWN).sub(cur.a).multiplyScalar(w)
      const e = [ep.x, ep.y, ep.z, ea.x, ea.y, ea.z]
      const err = Math.hypot(...e)
      if (ep.length() < 4e-4 && cur.a.angleTo(DOWN) < 0.02 + (w < 0.3 ? 0.3 : 0)) break
      if (err > best) lambda = Math.min(0.3, lambda * 1.5)
      else lambda = Math.max(lambda0, lambda * 0.8)
      best = Math.min(best, err)
      // numeric Jacobian (6x4)
      const J = [[], [], [], [], [], []]
      const d = 1e-4
      const p0v = cur.p.clone()
      const a0v = cur.a.clone()
      for (let k = 0; k < 4; k++) {
        const q2 = qq.slice()
        q2[k] += d
        fk(q2, cur2)
        J[0][k] = (cur2.p.x - p0v.x) / d
        J[1][k] = (cur2.p.y - p0v.y) / d
        J[2][k] = (cur2.p.z - p0v.z) / d
        J[3][k] = (w * (cur2.a.x - a0v.x)) / d
        J[4][k] = (w * (cur2.a.y - a0v.y)) / d
        J[5][k] = (w * (cur2.a.z - a0v.z)) / d
      }
      // (JtJ + l^2 I) dq = Jt e ... e is (target - current), J is d(current)/dq with orientation sign folded in
      // orientation error was DOWN - a; d(a)/dq enters with a minus sign relative to the position rows
      for (let k = 0; k < 4; k++) { J[3][k] *= -1; J[4][k] *= -1; J[5][k] *= -1 }
      const A = [[], [], [], []]
      const b = [0, 0, 0, 0]
      for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 4; c++) {
          let s = 0
          for (let k = 0; k < 6; k++) s += J[k][r] * J[k][c]
          A[r][c] = s + (r === c ? lambda * lambda : 0)
        }
        for (let k = 0; k < 6; k++) b[r] += J[k][r] * e[k]
      }
      const dq = solve4(A, b)
      for (let k = 0; k < 4; k++) {
        const step = THREE.MathUtils.clamp(dq[k], -0.2, 0.2)
        q[k] = THREE.MathUtils.clamp(q[k] + step, lo[k] + margin, hi[k] - margin)
      }
    }
    return q
  }

  function evaluate(q, target, roll) {
    fk([q[0], q[1], q[2], q[3], roll], cur)
    return { posErr: cur.p.distanceTo(target), tilt: cur.a.angleTo(DOWN) }
  }

  /**
   * Solve for a TCP target. Returns { q:[pan,lift,elbow,wflex], posErr, tilt } or null.
   * opts: roll (default 0), seed (q4), tiltPriority: array of weights tried in order.
   */
  function solve(target, opts = {}) {
    const roll = opts.roll ?? 0
    const weights = opts.weights ?? [0.35, 0.12, 0.05, 0.02]
    const maxTilt = opts.maxTilt ?? 0.3
    const saveQ = saved()
    const dx = target.x - panOrigin.x
    const dz = target.z - panOrigin.z
    const pan0 = panSign * Math.atan2(dz, dx)
    const seeds = []
    if (opts.seed) seeds.push(opts.seed.slice(0, 4))
    seeds.push([pan0, 0.6, 1.0, 0.7], [pan0, 0.2, 1.3, 0.9], [pan0, 0.9, 0.6, 0.4], [pan0, -0.2, 0.9, 1.2])
    let best = null
    for (const w of weights) {
      for (const s of seeds) {
        const q = iterate(s.slice(), target, w, roll, 140, 0.03)
        const r = evaluate(q, target, roll)
        const ok = r.posErr < 1.5e-3 && r.tilt <= maxTilt
        const dist = opts.seed ? q.reduce((acc, v, i) => acc + Math.abs(v - opts.seed[i]), 0) : 0
        const score = (ok ? 0 : 100) + r.posErr * 400 + r.tilt * 2 + dist * 0.15
        if (!best || score < best.score) best = { q, ...r, score, ok }
        if (opts.fast && ok && r.tilt < 0.12) break // live planning: the first good solution is good enough
      }
      if (best && best.ok && best.tilt < 0.12) break
    }
    restore(saveQ)
    return best
  }

  /** Roll that puts the jaw-closing axis (horizontal part) perpendicular to `axisDir` (a horizontal Vec3). */
  function rollForAxis(q4, axisDir, prefer = 0, jawInward = true) {
    const saveQ = saved()
    const n = new THREE.Vector3(axisDir.x, 0, axisDir.z).normalize()
    let bestR = 0
    let bestScore = Infinity
    for (let r = -2.6; r <= 2.6; r += 0.02) {
      fk([...q4, r], cur)
      _v.copy(cur.j).setY(0)
      if (_v.lengthSq() < 1e-6) continue
      _v.normalize()
      let score = Math.abs(_v.dot(n)) + 0.02 * Math.abs(r - prefer)
      if (jawInward) { // moving jaw on the arm's side: puts the wrist farther out, which is easier to reach
        _rad.set(cur.p.x - panOrigin.x, 0, cur.p.z - panOrigin.z).normalize()
        score += 0.6 * Math.max(0, _v.dot(_rad))
      }
      if (score < bestScore) { bestScore = score; bestR = r }
    }
    restore(saveQ)
    return bestR
  }

  return { rig, solve, fk, rollForAxis, panOrigin, panSign, evaluate, limits: { lo, hi } }
}
