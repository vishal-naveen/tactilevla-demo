// 3D phase path: the current task's phases pinned in the scene where the gripper does them.
//  - ONE path: upcoming = a faint hairline, travelled = a bright line with a soft comet falloff behind the gripper and a
//    glowing head on the tool tip (no bloom involved: the glow is a wider translucent copy, so it is smooth, not blocky),
//  - a small node at each phase point (hollow ring -> pulse as the gripper passes -> filled dot),
//  - the phase words as billboarded CSS3D text (styled by the page via .stage-phase classes). The active word grows and
//    glows; the layout is a deterministic slot picker (fixed candidate slots, costs, sticky choice + dwell time), so words
//    never swap or jitter, stay off each other, the arm, the path, the cell labels and the page's text column.
import * as THREE from 'three'
import { CSS3DRenderer, CSS3DSprite } from 'three/addons/renderers/CSS3DRenderer.js'
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js'
import { LineMaterial } from 'three/addons/lines/LineMaterial.js'
import { PAL, mixL, isLightPal } from './palette.js'
import { HZ, PHASE_NAMES } from './tasks.js'

const N = PHASE_NAMES.length
const WORD_SCALE = 0.00046 // world metres per CSS px of the word's own layout
const LABELS = { approach: 'Approach', descend: 'Descend', grasp: 'Grasp', lift: 'Lift', carry: 'Carry', release: 'Release', return: 'Return' }
const S_ACTIVE = 1.6 // the active word leads: this much bigger than the quiet ones
const A_UP = 0.42, A_DONE = 0.6 // resting opacity of upcoming / finished words
const PULSE_S = 0.8 // a node's "gripper passed" pulse lasts this long (task seconds)
const COMET_S = 0.6 // travelled path fades from the head to its resting level over this long
const SLOT_DIRS = Array.from({ length: 12 }, (_, i) => { const a = (-Math.PI / 2) + (i * Math.PI) / 6; return [Math.cos(a), Math.sin(a)] }) // 12 directions, starting "up"
const SLOT_RINGS = [1, 1.85] // gap multipliers: near, far

