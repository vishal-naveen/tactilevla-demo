// Cyclorama, table lights, and the signature ring light.
import * as THREE from 'three'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { RING, FLOOR_Y, WALL_X, GRID_CENTER } from './layout.js'

const REVEAL_S = 1.4
const smooth = (t) => t * t * (3 - 2 * t)
const easeInOut2 = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2)
const WALL = 0x454d52
const WALL2 = 0x2a3134

function buildCyclorama() {
  const R = 2.0
  const xStart = WALL_X + R // where the floor starts curving
  const prof = []
  prof.push([6, FLOOR_Y])
  for (let i = 0; i <= 36; i++) {
    const a = (i / 36) * (Math.PI / 2)
    prof.push([xStart - R * Math.sin(a), FLOOR_Y + R * (1 - Math.cos(a))])
  }
  prof.push([WALL_X, FLOOR_Y + R + 6])
  const W = 30 // long enough that the extrusion end (its cove profile) is buried in fog
  const pos = []
  const idx = []
  prof.forEach(([x, y]) => { pos.push(x, y, -W, x, y, W) })
  for (let i = 0; i < prof.length - 1; i++) {
    const a = i * 2
    idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3)
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setIndex(idx)
  g.computeVertexNormals()
  const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: WALL, roughness: 0.92, metalness: 0, side: THREE.DoubleSide }))
  m.receiveShadow = true
  return m
}

const ringVert = /* glsl */ `
varying vec2 vUv; varying vec3 vN; varying vec3 vV;
void main(){
  vUv = uv;
  vec4 mv = modelViewMatrix * vec4(position,1.0);
  vN = normalize(normalMatrix * normal);
  vV = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`
const ringFrag = /* glsl */ `
uniform float uProg; uniform vec3 uColor; uniform vec3 uDimColor; uniform float uDim; uniform float uBright; uniform float uHead; uniform float uGain;
varying vec2 vUv; varying vec3 vN; varying vec3 vV;
void main(){
  float f = fract(0.25 - vUv.x);          // 0 at 12 o'clock, grows clockwise
  float lit = (1.0 - smoothstep(uProg - 0.004, uProg + 0.004, f)) * step(0.002, uProg);
  float head = exp(-pow((f - uProg) * 34.0, 2.0)) * step(0.002, uProg) * step(uProg, 0.998);
  float core = pow(clamp(dot(normalize(vN), normalize(vV)), 0.0, 1.0), 0.55);
  vec3 base = mix(uDimColor * uDim, uColor * uBright, lit) + uColor * head * uHead;
  vec3 c = base * (0.55 + 0.75 * core) * uGain;
  gl_FragColor = vec4(c, 1.0);
}`

