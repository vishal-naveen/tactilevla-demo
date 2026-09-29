// Motion plans: baked joint-space waypoints (plans.json) loaded at boot, with live IK as the fallback.
// Regenerate with js/stage/tools/bake.html whenever layout.js or the choreography in tasks.js changes.
import * as THREE from 'three'
import { CELLS } from './protocol.js'
import { GRID, CUP, NOODLE, cellCenter, noodleYaw } from './layout.js'
import { solveTask, PLAN_VERSION } from './tasks.js'

export const HOME_TARGET = [0.19, 0.17, 0]
const PLANS_URL = new URL('./plans.json', import.meta.url).href

/** FNV-1a over everything the solved waypoints depend on. */
export function layoutHash(grasp) {
  const r = (v) => Math.round(v * 1e5) / 1e5
  const src = JSON.stringify({
    v: PLAN_VERSION, GRID, CUP, NOODLE, HOME_TARGET, grasp: grasp ? [...grasp.local.map(r), r(grasp.theta)] : null,
    cells: CELLS.map((c) => [...cellCenter(c).toArray().map(r), r(noodleYaw(c))]),
  })
  let h = 0x811c9dc5
  for (let i = 0; i < src.length; i++) { h ^= src.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return h.toString(16)
}

export function solveHome(ik) {
  const s = ik.solve(new THREE.Vector3(...HOME_TARGET), { maxTilt: 1.0, weights: [0.1, 0.04, 0.015] })
  return [...s.q, 0, 0.35].map((v) => Math.round(v * 1e4) / 1e4)
}

/** Everything IK produces, as plain JSON-able data. */
export async function solveAll(ik, onProgress = () => {}) {
  const idle = () => new Promise((r) => setTimeout(r, 0))
  const homeQ = solveHome(ik)
  const specs = {}
  const order = ['B2', 'A2', ...CELLS.filter((c) => c !== 'B2' && c !== 'A2')]
  for (let i = 0; i < order.length; i++) {
    specs[order[i]] = solveTask(ik, homeQ, order[i])
    onProgress((i + 1) / order.length)
    await idle() // keep the loader ring animating
  }
  return { hash: layoutHash(ik.rig.grasp), homeQ, specs }
}

/** @returns {Promise<{homeQ:number[], specs:Record<string,any>, source:'baked'|'live'}>} */
export async function loadPlans(ik, onProgress = () => {}) {
  try {
    const res = await fetch(PLANS_URL)
    if (res.ok) {
      const data = await res.json()
      if (data.hash === layoutHash(ik.rig.grasp) && CELLS.every((c) => data.specs?.[c]?.knots?.length)) {
        return { homeQ: data.homeQ, specs: data.specs, source: 'baked' }
      }
    }
  } catch { /* fall through to live IK */ }
  console.info('stage: baked plans missing or stale, solving IK live (run js/stage/tools/bake.html to regenerate)')
  const live = await solveAll(ik, onProgress)
  return { homeQ: live.homeQ, specs: live.specs, source: 'live' }
}
