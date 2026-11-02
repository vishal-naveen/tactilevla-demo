// Stage B moments (effects plan ../tactilevla-redesign/render/PLAN-effects.md): the B2 peak ("light from the held-out
// cell"), the close ("full circle") and the section hand-off envelope. Built at load, driven by values only; each one has
// an ?off= switch (b2, close, handoff). Under reduced motion every moment shows its end frame and the hand-off never runs.
import * as THREE from 'three'
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js'
import { cellCenter } from './layout.js'
import { PAL } from './palette.js'

const smooth = (x) => { const t = Math.min(1, Math.max(0, x)); return t * t * (3 - 2 * t) }
const ease = (cur, target, dt, rate) => cur + (target - cur) * (1 - Math.exp(-dt * rate))
const B2 = cellCenter('B2')

// The pool: light on the table, not a glowing decal. Hot, whiter core under the noodle, amber falling off past the cell's
// edges (a gaussian, slightly stretched along the row), over-range at the core so bloom gives it a little air.
const POOL_VERT = /* glsl */ `varying vec2 vP; void main(){ vP = position.xz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`
const POOL_FRAG = /* glsl */ `
uniform vec3 uColor; uniform float uGain; uniform float uR;
varying vec2 vP;
void main(){
  vec2 q = vP / (uR * vec2(0.8, 1.15));
  float d2 = dot(q, q);
  float halo = exp(-d2 * 1.3);
  float core = exp(-d2 * 6.0);
  vec3 c = uColor * halo * 1.3 + mix(uColor, vec3(1.0, 0.84, 0.62), 0.7) * core * 4.6;
  c *= 1.0 - smoothstep(0.075, 0.148, length(vP)); // falls to zero inside the 0.3 m plane: its square edge never shows
  gl_FragColor = vec4(c * uGain, 1.0);
}`

// Round 6 (flight.html only): the flight drives its own chapter seam (stage.setSeam, one per chapter crossing), so it
// retires this section hand-off there; index.html never calls this and keeps its hand-off exactly as before.
let flightSeams = false
/** @param {boolean} on true = the page sends its own seams (stage.setSeam); section changes play no hand-off */
export function setFlightSeams(on) { flightSeams = !!on }

/**
 * @param {THREE.Scene} scene
 * @param {{ studio: any, labelParent: THREE.Object3D, off: Set<string> }} o
 */
