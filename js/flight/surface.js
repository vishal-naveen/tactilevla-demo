// Flight M1.5 surfaces: PC-made detail on the island and the STS3215 housings (KTX2, UASTC, linear data).
// - island_nrm(_2k).ktx2: authored height field over the core (0.75 x 1.2 m, 0.29 mm/px at 4K) -> world-planar normal
//   (R = world x, G = world z, B = up) + A = wear (0.5 neutral; > 0.5 scuffed: lighter + polished, < 0.5 smudged: duller).
// - island_light.ktx2: Cycles bake (top-down; the page's own lights + env cube + the ring as a real emitter; arm, cup and
//   noodles excluded): RGB = sqrt(E / K), the island's whole diffuse irradiance in three units; A = AO (6 cm). Planar over
//   LIGHT_RECT. Live uses only A (ambient/IBL occlusion: the stepped blocks, the core's skirt, the ring stand); the RGB
//   irradiance is shipped for the next iteration (using it as the island's whole diffuse made F1 darker than Cycles).
// - servo_nrm.ktx2: box-projected atlas in the servo's own mesh frame (moulded seams, label recess + embossed STS3215,
//   case screws, connector sockets): RG = face normal, B = cavity (0.5 neutral), A = label/gloss mask.
// Placeholders are bound first and the KTX2 textures swap in when ready: sampler uniforms only, no recompiles.
// ?off=m15 keeps the patched programs and zeroes every effect (same program count; the M1 look, for A/B stills).
import * as THREE from 'three'
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js'
import { farTexture, FAR } from './world_far.js'

const BASE = new URL('../../assets/flight/', import.meta.url).href
export const NRM_RECT = new THREE.Vector4(-0.22, -0.52, 0.75, 1.2) // x0, z0, sx, sz (the core)
export const LIGHT_RECT = new THREE.Vector4(-0.88, -1.18, 2.0, 2.52)
const LIGHT_K = 4.711 // irradiance scale of island_light (three units); written by compose.py, keep in sync

const OFFS = new URLSearchParams(location.search).get('off')?.split(',') || []
const off = OFFS.includes('m15')
const offWorld = OFFS.includes('world')
const px = (r, g, b, a) => { const t = new THREE.DataTexture(new Uint8Array([r, g, b, a]), 1, 1); t.needsUpdate = true; return t }

export const U = {
  uSfN: { value: px(128, 128, 255, 128) }, uSfL: { value: px(0, 255, 255, 255) }, uSvA: { value: px(128, 128, 255, 0) },
  uSfNRect: { value: NRM_RECT }, uSfLRect: { value: LIGHT_RECT }, uSfK: { value: LIGHT_K },
  uSfOn: { value: 0 }, uSfLm: { value: 0 }, uSvOn: { value: 0 },
  uSfGloss: { value: OFFS.includes('mirror') ? 0 : 1 }, // round 6: the dark resin top (glossier, a shade darker); ?off=mirror = before
  uSfPool: { value: OFFS.includes('bakepool') ? 0 : 1 }, // round 11: the baked irradiance shapes the live direct light (ISL_F_AO)
}

/** Start loading (after the stage exists). Phone: the 2K normal set. */
export function loadSurfaces(renderer, { phone = false } = {}) {
  const loader = new KTX2Loader().setTranscoderPath(new URL('../../vendor/three/examples/jsm/libs/basis/', import.meta.url).href).detectSupport(renderer)
  const get = (name, uni, on) => loader.loadAsync(BASE + name).then((t) => {
    t.colorSpace = THREE.NoColorSpace
    t.wrapS = t.wrapT = THREE.RepeatWrapping
    t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter
    t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy())
    renderer.initTexture(t) // upload now, not on the first frame that samples it (a 4K upload mid-scroll hitched 84-133 ms)
    U[uni].value = t
    if (!off) U[on].value = 1
    return t
  })
  return Promise.allSettled([ // one missing file must not stop the others (dispose waits for all)
    get(phone ? 'island_nrm_2k.ktx2' : 'island_nrm.ktx2', 'uSfN', 'uSfOn'),
    get('island_light.ktx2', 'uSfL', 'uSfLm'),
    get('world_servo_nrm.ktx2', 'uSvA', 'uSvOn'), // round 6: lettering turned to read left to right in the arm (servo_nrm.ktx2 = round 5)
    // round 6: the distant world's panorama (world_far.js); ?off=world skips the download
    offWorld ? Promise.resolve() : loader.loadAsync(BASE + FAR.file).then((t) => { farTexture(t); renderer.initTexture(t); return t }),
  ]).then((r) => { loader.dispose(); r.forEach((x) => x.status === 'rejected' && console.warn('flight surface', x.reason?.message)); return r })
}

