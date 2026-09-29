// Camera shots per chapter, plus the camera rig: authored flights between shots (spherical arcs around the subject),
// in-chapter dolly modifiers, drift, parallax, orbit and the lens shift that keeps the subject in the safe area.
import * as THREE from 'three'

import { fitShot } from './framing.js'

// dir = direction from the subject to the camera; subject = key into the point clouds from subjects.js.
// Distance, look-at point and lens shift are fitted at runtime so the whole subject stays in the safe area.
export const SHOTS = {
  hero:     { dir: [0.6, 0.17, -0.78], fov: 34, subject: 'loop:hero' },
  arm:      { dir: [0.12, 0.05, -1.0], fov: 32, subject: 'exploded' },
  data:     { dir: [0.38, 0.93, 0.02], fov: 32, subject: 'rest' },
  sees:     { dir: [0.9, 0.5, -0.8], fov: 34, subject: 'sees' },
  policies: { dir: [0.7, 0.2, -0.8], fov: 32, subject: 'loop:calm' },
  test:     { dir: [0.75, 0.1, -0.5], fov: 32, subject: 'loop:test' },
  results:  { dir: [0.8, 0.3, -0.9], fov: 34, subject: 'loop:slow', sphere: true, orbit: 0.045 },
  film:     { dir: [0.75, 0.25, 0.85], fov: 34, subject: 'loop:slow', sphere: true, orbit: -0.04 },
  limits:   { dir: [0.9, 0.3, 0.55], fov: 38, subject: 'rest', sphere: true, pull: 1.45, orbit: 0.02 },
  touch:    { dir: [0.6, 0.22, -0.75], fov: 32, subject: 'touch' },
  sandbox:  { dir: [0.8, 0.62, -0.05], fov: 36, subject: 'play' },
}


const _v = new THREE.Vector3()
const _l = new THREE.Vector3()
const _u = new THREE.Vector3()
const _p = new THREE.Vector3()
const _d = new THREE.Vector3()
const _r = new THREE.Vector3()
const _o = new THREE.Vector3()
const _b = new THREE.Vector3()

export const easeInOut3 = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
export const easeOut3 = (t) => 1 - Math.pow(1 - t, 3)
const easeOut2 = (t) => 1 - (1 - t) * (1 - t)
const lerp = (a, b, t) => a + (b - a) * t
const shortest = (a, b) => { let d = b - a; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d }

const INTRO_DIST = 1.22 // hero dolly-in: start distance multiplier
const INTRO_FOV = 6
const INTRO_S = 2.6

export class CameraRig {
  constructor(camera) {
    this.camera = camera
    this.subjects = null
    this.cache = new Map()
    // base state: pos(3) look(3) fov lensShiftX lensShiftY
    this.s = [1, 0.4, -0.6, 0, 0.1, 0, 34, 0, 0]
    this.t = [...this.s]
    this.tw = null // running flight: { from, to, t, dur, lift }
    this.shot = 'hero'
    this.orbitAngle = 0
    this.orbitSpeed = 0
    this.time = 0
    this.pointer = new THREE.Vector2()
    this.pointerS = new THREE.Vector2()
    this.reduced = false
    this.aspect = 1.6
    this.autoOffset = 0 // progress-driven azimuth (arm chapter)
    this.autoOffsetS = 0
    // per-frame modifiers set by the stage: distance scale, fov delta, look-at pull toward a point
    this.mods = { scale: 1, fov: 0, lookTo: new THREE.Vector3(), lookK: 0 }
    this.intro = { k: 1, t: -1 } // k: 1 = pulled back, animates to 0 on reveal()
  }

  setSubjects(subjects) { this.subjects = subjects; this.cache.clear() }

  /** Fitted camera for a shot at the current aspect (cached). */
  resolve(id) {
    const shot = SHOTS[id] ?? SHOTS.hero
    const key = id + '@' + this.aspect.toFixed(3)
    let r = this.cache.get(key)
    if (!r) {
      const pts = this.subjects?.[shot.subject]
      r = pts ? fitShot(shot, pts, this.aspect) : { pos: [1, 0.4, -0.6], look: [0.15, 0.1, 0], fov: shot.fov, dx: 0, dy: 0 }
      if (shot.pull) { // pull the camera back along its ray; the lens shift keeps the subject where it was
        const p = new THREE.Vector3(...r.pos), l = new THREE.Vector3(...r.look)
        r = { ...r, pos: p.sub(l).multiplyScalar(shot.pull).add(l).toArray() }
      }
      this.cache.set(key, r)
    }
    return r
  }

  /** Fly (or cut, when snap) to a chapter's shot. */
  setShot(id, snap = false) {
    const shot = SHOTS[id] ?? SHOTS.hero
    this.shot = id
    this.orbitSpeed = shot.orbit ?? 0
    const r = this.resolve(id)
    this.t = [...r.pos, ...r.look, r.fov, r.dx, r.dy]
    if (snap || this.reduced) { this.s = [...this.t]; this.tw = null; return }
    const from = [...this.s]
    const chord = _v.set(from[0], from[1], from[2]).distanceTo(_l.set(...this.t.slice(0, 3)))
      + _o.set(from[3], from[4], from[5]).distanceTo(_b.set(...this.t.slice(3, 6)))
    if (chord < 1e-4 && Math.abs(from[6] - this.t[6]) < 0.01) { this.tw = null; this.s = [...this.t]; return }
    this.tw = { from, to: [...this.t], t: 0, dur: THREE.MathUtils.clamp(1.1 + 0.6 * chord, 1.3, 2.6), lift: Math.min(0.28, 0.16 * chord) }
  }

