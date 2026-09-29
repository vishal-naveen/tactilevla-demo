// Exploded view (arm chapter) and servo heat glow (touch chapter).
import * as THREE from 'three'
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js'
import { JOINT_NAMES, JOINT_LABELS } from './robot.js'

const PEAK_LOAD = { shoulder_pan: 92, shoulder_lift: 152, elbow_flex: 112, wrist_flex: 48, wrist_roll: 52, gripper: 56 }
const MAX_LOAD = 152

const _a = new THREE.Vector3()
const _b = new THREE.Vector3()
const _q = new THREE.Quaternion()
const _cb = new THREE.Color()

const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t) }

// Mirrors the page's leader stub + dot for chips that sit to the left of their joint (positioning only).
function injectFlipStyle() {
  if (document.getElementById('stage-label-flip')) return
  const st = document.createElement('style')
  st.id = 'stage-label-flip'
  st.textContent = '.stage-label--joint.is-flip{padding:0.4rem 1.9rem 0.4rem 0.7rem}.stage-label--joint.is-flip::before{left:auto;right:0.5rem}.stage-label--joint.is-flip::after{left:auto;right:0.3rem}'
  document.head.append(st)
}

function heatColor(t, out) {
  // one warm ramp: ivory -> amber -> hot orange-red
  const stops = [[0, 0xede4cf], [0.55, 0xf08a24], [1, 0xe8402a]]
  for (let i = 0; i < stops.length - 1; i++) {
    const [t0, c0] = stops[i], [t1, c1] = stops[i + 1]
    if (t <= t1) return out.setHex(c0).lerp(_cb.setHex(c1), (t - t0) / (t1 - t0))
  }
  return out.setHex(stops[stops.length - 1][1])
}

