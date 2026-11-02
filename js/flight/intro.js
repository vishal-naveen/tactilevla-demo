// Flight opening (intro2): load -> the first held frame, on the clock, as a title sequence. One bright element at a time,
// clean holds, every beat eased. Beat sheet (s after the stage is ready; INTRO_S = 6.4):
//   0.00  black   the navy field and the loader's hairline (#fl-warp's, taken over); it draws in to the ring's screen point (0.5 s)
//   0.50  ignite  the ring lights (studio reveal, 1.4 s arc sweep): the only light in the room
//   1.10  rake    light leaves the ring stand and rakes across the floor: the island's cells rise out of the dark on the
//                 grid pitch behind a stepped, warm front (2 s, decelerating); a low warm rake light comes up with it
//   2.20  data    the reach volume draws on in a sweep around the arm base (real IK samples, reachmap.js, smoothed into four
//                 stacked contour rings + a faint curtain), labelled on a leader line; it leaves before the hold (4.6-5.4)
//   2.70  print   the arm prints in base-up from the ring's light (vfx.js assembly 'fine', 3.1 s): a CAD edge trace draws
//                 base-up (0-0.8 s); ~80k fine motes bud off the ring's tube into a disc of light, drain base-first down one
//                 stream (hot while moving, ivory once settled) and the solid resolves up through the settled cloud
//                 behind a hot seam that leaves the plastic warm and cools to ivory (round 11)
//   0.50-5.20     camera (round 11): ONE move from the ignition, a long lens on the ring sweeping ~24 deg round the island
//                 and craning down while the lens widens, landing on F1 at rest (the halo: the arm in front of the ring);
//                 the HUD fades in from 5.4; hold
// Scrolling fast-forwards it (x4, the arm prints at once; camera <= ~0.85 m/s); reduced motion = the final frame. ?off=intro2 = the M1 build-in.
// All of it is uniforms, light intensities, transforms and DOM: no program is created after load.
import * as THREE from 'three'
import { RING } from '../stage/layout.js'
import { setAssemblyStyle } from '../stage/vfx.js'
import { setFrustumFrames } from '../stage/frustums.js'

const OFF = new Set((new URLSearchParams(location.search).get('off') || '').split(','))
const V2 = !OFF.has('intro2')
export const INTRO_S = V2 ? 6.4 : 4.5
// round 6: the print's fine, speed-tinted motes (vfx.js 'fine'); read by createAssembly, so it must be set before createStage
// (this module body runs before director.js's). ?off=fine keeps the round-5 particles.
if (V2 && !OFF.has('fine')) setAssemblyStyle('fine')
// round 6: real camera frames on the SEES frustums (frustums.js; same rule: before createStage). Source: the site's own
// media/observation-streams.mp4 (training episode 0, both streams side by side, 300x224 each), frame at t 2.8 s: the grasp.
// The eval-run .movs only show the cameras as a phone video of the laptop screen (cam 2 flagged out of focus), so not those.
if (!OFF.has('cams')) {
  const A = (n) => new URL(`../../assets/flight/${n}`, import.meta.url).href
  setFrustumFrames({ overhead: A('cams_overhead.webp'), wrist: A('cams_wrist.webp'),
    labels: { overhead: 'REAL FRAME, TRAINING EPISODE 0', wrist: 'REAL FRAME, SAME INSTANT' } })
}

const clamp01 = (x) => Math.min(1, Math.max(0, x))
const smooth = (x) => { x = clamp01(x); return x * x * (3 - 2 * x) }
const smoother = (x) => { x = clamp01(x); return x * x * x * (x * (6 * x - 15) + 10) }
const ramp = (t, a, b) => smooth((t - a) / (b - a))
const lerp = (a, b, t) => a + (b - a) * t
const outCubic = (x) => 1 - (1 - clamp01(x)) ** 3

export const INTRO_LAND = 5.2 // round 7: the crane lands on F1 here (= T.cam1); the headline enters 0.3 s later (director/hud)
const T = { ign: 0.5, grow0: 1.1, growS: 2.0, lat0: 2.2, latS: 1.2, print: 2.7, cam0: 0.9, cam1: 5.2, hud: 5.2 }
const STAND = new THREE.Vector2(RING.pos.x, RING.pos.z) // the ring stand's foot: where the light leaves for the floor
const GROW_MAX = 2.7 // m from the stand to the island's far corner

