// Page-facing helpers that are independent of the frame loop: ring rectangle for the loader morph, PNG snapshot.
import * as THREE from 'three'
import { RING } from './layout.js'

export function createExtras({ studio, camera, canvas, fx, getTime, isReduced }) {
  const pts = []
  for (let i = 0; i < 48; i++) for (let k = 0; k < 2; k++) pts.push(new THREE.Vector3())
  const _v = new THREE.Vector3()

  function ringRect() {
    camera.updateMatrixWorld(true)
    studio.ring.updateMatrixWorld(true)
    const r = canvas.getBoundingClientRect()
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (let i = 0; i < 48; i++) {
      const a = (i / 48) * Math.PI * 2
      for (let k = 0; k < 2; k++) {
        const rr = RING.radius + (k ? -RING.tube : RING.tube)
        _v.set(Math.cos(a) * rr, Math.sin(a) * rr, 0).applyMatrix4(studio.ring.matrixWorld).project(camera)
        if (_v.z > 1 || _v.z < -1) return null // behind the camera / clipped
        const x = r.left + (_v.x * 0.5 + 0.5) * r.width, y = r.top + (-_v.y * 0.5 + 0.5) * r.height
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y)
      }
    }
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
  }

  async function snapshot({ flash = true } = {}) {
    if (flash && !isReduced()) {
      const t0 = performance.now()
      await new Promise((res) => {
        const tick = () => {
          const u = Math.min(1, (performance.now() - t0) / 300)
          studio.setFlash(0.9 * Math.sin(Math.PI * u))
          if (u >= 1) res(); else requestAnimationFrame(tick)
        }
        tick()
      })
      studio.setFlash(0)
    }
    fx.render(0, getTime()) // render + capture in the same task: the drawing buffer is still valid
    return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('snapshot failed'))), 'image/png'))
  }

  return { getRingScreenRect: ringRect, snapshot }
}
