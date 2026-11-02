// 3x3 workspace grid: glowing tile outlines, B2 hatch, labels, hover picking.
import * as THREE from 'three'
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js'
import { CELLS, HELD_OUT } from './protocol.js'
import { GRID, cellCenter, TABLE_Y } from './layout.js'

const B2_LONG = 'B2 \u00b7 held out'
import { PAL, mixL, isLightPal } from './palette.js'
export const TEAL = PAL.trained // live theme colours (see palette.js)
export const AMBER = PAL.held
const Y = TABLE_Y + 0.0012
// Keep the perceived strength of the tile fill constant across themes: a brighter 'trained' colour gets less alpha.
const STUDIO_TRAINED_LUM = 0.36
function fillNorm() { const c = PAL.trained; return Math.min(1, STUDIO_TRAINED_LUM / (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b + 1e-3)) }

const fillVert = /* glsl */ `varying vec2 vP; varying vec2 vW; void main(){ vP = position.xz; vW = (modelMatrix*vec4(position,1.0)).xz; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`
// round 11 (flight only, uLight > 0; the default page keeps uLight 0 = the exact old output): each cell is LIGHT thrown on
// the table by a projector over the grid, not a UI rectangle: a hot spot over the grid centre falling off to its edge, a
// soft body brighter at the cell centre, a bright inner edge that blooms inward, a faint pixel structure, warmer colour
const fillFrag = /* glsl */ `
uniform vec3 uColor; uniform float uAlpha; uniform float uHatch; uniform float uTime; uniform float uBoost; uniform float uDraw; uniform vec2 uSize;
uniform float uLight; uniform vec2 uGridC;
varying vec2 vP; varying vec2 vW;
vec4 lightCell(vec4 base){
  vec2 hs = uSize * 0.5;
  float d = max(0.0, min(hs.x - abs(vP.x), hs.y - abs(vP.y))); // metres to the cell edge
  float glow = exp(-d / 0.006) * 0.7 + exp(-d / 0.02) * 0.3; // round 11b: no stroke, light bleeding inward
  float body = 0.3 + 0.7 * (1.0 - smoothstep(0.0, 1.2, length(vP / hs))); // falls off from the cell centre
  float fall = 1.0 - 0.5 * smoothstep(0.03, 0.26, length(vW - uGridC)); // the projector's hot spot over the grid centre
  float px = 0.93 + 0.07 * smoothstep(0.25, 0.5, abs(fract(vW.x * 520.0) - 0.5)) ; // faint projector pixel rows
  vec3 c = mix(base.rgb, vec3(1.0, 0.93, 0.82) * max(max(base.r, base.g), base.b), 0.58); // mostly warm light, a hint of the cell's colour
  float a = min(1.0, base.a * ((uHatch > 0.5 ? 0.5 : 0.75) * body * px + 3.0 * glow) * fall); // light on the surface, not a slab; B2's hatch is already dense
  return vec4(c * (1.0 + 0.9 * glow), a);
}
void main(){
  float a = uAlpha;
  float h = 0.0;
  float edge = 0.0;
  if (uHatch > 0.5) {
    float s = (vP.x + vP.y) * 150.0;
    h = smoothstep(0.32, 0.5, abs(fract(s) - 0.5) * 2.0);
    h = 1.0 - h;
    // Stage B draw-on: the stripes appear along the cell's diagonal, led by a brighter front (uDraw 1 = fully drawn)
    float g = (vP.x / uSize.x + vP.y / uSize.y) * 0.5 + 0.5;
    float shown = 1.0 - smoothstep(uDraw * 1.1 - 0.1, uDraw * 1.1, g);
    edge = h * shown * (1.0 - smoothstep(0.0, 0.12, uDraw * 1.1 - g)) * step(uDraw, 0.999);
    a = uAlpha * (0.55 * shown + 0.9 * h * shown);
  }
  vec4 o = vec4(uColor * (1.0 + uBoost + 2.5 * edge), a);
  if (uLight > 0.0) o = mix(o, lightCell(o), uLight);
  gl_FragColor = o;
}`

function outlineGeometry(w, d, lw) {
  const s = new THREE.Shape()
  s.moveTo(-d / 2, -w / 2); s.lineTo(d / 2, -w / 2); s.lineTo(d / 2, w / 2); s.lineTo(-d / 2, w / 2); s.closePath()
  const h = new THREE.Path()
  const dd = d / 2 - lw, ww = w / 2 - lw
  h.moveTo(-dd, -ww); h.lineTo(-dd, ww); h.lineTo(dd, ww); h.lineTo(dd, -ww); h.closePath()
  s.holes.push(h)
  const g = new THREE.ShapeGeometry(s)
  g.rotateX(-Math.PI / 2)
  return g
}

