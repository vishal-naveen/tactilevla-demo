// Episode dots inside trained cells + ghost trajectory arcs to the cup (chapter 'data').
import * as THREE from 'three'
import { CELLS, HELD_OUT, TOTAL_EPISODES, episodesPerCell, cellOfEpisode } from './protocol.js'
import { GRID, CUP, cellCenter, TABLE_Y } from './layout.js'
import { TEAL } from './grid.js'
import { PAL, mixL, isLightPal } from './palette.js'

const COLS = 5
const ROWS = 4
const PER = COLS * ROWS

function rng(seed) { // small deterministic PRNG so arcs are stable across reloads
  let s = seed >>> 0
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 }
}

export function createEpisodes(scene) {
  const group = new THREE.Group()
  scene.add(group)
  const trained = CELLS.filter((c) => c !== HELD_OUT)
  const cellIndex = Object.fromEntries(trained.map((c, i) => [c, i]))

  // --- dots ---
  const dotGeo = new THREE.CircleGeometry(0.0034, 14)
  dotGeo.rotateX(-Math.PI / 2)
  const dotMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, toneMapped: false })
  const dots = new THREE.InstancedMesh(dotGeo, dotMat, trained.length * PER)
  dots.frustumCulled = false
  dots.renderOrder = 4
  const dotPos = []
  const m4 = new THREE.Matrix4()
  const sx = (GRID.w - 0.03) / (COLS - 1)
  const sz = (GRID.d - 0.03) / (ROWS - 1)
  trained.forEach((id, ci) => {
    const c = cellCenter(id)
    for (let k = 0; k < PER; k++) {
      const col = k % COLS
      const row = Math.floor(k / COLS)
      const z = c.z + ((COLS - 1) / 2 - col) * sx // first column on the A side (+z)
      const x = c.x + (row - (ROWS - 1) / 2) * sz
      m4.makeTranslation(x, TABLE_Y + 0.0022, z)
      dots.setMatrixAt(ci * PER + k, m4)
      dotPos.push(new THREE.Vector3(x, TABLE_Y + 0.0022, z))
      dots.setColorAt(ci * PER + k, new THREE.Color(0, 0, 0))
    }
  })
  dots.instanceMatrix.needsUpdate = true
  group.add(dots)
  const flash = new Float32Array(trained.length * PER)
  const lit = new Uint8Array(trained.length * PER)
  const col = new THREE.Color()

  // --- ghost arcs: one per recorded episode ---
  const SEG = 28
  const arcCount = TOTAL_EPISODES
  const positions = new Float32Array(arcCount * SEG * 2 * 3)
  const colors = new Float32Array(arcCount * SEG * 2 * 4) // rgba: alpha carries the intensity, so glow (additive) and ink (normal) both work
  const rand = rng(1234)
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c1 = new THREE.Vector3()
  const perCellSeen = Object.fromEntries(trained.map((c) => [c, 0]))
  const arcEpisodeLit = []
  for (let e = 0; e < arcCount; e++) {
    const id = cellOfEpisode(e)
    const c = cellCenter(id)
    const k = perCellSeen[id]++
    a.set(c.x + (rand() - 0.5) * 0.028, TABLE_Y + 0.02, c.z + (rand() - 0.5) * 0.04)
    b.set(CUP.x + (rand() - 0.5) * 0.035, TABLE_Y + 0.08 + rand() * 0.02, CUP.z + (rand() - 0.5) * 0.035)
    const lift = 0.13 + rand() * 0.07 + 0.05 * (k / 5)
    c1.set((a.x + b.x) / 2 + (rand() - 0.5) * 0.03, lift * 2 - 0.02, (a.z + b.z) / 2 + (rand() - 0.5) * 0.03)
    let prev = null
    for (let s = 0; s <= SEG; s++) {
      const t = s / SEG
      const u = 1 - t
      const px = u * u * a.x + 2 * u * t * c1.x + t * t * b.x
      const py = u * u * a.y + 2 * u * t * c1.y + t * t * b.y
      const pz = u * u * a.z + 2 * u * t * c1.z + t * t * b.z
      if (prev) {
        const o = (e * SEG + (s - 1)) * 6
        positions.set([prev[0], prev[1], prev[2], px, py, pz], o)
      }
      prev = [px, py, pz]
    }
  }
  const arcGeo = new THREE.BufferGeometry()
  arcGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  const colAttr = new THREE.BufferAttribute(colors, 4)
  colAttr.setUsage(THREE.DynamicDrawUsage)
  arcGeo.setAttribute('color', colAttr)
  const arcMat = new THREE.LineBasicMaterial({
    vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, opacity: 0,
  })
  const arcs = new THREE.LineSegments(arcGeo, arcMat)
  arcs.frustumCulled = false
  arcs.renderOrder = 5
  group.add(arcs)

  let shownCount = -1
  let lastNew = -1
  let paintedStamp = -1
  let lastNewest = -1
  const WHITE = new THREE.Color(1, 1, 1)

  function paintArcs(count, newest) {
    lastNewest = newest
    const boost = mixL(1, 3.6) // ink needs more opacity than glow
    for (let e = 0; e < arcCount; e++) {
      const on = e < count
      const isNew = e === newest
      for (let s = 0; s < SEG; s++) {
        const t = (s + 0.5) / SEG
        const o = (e * SEG + s) * 8
        const a0 = on ? (isNew ? 1.9 : (0.16 + 0.1 * Math.sin(Math.PI * t)) * boost) : 0
        col.copy(PAL.arc).lerp(PAL.accent, t * t).multiplyScalar(Math.max(1, a0 > 1 ? a0 : 1))
        const al = Math.min(1, a0)
        colors[o] = colors[o + 4] = col.r
        colors[o + 1] = colors[o + 5] = col.g
        colors[o + 2] = colors[o + 6] = col.b
        colors[o + 3] = colors[o + 7] = al
      }
    }
    colAttr.needsUpdate = true
  }

  function setCount(count) {
    const per = episodesPerCell(count)
    let newly = 0
    const changed = []
    trained.forEach((id, ci) => {
      for (let k = 0; k < PER; k++) {
        const i = ci * PER + k
        const on = k < per[id] ? 1 : 0
        if (on && !lit[i]) { changed.push(i); newly++ }
        lit[i] = on
      }
    })
    if (newly > 0 && newly <= 8) for (const i of changed) flash[i] = 1
    if (count !== shownCount) {
      paintArcs(count, count > 0 && count > shownCount ? count - 1 : -1)
      lastNew = count - 1
      shownCount = count
      paintedStamp = PAL.stamp
    }
  }

  function update(dt, { dotsAlpha, arcsAlpha, count }) {
    group.visible = dotsAlpha > 0.01 || arcsAlpha > 0.01
    if (!group.visible) return
    if (count !== shownCount) setCount(count)
    else if (paintedStamp !== PAL.stamp) { paintArcs(count, lastNewest); paintedStamp = PAL.stamp } // theme changed
    const light = isLightPal()
    if (arcMat.userData.light !== light) { arcMat.userData.light = light; arcMat.blending = light ? THREE.NormalBlending : THREE.AdditiveBlending; arcMat.needsUpdate = true }
    dotMat.opacity = dotsAlpha
    arcMat.opacity = arcsAlpha
    const glow = mixL(2.0, 1.0), pop = mixL(5, 0.6)
    for (let i = 0; i < lit.length; i++) {
      flash[i] = Math.max(0, flash[i] - dt * 2.2)
      if (lit[i]) col.copy(TEAL).multiplyScalar(glow + flash[i] * pop).lerp(PAL.accent, flash[i] * 0.5)
      else if (light) col.copy(TEAL).lerp(WHITE, 0.8) // empty slots: pale on a light table
      else col.copy(TEAL).multiplyScalar(0.12)
      dots.setColorAt(i, col)
    }
    dots.instanceColor.needsUpdate = true
  }

  return {
    group, update, setCount,
    dispose() {
      dotGeo.dispose(); dotMat.dispose(); arcGeo.dispose(); arcMat.dispose(); dots.dispose()
    },
  }
}
