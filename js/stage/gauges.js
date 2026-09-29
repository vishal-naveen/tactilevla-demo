// 3D joint-angle gauges: at each revolute joint a thin arc in the joint's rotation plane, sweeping from the joint's zero
// to its current angle, over a faint full-range track (URDF lower..upper) with a bright tick at the current value.
// Screen-space-width lines (Line2), positions rewritten in place each frame: no allocation, no geometry rebuilds.
import * as THREE from 'three'
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js'
import { LineMaterial } from 'three/addons/lines/LineMaterial.js'
import { JOINT_NAMES } from './robot.js'
import { PAL, mixL, isLightPal } from './palette.js'

const N = 40 // segments per arc / track
const FADE_S = 0.3
// radius of the arc (m) and how far it sits off the joint centre along the axis, clear of the servo housings
// (a little larger than the servos so the arcs read at page scale instead of hiding inside the arm)
const SPEC = {
  shoulder_pan: { r: 0.05, off: 0.05 },
  shoulder_lift: { r: 0.048, off: 0.046 },
  elbow_flex: { r: 0.048, off: 0.046 },
  wrist_flex: { r: 0.04, off: 0.042 },
  wrist_roll: { r: 0.036, off: 0.04 },
  gripper: { r: 0.034, off: 0.04 },
}

function makeLines(segments, mat) {
  const g = new LineSegmentsGeometry()
  g.setPositions(new Float32Array(segments * 6))
  const o = new LineSegments2(g, mat)
  o.frustumCulled = false
  o.renderOrder = 8
  return { obj: o, buf: g.attributes.instanceStart.data }
}