// Low-specificity defaults so the page's own .stage-phase styles win without !important.
const BASE_CSS = `
:where(.stage-phase){position:relative;font:600 40px/1 var(--font-display, "Archivo", system-ui, sans-serif);font-stretch:112%;letter-spacing:.02em;
  color:var(--ivory,#ede4cf);white-space:nowrap;padding:.28em .55em;border-radius:.4em;background:rgba(10,14,20,.42);
  text-shadow:0 1px 8px rgba(0,0,0,.55);user-select:none;-webkit-user-select:none;will-change:opacity}
:where(.stage-phase--active){color:var(--noodle,#f4c430)}
:where(.stage-phase--hover){background:rgba(10,14,20,.7)}
:where(.stage-phase > i){position:absolute;left:.5em;right:.5em;bottom:.03em;height:.055em;border-radius:1em;background:var(--noodle,#f4c430);
  transform-origin:0 50%;transform:scaleX(0);opacity:0;pointer-events:none}
`
// The path is ONE camera-facing ribbon (screen-space width, one draw call, no per-segment overlap), shaded by task time:
// travelled part = bright core + soft glow with a comet falloff behind the head, upcoming part = a faint hairline.
// Analytic falloff across the width, so it is smooth at any resolution and never leans on the bloom pass.
const ribbonVert = /* glsl */ `
attribute vec3 aPrev; attribute vec3 aNext; attribute float aSide; attribute float aT;
uniform vec2 uRes; uniform float uHalfW; varying float vU; varying float vT;
void main(){
  mat4 mvp = projectionMatrix * modelViewMatrix;
  vec4 c = mvp * vec4(position, 1.0);
  vec4 p = mvp * vec4(aPrev, 1.0);
  vec4 n = mvp * vec4(aNext, 1.0);
  vec2 half_ = uRes * 0.5;
  vec2 sc = c.xy / c.w * half_;
  vec2 td = n.xy / n.w * half_ - p.xy / p.w * half_;
  float tl = length(td);
  td = tl > 1e-4 ? td / tl : vec2(1.0, 0.0);
  sc += vec2(-td.y, td.x) * aSide * uHalfW;
  gl_Position = vec4(sc / half_ * c.w, c.z, c.w);
  vU = aSide; vT = aT;
}`
const ribbonFrag = /* glsl */ `
uniform vec3 uAccent; uniform vec3 uHair; uniform float uHead; uniform float uAlpha; uniform float uFloor; uniform float uTau;
uniform float uLight; varying float vU; varying float vT;
void main(){
  float u2 = vU * vU;
  float trav = 1.0 - smoothstep(uHead - 0.05, uHead + 0.012, vT); // 1 behind the head, 0 ahead of it (soft at the head)
  float age = max(0.0, uHead - vT);
  float b = mix(1.0, uFloor + (1.0 - uFloor) * exp(-age / uTau), 1.0 - uLight);
  float core = exp(-u2 / 0.028);
  float glow = exp(-u2 / 0.32) * 0.5;
  float hair = exp(-u2 / 0.016);
  float aT = (core + glow * b) * b * mix(0.95, 0.9, uLight);
  float aU = hair * mix(0.55, 0.95, uLight);
  float a = mix(aU, aT, trav) * uAlpha;
  vec3 col = mix(uHair, uAccent, trav);
  gl_FragColor = vec4(col * mix(1.0, 1.15, trav), clamp(a, 0.0, 1.0));
}`
const nodeVert = /* glsl */ `
attribute float aA; attribute float aK; attribute float aD; attribute float aP;
uniform float uPx; uniform float uTime; varying float vA; varying float vK; varying float vD; varying float vP;
void main(){
  vA = aA; vK = aK; vD = aD; vP = aP;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = uPx * 2.1 / max(0.15, -mv.z);
  gl_Position = projectionMatrix * mv;
}`
const nodeFrag = /* glsl */ `
uniform vec3 uColor; uniform vec3 uRing; uniform float uAlpha; uniform float uLight; uniform float uTime;
varying float vA; varying float vK; varying float vD; varying float vP;
void main(){
  float d = length(gl_PointCoord - 0.5) * 2.0; // 0 centre .. 1 sprite edge
  float R0 = 0.22;
  float breathe = 0.5 + 0.5 * sin(uTime * 3.0);
  // resting ring (hollow while upcoming), fills in once the gripper has been there
  float ring = 1.0 - smoothstep(0.0, 0.05, abs(d - R0) - 0.018);
  float dot_ = 1.0 - smoothstep(R0 * 0.5, R0 * 0.66, d);
  float fill = mix(0.0, 0.85, vD) * dot_ + mix(0.35, 1.0, vK) * (1.0 - smoothstep(0.05, 0.1, d));
  // active: soft halo that breathes (analytic gaussian, so it is smooth at any resolution)
  float halo = vK * (0.28 + 0.12 * breathe) * exp(-pow(d / 0.42, 2.0));
  // the pass pulse: a ring that leaves the node and fades
  float pu = clamp(vP, 0.0, 1.0);
  float pr = mix(R0, 0.95, 1.0 - pow(1.0 - pu, 2.2));
  float pulse = step(0.0, vP) * (1.0 - pu) * (1.0 - smoothstep(0.0, 0.07, abs(d - pr) - 0.015)) * 0.9;
  float body = ring * mix(0.45, 1.0, max(vK, vD)) + fill;
  float a = clamp(body + halo + pulse, 0.0, 1.0) * vA * uAlpha * step(d, 1.0);
  vec3 c = mix(uRing, uColor, max(vK, vD * 0.7));
  c *= mix(1.0 + 0.55 * vK, 1.0, uLight);
  gl_FragColor = vec4(c, a);
}`
const headVert = /* glsl */ `
uniform float uPx; void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_PointSize = uPx; gl_Position = projectionMatrix * mv; }`
const headFrag = /* glsl */ `
uniform vec3 uColor; uniform float uAlpha; uniform float uLight;
void main(){
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float g = exp(-d * d * 5.5);
  float core = exp(-d * d * 55.0);
  vec3 c = uColor * (0.75 * g + 1.5 * core) + vec3(0.5, 0.45, 0.3) * core;
  float a = clamp(g * 0.85 + core, 0.0, 1.0) * uAlpha * step(d, 1.0);
  gl_FragColor = vec4(mix(c, uColor * 0.9, uLight), a);
}`

// critically damped spring: no overshoot, exact for any dt
function spring(o, x, v, target, omega, dt) {
  const dx = o[x] - target, c = o[v] + omega * dx, e = Math.exp(-omega * dt)
  o[x] = target + (dx + c * dt) * e
  o[v] = (o[v] - omega * c * dt) * e
}
const clamp01 = (x) => Math.min(1, Math.max(0, x))

