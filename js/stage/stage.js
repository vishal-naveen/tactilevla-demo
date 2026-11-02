// Stage orchestrator: renderer, scene, chapters, render loop. Implements the contract in CONTRACT.md.
import * as THREE from 'three'
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js'
import { loadRobot, disposeRig } from './robot.js'
import { makeIK } from './ik.js'
import { createStudio } from './studio.js'
import { applyBakedArm, applyBakedCup, applyBakedTable, applyProbe } from './baked.js'
import { buildCupMesh, Noodle } from './props.js'
import { createGround } from './ground.js'
import { createGrid } from './grid.js'
import { createEpisodes } from './episodes.js'
import { buildPlan, ArmController } from './tasks.js'
import { loadPlans } from './plans.js'
import { createRobotFx } from './robotfx.js'
import { createTrail } from './trail.js'
import { createFrustums } from './frustums.js'
import { createFX, estimateGpuMB } from './fx.js'
import { CameraRig, SHOTS } from './shots.js'
import { createLook, updateKeep, KEEP } from './look.js'
import { createAssembly, createDust } from './vfx.js'
import { createMoments } from './moments.js'
import { createInput } from './input.js'
import { buildSubjects } from './subjects.js'
import { MODES, LOOPS, PARAM_KEYS } from './modes.js'
import { createParams, stepParams } from './overlay.js'
import { createGovernor } from './governor.js'
import { createProtoViz } from './protoviz.js'
import { createDollies } from './dolly.js'
import { smooth01 as smoothBlend } from './blend.js'
import { createExtras } from './extras.js'
import { createThemeFX } from './themefx.js'
import { createGauges } from './gauges.js'
import { JOINT_NAMES } from './robot.js'
import { makeSkeleton } from './skeleton.js'
import { createPhaseMarkers } from './phasemarkers.js'
import { isStacked, stackedSceneBottom, textColumnRight } from './framing.js'
import { createPlacement, reachable } from './placement.js'
import { createPlaceHint } from './placehint.js'
import { solveTaskSteps } from './tasks.js'
import { PAL } from './palette.js'
import { DEFAULT_THEME, THEMES } from '../themes.js'
import { CELLS, episodeAt, DATA_FILL_END } from './protocol.js'
import { GRID, GRID_CENTER, CUP, RING, cellAtPoint, noodleYawAt } from './layout.js'

function hasWebGL2() {
  try {
    const c = document.createElement('canvas')
    const gl = c.getContext('webgl2')
    if (!gl) return false
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    return true
  } catch { return false }
}

const REST_PAN = 1.25 // folded arm swings to the C side, clear of the grid and the cup arcs