  /** Seconds until the current flight lands (0 when idle). */
  remaining() { return this.tw ? this.tw.dur - this.tw.t : 0 }

  /** Re-derive targets after a resize (aspect changes framing). */
  refresh() { this.setShot(this.shot, true) }

  /** Start the hero dolly-in (page calls reveal() after the loader). */
  startIntro() { if (this.intro.t < 0) this.intro.t = this.reduced ? INTRO_S : 0 }

  _flight(dt) {
    const f = this.tw
    if (!f) return
    f.t = Math.min(f.dur, f.t + dt)
    const u = f.t / f.dur
    const e = easeInOut3(u)
    const a = f.from, b = f.to, s = this.s
    // look-at and fov: straight blend
    for (let i = 3; i < 7; i++) s[i] = lerp(a[i], b[i], e)
    // lens shift leads, so the subject clears the text column early
    const eShift = easeOut2(Math.min(1, u / 0.6))
    s[7] = lerp(a[7], b[7], eShift)
    s[8] = lerp(a[8], b[8], eShift)
    // position: spherical blend around the moving look-at (arc, never through the arm), plus a raised mid-waypoint
    const lookNow = _l.set(s[3], s[4], s[5])
    const oa = _o.set(a[0] - a[3], a[1] - a[4], a[2] - a[5])
    const ra = oa.length(), tha = Math.atan2(oa.z, oa.x), pha = Math.asin(oa.y / ra)
    const ob = _b.set(b[0] - b[3], b[1] - b[4], b[2] - b[5])
    const rb = ob.length(), thb = Math.atan2(ob.z, ob.x), phb = Math.asin(ob.y / rb)
    const r = lerp(ra, rb, e), th = tha + shortest(tha, thb) * e, ph = lerp(pha, phb, e)
    s[0] = lookNow.x + r * Math.cos(ph) * Math.cos(th)
    s[1] = lookNow.y + r * Math.sin(ph) + f.lift * Math.sin(Math.PI * e)
    s[2] = lookNow.z + r * Math.cos(ph) * Math.sin(th)
    if (f.t >= f.dur) { this.s = [...b]; this.tw = null }
  }

  update(dt, { drift = true, write = true } = {}) {
    this.time += dt
    if (this.tw) this._flight(dt)
    else if (this.reduced) this.s = [...this.t]
    if (this.intro.t >= 0 && this.intro.k > 0) {
      this.intro.t += dt
      this.intro.k = this.reduced ? 0 : 1 - easeOut3(Math.min(1, this.intro.t / INTRO_S))
      if (this.intro.t >= INTRO_S) this.intro.k = 0
    }
    this.pointerS.lerp(this.pointer, 1 - Math.exp(-dt * 2.4))
    this.autoOffsetS += (this.autoOffset - this.autoOffsetS) * (1 - Math.exp(-dt * 5))
    if (this.orbitSpeed && !this.reduced) this.orbitAngle += this.orbitSpeed * dt

    const s = this.s
    const look = _u.set(s[3], s[4], s[5])
    const pos = _p.set(s[0], s[1], s[2])
    const m = this.mods
    const ik = this.intro.k
    const scale = m.scale * (1 + (INTRO_DIST - 1) * ik)
    if (scale !== 1) pos.sub(look).multiplyScalar(scale).add(look)
    if (m.lookK > 0) { // pull the look-at toward a point, carrying the camera along so the view direction holds
      _d.copy(m.lookTo).sub(look).multiplyScalar(m.lookK)
      look.add(_d)
      pos.add(_d)
    }
    const ang = this.orbitAngle + this.autoOffsetS
    if (ang !== 0) {
      const dx = pos.x - look.x, dz = pos.z - look.z
      const c = Math.cos(ang), sn = Math.sin(ang)
      pos.x = look.x + dx * c - dz * sn
      pos.z = look.z + dx * sn + dz * c
    }
    if (drift && !this.reduced) {
      const t = this.time
      pos.x += Math.sin(t * 0.21) * 0.012 + Math.sin(t * 0.53) * 0.004
      pos.y += Math.sin(t * 0.17 + 1.3) * 0.008
      pos.z += Math.cos(t * 0.19) * 0.012
      // mouse parallax: slide the camera sideways/up a touch
      _r.set(1, 0, 0).applyQuaternion(this.camera.quaternion)
      pos.addScaledVector(_r, this.pointerS.x * 0.028)
      pos.y += this.pointerS.y * 0.016
    }
    if (write) {
      this.camera.position.copy(pos)
      this.camera.lookAt(look)
    }
    this.camera.fov = s[6] + m.fov + INTRO_FOV * ik
    this._applyOffset(s[7], s[8])
  }

  _applyOffset(dx, dy) {
    const w = this.width || 1, h = this.height || 1
    this.camera.setViewOffset(w, h, -dx * w, dy * h, w, h) // also refreshes the projection
  }

  settled() { return !this.tw && this.intro.k < 0.002 }

  /** Take over from OrbitControls: continue from the camera's current position. */
  adopt(pos, look) {
    this.s.splice(0, 6, pos.x, pos.y, pos.z, look.x, look.y, look.z)
    this.tw = null
    this.orbitAngle = 0
    this.autoOffsetS = 0
  }

  setSize(w, h) {
    this.width = w; this.height = h
    this.aspect = w / h
    this.camera.aspect = w / h
    this.refresh()
  }
}
