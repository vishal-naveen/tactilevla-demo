// World layout (metres, Y-up). The robot base sits at the origin, arm forward = +X,
// viewer's left (looking back at the arm from the front) = +Z, so A is +Z and C is -Z.
import * as THREE from 'three'
import { CELLS } from './protocol.js'

export const TABLE_Y = 0
export const GRID = { w: 0.12, d: 0.055, x0: 0.14, gap: 0.006 } // cell width (across, z), depth (x)
export const CUP = { x: 0.2, z: 0.245, rimR: 0.055, h: 0.045, baseR: 0.03, wall: 0.0022 }
export const NOODLE = { r: 0.022, hole: 0.008, len: 0.06 }
export const RING = { pos: new THREE.Vector3(-0.59, 0.225, 0.76), radius: 0.178, tube: 0.0085 }
export const FLOOR_Y = -0.62
export const WALL_X = -2.3

export function cellCenter(id, out = new THREE.Vector3()) {
  const i = 'ABC'.indexOf(id[0])
  const r = Number(id[1]) - 1
  return out.set(GRID.x0 + (r + 0.5) * GRID.d, TABLE_Y, (1 - i) * GRID.w)
}
export const GRID_CENTER = new THREE.Vector3(GRID.x0 + 1.5 * GRID.d, TABLE_Y, 0)
export const CELL_IDS = CELLS

/** Yaw for a tube lying at table point (x, z): tangential to the pan axis, i.e. facing the arm. */
export function noodleYawAt(x, z) {
  return Math.atan2(z, x - 0.0388) + Math.PI / 2
}

/** Which cell tile contains the table point, or null (pitch-based, so the small gaps between tiles count as inside). */
export function cellAtPoint(x, z) {
  const col = Math.floor((x - GRID.x0) / GRID.d)
  const row = Math.floor((GRID.w * 1.5 - z) / GRID.w)
  if (col < 0 || col > 2 || row < 0 || row > 2) return null
  return 'ABC'[row] + (col + 1)
}

/** Noodle yaw (axis direction) for a cell: tangential to the pan axis so the jaws close across it. */
export function noodleYaw(id) {
  const c = cellCenter(id)
  const dx = c.x - 0.0388
  const dz = c.z
  const radial = Math.atan2(dz, dx) // angle of the radial direction in the xz plane (x -> z)
  // deterministic small jitter per cell
  const jitter = (((id.charCodeAt(0) * 7 + id.charCodeAt(1) * 13) % 11) - 5) * 0.012
  return radial + Math.PI / 2 + jitter
}
