// True grasp geometry, measured from the (decimated) meshes rather than assumed.
// gripper_frame_link sits ON the fixed jaw's inner face at the tips, so a tube "at the TCP" floated half inside the
// fixed jaw. Here we find the point BETWEEN the jaws and the jaw angle that closes on a tube of radius r.
//
// In gripper_link space: jaws point along -z (tips at z ~ -0.105), the moving jaw pivots about the y axis, so the jaws
// close along x. The tube axis is therefore gripper-y (parallel to the pivot), and the jaws squeeze across its diameter.
import * as THREE from 'three'

const Y_BAND = 0.012 // only the middle of the jaw width (pads), ignoring edges and screws
const Z_HALF = 0.006 // band along the jaw length used to read the inner faces
const SQUEEZE = 0.0018 // foam: the moving jaw closes this much deeper than first contact

/**
 * @param {object} rig loaded robot (needs robot.links, joints.gripper, meshes with userData.file)
 * @param {number} r tube outer radius
 * @param {number} zc position along the jaw (negative, gripper space) where the tube centre should sit. It is set by
 *   table clearance: the jaw tips extend below the tube centre, so the centre must stay high enough for them to clear.
 * @returns {{local:number[], theta:number, faceFixed:number, gap:number}}
 */
export function computeGrasp(rig, r, zc = -0.0895) {
  const g = rig.robot.links.gripper_link
  const jawLink = rig.robot.links.moving_jaw_so101_v1_link
  const find = (link, file) => { let m = null; link.traverse((o) => { if (o.isMesh && o.userData.file === file) m = o }); return m }
  const fixedMesh = find(g, 'wrist_roll_follower_so101_v1.stl')
  const jawMesh = find(jawLink, 'moving_jaw_so101_v1.stl')
  if (!fixedMesh || !jawMesh) throw new Error('grasp: jaw meshes not found')

  const saved = rig.joints.gripper.angle
  rig.robot.updateMatrixWorld(true)
  const inv = new THREE.Matrix4().copy(g.matrixWorld).invert()
  const v = new THREE.Vector3()
  const gather = (mesh, m4) => {
    const pos = mesh.geometry.attributes.position
    const out = []
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m4)
      if (Math.abs(v.y) < Y_BAND) out.push(v.x, v.y, v.z)
    }
    return out
  }

  // fixed jaw inner face at the grasp height: the largest x of the jaw plate (x < 0 side) inside the z band
  const fixedPts = gather(fixedMesh, new THREE.Matrix4().multiplyMatrices(inv, fixedMesh.matrixWorld))
  let xf = -Infinity
  for (let i = 0; i < fixedPts.length; i += 3) {
    const z = fixedPts[i + 2]
    if (Math.abs(z - zc) < Z_HALF && fixedPts[i] < 0.0) xf = Math.max(xf, fixedPts[i])
  }
  if (!Number.isFinite(xf)) throw new Error('grasp: no fixed-jaw geometry at the grasp height')

  const xc = xf + r // tube centre touches the fixed face
  const want = xc + r - SQUEEZE // where the moving jaw's inner face must sit

  // moving jaw: local vertices once, then rotate by the joint angle (jaw link frame -> gripper frame changes with theta)
  const jawLocal = []
  { const pos = jawMesh.geometry.attributes.position; for (let i = 0; i < pos.count; i++) jawLocal.push(pos.getX(i), pos.getY(i), pos.getZ(i)) }
  const inJaw = new THREE.Matrix4()
  const minX = (theta) => {
    rig.joints.gripper.setJointValue(theta)
    rig.robot.updateMatrixWorld(true)
    inJaw.multiplyMatrices(new THREE.Matrix4().copy(g.matrixWorld).invert(), jawMesh.matrixWorld)
    let m = Infinity
    for (let i = 0; i < jawLocal.length; i += 3) {
      v.set(jawLocal[i], jawLocal[i + 1], jawLocal[i + 2]).applyMatrix4(inJaw)
      if (Math.abs(v.y) < Y_BAND && Math.abs(v.z - zc) < Z_HALF && v.x < m) m = v.x
    }
    return m
  }
  const [lo0, hi0] = rig.limits.gripper
  let lo = lo0, hi = hi0
  for (let i = 0; i < 40; i++) { // minX grows with theta: bisect for the face position
    const mid = (lo + hi) / 2
    if (minX(mid) < want) lo = mid; else hi = mid
  }
  const theta = (lo + hi) / 2
  const gap = minX(theta) - xf
  rig.joints.gripper.setJointValue(saved)
  rig.robot.updateMatrixWorld(true)
  return { local: [xc, 0, zc], theta: Math.round(theta * 1e4) / 1e4, faceFixed: xf, gap }
}
