// Safe-area camera fitting. Given a viewing direction, a cloud of world points that must stay visible and a
// target rectangle in the viewport, find the closest camera distance that fits and the lens shift that centres it.
import * as THREE from 'three'

// Fractions of the viewport (origin top-left). The page's text column owns the left ~47% on landscape and the
// lower half on portrait, so the 3D subject must live in what is left.
export function safeRect(aspect) {
  return aspect < 1
    ? { x0: 0.05, x1: 0.95, y0: 0.105, y1: 0.5 }
    : { x0: 0.53, x1: 0.975, y0: 0.115, y1: 0.93 }
}

const _c = new THREE.Vector3()
const _p = new THREE.Vector3()
const _m = new THREE.Matrix4()

/** Axis-aligned centre and bounding-sphere radius of a flat xyz array. */
export function cloudBounds(pts) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < pts.length; i += 3) {
    for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], pts[i + k]); hi[k] = Math.max(hi[k], pts[i + k]) }
  }
  const c = new THREE.Vector3((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2)
  let r = 0
  for (let i = 0; i < pts.length; i += 3) r = Math.max(r, Math.hypot(pts[i] - c.x, pts[i + 1] - c.y, pts[i + 2] - c.z))
  return { c, r }
}

/**
 * @param {{dir:number[], fov:number, sphere?:boolean}} shot  dir = direction from target to camera
 * @param {Float32Array|number[]} pts  flat xyz
 * @returns {{pos:number[], look:number[], fov:number, dx:number, dy:number}}
 *   dx: fraction of the viewport width the image is shifted right; dy: fraction of the height shifted up.
 */
export function fitShot(shot, pts, aspect, margin = 0.02) {
  const R = safeRect(aspect)
  const rw = R.x1 - R.x0 - margin * 2, rh = R.y1 - R.y0 - margin * 2
  const rcx = (R.x0 + R.x1) / 2, rcy = (R.y0 + R.y1) / 2
  const tanV = Math.tan(THREE.MathUtils.degToRad(shot.fov) / 2)
  const tanH = tanV * aspect
  const dir = new THREE.Vector3(...shot.dir).normalize()
  const { c, r } = cloudBounds(pts)

  let d, cx = 0.5, cy = 0.5
  if (shot.sphere) {
    // rotation-safe: the bounding sphere must fit both ways
    const t = Math.min(rw * tanH, rh * tanV)
    d = r / Math.sin(Math.atan(t))
  } else {
    _m.lookAt(_c.copy(c).add(dir), c, new THREE.Vector3(0, 1, 0)) // camera basis (columns x,y,z)
    const right = new THREE.Vector3().setFromMatrixColumn(_m, 0)
    const up = new THREE.Vector3().setFromMatrixColumn(_m, 1)
    const fwd = dir.clone().negate()
    // view-space coords relative to the target: x along right, y along up, depth along dir (away from camera = -dir)
    const n = pts.length / 3
    const X = new Float32Array(n), Y = new Float32Array(n), Z = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      _p.set(pts[i * 3] - c.x, pts[i * 3 + 1] - c.y, pts[i * 3 + 2] - c.z)
      X[i] = _p.dot(right); Y[i] = _p.dot(up); Z[i] = _p.dot(fwd) // Z>0: farther than the target
    }
    const extent = (dist) => {
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
      for (let i = 0; i < n; i++) {
        const depth = dist + Z[i]
        if (depth < 0.05) return null
        const fx = 0.5 + X[i] / (depth * tanH) / 2
        const fy = 0.5 - Y[i] / (depth * tanV) / 2
        if (fx < x0) x0 = fx; if (fx > x1) x1 = fx
        if (fy < y0) y0 = fy; if (fy > y1) y1 = fy
      }
      return { x0, x1, y0, y1 }
    }
    d = 0.4
    let ex = extent(d)
    for (let k = 0; k < 400; k++, d *= 1.012) {
      ex = extent(d)
      if (ex && ex.x1 - ex.x0 <= rw && ex.y1 - ex.y0 <= rh) break
    }
    cx = (ex.x0 + ex.x1) / 2
    cy = (ex.y0 + ex.y1) / 2
  }
  const pos = c.clone().addScaledVector(dir, d)
  return { pos: pos.toArray(), look: c.toArray(), fov: shot.fov, dx: rcx - cx, dy: cy - rcy }
}