// --- loader: a hairline, centred, its length = load progress (created at import, so it shows while the stage builds) ---
const line = document.createElement('div')
line.setAttribute('aria-hidden', 'true')
line.style.cssText = 'position:fixed;left:50%;top:50%;height:1px;width:140px;transform:translate(-50%,-50%);' + // = the #fl-warp loader's hairline (flight.css), which it takes over
  'background:rgba(244,236,222,0.85);z-index:4;pointer-events:none;transition:width .25s linear;will-change:transform,opacity'
if (V2) {
  document.body.appendChild(line)
  line.dataset.flintro = ''
  // round 7 (B owns this gate): the page's layers wait for the opening, then arrive in a choreography instead of one shared
  // 1.1 s fade of every body child after an <html> class flip (a 532-element restyle on the landing frame, and ~16 full-
  // viewport translucent layers fading over the canvas at once). Each gated element carries data-flgate: "0" = hidden,
  // "1" = fading in (opacity only, its own layer), removed when done. Attribute changes restyle that element alone.
  // Order (director/hud): the crane lands (5.2 s) -> the headline enters line by line (+0.3 s) -> corners, index, the
  // scene layer (pins, Explore) and the skip link fade in staggered. Only under html.fl-live: the document fallback
  // (fl-doc) never hides anything; the hairline appears only once the page's own loader (#fl-warp) hands over.
  const st = document.createElement('style')
  st.textContent = 'html.fl-live [data-flgate="0"]{opacity:0!important;transition:none!important}' +
    'html.fl-live [data-flgate="1"]{transition:opacity .9s cubic-bezier(.2,.6,.2,1)!important;will-change:opacity}' +
    'html:not(.fl-live) [data-flintro],html.fl-loading [data-flintro]{display:none!important}'
  document.head.appendChild(st)
}
// [selector, seconds after the reveal starts] (the reveal starts 0.7 s after the crane lands: the headline is in by then)
const GATES = [['#fl-hud > .fl-tl', 0], ['#fl-hud > .fl-tr', 0.08], ['#fl-index', 0.16], ['#fl-hud > .fl-bl', 0.24], ['#fl-hud > .fl-br', 0.3],
  ['#fl-readout', 0.36], ['#fl-main', 0.42], ['.fl-skip', 0.5]]
const gateEls = V2 ? GATES.map(([sel, d]) => ({ el: document.querySelector(sel), d })).filter((g) => g.el) : []
gateEls.forEach((g) => { g.el.dataset.flgate = '0' })

/**
 * @param {{ stage: any, world: any }} o
 */