// ---------------------------------------------------------------------------------------------------- island chunks
export const ISL_V_DECL = /* glsl */ `varying vec3 vSfN; varying vec2 vSfC; varying vec2 vSfS;`
export const ISL_V_MAIN = /* glsl */ `
  { vec3 wn = objectNormal; vSfC = vec2(-9.0); vSfS = vec2(0.0);
  #ifdef USE_INSTANCING
    wn = mat3(instanceMatrix) * wn; vSfC = instanceMatrix[3].xz;
    vSfS = 0.5 * vec2(length(instanceMatrix[0].xyz), length(instanceMatrix[2].xyz)); // terrain cells: unit box x scale
  #endif
    vSfN = normalize(mat3(modelMatrix) * wn); }`
export const ISL_F_DECL = /* glsl */ `
  varying vec3 vSfN; varying vec2 vSfC; varying vec2 vSfS;
  uniform sampler2D uSfN; uniform sampler2D uSfL; uniform vec4 uSfNRect; uniform vec4 uSfLRect; uniform float uSfK;
  uniform float uSfOn; uniform float uSfLm; uniform vec2 uSfHalf; uniform float uSfGloss; uniform float uSfPool;
  vec4 sfN; vec4 sfL; float sfTop; vec2 sfBev;`
// sample once, right after the albedo: wear lifts the dark plastic (scuffs read lighter), marks darken it
export const ISL_F_COLOR = /* glsl */ `
  {
    sfTop = smoothstep(0.85, 0.97, vSfN.y);
    vec2 nuv = vec2((vFlW.z - uSfNRect.y) / uSfNRect.w, (vFlW.x - uSfNRect.x) / uSfNRect.z);
    sfBev = vec2(0.0);
    if (vSfC.x > -8.0) { // edge block: a block-sized patch from inside the core (no core bevel), + its own 2 mm bevel
      vec2 h = fract(sin(vec2(dot(vSfC, vec2(127.1, 311.7)), dot(vSfC, vec2(269.5, 183.3)))) * 43758.5453);
      vec2 lc = vFlW.xz - vSfC; // local (x, z) from the block centre
      nuv = vec2(0.08 + 0.78 * h.y + lc.y / uSfNRect.w, 0.08 + 0.78 * h.x + lc.x / uSfNRect.z);
      vec2 hf = vFlT > 0.5 ? vSfS : uSfHalf; // round 6 terrain cells carry their own size (bevel scales with it)
      vec2 e = hf - abs(lc); // distance to the block's edges
      vec2 b = clamp(1.0 - e / (0.0022 * max(1.0, hf.x / 0.03)), 0.0, 1.0);
      sfBev = sign(lc) * b * b * 1.6;
    }
    sfN = texture2D(uSfN, nuv);
    sfL = texture2D(uSfL, vec2((vFlW.x - uSfLRect.x) / uSfLRect.z, (vFlW.z - uSfLRect.y) / uSfLRect.w));
    float w = (sfN.a - 0.5) * 2.0 * uSfOn * sfTop;
    diffuseColor.rgb *= (1.0 + max(w, 0.0) * 0.9) * (1.0 - 0.18 * uSfGloss * sfTop);
  }`
export const ISL_F_ROUGH = /* glsl */ `
  { float w = (sfN.a - 0.5) * 2.0 * uSfOn * sfTop;
    roughnessFactor = clamp(roughnessFactor * (1.0 - 0.45 * max(w, 0.0) + 0.08 * max(-w, 0.0)), 0.06, 1.0);
    roughnessFactor *= 1.0 - 0.18 * uSfGloss * sfTop; } // round 6: dark resin, a touch glossier (the mirror in fx.js carries the rest) // smudges: barely duller (0.25 read as dirt blotches at F1)`
