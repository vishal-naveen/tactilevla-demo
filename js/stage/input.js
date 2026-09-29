// Pointer parallax, sandbox hover/click picking, and the OrbitControls hand-off.
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { TABLE_Y, cellAtPoint } from './layout.js'

export function createInput({ canvas, camera, grid, camRig, getChapter, onClick, onTable, onHover }) {
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -TABLE_Y)
  const hitP = new THREE.Vector3()
  const ray = new THREE.Raycaster()
  const ndc = new THREE.Vector2()
  const controls = new OrbitControls(camera, canvas)
  controls.enabled = false
  controls.enableDamping = true
  controls.dampingFactor = 0.08
  controls.enablePan = false
  controls.minDistance = 0.4
  controls.maxDistance = 1.5
  controls.minPolarAngle = 0.3
  controls.maxPolarAngle = 1.42
  controls.minAzimuthAngle = Math.PI / 2 - 1.1
  controls.maxAzimuthAngle = Math.PI / 2 + 1.1
  controls.rotateSpeed = 0.6
  // OrbitControls writes an inline `touch-action: none` on the canvas, which beats the stylesheet's `pan-y`.
  // On iPad the canvas is exposed beside the text panels, so every touch that started on it was swallowed
  // and the page could not scroll. Keep vertical panning native (horizontal drags and pinch still orbit/zoom).
  const keepScrollable = () => { canvas.style.touchAction = 'pan-y' }
  keepScrollable()
  let active = false // controls currently own the camera
  let down = null
  let hoverOn = false

  const pick = (e) => {
    const r = canvas.getBoundingClientRect()
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
    ray.setFromCamera(ndc, camera)
    const hit = ray.intersectObjects(grid.pickables, false)[0]
    return hit ? hit.object.userData.cell : null
  }

  // the table-plane point under the pointer (within the lit pool), or null
  const pickPoint = (e) => {
    const r = canvas.getBoundingClientRect()
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
    ray.setFromCamera(ndc, camera)
    if (!ray.ray.intersectPlane(plane, hitP)) return null
    return Math.hypot(hitP.x - 0.3, hitP.z) < 0.85 ? { x: hitP.x, z: hitP.z } : null
  }

  const onMove = (e) => {
    camRig.pointer.set((e.clientX / window.innerWidth) * 2 - 1, -((e.clientY / window.innerHeight) * 2 - 1))
    if (getChapter() !== 'sandbox' || e.target !== canvas) {
      if (hoverOn) { grid.setHover(null); canvas.style.cursor = ''; hoverOn = false; onHover?.(null) }
      return
    }
    const c = pick(e)
    grid.setHover(c)
    const pt = pickPoint(e)
    onHover?.(pt)
    hoverOn = !!pt || !!c
    canvas.style.cursor = c ? 'pointer' : pt ? 'crosshair' : ''
  }
  const onDown = (e) => { down = { x: e.clientX, y: e.clientY, t: performance.now() } }
  const onUp = (e) => {
    if (!down || getChapter() !== 'sandbox' || e.target !== canvas) { down = null; return }
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y)
    const dtMs = performance.now() - down.t
    down = null
    if (moved > 6 || dtMs > 500) return
    const c = pick(e)
    const pt = pickPoint(e)
    if (pt) onTable?.(pt, cellAtPoint(pt.x, pt.z))
    if (c) onClick(c)
  }
  window.addEventListener('pointermove', onMove, { passive: true })
  canvas.addEventListener('pointerdown', onDown)
  canvas.addEventListener('pointerup', onUp)

  return {
    controls,
    get active() { return active },
    /** Give OrbitControls the camera (called once the sandbox shot has settled). */
    engage(look) {
      if (active) return
      controls.maxDistance = Math.max(1.5, camera.position.distanceTo(look) * 1.5)
      controls.target.copy(look)
      controls.enabled = true
      keepScrollable()
      controls.update()
      active = true
    },
    release() {
      if (!active) return
      controls.enabled = false
      active = false
      grid.setHover(null)
      onHover?.(null)
      canvas.style.cursor = ''
    },
    update() { if (active) controls.update() },
    dispose() {
      window.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointerup', onUp)
      controls.dispose()
    },
  }
}
