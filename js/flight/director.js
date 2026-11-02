// Flight M1 director (flight.html): one pinned full-bleed stage over a 1200 vh spacer. The camera, the stage chapter, the
// arm's scrub, the count and the light are functions of the flight progress p, so scrolling back reverses everything.
// Drives the stage only through its public API (setChapter / setProgress / setSection / setRingProgress / scrubTask +
// the additive flight calls setCameraPath / setFocus / addToScene / setSetPiece / getPartInfo).
import * as THREE from 'three'
import Lenis from '../../vendor/lenis/lenis.mjs'
import { createStage } from '../stage/stage.js'
import { SHOTS } from '../stage/shots.js' // round 11: the flight's own (closer) sandbox shot
import { DEFAULT_THEME } from '../themes.js'
import { createWorld } from './world.js'
import { loadSurfaces, patchServo } from './surface.js'
import { createHud } from './hud.js'
import { sample, sceneAt, SCENES, PMAX, lookAt, lightP, SERVO_TH, SERVO_LIFT, SANDBOX_DIR } from './path.js'
import { MODES } from '../stage/modes.js' // round 13: limits parks the arm at home (flight only)
import { setGridTone, setGridStyle } from '../stage/grid.js' // round 6: colour reserved for events (flight only; inert on the default page)
import { tickScramble } from './scramble.js' // round 6: text decode clock
import { setFlightSeams, setFlightClose } from '../stage/moments.js' // round 6: one seam per chapter crossing (ours), not two
import { createNav, sceneStop } from './nav.js' // FULL SITE: Igloo-style stop-to-stop flights
import { createScenes } from './scenes.js' // FULL SITE: scenes 08-13, chapter index, explore panels, media, keyboard/hash nav
import { createIntro, INTRO_S, INTRO_LAND } from './intro.js' // INTRO: the opening build-in (intro2), its clock and its camera
import { createProps } from './props.js' // round 11: bench props + projector spill
import { createSound } from './sound.js' // SOUND hook: opt-in WebAudio (sound.js); inert until the toggle is clicked

const q = new URLSearchParams(location.search)
const CAPTURE = q.has('capture') // deterministic stills: the page is stepped by window.__flight.goto(p)
const reducedMQ = matchMedia('(prefers-reduced-motion: reduce)')
const clamp01 = (x) => Math.min(1, Math.max(0, x))
const smooth = (x) => { x = clamp01(x); return x * x * (3 - 2 * x) }
const lerp = (a, b, t) => a + (b - a) * t
const ramp = (p, a, b) => smooth((p - a) / (b - a))
const STEP_MAX = 0.03 // m per frame: the flight never moves the camera further than this in one frame (spec: <= 0.035)
const SPEED_MAX = 1.8 // m/s

const canvas = document.getElementById('fl-canvas')
// depth: the MSAA scene resolves a depth texture for the flight's real DoF + air (fx.js; the default page never asks)
const stage = await createStage(canvas, { theme: DEFAULT_THEME, depth: true, onLoadProgress: (f) => document.documentElement.style.setProperty('--fl-load', f) })
let reduced = reducedMQ.matches
stage.setTheme(DEFAULT_THEME)
stage.setTextSafeArea(null)
stage.setReducedMotion(reduced)
setFlightSeams(!!stage.setSeam) // the flight's own seams replace Stage B's section hand-off (inert without setSeam)
setFlightClose(true) // round 16: the close's ring = the hero's (no flash / rays at 13), so the loop's wrap onto 01 changes nothing
stage.setSection('learned') // no hand-off seam on the way in (the group was null); the one seam fires at S8 (-> proof)
stage.setPhaseMarkers(false)
// round 11 ("Try it yourself" was dark and small): a closer, lower sandbox shot, fitted by the stage like its own (the rig,
// its orbit and the director's hand-over all resolve the same entry). Flight only: this module never runs on the default page.
// round 13: the sandbox shot sits on the flight's orbit (path.js SANDBOX_DIR, azimuth 262 deg: the C side, grid in front)
if (!q.get('off')?.split(',').includes('sbshot')) { SHOTS.sandbox = { ...SHOTS.sandbox, dir: SANDBOX_DIR, fov: 32, pull: 1.05 }; stage.debug.camRig.cache.clear() }
// round 13 (owner's limits screenshot, "this is messed up"): limits parked the arm in the folded REST pose (upper arm and
// forearm side by side, the wrist hanging): seen close it read as a broken arm. The flight's limits stands it at home.
MODES.limits = { ...MODES.limits, pose: 'home' }
const GRIDLIGHT = !q.get('off')?.split(',').includes('gridlight') // round 11: the cells are projected light on the table (`?off=gridlight` = round 10)
stage.setJointGauges(false)

// the island replaces the cyclorama and the light-pool disc
const table = stage.getTablePiece()
const world = createWorld(table, stage.getBackground(), stage.getRakeLight) // INTRO: + the stage's rake light
stage.setSetPiece('cyc', false)
stage.setSetPiece('table', false)
world.set({ grow: 9, band: 0, lat: 1, latAlpha: 0.35 })
// M1.5 surfaces: servo housings patched before the precompile below re-runs (one program for all six); KTX2 swaps in
for (const j of ['shoulder_pan', 'shoulder_lift', 'elbow_flex', 'wrist_flex', 'wrist_roll', 'gripper']) {
  const m = stage.getPartInfo(j)?.mesh // the mesh may be wearing the intro's dissolve clone: patch that and its own material
  if (m) { m.geometry.computeBoundingBox(); patchServo(m.material, m.geometry.boundingBox); patchServo(stage.getServoMaterials()[j], m.geometry.boundingBox) }
}
const surfaces = loadSurfaces(stage.getRenderer(), { phone: matchMedia('(hover: none) and (pointer: coarse)').matches })
  .catch((e) => console.warn('flight surfaces', e))