export function createStudio(scene, { shadowSize = 2048 } = {}) {
  scene.background = new THREE.Color(WALL2)
  scene.fog = new THREE.FogExp2(WALL2, 0.1)

  const cyc = buildCyclorama()
  scene.add(cyc)

  // image-based reflections, kept quiet
  const pm = null
  const envHolder = { pm, tex: null }

  // ring light
  const ring = new THREE.Group()
  ring.position.copy(RING.pos)
  const geo = new THREE.TorusGeometry(RING.radius, RING.tube, 20, 320)
  const mat = new THREE.ShaderMaterial({
    vertexShader: ringVert, fragmentShader: ringFrag,
    uniforms: {
      uProg: { value: 0 }, uColor: { value: new THREE.Color(1.0, 0.85, 0.6) }, uDim: { value: 1.35 }, uDimColor: { value: new THREE.Color(1.0, 0.5, 0.2) },
      uBright: { value: 4.4 }, uHead: { value: 7 }, uGain: { value: 0 },
    },
    toneMapped: false,
  })
  const torus = new THREE.Mesh(geo, mat)
  torus.scale.z = 0.55
  ring.add(torus)
  // soft warm halo around the whole tube: the unlit part still reads as a glowing ring without feeding the bloom
  const haloMat = new THREE.ShaderMaterial({
    vertexShader: ringVert,
    fragmentShader: /* glsl */ `
      uniform vec3 uCol; uniform float uI; varying vec2 vUv; varying vec3 vN; varying vec3 vV;
      void main(){ float f = pow(clamp(dot(normalize(vN), normalize(vV)), 0.0, 1.0), 2.6); gl_FragColor = vec4(uCol * f * uI, 1.0); }`,
    uniforms: { uCol: { value: new THREE.Color(1.0, 0.52, 0.2) }, uI: { value: 0 } },
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
  })
  const halo = new THREE.Mesh(new THREE.TorusGeometry(RING.radius, RING.tube * 3.4, 16, 200), haloMat)
  halo.scale.z = 0.55
  halo.renderOrder = -3
  ring.add(halo)
  // dark housing behind the emitter + stand
  const housing = new THREE.Mesh(
    new THREE.TorusGeometry(RING.radius, RING.tube * 1.25, 12, 160),
    new THREE.MeshStandardMaterial({ color: 0x0c0d0e, roughness: 0.6 }),
  )
  housing.position.z = -0.011
  housing.scale.z = 0.5
  ring.add(housing)
  ring.lookAt(GRID_CENTER.x, 0.1, GRID_CENTER.z)
  scene.add(ring)
  const stand = new THREE.Mesh(
    new THREE.CylinderGeometry(0.0075, 0.0075, RING.pos.y - RING.radius, 10),
    new THREE.MeshStandardMaterial({ color: 0x0c0d0e, roughness: 0.5, metalness: 0.4 }),
  )
  stand.position.set(RING.pos.x, (RING.pos.y - RING.radius) / 2, RING.pos.z)
  scene.add(stand)

  // key light: from the ring towards the arm
  const target = new THREE.Object3D()
  target.position.set(0.16, 0.02, 0.02)
  scene.add(target)
  const key = new THREE.SpotLight(0xfff0dc, 1.7, 0, 0.55, 1.0, 1.7)
  key.position.copy(RING.pos).add(new THREE.Vector3(0.05, 0.32, 0.0))
  key.target = target
  key.castShadow = true
  key.shadow.mapSize.set(shadowSize, shadowSize)
  key.shadow.camera.near = 0.3
  key.shadow.camera.far = 3.2
  key.shadow.bias = -0.00035
  key.shadow.normalBias = 0.006
  key.shadow.radius = 7
  key.shadow.blurSamples = 16
  scene.add(key)

  // wash of the wall around the ring
  const wash = new THREE.PointLight(0xffe2bd, 1.1, 0, 2)
  wash.position.copy(RING.pos).add(new THREE.Vector3(-0.35, 0.4, 0.05))
  scene.add(wash)

  // soft frontal fill (no shadow), cool rim from behind-left
  const fill = new THREE.DirectionalLight(0xfff4e6, 0.34)
  fill.position.set(1.4, 0.9, 0.9)
  fill.target.position.set(0.2, 0.05, 0)
  scene.add(fill, fill.target)
  // narrow warm kick from the camera side so the arm reads ivory (only touches the arm + grid area)
  const kickTarget = new THREE.Object3D()
  kickTarget.position.set(0.12, 0.13, 0.0)
  scene.add(kickTarget)
  const kick = new THREE.SpotLight(0xfff0dd, 2.4, 0, 0.36, 1, 1.5)
  kick.position.set(1.05, 0.75, -0.55)
  kick.target = kickTarget
  scene.add(kick)

  // cool rim from behind-left: separates the arm's back edges from the wall (directional, so it never hot-spots the table)
  const rim = new THREE.DirectionalLight(0xb4c8f0, 0.85)
  rim.position.set(-0.6, 0.7, 0.9)
  rim.target.position.set(0.12, 0.15, 0)
  scene.add(rim, rim.target)

  // amber accent used by the "test" chapter to pool light on B2
  const amber = new THREE.PointLight(0xf08a24, 0, 0.7, 2)
  amber.position.set(0.2225, 0.16, 0)
  scene.add(amber)

  const ringState = { min: 0, target: 0, prog: null, gainBase: 0, revealed: false, reveal: null, flash: 0 }
  function applyRing() {
    const p = Math.max(ringState.prog ?? ringState.target, ringState.min)
    mat.uniforms.uProg.value = Math.max(0.03, p) // a sliver is always lit so the arc reads at 0%
    mat.uniforms.uGain.value = ringState.gainBase * (1 + ringState.flash)
    haloMat.uniforms.uI.value = 0.42 * ringState.gainBase * (1 + ringState.flash)
  }

  const dimTint = new THREE.Color()
  const dimTintLight = new THREE.Color()
  const themeK = { key: 1, wash: 1, fill: 1, rim: 1, env: 1 }
  const baseIntensity = { kick: kick.intensity, key: key.intensity, wash: wash.intensity, fill: fill.intensity, rim: rim.intensity }

  return {
    ring, key, wash, fill, rim, kick, amber, cyc, ringMat: mat, envHolder,
    /** Recolour the studio from tweened theme colours `c` (THREE.Color per key) and `light` (0 dark .. 1 light). */
    applyTheme(c, light) {
      cyc.material.color.copy(c.background)
      scene.background.copy(c.fog)
      scene.fog.color.copy(c.fog)
      mat.uniforms.uColor.value.copy(c.ring)
      // unlit ring: a deeper, warmer version of the lit colour (a powered-down softbox reads greyer on a light set)
      dimTint.set(1, 0.62, 0.34).lerp(dimTintLight.set(0.86, 0.8, 0.72), light)
      mat.uniforms.uDimColor.value.copy(c.ring).multiply(dimTint)
      mat.uniforms.uDim.value = 1.35 + (0.8 - 1.35) * light
      // on a light set the lit arc must stay a saturated colour (a 4x over-exposed arc would tone-map to white-on-white)
      mat.uniforms.uBright.value = 4.4 + (1.7 - 4.4) * light
      mat.uniforms.uHead.value = 7 + (2.4 - 7) * light
      haloMat.uniforms.uCol.value.copy(c.ring).multiply(dimTint)
      key.color.copy(c.key); kick.color.copy(c.key)
      fill.color.copy(c.fill); rim.color.copy(c.rim); wash.color.copy(c.ring)
      themeK.key = 1 + (0.62 - 1) * light
      themeK.wash = 1 + (0.4 - 1) * light
      themeK.fill = 1 + (0.9 - 1) * light
      themeK.rim = 1 + (0.5 - 1) * light
      scene.environmentIntensity = 0.4 + (0.32 - 0.4) * light
    },
    setEnvironment(renderer) {
      const pmrem = new THREE.PMREMGenerator(renderer)
      const tex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
      scene.environment = tex
      scene.environmentIntensity = 0.4
      envHolder.tex = tex
      pmrem.dispose()
    },
    /** Floor for the lit arc (0..1); the limits chapter lights the whole ring as the closing chord. */
    setRingMin(k) { if (k !== ringState.min) { ringState.min = k; if (!ringState.reveal) applyRing() } },
    setRingProgress(p) { ringState.target = THREE.MathUtils.clamp(Number(p) || 0, 0, 1); if (!ringState.reveal) applyRing() },
    /** Ignite the ring: progress sweeps 0 -> 1 -> current with a gain pulse. */
    reveal(instant = false) {
      if (ringState.revealed) return
      ringState.revealed = true
      if (instant) { ringState.gainBase = 1; applyRing(); return }
      ringState.reveal = { t: 0 }
    },
    get revealed() { return ringState.revealed },
    /** Brief overdrive (used by snapshot). 0..1 envelope handled by the caller. */
    setFlash(k) { ringState.flash = k; applyRing() },
    updateRing(dt) {
      const r = ringState.reveal
      if (!r) return
      r.t += dt
      const u = Math.min(1, r.t / REVEAL_S)
      const e = easeInOut2(u)
      // progress: 0 -> 1 in the first half, back to the page's value in the second
      ringState.prog = e < 0.5 ? e * 2 : 1 - (e - 0.5) * 2 * (1 - ringState.target)
      ringState.gainBase = u < 0.5 ? 1.6 * smooth(u / 0.5) : 1.6 - 0.6 * smooth((u - 0.5) / 0.5)
      if (u >= 1) { ringState.reveal = null; ringState.prog = null; ringState.gainBase = 1 }
      applyRing()
    },
    /** dim: 0..1 multiplier for scene lights (the "test" chapter). */
    setLightScale(s, amberI, kickMul = 1) {
      key.intensity = baseIntensity.key * s * themeK.key
      wash.intensity = baseIntensity.wash * s * themeK.wash
      fill.intensity = baseIntensity.fill * s * themeK.fill
      kick.intensity = baseIntensity.kick * s * kickMul * themeK.key
      rim.intensity = baseIntensity.rim * s * themeK.rim
      amber.intensity = amberI
    },
    dispose() {
      envHolder.tex?.dispose()
      key.shadow.map?.dispose()
    },
  }
}
