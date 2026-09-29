// The table as a pool of light: a big plane whose alpha falls off radially (no hard edge), a ShadowMaterial plane so
// shadows still land, and soft blob contact shadows under the base, cup and noodle.
import * as THREE from 'three'
import { TABLE_Y, CUP } from './layout.js'

function radialTexture(stops, size = 256) {
  const c = document.createElement('canvas')
  c.width = c.height = size
  const g = c.getContext('2d')
  const gr = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  // alphaMap reads the GREEN channel, so paint an opaque greyscale ramp (white = opaque), not canvas alpha
  for (const [t, a] of stops) { const v = Math.round(255 * a); gr.addColorStop(t, `rgb(${v},${v},${v})`) }
  g.fillStyle = '#000'
  g.fillRect(0, 0, size, size)
  g.fillStyle = gr
  g.fillRect(0, 0, size, size)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.NoColorSpace
  return tex
}

const BLOB_STOPS = [[0, 1], [0.35, 0.7], [0.7, 0.22], [1, 0]]

export function createGround(scene) {
  const group = new THREE.Group()
  scene.add(group)

  // light pool: alpha 1 near the work area, gone before the edge
  // smooth cos^2 falloff: solid near the work area, dissolving long before the edge (no visible boundary)
  const fall = []
  for (let i = 0; i <= 24; i++) { const r = i / 24; const u = Math.min(1, Math.max(0, (r - 0.12) / 0.88)); fall.push([r, Math.pow(Math.cos((u * Math.PI) / 2), 2.2)]) }
  const alpha = radialTexture(fall, 512)
  const tableMat = new THREE.MeshStandardMaterial({
    color: 0x66625b, roughness: 0.72, metalness: 0, transparent: true, alphaMap: alpha, depthWrite: false,
  })
  const R = 2.6
  const table = new THREE.Mesh(new THREE.CircleGeometry(R, 96), tableMat)
  table.rotation.x = -Math.PI / 2
  table.position.set(0.5, TABLE_Y - 0.0015, 0.0)
  table.receiveShadow = true
  table.renderOrder = -2
  group.add(table)

  // shadows that outlive the visible table
  const shadowMat = new THREE.ShadowMaterial({ opacity: 0.22, transparent: true, depthWrite: false })
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(4, 3.4).rotateX(-Math.PI / 2), shadowMat)
  shadow.position.set(0.4, TABLE_Y - 0.001, 0)
  shadow.receiveShadow = true
  shadow.renderOrder = -1
  group.add(shadow)

  // blob contact shadows
  const blobTex = radialTexture(BLOB_STOPS)
  const blobGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2)
  const mkBlob = (x, z, r, o) => {
    const m = new THREE.MeshBasicMaterial({ color: 0x000000, alphaMap: blobTex, transparent: true, opacity: o, depthWrite: false })
    const mesh = new THREE.Mesh(blobGeo, m)
    mesh.scale.set(r * 2, 1, r * 2)
    mesh.position.set(x, TABLE_Y + 0.0006, z)
    mesh.renderOrder = 0
    group.add(mesh)
    return { mesh, mat: m, base: o, r }
  }
  const base = mkBlob(0.0, 0.0, 0.16, 0.5)
  const cup = mkBlob(CUP.x, CUP.z, 0.085, 0.35)
  const noodle = mkBlob(0.2, 0, 0.045, 0.4)
  noodle.mesh.visible = false

  const _p = new THREE.Vector3()
  return {
    group,
    applyTheme(tableColor, light) {
      tableMat.color.copy(tableColor)
      shadowMat.opacity = 0.22 + (0.34 - 0.22) * light // shadows carry the grounding on a bright set
      for (const b of [base, cup, noodle]) b.mat.opacity = (b === noodle ? b.mat.opacity : b.base * (1 + 0.5 * light))
    },
    /** Follow the noodle: fades with height and with its own visibility. */
    update(noodleMesh) {
      const vis = noodleMesh.visible
      noodle.mesh.visible = vis
      if (!vis) return
      noodleMesh.getWorldPosition(_p)
      const h = Math.max(0, _p.y - TABLE_Y - 0.022)
      const k = Math.max(0, 1 - h / 0.22)
      noodle.mesh.position.set(_p.x, TABLE_Y + 0.0007, _p.z)
      const s = noodle.r * 2 * (1 + h * 2.2) * noodleMesh.scale.x
      noodle.mesh.scale.set(s, 1, s)
      noodle.mat.opacity = noodle.base * k * k
    },
    dispose() {
      alpha.dispose(); blobTex.dispose(); tableMat.dispose(); shadowMat.dispose(); blobGeo.dispose()
      table.geometry.dispose(); shadow.geometry.dispose(); noodle.mat.dispose(); cup.mat.dispose(); base.mat.dispose()
    },
  }
}