if (CAPTURE) await surfaces
await stage.addToScene(world.group, { receiveShadow: true }) // compiled + warmed with the rest (program count stays flat)
// round 11 (LOOK): under VSM three draws every RECEIVER into each shadow map (key 2048 + rake 512). Only the lit island
// pieces need it (top, edge blocks, skirt, the near terrain ring that catches the long shadow); the unlit ones (far terrain
// shader, the 18 m far sphere, the reach volume) cannot receive and were drawn into both maps on every redraw. Once, at
// build (receiveShadow is a uniform in r170, not a program key; castShadow is never toggled). ?off=recv = before.
if (!q.get('off')?.split(',').includes('recv')) world.group.traverse((o) => { if (o.isMesh && !o.material?.lights && !o.material?.isMeshStandardMaterial) o.receiveShadow = false })
// round 11: bench props (mounting plate, cables, adapter board) + the overhead stops' projector spill (js/flight/props.js);
// `?off=props` leaves them out
const props = q.get('off')?.split(',').includes('props') ? null : createProps()
if (props) { await stage.addToScene(props.group, { castShadow: true, receiveShadow: true }); await stage.addToScene(props.fx) }

// round 13 ARM (owner: "when going from 9 -> 10 the arm moves way too fast"): every pose change between chapters is a glide
// at <= 45 deg/s per joint, accelerating and braking at <= 60 deg/s^2 (a trapezoid per joint), all joints arriving together
// (each joint's caps scaled by its share of the move). tasks.js's own glide (critically damped, 63-92 deg/s caps, reaching
// its cap in ~0.03 s on a big move) stays on the default page; this replaces it on the arm instance, flight only. A loop
// task still running when the flight enters a chapter without a loop is let go first (director applyState), as "one job"
// already did: before, results -> limits played the rest of the results pick (wrist roll at the 229 deg/s slew cap), then
// glided home at up to 92 deg/s. `?off=armglide` = before.
// round 14 ARM (owner: "the arm tweaks out from 6 -> 7 if its mid motion", "moves too fast in section 7 after picking up
// the noodle"): (1) arm.calm (tasks.js): every task the flight plays, loop or scrubbed, is TIME-SCALED so no joint passes
// ~45 deg/s (wrist roll ~58, gripper 80) or ~180 deg/s^2 (90 per term); the pose stays exactly on the plan, so the noodle never pops; a new task waits for
// the glide to its start pose (velocity carried). (2) A joint the hand-over leaves moving the wrong way or too fast brakes
// at 90 deg/s^2 (was 240: a visible jolt). `?off=armcalm` = round 13 (loop picks up to 229 deg/s).
const ARM_V = 45 * Math.PI / 180, ARM_A = 60 * Math.PI / 180
const ARMGLIDE = !q.get('off')?.split(',').includes('armglide')
const ARMCALM = ARMGLIDE && !q.get('off')?.split(',').includes('armcalm')
const ARM_BRAKE = (ARMCALM ? 90 : 240) * Math.PI / 180
const RUNARM = ARMCALM && !q.get('off')?.split(',').includes('runarm') // round 14: 08's arm picks at the focused run's cell
if (ARMCALM && stage.debug.arm) stage.debug.arm.calm = { v: 42 * Math.PI / 180, roll: 56 * Math.PI / 180, a: 90 * Math.PI / 180, grip: 80 * Math.PI / 180 } // + the 1/60 s profile grid = <= ~45 / roll ~58 measured; a pick takes ~15 s (the real clips: ~20 s)
if (ARMGLIDE && stage.debug.arm) {
  const arm = stage.debug.arm, gT = new Float64Array(6).fill(NaN), gS = new Float64Array(6).fill(1)
  arm._glide = function (tq, dt) {
    let changed = false
    for (let i = 0; i < 6; i++) if (!(Math.abs(tq[i] - gT[i]) < 1e-6)) changed = true
    if (changed) { // a new target: every joint gets the share of the caps that makes them all arrive together
      let mx = 1e-6; const d = []
      for (let i = 0; i < 6; i++) { gT[i] = tq[i]; d[i] = Math.abs(tq[i] - this.q[i]); mx = Math.max(mx, d[i]) }
      for (let i = 0; i < 6; i++) gS[i] = Math.max(0.12, d[i] / mx)
    }
    for (let i = 0; i < 6; i++) {
      const vmax = ARM_V * gS[i], amax = ARM_A * gS[i], d = tq[i] - this.q[i], v = this.qv[i]
      if (Math.abs(d) < 2e-4 && Math.abs(v) < 2e-3) { this.q[i] = tq[i]; this.qv[i] = 0; continue }
      const want = Math.sign(d) * Math.min(vmax, Math.sqrt(2 * amax * Math.abs(d)))
      // a fast hand-over (a loop task let go) sheds its speed quickly; round 14: at 90 deg/s^2, or harder if that would
      // overshoot more than ~17 deg (only a hand-over faster than the calm caps, e.g. a loop started before load ends)
      const lim = Math.abs(v) > vmax * 1.05 || (ARMCALM && v * d < 0) ? Math.max(amax, ARM_BRAKE, ARMCALM ? v * v / (2 * 0.3) : 0) : amax
      this.qv[i] = v + Math.max(-lim * dt, Math.min(lim * dt, want - v))
      let st = this.qv[i] * dt
      if (Math.sign(st) === Math.sign(d) && Math.abs(st) > Math.abs(d)) { st = d; this.qv[i] = 0 }
      this.q[i] += st
    }
  }
}
const camera = stage.getCamera()
const intro = createIntro({ stage, world, sound: { cue: (n) => sound.cue(n) } }) // INTRO (+ the ignition hit: sound is created below)
const info = stage.getPartInfo('elbow_flex')
const servo = info.mesh, servoBase = servo.position.clone(), servoQ = servo.quaternion.clone()
const INSPECT_ROLL = 2.97 // rad, about the camera line (round 14: from the new front-left bearing, 2.97 reads "STS3215" level and upright; 0.5 = round 11-13b)
const SV_LIFT = [SERVO_LIFT * Math.cos(SERVO_TH * Math.PI / 180), SERVO_LIFT * Math.sin(SERVO_TH * Math.PI / 180)] // round 13: path.js SERVO_LIFTED uses the same
// round 13b: from the orbit's C side (SERVO_TH ~ -50 deg) the printed face already meets the camera with no turn in the
// hand (5 turns compared on stills: 0 shows the label, at an angle; the quarter turns show the horn or an unlit side)
const INSPECT_YAW = 0
const _ry = new THREE.Quaternion(), _up = new THREE.Vector3()
const _rq = new THREE.Quaternion(), _qi = new THREE.Quaternion(), _c0 = new THREE.Vector3()
servo.geometry.computeBoundingBox()
const servoC = servo.geometry.boundingBox.getCenter(new THREE.Vector3())
const hud = createHud({ envelope: world.envelope, quiet: reduced })
hud.setCallouts(info)
const sound = createSound({ stage, button: document.getElementById('fl-sound'), introS: INTRO_S }) // SOUND hook
document.documentElement.classList.remove('fl-loading')