function crossGeometry(len, lw) {
  const a = new THREE.PlaneGeometry(len, lw)
  const b = new THREE.PlaneGeometry(lw, len)
  const merged = new THREE.BufferGeometry()
  const pos = []
  for (const g of [a, b]) {
    const ni = g.toNonIndexed()
    pos.push(...ni.attributes.position.array)
  }
  merged.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  merged.rotateX(-Math.PI / 2)
  return merged
}

const LAYOUT_RANK = { A1: 1, B1: 2, C1: 3, C2: 4, A2: 5, A3: 6, B3: 7, C3: 8, B2: 9 }

// Round 6 (flight.html only; the default page never calls setGridTone, so both stay 1 = the colours above, unchanged):
// colour is reserved for events. At rest the grid is thin, low-contrast warm-white projected light; `teal` brings the
// trained cells' colour back in their moment (eight cells teach, the 160 landing, the sandbox), `held` B2's amber in its
// own (the held-out reveal, the test). Uniform / colour values only: no program changes.
const tone = { teal: 1, held: 1 }
const WARM = new THREE.Color(1.0, 0.93, 0.82)
/** @param {number} teal 0..1  @param {number} held 0..1 */
export function setGridTone(teal, held) { tone.teal = Math.min(1, Math.max(0, teal)); tone.held = Math.min(1, Math.max(0, held)) }
// round 11 (flight only; the default page never calls it): 0..1 = how far the cells are projected light (fill shader uLight,
// softer outline, printed labels). A uniform + a label class: no program changes.
const style = { light: 0 }
/** @param {number} k 0..1 */
export function setGridStyle(k) { style.light = Math.min(1, Math.max(0, k)) }

