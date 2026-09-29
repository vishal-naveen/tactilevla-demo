// Noodle (foam tube) and the yellow scalloped cup. (The table lives in ground.js.)
import * as THREE from 'three'
import { NOODLE, CUP, TABLE_Y, cellCenter, noodleYaw } from './layout.js'
import { fallPose } from './tasks.js'

function foamBump() {
  const c = document.createElement('canvas')
  c.width = c.height = 128
  const g = c.getContext('2d')
  const img = g.createImageData(128, 128)
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 128 + (Math.random() - 0.5) * 120
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v
    img.data[i + 3] = 255
  }
  g.putImageData(img, 0, 0)
  const t = new THREE.CanvasTexture(c)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.repeat.set(3, 3)
  return t
}

export function buildNoodleMesh() {
  const s = new THREE.Shape()
  s.absarc(0, 0, NOODLE.r, 0, Math.PI * 2, false)
  const hole = new THREE.Path()
  hole.absarc(0, 0, NOODLE.hole, 0, Math.PI * 2, true)
  s.holes.push(hole)
  const geo = new THREE.ExtrudeGeometry(s, {
    depth: NOODLE.len - 0.0024, curveSegments: 40, bevelEnabled: true,
    bevelThickness: 0.0012, bevelSize: 0.0012, bevelSegments: 2,
  })
  geo.translate(0, 0, -(NOODLE.len - 0.0024) / 2)
  geo.rotateY(Math.PI / 2) // tube axis -> local X
  geo.computeVertexNormals()
  const bump = foamBump()
  const mat = new THREE.MeshPhysicalMaterial({
    color: 0xf4c430, roughness: 0.86, metalness: 0, specularIntensity: 0.35, bumpMap: bump, bumpScale: 0.35,
    emissive: new THREE.Color(0xf4c430), emissiveIntensity: 0.05,
  })
  const mesh = new THREE.Mesh(geo, mat)
  mesh.castShadow = true
  mesh.receiveShadow = true
  return mesh
}

export function buildCupMesh() {
  const N = 160
  const prof = []
  const h = CUP.h
  const th = CUP.wall
  const outer = (t) => new THREE.Vector2(CUP.baseR + (CUP.rimR - CUP.baseR) * Math.pow(t, 0.75), h * t)
  // inner bottom centre -> inner wall up -> rim -> outer wall down -> outer bottom centre
  prof.push(new THREE.Vector2(0, th))
  prof.push(new THREE.Vector2(CUP.baseR - th * 2, th))
  for (let i = 0; i <= 14; i++) {
    const t = i / 14
    const p = outer(t)
    prof.push(new THREE.Vector2(p.x - th * (1.2 - 0.2 * t), p.y + th * 0.4))
  }
  for (let i = 0; i <= 3; i++) { // rounded rim
    const a = (i / 3) * Math.PI
    const c = outer(1)
    prof.push(new THREE.Vector2(c.x - th * 0.6 + Math.cos(Math.PI - a) * th * -0.6, c.y + Math.sin(a) * th * 0.8))
  }
  for (let i = 14; i >= 0; i--) {
    const t = i / 14
    prof.push(outer(t))
  }
  prof.push(new THREE.Vector2(0, 0))
  const geo = new THREE.LatheGeometry(prof, N)
  const pos = geo.attributes.position
  const P = prof.length
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i)
    const r = Math.hypot(x, z)
    if (r < 1e-6) continue
    const th2 = Math.atan2(z, x)
    const t = Math.min(1, Math.max(0, y / h))
    const amp = 0.09 * Math.pow(t, 1.3) + 0.012
    const k = 1 + amp * Math.cos(8 * th2)
    pos.setXYZ(i, x * k, y, z * k)
  }
  geo.computeVertexNormals()
  // fix seam normals (lathe duplicates the first/last column)
  const n = geo.attributes.normal
  for (let j = 0; j < P; j++) {
    const a = j, b = N * P + j
    const nx = n.getX(a) + n.getX(b), ny = n.getY(a) + n.getY(b), nz = n.getZ(a) + n.getZ(b)
    const l = Math.hypot(nx, ny, nz) || 1
    n.setXYZ(a, nx / l, ny / l, nz / l)
    n.setXYZ(b, nx / l, ny / l, nz / l)
  }
  const mat = new THREE.MeshPhysicalMaterial({
    color: 0xf3d020, roughness: 0.42, metalness: 0, clearcoat: 0.45, clearcoatRoughness: 0.35, specularIntensity: 0.6,
    side: THREE.DoubleSide,
  })
  const mesh = new THREE.Mesh(geo, mat)
  mesh.castShadow = true
  mesh.receiveShadow = true
  mesh.position.set(CUP.x, TABLE_Y, CUP.z)
  return mesh
}

const smooth = (t) => t * t * (3 - 2 * t)