// --- navigation ---------------------------------------------------------------------------------------------------
// FULL SITE + owner smoothness round (2026-10-30): the default is Igloo's intent model (js/flight/nav.js: every input is
// "next / previous stop", each a time-based eased flight, arc-length paced). `?nav=scroll` keeps the old scroll-scrubbed
// model (Lenis + the critically damped p follower + the step cap) for A/B measurement only.
const SCROLLNAV = q.get('nav') === 'scroll'
if (SCROLLNAV) document.documentElement.classList.add('fl-scrollnav')
const spacer = document.getElementById('fl-flight')
let spacerMax = 1
const measureSpacer = () => { spacerMax = Math.max(1, spacer.offsetHeight - innerHeight) }
measureSpacer(); addEventListener('resize', measureSpacer) // layout read on resize only, never per frame
const lenis = !SCROLLNAV || CAPTURE || reduced ? null : new Lenis({ lerp: 0.1, syncTouch: false })
const scrollP = () => PMAX * clamp01((lenis ? lenis.scroll : scrollY) / spacerMax)
const navCtx = { canvas, interactive: () => S.chapter === 'sandbox' } // sandbox: touches on the canvas orbit, they never navigate
const nav = createNav({ ctx: navCtx, isReduced: () => reduced, isLive: () => document.documentElement.classList.contains('fl-live'),
  // a warp (deep link / far index jump) skips the opening: make sure the stage was revealed (idempotent), or its camera rig
  // keeps its pre-reveal pull-back and never reports settled (the sandbox's orbit hand-over waits on that)
  onWarp: () => { S.lastPos = null; S.introT = INTRO_S; stage.reveal() } })
// FULL SITE: jump to a scene (chapter index, links, deep links): neighbours fly, far ones fly-to over the island (nav.goStop, round 9b)
function jump(si, opts = {}) {
  if (CAPTURE) return
  if (SCROLLNAV) { const y = Math.round(clamp01(SCENES[si].hold / PMAX) * spacerMax); if (lenis) lenis.scrollTo(y, { duration: 1.6, force: true }); else scrollTo(0, y); return }
  nav.goStop(sceneStop(si), opts)
}
const scenes = createScenes({ stage, jump, nav, reduced: () => reduced, getP: () => S.p, capture: CAPTURE })
if (!SCROLLNAV && !CAPTURE) nav.attach()

// --- state ----------------------------------------------------------------------------------------------------------
const ctx = { servo: [0, 0, 0], test: null, shots: {}, shotKey: '' }
// FULL SITE: the stage's fitted chapter shots at this viewport (cached per size); 'close' = the hero halo pulled back x1.16
// (as the stage's own close does), pos2 x1.1 for the slow push-in while the credits are read
ctx.shot = (id) => {
  const key = innerWidth + 'x' + innerHeight
  if (key !== ctx.shotKey) { ctx.shotKey = key; ctx.shots = {} }
  if (!ctx.shots[id]) {
    if (id === 'close') {
      const r = stage.resolveShot('hero'), L = r.look
      const out = (f) => r.pos.map((v, i) => L[i] + (v - L[i]) * f)
      ctx.shots.close = { pos: out(1.2), pos2: out(1.12), look: L, fov: r.fov, dx: r.dx }
    } else ctx.shots[id] = stage.resolveShot(id)
  }
  return ctx.shots[id]
}
// round 6: world centre of a joint's servo mesh (the touch macro frames the live servos)
const _pc = new THREE.Vector3()
ctx.part = (j) => {
  const m = stage.getPartInfo(j)?.mesh
  if (!m) return [0, 0.1, 0]
  if (!m.geometry.boundingBox) m.geometry.computeBoundingBox()
  m.geometry.boundingBox.getCenter(_pc); m.localToWorld(_pc)
  return [_pc.x, _pc.y, _pc.z]
}
navCtx.servo = ctx.servo; navCtx.shot = ctx.shot; navCtx.part = ctx.part; Object.defineProperty(navCtx, 'test', { get: () => testShot() })
if (!SCROLLNAV) nav.prebuild() // round 13: the orbit's tables are built during load (the opening's clock waits for steady frames)
const LK = { ring: 1, teal: 0, held: 0 }
// round 6 seams: Igloo's ~0.9 s hand-off (onset, peak at the middle, gone), only when a flight crosses a chapter, timed so
// its peak lands on the flight's fastest moment; exactly 0 at every hold. stage.setSeam (A) is guarded: inert until it lands.
const SEAM_S = 0.9
const seam = { on: false, t: 0, dir: 1, flight: null, warp: null, last: 0 }
const S = { teal: 0, held: 0, settle: 0, drift: { t: 0, w: 0, from: 0, to: 0, u: 1 }, ringLevel: -1, p: 0, v: 0, introT: CAPTURE && !q.has('introcap') ? INTRO_S : 0, revealed: false, chapter: null, scrub: false, lastPos: null, maxStep: 0, steps: [] }
const _w = new THREE.Vector3(), _q = new THREE.Quaternion(), _o = new THREE.Vector3(), _a = new THREE.Vector3()
let camOut = { pos: [0, 0, 0], look: [0, 0, 0], fov: 30, dx: 0, focus: 0, at: [0, 0, 0] }
const testShot = () => { if (!ctx.test) { ctx.test = stage.resolveShot('test') } return ctx.test }

