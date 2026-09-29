// Protocol illustrations for the data chapter (not recorded positions):
//  - the recording path: a thin light that draws itself around the perimeter, round after round (reversals visible),
//  - the hold: faint tethers from the eight trained cells toward B2 that stop short, and an amber ring on B2.
import * as THREE from 'three'
import { PERIMETER, TOTAL_EPISODES, HELD_OUT } from './protocol.js'
import { cellCenter, TABLE_Y, GRID } from './layout.js'
import { PAL, mixL, isLightPal } from './palette.js'

const ROUNDS = 4
const SUB = 14 // vertices per hop, so the head advances smoothly
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t) }

export function createProtoViz(scene) {
  const group = new THREE.Group()
  group.visible = false
  scene.add(group)

  // ---- recording path: one continuous strip through the visit order of all four rounds ----
  const visits = []
  for (let r = 0; r < ROUNDS; r++) {
    const order = r % 2 === 1 ? [...PERIMETER].reverse() : PERIMETER
    order.forEach((c) => visits.push({ c, r }))
  }
  const pts = []
  const roundOf = [] // round index per vertex (colour is repainted on theme change)
  const cool = new THREE.Color()
  const warm = new THREE.Color()
  for (let i = 0; i < visits.length - 1; i++) {
    const a = cellCenter(visits[i].c), b = cellCenter(visits[i + 1].c)
    const round = visits[i].r
    const y = TABLE_Y + 0.004 + round * 0.0015
    const off = (round % 2 === 1 ? -1 : 1) * 0.0035 // reversed rounds run beside the forward ones
    for (let s = 0; s < SUB; s++) {
      const t = s / SUB
      const dx = b.x - a.x, dz = b.z - a.z
      const len = Math.hypot(dx, dz) || 1
      pts.push(a.x + dx * t - (dz / len) * off, y, a.z + dz * t + (dx / len) * off)
      roundOf.push(round)
    }
  }
  const last = cellCenter(visits[visits.length - 1].c)
  pts.push(last.x, TABLE_Y + 0.004 + (ROUNDS - 1) * 0.0015, last.z)
  roundOf.push(ROUNDS - 1)
  const cols = new Float32Array(roundOf.length * 3)
  const pathGeo = new THREE.BufferGeometry()
  pathGeo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
  pathGeo.setAttribute('color', new THREE.BufferAttribute(cols, 3))
  const pathMat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false })
  const pathLine = new THREE.Line(pathGeo, pathMat) // the whole trail so far, faint
  pathLine.frustumCulled = false
  pathLine.renderOrder = 5
  group.add(pathLine)
  const tailMat = pathMat.clone() // the most recent round, bright: reads as a light being drawn
  const tailGeo = new THREE.BufferGeometry() // shares the vertex data, has its own draw range
  tailGeo.setAttribute('position', pathGeo.getAttribute('position'))
  tailGeo.setAttribute('color', pathGeo.getAttribute('color'))
  const tailLine = new THREE.Line(tailGeo, tailMat)
  tailLine.frustumCulled = false
  tailLine.renderOrder = 5
  group.add(tailLine)
  const TAIL = 8 * SUB
  const total = pts.length / 3
  const head = new THREE.Mesh(new THREE.CircleGeometry(0.0055, 20).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: new THREE.Color(2.6, 2.4, 1.8), transparent: true, opacity: 0, depthWrite: false, toneMapped: false }))
  head.renderOrder = 7
  group.add(head)

  // ---- hold: tethers that stop short of B2 + an amber ring ----
  const b2 = cellCenter(HELD_OUT)
  const tPos = []
  const tFade = [] // alpha per vertex
  const stop = 0.62
  for (const id of PERIMETER) {
    const a = cellCenter(id)
    const SEG = 10
    for (let s = 0; s < SEG; s++) {
      const t0 = (s / SEG) * stop, t1 = ((s + 1) / SEG) * stop
      for (const t of [t0, t1]) tPos.push(a.x + (b2.x - a.x) * t, TABLE_Y + 0.0035, a.z + (b2.z - a.z) * t)
      const f0 = 1 - s / SEG, f1 = 1 - (s + 1) / SEG // fade toward the stopping point
      tFade.push(f0, f1)
    }
  }
  const tGeo = new THREE.BufferGeometry()
  tGeo.setAttribute('position', new THREE.Float32BufferAttribute(tPos, 3))
  const tCols = new Float32Array(tFade.length * 4)
  tGeo.setAttribute('color', new THREE.BufferAttribute(tCols, 4))
  const tMat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false })
  const tethers = new THREE.LineSegments(tGeo, tMat)
  tethers.frustumCulled = false
  tethers.renderOrder = 5
  group.add(tethers)

  const ringMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 1, 1), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false })
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.93, 1, 96).rotateX(-Math.PI / 2), ringMat)
  ring.position.set(b2.x, TABLE_Y + 0.003, b2.z)
  ring.renderOrder = 6
  group.add(ring)
  const ringR = Math.hypot(GRID.d, GRID.w) * 0.42

  let painted = -1
  function repaint() {
    painted = PAL.stamp
    cool.copy(PAL.trained).lerp(new THREE.Color(0.9, 1, 0.95), mixL(0.35, 0))
    warm.copy(PAL.accent).lerp(new THREE.Color(1, 1, 1), mixL(0.35, 0))
    for (let i = 0; i < roundOf.length; i++) {
      const c = roundOf[i] % 2 === 1 ? warm : cool
      cols[i * 3] = c.r; cols[i * 3 + 1] = c.g; cols[i * 3 + 2] = c.b
    }
    pathGeo.attributes.color.needsUpdate = true
    const tc = new THREE.Color().copy(PAL.trained).lerp(new THREE.Color(1, 1, 1), mixL(0.5, 0)).multiplyScalar(mixL(2.0, 1.0))
    for (let i = 0; i < tFade.length; i++) { tCols[i * 4] = tc.r; tCols[i * 4 + 1] = tc.g; tCols[i * 4 + 2] = tc.b; tCols[i * 4 + 3] = tFade[i] }
    tGeo.attributes.color.needsUpdate = true
    ringMat.color.copy(PAL.held).multiplyScalar(mixL(2.0, 1.0))
    head.material.color.copy(isLightPal() ? PAL.held : new THREE.Color(2.6, 2.4, 1.8))
  }
  repaint()

  let t = 0
  return {
    group,
    update(dt, { count, pathAlpha, hold }) {
      t += dt
      group.visible = pathAlpha > 0.01 || hold > 0.01
      if (!group.visible) return
      if (painted !== PAL.stamp) repaint()
      const light = isLightPal()
      if (pathMat.userData.light !== light) {
        pathMat.userData.light = light
        for (const m of [pathMat, tailMat, tMat, ringMat, head.material]) { m.blending = light ? THREE.NormalBlending : THREE.AdditiveBlending; m.needsUpdate = true }
      }
      const drawn = Math.max(0, Math.min(1, count / TOTAL_EPISODES)) // 0..1 of the strip
      const n = Math.max(0, Math.min(total, Math.round(drawn * (total - 1)) + 1))
      pathGeo.setDrawRange(0, n >= 2 ? n : 0)
      pathMat.opacity = pathAlpha * mixL(0.22, 0.4) * (1 - hold * 0.7)
      const from = Math.max(0, n - TAIL)
      tailGeo.setDrawRange(from, n >= 2 ? n - from : 0)
      tailMat.opacity = pathAlpha * mixL(0.95, 1.0) * (1 - hold * 0.8)
      const hi = Math.max(0, Math.min(total - 1, n - 1))
      head.visible = n >= 2 && pathAlpha > 0.02
      head.position.set(pts[hi * 3], pts[hi * 3 + 1] + 0.0008, pts[hi * 3 + 2])
      head.material.opacity = pathAlpha * (1 - hold)
      tMat.opacity = hold * mixL(0.9, 1.0)
      const pulse = 0.5 + 0.5 * Math.sin(t * 2.4)
      const r = ringR * (1 + 0.05 * pulse) * (0.86 + 0.14 * hold)
      ring.scale.set(r, 1, r * 0.78)
      ringMat.opacity = smooth(0, 1, hold) * (0.55 + 0.4 * pulse)
    },
    dispose() {
      pathGeo.dispose(); tailGeo.dispose(); pathMat.dispose(); tailMat.dispose(); tGeo.dispose(); tMat.dispose(); ringMat.dispose(); ring.geometry.dispose()
      head.geometry.dispose(); head.material.dispose()
    },
  }
}