export function createMoments(scene, { studio, off }) {
  const OFF_B2 = off.has('b2'), OFF_CLOSE = off.has('close'), OFF_HAND = off.has('handoff'), OFF_QUIET = off.has('quiet') || OFF_CLOSE

  // --- B2 pool ---
  const poolMat = new THREE.ShaderMaterial({
    vertexShader: POOL_VERT, fragmentShader: POOL_FRAG,
    uniforms: { uColor: { value: new THREE.Color() }, uGain: { value: 0 }, uR: { value: 0.05 } },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
  })
  const pool = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 0.3).rotateX(-Math.PI / 2), poolMat)
  pool.position.set(B2.x, 0.0009, B2.z) // just above the grid fill, under the noodle
  pool.renderOrder = 3
  pool.userData.noAO = true
  pool.visible = false
  scene.add(pool)
  // honesty: the peak is where the reconstruction is most likely to be read as a result
  const tagEl = document.createElement('div')
  tagEl.className = 'stage-label stage-label--tag'
  tagEl.textContent = 'Reconstruction · staged light'
  tagEl.style.opacity = '0'
  const tag = new CSS2DObject(tagEl)
  // centred under the grid's front edge (row 3, the camera side): to the right it ran into the runs carousel's arrows and
  // off the viewport edge (desktop and phone)
  tag.position.set(B2.x + 0.118, 0.0, B2.z - 0.025) // clear of row 3's front edge on the phone shot too
  tag.center.set(0.5, 0)
  scene.add(tag)

  const b2 = { on: false, t: 0, level: 0, target: 0, first: true, pulseT: -1, ringDim: 1, tagA: 0, lifted: false }
  const _lp = new THREE.Vector3()

  // --- close ---
  const close = { on: false, k: 0, sweep: 0, flashT: -1, flashed: false }
  const quiet = { k: 0 } // limits: the ring settles low (?off=quiet; ?off=close keeps the old full-ring chord there instead)

  // --- hand-off ---
  const hand = { t: -1, dir: 1, seed: 0, k: 0 }
  const HAND_S = 0.8

  return {
    pool, tag,
    /** Stacked layouts (phone): the panel's big "B2" heading rises into the band's foot, so the tag moves under row C. */
    setStacked(on) {
      if (on) tag.position.set(B2.x + 0.1, 0.0, B2.z - 0.165)
      else tag.position.set(B2.x + 0.118, 0.0, B2.z - 0.025)
    },
    /** A section-group boundary was crossed: dir +1 scrolling down, -1 back up. */
    handoff(dir, reduced) {
      if (OFF_HAND || reduced || flightSeams) return
      hand.t = 0; hand.dir = dir < 0 ? -1 : 1; hand.seed = (hand.seed + 0.618) % 1
    },
    get handK() { return hand.k },
    get handDir() { return hand.dir },
    get handSeed() { return hand.seed },
    get closeK() { return close.k },
    get b2Level() { return b2.level },
    /**
     * @param {{ chapter: string, group: string|null, phase: string, cell: string|null, reduced: boolean, camDir: THREE.Vector3 }} s
     */
    update(dt, s) {
      // B2: enter -> house down (modes.js testLight), ring to 15 %, pool rises over 1.2 s, one pulse at the first grasp,
      // falls to half as the noodle leaves; later loops hold steady.
      const inTest = !OFF_B2 && s.chapter === 'test'
      if (inTest && !b2.on) { b2.on = true; b2.t = 0; b2.first = true; b2.pulseT = -1; b2.lifted = false }
      if (!inTest) b2.on = false
      if (b2.on) {
        b2.t += dt
        const onB2 = s.cell === 'B2'
        if (b2.first && onB2 && s.phase === 'grasp' && b2.pulseT < 0 && b2.t > 1.2) b2.pulseT = 0
        if (onB2 && (s.phase === 'lift' || s.phase === 'carry') && b2.t > 1.2) { b2.lifted = true; b2.first = false }
        b2.target = s.reduced ? 0.6 : smooth((b2.t - 0.5) / 1.2) * (b2.lifted ? 0.5 : 1)
      } else b2.target = 0
      b2.level = s.reduced ? b2.target : ease(b2.level, b2.target, dt, b2.on ? (b2.t < 1.7 ? 30 : 2.5) : 3.5)
      let pulse = 0
      if (b2.pulseT >= 0) {
        b2.pulseT += dt
        pulse = Math.sin(Math.PI * Math.min(1, b2.pulseT / 0.4))
        if (b2.pulseT >= 0.4) { b2.pulseT = -2 } // once per entry
      }
      const g = b2.level * (1 + 0.6 * pulse) * (1 - PAL.light * 0.6)
      pool.visible = g > 0.002
      poolMat.uniforms.uGain.value = g
      poolMat.uniforms.uColor.value.copy(PAL.held)
      poolMat.uniforms.uR.value = 0.034 + 0.03 * smooth(b2.level * 1.4) // grows out of the cell as it brightens
      b2.ringDim = ease(b2.ringDim, b2.on ? 0.07 : 1, dt, s.reduced ? 1e3 : 2.5)
      if (!OFF_B2) {
        // a real light at table height on the camera side of the cell: the noodle and the gripper's underside catch it
        _lp.set(s.camDir.x, 0, s.camDir.z).normalize().multiplyScalar(0.036)
        studio.amber.position.set(B2.x + _lp.x, 0.007, B2.z + _lp.z)
        studio.amber.distance = 0.32
        studio.amber.intensity = 0.026 * g
        studio.amber.color.copy(PAL.held)
        // while the pool is up it is the one bright thing: the key and the kick give way a little more than testLight's dim
        const give = 1 - 0.4 * Math.min(1, b2.level)
        studio.key.intensity *= give; studio.kick.intensity *= give
      }
      b2.tagA = ease(b2.tagA, b2.on && b2.t > 1.4 ? 1 : 0, dt, 6)
      const ta = b2.tagA < 0.01 ? '0' : b2.tagA.toFixed(2)
      if (tagEl.style.opacity !== ta) tagEl.style.opacity = ta
      tag.visible = b2.tagA > 0.01

      // close: the ring's arc completes its last gap, one flash, and the camera goes home to the hero's halo framing
      const inClose = !OFF_CLOSE && s.chapter === 'results' && s.group === 'next'
      if (inClose && !close.on) { close.on = true; close.flashed = false }
      if (!inClose) close.on = false
      close.k = s.reduced ? (close.on ? 1 : 0) : ease(close.k, close.on ? 1 : 0, dt, close.on ? 1.6 : 3)
      if (close.k < 1e-3) close.k = 0
      close.sweep = s.reduced ? (close.on ? 1 : 0) : Math.min(1, Math.max(0, close.sweep + (close.on ? dt / 0.7 : -dt / 0.5)))
      if (close.on && close.sweep >= 1 && !close.flashed && !s.reduced) { close.flashed = true; close.flashT = 0 }
      let flash = 0
      if (close.flashT >= 0) {
        close.flashT += dt
        flash = 0.8 * Math.sin(Math.PI * Math.min(1, close.flashT / 0.6))
        if (close.flashT >= 0.6) close.flashT = -1
      }
      quiet.k = s.reduced ? (s.chapter === 'limits' ? 1 : 0) : ease(quiet.k, !OFF_QUIET && s.chapter === 'limits' ? 1 : 0, dt, 1.8)
      if (quiet.k < 1e-3) quiet.k = 0
      if (!OFF_QUIET) studio.setRingQuiet(quiet.k)
      studio.setRingDim(b2.ringDim)
      if (!OFF_CLOSE) studio.setRingClose(smooth(close.sweep), flash)

      // hand-off envelope: up fast, out slower (0.8 s)
      if (hand.t >= 0) {
        hand.t += dt
        const u = hand.t / HAND_S
        hand.k = u >= 1 ? 0 : (u < 0.3 ? smooth(u / 0.3) : 1 - smooth((u - 0.3) / 0.7))
        if (u >= 1) hand.t = -1
      } else hand.k = 0
    },
    dispose() { pool.geometry.dispose(); poolMat.dispose(); tagEl.remove() },
  }
}