function chapterFor(p) {
  if (p < 0.075) return 'built' // the home pose facing the ring: a still subject for the halo macro
  if (p < 0.2) return 'arm'
  if (p < 0.517) return 'data'
  if (p < 0.633) return 'sees'
  if (p < 0.7) return 'policies'
  if (p < 0.917) return 'test'
  // FULL SITE scenes (stage chapter modes of the old document: film = calm loop behind the reels, the close = results in
  // group 'next'). The sandbox chapter starts once the path sits on the sandbox shot, so the stage's orbit engages there.
  if (p < 1.1) return 'film'
  if (p < 1.255) return 'results'
  if (p < 1.37) return 'limits'
  if (p < 1.545) return 'touch'
  if (p < 1.7) return 'sandbox'
  return 'results'
}
// FULL SITE: index.html section group per p (Stage B plays its hand-off seam at each change); null = keep the current one
function sectionFor(p) {
  if (p < 0.93) return 'learned'
  if (p < 1.1) return 'proof'
  if (p < 1.7) return 'outcome'
  return 'next'
}

function inspectK(p) { return Math.min(ramp(p, 0.138, 0.154), 1 - ramp(p, 0.19, 0.205)) }

/** Everything that is a function of p (and of the intro clock). */
function applyState(p, dt) {
  const ch = chapterFor(p)
  stage.setSection(sectionFor(p)) // before setChapter: the close (results in 'next') is chosen at the chapter switch
  if (ch !== S.chapter) {
    if (S.scrub) { stage.resumeTask(); S.scrub = false }
    // round 13 ARM: entering a chapter without a loop, a loop task still playing is let go (the arm glides to the new pose
    // from where it is, at the flight's gentle caps) instead of finishing its pick at full speed
    const em = ch === 'results' && sectionFor(p) === 'next' ? MODES.built : MODES[ch]
    if (ARMGLIDE && !em?.loop && stage.debug.arm?.cur?.auto) stage.debug.arm.abortAuto()
    S.chapter = ch
    stage.setChapter(ch)
  }
  // exploded view: sin plateau of progress.arm (stage.js); in -> held apart through the inspection -> back together
  stage.setProgress('arm', p < 0.1 ? lerp(0.04, 0.5, ramp(p, 0.067, 0.1)) : p < 0.185 ? 0.5 : lerp(0.5, 0.96, ramp(p, 0.185, 0.2)))
  // lane: empty grid through S3; 160 land over 0.30-0.45 (episodeAt(pData / 0.55)); hold; the stage's dive engages at 0.92+
  stage.setProgress('data', p < 0.3 ? 0 : p < 0.45 ? 0.55 * (p - 0.3) / 0.15 : p < 0.478 ? lerp(0.55, 0.9, (p - 0.45) / 0.028) : lerp(0.92, 1, ramp(p, 0.478, 0.5)))
  // ring: full through the flight; the B2 peak (stage moments, chapter test) drains it to its staged level
  // FULL SITE: after B2 the light comes back with the real footage (limits quiets itself: moments.js; the close sweeps)
  stage.setRingProgress(p < 0.7 ? 1 : p < 0.93 ? lerp(1, 0.07, ramp(p, 0.7, 0.75)) : lerp(0.07, 1, ramp(p, 0.93, 1.0)))
  // S7: the B2 pick is scrubbed by scroll (approach -> grasp -> lift), then plays on for the hand-off
  // (only the B2 task: entering test, the arm may still be finishing the previous chapter's loop task)
  // round 12 (fast scroll): arriving here while the arm still plays another chapter's loop task, the scrub used to wait
  // for that task to end (seconds), so the camera reached the B2 macro with the arm elsewhere. Now the loop task is let
  // go and the B2 task starts at once (explicit: no home glide; its blend-in is a function of t, so it scrubs too).
  // round 14 (the 6 -> 7 "tweak"): the test was `cell === 'B2'`, which a LOOP task's B2 pick also passes (the policies
  // loop is B2 every other pick), so that loop task was scrubbed to the start of the pick: rewound at the scrub chase
  // rate, wrist roll at the 229 deg/s slew cap. Only the explicit B2 task is scrubbed now. A loop B2 pick still before its
  // release is ADOPTED where it is (same plan, time and velocity); anything else is let go and the arm glides to the
  // pick's start pose from its current velocity before the B2 task begins (arm.calm). `?off=armcalm` = round 13.
  const arm = stage.debug.arm
  const ownB2 = () => !!arm && !!arm.cur && !arm.cur.auto && arm.cur.plan === arm.plans.B2
  if (ch === 'test' && p > 0.745 && p < 0.915 && !S.scrub && !CAPTURE && (ARMCALM ? !ownB2() : stage.getJointState().cell !== 'B2')) {
    // (a queued LOOP B2 job does not count: loop jobs first glide home, speed-capped, which took 1-2 s at a fast scroll)
    if (arm && !arm.queue.some((j) => !j.auto && j.plan === arm.plans.B2) && (!arm.cur || arm.cur.auto)) {
      if (ARMCALM && arm.cur?.auto && arm.cur.plan === arm.plans.B2 && arm.t < arm.cur.plan.releaseT) arm.adoptAuto()
      else { arm.abortAuto(); stage.runTask('B2').catch(() => {}) }
    }
  }
  if (ch === 'test' && p > 0.745 && p < 0.915 && (S.scrub || (ARMCALM ? ownB2() : stage.getJointState().cell === 'B2'))) {
    const tl = stage.getTaskProgress().timeline || []
    const g = tl.find((x) => x.phase === 'grasp'), l = tl.find((x) => x.phase === 'lift')
    const ug = g ? g.t0 : 0.45, ul = l ? l.t1 : ug + 0.15
    stage.scrubTask(p < 0.865 ? lerp(0.0, ug, ramp(p, 0.75, 0.865)) : lerp(ug, ul, ramp(p, 0.865, 0.905)))
    S.scrub = true
  } else if (S.scrub) { stage.resumeTask(); S.scrub = false }
  // round 14 RUNS (08): the arm performs a pick at the cell of the screen in focus (scenes.js runsFocus: engaged > hovered
  // or keyboard-focused > the first reel, which autoplays), its task time = the clip's time mapped onto the IK pick
  // (props_runs.js SYNC). A kinematic reconstruction timed to the clip, labelled as such (the rollouts logged no joints).
  // The test's own B2 pick, still playing on as 08 arrives, finishes first (the clips open on a 6-13 s lead-in); a change
  // of focus, or the clip starting over, lets the current pick go (the arm glides from its velocity, the old noodle shrinks
  // away, the new one grows at its cell). Leaving 08 the pick plays on to its end. `?off=runarm` = round 13 (film loop).
  const rf = RUNARM && ch === 'film' && !CAPTURE && arm ? scenes.runsFocus() : null
  if (rf) {
    const own = arm.cur?.tag === 'runs' ? arm.cur : null
    if (own && (own.plan !== arm.plans[rf.cell] || rf.t < arm.t - 1)) arm.dropTask()
    const qi = arm.queue.findIndex((j) => j.tag === 'runs')
    if (qi >= 0 && arm.queue[qi].plan !== arm.plans[rf.cell]) arm.queue.splice(qi, 1)
    const mine = arm.cur?.tag === 'runs'
    if (!mine && !arm.queue.some((j) => j.tag === 'runs')) {
      if (arm.cur?.auto) arm.abortAuto()
      stage.runTask(rf.cell).catch(() => {})
      const j = arm.queue[arm.queue.length - 1]; if (j) j.tag = 'runs'
    }
    if (mine) stage.scrubTask(rf.t / arm.cur.plan.duration)
    S.runs = true
  } else if (S.runs) { S.runs = false; if (arm?.cur?.tag === 'runs') stage.resumeTask() }

  // servo inspection: lift the elbow servo 6 cm out of the chain toward the camera side (world offset -> parent local)
  const ik = inspectK(p)
  document.documentElement.classList.toggle('fl-insp', ik > 0.02) // the joint tags step aside for the inspection
  servo.parent.getWorldQuaternion(_q); _qi.copy(_q).invert()
  _o.set(SV_LIFT[0] * ik, 0.012 * ik, SV_LIFT[1] * ik).applyQuaternion(_qi) // 6 cm, toward the inspection camera (round 13: its fixed azimuth)
  // round 11: the low inspection camera (dark sky behind the part, not the lit upper arm) saw the label run downhill; the
  // lifted part also turns in the hand about its line to the camera so "STS3215" reads level (INSPECT_ROLL, eased by ik)
  _c0.copy(servoC).multiply(servo.scale).applyQuaternion(servoQ).add(servoBase) // the part's centre, parent frame, at rest
  _w.copy(_c0).applyMatrix4(servo.parent.matrixWorld)
  _a.copy(camera.position).sub(_w).normalize().applyQuaternion(_qi) // the camera line, parent frame
  _rq.setFromAxisAngle(_a, INSPECT_ROLL * ik)
  _ry.setFromAxisAngle(_up.set(0, 1, 0).applyQuaternion(_qi), INSPECT_YAW * ik)
  servo.quaternion.copy(_rq).multiply(_ry).multiply(servoQ)
  servo.position.copy(_c0).add(_o).sub(_a.copy(servoC).multiply(servo.scale).applyQuaternion(servo.quaternion)) // centre' = centre + lift
  _w.copy(servoC); servo.localToWorld(_w)
  ctx.servo[0] = _w.x; ctx.servo[1] = _w.y; ctx.servo[2] = _w.z

  // round 6: one hot element per frame (the ring is hot only where it is the subject) and the grid's colour only in its
  // moment. Both are plain values; A's stage.setRingLevel eases its own (guarded: inert until it exists).
  lookAt(p, LK)
  // round 7: the grid's colour eases in on the clock (an event that arrives after the move, never a pop mid-flight)
  const te = CAPTURE || reduced ? 1 : 1 - Math.exp(-dt * 2.2)
  S.teal += (LK.teal - S.teal) * te; S.held += (LK.held - S.held) * te
  setGridTone(S.teal, S.held)
  // round 11: projected light with printed labels; the sandbox keeps half the light and its pill labels (they are buttons there)
  if (GRIDLIGHT) setGridStyle(ch === 'sandbox' ? 0.45 : 1)
  // the props arrive with the base in the opening's print (~4.1 s); the spill belongs to the grid's own moments
  props?.update(S.introT > 4.1, S.teal * (p < 0.52 ? 1 : ch === 'sandbox' ? 0.6 : 0.25))
  if (Math.abs(LK.ring - S.ringLevel) > 1e-4) { S.ringLevel = LK.ring; stage.setRingLevel?.(LK.ring) }

  // S0 build-in on the clock + the island's light and air as functions of p (js/flight/intro.js)
  intro.apply(S.introT, lightP(SCROLLNAV ? p : nav.pv), dt, reduced) // INTRO (round 9b: a fly-to eases the island's light across its scene switch; round 16: lightP, the close is lit as F1)

  // camera
  // round 9: while a flight runs, the camera rides nav.js's C2 curve (pos / look / lens on one eased, arc-length clock);
  // at holds (and in ?nav=scroll) it is the path at p
  const fc = !SCROLLNAV && nav.N.cam && !nav.N.flight?.veil ? nav.N.cam : null // round 10: also the scroll-spring path (nav.N.cam whenever it is active)
  if (fc) { for (let i = 0; i < 3; i++) { camOut.pos[i] = fc.pos[i]; camOut.look[i] = fc.look[i]; camOut.at[i] = fc.at[i] } camOut.fov = fc.fov; camOut.dx = fc.dx; camOut.focus = fc.focus }
  else sample(p, ctx, camOut)
  intro.camera(S.introT, p, camOut, reduced) // INTRO: the opening's camera on top of the F1 key
  // FULL SITE: no hand-off any more. k = 1 everywhere except the sandbox: once the stage's rig has settled on its sandbox
  // shot (= the path's key there), k drops to 0 (invisible: same pose) and the stage's orbit + table clicks own the camera;
  // leaving it, k springs back up from wherever the visitor orbited to (time-based, so a parked scroll never cuts).
  const inSandbox = ch === 'sandbox' && !CAPTURE
  // the flight's own opening replaces the stage's hero dolly-in: if the rig never started it (intro.js ignites the studio
  // itself), retire its pull-back, or the rig never reports settled and the sandbox would never get its orbit
  const rig = stage.debug.camRig
  if (inSandbox && rig.intro.t < 0 && rig.intro.k > 0) rig.intro.k = 0
  const kWant = inSandbox && rig.settled() && (SCROLLNAV || !nav.flying) ? 0 : 1 // round 9b: while a flight runs the path owns the camera
  // leaving the sandbox: the path takes the camera back at once (k = 1), blended over 1.2 s from wherever the visitor
  // orbited to (the stage's rig is mid-flight to its next shot then, so blending k against it made 6-8 cm frame jumps)
  // round 12: the blend is an OFFSET (orbited pose minus the path's pose at the hand-back) that fades over 1.2 s while the
  // path moves on, not a blend from a frozen pose: a visitor who never orbited has a ~0 offset, so a fast scroll out of
  // the sandbox no longer leaves the camera parked for a second and then chasing the path
  if (S.k === 0 && kWant === 1) {
    const cam = stage.getCamera(), d = Math.hypot(camOut.pos[0] - camOut.look[0], camOut.pos[1] - camOut.look[1], camOut.pos[2] - camOut.look[2])
    cam.getWorldDirection(_a)
    const P = cam.position.toArray(), L = [P[0] + _a.x * d, P[1] + _a.y * d, P[2] + _a.z * d]
    S.sbOut = { t: 0, dp: P.map((x, i) => x - camOut.pos[i]), dl: L.map((x, i) => x - camOut.look[i]) }
  }
  S.k = kWant
  if (S.sbOut) {
    S.sbOut.t += dt
    const u = Math.min(1, S.sbOut.t / 1.2), w = 1 - u * u * u * (u * (u * 6 - 15) + 10)
    for (let i = 0; i < 3; i++) { camOut.pos[i] += S.sbOut.dp[i] * w; camOut.look[i] += S.sbOut.dl[i] * w }
    if (u >= 1 || CAPTURE) S.sbOut = null
  }
  const k = S.k
  // portrait (phones): the keys are authored for 16:10; widen the vertical fov so most of the width survives, centre the
  // subject (the lines stack at the foot) and lift it into the upper part of the frame
  const asp = innerWidth / innerHeight
  let fov = camOut.fov, dx = camOut.dx, dy = 0
  // (the sandbox key is the stage's own fitted shot: it already suits the aspect, so it is passed through as it is)
  const sbK = Math.min(ramp(p, 1.505, 1.54), 1 - ramp(p, 1.67, 1.705))
  if (asp < 1 && sbK < 1) {
    const f = 1 + (Math.min(2, Math.max(1, Math.sqrt(1.6 / asp))) - 1) * (1 - sbK)
    fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(fov) / 2) * f))
    dx = dx * sbK; dy = 0.14 * (1 - sbK) + (ctx.shot('sandbox').dy || 0) * sbK
  } else {
    if (sbK > 0) dy = (ctx.shot('sandbox').dy || 0) * sbK
    // narrow landscape (iPad 1180x820 = 1.44, 4:3 laptops): the text column keeps its px width, so it covers more of the
    // frame than on the 16:10 the keys were authored for (owner check 2026-11-01: 07's copy sat on the gripper). Push the
    // subject further right and open the lens a little so the shift crops nothing.
    const n = Math.max(0, Math.min(1, (1.6 - asp) / 0.3)) * (1 - sbK)
    if (n > 0) {
      dx += 0.1 * n
      fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(fov) / 2) * (1 + 0.12 * n)))
    }
  }
  // round 13 CAMERA (owner: "the movements from the camera have to be extremely smooth and it has to make sense"): the
  // camera moves ONLY when the visitor scrolls. The hold breathing (round 7: yaw / dolly / lift drift), the arrival dolly and
  // the sub-threshold scroll nudge are gone; the stage's own drift is overridden while the path owns the camera (k 1).
  stage.setCameraPath({ pos: camOut.pos, look: camOut.look, fov, dx, dy, k })
  const clear = Math.min(ramp(p, 0.468, 0.488), 1 - ramp(p, 0.515, 0.53)) // the recording path + arcs step aside for the dive
  stage.setFocus(camOut.focus > 0.05 ? { px: camOut.focus, at: camOut.at, keep: 0, clear } : (k <= 0 ? null : { px: 0, keep: 0, clear }))
}

