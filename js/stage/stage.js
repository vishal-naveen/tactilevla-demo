// Stage orchestrator: renderer, scene, chapters, render loop. Implements the contract in CONTRACT.md.
import * as THREE from 'three'
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js'
import { loadRobot, disposeRig } from './robot.js'
import { makeIK } from './ik.js'
import { createStudio } from './studio.js'
import { buildCupMesh, Noodle } from './props.js'
import { createGround } from './ground.js'
import { createGrid } from './grid.js'
import { createEpisodes } from './episodes.js'
import { buildPlan, ArmController } from './tasks.js'
import { loadPlans } from './plans.js'
import { createRobotFx } from './robotfx.js'
import { createTrail } from './trail.js'
import { createFrustums } from './frustums.js'
import { createFX } from './fx.js'
import { CameraRig } from './shots.js'
import { createInput } from './input.js'
import { buildSubjects } from './subjects.js'
import { MODES, LOOPS, PARAM_KEYS } from './modes.js'
import { createParams, stepParams } from './overlay.js'
import { createGovernor } from './governor.js'
import { createProtoViz } from './protoviz.js'
import { createDollies } from './dolly.js'
import { createExtras } from './extras.js'
import { createThemeFX } from './themefx.js'
import { createGauges } from './gauges.js'
import { JOINT_NAMES } from './robot.js'
import { makeSkeleton } from './skeleton.js'
import { createPhaseMarkers } from './phasemarkers.js'
import { createPlacement, reachable } from './placement.js'
import { createPlaceHint } from './placehint.js'
import { solveTaskSteps } from './tasks.js'
import { PAL } from './palette.js'
import { DEFAULT_THEME, THEMES } from '../themes.js'
import { CELLS, episodeAt, DATA_FILL_END } from './protocol.js'
import { GRID, GRID_CENTER, CUP, cellAtPoint, noodleYawAt } from './layout.js'

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