export async function createStage(canvas, { onLoadProgress = () => {}, theme = DEFAULT_THEME, depth = false } = {}) { // depth: flight only (fx.js DoF + air)
  if (!hasWebGL2()) throw new Error('WebGL 2 is not available in this browser, so the 3D stage cannot start.')
  const report = (f) => { try { onLoadProgress(Math.min(1, Math.max(0, f))) } catch { /* page callback errors must not break loading */ } }
  report(0)
  const bootMarks = [['start', performance.now()]]
  const mark = (l) => bootMarks.push([l, Math.round(performance.now() - bootMarks[0][1])])

  const parent = canvas.parentElement || document.body
  // The canvas is sized by the page's CSS (e.g. fixed + 100%); read that size, never write it.
  const size = () => ({
    w: Math.max(1, Math.round(canvas.clientWidth || parent.clientWidth || window.innerWidth)),
    h: Math.max(1, Math.round(canvas.clientHeight || parent.clientHeight || window.innerHeight)),
  })
  let { w, h } = size()
  // Quality policy. Touch devices (phones, iPads) are NOT "low end": Apple GPUs are strong and a soft picture is the worse
  // failure, so they keep MSAA, VSM shadows and no 30 fps cap. But iOS Safari kills the WebGL context of a tab that holds too
  // much GPU memory (the "scene just cuts out" failure), and videos decode on the same GPU. So on touch the resolution is
  // chosen by an explicit memory budget (fx.estimateGpuMB: MSAA scene target + finish target + bloom chain + back buffers +
  // shadow maps), with 1024 shadows (a 2048 VSM pair alone is ~64 MB) and MSAA kept at 2x on the scene target only.
  // `weak` is only for genuinely small hardware (<= 2 cores / <= 2 GB); anything else that turns out slow is handled by the
  // governor (and, at its floor, by onStruggle).
  const touch = matchMedia('(pointer: coarse)').matches || matchMedia('(hover: none)').matches
  const weak = (navigator.hardwareConcurrency || 8) <= 2 || (navigator.deviceMemory || 8) <= 2
  const low = weak // FXAA instead of MSAA
  // Comparison switches: ?legacy = the v16 render; ?off=a,b drops single upgrades (ssao, bake, probe; merge = the old post
  // chain, shadow = re-render the key shadow every frame; look: pool, grade, haze, dust, keep (glow over the text column),
  // halo (hero re-frame), rays, intro; Stage B: b2 (the B2 peak), lane (noodles + dive), dive (the dive only), hatch (B2 hatch
  // draw-on), handoff (section transitions), close (the ending)); ?ssao forces live AO on
  const query = new URLSearchParams(location.search)
  const LEGACY = query.has('legacy')
  const OFF = new Set(LEGACY ? ['ssao', 'bake', 'probe', 'merge', 'shadow', 'pool', 'grade', 'haze', 'dust', 'keep', 'halo', 'rays', 'intro', 'b2', 'lane', 'dive', 'hatch', 'handoff', 'close', 'type', 'layout', 'footprint', 'breathe', 'quiet', 'calm'] : (query.get('off') || '').split(','))
  const SAMPLES = low ? 0 : 2 // 4x was tried: it halved the frame rate on an M3 Pro for edges you can barely tell apart
  const SHADOW = low || touch ? 1024 : 2048
  const TOUCH_BUDGET_MB = 128 // iOS-safe ceiling for what the render pipeline allocates (phone ~80 MB, iPad Pro 11 ~125 MB)
  let capAmbient = weak // 30 fps ambient chapters; also switched on if the governor bottoms out
  const screenDpr = () => window.devicePixelRatio || 1
  // Laptop/desktop: DPR 1.4 (unchanged). Touch: up to 2, then the largest DPR whose estimated GPU memory fits the budget
  // and whose drawing buffer stays within ~2.6 MP; never under 1.5 on a DPR >= 2 screen (soft is the worse failure).
  const PIXEL_BUDGET = 2.6e6
  const dprMax = () => {
    if (weak) return Math.min(screenDpr(), 1.25)
    if (!touch) return Math.min(screenDpr(), 1.4)
    const cap = Math.min(screenDpr(), 2)
    const floor = Math.min(cap, 1.5)
    let d = Math.min(cap, Math.sqrt(PIXEL_BUDGET / (w * h)))
    while (d > floor && estimateGpuMB(w * d, h * d, { samples: SAMPLES, low, shadowSize: SHADOW, merge: !OFF.has('merge') }) > TOUCH_BUDGET_MB) d -= 0.05
    return Math.max(floor, +d.toFixed(3))
  }
  const dprFloor = () => (touch && screenDpr() >= 2 ? 1.5 : 1)
  let dpr = dprMax()

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' })
  renderer.setPixelRatio(dpr)
  renderer.setSize(w, h, false)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  // ?tm=agx | neutral: compare tone curves on the same frames (ACES stays the default the page was graded with)
  const tmPick = { agx: THREE.AgXToneMapping, neutral: THREE.NeutralToneMapping }[new URLSearchParams(location.search).get('tm')]
  if (tmPick) renderer.toneMapping = tmPick
  renderer.toneMappingExposure = 1
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.VSMShadowMap // real penumbra widening; PCFSoft ignores shadow.radius
  // The 2048 VSM key shadow (render + two 16-tap blur passes, the largest tap count in the frame) is only redrawn when
  // something that casts it moved (shadowGate below), not every frame. Same map, same blur: the look does not change.
  const SHADOW_GATE = !OFF.has('shadow')
  if (SHADOW_GATE) { renderer.shadowMap.autoUpdate = false; renderer.shadowMap.needsUpdate = true }

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(30, w / h, 0.005, 30)
  const camRig = new CameraRig(camera)

  const labelRenderer = new CSS2DRenderer()
  const ld = labelRenderer.domElement
  ld.className = 'stage-labels'
  ld.setAttribute('aria-hidden', 'true') // decorative: the page carries the same information as text
  const placeLabels = () => {
    const cs = getComputedStyle(canvas)
    const fixed = cs.position === 'fixed'
    const r = canvas.getBoundingClientRect()
    Object.assign(ld.style, {
      position: fixed ? 'fixed' : 'absolute', pointerEvents: 'none', overflow: 'hidden',
      top: (fixed ? r.top : canvas.offsetTop) + 'px', left: (fixed ? r.left : canvas.offsetLeft) + 'px',
      zIndex: cs.zIndex === 'auto' ? '' : cs.zIndex,
    })
    if (markers) Object.assign(markers.layer.style, { position: ld.style.position, top: ld.style.top, left: ld.style.left, zIndex: ld.style.zIndex, width: w + 'px', height: h + 'px' })
  }
  let markers = null // created after the scene exists; placeLabels() also positions its layer
  placeLabels()
  labelRenderer.setSize(w, h)
  canvas.after(ld)

  // --- world ---
  const studio = createStudio(scene, { shadowSize: SHADOW })
  studio.setEnvironment(renderer)
  const ground = createGround(scene)
  const cup = buildCupMesh()
  cup.userData.bake = 'cup' // static: Cycles bakes its occlusion (baked.js)
  scene.add(cup)
  const grid = createGrid(scene)
  const episodes = createEpisodes(scene, { lane: !OFF.has('lane') })
  const protoviz = createProtoViz(scene)

  mark('renderer+world')
  const rig = await loadRobot((f) => report(f * 0.86))
  mark('robot loaded')
  // offline-rendered light (baked.js): AO and printed detail on the arm, the cup and the table now, the studio probe whenever it lands
  if (!OFF.has('bake')) {
    await Promise.all([applyBakedArm(rig), applyBakedCup(cup), applyBakedTable(ground.group.getObjectByProperty('name', 'table'), ground)])
  }
  if (!OFF.has('probe')) applyProbe(THEMES[theme] ? theme : DEFAULT_THEME)
  scene.add(rig.root)
  const ik = makeIK(rig)
  const skelIK = makeIK(makeSkeleton(loadRobot.lastUrdf, rig.grasp, rig.limits)) // mesh-free kinematics for live planning
  const fxRobot = createRobotFx(rig)
  const frustums = createFrustums(scene, rig, { footprint: !OFF.has('footprint') })
  const trail = createTrail(scene)
  trail.setPixelRatio(dpr)
  const noodle = new Noodle(scene, rig.tcp)
  const gauges = createGauges(rig)
  markers = createPhaseMarkers({ scene, canvas, camera, rig })
  placeLabels()
  const placement = createPlacement(scene)
  const placeHint = createPlaceHint(scene, camera)
  const tableCbs = []
  const armPts = [...JOINT_NAMES, 'tcp'].map(() => new THREE.Vector3())
  const labelObs = [], labelPool = {}
  const planOwner = { plan: null, chapter: null }
  let phaseOverride = null // null: follow the chapter (hero subtle, sandbox full); true/false: the page's choice
  gauges.setResolution(w * dpr, h * dpr)
  let gaugeDim = 1, gaugesYield = false // gauges dim to half while the phase path is showing
  let gaugeOverride = null // null: follow the chapter (sandbox + policies); true/false: the page's choice
  const taskProgress = { running: false, paused: false, t: 0, duration: 0, phase: 'approach', timeline: [] }
  const EMPTY = []
  const jointState = { joints: {}, gripperOpen: 0, phase: 'idle', cell: null } // reused: the page polls at ~20 Hz
  for (const n of JOINT_NAMES) jointState.joints[n] = 0

  // --- motion plans ---
  mark('helpers')
  const solved = await loadPlans(ik, (f) => report(0.86 + f * 0.08))
  const HOME_Q = solved.homeQ
  const plans = {}
  for (const c of CELLS) plans[c] = buildPlan(rig, ik, c, solved.specs[c])
  mark('plans built')
  report(0.94)
  const REST_Q = [-ik.panSign * REST_PAN, -1.72, 1.66, 1.3, 0, 0.1]
  const poses = { home: HOME_Q, rest: REST_Q, sees: plans.A2.graspQ, touch: plans.B2.liftQ }
  const arm = new ArmController({ rig, noodle, homeQ: HOME_Q, plans })
  // Hero as a halo: the camera drops toward table height on the line from the ring through the elbow, so the lit ring
  // frames the arm instead of hanging above it (?off=halo = the old, higher hero shot).
  if (!OFF.has('halo')) SHOTS.hero = { ...SHOTS.hero, dir: [0.66, 0.06, -0.75], fov: 30 }
  // B2 peak: ~15 % closer, a touch lower (the pool reads as light on the table, not a decal seen from above)
  if (!OFF.has('b2')) SHOTS.test = { ...SHOTS.test, dir: [0.75, 0.085, -0.5] }
  // the full-ring chord belongs to the close, not to limits (the quietest chapter); ?legacy / ?off=close keep it there
  if (OFF.has('close')) MODES.limits = { ...MODES.limits, ringFull: 1 }
  camRig.setSubjects(buildSubjects({ rig, plans, loops: LOOPS, poses, explode: fxRobot.applyExplode }))
  camRig.setSize(w, h)

  mark('subjects')
  const fx = createFX(renderer, scene, camera, { low, samples: SAMPLES, width: w, height: h, dpr, ao: !low && !touch && !OFF.has('ssao'), merge: !OFF.has('merge'), depth: depth && !LEGACY && !touch && !low }) // flight depth effects: desktop tier only
  const themeFx = createThemeFX({ studio, ground, fx })
  // flight (depth: true) only: a dormant low rake light, in the scene BEFORE the precompile so no program is ever rebuilt for
  // it (adding it later from js/flight recompiled every material and kept both sets: 60 -> 97 programs). Intensity 0 = off.
  const flightRake = depth && !LEGACY ? new THREE.DirectionalLight(0xffd9b0, 0) : null
  if (flightRake) { flightRake.name = 'flight-rake'; scene.add(flightRake, flightRake.target) }
  if (depth && !LEGACY && !OFF.has('ambient')) studio.setAmbient(true) // round 7: the ring's slow breath (flight only)
  // round 6: the rake also casts the arm's LONG soft shadow (Cycles' ring-as-emitter shadow had no live twin). Set before
  // the precompile (its depth/VSM programs exist from load; castShadow is never toggled), redrawn only through shadowGate
  // (a caster or the light itself moved). ?off=rakeshadow = no shadow on it (one program set fewer).
  if (flightRake && !OFF.has('rakeshadow')) {
    flightRake.castShadow = true
    const sh = flightRake.shadow
    sh.mapSize.set(512, 512) // soft and long: 512 + the VSM blur holds the look at a quarter of the fill (the Mac is fill-bound)
    // redrawn on its own cadence (shadowGate: at most every 3rd frame while casters move), never every frame; needsUpdate
    // now so the precompile's real shadow render builds its programs at load
    sh.autoUpdate = false; sh.needsUpdate = true
    Object.assign(sh.camera, { left: -0.95, right: 0.95, top: 0.95, bottom: -0.95, near: 1.2, far: 4.8 })
    sh.camera.updateProjectionMatrix()
    sh.bias = -0.0006; sh.normalBias = 0.01; sh.radius = 14; sh.blurSamples = 12
  }
  themeFx.set(theme, true)

  // --- Stage A look + intro (see look.js, vfx.js). ?legacy builds none of it; ?off=<name> zeroes one part by uniform. ---
  const look = LEGACY ? null : createLook(scene, { studio, ground })
  const dust = LEGACY || low ? null : createDust(scene, studio.key, touch ? 600 : 1400)
  const assembly = OFF.has('intro') || low ? null : createAssembly(scene, rig, {
    ring: studio.ring, ringRadius: RING.radius, ringColor: studio.ringMat.uniforms.uColor.value, onLight: (k) => studio.setIntroLight(k),
    table: ground.group.getObjectByProperty('name', 'table'), count: touch ? 8000 : 16000,
  })
  assembly?.arm()
  if (fx.merged) fx.finish.uniforms.uKeep = KEEP.uKeep // bloom + rays share the ring's text keep-out
  const vfxK = { hero: 1, rays: 0 }
  const moments = createMoments(scene, { studio, off: OFF })
  const sb = { group: null, hatch: 1, hatchArmed: false, dive: 0, diveV: 0, layout: 1, laidOut: false } // Stage B per-frame state (section group, hatch draw, dive)
  const _camDir = new THREE.Vector3(), _ovP = new THREE.Vector3(), _b2p = new THREE.Vector3()
  // Flight (js/flight, flight.html; additive, inert unless the flight page calls setCameraPath / setFocus)
  let flightCam = null, flightFocus = null, beforeFrame = null, flWasHeld = false
  const _flP = new THREE.Vector3(), _flL = new THREE.Vector3(), _d0 = new THREE.Vector3()
  const _rc = new THREE.Vector3(), _re = new THREE.Vector3(), _rv = new THREE.Vector3()
  function syncViewport() {
    updateKeep(w, h, dpr, !LEGACY && !OFF.has('keep'))
    moments.setStacked(isStacked(w, h))
    dust?.setViewport(h * dpr)
    assembly?.setViewport(h * dpr)
  }
  syncViewport()
  const poolV = { x: 0, z: 0 } // round 11: the moving key pool's velocity (stepLook)
  function stepLook(dt) {
    if (!look) return
    const dark = 1 - PAL.light // the light theme keeps its own bright set: no pool, haze, dust or grade
    const lit = 1 - params.testLight * 0.62
    // haze reads as air only when the camera looks across the beam; looking down it (data, sandbox) it is a milky veil
    const down = -camera.getWorldDirection(_rv).y
    const across = 1 - smoothBlend((down - 0.3) / 0.3)
    look.update({ pool: OFF.has('pool') ? 0 : dark, haze: OFF.has('haze') ? 0 : 0.12 * dark * lit * across })
    // round 11 (flight): the key pool follows the stop's subject (the path's focus point, path.js via setFocus), so each stop
    // has one motivated pool of light on the table: under the arm, the cup, B2... Two thirds of the way from the arm's
    // pool to the subject, kept on the island core, critically damped (~0.8 s), so it glides with the camera, never pops.
    // ?off=poolmove keeps it fixed at the arm.
    if (depth && !LEGACY && flightFocus?.at && !OFF.has('poolmove')) {
      const tx = THREE.MathUtils.clamp(0.16 + 0.66 * (flightFocus.at[0] - 0.16), -0.15, 0.48)
      const tz = THREE.MathUtils.clamp(0.06 + 0.66 * (flightFocus.at[2] - 0.06), -0.45, 0.6)
      const c = look.poolCenter, om = 5, e = Math.exp(-om * dt)
      for (const [k, t] of [['x', tx], ['z', tz]]) { // exact critically damped step
        const x0 = c[k] - t, v0 = poolV[k], q = (v0 + om * x0) * dt
        c[k] = t + (x0 + q) * e; poolV[k] = (v0 - om * q) * e
      }
    }
    if (fx.merged) fx.finish.uniforms.uGrade.value = OFF.has('grade') ? 0 : 0.5 * dark
    const focus = camera.position.distanceTo(_rc.set(camRig.s[3], camRig.s[4], camRig.s[5]))
    dust?.update(time, OFF.has('dust') ? 0 : 1.4 * dark * lit, focus)
    assembly?.update(dt)
    // ring light shafts: hero only (the ring is the subject there), eased in and out with the chapter
    vfxK.hero += ((chapter === 'hero' ? 1 : 0.6 * moments.closeK) - vfxK.hero) * (1 - Math.exp(-dt * 3)) // + the close
    if (fx.rays) {
      // shafts wait for the ignition sweep to finish (a half-lit arc throws a hard-edged wedge), then breathe in
      vfxK.rays = Math.min(1, Math.max(0, vfxK.rays + (studio.igniting || !studio.revealed ? -dt * 4 : dt / 1.2)))
      let g = OFF.has('rays') ? 0 : 0.85 * vfxK.hero * dark * smoothBlend(vfxK.rays)
      studio.ring.getWorldPosition(_rc)
      _re.set(RING.radius, 0, 0).applyMatrix4(studio.ring.matrixWorld)
      if (_rv.copy(_rc).applyMatrix4(camera.matrixWorldInverse).z > -0.05) g = 0 // centre behind the camera: shafts would mirror
      _rc.project(camera); _re.project(camera)
      const aspect = w / h
      const r = Math.hypot((_re.x - _rc.x) * 0.5 * aspect, (_re.y - _rc.y) * 0.5)
      fx.rays.set(_rc.x * 0.5 + 0.5, _rc.y * 0.5 + 0.5, r, g, aspect)
    }
  }
  const input = createInput({
    canvas, camera, grid, camRig, getChapter: () => chapter,
    onClick: (cell) => { grid.ripple(cell); clickCbs.forEach((cb) => cb(cell)) },
    onTable: (pt, cell) => { placeHint.dismiss(); tableCbs.forEach((cb) => cb(pt, cell)) },
    onHover: (pt) => placement.setHover(pt),
  })

  // --- state ---
  let chapter = 'hero'
  let mode = MODES.hero
  // Scroll-linked blend (setChapterBlend): once the page starts sending it, the camera and the resting pose are driven by it and
  // setChapter only switches the scene mode (loops, overlays, sandbox). Never engaged under reduced motion (cuts).
  const blend = { on: false, from: 'hero', to: 'hero', t: 0 }
  const blendPose = new Array(6).fill(0)
  let speedS = 1 // eased task playback rate
  const progress = {}
  const clickCbs = []
  const P = createParams(MODES.hero)
  const params = P.v
  const dollies = createDollies(camRig)
  // round 12 (flight): a resolution change mid-move is a visible pop, so the flight applies the governor's step only once
  // the camera rests (trackMotion); the default page keeps applying it at once
  let dprPending = 0
  const governor = createGovernor({ max: dpr, floor: dprFloor(), onChange: (d) => { if (depth && camMot.moving) dprPending = d; else { dprPending = 0; applyDpr(d) } }, onStruggle: () => { capAmbient = true } })
  let gateAt = 0
  let activeCell = null
  let lastRender = null
  const _engageLook = new THREE.Vector3()
  const _tcpW = new THREE.Vector3()
  let policy = 'act'
  let reduced = false
  let paused = false
  let hidden = document.hidden
  let disposed = false
  let raf = 0
  let last = null
  let lastFrameAt = performance.now() // watchdog: when a frame last completed
  let framesDrawn = 0 // the page's health check reads this (getFrameCount) to tell a usable GPU from a crawling one
  let lost = false // WebGL context lost (iOS kills it under memory pressure); nothing may touch the GPU until restored
  let acc = 0
  let time = 0
  let explodeE = 0
  let dataVis = 0
  let loopIdx = 0
  let loopPrev = null
  let engaged = false

  function loopCell() {
    if (reduced || !mode.loop) return null
    const seq = LOOPS[mode.loop]
    const c = seq[loopIdx % seq.length]
    loopIdx++
    return c
  }

  function noodleIntent() {
    if (arm.busy) return
    const nd = noodle
    switch (mode.noodle) {
      case 'hidden':
        if (chapter === 'sandbox' && nd.state === 'cup') break // the finished pick stays in the cup (and scrubbable)
        if (nd.state !== 'hidden' && nd.scaleDir >= 0) nd.hide(true)
        break
      case 'table':
        if (!(nd.state === 'table' && nd.cell === mode.noodleCell)) nd.spawnAt(mode.noodleCell, true)
        break
      case 'sees':
        if (nd.state === 'held') break
        if (!(nd.state === 'table' && nd.cell === 'A2')) nd.spawnAt('A2', true)
        else if (arm.atTarget(0.03)) nd.grab()
        break
      case 'held':
        if (nd.state !== 'held' && arm.atTarget(0.05)) nd.holdLocal(plans.B2.heldLocal)
        break
      default: // 'auto': loops place their own noodle; when parked (reduced motion) show it waiting at B2
        if (reduced && nd.state !== 'table' && !(nd.state === 'cup' || nd.state === 'falling')) nd.spawnAt(mode.noodleCell, false)
    }
  }

  function setChapter(id) {
    if (!MODES[id]) return
    const wasSandbox = chapter === 'sandbox'
    if (id === 'data' && chapter !== 'data' && !OFF.has('hatch') && !reduced) { // B2's hatch draws itself in on arrival
      sb.hatchArmed = true; sb.hatch = 0
      if (!sb.laidOut && !OFF.has('layout')) { sb.laidOut = true; sb.layout = 0 } // the first time: the grid lays itself out
    }
    // "one job" opens calm: a hero loop task still running (a fast scroll or a jump from the top) is let go and the arm
    // glides to rest from wherever it is, carrying its velocity (no pop); the next loop chapter starts its loop afresh
    if (id === 'data' && chapter !== 'data' && arm.cur?.auto && !reduced && !OFF.has('calm')) arm.abortAuto()
    chapter = id
    mode = MODES[id]
    if (id === 'results' && sb.group === 'next' && !OFF.has('close')) mode = MODES.built // the close: home pose, no loop
    if (wasSandbox && engaged) releaseControls()
    if (wasSandbox && id !== 'sandbox') arm.resume() // a task paused in the sandbox plays on when you scroll away
    if (mode.loop !== loopPrev) { loopIdx = 0; loopPrev = mode.loop }
    const blended = blend.on && !reduced // the scroll-linked blend owns the camera and the resting pose
    if (!blended) camRig.setShot(mode.shot, reduced)
    // overlays for the new chapter wait for the camera to land, then a beat
    gateAt = reduced ? 0 : time + (blended ? 0.1 : camRig.remaining() + 0.25)
    governor.reset(); lastRender = null
    if (!blended) arm.setTarget(poses[mode.pose], reduced)
    // a held noodle from a previous static pose is dismissed unless the new mode wants it
    if (noodle.state === 'held' && !arm.cur && mode.noodle !== 'held' && mode.noodle !== 'sees') noodle.hide(true)
    if (reduced) stepParams(P, mode, 0, { gateOpen: true, reduced: true })
  }

  // the cell a run is working on (explicit runTask, or the loop task) - only in chapters that label cells
  function highlightCell() {
    if (mode.label < 0.5) return null
    return arm.cur ? arm.cur.plan.cell : null
  }
  // the cell whose tile is covered by the noodle / gripper right now (label steps aside)
  function occupiedCell() {
    if (noodle.state === 'table') return noodle.cell
    const ph = arm.phase()
    return ph === 'descend' || ph === 'grasp' ? arm.cur.plan.cell : null
  }

  // With the scroll-linked blend, free orbit is only allowed while the camera is (almost) entirely on the sandbox shot.
  function camOnSandbox() {
    if (!blend.on) return true
    return (blend.to === 'sandbox' && blend.t > 0.9) || (blend.from === 'sandbox' && blend.t < 0.1)
  }

  function releaseControls() {
    if (!engaged) return
    camRig.adopt(camera.position, input.controls.target)
    input.release()
    engaged = false
  }

  function applyDpr(d) {
    dpr = d
    renderer.setPixelRatio(d)
    renderer.setSize(w, h, false)
    fx.setPixelRatio(d)
    trail.setPixelRatio(d)
    gauges.setResolution(w * d, h * d)
    syncViewport()
  }

  // --- frame ---
  const _look = new THREE.Vector3()
  const smooth01 = (t) => t * t * (3 - 2 * t)
  function step(dt) {
    time += dt
    const blended = blend.on && !reduced
    stepParams(P, mode, dt, { gateOpen: time >= gateAt && (!blended || camRig.landed()), reduced })

    // arm + noodle
    let speed = mode.speed
    if (arm.cur?.auto && !mode.loop) { // a loop task outlives its chapter: before the grasp the arm just glides on, after it finishes briskly
      if (blended && arm.yieldAuto()) speed = mode.speed
      else speed = blended ? 1.5 : 2.6
    } else if (reduced && arm.cur && !arm.cur.auto) speed = 3 // explicit tasks still play, just briskly
    speedS = reduced || !blended ? speed : speedS + (speed - speedS) * (1 - Math.exp(-dt * 2.4)) // rate changes ease in and out
    speed = speedS
    arm.snap = reduced
    arm.update(dt, { speed, loopCell })
    noodle.update(dt)
    noodleIntent()
    ground.update(noodle.mesh)

    // exploded view: plateau in the middle of the pin, joint labels revealed one at a time
    const pArm = progress.arm ?? 0
    const eT = mode.explode ? smooth01(Math.sin(Math.PI * Math.min(1, Math.max(0, pArm)))) : 0
    const prevE = explodeE
    explodeE += (eT - explodeE) * (reduced ? 1 : 1 - Math.exp(-dt * 6))
    if (explodeE < 0.001) explodeE = 0
    fxRobot.typing = !OFF.has('type') && !reduced
    // Stage B: the exploded parts breathe (a slow +-4 % swell) once they are apart
    const breathe = mode.explode && !reduced && !OFF.has('breathe') ? 1 + 0.04 * Math.sin(time * 1.2) * smooth01(Math.min(1, explodeE * 1.4)) : 1
    if (explodeE > 0 || prevE > 0) {
      fxRobot.applyExplode(explodeE * breathe, camera.position.z < 0 ? -1 : 1)
      fxRobot.placeLabels(explodeE, camera, w, h)
    }
    camRig.autoOffset = mode.explode ? (pArm - 0.5) * 0.4 : 0
    fxRobot.applyHeat(dt, params.heat)

    // grid, episodes, protocol illustrations
    const gridDist = camera.position.distanceTo(GRID_CENTER)
    const cellPx = GRID.w * (h / (2 * gridDist * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)))
    grid.update(dt, {
      cellPx, narrow: w <= 640, activeCell: highlightCell(), cameraPos: camera.position, cameraMatrix: camera.matrixWorld, occupiedCell: occupiedCell(),
      lineAlpha: params.line, fillScale: params.fill, labelAlpha: params.label * (1 - sb.dive), dim: params.dim,
      pulse: params.pulse, crossAlpha: params.cross, hatchDraw: sb.hatch, layout: sb.layout,
    })
    // B2 hatch draw-on (600 ms) once the camera has landed on the grid; scrolling back and in again redraws it
    // (the very first time, the grid first lays itself out cell by cell, stepped, then the hatch draws)
    if (reduced || chapter !== 'data') { sb.hatchArmed = false; sb.hatch = 1; sb.layout = 1 }
    if (sb.hatchArmed && time >= gateAt && (!blended || camRig.landed())) sb.hatchArmed = false
    if (!sb.hatchArmed) {
      sb.layout = Math.min(1, sb.layout + dt / 0.75)
      if (sb.layout >= 1) sb.hatch = Math.min(1, sb.hatch + dt / 0.6)
    }
    // Dots, arcs and the recording path answer the scrub instantly (no spring, no camera-landing stagger), and the
    // whole set is complete by DATA_FILL_END of the pin; the rest of the pin holds the finished picture + B2 tethers.
    const pData = progress.data ?? 0
    const inData = mode.dots > 0.5 ? 1 : 0
    const holdLane = !inData && sb.dive > 0.02 // leaving the pin from the dive: the noodles stay while the camera eases out
    const shownCount = inData || holdLane ? episodeAt(Math.min(1, pData / DATA_FILL_END)).count : 0
    const fk = inData ? 1 : 1 - Math.exp(-dt * 30) // snap in, brief cut-out when leaving
    dataVis += (inData - dataVis) * (reduced ? 1 : fk)
    if (inData) dataVis = 1
    // Stage B lane dive: over the last 8 % of the pin the camera drops to table height and looks along the rows at the empty
    // B2 (desktop / landscape only; reduced motion cuts to it). The arcs and the recording path step aside for it.
    const diveOn = inData && !OFF.has('lane') && !OFF.has('dive') && camRig.aspect >= 1 && sb.group !== 'setup'
    const diveT = diveOn ? (reduced ? (pData > 0.96 ? 1 : 0) : smooth01(Math.min(1, Math.max(0, (pData - 0.92) / 0.08)))) : 0
    if (reduced || camRig.aspect < 1) { sb.dive = diveT; sb.diveV = 0 } else {
      // critically damped spring (exact step): starts and lands with zero velocity, so leaving the pin from the dive glides
      // out like the other camera moves instead of an exponential's first-frame kick; slower on the way out (no scroll drives it)
      const om = inData ? 6 : 1.8, x = sb.dive - diveT, e = Math.exp(-om * dt), q = (sb.diveV + om * x) * dt
      sb.diveV = (sb.diveV - om * q) * e
      sb.dive = Math.min(1, Math.max(0, diveT + (x + q) * e))
    }
    if (sb.dive < 1e-3 && diveT === 0) { sb.dive = 0; sb.diveV = 0 }
    const clear = 1 - Math.max(sb.dive, flightFocus?.clear || 0) // flight page: the arcs / path also step aside in its dive (any aspect)
    episodes.update(dt, { dotsAlpha: holdLane ? 1 : dataVis, arcsAlpha: dataVis * 0.9 * clear, count: shownCount })
    if (!OFF.has('lane')) for (const c of episodes.landed) grid.tick(c)
    protoviz.update(dt, { count: shownCount, pathAlpha: dataVis * clear, hold: dataVis * clear * smooth01(Math.min(1, Math.max(0, (pData - DATA_FILL_END) / 0.1))) })

    // trail, frustums
    const plan = arm.cur?.plan
    trail.update(dt, {
      plan, planTime: arm.t, alpha: params.trail, targetN: policy === 'act' ? 100 : 50,
      color: policy === 'act' ? PAL.trail : PAL.arc,
    })
    frustums.update(params.frustum, rig.tcp)
    gaugeDim += ((gaugesYield ? 0.5 : 1) - gaugeDim) * (1 - Math.exp(-dt * 5))
    gauges.update(dt, gaugeOverride ?? mode.gauges, camera, gaugeDim)
    placement.setEnabled(chapter === 'sandbox')
    placement.update(dt)
    {
      // phase path: the task in view is the running one, else the last finished one (still scrubbable)
      const pm = phaseOverride === false ? 'off' : (phaseOverride === true ? (mode.phases ?? 'full') : (mode.phases ?? 'off'))
      if (arm.cur && arm.cur.plan !== planOwner.plan) { planOwner.plan = arm.cur.plan; planOwner.chapter = chapter } // the chapter that started this task
      const shownPlan = planOwner.chapter === chapter ? arm.plan : null // hero's last task is not shown in the sandbox
      gaugesYield = pm === 'full' && !!shownPlan
      for (let i = 0; i < JOINT_NAMES.length; i++) armPts[i].setFromMatrixPosition(rig.joints[JOINT_NAMES[i]].matrixWorld)
      armPts[JOINT_NAMES.length].setFromMatrixPosition(rig.tcp.matrixWorld)
      labelObs.length = 0
      if (params.label > 0.3) {
        for (const id of CELLS) {
          const c = grid.cells[id]
          if (!c.el || c.lastLabel === 0) continue
          const o = labelPool[id] ?? (labelPool[id] = { p: new THREE.Vector3(), w: 0, h: 26 })
          o.p.set(c.group.position.x + c.lx, c.group.position.y + 0.006, c.group.position.z + c.lz)
          o.w = c.held ? (w <= 640 ? 118 : 146) : (w <= 640 ? 38 : 44)
          labelObs.push(o)
        }
      }
      const stacked = isStacked(w, h) // text under the 3D (phones and portrait tablets, see stacked.js) vs a column on the left (landscape and desktop)
      const minX = stacked ? 0 : textColumnRight(w) + 8, maxY = stacked ? (stackedSceneBottom(w, h) - 0.03) * h : h
      markers.update(dt, {
        mode: pm, interactive: chapter === 'sandbox', running: !!arm.cur && !arm.paused, plan: shownPlan, t: arm.cur ? arm.t : (shownPlan ? shownPlan.duration : 0),
        w, h, dpr: governor.dpr, armPts, labels: labelObs, minX, maxY,
      })
      camera.updateMatrixWorld()
      placeHint.update(dt, { enabled: chapter === 'sandbox', idle: !arm.busy && !placement.busy, reduced, w, h, minX, maxY })
    }

    // lights / exposure / ring
    const dimmed = 1 - params.testLight * 0.62
    studio.setLightScale(dimmed, params.testLight * 0.04, params.kick)
    studio.setRingMin(params.ringFull)
    camera.getWorldDirection(_camDir).negate()
    moments.update(dt, { chapter, group: sb.group, phase: arm.phase(), cell: arm.cur ? arm.cur.plan.cell : null, reduced, camDir: _camDir })
    if (explodeE > 0.02 && !OFF.has('breathe') && moments.b2Level < 0.01) {
      // warm light between the exploded parts: the room's accent light (otherwise B2's) hung at the elbow, a touch toward
      // the camera; it breathes with the parts. No new light (a new one would recompile every material).
      rig.joints.elbow_flex.getWorldPosition(_ovP).lerp(camera.position, 0.06)
      studio.amber.position.copy(_ovP)
      studio.amber.color.setRGB(1, 0.62, 0.32)
      studio.amber.distance = 0.5
      studio.amber.intensity = 0.2 * explodeE * (0.85 + 0.15 * Math.sin(time * 1.2)) * (1 - PAL.light)
    }
    studio.updateRing(dt)
    themeFx.update(dt)
    renderer.toneMappingExposure = params.exposure * themeFx.exposure

    // camera: authored flights + in-chapter dollies (+ OrbitControls in the sandbox)
    dollies.update(dt, { chapter, progress, running: !!arm.cur, tcpObj: rig.tcp, reduced, b2Peak: !OFF.has('b2') })
    // Stage B authored poses on top: the lane's macro dive, then the close's return to the hero halo framing
    const ov = camRig.ov
    ov.k = 0
    if (sb.dive > 0) {
      const d = camRig.resolve('data')
      ov.k = sb.dive // the spring above is already eased at both ends
      // from the C side, low, a longish lens: the lanes run away through B2's gap to the cup; B2 right of the text column
      ov.pos.set(0.236, 0.095, -0.47); ov.look.set(0.2225, 0.0, 0.015); ov.fov = 17; ov.dx = Math.max(0.2, d.dx); ov.dy = -0.06
    } else if (moments.closeK > 0) {
      const r = camRig.resolve('hero')
      ov.k = smooth01(moments.closeK)
      ov.pos.fromArray(r.pos); ov.look.fromArray(r.look); ov.fov = r.fov; ov.dx = r.dx; ov.dy = r.dy
      ov.pos.sub(ov.look).multiplyScalar(1.16).add(ov.look) // the hero shot is fitted to its loop; the home pose reaches past it (gripper cut at the right edge)
    }
    if (flightCam && flightCam.k > 0) { // flight page: its authored path on top of every other pose (k eases the hand-off)
      const fk = Math.min(1, flightCam.k), fc = flightCam
      _flP.fromArray(fc.pos); _flL.fromArray(fc.look)
      if (ov.k <= 0) { ov.pos.copy(_flP); ov.look.copy(_flL); ov.fov = fc.fov; ov.dx = fc.dx || 0; ov.dy = fc.dy || 0; ov.k = fk } else {
        ov.pos.lerp(_flP, fk); ov.look.lerp(_flL, fk); ov.fov += (fc.fov - ov.fov) * fk
        ov.dx += ((fc.dx || 0) - ov.dx) * fk; ov.dy += ((fc.dy || 0) - ov.dy) * fk; ov.k += (1 - ov.k) * fk
      }
    }
    const flHeld = !!(flightCam && flightCam.k > 0) // r12 NAV request: the flight's path owns the camera whenever k > 0
    // round 13 (the owner's log: a 32 cm one-frame teleport at rest in the sandbox, 20 deg of azimuth about the look point):
    // the rig kept orbitAngle from the film / results / limits shots (their slow orbit accumulates and setShot never resets
    // it), so the frame the flight handed the camera back (k 1 -> 0) showed the sandbox shot rotated by it. The rig now
    // ADOPTS the pose the flight left the camera in (resets orbitAngle / the pointer offset) and the orbit engages there.
    if (flightCam && !flHeld && flWasHeld) { // the rig's update adds its modifiers on top of s: store s so the result IS the pose
      const m = camRig.mods, kk = Math.min(0.95, m.lookK)
      const sL = _flL.clone(), sP = _flP.clone()
      if (kk > 0) { sL.addScaledVector(m.lookTo, -kk).multiplyScalar(1 / (1 - kk)); sP.addScaledVector(_d0.copy(m.lookTo).sub(sL), -kk) } // undo the look-at pull
      if (m.scale !== 1) sP.sub(sL).multiplyScalar(1 / m.scale).add(sL) // undo the distance scale
      camRig.adopt(sP, sL)
    }
    flWasHeld = flHeld
    if (engaged && (!camOnSandbox() || flHeld)) releaseControls() // scrolling out of the sandbox: hand the camera back before it blends away
    if (mode.orbit && !engaged && camRig.settled() && !reduced && camOnSandbox() && !flHeld) {
      camRig.update(dt, { drift: false })
      if (flightCam) _look.set(camRig.s[3], camRig.s[4], camRig.s[5]) // the flight: engage on the adopted look (no re-aim)
      else _look.set(camRig.t[3], camRig.t[4], camRig.t[5])
      _engageLook.copy(_look)
      input.engage(_look)
      engaged = true
    } else if (engaged) {
      camRig.update(dt, { drift: false, write: false })
      dollies.leanTarget(input.controls.target, _engageLook)
      input.update()
    } else camRig.update(dt, { drift: mode.drift })
    camera.updateMatrixWorld()
    trackMotion(dt)
    stepLook(dt)
    if (fx.merged) {
      const u = fx.finish.uniforms
      // round 6 seam (setSeam, flight chapter hand-offs) rides the same uniform branch as Stage B's section hand-off; it wins
      // when larger and adds the haze breath. A caller that stops sending lets it decay on its own (never stuck on).
      if (seam.a > 0 && time - seam.t > 0.25) seam.a = Math.max(0, seam.a - dt * 4)
      const sa = OFF.has('seam') || reduced ? 0 : seam.a
      // round 7 veil: B's chapter jumps (depth-aware where the flight has a depth texture)
      u.uVeil.value = OFF.has('veil') ? 0 : veil.a
      // the scene's screen motion this frame (a point 2.5 m ahead, last frame's view-projection vs now): the veil's mist pans
      // with it at three depths and the specks streak along it. Cheap: one matrix + two projections per frame.
      _vp.copy(camera.position).addScaledVector(camera.getWorldDirection(_vd), 2.5).applyMatrix4(veil.prevVP)
      const vx = veil.has ? (_vp.x * 0.5 + 0.5 - 0.5) : 0, vy = veil.has ? (_vp.y * 0.5 + 0.5 - 0.5) : 0
      veil.prevVP.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse); veil.has = true
      if (veil.a > 0) {
        if (veil.warm) u.uVeilCol.value.setRGB(0.66, 0.47, 0.33); else u.uVeilCol.value.copy(scene.background).multiplyScalar(1.6).offsetHSL(0, 0, 0.004)
        u.uVeilWarm.value = veil.warm ? 1 : veil.light ? 2 : 0
        u.uVeilDepth.value = fx.dof ? 1 : 0; u.uVeilT.value = time
        const asp = w / h
        u.uVeilPan.value.x -= vx * asp; u.uVeilPan.value.y -= vy // content moves opposite to the camera: the mist with it
        u.uVeilVel.value.set(-vx * asp / Math.max(dt, 1e-3), -vy / Math.max(dt, 1e-3))
        studio.ring.getWorldPosition(_vr)
        const front = _vr.clone().applyMatrix4(camera.matrixWorldInverse).z < -0.05
        _vr.project(camera)
        u.uRingVis.value = front ? 1 : 0
        u.uRingUv.value.set(_vr.x * 0.5 + 0.5, _vr.y * 0.5 + 0.5)
        u.uRingR.value = RING.radius / Math.max(0.05, camera.position.distanceTo(studio.ring.getWorldPosition(_vd2))) / Math.tan(camera.fov * Math.PI / 360) * 0.5
      }
      if (sa > moments.handK) { u.uHand.value = sa; u.uHandDir.value = seam.dir; u.uHandSeed.value = seam.seed; u.uSeamHaze.value = 1 } else {
        u.uHand.value = moments.handK; u.uHandDir.value = moments.handDir; u.uHandSeed.value = moments.handSeed; u.uSeamHaze.value = 0
      }
      // the dive's focus falloff: up to ~10 CSS px on the near rows, focus line through B2
      u.uTilt.value = touch ? 0 : 14 * governor.dpr * sb.dive * sb.dive
      u.uSceneKeep.value = 0.7 * sb.dive // the dive's frame is full-bleed: the 3D steps back under the text column
      if (sb.dive > 0) u.uTiltY.value = _b2p.set(0.2225, 0, 0).project(camera).y * 0.5 + 0.5
      if (flightFocus) { // flight page: the same fake focus falloff, focus line through a world point (stand-in until real DoF)
        u.uTilt.value = touch ? 0 : flightFocus.px * governor.dpr
        if (flightFocus.at) u.uTiltY.value = _b2p.fromArray(flightFocus.at).project(camera).y * 0.5 + 0.5
        u.uSceneKeep.value = flightFocus.keep || 0
        if (fx.dof && !OFF.has('dof')) { // flight with a depth texture: real DoF (fx.js DofGather) replaces the screen-y stand-in (?off=dof keeps the stand-in); off on touch
          u.uTilt.value = 0
          fx.dof.aperture = touch ? 0 : 1.6 * flightFocus.px * governor.dpr // path focus px -> far CoC at infinity
          if (flightFocus.at) fx.dof.focus = -_b2p.fromArray(flightFocus.at).applyMatrix4(camera.matrixWorldInverse).z
        }
      } else if (fx.dof) fx.dof.aperture = 0
    }
  }


  // round 11: is the camera travelling (not a hold's slow breath)? Above ~2 cm/s or ~1.5 deg/s, held 0.3 s after it stops.
  // Moving frames get the cheaper DoF gather (fx.js DofGather.moving); nothing changes at rest.
  const camMot = { pos: new THREE.Vector3(), dir: new THREE.Vector3(), has: false, still: 1, moving: false }
  const _cmd = new THREE.Vector3()
  function trackMotion(dt) {
    camera.getWorldDirection(_cmd)
    if (camMot.has && dt > 0) {
      const v = camera.position.distanceTo(camMot.pos) / dt, w = Math.acos(Math.min(1, _cmd.dot(camMot.dir))) / dt
      camMot.still = v > 0.02 || w > 0.026 ? 0 : camMot.still + dt
    }
    camMot.pos.copy(camera.position); camMot.dir.copy(_cmd); camMot.has = true
    camMot.moving = camMot.still < 0.3
    if (depth) globalThis.__pace?.setMoving?.(camMot.moving) // round 12 (flight): js/flight/pace.js tries 120 only at rest
    if (dprPending && !camMot.moving) { const d = dprPending; dprPending = 0; if (Math.abs(d - dpr) > 1e-3) applyDpr(d) }
    if (fx.dof) fx.dof.moving = camMot.moving && !OFF.has('dofmove')
  }
  const seam = { a: 0, dir: 1, seed: 0, t: -9 } // round 6: stage.setSeam (flight)
  const rakeGate = { n: 0, dirty: false, kd: false }
  const veil = { a: 0, warm: false, light: false, prevVP: new THREE.Matrix4(), has: false } // round 7: stage.setVeil (flight)
  const _vp = new THREE.Vector3(), _vd = new THREE.Vector3(), _vr = new THREE.Vector3(), _vd2 = new THREE.Vector3()
  // Shadow casters' world matrices + visibility, compared with the last drawn shadow. Matrices are brought up to date here
  // (the render would do it anyway a moment later), so a pose, explode offset or noodle hand-off is never a frame late.
  let casters = null, casterSig = null
  function shadowGate() {
    if (!SHADOW_GATE) return
    if (!casters) {
      casters = []
      scene.traverse((o) => { if (o.castShadow && (o.isMesh || o.isLight)) casters.push(o) })
      casterSig = new Float32Array(casters.length * 17)
    }
    scene.updateMatrixWorld()
    let moved = false
    for (let i = 0, k = 0; i < casters.length; i++, k += 17) {
      const o = casters[i]
      let vis = o.visible
      for (let p = o.parent; vis && p; p = p.parent) vis = p.visible
      const v = vis ? 1 : 0
      if (casterSig[k] !== v) { casterSig[k] = v; moved = true }
      const e = o.matrixWorld.elements
      for (let j = 0; j < 16; j++) if (casterSig[k + 1 + j] !== e[j]) { casterSig[k + 1 + j] = e[j]; moved = true }
    }
    if (episodes.takeShadowDirty()) moved = true // lane noodles move as instances, which the matrix check cannot see
    // round 11 (flight, ?off=shadowmix = round 6): while casters move, the key map and the rake's long soft map take turns,
    // one map per frame (each at 60 Hz on a 120 Hz screen; the arm moves a few mm per 8 ms), and both redraw once when the
    // motion stops, so a resting frame is exact. Round 6 drew the key every moving frame + the rake every 3rd (1.33 maps).
    if (flightRake?.castShadow && !OFF.has('shadowmix')) {
      const ks = studio.key.shadow
      if (ks.autoUpdate) ks.autoUpdate = false // per-light gating from here on (needsUpdate set at load: precompile drew it)
      if (moved) {
        rakeGate.n++
        if (rakeGate.n % 2 === 0) { ks.needsUpdate = true; rakeGate.kd = false; rakeGate.dirty = true } else { flightRake.shadow.needsUpdate = true; rakeGate.dirty = false; rakeGate.kd = true }
        renderer.shadowMap.needsUpdate = true
      } else if (rakeGate.dirty || rakeGate.kd || renderer.shadowMap.needsUpdate) { // (or someone else asked for a redraw: theme, restore)
        ks.needsUpdate = true; flightRake.shadow.needsUpdate = true; renderer.shadowMap.needsUpdate = true
        rakeGate.dirty = rakeGate.kd = false
      }
      return
    }
    if (moved) renderer.shadowMap.needsUpdate = true
    // round 6: the rake's long soft shadow follows at most every 3rd moving frame (+ once when motion stops), so a moving arm
    // costs one shadow map per frame, not two
    if (flightRake?.castShadow) {
      if (moved) rakeGate.n++
      if ((moved && rakeGate.n % 3 === 0) || (!moved && rakeGate.dirty)) { flightRake.shadow.needsUpdate = true; renderer.shadowMap.needsUpdate = true; rakeGate.dirty = false } else if (moved) rakeGate.dirty = true
    }
  }

  function frame(now) {
    raf = requestAnimationFrame(frame)
    if (last === null) last = now
    let dt = Math.min(0.25, Math.max(0, (now - last) / 1000))
    last = now
    acc += dt
    const cap30 = mode.ambient && capAmbient // battery-friendly 30 fps only for ambient chapters on small/weak devices
    if (cap30 && acc < 1 / 30 - 0.002) return
    dt = acc
    acc = 0
    if (lost) return
    if (beforeFrame) beforeFrame(Math.min(dt, 0.25), now) // flight page: its director runs INSIDE this frame (no 1-frame camera lag)
    step(Math.min(dt, 0.25))
    shadowGate()
    fx.render(dt, time)
    labelRenderer.render(scene, camera)
    lastFrameAt = performance.now()
    framesDrawn++
    if (!cap30) { // budget governor: only fed by back-to-back full-rate frames
      if (lastRender !== null) governor.sample(now - lastRender)
      lastRender = now
    } else lastRender = null
    aoPolicy(dt)
  }

  // Live AO only where there is room for it: a 60 Hz display at full resolution (the page uses under half that budget there).
  // On 120 Hz screens it doubled the missed frames (M3 Pro), so it stays off; it also yields as soon as the governor has to
  // drop resolution. Toggled at runtime (no shader recompile) and faded, never popped.
  const aoState = { want: query.has('ssao'), k: 0, frames: 0 }
  function aoPolicy(dt) {
    if (!fx.gtao) return
    aoState.frames++
    // decide once the governor's first window is in (45 warm-up + 90 frames: its refresh-period estimate exists), so AO is
    // settled before the flight's print at ~2.7 s (at 240 it switched on mid-print: the opening's 1-2 vsync slips, round 6)
    // The flight (depth) never runs it: a long frame period there means a heavy frame, not a 60 Hz screen, so on a 120 Hz Mac
    // it switched AO on and pinned camera moves at 16.7/25 ms (2026-10-31, owner: "its just not smooth"); the baked AO stays
    if (!query.has('ssao') && aoState.frames > 135) aoState.want = !depth && governor.period > 12 && governor.dpr >= dprMax() - 1e-3
    aoState.k = THREE.MathUtils.clamp(aoState.k + (aoState.want ? dt : -dt) / 0.6, 0, 1)
    fx.gtao.enabled = aoState.k > 0
    fx.finish.uniforms.uAO.value = 0.85 * aoState.k * aoState.k * (3 - 2 * aoState.k)
  }

  function start() {
    if (raf || disposed || paused || hidden || lost) return
    last = null
    acc = 0
    raf = requestAnimationFrame(frame)
  }
  function stop() { cancelAnimationFrame(raf); raf = 0 }

  const onVis = () => { hidden = document.hidden; hidden ? stop() : start() }
  document.addEventListener('visibilitychange', onVis)

  // --- WebGL context loss -----------------------------------------------------------------------------------------
  // iOS Safari drops the context of a tab under GPU-memory pressure (and when the app is backgrounded). three.js already
  // preventDefault()s and, on restore, re-initialises its GL state and lazily re-uploads every buffer/texture/program.
  // What it cannot restore is anything that only ever lived on the GPU: the PMREM environment map. So: stop drawing while
  // lost, rebuild the environment (+ reset shadow/governor state) when the browser hands the context back, and tell the
  // page ('stage:lost' / 'stage:restored' on the canvas) so it can show the static poster meanwhile. If the context does
  // not come back within DEAD_MS the page is told ('stage:dead') and re-creates the whole stage on a fresh canvas.
  const DEAD_MS = 3500
  let deadTimer = 0
  const emit = (name) => { try { canvas.dispatchEvent(new CustomEvent(name, { bubbles: true })) } catch { /* no DOM events: ignore */ } }
  function onLost(e) {
    e.preventDefault() // required, or the browser will never attempt a restore
    if (lost) return
    lost = true
    stop()
    emit('stage:lost')
    clearTimeout(deadTimer)
    deadTimer = setTimeout(() => { if (lost && !disposed) emit('stage:dead') }, DEAD_MS)
  }
  function onRestored() {
    clearTimeout(deadTimer)
    try {
      studio.envHolder.rt = null // its GL handles died with the old context: never dispose them against the new one
      studio.setEnvironment(renderer) // the only GPU-only resource
      renderer.shadowMap.needsUpdate = true
      governor.reset(); lastRender = null
      lost = false
      fx.render(0, time) // warm frame: re-uploads programs, buffers and targets before the first visible one
    } catch (err) { console.warn('stage: context restore failed', err); lost = true; emit('stage:dead'); return }
    emit('stage:restored')
    start()
  }
  canvas.addEventListener('webglcontextlost', onLost, false)
  canvas.addEventListener('webglcontextrestored', onRestored, false)
  if (renderer.getContext().isContextLost?.()) onLost({ preventDefault() {} })
  // rAF can be silently dropped after iOS suspends the page: restart the loop if no frame landed for a while.
  const watchdog = setInterval(() => {
    if (disposed || paused || hidden || lost || !raf) return
    if (performance.now() - lastFrameAt > 2500) { stop(); start() }
  }, 2000)
  const onPageShow = (e) => { if (e.persisted) { hidden = document.hidden; stop(); start() } }
  addEventListener('pageshow', onPageShow)

  const ro = new ResizeObserver(() => {
    const s = size()
    if (s.w === w && s.h === h) return
    w = s.w; h = s.h
    governor.setMax(dprMax())
    renderer.setPixelRatio(governor.dpr)
    renderer.setSize(w, h, false)
    fx.setSize(w, h)
    labelRenderer.setSize(w, h)
    placeLabels()
    camRig.setSize(w, h)
    trail.setPixelRatio(governor.dpr)
    gauges.setResolution(w * governor.dpr, h * governor.dpr)
    syncViewport()
  })
  ro.observe(canvas)
  if (parent !== canvas) ro.observe(parent)

  // Compile every program (including chapter-only ones: frustums, trail, dots, ghost noodle) off the main thread
  // before the first frame, so neither the loader ring nor a later scroll hitches on shader compilation.
  async function precompile() {
    const hidden = []
    scene.traverse((o) => { if (o.visible === false && (o.isMesh || o.isLine || o.isPoints || o.isGroup)) hidden.push(o) })
    hidden.forEach((o) => { o.visible = true })
    const prevTarget = renderer.getRenderTarget()
    try {
      renderer.setRenderTarget(fx.composer.renderTarget2) // same output format as the composer's scene pass
      const compile = async () => {
        if (renderer.extensions.has('KHR_parallel_shader_compile')) await renderer.compileAsync(scene, camera)
        else renderer.compile(scene, camera) // no async path (e.g. software GL): still front-load the hidden programs
      }
      // the arm's own materials AND its intro clones (vfx.js): the hand-back at the end of the intro must not compile
      if (assembly) { assembly.wear(false); await compile(); assembly.wear(true) }
      await compile()
    } catch { /* first real render compiles synchronously instead */ }
    renderer.setRenderTarget(prevTarget)
    // One warm frame with every chapter-only object present: uploads their buffers/textures now, not on first scroll-in.
    // Pass materials (rays march) only compile when they first draw, so the warm frames run them too; and the arm is drawn
    // in its own materials as well as the intro's, so the hand-back at the end of the intro is a plain draw.
    // Live AO (aoPolicy) runs in the warm frames too, so its normal/AO/denoise programs exist before it first switches on.
    if (fx.rays) fx.rays.gain = 1
    if (fx.gtao) fx.gtao.enabled = true
    try {
      if (assembly) { assembly.wear(false); fx.render(0, time); assembly.wear(true) }
      fx.render(0, time)
    } catch { /* ignore */ }
    if (fx.rays) fx.rays.gain = 0
    if (fx.gtao) fx.gtao.enabled = false
    hidden.forEach((o) => { o.visible = false })
  }

  // --- first frame, then resolve ---
  camRig.setSize(w, h)
  setChapter('hero')
  camRig.setShot('hero', true)
  noodle.spawnAt('B2', false)
  for (let i = 0; i < 3; i++) step(1 / 60)
  mark('warm steps')
  await precompile()
  mark('shaders compiled')
  fx.render(1 / 60, time)
  mark('first frame')
  labelRenderer.render(scene, camera)
  report(1)
  start()

  let autoReveal = setTimeout(() => stage.reveal(), 10000) // safety net if the page never calls reveal()

  const extras = createExtras({ studio, camera, canvas, fx, getTime: () => time, isReduced: () => reduced })

  const stage = {
    setChapter,
    /**
     * Scroll-linked camera + resting pose: the page is between chapter `fromId` and `toId`, `t` (0..1) of the way. The camera and
     * the arm's parked pose FOLLOW that blend through critically damped, speed-capped springs (no fixed-duration flights), so
     * scrolling back reverses smoothly. setChapter(id) still switches the scene mode (loops, overlays, sandbox).
     */
    setChapterBlend(fromId, toId, t) {
      if (!MODES[fromId] || !MODES[toId]) return
      const u = Math.min(1, Math.max(0, Number(t) || 0))
      blend.on = true; blend.from = fromId; blend.to = toId; blend.t = u
      if (reduced) return // reduced motion: setChapter cuts to the shot and pose
      const A = MODES[fromId], B = MODES[toId]
      camRig.setBlend(A.shot, B.shot, u)
      if (A.pose === B.pose) arm.setTarget(poses[B.pose])
      else {
        const e = smoothBlend(u), pa = poses[A.pose], pb = poses[B.pose]
        for (let i = 0; i < 6; i++) blendPose[i] = pa[i] + (pb[i] - pa[i]) * e
        arm.setTarget(blendPose)
      }
    },
    setProgress(id, p) { progress[id] = Math.min(1, Math.max(0, Number(p) || 0)) },
    setPolicy(which) { policy = which === 'smolvla' ? 'smolvla' : 'act' },
    setRingProgress(p) { studio.setRingProgress(p) },
    /** Round 6 (flight): ring emission/bloom level 0..1, eased in the studio (1 = the default look). Inert unless called. */
    setRingLevel(k) { if (!OFF.has('ringlevel')) studio.setRingLevel(k) },
    /**
     * Round 6 (flight): the chapter seam (Igloo's hand-off): edge/luma-masked 6-tap spectral fringe (<= 3 CSS px), blocky
     * row shear and a haze breath, all in the merged pass's existing uniform branch: exactly zero cost at 0. Pass the
     * eased 0..1 envelope every frame; dir = +-1 (scroll direction). Stops by itself if the caller stops sending.
     */
    /**
     * Round 7 (flight): a depth-aware fog/light wall in the merged pass, for chapter jumps. a 0..1 (hold it: it does NOT
     * decay on its own; 0 = off and exactly zero cost), tint 'ink' (the page's navy, lifted), 'warm' (a gold light wall) or
     * 'light' (a pale silver haze).
     * The far world goes first and near objects last, so it reads as volume. Pass the eased envelope each frame.
     */
    setVeil(a, tint = 'ink') { veil.a = Math.min(1, Math.max(0, Number(a) || 0)); veil.warm = tint === 'warm'; veil.light = tint === 'light' },
    setSeam(amount, dir = 1) {
      const a = Math.min(1, Math.max(0, Number(amount) || 0))
      if (seam.a <= 0 && a > 0) seam.seed = Math.random()
      seam.a = a; seam.dir = dir < 0 ? -1 : 1; seam.t = time
    },
    /**
     * Stage B: the page's section group under the reading line (index.html section.group id: setup, learned, proof, outcome,
     * next; null between groups, e.g. the sandbox). Crossing from one group into another plays the hand-off transition
     * (reversed when scrolling back up). Call before setChapter for the same scroll step.
     */
    setSection(id) {
      const g = id || null
      if (!g || g === sb.group) return
      const order = ['setup', 'learned', 'proof', 'outcome', 'next']
      const a = order.indexOf(sb.group), b = order.indexOf(g)
      if (a >= 0 && b >= 0) moments.handoff(b > a ? 1 : -1, reduced)
      sb.group = g
    },
    /** Recolour the scene from themes.js THEMES[name].stage (tweens ~0.6 s). Unknown names fall back to the default. */
    setTheme(name) {
      if (!THEMES[name]) console.warn(`stage: unknown theme "${name}"`)
      themeFx.set(name, reduced)
      if (!OFF.has('probe') && THEMES[name]) applyProbe(name) // each theme's studio has its own baked reflections
    },
    runTask(cell) {
      activeCell = cell
      const p = arm.runTask(cell)
      const clear = () => { if (activeCell === cell) activeCell = null }
      p.then(clear, clear)
      return p
    },
    onCellClick(cb) { if (typeof cb === 'function') clickCbs.push(cb) },
    /** Timeline of the task in view (the running one, else the last finished): normalised times, phase, pause state. */
    getTaskProgress() {
      const plan = arm.plan
      const p = taskProgress
      if (!plan) { p.running = false; p.paused = false; p.t = 0; p.duration = 0; p.phase = 'approach'; p.timeline = EMPTY; return p }
      const tt = arm.cur ? arm.t : plan.duration
      p.running = !!arm.cur
      p.paused = !!arm.cur && arm.paused
      p.t = Math.min(1, Math.max(0, tt / plan.duration))
      p.duration = plan.duration
      p.phase = arm.phaseAt(plan, tt)
      p.timeline = plan.timeline
      return p
    },
    pauseTask() { arm.pause() },
    resumeTask() { arm.resume() },
    /** u in 0..1 within the current / last task. Implies pause; the arm, noodle, gauges and phase words follow exactly. */
    scrubTask(u) { arm.scrub(Number(u) || 0) },
    onPhaseClick(cb) { if (typeof cb === 'function') markers.onClick(cb) },
    setPhaseMarkers(on) { phaseOverride = on === null || on === undefined ? null : !!on },
    setTextSafeArea(r) { markers.setSafeArea(r) }, // the page's measured text rect (viewport CSS px) or null: phase words stay out of it
    onTableClick(cb) { if (typeof cb === 'function') tableCbs.push(cb) },
    /** Sandbox only, and only while no task runs: a pulsing target with a tap ripple on an empty reachable table spot. */
    setPlaceHint(on) { placeHint.setWanted(!!on) },
    /** Viewport CSS px of the hint target (for a DOM tooltip), or null while the hint is not showing. */
    getPlaceHintScreenPos() {
      const p = placeHint.getScreenPos()
      if (!p) return null
      const r = canvas.getBoundingClientRect()
      return { x: r.left + p.x, y: r.top + p.y }
    },
    /** Pick from any table point. Plans live (IK on a mesh-free skeleton, spread over event-loop turns). */
    async runTaskAt(point) {
      const x = Number(point?.x), z = Number(point?.z)
      if (!Number.isFinite(x) || !Number.isFinite(z)) return 'unreachable'
      const pt = { x, z }
      if (!reachable(x, z) || Math.hypot(x - CUP.x, z - CUP.z) < CUP.rimR + 0.035) { placement.flashFail(pt); return 'unreachable' }
      placement.setPlanning(pt)
      const target = { cell: cellAtPoint(x, z), x, z, yaw: noodleYawAt(x, z) }
      let spec
      try {
        const it = solveTaskSteps(skelIK, HOME_Q, target, true)
        let r = it.next()
        while (!r.done) { await new Promise((res) => setTimeout(res, 0)); r = it.next() } // let a frame draw between waypoint solves
        spec = r.value
      } finally { placement.setPlanning(null) }
      if (!spec.ok || spec.tilt > 0.26) { placement.flashFail(pt); return 'unreachable' }
      await arm.runPlan(buildPlan(rig, ik, target, spec))
      return 'ok'
    },
    /** Displayed pose (radians, URDF zero) + task phase. Returns one reused object: copy what you need. */
    getJointState() {
      const js = jointState
      for (const n of JOINT_NAMES) js.joints[n] = rig.joints[n].angle
      const up = rig.limits.gripper[1]
      js.gripperOpen = Math.min(1, Math.max(0, rig.joints.gripper.angle / up)) // 0 = jaws closed (angle <= 0), 1 = URDF upper limit
      js.phase = arm.phase()
      js.cell = arm.cur ? arm.cur.plan.cell : null
      return js
    },
    /** 3D angle arcs at each joint. On by default in sandbox + policies; an explicit call overrides the chapter. */
    setJointGauges(on) { gaugeOverride = !!on },
    /** The page calls this once when the loader hands off: the ring ignites and the hero camera dollies in. */
    reveal() {
      clearTimeout(autoReveal)
      if (studio.revealed) return
      studio.reveal(reduced)
      camRig.startIntro()
      assembly?.play(reduced)
    },
    /** Flight intro2 (js/flight/intro.js): reveal()'s halves on the page's own beats. Inert unless called. */
    // igniteRing = reveal() minus the assembly: the ring + the rig's own intro clock (so camRig settles and the sandbox
    // orbit engages exactly as after reveal(); the flight's path overrides the rig's dolly meanwhile). reveal() is then a no-op.
    igniteRing() { clearTimeout(autoReveal); studio.reveal(reduced); camRig.startIntro() },
    printArm(instant = false) { assembly?.play(instant || reduced) },
    /** The ring's projected bounding box in CSS px (for the loader morph), or null if it is off-screen/behind. */
    getRingScreenRect: () => extras.getRingScreenRect(),
    /** One clean frame (no DOM) as a PNG, after a short ring flash. */
    snapshot: (opts) => extras.snapshot(opts),
    setReducedMotion(on) {
      reduced = !!on
      camRig.reduced = reduced
      if (reduced) {
        arm.abortAuto()
        arm.setTarget(poses[mode.pose], true)
        camRig.setShot(mode.shot, true)
        stepParams(P, mode, 0, { gateOpen: true, reduced: true })
        if (noodle.state === 'held' && !arm.cur && mode.noodle === 'auto') noodle.hide(false)
        if (!studio.revealed) stage.reveal()
        if (assembly?.playing) assembly.play(true) // reduced motion: the intro's final frame
      }
    },
    getFrameCount() { return framesDrawn },
    // --- flight page (js/flight; additive: nothing below runs unless flight.html calls it) ---
    /** Authored camera on top of every chapter pose: {pos:[3], look:[3], fov, dx, dy, k 0..1}, or null to hand back. */
    setCameraPath(c) { flightCam = c || null },
    /** Fake focus falloff (the dive's uTilt): {px CSS px of blur, at:[x,y,z] focus point, keep 0..1}, or null. */
    setFocus(f) { flightFocus = f || null },
    /** Flight page: run fn(dt, now) at the start of every drawn frame, before the scene steps (its camera then shows THIS
     *  frame's flight position: with a separate rAF it lagged one frame, which turned any long frame into a visible jump). */
    setBeforeFrame(fn) { beforeFrame = typeof fn === 'function' ? fn : null },
    /** Flight: the post chain (fx.js), for the depth-driven air uniforms (finish.uniforms.uAir*) and fx.dof. Inert getter. */
    getFX: () => fx,
    /** Flight: the dormant rake light (null on the default page). */
    getRakeLight: () => flightRake,
    /** Add a flight object into the stage scene (its shadows, fog, post), then precompile + warm it like the rest. */
    async addToScene(obj, { castShadow = false, receiveShadow = false } = {}) {
      obj.traverse((o) => { if (o.isMesh) { o.castShadow = castShadow; o.receiveShadow = receiveShadow } })
      scene.add(obj)
      casters = null // the shadow gate rebuilds its caster list
      await precompile()
    },
    /** Hide or show a stage set piece for the flight's island ('cyc' backdrop, 'table' light pool). */
    setSetPiece(name, on) {
      const o = name === 'table' ? ground.group.getObjectByProperty('name', 'table') : name === 'cyc' ? studio.cyc : null
      if (o) o.visible = !!on
      return o
    },
    /** Real part facts for a joint's servo: URDF mesh file + link + joint type/limits, Box3 size (mm), live q, the mesh. */
    getPartInfo(joint) {
      const mesh = rig.servoMeshes[joint]?.[0]
      if (!mesh) return null
      let link = mesh.parent
      while (link && !link.isURDFLink) link = link.parent
      const bb = mesh.geometry.boundingBox || (mesh.geometry.computeBoundingBox(), mesh.geometry.boundingBox)
      const size = bb.getSize(new THREE.Vector3()).multiplyScalar(1000)
      return { file: mesh.userData.file, link: link?.name, joint, type: rig.robot.joints[joint].jointType, limits: rig.limits[joint], sizeMM: [size.x, size.y, size.z], q: rig.joints[joint].angle, mesh, urdf: loadRobot.lastUrdf }
    },
    getCamera() { return camera },
    getRenderer() { return renderer }, // flight M1.5: KTX2Loader.detectSupport
    /** The servo materials per joint (their own ones, not the intro's dissolve clones the meshes may be wearing). */
    getServoMaterials() { return rig.servoMats },
    getBackground() { return scene.background },
    /** A chapter's fitted camera shot {pos, look, fov, dx, dy} at the current viewport (the flight's hand-off target). */
    resolveShot(id) { return camRig.resolve(id) }, // shared Color (themes recolour it in place)
    getView() { return { w, h, dpr: governor.dpr } },
    getTablePiece() { return ground.group.getObjectByProperty('name', 'table') },
    pause() { paused = true; stop() },
    resume() { paused = false; start() },
    dispose() {
      disposed = true
      clearTimeout(autoReveal)
      clearTimeout(deadTimer)
      clearInterval(watchdog)
      removeEventListener('pageshow', onPageShow)
      canvas.removeEventListener('webglcontextlost', onLost, false)
      canvas.removeEventListener('webglcontextrestored', onRestored, false)
      stop()
      document.removeEventListener('visibilitychange', onVis)
      ro.disconnect()
      input.dispose()
      gauges.dispose(); markers.dispose(); placement.dispose(); placeHint.dispose(); fxRobot.dispose(); frustums.dispose(); trail.dispose(); episodes.dispose(); protoviz.dispose(); grid.dispose(); ground.dispose()
      studio.dispose(); fx.dispose(); disposeRig(rig)
      scene.traverse((o) => { if (o.isMesh || o.isPoints || o.isLine) { o.geometry?.dispose?.(); const m = o.material; (Array.isArray(m) ? m : [m]).forEach((x) => x?.dispose?.()) } })
      scene.environment?.dispose?.()
      ld.remove()
      renderer.dispose()
      renderer.forceContextLoss()
    },
    // handy for tests / the dev page
    debug: { moments, sb, episodes, replayIntro() { assembly?.arm(); studio.replay(); camRig.intro.k = 1; camRig.intro.t = -1; camRig.startIntro(); assembly?.play(reduced) }, assembly, look, dust, fx, gauges, placeHint, governor, setCam(pos, look, fov = 30) { camRig.t = [...pos, ...look, fov, 0, 0]; camRig.s = [...camRig.t]; camRig.tw = null }, advance(sec, dt = 1 / 30) { for (let t = 0; t < sec; t += dt) step(dt); shadowGate(); fx.render(dt, time); labelRenderer.render(scene, camera) }, scene, camera, renderer, rig, arm, plans, ik, skelIK, placement, markers, noodle, camRig, params, studio, grid, get chapter() { return chapter }, get blend() { return blend }, get speed() { return speedS } },
  }
  if (new URLSearchParams(location.search).has('stagedebug')) { window.__stage = stage; window.__bootMarks = bootMarks } // test hooks, opt-in via ?stagedebug
  return stage
}