// p follower: critically damped toward the scroll target, then limited so the camera never steps > STEP_MAX
function follow(target, dt) {
  if (reduced) { // calm: each scene cuts to its end frame (the last hold key of the scene)
    const si = sceneAt(target)
    const holds = [0.06, 0.188, 0.312, 0.515, 0.615, 0.7, 0.9, 1.04, 1.19, 1.32, 1.45, 1.61, 1.8] // FULL SITE: + scenes 08-13
    S.p = holds[si]; return
  }
  const om = 2 / 0.25, x = S.p - target, e = Math.exp(-om * dt), qq = (S.v + om * x) * dt
  let np = target + (x + qq) * e
  S.v = (S.v - om * qq) * e
  const cap = Math.min(STEP_MAX, SPEED_MAX * Math.max(dt, 1 / 240))
  if (S.lastPos) { // bisect toward the previous p until the camera step fits the cap
    const probe = (pp) => { const o = sample(pp, ctx, { pos: [0, 0, 0], look: [0, 0, 0], fov: 0, dx: 0, focus: 0, at: [0, 0, 0] }); return Math.hypot(o.pos[0] - S.lastPos[0], o.pos[1] - S.lastPos[1], o.pos[2] - S.lastPos[2]) }
    if (probe(np) > cap) {
      let lo = S.p, hi = np
      for (let i = 0; i < 14; i++) { const mid = (lo + hi) / 2; if (probe(mid) > cap) hi = mid; else lo = mid }
      np = lo; S.v = (np - S.p) / Math.max(dt, 1e-3)
    }
  }
  S.p = np
}