export async function createStage(canvas, { onLoadProgress = () => {}, theme = DEFAULT_THEME } = {}) {
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
  const low = Math.min(window.innerWidth, window.innerHeight) < 700 || (navigator.hardwareConcurrency || 8) <= 4
  const dprCap = low ? 1.25 : 1.4
  let dpr = Math.min(window.devicePixelRatio || 1, dprCap)

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' })
  renderer.setPixelRatio(dpr)
  renderer.setSize(w, h, false)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.VSMShadowMap // real penumbra widening; PCFSoft ignores shadow.radius

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
  const studio = createStudio(scene, { shadowSize: low ? 1024 : 2048 })
  studio.setEnvironment(renderer)
  const ground = createGround(scene)
  const cup = buildCupMesh()
  scene.add(cup)
  const grid = createGrid(scene)
  const episodes = createEpisodes(scene)
  const protoviz = createProtoViz(scene)

  mark('renderer+world')
  const rig = await loadRobot((f) => report(f * 0.86))
  mark('robot loaded')
  scene.add(rig.root)
  const ik = makeIK(rig)
  const skelIK = makeIK(makeSkeleton(loadRobot.lastUrdf, rig.grasp, rig.limits)) // mesh-free kinematics for live planning
  const fxRobot = createRobotFx(rig)
  const frustums = createFrustums(scene, rig)
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
  camRig.setSubjects(buildSubjects({ rig, plans, loops: LOOPS, poses, explode: fxRobot.applyExplode }))
  camRig.setSize(w, h)

  mark('subjects')
  const fx = createFX(renderer, scene, camera, { low, width: w, height: h, dpr })
  const themeFx = createThemeFX({ studio, ground, fx })
  themeFx.set(theme, true)
  const input = createInput({
    canvas, camera, grid, camRig, getChapter: () => chapter,
    onClick: (cell) => { grid.ripple(cell); clickCbs.forEach((cb) => cb(cell)) },
    onTable: (pt, cell) => { placeHint.dismiss(); tableCbs.forEach((cb) => cb(pt, cell)) },
    onHover: (pt) => placement.setHover(pt),
  })

  // --- state ---
  let chapter = 'hero'
  let mode = MODES.hero
  const progress = {}
  const clickCbs = []
  const P = createParams(MODES.hero)
  const params = P.v
  const dollies = createDollies(camRig)
  const governor = createGovernor({ max: dpr, onChange: (d) => applyDpr(d) })
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
    chapter = id
    mode = MODES[id]
    if (wasSandbox && engaged) releaseControls()
    if (wasSandbox && id !== 'sandbox') arm.resume() // a task paused in the sandbox plays on when you scroll away
    if (mode.loop !== loopPrev) { loopIdx = 0; loopPrev = mode.loop }
    camRig.setShot(mode.shot, reduced)
    // overlays for the new chapter wait for the camera to land, then a beat
    gateAt = reduced ? 0 : time + camRig.remaining() + 0.25
    governor.reset(); lastRender = null
    arm.setTarget(poses[mode.pose], reduced)
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
  }

  // --- frame ---
  const _look = new THREE.Vector3()
  const smooth01 = (t) => t * t * (3 - 2 * t)
  function step(dt) {
    time += dt
    stepParams(P, mode, dt, { gateOpen: time >= gateAt, reduced })

    // arm + noodle
    let speed = mode.speed
    if (arm.cur?.auto && !mode.loop) speed = 2.6
    else if (reduced && arm.cur && !arm.cur.auto) speed = 3 // explicit tasks still play, just briskly
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
    if (explodeE > 0 || prevE > 0) {
      fxRobot.applyExplode(explodeE, camera.position.z < 0 ? -1 : 1)
      fxRobot.placeLabels(explodeE, camera, w, h)
    }
    camRig.autoOffset = mode.explode ? (pArm - 0.5) * 0.4 : 0
    fxRobot.applyHeat(dt, params.heat)

    // grid, episodes, protocol illustrations
    const gridDist = camera.position.distanceTo(GRID_CENTER)
    const cellPx = GRID.w * (h / (2 * gridDist * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)))
    grid.update(dt, {
      cellPx, narrow: w <= 640, activeCell: highlightCell(), cameraPos: camera.position, cameraMatrix: camera.matrixWorld, occupiedCell: occupiedCell(),
      lineAlpha: params.line, fillScale: params.fill, labelAlpha: params.label, dim: params.dim,
      pulse: params.pulse, crossAlpha: params.cross,
    })
    // Dots, arcs and the recording path answer the scrub instantly (no spring, no camera-landing stagger), and the
    // whole set is complete by DATA_FILL_END of the pin; the rest of the pin holds the finished picture + B2 tethers.
    const pData = progress.data ?? 0
    const inData = mode.dots > 0.5 ? 1 : 0
    const shownCount = inData ? episodeAt(Math.min(1, pData / DATA_FILL_END)).count : 0
    const fk = inData ? 1 : 1 - Math.exp(-dt * 30) // snap in, brief cut-out when leaving
    dataVis += (inData - dataVis) * (reduced ? 1 : fk)
    if (inData) dataVis = 1
    episodes.update(dt, { dotsAlpha: dataVis, arcsAlpha: dataVis * 0.9, count: shownCount })
    protoviz.update(dt, { count: shownCount, pathAlpha: dataVis, hold: dataVis * smooth01(Math.min(1, Math.max(0, (pData - DATA_FILL_END) / 0.1))) })

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
      const minX = w >= h ? 0.47 * w : 0, maxY = w >= h ? h : 0.47 * h // the page's text column (left, or lower half on portrait)
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
    studio.updateRing(dt)
    themeFx.update(dt)
    renderer.toneMappingExposure = params.exposure * themeFx.exposure

    // camera: authored flights + in-chapter dollies (+ OrbitControls in the sandbox)
    dollies.update(dt, { chapter, progress, running: !!arm.cur, tcpObj: rig.tcp, reduced })
    if (mode.orbit && !engaged && camRig.settled() && !reduced) {
      camRig.update(dt, { drift: false })
      _look.set(camRig.t[3], camRig.t[4], camRig.t[5])
      _engageLook.copy(_look)
      input.engage(_look)
      engaged = true
    } else if (engaged) {
      camRig.update(dt, { drift: false, write: false })
      dollies.leanTarget(input.controls.target, _engageLook)
      input.update()
    } else camRig.update(dt, { drift: mode.drift })
  }


  function frame(now) {
    raf = requestAnimationFrame(frame)
    if (last === null) last = now
    let dt = Math.min(0.25, Math.max(0, (now - last) / 1000))
    last = now
    acc += dt
    const cap30 = mode.ambient && low // battery-friendly 30 fps only for ambient chapters on small/weak devices
    if (cap30 && acc < 1 / 30 - 0.002) return
    dt = acc
    acc = 0
    step(Math.min(dt, 0.25))
    fx.render(dt, time)
    labelRenderer.render(scene, camera)
    if (!cap30) { // budget governor: only fed by back-to-back full-rate frames
      if (lastRender !== null) governor.sample(now - lastRender)
      lastRender = now
    } else lastRender = null
  }

  function start() {
    if (raf || disposed || paused || hidden) return
    last = null
    acc = 0
    raf = requestAnimationFrame(frame)
  }
  function stop() { cancelAnimationFrame(raf); raf = 0 }

  const onVis = () => { hidden = document.hidden; hidden ? stop() : start() }
  document.addEventListener('visibilitychange', onVis)

  const ro = new ResizeObserver(() => {
    const s = size()
    if (s.w === w && s.h === h) return
    w = s.w; h = s.h
    governor.setMax(Math.min(window.devicePixelRatio || 1, dprCap))
    renderer.setPixelRatio(governor.dpr)
    renderer.setSize(w, h, false)
    fx.setSize(w, h)
    labelRenderer.setSize(w, h)
    placeLabels()
    camRig.setSize(w, h)
    trail.setPixelRatio(governor.dpr)
    gauges.setResolution(w * governor.dpr, h * governor.dpr)
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
      if (renderer.extensions.has('KHR_parallel_shader_compile')) await renderer.compileAsync(scene, camera)
      else renderer.compile(scene, camera) // no async path (e.g. software GL): still front-load the hidden programs
    } catch { /* first real render compiles synchronously instead */ }
    renderer.setRenderTarget(prevTarget)
    // One warm frame with every chapter-only object present: uploads their buffers/textures now, not on first scroll-in.
    try { fx.render(0, time) } catch { /* ignore */ }
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
    setProgress(id, p) { progress[id] = Math.min(1, Math.max(0, Number(p) || 0)) },
    setPolicy(which) { policy = which === 'smolvla' ? 'smolvla' : 'act' },
    setRingProgress(p) { studio.setRingProgress(p) },
    /** Recolour the scene from themes.js THEMES[name].stage (tweens ~0.6 s). Unknown names fall back to the default. */
    setTheme(name) { if (!THEMES[name]) console.warn(`stage: unknown theme "${name}"`); themeFx.set(name, reduced) },
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
    },
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
      }
    },
    pause() { paused = true; stop() },
    resume() { paused = false; start() },
    dispose() {
      disposed = true
      clearTimeout(autoReveal)
      stop()
      document.removeEventListener('visibilitychange', onVis)
      ro.disconnect()
      input.dispose()
      gauges.dispose(); markers.dispose(); placement.dispose(); placeHint.dispose(); fxRobot.dispose(); frustums.dispose(); trail.dispose(); episodes.dispose(); protoviz.dispose(); grid.dispose(); ground.dispose()
      studio.dispose(); fx.dispose(); disposeRig(rig)
      scene.traverse((o) => { if (o.isMesh) { o.geometry?.dispose?.(); const m = o.material; (Array.isArray(m) ? m : [m]).forEach((x) => x?.dispose?.()) } })
      scene.environment?.dispose?.()
      ld.remove()
      renderer.dispose()
      renderer.forceContextLoss()
    },
    // handy for tests / the dev page
    debug: { fx, gauges, placeHint, governor, setCam(pos, look, fov = 30) { camRig.t = [...pos, ...look, fov, 0, 0]; camRig.s = [...camRig.t]; camRig.tw = null }, advance(sec, dt = 1 / 30) { for (let t = 0; t < sec; t += dt) step(dt); fx.render(dt, time); labelRenderer.render(scene, camera) }, scene, camera, renderer, rig, arm, plans, ik, skelIK, placement, markers, noodle, camRig, params, studio, grid, get chapter() { return chapter } },
  }
  if (new URLSearchParams(location.search).has('stagedebug')) { window.__stage = stage; window.__bootMarks = bootMarks } // test hooks, opt-in via ?stagedebug
  return stage
}
