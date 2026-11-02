// The look foundation (Stage A): one warm pool of key light on the table falling off into a dark room, a faint beam of that
// light in the air (haze), and the text keep-out shared by every glow (ring, dust, bloom, rays). All uniform-driven: each
// part is compiled at load and switched by value (?off=pool,haze,keep), never by a define.
import * as THREE from 'three'
import { FLOOR_Y } from './layout.js'
import { isStacked, textColumnRight, stackedSceneBottom } from './framing.js'

// Shared by the ring, its halo, the dust and the merged post pass: x 0 = text on the left (fade along x) / 1 = text below
// (fade along y, uv y up); y edge, z feather (uv); w how much light is left over the text (1 = keep-out off).
export const KEEP = { uKeep: { value: new THREE.Vector4(0, 0, 0.1, 1) }, uRes: { value: new THREE.Vector2(1, 1) } }
export const KEEP_GLSL = /* glsl */ `
uniform vec4 uKeep; uniform vec2 uRes;
float keepOut() {
  vec2 q = gl_FragCoord.xy / uRes;
  float a = uKeep.x > 0.5 ? q.y : q.x;
  return mix(uKeep.w, 1.0, smoothstep(uKeep.y - uKeep.z * 0.25, uKeep.y + uKeep.z, a));
}`

/** Keep-out from the page layout (framing.js): the column's right edge on wide screens, the panel top when stacked. */
export function updateKeep(w, h, dpr, on, floor = 0.3) {
  const k = KEEP.uKeep.value
  KEEP.uRes.value.set(w * dpr, h * dpr)
  if (!on) { k.set(0, 0, 0.1, 1); return k }
  if (isStacked(w, h)) k.set(1, 1 - stackedSceneBottom(w, h), 0.12, floor)
  else k.set(0, textColumnRight(w) / w, 0.1, floor)
  return k
}

// Pool: the table's light falls off with distance from the work area (no flat plane to the horizon), warm where the key
// lands, cool and dark at the rim. The cyclorama floor beyond goes the same way; its wall keeps the ring's wash.
const POOL = { uPool: { value: 0 }, uPoolC: { value: new THREE.Vector3(0.16, 0, 0.06) } }
function patchPool(m, kind) {
  const prev = m.onBeforeCompile
  const prevKey = m.customProgramCacheKey()
  m.onBeforeCompile = (sh, r) => {
    prev?.call(m, sh, r)
    sh.uniforms.uPool = POOL.uPool
    sh.uniforms.uPoolC = POOL.uPoolC
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vPoolW;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvPoolW = (modelMatrix * vec4(transformed, 1.0)).xyz;')
    const body = kind === 'table'
      ? `float pd = length((vPoolW.xz - uPoolC.xz) * vec2(1.0, 0.85));
         float pk = exp(-pd * pd / (2.0 * 0.26 * 0.26));
         // inside the pool the table reads as lit by the warm key alone (the cool fill and rim stay on the arm)
         float pl = dot(outgoingLight, vec3(0.2126, 0.7152, 0.0722));
         outgoingLight = mix(outgoingLight, pl * vec3(1.16, 1.0, 0.84), 0.75 * smoothstep(0.0, 0.6, pk) * uPool); // warm white, not tan
         vec3 pm = mix(vec3(0.04, 0.05, 0.08), vec3(0.92), pk);`
      // the cove of the cyclorama was a lit horizon band: the room now falls away to ink below the ring's height
      : `float fl = 1.0 - smoothstep(${(FLOOR_Y + 1.1).toFixed(3)}, ${(FLOOR_Y + 2.4).toFixed(3)}, vPoolW.y);
         vec3 pm = mix(vec3(0.62), vec3(0.13, 0.15, 0.21), fl);`
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vPoolW; uniform float uPool; uniform vec3 uPoolC;')
      .replace('#include <opaque_fragment>', `{ ${body}
          outgoingLight *= mix(vec3(1.0), pm, uPool); }
        #include <opaque_fragment>`)
  }
  m.customProgramCacheKey = () => 'pool|' + kind + '|' + prevKey
  m.needsUpdate = true
}

// Haze: the key light seen in the air, a soft additive cone (brightest along its axis, fading at its sides and with distance).
const BEAM_VERT = /* glsl */ `
varying vec3 vN; varying vec3 vV; varying float vL;
void main() {
  vL = -position.y; // the cone hangs from its apex at the origin down -y (0 .. 1)
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`
const BEAM_FRAG = /* glsl */ `
uniform vec3 uColor; uniform float uGain;
varying vec3 vN; varying vec3 vV; varying float vL;
${KEEP_GLSL}
void main() {
  float side = pow(abs(dot(normalize(vN), normalize(vV))), 2.5); // seen through the middle of the cone: more air, more light
  float len = smoothstep(0.3, 0.62, vL) * (1.0 - smoothstep(0.75, 1.0, vL));
  gl_FragColor = vec4(uColor * (side * len * uGain * keepOut()), 1.0);
}`

/**
 * @param {THREE.Scene} scene
 * @param {{ studio: any, ground: any }} o
 */
export function createLook(scene, { studio, ground }) {
  const table = ground.group.getObjectByProperty('name', 'table')
  patchPool(table.material, 'table')
  patchPool(studio.cyc.material, 'cyc')

  const key = studio.key
  const L = 1.55
  const geo = new THREE.ConeGeometry(Math.tan(key.angle * 0.62) * L, L, 48, 1, true).translate(0, -L / 2, 0).scale(1 / L, 1 / L, 1 / L)
  const beamMat = new THREE.ShaderMaterial({
    vertexShader: BEAM_VERT, fragmentShader: BEAM_FRAG,
    uniforms: { uColor: { value: new THREE.Color() }, uGain: { value: 0 }, ...KEEP },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false,
  })
  const beam = new THREE.Mesh(geo, beamMat)
  beam.scale.setScalar(L)
  beam.userData.noAO = true
  beam.renderOrder = 2
  beam.frustumCulled = false
  scene.add(beam)
  const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _q = new THREE.Quaternion(), DOWN = new THREE.Vector3(0, -1, 0)

  return {
    beam,
    /** Round 11 (flight only): move the key pool's centre (world x, z). The default page never calls it (fixed at the arm). */
    setPoolCenter(x, z) { POOL.uPoolC.value.x = x; POOL.uPoolC.value.z = z },
    poolCenter: POOL.uPoolC.value,
    /** pool, haze: 0..1 strengths for this frame (the theme's light set turns both down). */
    update({ pool, haze }) {
      POOL.uPool.value = pool
      key.getWorldPosition(_a); key.target.getWorldPosition(_b)
      beam.position.copy(_a)
      beam.quaternion.copy(_q.setFromUnitVectors(DOWN, _b.sub(_a).normalize()))
      beamMat.uniforms.uColor.value.copy(key.color).multiplyScalar(key.intensity / 1.7)
      beamMat.uniforms.uGain.value = haze
      beam.visible = haze > 0.001
    },
  }
}