function seamEnv(u) { return u <= 0 || u >= 1 ? 0 : Math.pow(Math.sin(Math.PI * u), 2) } // 0 -> 1 at mid -> 0, C1
// round 7: the veil (nav.N.veil): stage.setVeil (A, depth-aware fog/light wall) when it exists; the DOM wall #fl-warp
// is the whole veil only when stage.setVeil is missing (an ink / light / warm wash, opacity only); with it, A's moving mist
// (92-98 % at a = 1) covers the cut by itself: the DOM wall on top read as a flat dip to colour (round 8)
const warpEl = document.getElementById('fl-warp')
const VEIL_BG = {
  ink: 'radial-gradient(120% 90% at 50% 62%, #2b3550 0%, #141d31 52%, #0a111f 100%)',
  light: 'radial-gradient(110% 90% at 50% 45%, #c9c3b6 0%, #7c8090 48%, #2a3145 100%)',
  warm: 'radial-gradient(90% 80% at 46% 40%, #f3cf9a 0%, #a2775a 40%, #2a2232 100%)',
}
let veilTint = '', veilLast = -1
function updateVeil() {
  const a = nav.N.veil || 0
  if (a > 0 && nav.N.vtint !== veilTint && warpEl) { veilTint = nav.N.vtint; warpEl.style.background = VEIL_BG[veilTint] || VEIL_BG.ink }
  stage.setVeil?.(a, veilTint || 'ink')
  const dom = stage.setVeil ? 0 : a
  if (Math.abs(dom - veilLast) > 1e-3 || (dom === 0 && veilLast !== 0)) { veilLast = dom; if (warpEl) warpEl.style.opacity = dom.toFixed(3) }
}

