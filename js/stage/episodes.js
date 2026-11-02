// Episode dots inside trained cells + ghost trajectory arcs to the cup (chapter 'data').
import * as THREE from 'three'
import { CELLS, HELD_OUT, TOTAL_EPISODES, episodesPerCell, cellOfEpisode } from './protocol.js'
import { GRID, CUP, cellCenter, TABLE_Y } from './layout.js'
import { TEAL } from './grid.js'
import { PAL, mixL, isLightPal } from './palette.js'
import { buildNoodleMesh } from './props.js'

// Round 8 (flight.html only: the default page has no #fl-hud, so its arcs are untouched). Seen from above at the 160 landing the
// arcs rain over the whole frame as bright teal lines; in the flight they are the same 160 trajectories, one per recorded
// episode, but warm-white like the grid at rest, about a third as bright, with the apex (nearest the camera, longest on
// screen) the faintest, and the newest one a gentle pulse rather than a 1.9x flare.
const CALM = typeof document !== 'undefined' && !!document.getElementById('fl-hud')
const CALM_COL = [1, 0.9, 0.76]
const CALM_OPACITY = 0.55

const COLS = 5
const ROWS = 4
const PER = COLS * ROWS

function rng(seed) { // small deterministic PRNG so arcs are stable across reloads
  let s = seed >>> 0
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 }
}

// Stage B "lane": each recorded episode lands as a small noodle in its cell (20 per trained cell, none in B2). The counts are
// real; positions and the one shared orientation are illustrative (the page's note says so). Per cell 4 lanes (along x) x 5
// deep (along z), tube axis along z: from the C side at table height the lanes run away from the camera, through the gap
// at B2, like the demos_b_lane still.
const LANES = 4, DEEP = 5
const LANE_R = 0.0047, LANE_LEN = 0.0185 // the real noodle is r 22 mm x 60 mm: this is a scale token, not a size claim
const DROP_S = 0.25

/** @param {THREE.Scene} scene @param {{ lane?: boolean }} [o] lane: false = the old episode dots (?off=lane, ?legacy) */
export function createEpisodes(scene, { lane = true } = {}) {
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
  // --- lane noodles (built even when off: one instanced program, compiled at load like everything else) ---
  const proto = buildNoodleMesh()
  const nMat = proto.material.clone()
  nMat.emissiveIntensity = 0.03
  const noodles = new THREE.InstancedMesh(proto.geometry, nMat, trained.length * PER)
  noodles.castShadow = true
  noodles.receiveShadow = true
  noodles.frustumCulled = false
  noodles.visible = false
  const slot = [] // rest position per instance
  const sLane = (GRID.d - 0.006) / LANES, sDeep = (GRID.w - 0.006 - 0.008) / DEEP
  trained.forEach((id, ci) => {
    const c = cellCenter(id)
    for (let k = 0; k < PER; k++) {
      const ln = k % LANES, row = Math.floor(k / LANES)
      slot.push(new THREE.Vector3(c.x + (ln - (LANES - 1) / 2) * sLane, TABLE_Y + LANE_R, c.z + ((DEEP - 1) / 2 - row) * sDeep))
    }
  })
  const dropT = new Float32Array(trained.length * PER).fill(1)
  const _q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2), _s = new THREE.Vector3(), _p = new THREE.Vector3()
  const ZERO = new THREE.Vector3(0, 0, 0)
  const NS = new THREE.Vector3(LANE_LEN / 0.06, LANE_R / 0.022, LANE_R / 0.022) // geometry is the full-size noodle, axis on x
  const writeNoodle = (i) => {
    if (!lit[i]) { m4.compose(slot[i], _q, ZERO); noodles.setMatrixAt(i, m4); return }
    const u = dropT[i], e = 1 - (1 - u) * (1 - u) * (1 - u)
    _p.copy(slot[i]); _p.y += (1 - e) * 0.03
    _s.copy(NS).multiplyScalar(0.6 + 0.4 * e)
    m4.compose(_p, _q, _s); noodles.setMatrixAt(i, m4)
  }
  group.add(noodles)
  let shadowDirty = false // instance moves are invisible to stage.js's shadow gate (it compares object matrices)
  let landed = [] // cells that received a noodle this frame (the grid ticks their outlines)
  const flash = new Float32Array(trained.length * PER)
  const lit = new Uint8Array(trained.length * PER)
  for (let i = 0; i < slot.length; i++) writeNoodle(i) // all empty to start
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
        const a0 = on ? (CALM ? (isNew ? 0.5 : 0.16 - 0.07 * Math.sin(Math.PI * t)) * boost * 0.65 : isNew ? 1.9 : (0.16 + 0.1 * Math.sin(Math.PI * t)) * boost) : 0
        if (CALM) col.setRGB(CALM_COL[0], CALM_COL[1], CALM_COL[2])
        else col.copy(PAL.arc).lerp(PAL.accent, t * t).multiplyScalar(Math.max(1, a0 > 1 ? a0 : 1))
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
        if (on && !lit[i]) { changed.push(i); newly++; landed.push(id) }
        lit[i] = on
        dropT[i] = on ? dropT[i] : 1
      }
    })
    if (newly > 0 && newly <= 8) for (const i of changed) { flash[i] = 1; dropT[i] = 0 } // a scrub jump fills in place
    for (let i = 0; i < lit.length; i++) writeNoodle(i)
    noodles.instanceMatrix.needsUpdate = true
    shadowDirty = true
    if (count !== shownCount) {
      paintArcs(count, count > 0 && count > shownCount ? count - 1 : -1)
      lastNew = count - 1
      shownCount = count
      paintedStamp = PAL.stamp
    }
  }

  function update(dt, { dotsAlpha, arcsAlpha, count }) {
    landed = []
    group.visible = dotsAlpha > 0.01 || arcsAlpha > 0.01
    if (!group.visible) return
    if (count !== shownCount) setCount(count)
    else if (paintedStamp !== PAL.stamp) { paintArcs(count, lastNewest); paintedStamp = PAL.stamp } // theme changed
    if (lane) {
      dots.visible = false
      noodles.visible = dotsAlpha > 0.5 && count > 0
      let moving = false
      for (let i = 0; i < dropT.length; i++) if (dropT[i] < 1) { dropT[i] = Math.min(1, dropT[i] + dt / DROP_S); writeNoodle(i); moving = true }
      if (moving) { noodles.instanceMatrix.needsUpdate = true; shadowDirty = true }
    } else noodles.visible = false
    const light = isLightPal()
    if (arcMat.userData.light !== light) { arcMat.userData.light = light; arcMat.blending = light ? THREE.NormalBlending : THREE.AdditiveBlending; arcMat.needsUpdate = true }
    dotMat.opacity = dotsAlpha
    arcMat.opacity = CALM ? arcsAlpha * CALM_OPACITY : arcsAlpha
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
    group, update, setCount, noodles,
    /** Cells that received a noodle in the last update (for the grid's outline tick). */
    get landed() { return landed },
    /** True once after the noodles changed (stage.js redraws the key shadow). */
    takeShadowDirty() { const d = shadowDirty && noodles.visible; shadowDirty = false; return d },
    dispose() {
      dotGeo.dispose(); dotMat.dispose(); arcGeo.dispose(); arcMat.dispose(); dots.dispose(); proto.geometry.dispose(); nMat.dispose(); noodles.dispose()
    },
  }
}
