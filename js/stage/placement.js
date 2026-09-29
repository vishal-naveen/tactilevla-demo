// "Place anywhere": table hover ring (teal = reachable, red = not), the planning pulse while IK runs, and the brief
// "Out of reach" flash. The geometry is cheap: three rings and one label, all positioned on the table plane.
import * as THREE from 'three'
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js'
import { PAL, isLightPal } from './palette.js'
import { CUP, TABLE_Y } from './layout.js'
import { reachSample } from './reachmap.js'

const RED = new THREE.Color('#ff5a4a')

/** Cheap reach test for the hover cursor (IK-sampled map); runTaskAt still confirms with the real IK. */
export function reachable(x, z) {
  return reachSample(x, z) && Math.hypot(x - CUP.x, z - CUP.z) > CUP.rimR + 0.035 // and not on top of the cup
}

export function createPlacement(scene) {
  const group = new THREE.Group()
  group.visible = false
  scene.add(group)
  const geo = new THREE.RingGeometry(0.86, 1, 64).rotateX(-Math.PI / 2)
  const mkRing = (r) => {
    const m = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, toneMapped: false })
    const o = new THREE.Mesh(geo, m)
    o.scale.set(r, 1, r)
    o.renderOrder = 6
    o.visible = false
    group.add(o)
    return { o, m }
  }
  const hover = mkRing(0.03)
  const plan = mkRing(0.03)
  const fail = mkRing(0.03)

  const el = document.createElement('div')
  el.className = 'stage-label stage-label--warn'
  el.textContent = 'Out of reach'
  el.style.cssText = 'opacity:0;visibility:hidden;transform:translate(0,-50%)'
  const wrap = document.createElement('div')
  wrap.style.cssText = 'width:0;height:0'
  wrap.append(el)
  const label = new CSS2DObject(wrap)
  label.position.set(0, 0.012, 0)
  group.add(label)

  const st = {
    hoverP: null, hoverOk: false, hoverA: 0, hx: 0, hz: 0,
    planning: null, planA: 0, failP: null, failT: 1, time: 0, enabled: false,
  }

  return {
    group,
    /** point: {x,z} | null (pointer left the table) */
    setHover(point) {
      if (point) { st.hoverP = point; st.hoverOk = reachable(point.x, point.z) } else st.hoverP = null
    },
    setPlanning(point) { st.planning = point },
    flashFail(point) { st.failP = point; st.failT = 0 },
    setEnabled(on) { st.enabled = on },
    /** true while a plan is being solved or a failure flash is showing */
    get busy() { return !!st.planning || st.failT < 1 },
    update(dt) {
      st.time += dt
      const light = isLightPal()
      const blend = light ? THREE.NormalBlending : THREE.AdditiveBlending
      const gain = light ? 1 : 1.8
      for (const r of [hover, plan, fail]) if (r.m.blending !== blend) { r.m.blending = blend; r.m.needsUpdate = true }

      // hover cursor: follows the pointer with a little lag, colour by reach test
      const showHover = st.enabled && !!st.hoverP && !st.planning
      st.hoverA += ((showHover ? 1 : 0) - st.hoverA) * (1 - Math.exp(-dt * 14))
      if (st.hoverP) {
        const k = 1 - Math.exp(-dt * 22)
        if (st.hx === 0 && st.hz === 0) { st.hx = st.hoverP.x; st.hz = st.hoverP.z }
        st.hx += (st.hoverP.x - st.hx) * k; st.hz += (st.hoverP.z - st.hz) * k
      }
      hover.o.visible = st.hoverA > 0.01
      if (hover.o.visible) {
        hover.o.position.set(st.hx, TABLE_Y + 0.0025, st.hz)
        hover.m.color.copy(st.hoverOk ? PAL.trained : RED).multiplyScalar(gain)
        hover.m.opacity = st.hoverA * (st.hoverOk ? 0.85 : 0.6)
        const r = 0.03 + (st.hoverOk ? 0 : 0.004 * Math.sin(st.time * 8))
        hover.o.scale.set(r, 1, r)
      }
      // planning pulse
      st.planA += ((st.planning ? 1 : 0) - st.planA) * (1 - Math.exp(-dt * 16))
      plan.o.visible = st.planA > 0.01 && !!(st.planning || st.planA > 0.02)
      if (st.planning) plan.o.position.set(st.planning.x, TABLE_Y + 0.0026, st.planning.z)
      if (plan.o.visible) {
        const u = (st.time * 2.2) % 1
        const r = 0.02 + 0.03 * u
        plan.o.scale.set(r, 1, r)
        plan.m.color.copy(PAL.accent).multiplyScalar(gain)
        plan.m.opacity = st.planA * (1 - u) * 0.9
      }
      // out-of-reach flash: a red ring that blooms once, and the label
      if (st.failT < 1) {
        st.failT = Math.min(1, st.failT + dt / 1.5)
        const u = st.failT
        const p = st.failP
        fail.o.visible = true
        fail.o.position.set(p.x, TABLE_Y + 0.0027, p.z)
        const r = 0.02 + 0.05 * (1 - Math.pow(1 - Math.min(1, u * 2.2), 3))
        fail.o.scale.set(r, 1, r)
        fail.m.color.copy(RED).multiplyScalar(gain)
        fail.m.opacity = Math.max(0, 1 - Math.max(0, (u - 0.25) / 0.75))
        label.position.set(p.x + 0.078, 0.012, p.z)
        const la = Math.min(1, u * 8) * Math.max(0, 1 - Math.max(0, (u - 0.6) / 0.4))
        el.style.opacity = la.toFixed(2)
        el.style.visibility = la > 0.01 ? 'visible' : 'hidden'
        if (u >= 1) { fail.o.visible = false; el.style.visibility = 'hidden' }
      }
      group.visible = hover.o.visible || plan.o.visible || fail.o.visible
    },
    dispose() { geo.dispose(); for (const r of [hover, plan, fail]) r.m.dispose(); wrap.remove(); group.removeFromParent() },
  }
}