function updateSeam(dt) {
  const f = nav.N.flight, w = nav.N.warp
  if (f && f !== seam.flight) {
    seam.flight = f
    const si = sceneAt(f.from + 1e-6 * Math.sign(f.to - f.from)), sj = sceneAt(f.to)
    if (!f.veil && si !== sj && !reduced) { seam.on = true; seam.t = -Math.max(0, f.dur * 0.5 - SEAM_S * 0.5); seam.dir = Math.sign(f.to - f.from) || 1 }
  }
  if (!f) seam.flight = null
  let a = 0
  if (seam.on) {
    seam.t += dt
    a = 0 * seamEnv(seam.t / SEAM_S) // owner 2026-10-31 "its still the veil transitions": no haze/CA breath either; the camera move alone is the transition
    if (seam.t >= SEAM_S) seam.on = false
  }
  if ((f?.veil || w) && !reduced) a = Math.max(a, 0.5 * (nav.N.veil || 0)) // the veil carries the seam's haze breath
  if (a !== seam.last) { seam.last = a; stage.setSeam?.(a, seam.dir) }
}

function tick(dt) {
  testShot()
  if (!CAPTURE) {
    if (SCROLLNAV) {
      if (S.introT < INTRO_S) S.introT = intro.advance(S.introT, dt, scrollP() > 0.002, reduced) // INTRO: scrolling fast-forwards it
      follow(scrollP(), dt)
    } else {
      if (S.introT < INTRO_S) S.introT = intro.advance(S.introT, dt, nav.moved, reduced) // INTRO: the first intent fast-forwards the build-in
      nav.update(dt); S.p = nav.p
    }
  }
  applyState(S.p, dt)
  if (!SCROLLNAV && !CAPTURE) { updateSeam(dt); updateVeil() }
  tickScramble(dt, CAPTURE || reduced)
  const pos = camOut.pos
  if (S.lastPos) {
    const st = Math.hypot(pos[0] - S.lastPos[0], pos[1] - S.lastPos[1], pos[2] - S.lastPos[2])
    S.maxStep = Math.max(S.maxStep, st)
    if (S.log) S.steps.push(+st.toFixed(5))
  }
  S.lastPos = [...pos]
  const v = stage.getView()
  world.setResolution(v.w, v.h, v.dpr)
  // HUD
  _a.set(ctx.servo[0], ctx.servo[1], ctx.servo[2]).project(camera)
  const anchor = _a.z < 1 ? { x: (_a.x * 0.5 + 0.5) * innerWidth, y: (-_a.y * 0.5 + 0.5) * innerHeight } : null
  // round 7 text choreography: the HUD and the scenes read the move (out as it begins, in ~0.3 s after it settles)
  const f = nav.N.flight
  const mv = SCROLLNAV ? null : { flying: nav.flying, stopP: nav.STOPS[nav.N.idx].p, toP: nav.toP, content: nav.content, settle: CAPTURE ? 9 : S.settleT }
  S.settleT = nav.flying || S.introT < INTRO_LAND ? 0 : (S.settleT || 0) + dt // the opening: text waits for the crane to land
  // round 12: text, panels and pins are keyed to where the camera is between two stops (nav.mix), never to "settled";
  // the only clock left is the opening's: the text fades in once over 0.6 s after the crane lands
  const mix = SCROLLNAV ? (() => { let b = 0; nav.STOPS.forEach((s, i) => { if (Math.abs(s.p - S.p) < Math.abs(nav.STOPS[b].p - S.p)) b = i }); return { a: b, b, u: 0 } })() : nav.mix
  S.textGate = CAPTURE || reduced ? 1 : S.introT < INTRO_LAND + 0.3 ? 0 : Math.min(1, (S.textGate || 0) + dt / 0.6)
  hud.update(S.p, { sceneIdx: sceneAt(S.p), scenes: SCENES, insp: inspectK(S.p), progress: SCROLLNAV ? null : nav.progress, loop: SCROLLNAV ? null : nav.loop, anchor, q: stage.getJointState().joints.elbow_flex, dt, instant: CAPTURE, mv, mix, gate: S.textGate })

  sound.update(dt, S.p, intro.soundT(S.introT), reduced) // SOUND hook: one boolean check per frame while off
  scenes.update(S.p, dt, { instant: CAPTURE, mv, mix, gate: S.textGate }) // FULL SITE: scene panels, pins, index
}