export function createRobotFx(rig) {
  const { robot, joints, visualsByLink } = rig
  const chain = JOINT_NAMES.map((n) => {
    const joint = joints[n]
    const link = joint.children.find((c) => c.isURDFLink)
    return { name: n, joint, link }
  })

  // per-visual explode data in link space
  const parts = []
  for (const { link } of [{ link: robot.links.base_link }, ...chain]) {
    const vis = (visualsByLink[link.name] || []).filter((v, i, a) => a.indexOf(v) === i)
    const entries = vis.map((v) => {
      const mesh = v.children.find((c) => c.isMesh)
      const bb = mesh.geometry.boundingBox
      const c = bb.getCenter(new THREE.Vector3())
      const center = c.applyQuaternion(v.quaternion).add(v.position)
      return { v, center, servo: !!mesh.userData.servo, base: v.position.clone() }
    })
    const centroid = new THREE.Vector3()
    entries.forEach((e) => centroid.add(e.center))
    if (entries.length) centroid.divideScalar(entries.length)
    for (const e of entries) {
      e.dir = e.center.clone().sub(centroid)
      if (e.dir.lengthSq() < 1e-8 || entries.length < 2) e.dir.set(0, 0, 0)
      else e.dir.normalize()
    }
    parts.push(...entries)
  }

  // labels: a wrapper (positioned by CSS2DRenderer at the joint) holds the chip and a 1px leader that draws in
  injectFlipStyle()
  const labels = chain.map(({ joint }, i) => {
    const wrap = document.createElement('div')
    wrap.style.cssText = 'width:0;height:0;visibility:hidden'
    const el = document.createElement('div')
    el.className = 'stage-label stage-label--joint'
    el.textContent = JOINT_LABELS[i]
    el.style.cssText = 'position:absolute;left:0;top:0;opacity:0;will-change:transform,opacity'
    const leader = document.createElement('div')
    leader.style.cssText = 'position:absolute;left:0;top:0;height:1px;width:0;transform-origin:0 50%;background:rgba(237,228,207,0.6);pointer-events:none'
    wrap.append(leader, el)
    const obj = new CSS2DObject(wrap)
    joint.add(obj)
    return { wrap, el, leader, obj, joint, last: '' }
  })
  const LABEL_R = 72
  const _wp = new THREE.Vector3()
  const cpx = []

  const heatCol = new THREE.Color()
  let phase = 0
  let exploded = 0

  function applyExplode(e, camSide) {
    exploded = e
    // 1) clear offsets, refresh FK to read the rest chain
    for (const c of chain) { c.link.position.set(0, 0, 0); c.link.quaternion.identity() }
    for (const p of parts) p.v.position.copy(p.base)
    if (e < 0.001) { robot.updateMatrixWorld(true); return }
    robot.updateMatrixWorld(true)
    const dirs = []
    let prev = new THREE.Vector3().setFromMatrixPosition(robot.links.base_link.matrixWorld)
    chain.forEach((c, i) => {
      const p = new THREE.Vector3().setFromMatrixPosition(c.joint.matrixWorld)
      let d
      if (i === 0) d = new THREE.Vector3(0, 1, 0)
      else if (i === 5) { // gripper: jaw sits beside the fixed jaw
        d = p.clone().sub(new THREE.Vector3().setFromMatrixPosition(chain[4].joint.matrixWorld))
        d.y += 0.4 * d.length(); d.z += camSide * 0.6 * d.length()
      } else d = p.clone().sub(prev)
      if (d.lengthSq() < 1e-10) d.set(0, 1, 0)
      dirs.push(d.normalize())
      prev = p
    })
    // 2) apply cumulative offsets in each joint frame
    chain.forEach((c, i) => {
      const level = 0.036 + 0.008 * (i === 0 ? 1 : 0)
      _q.setFromRotationMatrix(new THREE.Matrix4().extractRotation(c.joint.matrixWorld)).invert()
      const local = dirs[i].clone().applyQuaternion(_q)
      c.link.position.copy(local).multiplyScalar(level * e)
      const twist = e * 0.34 * (i % 2 ? 1 : -1)
      c.link.quaternion.setFromAxisAngle(local, twist)
    })
    // 3) separate servos and printed parts inside each link
    for (const p of parts) p.v.position.copy(p.base).addScaledVector(p.dir, (p.servo ? 0.034 : 0.012) * e)
    robot.updateMatrixWorld(true)
  }

  /** Screen-space label layout: each chip sits ~72 px out from the arm's projected centroid, revealed joint by joint. */
  function placeLabels(e, camera, vw, vh) {
    const show = e > 0.05
    for (let i = 0; i < labels.length; i++) {
      const l = labels[i]
      if (!show) { if (l.last !== 'off') { l.wrap.style.visibility = 'hidden'; l.last = 'off' } continue }
      _wp.setFromMatrixPosition(l.joint.matrixWorld).project(camera)
      cpx[i * 2] = (_wp.x * 0.5 + 0.5) * vw
      cpx[i * 2 + 1] = (-_wp.y * 0.5 + 0.5) * vh
    }
    if (!show) return
    let cx = 0, cy = 0
    for (let i = 0; i < labels.length; i++) { cx += cpx[i * 2]; cy += cpx[i * 2 + 1] }
    cx /= labels.length; cy /= labels.length
    // chip anchor offsets (px), then a light relaxation so neighbouring chips never overlap
    const ax = [], ay = [], dxs = []
    for (let i = 0; i < labels.length; i++) {
      let dx = cpx[i * 2] - cx, dy = cpx[i * 2 + 1] - cy
      const len = Math.hypot(dx, dy)
      if (len < 6) { dx = 1; dy = -0.35 } else { dx /= len; dy /= len }
      dxs[i] = dx
      ax[i] = dx * LABEL_R; ay[i] = dy * LABEL_R
    }
    for (let it = 0; it < 6; it++) {
      for (let i = 0; i < labels.length; i++) {
        for (let j = i + 1; j < labels.length; j++) {
          const gx = cpx[i * 2] + ax[i] - (cpx[j * 2] + ax[j]), gy = cpx[i * 2 + 1] + ay[i] - (cpx[j * 2 + 1] + ay[j])
          if (Math.abs(gx) < 132 && Math.abs(gy) < 30) {
            const push = (30 - Math.abs(gy)) / 2 + 1
            const s = gy >= 0 ? 1 : -1
            ay[i] += s * push; ay[j] -= s * push
          }
        }
      }
    }
    for (let i = 0; i < labels.length; i++) {
      const l = labels[i]
      const a = smoothstep(0.12 + i * 0.07, 0.22 + i * 0.07, e)
      let flip = dxs[i] < 0
      let ox = Math.round(ax[i]); const oy = Math.round(ay[i])
      // keep the chip on screen: flip to the other side of its joint when it would leave the viewport
      const CHIP = 128
      if (!flip && cpx[i * 2] + ox + CHIP > vw - 8) { flip = true; ox = -Math.abs(ox) }
      else if (flip && cpx[i * 2] + ox - CHIP < 8) { flip = false; ox = Math.abs(ox) }
      const ang = Math.atan2(oy, ox)
      const key = `${ox},${oy},${Math.round(a * 50)}`
      if (key === l.last) continue
      l.last = key
      l.wrap.style.visibility = a < 0.01 ? 'hidden' : 'visible'
      l.el.style.opacity = String(a)
      l.el.classList.toggle('is-flip', flip)
      l.el.style.transform = `translate(${ox}px, ${oy}px) translate(${flip ? '-100%' : '0'}, -50%)`
      l.leader.style.width = `${Math.round(LABEL_R * a)}px`
      l.leader.style.transform = `rotate(${ang}rad)`
      l.leader.style.opacity = String(Math.min(1, a * 1.5))
    }
  }

  function applyHeat(dt, weight) {
    phase += dt
    for (const n of JOINT_NAMES) {
      const t = PEAK_LOAD[n] / MAX_LOAD
      const breath = 0.72 + 0.28 * Math.sin(phase * 1.6 + t * 4)
      heatColor(t, heatCol)
      const m = rig.servoMats[n]
      m.emissive.copy(heatCol).multiplyScalar(weight * (0.55 + 1.9 * t) * breath)
    }
  }

  return {
    applyExplode, placeLabels, applyHeat,
    get exploded() { return exploded },
    dispose() { labels.forEach((l) => { l.obj.removeFromParent(); l.wrap.remove() }) },
  }
}
