// FULL SITE (2026-10-30): every chapter of index.html lives inside the flight. flight.html holds one <section class="fls">
// per scene (all the copy, in reading order, readable by screen readers and without JS); this module
//  - initDom(): wires what works with or without the 3D (real footage, reels via ui/film.js, policy specs, result dots,
//    joint table from the URDF, the protocol's recording order, the sandbox picker via ui/sandbox.js through a proxy);
//  - createScenes(): in the flight (html.fl-live) fades each scene's panels by flight progress p, draws Igloo-style pinned
//    callouts with leader lines from real objects (projected every frame), the reel leaders to their cells, the chapter
//    index, the "explore" drawers, hash / focus / link navigation, and the per-scene media (only the scene in view plays).
// Facts shown here come from index.html copy, protocol.js, layout.js, the URDF and the stage's live joint state only.
import { initFilm } from '../ui/film.js'
import { initPolicies } from '../ui/policies.js'
import { initResults } from '../ui/results.js'
import { initSandbox } from '../ui/sandbox.js'
import { initFullscreen } from '../ui/video-expand.js'
import { guardVideo, playback } from '../ui/video-guard.js'
import { cellOfEpisode, PERIMETER, TOTAL_EPISODES } from '../stage/protocol.js'
import { cellCenter, CUP, RING } from '../stage/layout.js'
import { urdfJoint, COPY, HUD_STOPS } from './hud.js'
import { mixWeights, sceneOfStop, STOPS } from './nav.js' // round 12: panels and pins keyed to the camera's place between stops
import { SCENES, sceneAt } from './path.js'
import { scramble } from './scramble.js' // round 6: decode on entry, type-on pins
import { createRuns } from './props_runs.js' // round 11: the four runs as screens standing on the table (desktop)

const $ = (s, r = document) => r.querySelector(s)
const $$ = (s, r = document) => [...r.querySelectorAll(s)]
const clamp01 = (x) => Math.min(1, Math.max(0, x))
const win = (p, a, b, f) => clamp01(Math.min((p - a) / f, (b - p) / f))
const reducedNow = () => matchMedia('(prefers-reduced-motion: reduce)').matches
const JOINTS = ['shoulder_pan', 'shoulder_lift', 'elbow_flex', 'wrist_flex', 'wrist_roll', 'gripper']
const PRETTY = { shoulder_pan: 'Shoulder pan', shoulder_lift: 'Shoulder lift', elbow_flex: 'Elbow flex', wrist_flex: 'Wrist flex', wrist_roll: 'Wrist roll', gripper: 'Gripper' }
const fmt = (x, d = 2) => (x >= 0 ? '+' : '−') + Math.abs(x).toFixed(d)

// Where each scene's panels are fully shown (flight p). Every navigation stop sits inside its window (js/flight/nav.js).
const WIN = [[-0.05, 0.068], [0.08, 0.137], [0.205, 0.322], [0.322, 0.492], [0.528, 0.633], [0.642, 0.703], [0.72, 0.918],
  [0.985, 1.097], [1.13, 1.252], [1.28, 1.368], [1.39, 1.497], [1.565, 1.697], [1.73, 1.95]]
const FADE = 0.012

// --- the stage proxy for the sandbox / policies (the page works before, without, or after the real stage) -------------
const proxy = (() => {
  let real = null
  const table = [], cells = []
  return {
    get available() { return !!real },
    attach(s) { real = s; table.forEach((cb) => s.onTableClick(cb)); cells.forEach((cb) => s.onCellClick(cb)) },
    onTableClick(cb) { table.push(cb); real?.onTableClick(cb) },
    onCellClick(cb) { cells.push(cb); real?.onCellClick(cb) },
    runTask: (c) => (real ? real.runTask(c) : Promise.resolve()),
    runTaskAt: (pt) => (real ? real.runTaskAt(pt) : Promise.resolve('unreachable')),
    snapshot: (o) => real.snapshot(o),
    setPolicy: (w) => real?.setPolicy(w),
  }
})()