export function createGrid(scene) {
  const group = new THREE.Group()
  scene.add(group)
  const cw = GRID.d - GRID.gap // extent along x
  const cd = GRID.w - GRID.gap // extent along z
  const cells = {}
  const pickables = []
  const fillGeo = new THREE.PlaneGeometry(cw, cd)
  fillGeo.rotateX(-Math.PI / 2)
  const outlineGeo = outlineGeometry(cd, cw, 0.0022)
  const crossGeo = crossGeometry(0.014, 0.0016)

  for (const id of CELLS) {
    const held = id === HELD_OUT
    const color = held ? AMBER : TEAL
    const c = cellCenter(id)
    const g = new THREE.Group()
    g.position.set(c.x, Y, c.z)
    group.add(g)

    const fillMat = new THREE.ShaderMaterial({
      vertexShader: fillVert, fragmentShader: fillFrag, transparent: true, depthWrite: false,
      uniforms: {
        uColor: { value: color.clone() }, uAlpha: { value: held ? 0.34 : 0.12 }, uHatch: { value: held ? 1 : 0 },
        uTime: { value: 0 }, uBoost: { value: 0 }, uDraw: { value: 1 }, uSize: { value: new THREE.Vector2(cw, cd) },
        uLight: { value: 0 }, uGridC: { value: new THREE.Vector2(GRID.x0 + 1.5 * GRID.d, 0) },
      },
      toneMapped: false,
    })
    const fill = new THREE.Mesh(fillGeo, fillMat)
    fill.renderOrder = 2
    fill.userData.cell = id
    g.add(fill)
    pickables.push(fill)

    const lineMat = new THREE.MeshBasicMaterial({
      color: color.clone().multiplyScalar(held ? 3.4 : 3.0), transparent: true, opacity: held ? 0.9 : 0.75,
      depthWrite: false, toneMapped: false,
    })
    const outline = new THREE.Mesh(outlineGeo, lineMat)
    outline.position.y = 0.0004
    outline.renderOrder = 3
    g.add(outline)
    const cross = new THREE.Mesh(crossGeo, lineMat)
    cross.position.y = 0.0004
    cross.renderOrder = 3
    g.add(cross)

    // label (CSS2D): a zero-size wrapper sits at the anchor inside the cell; the pill hangs off it (see placeLabel)
    const wrap = document.createElement('div')
    wrap.style.cssText = 'width:0;height:0'
    const el = document.createElement('div')
    el.className = 'stage-label' + (held ? ' stage-label--held' : '')
    el.textContent = held ? B2_LONG : id
    el.style.cssText = 'position:absolute;left:0;top:0;opacity:0;transform:translate(0,-50%)'
    wrap.append(el)
    const label = new CSS2DObject(wrap)
    label.position.set(cw * 0.3, 0.006, cd * 0.4)
    g.add(label)

    cells[id] = { tick: 0, id, held, group: g, fillMat, lineMat, cross, outline, label, el, wrap, base: { fill: fillMat.uniforms.uAlpha.value, line: lineMat.opacity }, hover: 0, hoverT: 0, active: 0, lx: cw * 0.2, lz: cd * 0.3, zSide: 1, cw, cd }
  }

  // tap feedback: a ring that blooms out of the clicked cell
  const rippleMat = new THREE.MeshBasicMaterial({ color: TEAL.clone().multiplyScalar(3.2), transparent: true, opacity: 0, depthWrite: false, toneMapped: false, blending: THREE.AdditiveBlending })
  const ripple = new THREE.Mesh(new THREE.RingGeometry(0.9, 1, 64).rotateX(-Math.PI / 2), rippleMat)
  ripple.visible = false
  ripple.renderOrder = 6
  group.add(ripple)
  let rippleT = 1

  let time = 0
  let hovered = null
  const _c = new THREE.Color()

  const _cc = new THREE.Vector3()
  const _r = new THREE.Vector3()
  /**
   * Anchor each label unambiguously INSIDE its own cell, always at the cell's screen-left / camera-side corner, so a
   * label never sits at a boundary shared with a neighbour's label. Steps aside (to the far corner) when the noodle or
   * gripper occupies the cell. The pill extends rightwards, into its own tile.
   */
  function placeLabel(cell, dt, prm) {
    const cam = prm.cameraPos
    if (!cam) return
    cellCenter(cell.id, _cc)
    const hw = cell.cd / 2 // half extent across the grid (z)
    const hd = cell.cw / 2 // half extent along the arm (x)
    // screen-left (world xz) and direction to the camera -> pick the corner that best matches "left and near"
    _r.setFromMatrixColumn(prm.cameraMatrix, 0) // camera right in world space
    const lx = -_r.x, lz = -_r.z
    const tx0 = cam.x - _cc.x, tz0 = cam.z - _cc.z
    const tl = Math.hypot(tx0, tz0) || 1
    const wx = lx + (tx0 / tl) * 0.8, wz = lz + (tz0 / tl) * 0.8
    const sx = wx >= 0 ? 1 : -1
    const sz = wz >= 0 ? 1 : -1
    let tx = sx * hd * 0.6, tz = sz * hw * 0.88
    if (prm.occupiedCell === cell.id) { tx = -sx * hd * 0.6 } // step to the far side of the tile, away from the tube
    const k = 1 - Math.exp(-dt * 10)
    cell.lx += (tx - cell.lx) * k
    cell.lz += (tz - cell.lz) * k
    cell.label.position.set(cell.lx, 0.006, cell.lz)
  }

  /** params: lineAlpha, labelAlpha, dim (0..1 others dimmed), pulse (0..1 B2 pulse), crossAlpha, hatchBoost */
  function update(dt, prm) {
    time += dt
    const lightNow = isLightPal()
    if (rippleMat.userData.light !== lightNow) { rippleMat.userData.light = lightNow; rippleMat.blending = lightNow ? THREE.NormalBlending : THREE.AdditiveBlending; rippleMat.needsUpdate = true }
    if (rippleT < 1) {
      rippleT = Math.min(1, rippleT + dt / 0.6)
      const e = 1 - Math.pow(1 - rippleT, 3)
      const r = 0.02 + 0.075 * e
      ripple.scale.set(r, 1, r)
      rippleMat.opacity = (1 - rippleT) * (1 - rippleT) * 0.9
      ripple.visible = rippleT < 1
    }
    for (const id of CELLS) {
      const cell = cells[id]
      const held = cell.held
      cell.hover += ((hovered === id ? 1 : 0) - cell.hover) * (1 - Math.exp(-dt * 12))
      cell.active += ((prm.activeCell === id ? 1 : 0) - cell.active) * (1 - Math.exp(-dt * 9))
      if (cell.active < 0.004) cell.active = 0
      placeLabel(cell, dt, prm)
      let dim = held ? 1 : 1 - prm.dim * 0.86
      // Stage B layout-in: cells step in one at a time, near row first, B2 last (prm.layout 0..1, 1 = all laid out)
      const lay = prm.layout ?? 1
      if (lay < 1) dim *= 0.2 + 0.8 * (lay * 1.08 >= LAYOUT_RANK[id] / 9 ? 1 : 0)
      const pulse = held ? 0.5 + 0.5 * Math.sin(time * 3.0) : 0
      const pAmt = held ? prm.pulse * pulse : 0
      const tk = Math.max(held ? tone.held : tone.teal, cell.hover, cell.active) // 1 = full colour (default page always)
      cell.fillMat.uniforms.uAlpha.value = (cell.base.fill * dim * (prm.fillScale ?? 1) * mixL(fillNorm(), 1.7) * (1 + pAmt * 0.9)) * (0.12 + 0.88 * tk) + cell.hover * 0.16 + cell.active * 0.2
      cell.fillMat.uniforms.uBoost.value = cell.hover * 0.5 + pAmt * 0.25
      cell.fillMat.uniforms.uLight.value = style.light
      cell.lineMat.opacity = Math.min(1, cell.base.line * dim * prm.lineAlpha * mixL(1, 2.6) * (1 + cell.hover * 0.8)) * (0.42 + 0.58 * tk)
      // dark studio: over-bright lines that bloom; light studio: plain saturated ink
      cell.fillMat.uniforms.uColor.value.copy(held ? AMBER : TEAL)
      if (held) {
        const s = mixL((2.6 + prm.pulse * (0.4 + pulse * 2.4) + cell.hover * 1.5) * 1.35, 1.0 + cell.hover * 0.25)
        cell.lineMat.color.copy(AMBER).multiplyScalar(s)
      } else {
        cell.lineMat.color.copy(TEAL).multiplyScalar(mixL(3.5 + cell.hover * 1.8, 1.0 + cell.hover * 0.3))
      }
      // at rest: warm-white light under the bloom threshold (no glow), the fill nearly gone
      if (tk < 1) { _c.copy(WARM).multiplyScalar(0.85); cell.lineMat.color.lerp(_c, 1 - tk); cell.fillMat.uniforms.uColor.value.lerp(WARM, 1 - tk) }
      if (cell.active > 0) { // the running cell: brighter outline in the accent (amber stays amber for B2)
        cell.lineMat.color.lerp(held ? AMBER : PAL.accent, cell.active * 0.7).multiplyScalar(1 + cell.active * mixL(0.25, 0.2))
        cell.lineMat.opacity = Math.min(1, cell.lineMat.opacity + cell.active * 0.5)
      }
      if (style.light > 0) cell.lineMat.opacity *= 1 - style.light // round 11b: no outline strokes at all; the fill's edge glow is the edge
      const pr = style.light > 0.5
      if (cell.print !== pr) { cell.print = pr; cell.el.classList.toggle('stage-label--print', pr); cell.lastText = null }
      if (cell.wasActive !== (cell.active > 0.5)) { cell.wasActive = cell.active > 0.5; cell.el.classList.toggle('stage-label--active', cell.wasActive) }
      if (held) cell.fillMat.uniforms.uDraw.value = prm.hatchDraw ?? 1
      else if (cell.tick > 0) { // a noodle landed: the outline ticks bright, then settles (250 ms)
        cell.tick = Math.max(0, cell.tick - dt / 0.25)
        cell.lineMat.color.multiplyScalar(1 + 1.6 * cell.tick)
        cell.lineMat.opacity = Math.min(1, cell.lineMat.opacity + 0.6 * cell.tick)
      }
      cell.cross.visible = prm.crossAlpha > 0.02
      // labels only when the projected cell is big enough to hold them: no clusters on phones / far shots
      const cellPx = prm.cellPx ?? 999
      if (held) {
        const txt = cellPx < 84 ? 'B2' : cell.print ? 'B2 HELD OUT' : B2_LONG
        if (txt !== cell.lastText) { cell.lastText = txt; cell.el.textContent = txt }
      }
      const fit = held ? (cellPx < 30 ? 0 : 1) : cellPx < 56 ? 0 : 1
      let la = prm.labelAlpha * fit * (held ? 1 : 1 - 0.8 * prm.dim) // 'test': only the B2 chip stays legible
      if (prm.narrow && !held && id !== hovered && id !== prm.activeCell) la = 0 // phones: B2 + hovered/active only
      la = Math.round(la * 100) / 100
      if (la !== cell.lastLabel) {
        cell.lastLabel = la
        cell.el.style.opacity = String(la)
        cell.el.style.visibility = la < 0.02 ? 'hidden' : 'visible'
      }
    }
  }

  return {
    group, cells, pickables, update,
    setHover(id) { hovered = id },
    /** Stage B lane: a noodle landed in this cell. */
    tick(id) { if (cells[id] && !cells[id].held) cells[id].tick = 1 },
    ripple(id) {
      const c = cells[id]
      if (!c) return
      ripple.position.set(c.group.position.x, c.group.position.y + 0.0012, c.group.position.z)
      rippleMat.color.copy(c.held ? AMBER : TEAL).multiplyScalar(mixL(3.2, 1.0))
      rippleT = 0
      ripple.visible = true
    },
    get hovered() { return hovered },
    setVisible(v) { group.visible = v },
    dispose() {
      group.traverse((o) => { if (o.isMesh) { o.geometry.dispose?.(); o.material.dispose?.() } })
      for (const id of CELLS) cells[id].wrap.remove()
    },
  }
}