/** The noodle with a tiny state machine: table / held / falling / cup / hidden. */
export class Noodle {
  constructor(scene, tcp) {
    this.scene = scene
    this.tcp = tcp
    this.mesh = buildNoodleMesh()
    this.mesh.visible = false
    scene.add(this.mesh)
    this.state = 'hidden'
    this.cell = null
    this.scaleT = 1 // 0..1 pop-in
    this.scaleDir = 0
    this.vel = new THREE.Vector3()
    this.spin = new THREE.Quaternion()
    this.cupBottomY = TABLE_Y + CUP.wall + NOODLE.r
    this._q = new THREE.Quaternion()
    this._v = new THREE.Vector3()
    this.bounces = 0
    this.ghost = new THREE.Mesh(this.mesh.geometry, this.mesh.material)
    this.ghost.castShadow = true
    this.ghost.visible = false
    this.ghostT = 0
    scene.add(this.ghost)
  }

  /** Pop the noodle in at a cell on the table. */
  spawnAt(cell, animate = true) {
    if (this.state === 'cup' && animate) { // the previous noodle shrinks away out of the cup
      this.ghost.position.copy(this.mesh.position)
      this.ghost.quaternion.copy(this.mesh.quaternion)
      this.ghost.visible = true
      this.ghostT = 1
    }
    this.scene.attach(this.mesh)
    this.mesh.visible = true
    const c = cellCenter(cell)
    this.mesh.position.set(c.x, TABLE_Y + NOODLE.r, c.z)
    this.mesh.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -noodleYaw(cell))
    this.state = 'table'
    this.cell = cell
    this.scaleT = animate ? 0 : 1
    this.scaleDir = animate ? 1 : 0
    this.mesh.scale.setScalar(animate ? 0.001 : 1)
  }

  /** Attach to the gripper at its current world transform (called at the grasp instant). */
  grab() {
    this.tcp.attach(this.mesh)
    this.state = 'held'
  }

  /** Place the noodle directly in the gripper using a precomputed tcp-frame transform. */
  holdLocal(local) {
    this.tcp.add(this.mesh)
    this.mesh.position.copy(local.p)
    this.mesh.quaternion.copy(local.q)
    this.mesh.visible = true
    this.state = 'held'
    this.cell = null
    this.scaleT = 0
    this.scaleDir = 1
    this.mesh.scale.setScalar(0.001)
  }

  /**
   * A new task is starting: the previous noodle (sitting in the cup) shrinks away, and the pose is then owned by
   * applyPlan() every frame.
   */
  beginTask(plan) {
    if (this.state === 'cup' && this.mesh.visible) {
      this.ghost.position.copy(this.mesh.position)
      this.ghost.quaternion.copy(this.mesh.quaternion)
      this.ghost.visible = true
      this.ghostT = 1
    }
    this.cell = plan.cell
  }

  /**
   * The noodle at task time t, as a pure function of the plan: on the table until the jaws close, carried in the gripper
   * until they open, then the closed-form drop into the cup. Scrubbing forwards or backwards is therefore always
   * consistent. `popIn` grows it from nothing over the first 0.4 s (live playback only).
   */
  applyPlan(plan, t, popIn = false) {
    const m = this.mesh
    m.visible = true
    this.scaleDir = 0
    this.cell = plan.cell
    if (t < plan.grabT) {
      if (m.parent !== this.scene) this.scene.add(m)
      m.position.copy(plan.tablePose.p)
      m.quaternion.copy(plan.tablePose.q)
      m.scale.setScalar(popIn ? Math.max(0.001, smooth(Math.min(1, t / 0.4))) : 1)
      this.state = 'table'
    } else if (t < plan.releaseT) {
      if (m.parent !== this.tcp) this.tcp.add(m)
      m.position.copy(plan.heldLocal.p)
      m.quaternion.copy(plan.heldLocal.q)
      m.scale.setScalar(1)
      this.state = 'held'
    } else {
      if (m.parent !== this.scene) this.scene.add(m)
      const tau = t - plan.releaseT
      fallPose(plan.fall, tau, m.position, m.quaternion)
      m.scale.setScalar(1)
      this.state = tau >= plan.fall.end ? 'cup' : 'falling'
    }
  }

  hide(animate = true) {
    if (this.state === 'hidden') return
    if (animate) { this.scaleDir = -1; this.scaleT = Math.min(this.scaleT, 1) } else { this.mesh.visible = false; this.state = 'hidden' }
  }

  update(dt) {
    const m = this.mesh
    if (this.ghost.visible) {
      this.ghostT = Math.max(0, this.ghostT - dt / 0.45)
      this.ghost.scale.setScalar(Math.max(0.001, smooth(this.ghostT)))
      if (this.ghostT <= 0) this.ghost.visible = false
    }
    if (this.scaleDir !== 0) {
      this.scaleT = THREE.MathUtils.clamp(this.scaleT + this.scaleDir * dt / 0.4, 0, 1)
      const s = Math.max(0.001, smooth(this.scaleT))
      m.scale.setScalar(this.state === 'hidden' ? 1 : s)
      if (this.scaleDir > 0 && this.scaleT >= 1) this.scaleDir = 0
      if (this.scaleDir < 0 && this.scaleT <= 0) { this.scaleDir = 0; m.visible = false; this.state = 'hidden'; this.scene.attach(m) }
    }
  }
}