// --- media: the small real-footage cards (hero inset, time-lapse, camera streams) ---------------------------------------
const PLAY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z"/></svg>'
const PAUSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/></svg>'
const clips = []
function initClips() {
  $$('[data-fclip]').forEach((box) => {
    const v = $('video', box)
    const g = guardVideo(box, v)
    const scene = box.closest('.fls')
    const c = { box, v, g, scene, inCard: !!box.closest('.fls-card'), user: reducedNow() ? 'paused' : null, want: false, ratio: 0 }
    const t = document.createElement('button')
    t.type = 'button'; t.className = 'fl-ctoggle'
    const paint = () => { t.innerHTML = v.paused ? PLAY : PAUSE; t.setAttribute('aria-label', v.paused ? 'Play the looping video' : 'Pause the looping video') }
    ;['play', 'pause'].forEach((e) => v.addEventListener(e, paint)); paint()
    t.addEventListener('click', () => { if (v.paused) { c.user = 'play'; g.start().catch(() => {}) } else { c.user = 'paused'; g.pause() } })
    box.append(t)
    clips.push(c)
    // document layout (no flight): play the one most in view, like ui/media.js
    new IntersectionObserver((es) => { es.forEach((e) => { c.ratio = e.isIntersecting ? e.intersectionRatio : 0 }); if (!document.documentElement.classList.contains('fl-live')) arbitrateDoc() }, { threshold: [0, 0.5, 1] }).observe(box)
  })
}
function arbitrateDoc() {
  let best = null
  for (const c of clips) if (c.user !== 'paused' && c.ratio >= 0.5 && (!best || c.ratio > best.ratio)) best = c
  for (const c of clips) setClip(c, c === best)
}
function setClip(c, on) {
  if (playback.exclusive || (playback.fullscreen && playback.fullscreen !== c.v)) on = false // an engaged reel owns the decoder
  if (c.user === 'paused') on = false
  if (on === c.want) return
  c.want = on
  if (on) c.g.start().catch(() => {}); else c.g.pause()
}

/** The URDF joint table (scene 02's drawer): read from the URDF text, never from a table in this file. */
async function fillJoints() {
  const body = $('#fl-joints tbody')
  if (!body) return
  try {
    const txt = await (await fetch('assets/so101/so101_new_calib.urdf')).text()
    const deg = (r) => Math.round((r * 180) / Math.PI)
    body.innerHTML = JOINTS.map((j, i) => {
      const u = urdfJoint(txt, j)
      return u ? `<tr><td>${i + 1}</td><th scope="row">${j}</th><td>${u.type}</td><td>${fmt(u.lower)} … ${fmt(u.upper)} rad <span>(${fmt(deg(u.lower), 0)}° … ${fmt(deg(u.upper), 0)}°)</span></td></tr>` : ''
    }).join('')
  } catch { body.innerHTML = '<tr><td colspan="4">The joint table needs the URDF file, which did not load.</td></tr>' }
}

/** The recording order (scene 04's drawer), generated from protocol.js. */
function fillProtocol() {
  const ol = $('#fl-rounds'), lead = $('#fl-proto')
  if (!ol) return
  lead.textContent = `${TOTAL_EPISODES} episodes in 4 rounds. Each round visits the 8 perimeter cells, 5 episodes per cell; rounds 2 and 4 walk the perimeter in reverse. B2 is never visited.`
  const rounds = [[], [], [], []]
  for (let e = 0; e < TOTAL_EPISODES; e += 5) rounds[Math.floor(e / 40)].push(cellOfEpisode(e))
  ol.innerHTML = rounds.map((r, i) => `<li><b>Round ${i + 1}</b><span>${r.join(' → ')}</span><i>episodes ${i * 40 + 1}–${i * 40 + 40}</i></li>`).join('')
  void PERIMETER
}

let domDone = false
let sandboxApi = null
/** Everything that works without the 3D (also the no-WebGL / slow-GPU document). Idempotent. */
export function initDom() {
  if (domDone) return
  domDone = true
  const safe = (n, f) => { try { f() } catch (e) { console.warn(n, e) } }
  safe('clips', initClips)
  safe('film', initFilm)
  safe('fullscreen', initFullscreen)
  safe('policies', () => initPolicies(proxy))
  safe('results', initResults)
  safe('sandbox', () => { sandboxApi = initSandbox(proxy) })
  safe('protocol', fillProtocol)
  fillJoints()
  const b2 = cellCenter('B2')
  const xy = $('#fl-b2xy'); if (xy) xy.textContent = `x ${b2.x.toFixed(4)} m, z ${b2.z.toFixed(3)} m`
  // explore drawers (both layouts: in the document they are simply open)
  $$('.fl-explore').forEach((b) => {
    const d = document.getElementById(b.getAttribute('aria-controls'))
    if (!d) return
    b.addEventListener('click', () => toggleDrawer(d, b, !d.classList.contains('is-open')))
    $('.fl-close', d)?.addEventListener('click', () => toggleDrawer(d, b, false))
  })
  // Escape closes the innermost open layer: a drawer first, then (flight only, set by createScenes) the phone index overlay,
  // then the Explore sheet; focus returns to whatever opened it
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && !closeDrawers(true)) layers.escape?.() })
}
const layers = { escape: null }
/** The document layout (no 3D): the sandbox says why it can't run; everything else works as it is. */
export function docMode() { sandboxApi?.disable('The sandbox needs the 3D scene, which isn’t running here. The real runs are in chapter 08.') }
/** "Try 3D anyway" (boot.js): the flight is live again, so the sandbox is too (this also drops the stale html.no-webgl). */
export function liveMode() { sandboxApi?.enable(); document.documentElement.classList.remove('no-webgl') }
function toggleDrawer(d, b, on) {
  if (on) closeDrawers(false)
  d.classList.toggle('is-open', on)
  b.setAttribute('aria-expanded', String(on))
  if (on) $('.fl-close', d)?.focus({ preventScroll: true })
  else b.focus({ preventScroll: true })
}
function closeDrawers(refocus) {
  const open = $$('.fls-drawer.is-open')
  open.forEach((d) => {
    d.classList.remove('is-open')
    const b = $(`[aria-controls="${d.id}"]`)
    b?.setAttribute('aria-expanded', 'false')
    if (refocus && d.contains(document.activeElement)) b?.focus({ preventScroll: true })
  })
  return open.length > 0
}

