// Round 11 (flight.html only): scene 08's four real runs stand on the table as phone screens in front of the grid, each
// in front of the cell it was filmed in (A2 left, the two B2 runs centre, C3 right, as seen from the scene's camera).
// The pictures are the page's own <video> reels (ui/film.js: play, sound, captions, seek, fullscreen stay as they were),
// placed every frame onto the screens' projected rectangles; the 3D part is only what the DOM cannot do: a dark bezel
// and a foot behind each picture, the screen's light pooled on the table in front of it, and a glowing face the table's
// mirror (fx TableSheen) reflects. Every screen turns on its foot to face the camera (yaw only), so its projection stays
// a rectangle the DOM can match with translate + scale. Desktop only: phones keep the bottom strip.
// Round 14 (owner: "I like that it points to the cell it was recorded in but make it even better"):
//  - each cell a run was filmed in is lit by a soft pool in the result colour (all four succeeded: the noodle gold of the
//    results' hit dots); the screen IN FOCUS (engaged > hovered / keyboard-focused > the first reel, which autoplays)
//    steps 1.4 cm toward the camera, grows 7 % and its cell's pool brightens (eased, ~0.35 s);
//  - focus() tells the director which cell the 3D arm should pick from and WHEN: the clip's time mapped onto the IK
//    pick's own timeline through four moments read off the footage (SYNC). That makes the arm a kinematic
//    reconstruction timed to the clip, NOT the recorded trajectory: the rollouts (lerobot-rollout, base strategy) logged
//    no joints, and results say no per-trial log exists.
import * as THREE from 'three'
import { cellCenter } from '../stage/layout.js'
import { glowMaterial } from './props.js'

const H = 0.11, W = H * 9 / 16 // a standing phone, 9:16 like the footage
const FOOT = 0.012 // the picture's lower edge above the table (a small stand)
const X = 0.405 // in front of the grid's near edge (row 3 ends at x 0.305), clear of the arm's reach on the table
const Z = { A2: 0.165, C3: -0.165, B2: [0.055, -0.055] }
const BASE_W = 180 // CSS px: the reel's laid-out width (flight_content.css), scaled per frame from here
const FWD = 0.014, GROW = 0.07 // the focused screen: metres toward the camera, scale

// Clip seconds of four moments, read off each video at 0.5 s steps (round 14, by eye: +-0.5 s): the arm starts to move,
// its jaws reach the noodle, the lift begins, the noodle drops into the cup; then the clip's end. They map onto the IK
// plan's own times (tasks.js: approach starts 0, grasp pose 1.85, lift 2.5, release 4.5, home 6.7).
const SYNC = {
  'act-b2': [13, 20, 28.8, 33.0, 37.5],
  'smolvla-b2': [10, 20, 28.7, 33.5, 37.0],
  'act-a2': [6, 16, 20.3, 24.3, 25.5],
  'smolvla-c3': [10, 16, 25.5, 28.3, 31.0],
}
const PLAN_T = [0, 1.85, 2.5, 4.5, 6.7]
const mapT = (k, vt) => {
  if (!k || vt <= k[0]) return 0
  for (let i = 1; i < k.length; i++) if (vt < k[i]) return PLAN_T[i - 1] + (PLAN_T[i] - PLAN_T[i - 1]) * (vt - k[i - 1]) / (k[i] - k[i - 1])
  return PLAN_T[PLAN_T.length - 1]
}
const RESULT = new THREE.Color(1.0, 0.79, 0.235) // --noodle (results' hit dots): every run here succeeded