export function createPhaseMarkers({ scene, canvas, camera, rig }) {
  if (!document.getElementById('stage-phase-base')) {
    const st = document.createElement('style')
    st.id = 'stage-phase-base'
    st.textContent = BASE_CSS
    document.head.append(st)
  }
  // ---- WebGL parts ----
  const group = new THREE.Group()
  group.visible = false
  scene.add(group)
  const leadMat = new LineMaterial({ linewidth: 0.9, transparent: true, depthWrite: false, depthTest: true, toneMapped: false, vertexColors: true })
  const ribbonMat = new THREE.ShaderMaterial({
    vertexShader: ribbonVert, fragmentShader: ribbonFrag, transparent: true, depthWrite: false, depthTest: true, toneMapped: false, side: THREE.DoubleSide,
    uniforms: {
      uRes: { value: new THREE.Vector2(1, 1) }, uHalfW: { value: 7 }, uAccent: { value: new THREE.Color() }, uHair: { value: new THREE.Color() },
      uHead: { value: 0 }, uAlpha: { value: 0 }, uFloor: { value: 0.4 }, uTau: { value: COMET_S }, uLight: { value: 0 },
    },
  })
  let ribbon = null, nSeg = 0

  const leaders = new LineSegments2(new LineSegmentsGeometry().setPositions(new Float32Array(N * 6)), leadMat)
  leaders.geometry.setColors(new Float32Array(N * 6).fill(1))
  leaders.frustumCulled = false
  leaders.renderOrder = 8
  group.add(leaders)
  const leadBuf = leaders.geometry.attributes.instanceStart.data
  const leadCol = leaders.geometry.attributes.instanceColorStart.data

  const nodeGeo = new THREE.BufferGeometry()
  const nodePos = new Float32Array(N * 3), nodeA = new Float32Array(N), nodeK = new Float32Array(N), nodeD = new Float32Array(N), nodeP = new Float32Array(N).fill(-1)
  nodeGeo.setAttribute('position', new THREE.BufferAttribute(nodePos, 3))
  nodeGeo.setAttribute('aA', new THREE.BufferAttribute(nodeA, 1))
  nodeGeo.setAttribute('aK', new THREE.BufferAttribute(nodeK, 1))
  nodeGeo.setAttribute('aD', new THREE.BufferAttribute(nodeD, 1))
  nodeGeo.setAttribute('aP', new THREE.BufferAttribute(nodeP, 1))
  const nodeMat = new THREE.ShaderMaterial({
    vertexShader: nodeVert, fragmentShader: nodeFrag, transparent: true, depthWrite: false, depthTest: true, toneMapped: false,
    uniforms: { uPx: { value: 1 }, uTime: { value: 0 }, uColor: { value: new THREE.Color() }, uRing: { value: new THREE.Color() }, uAlpha: { value: 0 }, uLight: { value: 0 } },
  })
  const nodes = new THREE.Points(nodeGeo, nodeMat)
  nodes.frustumCulled = false
  nodes.renderOrder = 9
  group.add(nodes)

  const headGeo = new THREE.BufferGeometry()
  const headPos = new Float32Array(3)
  headGeo.setAttribute('position', new THREE.BufferAttribute(headPos, 3))
  const headMat = new THREE.ShaderMaterial({
    vertexShader: headVert, fragmentShader: headFrag, transparent: true, depthWrite: false, depthTest: false, toneMapped: false,
    uniforms: { uPx: { value: 40 }, uColor: { value: new THREE.Color() }, uAlpha: { value: 0 }, uLight: { value: 0 } },
  })
  const head = new THREE.Points(headGeo, headMat)
  head.frustumCulled = false
  head.renderOrder = 10
  head.visible = false
  group.add(head)

  // ---- CSS3D words ----
  const cssScene = new THREE.Scene()
  const cssRenderer = new CSS3DRenderer()
  const layer = document.createElement('div') // clips + positions; the renderer's element inside is shifted by the lens shift
  layer.className = 'stage-phases'
  layer.setAttribute('aria-hidden', 'true')
  layer.style.cssText = 'pointer-events:none;overflow:hidden'
  cssRenderer.domElement.style.overflow = 'visible'
  cssRenderer.domElement.style.pointerEvents = 'none'
  layer.append(cssRenderer.domElement)
  canvas.after(layer)

  const words = PHASE_NAMES.map((ph, i) => {
    const el = document.createElement('div')
    el.className = 'stage-phase'
    el.dataset.phase = ph
    const label = document.createElement('span')
    label.textContent = LABELS[ph]
    const bar = document.createElement('i')
    el.append(label, bar)
    // the stage owns opacity / size / position every frame: only colour and shadow may ease via CSS
    el.style.cssText = 'opacity:0;transition:color .3s;'
    el.addEventListener('pointerenter', () => { if (state.interactive) { el.classList.add('stage-phase--hover'); el.style.cursor = 'pointer' } })
    el.addEventListener('pointerleave', () => el.classList.remove('stage-phase--hover'))
    el.addEventListener('click', (e) => { if (state.interactive) { e.stopPropagation(); clicks.forEach((cb) => cb(ph)) } })
    const obj = new CSS3DSprite(el)
    obj.scale.setScalar(WORD_SCALE)
    cssScene.add(obj)
    return {
      ph, el, bar, obj, cls: '', w: 0, h: 0, pw: 0, ph_: 0,
      a: 0, av: 0, k: 0, kv: 0, s: 1, // opacity, active amount (0..1) - both spring-smoothed
      px: null, py: null, vx: 0, vy: 0, slot: -1, slotT: -9, // on-screen centre (spring) and the chosen layout slot
      lastK: -1, lastBar: -1, lastOp: '', rect: [0, 0, 0, 0],
    }
  })
  const clicks = []
  const state = { interactive: false, plan: null, master: 0, shown: false, headA: 0, headAv: 0 }

  const _v = new THREE.Vector3(), _d = new THREE.Vector3(), _f = new THREE.Vector3(), _c = new THREE.Vector3(), _h = new THREE.Vector3()
  const anchorPx = words.map(() => [0, 0, 0]) // x, y, depth
  const tmp = [0, 0, 0]
  let sizeW = 1, sizeH = 1, lastDpr = 0
  let sizesFor = null
  let time = 0
  let pathPx = new Float32Array(0) // projected path samples (x,y pairs)
  let armPx = new Float32Array(0)
  const obst = [] // rects {x0,y0,x1,y1} to stay off: cell labels, other phase nodes

  function setPlan(plan) {
    state.plan = plan
    state.master = 0 // words fade in for the new task
    state.headA = 0
    for (const w of words) { w.a = 0; w.av = 0; w.k = 0; w.kv = 0; w.s = 1; w.px = null; w.slot = -1; w.slotT = -9; w.lastK = -1; w.lastBar = -1 }
    if (ribbon) { ribbon.removeFromParent(); ribbon.geometry.dispose(); ribbon = null }
    if (!plan) return
    nSeg = plan.tcpPath.length / 3 - 1
    ribbon = new THREE.Mesh(buildRibbon(plan.tcpPath), ribbonMat)
    ribbon.frustumCulled = false
    ribbon.renderOrder = 7
    group.add(ribbon)
    for (let i = 0; i < N; i++) plan.phasePts[i].toArray(nodePos, i * 3)
    nodeGeo.attributes.position.needsUpdate = true
    pathPx = new Float32Array(Math.ceil((nSeg + 1) / 5) * 2)
    sizesFor = null
  }

  function buildRibbon(path) {
    const n = path.length / 3
    const pos = new Float32Array(n * 6), prev = new Float32Array(n * 6), next = new Float32Array(n * 6), side = new Float32Array(n * 2), tt = new Float32Array(n * 2)
    const idx = []
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 1) * 3, b = Math.min(n - 1, i + 1) * 3
      for (let s = 0; s < 2; s++) {
        const o = (i * 2 + s) * 3
        for (let c = 0; c < 3; c++) { pos[o + c] = path[i * 3 + c]; prev[o + c] = path[a + c]; next[o + c] = path[b + c] }
        side[i * 2 + s] = s === 0 ? -1 : 1
        tt[i * 2 + s] = i / HZ
      }
      if (i < n - 1) { const q = i * 2; idx.push(q, q + 1, q + 2, q + 1, q + 3, q + 2) }
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    g.setAttribute('aPrev', new THREE.BufferAttribute(prev, 3))
    g.setAttribute('aNext', new THREE.BufferAttribute(next, 3))
    g.setAttribute('aSide', new THREE.BufferAttribute(side, 1))
    g.setAttribute('aT', new THREE.BufferAttribute(tt, 1))
    g.setIndex(idx)
    return g
  }

  function measure() {
    for (const w of words) { w.w = w.el.offsetWidth || 160; w.h = w.el.offsetHeight || 56 }
    sizesFor = state.plan
  }

  function paintColors(mode) {
    const light = isLightPal()
    ribbonMat.uniforms.uAccent.value.copy(PAL.accent).multiplyScalar(mixL(1, 0.8))
    ribbonMat.uniforms.uHair.value.copy(light ? PAL.trained : PAL.arc).multiplyScalar(mixL(1, 0.8))
    ribbonMat.uniforms.uLight.value = PAL.light
    leadMat.color.setScalar(1)
    nodeMat.uniforms.uColor.value.copy(PAL.accent)
    nodeMat.uniforms.uRing.value.copy(PAL.arc).multiplyScalar(mixL(1, 0.8))
    nodeMat.uniforms.uLight.value = PAL.light
    headMat.uniforms.uColor.value.copy(PAL.accent)
    headMat.uniforms.uLight.value = PAL.light
    for (const m of [ribbonMat, leadMat, nodeMat, headMat]) {
      const b = light ? THREE.NormalBlending : THREE.AdditiveBlending
      if (m.blending !== b) { m.blending = b; m.needsUpdate = true }
    }
  }

  function project(p, out) {
    _v.copy(p).project(camera)
    out[0] = (_v.x * 0.5 + 0.5) * sizeW
    out[1] = (-_v.y * 0.5 + 0.5) * sizeH
    _f.copy(p).sub(camera.position)
    camera.getWorldDirection(_d)
    out[2] = _f.dot(_d)
  }

  // px -> world point at the given view depth (so the word sits in the same plane as its node)
  function unproject(x, y, depth, out) {
    _v.set((x / sizeW) * 2 - 1, -(y / sizeH) * 2 + 1, 0.5).unproject(camera)
    _f.copy(_v).sub(camera.position).normalize()
    camera.getWorldDirection(_d)
    return out.copy(camera.position).addScaledVector(_f, depth / _f.dot(_d))
  }

  // ---- layout: deterministic slot picker ----
  function slotCost(i, si, prefX, prefY, gap, hw, hh, placed, bounds) {
    const dir = SLOT_DIRS[si % 12], ring = SLOT_RINGS[(si / 12) | 0]
    const dx = dir[0], dy = dir[1]
    const tEdge = Math.min(hw / Math.max(1e-3, Math.abs(dx)), hh / Math.max(1e-3, Math.abs(dy)))
    const off = tEdge + gap * ring
    const cx = anchorPx[i][0] + dx * off, cy = anchorPx[i][1] + dy * off
    const padX = 5, padY = 3
    let cost = 0
    // hard bounds: the page's text column, top nav, viewport
    const L = cx - hw, R = cx + hw, T = cy - hh, B = cy + hh
    if (L < bounds.minX + 6) cost += 3000 + (bounds.minX + 6 - L)
    if (R > sizeW - 8) cost += 3000 + (R - sizeW + 8)
    if (T < 84) cost += 3000 + (84 - T)
    if (B > bounds.maxY - 8) cost += 3000 + (B - bounds.maxY + 8)
    // other words (already placed)
    for (let j = 0; j < placed.length; j++) {
      const r = placed[j]
      const ox = hw + r[2] + padX - Math.abs(cx - r[0]), oy = hh + r[3] + padY - Math.abs(cy - r[1])
      if (ox > 0 && oy > 0) cost += 1200 + Math.min(ox, oy) * 4
    }
    // cell labels / other phase nodes
    for (let j = 0; j < obst.length; j++) {
      const o = obst[j]
      if (o.x1 > L - 3 && o.x0 < R + 3 && o.y1 > T - 2 && o.y0 < B + 2) cost += o.node ? 400 : 700
    }
    // the path and the arm: staying clear reads cleaner, but is only a preference
    for (let p = 0; p < pathPx.length; p += 2) {
      const x = pathPx[p], y = pathPx[p + 1]
      if (x > L - 3 && x < R + 3 && y > T - 3 && y < B + 3) cost += 5
    }
    for (let p = 0; p < armPx.length; p += 2) {
      const x = armPx[p], y = armPx[p + 1]
      if (x > L - 12 && x < R + 12 && y > T - 12 && y < B + 12) cost += 3
    }
    // preference: the design direction (away from the base, leaning up), and being near the node
    const dot = dx * prefX + dy * prefY
    cost += (1 - dot) * 16 + (ring - 1) * 28
    return { cost, cx, cy }
  }

  const order = []
  function layoutWords(mode, armPts, bounds) {
    // project the arm chain (as sample points along each link) and the path (every 5th sample)
    let ap = 0
    if (armPx.length < (armPts.length - 1) * 8 * 2) armPx = new Float32Array((armPts.length - 1) * 8 * 2)
    for (let a = 0; a < armPts.length - 1; a++) {
      for (let s = 0; s < 8; s++) {
        _h.lerpVectors(armPts[a], armPts[a + 1], s / 8)
        project(_h, tmp); armPx[ap++] = tmp[0]; armPx[ap++] = tmp[1]
      }
    }
    const plan = state.plan
    let pp = 0
    for (let v = 0; v <= nSeg && pp < pathPx.length; v += 5) {
      _h.fromArray(plan.tcpPath, v * 3)
      project(_h, tmp); pathPx[pp++] = tmp[0]; pathPx[pp++] = tmp[1]
    }
    // base of the arm on screen: where "away from the arm" starts
    project(armPts[0], tmp)
    const bx = tmp[0], by = tmp[1]
    // Every word reserves room for its ACTIVE size, whatever it is doing now, so the layout does not depend on which phase
    // is active: nothing is re-laid-out at a phase boundary. A quiet word sits at the node end of its reserved slot and
    // grows outward along the slot's direction.
    order.length = 0
    for (let i = 0; i < N; i++) order.push(i)
    const placed = []
    const gap = mode === 'full' ? 34 : 26
    for (const i of order) {
      const wd = words[i]
      const sT = S_ACTIVE
      const hw = (wd.w * WORD_SCALE * sT * wd.pxPerM) * 0.5, hh = (wd.h * WORD_SCALE * sT * wd.pxPerM) * 0.5
      let pxv = anchorPx[i][0] - bx, pyv = anchorPx[i][1] - by
      const pl = Math.hypot(pxv, pyv)
      if (pl < 24) { pxv = 1; pyv = -0.6 } else { pxv /= pl; pyv /= pl }
      pyv -= 0.5
      const ql = Math.hypot(pxv, pyv); pxv /= ql; pyv /= ql
      let best = -1, bestCost = Infinity
      for (let si = 0; si < 24; si++) {
        const r = slotCost(i, si, pxv, pyv, gap * 1.2 + 4, hw, hh, placed, bounds)
        let c = r.cost
        if (si === wd.slot) {
          c -= time - wd.slotT < 0.9 ? 160 : 45 // sticky: a new slot must beat the current one clearly, and not too soon
        }
        if (c < bestCost) { bestCost = c; best = si }
      }
      if (best !== wd.slot) { wd.slot = best; wd.slotT = time } // (an invalid slot loses to any valid one despite the sticky bonus)
      const r = slotCost(i, wd.slot, pxv, pyv, gap * 1.2 + 4, hw, hh, placed, bounds)
      // where the word actually sits now: same direction and ring, but measured from its current (smaller) size
      const dir = SLOT_DIRS[wd.slot % 12], ring = SLOT_RINGS[(wd.slot / 12) | 0]
      const ahw = wd.pw * 0.5, ahh = wd.ph_ * 0.5
      const off = Math.min(ahw / Math.max(1e-3, Math.abs(dir[0])), ahh / Math.max(1e-3, Math.abs(dir[1]))) + (gap * 1.2 + 4) * ring
      wd.tx = anchorPx[i][0] + dir[0] * off; wd.ty = anchorPx[i][1] + dir[1] * off
      placed.push([r.cx, r.cy, hw, hh])
      wd.rect[0] = r.cx; wd.rect[1] = r.cy; wd.rect[2] = hw; wd.rect[3] = hh
    }
  }

  /**
   * @param mode 'off' | 'subtle' | 'full'
   * @param t task time (s)
   * @param armPts array of world points on the arm (joints + tcp)
   * @param labels [{ p: Vector3 (world), w, h }] cell label pills to keep clear of (pill hangs to the right of p)
   */
  function update(dt, { mode, interactive, running, t, plan, w, h, dpr, armPts, labels, minX, maxY }) {
    dt = Math.min(dt, 0.05)
    time += dt
    if (plan !== state.plan) setPlan(plan)
    const want = mode !== 'off' && !!plan
    state.interactive = !!interactive && mode === 'full' && want
    const masterT = !want ? 0 : mode === 'subtle' ? 0.6 : 1
    state.master += (masterT - state.master) * (1 - Math.exp(-dt * (want ? 4 : 8)))
    if (state.master < 0.004 && !want) state.master = 0
    const show = state.master > 0.004
    group.visible = show
    layer.style.visibility = show ? 'visible' : 'hidden'
    if (!show) return
    if (sizesFor !== plan) measure()
    if (sizeW !== w || sizeH !== h || lastDpr !== dpr) {
      sizeW = w; sizeH = h; lastDpr = dpr
      cssRenderer.setSize(w, h)
      leadMat.resolution.set(w * dpr, h * dpr)
      leadMat.linewidth = 0.9 * dpr
      ribbonMat.uniforms.uRes.value.set(w * dpr, h * dpr)
      ribbonMat.uniforms.uHalfW.value = 6.5 * dpr
      nodeMat.uniforms.uPx.value = h * dpr * 0.05
      headMat.uniforms.uPx.value = 38 * dpr
    }
    // (CSS3DRenderer applies camera.view - our lens shift - itself)
    paintColors(mode)
    camera.updateMatrixWorld()

    const M = state.master
    const light = isLightPal()
    const finished = t >= plan.duration - 1e-4
    leadMat.opacity = M * (mode === 'full' ? 0.75 : 0.4)
    nodeMat.uniforms.uAlpha.value = M
    nodeMat.uniforms.uTime.value = time

    // ---- the path: a pure function of task time (uniforms only, nothing rewritten per frame) ----
    const f = Math.min(nSeg, Math.max(0, t * HZ))
    ribbonMat.uniforms.uHead.value = finished ? plan.duration + 1 : t
    ribbonMat.uniforms.uAlpha.value = M
    ribbonMat.uniforms.uFloor.value = running ? 0.42 : 0.55
    // head: sits on the tool tip, fades when the task is over / not started
    const headWant = !finished && f > 0.5 ? 1 : 0
    state.headA += (headWant - state.headA) * (1 - Math.exp(-dt * 8))
    head.visible = state.headA > 0.01
    if (head.visible) {
      const i0 = Math.min(nSeg - 1, Math.floor(f)), u = f - i0
      for (let c = 0; c < 3; c++) headPos[c] = plan.tcpPath[i0 * 3 + c] + (plan.tcpPath[(i0 + 1) * 3 + c] - plan.tcpPath[i0 * 3 + c]) * u
      headGeo.attributes.position.needsUpdate = true
      headMat.uniforms.uAlpha.value = M * state.headA * mixL(0.9, 0.5)
    }

    // ---- per-phase state: everything eases with springs, so a phase change never pops ----
    let activeIdx = -1
    for (let i = 0; i < N; i++) {
      const ph = plan.phases[i]
      const done = finished || t >= ph.s1 - 1e-4
      const active = !done && t >= ph.s0
      if (active) activeIdx = i
      const wd = words[i]
      spring(wd, 'k', 'kv', active ? 1 : 0, 9, dt)
      wd.k = Math.min(1, Math.max(0, wd.k))
      spring(wd, 'a', 'av', active ? 1 : done ? A_DONE : A_UP, 8, dt)
      wd.s = 1 + (S_ACTIVE - 1) * wd.k
      nodeA[i] = 1
      nodeK[i] = wd.k
      nodeD[i] += ((done ? 1 : 0) - nodeD[i]) * (1 - Math.exp(-dt * 10))
      const since = t - ph.pin
      nodeP[i] = since >= 0 && since < PULSE_S && !finished ? since / PULSE_S : -1
      const cls = active ? 'stage-phase--active' : done ? 'stage-phase--done' : ''
      if (cls !== wd.cls) {
        if (wd.cls) wd.el.classList.remove(wd.cls)
        if (cls) wd.el.classList.add(cls)
        wd.cls = cls
      }
      // progress tick under the active word (a pure function of t)
      const pg = active ? clamp01((t - ph.s0) / Math.max(1e-3, ph.s1 - ph.s0)) : done ? 1 : 0
      const q = Math.round(pg * 200) / 200
      if (q !== wd.lastBar || Math.abs(wd.k - wd.lastK) > 0.01) {
        wd.bar.style.transform = `scaleX(${q})`
        wd.bar.style.opacity = (wd.k * 0.9).toFixed(2)
      }
      wd.lastBar = q
    }
    for (const a of ['aA', 'aK', 'aD', 'aP']) nodeGeo.attributes[a].needsUpdate = true

    // ---- screen-space layout ----
    for (let i = 0; i < N; i++) {
      project(plan.phasePts[i], anchorPx[i])
      const wd = words[i]
      wd.pxPerM = h / (2 * Math.max(0.05, anchorPx[i][2]) * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2))
      wd.pw = wd.w * WORD_SCALE * wd.s * wd.pxPerM // on-screen size now (px)
      wd.ph_ = wd.h * WORD_SCALE * wd.s * wd.pxPerM
    }
    // things to keep clear of: cell label pills, and every node (a word never covers a node that is not its own)
    obst.length = 0
    if (labels) for (const l of labels) {
      project(l.p, tmp)
      obst.push({ x0: tmp[0] - 2, x1: tmp[0] + l.w, y0: tmp[1] - l.h * 0.5, y1: tmp[1] + l.h * 0.5, node: false })
    }
    for (let i = 0; i < N; i++) obst.push({ x0: anchorPx[i][0] - 9, x1: anchorPx[i][0] + 9, y0: anchorPx[i][1] - 9, y1: anchorPx[i][1] + 9, node: true, i })
    layoutWords(mode, armPts, { minX: minX ?? 0, maxY: Math.min(maxY ?? h, h) })

    for (let i = 0; i < N; i++) {
      const wd = words[i]
      // own node is not an obstacle for itself (handled through the gap), so it is skipped in slotCost via distance
      if (wd.px === null) { wd.px = wd.tx; wd.py = wd.ty; wd.vx = 0; wd.vy = 0 }
      else { spring(wd, 'px', 'vx', wd.tx, 8, dt); spring(wd, 'py', 'vy', wd.ty, 8, dt) }
      unproject(wd.px, wd.py, anchorPx[i][2], wd.obj.position)
      wd.obj.scale.setScalar(WORD_SCALE * wd.s)
      const op = (wd.a * M).toFixed(3)
      if (op !== wd.lastOp) { wd.el.style.opacity = op; wd.lastOp = op }
      const pe = state.interactive && wd.a * M > 0.2 ? 'auto' : 'none'
      if (wd.el.style.pointerEvents !== pe) wd.el.style.pointerEvents = pe
      // active glow, continuous in k (page CSS still owns the colours; this only adds the lift)
      const kq = Math.round(wd.k * 50) / 50
      if (kq !== wd.lastK) {
        wd.lastK = kq
        if (light) { wd.el.style.textShadow = ''; wd.el.style.boxShadow = ''; wd.el.style.background = '' }
        else {
          const c = PAL.accent
          const rgb = `${Math.round(Math.pow(c.r, 1 / 2.2) * 255)},${Math.round(Math.pow(c.g, 1 / 2.2) * 255)},${Math.round(Math.pow(c.b, 1 / 2.2) * 255)}`
          wd.el.style.textShadow = kq > 0 ? `0 0 ${(6 + 12 * kq).toFixed(1)}px rgba(${rgb},${(0.35 + 0.4 * kq).toFixed(2)}), 0 0 ${(26 * kq).toFixed(1)}px rgba(${rgb},${(0.55 * kq).toFixed(2)}), 0 1px 3px rgba(0,0,0,.85)` : ''
          wd.el.style.boxShadow = kq > 0 ? `0 0 ${(22 * kq).toFixed(1)}px rgba(${rgb},${(0.22 * kq).toFixed(2)}), inset 0 0 0 1px rgba(${rgb},${(0.42 * kq).toFixed(2)})` : ''
          wd.el.style.background = kq > 0 ? `rgba(12,15,20,${(0.42 + 0.26 * kq).toFixed(2)})` : ''
        }
      }
      // leader: from just outside the node ring to the word's near edge; brighter for the active phase
      let lx = wd.px - anchorPx[i][0], ly = wd.py - anchorPx[i][1]
      const ll = Math.hypot(lx, ly) || 1
      const ux = lx / ll, uy = ly / ll
      const edge = Math.min((wd.pw * 0.5) / Math.max(1e-3, Math.abs(ux)), (wd.ph_ * 0.5) / Math.max(1e-3, Math.abs(uy)))
      const start = 7, endD = ll - edge - 3
      const on = endD > start + 2
      unproject(anchorPx[i][0] + ux * start, anchorPx[i][1] + uy * start, anchorPx[i][2], _c).toArray(leadBuf.array, i * 6)
      unproject(anchorPx[i][0] + ux * (on ? endD : start), anchorPx[i][1] + uy * (on ? endD : start), anchorPx[i][2], _c).toArray(leadBuf.array, i * 6 + 3)
      const li = (0.3 + 0.7 * wd.k) * (on ? 1 : 0)
      const ac = PAL.accent, ar = PAL.arc
      const lr = (ar.r + (ac.r - ar.r) * wd.k) * li, lg = (ar.g + (ac.g - ar.g) * wd.k) * li, lb = (ar.b + (ac.b - ar.b) * wd.k) * li
      for (let c = 0; c < 2; c++) { leadCol.array[i * 6 + c * 3] = lr; leadCol.array[i * 6 + c * 3 + 1] = lg; leadCol.array[i * 6 + c * 3 + 2] = lb }
    }
    leadBuf.needsUpdate = true
    leadCol.needsUpdate = true
    cssRenderer.render(cssScene, camera)
  }

  return {
    update, layer,
    onClick(cb) { clicks.push(cb) },
    setSize(w, h) { sizeW = w; sizeH = h; cssRenderer.setSize(w, h) },
    dispose() {
      layer.remove()
      if (ribbon) ribbon.geometry.dispose()
      ribbonMat.dispose()
      leaders.geometry.dispose(); nodeGeo.dispose(); nodeMat.dispose(); headGeo.dispose(); headMat.dispose(); leadMat.dispose()
      group.removeFromParent()
    },
  }
}