// --- the flight ---------------------------------------------------------------------------------------------------------
export function createScenes({ stage, jump, nav, reduced, capture }) {
  initDom()
  proxy.attach(stage)
  sandboxApi?.enable()
  const root = document.documentElement
  const camera = stage.getCamera()
  const secs = $$('.fls')
  const links = $$('#fl-index a')
  const svg = $('#fl-pins'), labels = $('#fl-pinlabels')
  const V = new camera.position.constructor()
  if (capture) root.classList.add('fl-still') // once, at load: deterministic stills (no CSS transitions)
  const state = { vis: null, cur: -1, a: secs.map(() => -1), live: [], reelRects: null, joints: 0, settle: 0, out: 1, lastGate: 0, instant: false }

  // pinned callouts: [scene, world point fn, label lines, label offset px (desktop)]
  const servoAt = (j) => {
    const m = stage.getPartInfo(j)?.mesh
    if (!m) return null
    if (!m.geometry.boundingBox) m.geometry.computeBoundingBox()
    return m.localToWorld(m.geometry.boundingBox.getCenter(V.set(0, 0, 0)))
  }
  const B2 = cellCenter('B2')
  const VAL = Object.fromEntries($$('#touch .bars li').map((li) => [li.dataset.joint, li.querySelector('.b-val').textContent]))
  // round 6 (Igloo #11): tiny mono labels pinned to real objects, per STOP (`st`: the stop p's they belong to; none = the
  // whole scene). They type on ~0.3 s after the camera settles and leave as soon as it moves. Every fact is also in the text.
  const gp = () => servoAt('gripper')
  // nophone: left off at phone width (the label would sit on the arm itself at 390 px; the same facts are in the text).
  // 2026-11-01 phone check: also the 08 reconstruction pin (it sat on the headline; the footer chip keeps the honesty line)
  // and the 11 servo readouts (the close-up put them across the headline)
  const PINS = [
    { s: 0, st: [0.0], nophone: 1, at: () => servoAt('shoulder_lift'), t: ['SO-101 FOLLOWER', '6 FEETECH STS3215 SERVOS'], o: [120, -70] },
    { s: 0, st: [0.0], nophone: 1, at: gp, t: ['GRIPPER', 'ONE OF SIX SERVO JOINTS'], o: [-130, 70] },
    { s: 2, st: [0.3], at: () => V.set(CUP.x, CUP.h, CUP.z), t: ['THE CUP', 'THE NOODLE MUST END UP INSIDE'], o: [90, -60] },
    { s: 3, st: [0.515], at: () => V.set(B2.x, 0.004, B2.z), t: ['B2', '0 OF 160 EPISODES'], o: [-120, -110] },
    { s: 4, st: [0.615], at: () => V.set(0.2225, 0.5, 0.05), t: ['OVERHEAD CAMERA', '800×600'], o: [110, 20] },
    { s: 4, st: [0.615], at: gp, t: ['WRIST CAMERA', '640×480'], o: [-110, 60] },
    { s: 6, st: [0.775], at: () => V.set(B2.x, 0.002, B2.z), t: ['B2, HELD OUT', '0 OF 160 EPISODES'], o: [-150, -96] }, // round 11: not at the lift's hero (B2 is below its frame)
    // round 14: the 3D arm in 08 picks at the focused run's cell, timed to its clip: say what it is (no joints were logged)
    { s: 7, run: 1, nophone: 1, at: gp, t: ['3D ARM: A RECONSTRUCTION', 'IK PICK AT B2, TIMED TO THE CLIP', 'NOT THE RECORDED JOINTS'], o: [190, -50] },
    { s: 8, at: () => V.set(CUP.x, CUP.h * 0.9, CUP.z), t: ['THE CUP', 'A TRIAL COUNTS ONLY IF', 'THE NOODLE ENDS UP IN IT'], o: [250, 30] },
    { s: 9, at: () => servoAt('gripper'), t: ['01 VISION ONLY', 'NO TACTILE DATA RECORDED'], o: [-70, -140] },
    { s: 9, at: () => V.set(0.335, 0, 0.02), t: ['03 BEYOND ROW 3: OUTSIDE THE GRID', 'NOT TESTED'], o: [70, 36] },
    { s: 9, at: () => V.set(RING.pos.x, RING.pos.y + RING.radius, RING.pos.z), t: ['03 ONE LIGHTING SETUP'], o: [70, -40] },
    ...JOINTS.map((j, i) => ({ s: 10, nophone: 1, at: () => servoAt(j), t: [`${PRETTY[j].toUpperCase()}  ${VAL[j] ?? '—'}`], o: [[110, 30], [120, -40], [110, -70], [120, -60], [110, -30], [120, 20]][i], bar: Number(VAL[j]) / 152 })),
  ]
  svg.innerHTML = PINS.map(() => '<g><path/><circle r="2.6"/></g>').join('') + '<g class="reels"></g>'
  labels.innerHTML = PINS.map((p) => `<div class="fl-pin">${p.t.map((l, i) => `<span${i ? '' : ' class="h"'}>${l}</span>`).join('')}${p.bar ? `<i style="--v:${p.bar.toFixed(3)}"></i>` : ''}</div>`).join('')
  const gEls = [...svg.children].slice(0, PINS.length), lEls = [...labels.children]
  const reelG = svg.querySelector('.reels')
  const reels = $$('#film .reel')
  reelG.innerHTML = reels.map(() => '<path/><circle r="2.6"/>').join('')
  // round 11: desktop = the reels stand on the table as screens (props_runs.js places them per frame; html.fl-reels3d
  // switches their CSS layout, set at load and on resize only); phones keep the strip. `?off=screens` = round 10.
  const runs = new URLSearchParams(location.search).get('off')?.split(',').includes('screens') ? null : createRuns({ stage, reels })
  if (runs) stage.addToScene(runs.group)
  const runs3d = () => { const on = !!runs && !phone(); root.classList.toggle('fl-reels3d', on); if (!on) runs?.reset() }
  // round 14: each screen names its result (the headline's "all successful": the noodle ended up in the cup in all four)
  reels.forEach((r) => { const fc = $('figcaption', r); if (fc && !$('.fl-res', fc)) { const b = document.createElement('span'); b.className = 'fl-res'; b.textContent = 'Success: noodle in the cup'; fc.append(b) } })

  const project = (v) => {
    V.copy(v).project(camera)
    return V.z < 1 && V.z > -1 ? { x: (V.x * 0.5 + 0.5) * innerWidth, y: (-V.y * 0.5 + 0.5) * innerHeight } : null
  }
  const phone = () => innerWidth < 700 || innerWidth / innerHeight < 1
  addEventListener('resize', () => { state.reelRects = null; runs3d() })
  runs3d()

  // round 12: a pin's opacity is a pure function of where the camera is: whole within ~7 % of the segment round its stop,
  // gone by 18 % (stop pins), or with its scene's panel (scene-wide pins). No settle gate, no clock.
  PINS.forEach((pin) => { pin.si = pin.st ? pin.st.map((x) => STOPS.findIndex((s) => Math.abs(s.p - x) < 1e-6)).filter((i) => i >= 0) : null })
  function pinA(pin, sceneA, mix, gate) {
    if (!pin.si) return (sceneA[pin.s] || 0)
    if (!mix) return 0
    const w = mixWeights(mix, false, true)
    return Math.max(pin.si.includes(mix.a) ? w[0] : 0, pin.si.includes(mix.b) ? w[1] : 0) * gate
  }
  function drawPins(sceneA, gate, mix) {
    const ph = phone()
    PINS.forEach((pin, i) => {
      const a = !(ph && pin.nophone) ? Math.round(pinA(pin, sceneA, mix, gate) * 100) / 100 : 0
      const g = gEls[i], l = lEls[i]
      // type on when the pin (re)appears after a move; the text stays whole once typed
      if (a > 0.01 && !pin.shown) { pin.shown = true; if (!state.instant && !reduced()) scramble(l, 0.45, 'type') }
      if (a <= 0.01) pin.shown = false
      if (a < 0.01) { if (g.style.opacity !== '0') { g.style.opacity = '0'; l.style.opacity = '0' } return }
      const w = pin.at()
      const s = w && project(w)
      // round 13: an anchor outside the frame hides its pin (the limits ring sat off-screen: its label was clamped into the corner)
      if (!s || s.x < 8 || s.x > innerWidth - 8 || s.y < 8 || s.y > innerHeight - 8) { g.style.opacity = '0'; l.style.opacity = '0'; return }
      let [ox, oy] = pin.o
      if (ph) { ox *= 0.55; oy *= 0.6 }
      // the label stays inside the frame and clear of the corner chrome (the leader bends to reach it)
      const room = ph ? 190 : 270, edge = ph ? 16 : 60 // ~ a label's width + the 32 px run; labels hang left (ox < 0) or right of the knee (round 14: phone 150 let the limits row-3 label run 26 px off the right edge)
      const kx = ox >= 0 ? Math.min(innerWidth - room, Math.max(edge, s.x + ox)) : Math.min(innerWidth - edge, Math.max(room, s.x + ox)), ky = Math.min(innerHeight - (ph ? 200 : 110), Math.max(ph ? 110 : 120, s.y + oy)), run = ox >= 0 ? 26 : -26
      g.firstChild.setAttribute('d', `M${s.x.toFixed(1)},${s.y.toFixed(1)} L${kx.toFixed(1)},${ky.toFixed(1)} L${(kx + run).toFixed(1)},${ky.toFixed(1)}`)
      g.lastChild.setAttribute('cx', s.x.toFixed(1)); g.lastChild.setAttribute('cy', s.y.toFixed(1))
      g.style.opacity = a.toFixed(3)
      l.style.opacity = a.toFixed(3)
      l.style.transform = `translate(${(ox >= 0 ? kx + run + 6 : kx + run - 6).toFixed(1)}px, ${(ky - 4).toFixed(1)}px) translate(${ox >= 0 ? '0' : '-100%'}, -100%)`
      l.classList.toggle('r', ox < 0)
    })
    // reels: a hairline from each card's foot down to the cell it was filmed in (desktop: the cards float over the grid)
    const ra = sceneA[7] || 0
    reelG.style.opacity = ph ? '0' : ra.toFixed(3)
    if (ra > 0.01 && !ph && runs?.on) { // round 11: from each screen's foot down the table to its cell
      // round 14: each leader DRAWS ON as the scene arrives (a pure function of its weight: scrolling back undraws it),
      // left to right 0.12 apart; its dot lands last; the screen in focus keeps a brighter, solid leader
      const kids = reelG.children, fi = runs.focusIdx
      reels.forEach((r, i) => {
        const f = runs.foot2d[i], c = runs.cell2d[i]
        if (!f.ok || !c.ok) return
        const k = clamp01((ra - 0.2 - 0.12 * i) / 0.4), e = k * k * (3 - 2 * k)
        const x = f.x + (c.x - f.x) * e, y = f.y + (c.y - f.y) * e
        kids[i * 2].setAttribute('d', `M${f.x.toFixed(1)},${f.y.toFixed(1)} L${x.toFixed(1)},${y.toFixed(1)}`)
        kids[i * 2 + 1].setAttribute('cx', c.x.toFixed(1)); kids[i * 2 + 1].setAttribute('cy', c.y.toFixed(1))
        const dot = clamp01((k - 0.85) / 0.15).toFixed(2)
        if (kids[i * 2 + 1].style.opacity !== dot) kids[i * 2 + 1].style.opacity = dot
        const on = i === fi ? 'is-focus' : ''
        if (kids[i * 2].getAttribute('class') !== on) { kids[i * 2].setAttribute('class', on); kids[i * 2 + 1].setAttribute('class', on) }
      })
    } else if (ra > 0.01 && !ph) {
      if (!state.reelRects) state.reelRects = reels.map((r) => $('.frame', r).getBoundingClientRect())
      const kids = reelG.children
      reels.forEach((r, i) => {
        const rc = state.reelRects[i], c = project(cellCenter(r.dataset.cell))
        if (!c) return
        const x0 = rc.left + rc.width / 2, y0 = rc.bottom + 30
        kids[i * 2].setAttribute('d', `M${x0.toFixed(1)},${y0.toFixed(1)} L${x0.toFixed(1)},${(y0 + 14).toFixed(1)} L${c.x.toFixed(1)},${c.y.toFixed(1)}`)
        kids[i * 2 + 1].setAttribute('cx', c.x.toFixed(1)); kids[i * 2 + 1].setAttribute('cy', c.y.toFixed(1))
      })
    }
  }

  // --- navigation hooks: index links, in-page links, hash, focus, tour ---------------------------------------------
  const sceneOfHash = (h) => SCENES.findIndex((s) => s.hash === h)
  document.addEventListener('click', (e) => {
    const a = e.target instanceof Element && e.target.closest('a[href^="#"]')
    if (!a || !root.classList.contains('fl-live')) return
    const si = sceneOfHash(a.getAttribute('href').slice(1))
    if (si < 0) return
    e.preventDefault()
    closeIndex()
    jump(si, a.hasAttribute('data-warp') ? { warp: true } : {})
  })
  addEventListener('hashchange', () => { const si = sceneOfHash(location.hash.slice(1)); if (si >= 0 && root.classList.contains('fl-live')) jump(si) })
  // keyboard / screen-reader focus landing in another scene's panel takes the flight there
  document.addEventListener('focusin', (e) => {
    if (!root.classList.contains('fl-live')) return
    const sec = e.target instanceof Element && e.target.closest('.fls')
    if (!sec) return
    const si = Number(sec.dataset.i)
    if (si !== sceneAt(nav ? nav.p : 0)) jump(si)
  })
  $('.fl-skiplink')?.addEventListener('click', (e) => {
    e.preventDefault()
    const sec = secs[Math.max(0, state.cur)]
    sec?.focus({ preventScroll: true })
  })
  const idxBtn = $('#fl-index-toggle'), idx = $('#fl-index')
  const closeIndex = () => { idx.classList.remove('is-open'); idxBtn.setAttribute('aria-expanded', 'false') }
  idxBtn.addEventListener('click', () => { const on = !idx.classList.contains('is-open'); idx.classList.toggle('is-open', on); idxBtn.setAttribute('aria-expanded', String(on)) })
  const tourBtn = $('#fl-tour')
  tourBtn?.addEventListener('click', () => { if (nav?.N.tour) nav.stopTour(); else nav?.startTour() })
  document.addEventListener('flight:tour', (e) => { tourBtn.setAttribute('aria-pressed', String(e.detail.on)); tourBtn.textContent = e.detail.on ? 'Stop the tour' : 'Play the tour' })
  // a deep link lands directly (after the first frame, so the director's state exists)
  let pendingHash = capture ? -1 : sceneOfHash(location.hash.slice(1))

  // round 6 clean holds: every scene rests on its headline, one line and its pins; the card (01-07) or the rest of the
  // column (08-13: lists, tables, notes, drawers) opens behind "Explore" (desktop and phone; phones show it as a sheet).
  // The no-3D document never hides anything (is-sheet only means something under html.fl-live).
  // round 12: scenes 08-13 read the COPY agent's js/flight/copy.js (kicker, headline, explanatory body shown by default,
  // facts) into their own panel, in the live flight only (the document keeps flight.html's text). Without copy.js the
  // panels keep their own text.
  if (COPY?.stops) for (let i = HUD_STOPS; i < STOPS.length; i++) {
    const c = COPY.stops.find((x) => x.stop === i), sec = secs[sceneOfStop(i)], main = sec && $('.fls-main', sec)
    if (!c || !main) continue
    const k = $('.fls-kick', main), h = $('.fl-h', main)
    let cap = $('.fl-cap', main)
    if (!cap && h && c.body) { cap = document.createElement('p'); cap.className = 'fl-cap'; h.after(cap) } // 10 / 13 had none
    if (k && c.kicker) k.textContent = c.kicker
    const norm = (t) => t.replace(/\s+/g, ' ').trim().replace(/[.]$/, '').toLowerCase()
    if (h && c.headline && norm(h.textContent) !== norm(c.headline)) h.textContent = c.headline
    if (cap && c.body) {
      const desk = $('.fl-desk', cap)
      cap.textContent = c.body + (sec.id === 'sandbox' ? ' Drag to orbit.' : '')
      if (desk) cap.append(desk)
    }
    if (c.facts?.length && !['results', 'sandbox'].includes(sec.id) && !$('.fl-facts', main)) {
      const ul = document.createElement('ul'); ul.className = 'fl-facts fl-keep'
      ul.innerHTML = c.facts.map((f) => `<li>${f}</li>`).join('')
      ;(cap || h).after(ul)
    }
  }
  const KEEP = '.fls-kick, .fl-h, .fl-cap, .fl-info, .fl-keep'
  secs.forEach((sec) => {
    const card = $('.fls-card', sec), main = $('.fls-main', sec)
    const target = card || main
    if (!target) return
    if (!card && ![...main.children].some((c) => !c.matches(KEEP)) && !$('.fl-more', main)) return // nothing behind it (film)
    target.id = target.id || `card-${sec.id}`
    const b = document.createElement('button')
    b.type = 'button'; b.className = 'fl-info' + (card ? '' : ' fl-info--in'); b.textContent = 'Explore +'
    b.setAttribute('aria-expanded', 'false'); b.setAttribute('aria-controls', target.id)
    target.tabIndex = -1 // the sheet takes focus when it opens (a container, not a tab stop)
    b.addEventListener('click', () => { setSheet(sec, on => !on) })
    if (card) sec.append(b)
    else { const after = $('.fl-cap', main) || $('.fl-h', main); after.after(b) }
  })
  /** Open / close a scene's Explore sheet. Opening moves focus into the sheet; closing from the keyboard (Escape, or the
   *  button itself) returns it to the opener. `next(on)` gets the current state. */
  function setSheet(sec, next, { refocus = true } = {}) {
    const b = $('.fl-info', sec), on = next(sec.classList.contains('is-sheet'))
    if (!b) return
    sec.classList.toggle('is-sheet', on)
    b.setAttribute('aria-expanded', String(on)); b.textContent = on ? 'Close ×' : 'Explore +'
    const target = document.getElementById(b.getAttribute('aria-controls'))
    if (on) target?.focus({ preventScroll: true })
    else if (refocus && (!document.activeElement || document.activeElement === document.body || sec.contains(document.activeElement))) b.focus({ preventScroll: true })
  }
  layers.escape = () => {
    if (!root.classList.contains('fl-live')) return
    if (idx.classList.contains('is-open')) { closeIndex(); idxBtn.focus({ preventScroll: true }); return }
    const sec = secs.find((s) => s.classList.contains('is-sheet'))
    if (sec) setSheet(sec, () => false)
  }
  const skip = $('.fl-skip'), chip = $('.fl-br')
  const liveJoints = $('#fl-joints-live')
  if (liveJoints) liveJoints.innerHTML = JOINTS.map((j) => `<div><dt>${j.replace('_', ' ')}</dt><dd>—</dd></div>`).join('') + '<div><dt>phase</dt><dd>—</dd></div>'
  const jEls = liveJoints ? $$('dd', liveJoints) : []

  // round 14: the run pin's middle line follows the screen in focus (the director picks at that cell)
  const runPin = PINS.findIndex((x) => x.run), runLine = runPin >= 0 ? lEls[runPin].children[1] : null
  return {
    /** round 14: the screen in focus in 08 (cell + the clip's time on the IK pick's timeline) while 08 is in view, else null */
    runsFocus() {
      if (!runs || !(state.runsA > 0.5)) return null
      const f = runs.focus()
      if (f && runLine) { const t = `IK PICK AT ${f.cell}, TIMED TO THE CLIP`; if (runLine.textContent !== t) runLine.textContent = t }
      return f
    },
    update(p, dt, { instant, mv, mix, gate } = {}) {
      if (pendingHash >= 0) { const si = pendingHash; pendingHash = -1; if (si > 0) jump(si, { warp: true }) }
      if (!root.classList.contains('fl-live')) return
      const cur = sceneAt(p)
      let sceneA
      if (!mix) sceneA = WIN.map(([a, b]) => win(p, a, b, FADE)) // no mix (should not happen): the old p windows
      else { // round 12: a scene's layer is a pure function of where the camera is between two stops (nav.mix): whole near
        // its stops, crossfading to the next scene's with a gap between them (mixWeights). No settle gate, no clock: a fast
        // scroll in either direction only ever moves these numbers.
        const sa = sceneOfStop(mix.a), sb = sceneOfStop(mix.b), w = mixWeights(mix, sa === sb), g = instant ? 1 : (gate ?? 1)
        sceneA = state.vis = secs.map((_, i) => Math.max(i === sa ? w[0] : 0, i === sb ? w[1] : 0) * g)
      }
      secs.forEach((s, i) => {
        const a = Math.round(sceneA[i] * 1000) / 1000
        if (a === state.a[i]) return
        const was = state.a[i]
        state.a[i] = a
        s.style.setProperty('--a', String(a))
        s.classList.toggle('is-on', a > 0)
        s.classList.toggle('is-live', a > 0.6)
        if (a > 0.6 && !(was > 0.6) && i >= 7 && !instant && !reduced()) scramble($('.fls-kick', s), 0.45) // small mono only
        if (a === 0 && was > 0 && s.classList.contains('is-sheet')) { s.classList.remove('is-sheet'); const b = $('.fl-info', s); if (b) { b.setAttribute('aria-expanded', 'false'); b.textContent = 'Explore +' } }
        if (a === 0 && was > 0) { $$('.fls-drawer.is-open', s).forEach((d) => { d.classList.remove('is-open'); $(`[aria-controls="${d.id}"]`)?.setAttribute('aria-expanded', 'false') }) }
        if (i === 7 && a > 0 && was <= 0) state.reelRects = null
      })
      // only the scene in view plays its footage (reels: ui/film.js; small cards: here)
      // a loop starts only once the flight has landed (starting a decoder mid-flight can stall a frame); it stops at once
      const landed = !nav?.flying
      if (!reduced()) for (const c of clips) { const on = c.user !== 'paused' && (sceneA[Number(c.scene.dataset.i)] || 0) > 0.6 && (!c.inCard || c.scene.classList.contains('is-sheet')); if (!on || landed) setClip(c, on) } // round 6: a clip behind Explore plays only once opened
      else for (const c of clips) if (c.user !== 'play') setClip(c, false)
      if (cur !== state.cur) {
        const prev = state.cur
        state.cur = cur
        links.forEach((l, i) => { if (i === cur) l.setAttribute('aria-current', 'step'); else l.removeAttribute('aria-current') })
        if (skip) skip.style.visibility = cur >= 8 ? 'hidden' : '' // (not a class on <html>: that restyles the whole page mid-flight)
        // the hash follows only once the camera rests: history.replaceState is a browser-process round trip (88-90 ms
        // CrBrowserMain tasks in a scroll trace), which mid-glide showed up as 40-65 ms frames (2026-10-31)
        if (!instant && prev >= 0) state.hash = SCENES[cur].hash
        stage.setPlaceHint?.(cur === 11)
        if (prev === 7) reels.forEach((r) => { const v = $('video', r); if (!v.paused && !playback.fullscreen) v.pause() })
      }
      // round 6: pins / callouts only while the camera holds: in ~0.3 s after it settles, out in 0.15 s when it moves
      const flying = !!nav?.flying
      if (state.hash && !flying) { try { history.replaceState(null, '', '#' + state.hash) } catch { /* file:// etc */ } state.hash = '' }
      state.instant = !!instant
      state.settle = flying ? 0 : state.settle + dt
      const pg = instant || reduced() ? 1 : (gate ?? 1)
      // the honesty chip leaves the bottom-right corner at the stops where the arm stands there (the halo pair, the 160 landing
      // and the dive): one attribute on one element, only when the held stop changes (never per frame)
      const sp = mix ? STOPS[mix.u < 0.5 ? mix.a : mix.b].p : nav ? nav.STOPS[nav.N.idx].p : p // round 12: the nearer stop
      if (chip && sp !== state.chipP) { state.chipP = sp; chip.dataset.pos = sp < 0.05 || (sp >= 0.44 && sp <= 0.52) ? 'tl' : 'br' }
      if (runs) runs.update(sceneA[7] || 0, camera, !phone(), dt) // round 11: before the leaders read its projections
      state.runsA = sceneA[7] || 0
      drawPins(sceneA, pg, mix)
      // round 12: the results dots and intervals follow the panel both ways (they lit once, on the first intersection)
      const ra = sceneA[8] || 0, lit = state.dotsLit ? ra > 0.15 : ra > 0.45
      if (lit !== !!state.dotsLit && !reduced()) {
        state.dotsLit = lit
        $$('#rows .row').forEach((row) => {
          $$('.dot.is-hit', row).forEach((d) => d.classList.toggle('is-on', lit))
          $('.dots', row)?.classList.toggle('is-lit', lit); $('.dots', row)?.classList.toggle('is-armed', true)
          $('.interval', row)?.classList.toggle('is-armed', !lit)
        })
      }
      // the sandbox's live joint read-out (10 Hz; the stage's displayed pose, not policy output)
      if (cur === 11 && jEls.length) {
        state.joints += dt
        if (state.joints > 0.1 || instant) {
          state.joints = 0
          const js = stage.getJointState()
          JOINTS.forEach((j, i) => { const t = `${fmt(js.joints[j])} rad`; if (jEls[i].textContent !== t) jEls[i].textContent = t })
          const ph = js.phase || 'idle'
          if (jEls[6].textContent !== ph) jEls[6].textContent = ph
        }
      }
    },
  }
}
