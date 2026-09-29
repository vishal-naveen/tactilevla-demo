// "Place anywhere" hint: an inviting target on an empty, reachable table spot (never a grid-cell centre) with a slow pulse
// and a gentle tap ripple about every 2 s. Shown only in the sandbox while no task is running; hidden for good by the
// first table click (until the page asks again). The page anchors a DOM tooltip at getScreenPos().
import * as THREE from 'three'
import { PAL, isLightPal } from './palette.js'
import { CUP, GRID, TABLE_Y, cellAtPoint } from './layout.js'
import { reachable } from './placement.js'

const RIPPLE_S = 2.1 // seconds between taps
const R = 0.026 // ring radius (m)
const CANDIDATES = (() => {
  const out = []
  for (const x of [0.325, 0.315, 0.25, 0.2, 0.16]) for (const z of [0, -0.06, 0.06, -0.12, 0.12, -0.18, 0.18]) out.push({ x, z })
  return out
})()

export function createPlaceHint(scene, camera) {
  const group = new THREE.Group()
  group.visible = false
  scene.add(group)
  const ringGeo = new THREE.RingGeometry(0.88, 1, 64).rotateX(-Math.PI / 2)
  const discGeo = new THREE.CircleGeometry(1, 40).rotateX(-Math.PI / 2)
  const mk = (geo) => {
    const m = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, toneMapped: false })
    const o = new THREE.Mesh(geo, m)
    o.renderOrder = 6
    group.add(o)
    return { o, m }
  }
  const ring = mk(ringGeo), dot = mk(discGeo), ripple = mk(ringGeo), halo = mk(discGeo)

  const st = { want: false, latched: false, a: 0, time: 0, spot: null, spotAt: -9, sw: 1, sh: 1, sx: 0, sy: 0 }
  const _v = new THREE.Vector3()

  /** Best empty reachable spot on screen: away from cells, cup and the page's text column; stays put once chosen. */
  function chooseSpot(w, h, minX, maxY) {
    let best = null, bestScore = -Infinity
    for (const c of CANDIDATES) {
      if (!reachable(c.x, c.z) || cellAtPoint(c.x, c.z) || Math.hypot(c.x - CUP.x, c.z - CUP.z) < CUP.rimR + 0.08) continue
      _v.set(c.x, TABLE_Y, c.z).project(camera)
      const px = (_v.x * 0.5 + 0.5) * w, py = (-_v.y * 0.5 + 0.5) * h
      if (px < minX + 60 || px > w - 70 || py < 130 || py > maxY - 90) continue
      // prefer a spot just beyond the grid, near the middle of the free part of the screen
      const score = -Math.abs(px - (minX + (w - minX) * 0.55)) * 0.6 - Math.abs(py - h * 0.62) * 0.4 - (c.x < GRID.x0 + 3 * GRID.d ? 200 : 0)
      if (score > bestScore) { bestScore = score; best = c }
    }
    return best
  }

  return {
    setWanted(on) { st.want = !!on; if (st.want) st.latched = false },
    /** The first table click hides the hint until the page asks for it again. */
    dismiss() { st.want = false },
    /** CSS px (relative to the canvas' top-left, offset by originX/Y by the caller), or null while hidden. */
    getScreenPos() { return st.a > 0.05 && st.spot ? { x: st.sx, y: st.sy } : null },
    update(dt, { enabled, idle, reduced, w, h, minX, maxY }) {
      st.time += dt
      const show = enabled && idle && st.want
      st.a += ((show ? 1 : 0) - st.a) * (reduced ? 1 : 1 - Math.exp(-dt * 5))
      if (!show && st.a < 0.004) st.a = 0
      group.visible = st.a > 0.004
      if (!group.visible) return
      if (!st.spot || st.time - st.spotAt > 0.6) {
        st.spotAt = st.time
        // stickiness: only re-pick when the current spot is no longer valid on screen
        const cur = st.spot
        let ok = false
        if (cur) {
          _v.set(cur.x, TABLE_Y, cur.z).project(camera)
          const px = (_v.x * 0.5 + 0.5) * w, py = (-_v.y * 0.5 + 0.5) * h
          ok = px > minX + 30 && px < w - 40 && py > 100 && py < maxY - 60
        }
        if (!ok) st.spot = chooseSpot(w, h, minX, maxY) ?? cur
      }
      if (!st.spot) { group.visible = false; return }
      const light = isLightPal()
      const blend = light ? THREE.NormalBlending : THREE.AdditiveBlending
      const gain = light ? 0.9 : 1.5
      for (const r of [ring, dot, ripple, halo]) if (r.m.blending !== blend) { r.m.blending = blend; r.m.needsUpdate = true }
      const { x, z } = st.spot
      group.position.set(x, TABLE_Y + 0.0028, z)
      const A = st.a
      const breathe = reduced ? 0.5 : 0.5 + 0.5 * Math.sin(st.time * 2.2)
      // ring: slow breathing; inner dot: a soft "press" once per cycle
      const cyc = (st.time % RIPPLE_S) / RIPPLE_S
      const press = reduced ? 0 : Math.exp(-Math.pow((cyc - 0.12) / 0.07, 2)) // 0..1 pulse near the start of the cycle
      const rr = R * (1 + 0.05 * breathe - 0.1 * press)
      ring.o.scale.set(rr, 1, rr)
      ring.m.color.copy(PAL.accent).multiplyScalar(gain)
      ring.m.opacity = A * (0.5 + 0.25 * breathe + 0.2 * press)
      dot.o.scale.set(R * 0.2 * (1 + 0.4 * press), 1, R * 0.2 * (1 + 0.4 * press))
      dot.m.color.copy(PAL.accent).multiplyScalar(gain)
      dot.m.opacity = A * (0.55 + 0.4 * press)
      halo.o.scale.set(R * 1.7, 1, R * 1.7)
      halo.m.color.copy(PAL.accent).multiplyScalar(gain * 0.5)
      halo.m.opacity = A * (0.07 + 0.05 * breathe)
      // tap ripple: expands out of the press and fades; nothing in reduced motion
      const u = Math.min(1, Math.max(0, (cyc - 0.12) / 0.55))
      const eu = 1 - Math.pow(1 - u, 3)
      ripple.o.visible = !reduced && u > 0 && u < 1
      if (ripple.o.visible) {
        const r2 = R * (0.6 + 1.9 * eu)
        ripple.o.scale.set(r2, 1, r2)
        ripple.m.color.copy(PAL.accent).multiplyScalar(gain)
        ripple.m.opacity = A * 0.75 * Math.pow(1 - u, 1.6)
      }
      _v.set(x, TABLE_Y + 0.012, z).project(camera)
      st.sx = (_v.x * 0.5 + 0.5) * w
      st.sy = (-_v.y * 0.5 + 0.5) * h
    },
    dispose() { ringGeo.dispose(); discGeo.dispose(); for (const r of [ring, dot, ripple, halo]) r.m.dispose(); group.removeFromParent() },
  }
}
