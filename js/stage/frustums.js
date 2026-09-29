// "Sees" chapter: overhead camera + wrist camera frustums as glowing wireframes, and the occlusion wedge.
import * as THREE from 'three'
import { GRID_CENTER } from './layout.js'
import { PAL, mixL, isLightPal } from './palette.js'

const OVERHEAD = { pos: new THREE.Vector3(GRID_CENTER.x, 0.5, 0.05), halfW: 0.3, halfH: 0.225 } // 4:3 footprint
const PALE = new THREE.Color(0x8ff0d6)
const YEL = new THREE.Color(0xf4c430)
const RED = new THREE.Color(0xf08a24)

/** Apex and footprint corners of the overhead camera (for framing). */
export function overheadCorners() {
  const A = OVERHEAD.pos
  return [
    [A.x, A.y + 0.06, A.z],
    [A.x - OVERHEAD.halfH, 0, A.z + OVERHEAD.halfW], [A.x - OVERHEAD.halfH, 0, A.z - OVERHEAD.halfW],
    [A.x + OVERHEAD.halfH, 0, A.z - OVERHEAD.halfW], [A.x + OVERHEAD.halfH, 0, A.z + OVERHEAD.halfW],
  ]
}

function lines(points, color, gain) {
  const g = new THREE.BufferGeometry().setFromPoints(points)
  const m = new THREE.LineBasicMaterial({ color: color.clone().multiplyScalar(gain), transparent: true, opacity: 0, depthWrite: false, toneMapped: false })
  const l = new THREE.LineSegments(g, m)
  l.frustumCulled = false
  return l
}

function frustumSegments(apex, corners, ring = true) {
  const p = []
  corners.forEach((c) => p.push(apex.clone(), c.clone()))
  if (ring) corners.forEach((c, i) => p.push(c.clone(), corners[(i + 1) % 4].clone()))
  return p
}

function volume(apex, corners, color, gain, side = THREE.BackSide) {
  const pos = [], col = []
  const c = color.clone().multiplyScalar(gain)
  for (let i = 0; i < 4; i++) {
    const a = corners[i], b = corners[(i + 1) % 4]
    pos.push(apex.x, apex.y, apex.z, a.x, a.y, a.z, b.x, b.y, b.z)
    col.push(0, 0, 0, c.r, c.g, c.b, c.r, c.g, c.b)
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
  const m = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side, toneMapped: false })
  return new THREE.Mesh(g, m)
}