export function createIntro({ stage, world, sound = null }) {
  const fx = stage.getFX()
  const scene = stage.debug.scene
  const studio = stage.debug.studio
  const envBase = scene.environmentIntensity
  // props that rise with the island (the cup, the noodle) and the tape grid that appears under the front
  let cup = null
  scene.traverse((o) => { if (o.userData?.bake === 'cup') cup = o })
  const grid = stage.debug.grid?.group || null
  const props = [cup].filter(Boolean).map((o) => ({ o, sy: o.scale.y })) // (not the noodle: the stage owns its scale)
  // the reach volume's one label (HUD style) on a leader line from its outer ring: what the lines are, said plainly
  const box = document.createElement('div')
  box.setAttribute('aria-hidden', 'true')
  box.dataset.flintro = ''
  box.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:3;opacity:0'
  box.innerHTML = '<svg style="position:absolute;inset:0;width:100%;height:100%;overflow:visible"><path fill="none" stroke="rgba(255,233,207,.7)" stroke-width="1"/><circle r="2.2" fill="rgba(255,233,207,.9)"/></svg>' +
    "<div style=\"position:absolute;left:0;top:0;font:500 10.5px/1.5 'Archivo',system-ui,sans-serif;font-stretch:62%;letter-spacing:.1em;text-transform:uppercase;white-space:nowrap;color:rgba(244,236,222,.92)\"><b style='font-weight:700;letter-spacing:.14em'></b><br><span style='color:rgba(244,236,222,.62)'></span></div>"
  const LAB = { path: box.querySelector('path'), dot: box.querySelector('circle'), card: box.querySelector('div'), b: box.querySelector('b'), sub: box.querySelector('span'),
    t1: 'REACH · WHERE THE GRIPPER CAN GO', t2: 'IK-SAMPLED TOP-DOWN PICKS, SMOOTHED', t: 2.75 }
  if (V2) document.body.appendChild(box)
  const _v = new THREE.Vector3(), _l0 = new THREE.Vector3()
  const camera = stage.getCamera()
  const S = { ignited: false, printed: false, hud: null, restored: false, rv: undefined }
  const GLYPH = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789·°+-'
  if (V2) S.hud = false // the page's layers arrive at the end of the opening (hud())

  // F1 framing (path.js key p=0): the intro camera starts as a long lens on the ignition above and behind it
  const F1 = { pos: new THREE.Vector3(), look: new THREE.Vector3(), fov: 30 }
  const ringC = RING.pos.clone()

  // round 11: the reach volume (lattice, curtain, floor area) is additive light: unlit, transparent, no depth write. The
  // director adds world.group with receiveShadow on every mesh, and under VSM three draws RECEIVERS into each shadow map
  // too, so the fat-line lattice (LineSegments2 is a Mesh) went into the 2048 key map through the generic depth material,
  // which ignores the line expansion: thousands of instanced quads of overdraw, 9-10 ms per key redraw on the RTX 3060
  // (PC trace: every 5th frame 33 ms from 3.0 to 5.3 s, the whole time the volume was visible). Such objects never belong
  // in a depth map. receiveShadow is a uniform in three r170 (not a program key), so no program changes. Run on the first
  // apply(), i.e. after director.js's addToScene.
  function unshadow() {
    S.unshadowed = true
    world.group.traverse((o) => {
      const m = o.material
      if (m && !Array.isArray(m) && m.transparent && m.depthWrite === false && !m.lights) { o.receiveShadow = false; o.castShadow = false }
    })
  }

  // the page's layers (gates above): hidden through the opening, then staggered in on the intro clock (`t` = seconds since
  // the reveal began; `now` = show all at once: reduced motion, a skipped opening, capture)
  function hud(on, t = 0, now = false) {
    if (!on) { S.hud = false; S.rv = undefined; gateEls.forEach((g) => { g.el.dataset.flgate = '0'; g.state = 0 }); return }
    if (S.hud === true) return
    let all = true
    for (const g of gateEls) {
      if (g.state === 2) continue
      if (now) { delete g.el.dataset.flgate; g.state = 2; continue }
      if (!g.state && t >= g.d) { g.el.dataset.flgate = '1'; g.state = 1; g.at = t }
      if (g.state === 1 && t >= g.at + 1.0) { delete g.el.dataset.flgate; g.state = 2 } // done: drop the layer hint
      if (g.state !== 2) all = false
    }
    if (all) S.hud = true
  }

  return {
    duration: INTRO_S,
    /** Advance the clock: skipping (a scroll) fast-forwards and prints the arm at once; reduced motion jumps to the end. */
    advance(it, dt, skip, reduced) {
      if (it >= INTRO_S) return it
      if (reduced) return INTRO_S
      // round 11: the clock holds at 0 (the static navy field + hairline) until 6 frames in a row came in under 24 ms: the
      // hand-over from the loader costs 1-3 first-use frames (the page's first layout + text shaping, the director's first
      // ticks: 33-67 ms on the PC) and they used to land in the hairline's draw-in; at most 0.8 s, so a slow device starts
      if (it === 0 && !skip) {
        S.steady = dt < 0.024 ? (S.steady || 0) + 1 : 0
        S.wait = (S.wait || 0) + dt
        if (S.steady < 6 && S.wait < 0.8) return 0
      }
      if (skip && V2) { if (!S.printed) { S.printed = true; stage.printArm(true) } return Math.min(INTRO_S, it + dt * 4) } // x4: the crane at x6 hit 1.27 m/s
      if (skip) return INTRO_S
      return it + dt
    },
    /** Map intro time onto sound.js's build-in clock (its shimmer follows the M1 lattice 0-1 s + island 1.0-2.4 s). */
    soundT(it) {
      if (!V2) return it
      // sound v2 plays the ignition hit itself when it sees the ring light at clock 0, or the whole rise when the clock is
      // > 0: the hit is cued directly on the ignition frame (apply), so from then on the clock reads >= INTRO_HIT - 0.15
      // (its "already played" branch) and holds its shimmer up through the build, letting go as the print completes
      if (!S.ignited) return 0
      return it < 3.4 ? 2.26 + 0.14 * clamp01((it - T.ign) / (3.4 - T.ign)) : 2.4 + (it - 3.4)
    },
    /** Everything of the build-in that is a function of (it, p). */
    apply(it, p, dt, reduced) {
      if (!S.unshadowed) unshadow()
      const done = it >= INTRO_S || reduced
      // lattice opacity over the flight (S0/F1 only, a faint return over S2's exploded view)
      const pK = (1 - ramp(p, 0.02, 0.06)), pS2 = 0.22 * Math.min(ramp(p, 0.07, 0.1), 1 - ramp(p, 0.14, 0.16)) // M1 only
      world.uniforms.uTime.value = reduced ? 0 : (world.uniforms.uTime.value + dt)
      if (!V2) { // M1 build-in (director.js before intro2): lattice 0-1.0 s, island grows 1.0-2.4 s, ring + print at 2.4 s
        if (!S.ignited && it >= 2.4) { S.ignited = true; stage.reveal() }
        const grow = it >= INTRO_S ? 9 : it < 1.0 ? 0 : lerp(0.0, 1.6, smooth((it - 1.0) / 1.4) ** 1.3)
        const band = it < 1.0 || it > 3.2 ? 0 : 0.55 * Math.min(1, (it - 1.0) / 0.2) * (1 - smooth((it - 2.2) / 0.6))
        const latAlpha = (it < 2.4 ? 0.9 : lerp(0.9, 0.35, smooth((it - 2.4) / 1.6))) * pK + pS2
        world.set({ grow: reduced ? 9 : grow, band: reduced ? 0 : band, lat: reduced ? 1 : clamp01(it / 1.0), latAlpha })
        world.setRake(0, 0.2, 0)
        this.air(p, 1)
        return
      }
      // beats
      if (!S.ignited && (it >= T.ign || done)) { S.ignited = true; S.ignT = it; stage.igniteRing(); if (!done) sound?.cue('ignite') } // the hit on the exact frame (a no-op while sound is off)
      if (!S.printed && (it >= T.print || done)) { S.printed = true; stage.printArm(done) }
      // island: cells rise behind a stepped front leaving the ring stand
      const g = clamp01((it - T.grow0) / T.growS)
      const grow = done ? 9 : it < T.grow0 ? 0 : GROW_MAX * (0.03 + 0.97 * smoother(g)) // slow in: the front crosses the frame, then runs off
      const band = done ? 0 : 0.85 * ramp(it, T.grow0, T.grow0 + 0.15) * (1 - ramp(it, T.grow0 + T.growS * 0.55, T.grow0 + T.growS))
      world.uniforms.uO.value.copy(STAND); world.uniforms.uAniso.value.set(1, 1); world.uniforms.uRise.value = 1
      world.uniforms.uBandP.value.set(0.09, 1.3, 0.1) // a hot stepped front (it blooms a little) and a warm wake behind it
      // the reach volume: drawn on by a sweep around the base, held while its label reads, gone before the hold
      const lat = done ? 1 : smooth((it - T.lat0) / T.latS)
      const latAlpha = done ? 0 : 0.85 * ramp(it, T.lat0, T.lat0 + 0.3) * (1 - ramp(it, 4.6, 5.4))
      world.set({ grow, band, lat, latAlpha })
      // props rise as the front passes them; the tape grid appears under the front
      // (written only while the intro runs, restored once: the stage owns them afterwards, e.g. the noodle's own shrink)
      if (!done || !S.restored) {
        S.restored = done
        for (const pr of props) {
          const d = Math.hypot(pr.o.position.x - STAND.x, pr.o.position.z - STAND.y)
          pr.o.scale.y = pr.sy * (done ? 1 : Math.max(0.001, smoother((grow - d) / 0.22)))
        }
        if (grid) grid.visible = done || grow > Math.hypot(0.24 - STAND.x, 0 - STAND.y)
        // light: the room stays dark (the print brings the key up: vfx.js onLight); the rake + ring light the floor first
        scene.environmentIntensity = envBase * (done ? 1 : lerp(0.12, 1, ramp(it, T.grow0, 4.6)))
      }
      this.rake(p, done ? 1 : ramp(it, T.grow0 - 0.1, T.grow0 + 0.9), done ? 0 : Math.max(0, 1 - Math.abs(it - 2.2) / 1.4))
      this.air(p, done ? 1 : ramp(it, 0.8, 3.0))
      // labels: typed on as the lattice reaches them, gone before the hold
      this.labels(done ? 99 : it)
      // loader hairline: complete, then draws in to the ring's screen point while the ring ignites
      if (line.isConnected) {
        const k = smooth((it - 0.05) / 0.5)
        const r = stage.getRingScreenRect?.()
        const cx = r ? r.x + r.width / 2 : innerWidth / 2, cy = r ? r.y + r.height / 2 : innerHeight / 2
        line.style.transition = 'none'
        line.style.left = lerp(innerWidth / 2, cx, k) + 'px'; line.style.top = lerp(innerHeight / 2, cy, k) + 'px'
        line.style.width = (140 * (1 - k)) + 'px'
        line.style.opacity = String(1 - smooth((it - 0.35) / 0.2))
        if (it > 0.6 || done) line.remove()
      }
      // reveal: 0.7 s after the crane lands (the headline enters at +0.3, hud.js), on the intro clock, then on dt once the
      // clock has stopped at INTRO_S (a fast-forward runs it x4 too); reduced motion shows everything at once
      if (reduced) hud(true, 9, true)
      else {
        if (it < INTRO_S) { if (it >= T.hud + 0.7) S.rv = it - T.hud - 0.7 } else S.rv = (S.rv ?? 0) + dt
        if (S.rv !== undefined) hud(true, S.rv)
      }
    },
    /** Rake light: F1's grazing key from the ring's side (k), plus the intro's sweep (sweep 0..1 swings it across). */
    rake(p, k, sweep = 0) {
      if (OFF.has('rake')) { world.setRake(0, 0.2, 0); return }
      const f1 = 1 - ramp(p, 0.012, 0.05) * 0.7 // full in F1, a low glancing third through the halo and beyond the island
      const az = Math.atan2(STAND.y - 0.1, STAND.x - 0.15) - 0.62 + 0.55 * sweep // from the ring's side, swung toward camera-left
      world.setRake(az, 0.15 + 0.05 * sweep, (1.45 + 1.2 * sweep) * k * f1 * (1 - ramp(p, 0.2, 0.26)))
    },
    /** Depth air + table sheen (fx.js merged pass): a low warm-to-ink haze, thickest near the floor, and the waxed top's mirror. */
    air(p, k) {
      const u = fx.finish?.uniforms
      if (!u || !fx.dof) return
      u.uAir.value = OFF.has('air') ? 0 : k * (1 - 0.35 * ramp(p, 0.012, 0.06))
      const bg = stage.getBackground()
      u.uAirCol.value.copy(bg).multiplyScalar(1.3); u.uAirCol.value.r += 0.003; u.uAirCol.value.g += 0.011; u.uAirCol.value.b += 0.03 // cool ink, lifted
      u.uAirWarm.value.setRGB(0.16, 0.075, 0.03)
      u.uAirP.value.set(0.5, 2.6, 0.0, 3.4)
      // mist: a few cm deep, sitting just under the island top: the stepped edge sinks into it and the void below reads as
      // a soft bank of ink-blue haze instead of black (strongest in F1)
      u.uMistCol.value.copy(bg).multiplyScalar(2.4); u.uMistCol.value.r += 0.008; u.uMistCol.value.g += 0.017; u.uMistCol.value.b += 0.034
      u.uMist.value.set(OFF.has('mist') ? 0 : 1.6 * (1 - 0.5 * ramp(p, 0.012, 0.06)), 34, -0.018, 0)
      _v.copy(ringC).sub(camera.position).normalize()
      u.uAirSun.value.copy(_v)
      u.uSheen.value = OFF.has('sheen') ? 0 : k * (0.42 - 0.22 * ramp(p, 0.012, 0.06)) * (1 - 0.6 * Math.min(ramp(p, 0.46, 0.48), 1 - ramp(p, 0.52, 0.54))) // the dive: the noodles' mirror read as ghost rows
    },
    labels(it) {
      if (!V2 || OFF.has('reachlabel')) return
      const a = it < LAB.t ? 0 : Math.min(1, (it - LAB.t) / 0.2) * (1 - ramp(it, 4.5, 5.1))
      box.style.opacity = String(a)
      if (a <= 0) return
      _v.fromArray(world.reachAnchor).project(camera)
      const x0 = (_v.x * 0.5 + 0.5) * innerWidth, y0 = (-_v.y * 0.5 + 0.5) * innerHeight
      const draw = smooth((it - LAB.t) / 0.35)
      const x1 = x0 + 26, y1 = y0 - 54, x2 = x1 + 34 * draw
      LAB.path.setAttribute('d', `M${x0.toFixed(1)},${y0.toFixed(1)} L${x1.toFixed(1)},${(y0 + (y1 - y0) * Math.min(1, draw * 1.6)).toFixed(1)} L${x2.toFixed(1)},${y1.toFixed(1)}`)
      LAB.dot.setAttribute('cx', x0.toFixed(1)); LAB.dot.setAttribute('cy', y0.toFixed(1))
      LAB.card.style.transform = `translate(${(x1 + 40).toFixed(1)}px,${(y1 - 9).toFixed(1)}px)`
      const type = (txt, u) => { const n = Math.floor(clamp01(u / 0.45) * txt.length); return txt.slice(0, n) + (n < txt.length ? GLYPH[Math.floor((it * 37 + n * 7) % GLYPH.length)] : '') }
      const s1 = type(LAB.t1, it - LAB.t - 0.2), s2 = type(LAB.t2, it - LAB.t - 0.45)
      if (LAB.b.textContent !== s1) LAB.b.textContent = s1
      if (LAB.sub.textContent !== s2) LAB.sub.textContent = s2
    },
    /**
     * The intro camera on top of the path's F1 key (camOut from path.sample at p): a long lens on the ignition, then one
     * crane down and out while the lens widens, landing on the key with a long ease (no overshoot). Scroll takes over as
     * the intro ends (the director's p follower starts from the same F1 pose).
     */
    camera(it, p, out, reduced) {
      if (reduced || it >= INTRO_S) return
      const w = 1 - smooth(p / 0.03) // a skip (scroll / first intent) flies on while the opening fast-forwards: blend, never cut
      if (w <= 0) return
      const P0 = [...out.pos], L0p = [...out.look], fov0 = out.fov, dx0 = out.dx, f0 = out.focus, at0 = [...out.at]
      if (!V2) { // M1: a slow 6 deg orbit into the first key
        const ang = THREE.MathUtils.degToRad(6) * (1 - smooth(it / INTRO_S))
        const c = out.look, x = out.pos[0] - c[0], z = out.pos[2] - c[2]
        out.pos[0] = c[0] + x * Math.cos(ang) - z * Math.sin(ang); out.pos[2] = c[2] + x * Math.sin(ang) + z * Math.cos(ang)
        return
      }
      F1.pos.fromArray(out.pos); F1.look.fromArray(out.look); F1.fov = out.fov
      const L0 = _l0.lerpVectors(ringC, F1.look, 0.35).setY(ringC.y * 0.62) // the ring in the upper frame, the dark floor below it
      // start: further out along the F1 bearing, higher, aimed at the ring, long lens; a slow 2 % push while it ignites
      const d = F1.pos.clone().sub(F1.look)
      const az1 = Math.atan2(d.z, d.x), r1 = Math.hypot(d.x, d.z), el1 = Math.atan2(d.y, r1), D1 = d.length()
      // round 11: ONE move from the ignition to F1 (was a 0.9 s hold + 2 % push, then the crane): it starts the instant the
      // ring lights, sweeps ~24 deg round the island while the cells assemble under the rake, and lands on the key with
      // zero velocity and acceleration (smootherstep), so the hold and the first scroll start from rest (no snap)
      const az0 = az1 + 0.42, el0 = el1 + 0.13, D0 = D1 * 1.38
      const e = smoother((it - T.ign) / (T.cam1 - T.ign))
      const az = lerp(az0, az1, e), el = lerp(el0, el1, e), D = lerp(D0, D1, e)
      const look = new THREE.Vector3().lerpVectors(L0, F1.look, smooth((it - T.ign - 0.5) / (T.cam1 - T.ign - 0.5)))
      out.pos[0] = look.x + Math.cos(el) * Math.cos(az) * D
      out.pos[1] = look.y + Math.sin(el) * D
      out.pos[2] = look.z + Math.cos(el) * Math.sin(az) * D
      out.look[0] = look.x; out.look[1] = look.y; out.look[2] = look.z
      out.fov = lerp(19, F1.fov, e)
      out.dx = lerp(0, out.dx, e)
      // focus: on the ring through the ignition, onto the arm as it prints
      out.focus = lerp(1.2, out.focus, smooth((it - 4.2) / 1.0)) // shallow only once the print is done (defocused particles read as smoke)
      out.at = [lerp(ringC.x, out.at[0], e), lerp(ringC.y, out.at[1], e), lerp(ringC.z, out.at[2], e)]
      if (w < 1) {
        for (let i = 0; i < 3; i++) { out.pos[i] = lerp(P0[i], out.pos[i], w); out.look[i] = lerp(L0p[i], out.look[i], w); out.at[i] = lerp(at0[i], out.at[i], w) }
        out.fov = lerp(fov0, out.fov, w); out.dx = lerp(dx0, out.dx, w); out.focus = lerp(f0, out.focus, w)
      }
    },
  }
}