export function createRuns({ stage, reels }) {
  const group = new THREE.Group()
  group.name = 'runs-screens'
  group.visible = false
  const bezelMat = new THREE.MeshStandardMaterial({ color: 0x0d0f11, roughness: 0.32, metalness: 0.15 })
  const faceMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.78, 0.84, 0.9) }) // the lit picture, for the mirror
  const poolMat = glowMaterial(new THREE.Color(0.62, 0.68, 0.76), [0.5, 0.0], [4.4, 3.0]) // from the screen's foot toward the camera
  const bezelGeo = new THREE.BoxGeometry(W + 0.006, H + 0.006, 0.006)
  const faceGeo = new THREE.PlaneGeometry(W - 0.002, H - 0.002)
  const footGeo = new THREE.BoxGeometry(W * 0.7, FOOT + 0.003, 0.03)
  const poolGeo = new THREE.PlaneGeometry(0.2, 0.16).rotateX(-Math.PI / 2).translate(0, 0.0007, 0.08)
  // round 14: one result pool per filmed cell (B2 holds two runs: one pool), same glow program as the screen pools
  const cellGeo = new THREE.PlaneGeometry(0.075, 0.14).rotateX(-Math.PI / 2)
  const cellPools = {}
  for (const cell of new Set(reels.map((r) => r.dataset.cell))) {
    const mat = glowMaterial(RESULT, [0.5, 0.5], [2.3, 2.3])
    const m = new THREE.Mesh(cellGeo, mat)
    m.position.copy(cellCenter(cell)); m.position.y = 0.0009
    m.renderOrder = 1; m.userData.noAO = true
    group.add(m)
    cellPools[cell] = { m, mat, k: 0 }
  }

  let b2 = 0
  const screens = reels.map((reel, i) => {
    const cell = reel.dataset.cell
    const z = cell === 'B2' ? Z.B2[b2++ % 2] : Z[cell] ?? 0
    const g = new THREE.Group()
    g.position.set(X, 0, z)
    const bezel = new THREE.Mesh(bezelGeo, bezelMat); bezel.position.set(0, FOOT + H / 2, -0.0035)
    const face = new THREE.Mesh(faceGeo, faceMat); face.position.set(0, FOOT + H / 2, 0.0001)
    const foot = new THREE.Mesh(footGeo, bezelMat); foot.position.set(0, (FOOT + 0.003) / 2, -0.008)
    const pool = new THREE.Mesh(poolGeo, poolMat); pool.renderOrder = 1; pool.userData.noAO = true
    g.add(bezel, face, foot, pool)
    group.add(g)
    const video = reel.querySelector('video')
    // the clip's name from its poster (stable: video-guard drops and restores the src attribute)
    const key = (video?.getAttribute('poster') || '').replace(/^.*poster-/, '').replace(/\.(jpg|webp)$/, '')
    const policy = reel.querySelector('strong')?.textContent.trim() || ''
    return { reel, cell, g, el: reel, last: '', base: g.position.clone(), k: 0, video, sync: SYNC[key] || null, policy, i }
  })

  // focus: engaged reel > the one under the pointer / keyboard focus > the first reel (it autoplays while in view)
  let hover = -1
  screens.forEach((s) => {
    s.reel.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') hover = s.i })
    s.reel.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse' && hover === s.i) hover = -1 })
    s.reel.addEventListener('focusin', () => { hover = s.i })
    s.reel.addEventListener('focusout', () => { if (hover === s.i) hover = -1 })
  })
  const focusIdx = () => {
    const e = screens.findIndex((s) => s.reel.classList.contains('is-engaged'))
    return e >= 0 ? e : hover >= 0 ? hover : 0
  }

  const _v = new THREE.Vector3(), _c = new THREE.Vector3()
  const proj = (v, cam, out) => { _v.copy(v).project(cam); out.x = (_v.x * 0.5 + 0.5) * innerWidth; out.y = (-_v.y * 0.5 + 0.5) * innerHeight; out.ok = _v.z < 1 && _v.z > -1; return out }
  const P = [{}, {}, {}, {}], foot2d = screens.map(() => ({ x: 0, y: 0, ok: false })), cell2d = screens.map(() => ({ x: 0, y: 0, ok: false }))
  let on = false, fi = 0
  const F = { cell: null, t: 0, idx: 0, policy: '' }

  return {
    group,
    foot2d, cell2d,
    get on() { return on },
    /** the screen in focus (index) this frame */
    get focusIdx() { return fi },
    /** round 14: { cell, t (s on the IK pick's timeline), idx, policy } for the screen in focus, every layout. */
    focus() {
      const s = screens[focusIdx()]
      if (!s) return null
      const v = s.video, has = !!v && !!v.getAttribute('src') && v.readyState >= 1 && !v.ended
      F.cell = s.cell; F.idx = s.i; F.policy = s.policy
      F.t = has ? mapT(s.sync, v.currentTime) : 0 // poster / unloaded / ended: the arm waits at the start of its pick
      return F
    },
    /** a = scene 08's layer opacity; live = desktop layout (phones keep the strip); dt for the focus ease. Once per frame. */
    update(a, camera, live, dt = 1 / 60) {
      const vis = live && a > 0.005
      group.visible = vis
      on = live
      fi = focusIdx()
      if (!vis) return
      const ease = 1 - Math.exp(-dt / 0.12) // ~0.35 s to settle
      poolMat.uniforms.uA.value = 0.5 * a
      faceMat.color.setRGB(0.78 * a, 0.84 * a, 0.9 * a)
      for (const c in cellPools) cellPools[c].want = 0.28
      for (let i = 0; i < screens.length; i++) {
        const s = screens[i]
        s.k += ((i === fi ? 1 : 0) - s.k) * ease
        if (i === fi) cellPools[s.cell].want = 1
        // toward the camera along the table (yaw only), and a little larger
        _c.set(camera.position.x - s.base.x, 0, camera.position.z - s.base.z).normalize().multiplyScalar(FWD * s.k)
        s.g.position.copy(s.base).add(_c)
        s.g.scale.setScalar(1 + GROW * s.k)
        s.g.rotation.y = Math.atan2(camera.position.x - s.g.position.x, camera.position.z - s.g.position.z)
        s.g.updateMatrixWorld(true)
        // the picture's corners -> its screen rectangle
        let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9, ok = true
        for (let k = 0; k < 4; k++) {
          _c.set((k & 1 ? 0.5 : -0.5) * W, FOOT + (k & 2 ? H : 0), 0).applyMatrix4(s.g.matrixWorld)
          const p = proj(_c, camera, P[k]); ok = ok && p.ok
          x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y)
        }
        const t = ok ? `translate(${x0.toFixed(1)}px, ${y0.toFixed(1)}px) scale(${((x1 - x0) / BASE_W).toFixed(4)})` : 'translate(-9999px, 0)'
        if (t !== s.last) { s.last = t; s.el.style.transform = t }
        if ((i === fi) !== s.foc) { s.foc = i === fi; s.el.classList.toggle('is-runfocus', s.foc) } // CSS: lit frame, on top
        proj(_c.set(0, 0.001, 0.012).applyMatrix4(s.g.matrixWorld), camera, foot2d[i])
        proj(cellCenter(s.cell, _c), camera, cell2d[i])
      }
      for (const c in cellPools) { const p = cellPools[c]; p.k += (p.want - p.k) * ease; p.mat.uniforms.uA.value = 0.55 * p.k * a }
    },
    /** Desktop layout off (phones, the document): drop the per-frame transforms. */
    reset() { for (const s of screens) { s.el.style.transform = ''; s.el.classList.remove('is-runfocus'); s.foc = false; s.last = '' } group.visible = false; on = false },
  }
}
