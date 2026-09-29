// World-space point clouds that must stay inside the safe area for each chapter (arm through its whole motion,
// grid, cup, frustums...). Built once from the solved plans; consumed by framing.fitShot.
import * as THREE from 'three'
import { JOINT_NAMES } from './robot.js'
import { CELLS } from './protocol.js'
import { GRID, CUP, NOODLE, cellCenter } from './layout.js'
import { overheadCorners } from './frustums.js'

const BODY_PAD = 0.04 // links are ~8 cm thick around the joint origins

export function buildSubjects({ rig, plans, loops, poses, explode }) {
  const robot = rig.robot
  const saved = JOINT_NAMES.map((n) => rig.joints[n].angle)
  const q = new Array(6).fill(0)
  const V = new THREE.Vector3()
  const dirs = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]

  const armPoints = (out, pad = BODY_PAD) => {
    robot.updateMatrixWorld(true)
    const pts = [...Object.values(robot.joints).map((j) => V.clone().setFromMatrixPosition(j.matrixWorld))]
    pts.push(V.clone().setFromMatrixPosition(rig.tcp.matrixWorld))
    for (const p of pts) for (const d of dirs) out.push(p.x + d[0] * pad, p.y + d[1] * pad, p.z + d[2] * pad)
  }
  const setPose = (qq) => JOINT_NAMES.forEach((n, i) => rig.joints[n].setJointValue(qq[i]))

  const scene = () => { // grid footprint + cup: always in view
    const out = []
    const x0 = GRID.x0, x1 = GRID.x0 + 3 * GRID.d, z = 1.5 * GRID.w
    for (const [x, zz] of [[x0, z], [x0, -z], [x1, z], [x1, -z]]) out.push(x, 0, zz)
    const r = CUP.rimR + 0.012
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2
      out.push(CUP.x + Math.cos(a) * r, CUP.h, CUP.z + Math.sin(a) * r)
    }
    out.push(CUP.x, 0, CUP.z)
    return out
  }

  const loopPoints = (cells) => {
    const out = scene()
    for (const c of cells) {
      const p = plans[c]
      for (let t = 0; t <= p.duration + 1e-6; t += 0.2) {
        p.spline(Math.min(t, p.duration), q)
        setPose(q)
        armPoints(out)
        if (t > p.grabT && t < p.releaseT) { // the held noodle rides ahead of the tcp
          V.setFromMatrixPosition(rig.tcp.matrixWorld)
          out.push(V.x, V.y + NOODLE.r + 0.01, V.z)
        }
      }
    }
    return out
  }
  const posePoints = (qq, extra = []) => {
    const out = scene()
    setPose(qq)
    armPoints(out)
    for (const p of extra) out.push(...p)
    return out
  }

  const subjects = {}
  for (const [name, cells] of Object.entries(loops)) subjects['loop:' + name] = new Float32Array(loopPoints([...new Set(cells)]))
  { // sandbox: the grid and cup dominate; the arm only needs its base and the hovering gripper in frame
    const out = scene()
    out.push(0.04, 0.02, 0.06, 0.04, 0.02, -0.06, 0.04, 0.12, 0.0, 0.16, 0.16, 0.0)
    subjects.play = new Float32Array(out)
  }
  subjects.home = new Float32Array(posePoints(poses.home, [[...cellCenter('B2').toArray()]]))
  subjects.exploded = new Float32Array((() => {
    setPose(poses.home)
    const out = []
    for (const side of [-1, 1]) { explode(1, side); armPoints(out, 0.09) } // pad covers the joint labels
    explode(0, -1)
    for (let i = 0; i < out.length; i += 3) out[i + 2] += 0 // (labels sit toward the camera: covered by the pad)
    return out
  })())
  const rest = posePoints(poses.rest)
  for (const c of CELLS) { // ghost arcs climb ~20 cm between the cells and the cup
    const p = cellCenter(c)
    rest.push((p.x + CUP.x) / 2, 0.22, (p.z + CUP.z) / 2)
  }
  subjects.rest = new Float32Array(rest)
  subjects.sees = new Float32Array(posePoints(poses.sees, overheadCorners()))
  subjects.touch = new Float32Array(posePoints(poses.touch, [[CUP.x, 0.03, CUP.z]]))

  setPose(saved)
  robot.updateMatrixWorld(true)
  return subjects
}