export const ISL_F_NORMAL = /* glsl */ `
  { vec3 nw = sfN.xyz * 2.0 - 1.0;
    vec3 Nw = normalize(vec3(nw.x + sfBev.x, nw.z, nw.y + sfBev.y));
    vec3 Nv = normalize((viewMatrix * vec4(Nw, 0.0)).xyz);
    normal = normalize(mix(normal, Nv, uSfOn * sfTop)); }`
export const ISL_F_AO = /* glsl */ `
  // AO only (ambient + IBL). Replacing the island's live diffuse with the baked RGB irradiance (+ the key's live shadow
  // factor) was tried 2026-10-30 and moved F1 FURTHER from the Cycles frame (right cells 2.3x -> 3.9x). That reference
  // over-lit the island at grazing angles (its pool model; fixed in flight_ref_pc.py, intro2): retry against the fixed one
  { float ao = mix(1.0, sfL.a, uSfLm);
    reflectedLight.indirectDiffuse *= ao; reflectedLight.indirectSpecular *= ao;
    // round 6 resin: the env cube is a bright ROOM (RoomEnvironment); a dark top in an open world must not mirror it (at
    // the dive's grazing angle it turned the floor milky). The screen-space mirror (fx.js) reflects what is really there.
    reflectedLight.indirectSpecular *= 1.0 - 0.6 * uSfGloss * sfTop;
    // round 11: the Cycles irradiance (RGB) finally used, as a SHAPE on the live direct light rather than a replacement (the
    // 2026-10-30 replacement darkened F1): its pools lift (the key under the arm, the ring's warm spill on the ring-side
    // cells), its falloff sinks, its warmth tints. Ratio to the core's mean E (0.68, measured from island_light.png),
    // steepened (^1.1) and clamped 0.65-1.45; the live shadows stay. uSfPool 0 (?off=bakepool) = round 10.
    vec3 sfE = sfL.rgb * sfL.rgb; float sfLu = dot(sfE, vec3(0.2126, 0.7152, 0.0722));
    vec3 sfR = clamp(pow(sfLu / 0.68, 1.1), 0.65, 1.45) * mix(vec3(1.0), sfE / max(sfLu, 1e-3), 0.5);
    vec2 sfQ = (vFlW.xz - uSfLRect.xy) / uSfLRect.zw; float sfIn = step(0.0, sfQ.x) * step(sfQ.x, 1.0) * step(0.0, sfQ.y) * step(sfQ.y, 1.0);
    reflectedLight.directDiffuse *= mix(vec3(1.0), sfR, uSfLm * uSfPool * step(0.02, sfL.a) * sfIn); }`

// ---------------------------------------------------------------------------------------------------- servo housing
const SV_V_DECL = /* glsl */ `varying vec3 vSvP; varying vec3 vSvN; varying vec3 vSvX; varying vec3 vSvY; varying vec3 vSvZ;`
const SV_V_MAIN = /* glsl */ `
  vSvP = position; vSvN = normal;
  vSvX = normalize(normalMatrix * vec3(1.0, 0.0, 0.0)); vSvY = normalize(normalMatrix * vec3(0.0, 1.0, 0.0)); vSvZ = normalize(normalMatrix * vec3(0.0, 0.0, 1.0));`
const SV_F_DECL = /* glsl */ `
  varying vec3 vSvP; varying vec3 vSvN; varying vec3 vSvX; varying vec3 vSvY; varying vec3 vSvZ;
  uniform sampler2D uSvA; uniform float uSvOn; uniform vec3 uSvMin; uniform vec3 uSvSize;
  vec4 svT; vec3 svU; vec3 svV; float svW;`
