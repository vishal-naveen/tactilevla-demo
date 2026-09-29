// Minimal URDF -> three.js builder (revolute + fixed joints, mesh visuals). Same shape as urdf-loader's output
// (robot.links / robot.joints / joint.setJointValue / .angle / .limit) without its bare `three/examples/...`
// imports, so the page's importmap only needs `three` and `three/addons/`.
import * as THREE from 'three'

const tuple = (s, n = 3) => (s ? s.trim().split(/\s+/).map(Number) : new Array(n).fill(0))

function applyOrigin(obj, node) {
  const o = node?.querySelector(':scope > origin')
  if (!o) return
  const xyz = tuple(o.getAttribute('xyz'))
  const rpy = tuple(o.getAttribute('rpy'))
  obj.position.set(xyz[0], xyz[1], xyz[2])
  obj.quaternion.setFromEuler(new THREE.Euler(rpy[0], rpy[1], rpy[2], 'ZYX'))
}

class Joint extends THREE.Object3D {
  constructor(name, type) {
    super()
    this.name = name
    this.jointType = type
    this.isURDFJoint = true
    this.axis = new THREE.Vector3(0, 0, 1)
    this.limit = { lower: 0, upper: 0 }
    this.angle = 0
    this.origPosition = null
    this.origQuaternion = null
  }

  setJointValue(v) {
    if (this.jointType === 'fixed') return
    const a = Number.isFinite(v) ? v : 0
    this.angle = a
    this.position.copy(this.origPosition)
    this.quaternion.setFromAxisAngle(this.axis, a).premultiply(this.origQuaternion)
    this.matrixWorldNeedsUpdate = true
  }
}

/**
 * @param {string} xmlText
 * @param {(file:string, done:(mesh:THREE.Object3D)=>void)=>void} loadMesh
 */
export function buildURDF(xmlText, loadMesh) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml')
  if (doc.querySelector('parsererror')) throw new Error('URDF parse error')
  const robotNode = doc.querySelector('robot')
  const robot = new THREE.Object3D()
  robot.name = robotNode.getAttribute('name') || 'robot'
  robot.links = {}
  robot.joints = {}

  for (const ln of robotNode.querySelectorAll(':scope > link')) {
    const link = new THREE.Object3D()
    link.name = ln.getAttribute('name')
    link.isURDFLink = true
    robot.links[link.name] = link
    for (const vn of ln.querySelectorAll(':scope > visual')) {
      const visual = new THREE.Group()
      visual.isURDFVisual = true
      applyOrigin(visual, vn)
      const mesh = vn.querySelector('geometry > mesh')
      if (mesh) loadMesh(mesh.getAttribute('filename'), (m) => { if (m) visual.add(m) })
      link.add(visual)
    }
  }

  const children = new Set()
  for (const jn of robotNode.querySelectorAll(':scope > joint')) {
    const type = jn.getAttribute('type')
    const joint = new Joint(jn.getAttribute('name'), type === 'fixed' ? 'fixed' : 'revolute')
    applyOrigin(joint, jn)
    joint.origPosition = joint.position.clone()
    joint.origQuaternion = joint.quaternion.clone()
    const ax = jn.querySelector(':scope > axis')
    if (ax) joint.axis.fromArray(tuple(ax.getAttribute('xyz'))).normalize()
    const lim = jn.querySelector(':scope > limit')
    if (lim) joint.limit = { lower: Number(lim.getAttribute('lower')) || 0, upper: Number(lim.getAttribute('upper')) || 0 }
    const parent = robot.links[jn.querySelector(':scope > parent').getAttribute('link')]
    const child = robot.links[jn.querySelector(':scope > child').getAttribute('link')]
    if (!parent || !child) throw new Error(`URDF joint ${joint.name} references a missing link`)
    parent.add(joint)
    joint.add(child)
    children.add(child.name)
    robot.joints[joint.name] = joint
  }

  const rootLink = Object.values(robot.links).find((l) => !children.has(l.name))
  robot.add(rootLink)
  return robot
}