export function createGauges(rig) {
  const root = new THREE.Group()
  root.visible = false
  const mk = (linewidth) => new LineMaterial({ linewidth, transparent: true, depthWrite: false, depthTest: true, worldUnits: false, toneMapped: false })
  const trackMat = mk(2)
  const arcMat = mk(4)
  const tickMat = mk(5)
  const mats = [trackMat, arcMat, tickMat]

  const items = JOINT_NAMES.map((name) => {
    const joint = rig.joints[name]
    const [lo, hi] = rig.limits[name]
    const { r } = SPEC[name]
    // fixed frame of the joint (parent link space): same origin/orientation as the joint before it rotates
    const frame = new THREE.Group()
    frame.position.copy(joint.origPosition)
    frame.quaternion.copy(joint.origQuaternion)
    joint.parent.add(frame)
    const side = new THREE.Group() // slides along the axis to whichever side faces the camera
    frame.add(side)

    // static track: full range + zero mark
    const track = makeLines(N + 1, trackMat)
    const ta = track.buf.array
    for (let i = 0; i < N; i++) {
      const a0 = lo + ((hi - lo) * i) / N, a1 = lo + ((hi - lo) * (i + 1)) / N
      ta.set([r * Math.cos(a0), r * Math.sin(a0), 0, r * Math.cos(a1), r * Math.sin(a1), 0], i * 6)
    }
    ta.set([r * 0.86, 0, 0, r * 1.14, 0, 0], N * 6) // zero tick
    track.buf.needsUpdate = true
    // dynamic: arc 0 -> angle (N segments) + the current-value tick
    const dyn = makeLines(N + 1, arcMat)
    const tick = makeLines(1, tickMat)
    side.add(track.obj, dyn.obj, tick.obj)
    return { name, joint, lo, hi, r, frame, side, dyn, tick, sign: 1, off: SPEC[name].off, lastAngle: NaN }
  })
  rig.root.add(root) // group kept for on/off visibility (frames live in the parent links)

  const _v = new THREE.Vector3()
  const WHITE = new THREE.Color(1, 1, 1)
  const _c = new THREE.Vector3()
  const _q = new THREE.Quaternion()
  const _ax = new THREE.Vector3()
  let alpha = 0
  let lightSeen = null
  let painted = -1

  function paint() {
    painted = PAL.stamp
    const light = isLightPal()
    trackMat.color.copy(PAL.trained).multiplyScalar(mixL(1.3, 1.0))
    arcMat.color.copy(PAL.accent).multiplyScalar(mixL(1.2, 1.0))
    tickMat.color.copy(PAL.accent).lerp(WHITE, mixL(0.35, 0)).multiplyScalar(mixL(1.55, 1.0))
    if (lightSeen !== light) {
      lightSeen = light
      for (const m of mats) { m.blending = light ? THREE.NormalBlending : THREE.AdditiveBlending; m.needsUpdate = true }
    }
  }

  return {
    setResolution(w, h) { for (const m of mats) m.resolution.set(w, h) },
    /** @param on wanted visibility; dim 0..1 opacity scale; camera used to put each arc on the side of the joint that faces the viewer */
    update(dt, on, camera, dim = 1) {
      const target = on ? 1 : 0
      alpha += (target - alpha) * (1 - Math.exp(-dt / (FADE_S / 4))) // ~0.3 s to settle
      if (Math.abs(target - alpha) < 0.004) alpha = target
      const show = alpha > 0.004
      for (const it of items) { it.frame.visible = show }
      if (!show) return
      if (painted !== PAL.stamp || lightSeen === null) paint()
      // dim (0..1): stand back while the 3D phase path is up - one clean path leads, the gauges become quiet context
      trackMat.opacity = alpha * dim * mixL(0.42, 0.55)
      arcMat.opacity = alpha * dim * mixL(0.95, 1.0)
      tickMat.opacity = alpha * dim

      for (const it of items) {
        // which side of the joint faces the camera (with hysteresis), eased so it never pops
        it.frame.getWorldQuaternion(_q)
        _ax.set(0, 0, 1).applyQuaternion(_q)
        it.frame.getWorldPosition(_c)
        const d = _ax.dot(_v.copy(camera.position).sub(_c).normalize())
        if (Math.abs(d) > 0.18) it.sign = d > 0 ? 1 : -1
        it.side.position.z += (it.sign * it.off - it.side.position.z) * (1 - Math.exp(-dt * 12))

        const a = it.joint.angle
        if (a === it.lastAngle) continue
        it.lastAngle = a
        // Line2 normalises each segment's direction: a zero-length segment yields NaN, and one NaN pixel is smeared over
        // the whole frame by the bloom blur. Keep every segment strictly non-degenerate.
        const sweep = Math.abs(a) < 2e-3 ? 2e-3 : a
        const buf = it.dyn.buf.array
        const r = it.r
        for (let i = 0; i < N; i++) {
          const a0 = (sweep * i) / N, a1 = (sweep * (i + 1)) / N
          const o = i * 6
          buf[o] = r * Math.cos(a0); buf[o + 1] = r * Math.sin(a0); buf[o + 2] = 0
          buf[o + 3] = r * Math.cos(a1); buf[o + 4] = r * Math.sin(a1); buf[o + 5] = 0
        }
        // the last dynamic segment is unused by the arc; park it as a tiny dot at the arc's end (non-degenerate)
        const o = N * 6
        buf[o] = buf[N * 6 - 3]; buf[o + 1] = buf[N * 6 - 2]; buf[o + 2] = 0
        buf[o + 3] = buf[o] + 1e-4; buf[o + 4] = buf[o + 1]; buf[o + 5] = 0
        it.dyn.buf.needsUpdate = true
        const tb = it.tick.buf.array
        const c = Math.cos(a), s = Math.sin(a)
        tb[0] = r * 0.78 * c; tb[1] = r * 0.78 * s; tb[2] = 0
        tb[3] = r * 1.3 * c; tb[4] = r * 1.3 * s; tb[5] = 0
        it.tick.buf.needsUpdate = true
      }
    },
    dispose() {
      for (const it of items) { it.frame.removeFromParent(); it.side.traverse((o) => o.geometry?.dispose?.()) }
      for (const m of mats) m.dispose()
      root.removeFromParent()
    },
  }
}
