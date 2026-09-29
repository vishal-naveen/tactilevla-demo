// Scene-mode parameters on critically damped springs. Overlay parameters (grid lines, fills, dots, labels...) that are
// fading IN wait until the camera has landed (+ a beat) so nothing pops in mid-flight; fading OUT is immediate.
import { PARAM_KEYS } from './modes.js'

export const OVERLAY_KEYS = new Set(['line', 'fill', 'label', 'cross', 'dim', 'pulse', 'dots', 'arcs', 'path'])
const OMEGA_OVERLAY = 7
const OMEGA_MOOD = 3.6

export function createParams(mode) {
  const v = {}
  const vel = {}
  for (const k of PARAM_KEYS) { v[k] = mode[k] ?? 0; vel[k] = 0 }
  return { v, vel }
}

/** Exact critically damped step: returns [x', v']. */
function spring(x, vel, target, omega, dt) {
  const e = Math.exp(-omega * dt)
  const d = x - target
  const t = (vel + omega * d) * dt
  return [target + (d + t) * e, (vel - omega * t) * e]
}

/** @param gateOpen  whether fade-ins are allowed to start (camera landed + delay) */
export function stepParams(P, mode, dt, { gateOpen, reduced }) {
  for (const k of PARAM_KEYS) {
    const target = mode[k] ?? 0
    if (reduced) { P.v[k] = target; P.vel[k] = 0; continue }
    const overlay = OVERLAY_KEYS.has(k)
    if (overlay && !gateOpen && target > P.v[k]) { P.vel[k] = 0; continue }
    const [x, v] = spring(P.v[k], P.vel[k], target, overlay ? OMEGA_OVERLAY : OMEGA_MOOD, dt)
    P.v[k] = Math.abs(x - target) < 1e-4 ? target : x
    P.vel[k] = v
  }
}