reducedMQ.addEventListener?.('change', (e) => { reduced = e.matches; stage.setReducedMotion(reduced) })

if (!CAPTURE && stage.setBeforeFrame) {
  // smoothness round: the director runs inside the stage's own frame (sample input -> flight -> camera -> render, one tick)
  const PROF = q.has('prof') ? (window.__prof = []) : null // ?prof: per-frame JS cost of the director (tests)
  stage.setBeforeFrame((dt, t) => {
    const t0 = PROF ? performance.now() : 0
    lenis?.raf(t); tick(Math.min(0.1, dt))
    if (PROF) PROF.push([+(performance.now() - t0).toFixed(2), +(dt * 1000).toFixed(1), +S.p.toFixed(3)])
  })
} else if (!CAPTURE) {
  let last = performance.now()
  const raf = (t) => {
    const dt = Math.min(0.1, Math.max(0, (t - last) / 1000)); last = t
    lenis?.raf(t)
    tick(dt)
    requestAnimationFrame(raf)
  }
  requestAnimationFrame(raf)
} else {
  stage.pause()
}

// test hooks (also used by render/flight_snap.mjs): deterministic stepping in ?capture, per-frame camera-step log
window.__flight = {
  stage, world, S, info, ctx, sound, scenes, jump, PMAX, // sound: SOUND hook (tests read sound.ctx / engine / meter())
  /** ?capture: jump to p (and the intro clock), then step the stage `settle` seconds at 30 Hz with the director in the loop. */
  nav, get camOut() { return camOut }, // tests: the path's camera this frame (before the stage renders it)
  async goto(p, settle = 2, introT = INTRO_S) {
    S.introT = introT; S.p = p; S.lastPos = null; nav.setP(p)
    const d = stage.debug
    const n = Math.round(settle * 30)
    for (let i = 0; i < n; i++) { tick(1 / 30); d.advance(1 / 30, 1 / 30) }
    await new Promise((r) => setTimeout(r, 700)) // the stage's typed labels decode on the wall clock
    tick(1 / 30); d.advance(1 / 30, 1 / 30)
    return { p: S.p, cam: camera.position.toArray(), progs: d.renderer.info.programs.length }
  },
  /** round 13 tests (?capture): one director tick at p + one stage step (no wait); returns the displayed joint angles. */
  stepP(p, dt = 1 / 60) { S.p = p; tick(dt); stage.debug.advance(dt, dt); return stage.getJointState().joints },
  __apply: (p, dt) => applyState(p, dt), // round 7 tools (segs.mjs): the director's state + camera at p, no render
  /** ?capture: the seam at a fixed amount (round 6 mid-seam stills); 0 clears it. */
  seam(a, dir = 1) { seam.last = a; stage.setSeam?.(a, dir); stage.debug.advance(1 / 30, 1 / 30); return !!stage.setSeam },
  /** ?capture&introcap: step the opening forward to intro time t at 30 Hz (monotonic: call with increasing t). INTRO */
  async introAt(t) {
    const d = stage.debug
    while (S.introT < t - 1e-6) { const dt = Math.min(1 / 30, t - S.introT); S.introT += dt; tick(dt); d.advance(dt, dt) }
    await new Promise((r) => setTimeout(r, 120))
    tick(0); d.advance(1 / 240, 1 / 240)
    return { t: S.introT, cam: camera.position.toArray(), progs: d.renderer.info.programs.length }
  },
  /** ?capture: one nav flight from stop i in direction dir, director in the loop at a fixed dt (no render): the PATH's
   *  per-frame camera speed (m/s) and p, to separate the flight's own pacing from anything the stage adds on top. */
  simFlight(i, dir = 1, dt = 1 / 60) {
    nav.setP(nav.STOPS[i].p); nav.N.idx = i; nav.step(dir)
    const out = []; let last = null
    for (let k = 0; k < 600 && nav.flying; k++) { nav.update(dt); S.p = nav.p; applyState(S.p, dt); const P = camOut.pos; if (last) out.push([Math.hypot(P[0] - last[0], P[1] - last[1], P[2] - last[2]) / dt, S.p]); last = [...P] }
    return { n: out.length, peak: Math.max(...out.map((x) => x[0])), at: out.reduce((a, c) => (c[0] > a[0] ? c : a), [0, 0])[1], dur: out.length * dt }
  },
  /** ?capture: run the director along a p schedule at a fixed dt (no render) and return the per-frame camera steps. */
  sweep(ps, dt = 1 / 60) {
    S.lastPos = null; S.maxStep = 0; S.steps = []; S.log = true
    for (const target of ps) { follow(target, dt); applyState(S.p, dt); const pos = camOut.pos; if (S.lastPos) S.steps.push(Math.hypot(pos[0] - S.lastPos[0], pos[1] - S.lastPos[1], pos[2] - S.lastPos[2])); S.lastPos = [...pos] }
    S.log = false
    return { max: Math.max(...S.steps), n: S.steps.length, pEnd: S.p }
  },
}