export function createFrustums(scene, rig) {
  const group = new THREE.Group()
  group.visible = false
  scene.add(group)
  const mats = []
  const add = (o) => { group.add(o); mats.push(o.material); return o }

  // overhead camera
  const A = OVERHEAD.pos
  const gy = 0.001
  // image up = -x (toward the arm), right = -z
  const corners = [
    new THREE.Vector3(A.x - OVERHEAD.halfH, gy, A.z + OVERHEAD.halfW),
    new THREE.Vector3(A.x - OVERHEAD.halfH, gy, A.z - OVERHEAD.halfW),
    new THREE.Vector3(A.x + OVERHEAD.halfH, gy, A.z - OVERHEAD.halfW),
    new THREE.Vector3(A.x + OVERHEAD.halfH, gy, A.z + OVERHEAD.halfW),
  ]
  const ohLines = add(lines(frustumSegments(A, corners), PALE, 3.0))
  const ohVol = add(volume(A, corners, PALE, 0.07))
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(0.075, 0.04, 0.05),
    new THREE.MeshStandardMaterial({ color: 0x1b1d1f, roughness: 0.4, metalness: 0.3 }),
  )
  body.position.copy(A).add(new THREE.Vector3(0, 0.03, 0))
  body.castShadow = false
  group.add(body)
  const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.017, 0.02, 20), new THREE.MeshBasicMaterial({ color: PALE.clone().multiplyScalar(2.4), transparent: true, opacity: 0, toneMapped: false }))
  lens.position.copy(A).add(new THREE.Vector3(0, 0.002, 0))
  group.add(lens)
  mats.push(lens.material)
  // stand
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, A.y, 8), new THREE.MeshStandardMaterial({ color: 0x0f1112, roughness: 0.5 }))
  post.position.set(A.x, A.y / 2 + 0.05, A.z)
  post.visible = false // keep the frame clean; the box reads as a camera floating over the set
  group.add(post)

  // wrist camera (child of gripper_link so it follows the pose)
  const wrist = new THREE.Group()
  rig.robot.links.gripper_link.add(wrist)
  wrist.position.set(-0.021, 0.0, -0.048)
  const far = 0.15
  const hw = Math.tan(THREE.MathUtils.degToRad(35)) * far
  const hh = hw * 0.75
  const ap = new THREE.Vector3(0, 0, 0)
  const wc = [new THREE.Vector3(-hw, hh, far), new THREE.Vector3(hw, hh, far), new THREE.Vector3(hw, -hh, far), new THREE.Vector3(-hw, -hh, far)]
  const wl = lines(frustumSegments(ap, wc), YEL, 3.2)
  const wv = volume(ap, wc, YEL, 0.16)
  wrist.add(wl, wv)
  mats.push(wl.material, wv.material)
  wrist.rotation.y = Math.PI // frustum is built along +Z; gripper points along its own -Z
  const cam = new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.01, 0.012), new THREE.MeshBasicMaterial({ color: YEL.clone().multiplyScalar(2), transparent: true, opacity: 0, toneMapped: false }))
  wrist.add(cam)
  mats.push(cam.material)

  // occlusion wedge: shadow of a box around the gripper, cast from the overhead camera onto the table
  const wedgeGeo = new THREE.BufferGeometry()
  wedgeGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(8 * 3), 3))
  wedgeGeo.setIndex([0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7, 4, 5, 6, 4, 6, 7])
  const wedgeMat = new THREE.MeshBasicMaterial({ color: RED.clone().multiplyScalar(1.6), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false })
  const wedge = new THREE.Mesh(wedgeGeo, wedgeMat)
  wedge.frustumCulled = false
  group.add(wedge)
  mats.push(wedgeMat)
  const wedgeEdges = new THREE.LineSegments(new THREE.EdgesGeometry(wedgeGeo, 1), new THREE.LineBasicMaterial({ color: RED.clone().multiplyScalar(2.6), transparent: true, opacity: 0, toneMapped: false, depthWrite: false }))
  wedgeEdges.frustumCulled = false
  group.add(wedgeEdges)
  mats.push(wedgeEdges.material)

  const _c = new THREE.Vector3()
  const box = new THREE.Box3()
  function updateWedge(tcp) {
    _c.setFromMatrixPosition(tcp.matrixWorld)
    const h = 0.07
    const hx = 0.026, hz = 0.03
    const top = [
      [_c.x - hx, _c.z - hz], [_c.x + hx, _c.z - hz], [_c.x + hx, _c.z + hz], [_c.x - hx, _c.z + hz],
    ]
    const p = wedgeGeo.attributes.position
    top.forEach(([x, z], i) => {
      const y = _c.y + h
      p.setXYZ(i, x, y, z)
      const s = A.y / (A.y - y) // extend the ray from the camera through the corner down to y=0
      p.setXYZ(4 + i, A.x + (x - A.x) * s, 0.002, A.z + (z - A.z) * s)
    })
    p.needsUpdate = true
    wedgeGeo.computeBoundingSphere()
    wedgeEdges.geometry.dispose()
    wedgeEdges.geometry = new THREE.EdgesGeometry(wedgeGeo, 1)
  }

  // theme: recolour lines/volumes/markers from the live palette (glow gains in a dark studio, plain ink in a light one)
  let painted = -1
  const tmp = new THREE.Color()
  function paintVolume(mesh, color, gain) {
    const col = mesh.geometry.attributes.color
    tmp.copy(color).multiplyScalar(gain)
    for (let i = 0; i < col.count; i++) if (i % 3 !== 0) col.setXYZ(i, tmp.r, tmp.g, tmp.b) // apex vertex stays black
    col.needsUpdate = true
  }
  function repaint() {
    painted = PAL.stamp
    ohLines.material.color.copy(PAL.frustum).multiplyScalar(mixL(3.0, 1.0))
    wl.material.color.copy(PAL.accent).multiplyScalar(mixL(3.2, 1.0))
    paintVolume(ohVol, PAL.frustum, 0.07)
    paintVolume(wv, PAL.accent, 0.16)
    lens.material.color.copy(PAL.frustum).multiplyScalar(mixL(2.4, 1.0))
    cam.material.color.copy(PAL.accent).multiplyScalar(mixL(2.0, 1.0))
    wedgeMat.color.copy(PAL.held).multiplyScalar(mixL(1.6, 1.0))
    wedgeEdges.material.color.copy(PAL.held).multiplyScalar(mixL(2.6, 1.0))
  }
  let lightSeen = null
  return {
    group,
    update(weight, tcp) {
      group.visible = weight > 0.01
      wrist.visible = group.visible
      if (!group.visible) return
      if (painted !== PAL.stamp) repaint()
      const light = isLightPal()
      if (lightSeen !== light) {
        lightSeen = light
        wedgeMat.blending = light ? THREE.NormalBlending : THREE.AdditiveBlending
        wedgeMat.needsUpdate = true
        ohVol.visible = wv.visible = !light // translucent glow volumes only read on dark
      }
      for (const m of mats) m.opacity = weight * (m === wedgeMat ? mixL(0.17, 0.3) : 1)
      lens.material.opacity = weight
      wedgeEdges.material.opacity = weight * 0.9
      updateWedge(tcp)
    },
    dispose() {
      group.traverse((o) => { o.geometry?.dispose?.(); o.material?.dispose?.() })
      wrist.removeFromParent()
    },
  }
}