// atlas (2048 x 1024): A = +-y faces (u = x, v = z) at (0,0) 772x673; C = +-x (u = y, v = z) at (776,0) 422x673;
// B = +-z (u = x, v = y) at (1202,0) 772x422. Rows run top-down (v up = row 0 at the face's top). u mirrored per side so
// the moulded text reads from outside.
const SV_F_ROUGH = /* glsl */ `
  {
    vec3 q = clamp((vSvP - uSvMin) / uSvSize, 0.0, 1.0);
    // facet normal from the local position's screen derivatives: the STL's smoothed vertex normals lean diagonally at the
    // box corners, so a 2-triangle face never reads as one axis from vSvN
    vec3 fn = normalize(cross(dFdx(vSvP), dFdy(vSvP)));
    vec3 an = abs(fn); vec3 sd = sign(q - 0.5);
    vec2 a; vec2 o; vec2 s;
    if (an.y >= an.x && an.y >= an.z) {
      float sg = sd.y; a = vec2(sg > 0.0 ? 1.0 - q.x : q.x, q.z); o = vec2(0.0); s = vec2(772.0, 673.0);
      svU = vSvX * (sg > 0.0 ? -1.0 : 1.0); svV = vSvZ; svW = an.y;
    } else if (an.x >= an.z) {
      float sg = sd.x; a = vec2(sg > 0.0 ? q.y : 1.0 - q.y, q.z); o = vec2(776.0, 0.0); s = vec2(422.0, 673.0);
      svU = vSvY * (sg > 0.0 ? 1.0 : -1.0); svV = vSvZ; svW = an.x;
    } else {
      float sg = sd.z; a = vec2(q.x, sg > 0.0 ? q.y : 1.0 - q.y); o = vec2(1202.0, 0.0); s = vec2(772.0, 422.0);
      svU = vSvX; svV = vSvY * (sg > 0.0 ? 1.0 : -1.0); svW = an.z;
    }
    vec2 px = o + vec2(a.x, 1.0 - a.y) * s;
    svT = texture2D(uSvA, px / vec2(2048.0, 1024.0));
    svW = smoothstep(0.82, 0.95, svW) * uSvOn;
    // round 6: calmer: the label panel only a little glossier (was x0.5) and the case never mirror-like (its ribs and
    // lettering edges glinted hot in the F3 macro)
    roughnessFactor = max(mix(roughnessFactor, roughnessFactor * 0.85, svT.a * svW), mix(roughnessFactor, 0.55, svW));
    diffuseColor.rgb *= 1.0 + 1.2 * svT.a * svW; // the label panel reads a shade lighter than the black case
  }`
const SV_F_NORMAL = /* glsl */ `
  { vec2 t = svT.xy * 2.0 - 1.0; float tz = sqrt(max(0.0, 1.0 - dot(t, t)));
    vec3 nd = normalize(svU * t.x + svV * t.y + normal * tz);
    normal = normalize(mix(normal, nd, svW)); }`
const SV_F_AO = /* glsl */ `
  { float cv = mix(1.0, svT.b * 2.0, svW); // 0.5-biased cavity: recesses darken, raised lettering and rims catch light
    reflectedLight.indirectDiffuse *= cv; reflectedLight.indirectSpecular *= min(cv, 1.0); reflectedLight.directDiffuse *= cv; }`

/** Patch a servo material (call before the stage's precompile re-runs). Keeps its existing onBeforeCompile chain. */
export function patchServo(mat, bbox) {
  if (mat.userData.flServo) return
  mat.userData.flServo = true
  const prev = mat.onBeforeCompile
  const size = bbox.getSize(new THREE.Vector3())
  mat.onBeforeCompile = (sh, r) => {
    prev?.call(mat, sh, r)
    if (sh.vertexShader.includes('vSvP')) return // a dissolve clone whose callback already ran its own material's patch
    Object.assign(sh.uniforms, { uSvA: U.uSvA, uSvOn: U.uSvOn, uSvMin: { value: bbox.min.clone() }, uSvSize: { value: size } })
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\n' + SV_V_DECL)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + SV_V_MAIN)
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\n' + SV_F_DECL)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n' + SV_F_ROUGH)
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + SV_F_NORMAL)
      .replace('#include <aomap_fragment>', '#include <aomap_fragment>\n' + SV_F_AO)
  }
  const key = mat.customProgramCacheKey?.bind(mat)
  mat.customProgramCacheKey = () => (key ? key() : '') + '|flServo'
  mat.needsUpdate = true
}
