// Flight M1 greybox world: the bench as a floating island + the reachable workspace (a lifted contour volume since intro2).
// - Island core: the stage's own table material (cloned, opaque, its Cycles contact-AO bake kept via matching UVs).
// - Edge: instanced blocks on the 3x3 grid's own pitch (layout.js GRID: w + gap across, d + gap deep), stepped down and
//   dissolved into the background colour with distance. Both share one patched material => one program.
// - Build-in: everything outside a growing radius (quantised to the grid pitch) is discarded; a hot band rides the front.
// - Lattice: reachmap.js IK samples (top-down pick, 2 x 2.5 cm) as LineSegments2 + dots. Data, not decoration.
import * as THREE from 'three'
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js'
import { LineMaterial } from 'three/addons/lines/LineMaterial.js'
import { GRID, TABLE_Y, RING } from '../stage/layout.js'
import { reachSample } from '../stage/reachmap.js'
import { createFar, FAR_U, FAR } from './world_far.js'
import { createTerrainMaterial, SEAM_GLSL } from './world_terrain.js'
import { createMotes } from './world_motes.js'
const FAR_C0 = FAR.C0
import { U as SF, ISL_V_DECL, ISL_V_MAIN, ISL_F_DECL, ISL_F_COLOR, ISL_F_ROUGH, ISL_F_NORMAL, ISL_F_AO } from './surface.js'

const RAKE_FLOOR = 0.6
const OFF = new Set(new URLSearchParams(location.search).get('off')?.split(',') || [])
const P2 = !OFF.has('world2') // round 6 pass 2 (high-key distance, calm rimmed terrain); ?off=world2 = pass 1
export const PITCH_Z = GRID.w + GRID.gap // 0.126 m (across)
export const PITCH_X = GRID.d + GRID.gap // 0.061 m (deep)
// Core: the hero region of the real table (1.2 m across x 0.75 m deep), arm base at the origin near the back edge
const CORE = { x0: -0.22, x1: 0.53, z0: -0.52, z1: 0.68 }
const C = new THREE.Vector2((CORE.x0 + CORE.x1) / 2, (CORE.z0 + CORE.z1) / 2)

// reachmap.js constants (same recipe: rows = x from -0.10 step 0.02, columns = z from +0.40 step -0.025)
const RX0 = -0.10, RDX = 0.02, RZ0 = 0.40, RDZ = -0.025, RROWS = 28, RCOLS = 33

const PATCH_V = /* glsl */ `
  varying vec3 vFlW; varying float vFlH; varying float vFlT; uniform float uTime; uniform float uGrow; uniform vec2 uPitch; uniform vec2 uO; uniform float uRise; uniform float uTerrK;
  varying float vFlTop; // round 11: the cell's top height (world y) for the riser seams
`
// idle breathing (edge blocks only): +-3 mm on a slow per-block phase, 6-8 s periods. Applied after project_vertex too.
const PATCH_V_BEGIN = /* glsl */ `
  vFlH = 0.5; vFlT = 0.0;
  #ifdef USE_INSTANCING
  { vec2 ib = instanceMatrix[3].xz; float h = fract(sin(dot(ib, vec2(127.1, 311.7))) * 43758.5453);
    vFlH = h;
    // round 6 terrain cells (world.js terrain): a unit box scaled per instance (island blocks are pitch-sized, scale 1)
    vFlT = step(0.02, abs(length(instanceMatrix[0].xyz) - 1.0));
    float sy = mix(1.0, length(instanceMatrix[1].xyz), vFlT);
    transformed.y += (1.0 - vFlT) * 0.003 * sin(uTime * (0.8 + 0.25 * h) + h * 6.2831);
    // intro2 build-in: a block rises out of the dark from 7 cm below as the front reaches its cell (its own pace per block);
    // terrain cells use their own centre and a stretched front (uTerrK), so the world builds out with the island
    vec2 cell = mix((floor(ib / uPitch) + 0.5) * uPitch, ib, vFlT);
    float k = clamp((uGrow - length(cell - uO) * mix(1.0, uTerrK, vFlT)) / (0.05 + 0.05 * h), 0.0, 1.0); // settled inside the hot front
    transformed.y -= uRise * 0.07 * (1.0 - k * k * (3.0 - 2.0 * k)) / sy; }
  #endif`
const PATCH_V_MAIN = /* glsl */ `
  { vec4 fw = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
    fw = instanceMatrix * fw;
  #endif
    vFlW = (modelMatrix * fw).xyz;
    vFlTop = 99.0;
  #ifdef USE_INSTANCING
    // round 11: world y of this cell's top face (exact on its sides: linear in the box's local y); unit terrain boxes vs
    // the island's BH-tall blocks
    vFlTop = vFlW.y + ((vFlT > 0.5 ? 0.5 : ${(0.06 / 2).toFixed(3)}) - position.y) * mix(1.0, length(instanceMatrix[1].xyz), vFlT);
  #endif
  }`
const PATCH_F = /* glsl */ `
  varying vec3 vFlW; varying float vFlH; varying float vFlT; uniform float uTerrK; uniform float uW2; uniform vec3 uRakeDir; uniform float uRakeK; varying float vFlTop;
  uniform float uGrow; uniform float uBand; uniform vec3 uBg; uniform vec2 uC; uniform vec2 uFade; uniform vec2 uPitch;
  uniform vec2 uO; uniform vec2 uAniso; // build-in origin (arm base, or the ring stand for intro2) + metric
  uniform vec3 uBandP; // x: front width (m), y: front gain, z: warm afterglow behind the front (intro2)
  uniform float uAmbT; uniform float uSeamK; // round 11 seam glow (world_terrain.js SEAM_GLSL)`
// grow mask: the cell this fragment belongs to (grid pitch from the arm base) against the growing radius
const PATCH_F_MAIN = /* glsl */ `
  vec2 cell = mix((floor(vec2(vFlW.x, vFlW.z) / uPitch) + 0.5) * uPitch, vSfC, vFlT);
  float cd = length((cell - uO) * uAniso) * mix(1.0, uTerrK, vFlT);
  if (cd > uGrow) discard;
  float band = uBand * (1.0 - smoothstep(0.0, uBandP.x, uGrow - cd)) * (1.0 - 0.75 * vFlT);
  // block-top outline mask (derivatives taken in uniform control flow): ~1.5 px rims along each top's edges
  vec2 lcR = vFlW.xz - vSfC; vec2 epR = ((vFlT > 0.5 ? vSfS : uSfHalf) - abs(lcR)) / max(fwidth(lcR), vec2(1e-5));
  float isTop = (vSfC.x > -8.0 ? 1.0 : 0.0) * step(0.5, vSfN.y);
  float rk = isTop * (1.0 - smoothstep(0.6, 2.4, min(epR.x, epR.y)));
  // round 11: the riser's lip (a side face within ~1.5 px of its cell's top edge), for the seam glow seen from low angles
  float lipD = (vFlTop - vFlW.y) / max(fwidth(vFlW.y), 1e-5);
  float lip = (vSfC.x > -8.0 ? 1.0 : 0.0) * (1.0 - step(0.5, vSfN.y)) * (1.0 - smoothstep(0.6, 2.2, lipD));
  float glow = uBand * uBandP.z * exp(-(uGrow - cd) / 0.3);
  // round 8: the build front draws itself as thin hot rims on dark tops (then cools), not lit cream blocks; sides stay deep
  float edgeOnly = isTop > 0.5 ? 0.06 + 1.7 * rk : (vSfC.x > -8.0 ? 0.03 : 1.0);
  band *= mix(1.0, edgeOnly, uW2);
  glow *= mix(1.0, isTop > 0.5 ? 0.08 + 1.4 * rk : (vSfC.x > -8.0 ? 0.03 : 1.0), uW2);
  float rr = length((vFlW.xz - uC) * vec2(1.25, 0.8));
  float fade = (smoothstep(uFade.x, uFade.y, rr) + smoothstep(0.0, -0.075, vFlW.y - ${TABLE_Y.toFixed(3)} + 0.004) * 0.75) * (1.0 - vFlT);
  gl_FragColor.rgb *= (0.9 + 0.2 * vFlH) * (1.0 - mix(0.4, 0.62, uW2) * vFlT); // per-block tone (round 6 terrain: darker resin, deep blacks near), so the edge reads as cut cells, not a tiled floor
  if (uW2 > 0.0 && vSfC.x > -8.0) gl_FragColor.rgb *= 1.0 - 0.55 * (1.0 - smoothstep(0.3, 0.6, vSfN.y)); // pass 2: the blocks' sides go deep (the rake drew lit cream faces); the light rides the rims below
  if (uW2 > 0.0 && isTop > 0.5) { // pass 2: thin lit rims on the block tops' outlines (see world_terrain.js)
    vec2 lc = lcR; vec2 ep = epR;
    vec2 ne = ep.x < ep.y ? vec2(sign(lc.x), 0.0) : vec2(0.0, sign(lc.y));
    float face = 0.25 + 0.75 * max(dot(ne, normalize(uRakeDir.xz + 1e-5)), 0.0);
    vec3 vd = normalize(cameraPosition - vFlW); // near cells only, never at grazing angles (edge-on tops drew dashes)
    float nk = (1.0 - smoothstep(1.2, 3.5, length(cameraPosition - vFlW))) * smoothstep(0.12, 0.35, dot(vSfN, vd));
    gl_FragColor.rgb += vec3(1.0, 0.8, 0.6) * (1.0 - smoothstep(0.6, 2.2, min(ep.x, ep.y))) * face * nk * (0.03 + 0.22 * uRakeK);
  }
  if (uSeamK > 0.0 && vSfC.x > -8.0) gl_FragColor.rgb += seamGlow(vFlW, vSfC, vSfN, max(rk, lip)); // round 11: glowing seams (world_terrain.js SEAM_GLSL)
  gl_FragColor.rgb = mix(gl_FragColor.rgb, uBg, clamp(fade, 0.0, 1.0));
  gl_FragColor.rgb += (vec3(1.0, 0.76, 0.5) * band * uBandP.y + vec3(1.0, 0.62, 0.32) * glow) * (1.0 - clamp(fade, 0.0, 1.0));`

// M1.5: + the PC surfaces (surface.js): planar normal/wear, Cycles irradiance + AO + marks, block bevels
function patch(mat, U, prev) {
  mat.onBeforeCompile = (sh, r) => {
    prev?.(sh, r)
    Object.assign(sh.uniforms, U, SF)
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>' + PATCH_V + ISL_V_DECL)
      .replace('#include <begin_vertex>', '#include <begin_vertex>' + PATCH_V_BEGIN)
      .replace('#include <fog_vertex>', '#include <fog_vertex>' + PATCH_V_MAIN + ISL_V_MAIN)
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>' + PATCH_F + ISL_F_DECL + SEAM_GLSL)
      .replace('#include <color_fragment>', '#include <color_fragment>' + ISL_F_COLOR)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>' + ISL_F_ROUGH)
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>' + ISL_F_NORMAL)
      .replace('#include <aomap_fragment>', '#include <aomap_fragment>' + ISL_F_AO)
      .replace('#include <dithering_fragment>', PATCH_F_MAIN + '\n#include <dithering_fragment>')
  }
  const key = mat.customProgramCacheKey?.bind(mat)
  mat.customProgramCacheKey = () => (key ? key() : '') + '|flightIsland'
}

/**
 * @param {THREE.Mesh} table the stage's light-pool table (its material carries the baked contact AO)
 * @param {THREE.Color} bg the scene background colour (shared reference: follows the theme)
 */
export function createWorld(table, bg, getRake) {
  const group = new THREE.Group()
  group.name = 'flight-world'
  const U = {
    uTime: { value: 0 }, uGrow: { value: 9 }, uBand: { value: 0 }, uBg: { value: bg }, uC: { value: C.clone() },
    uO: { value: new THREE.Vector2() }, uAniso: { value: new THREE.Vector2(1, 0.62) }, uRise: { value: 0 }, uBandP: { value: new THREE.Vector3(0.045, 1.1, 0) }, // M1 build-in: arm base, 0.62, no rise
    uFade: { value: new THREE.Vector2(0.44, 0.98) }, uPitch: { value: new THREE.Vector2(PITCH_X, PITCH_Z) },
    uSfHalf: { value: new THREE.Vector2((PITCH_X - 0.0022) / 2, (PITCH_Z - 0.0022) / 2) }, // block half size (bevel)
    uW2: { value: P2 ? 1 : 0 },
    uRakeDir: { value: new THREE.Vector3(-0.5, 0.2, 0.8).normalize() }, uRakeK: { value: 0 }, // shared with world_terrain.js
    // round 7 ambient clock (s): advanced while the far world / motes render (onBeforeRender below), frozen under reduced
    // motion; uAmb 0 (?off=ambient) stills every ambient motion with the same programs
    uAmbT: { value: 0 }, uAmb: { value: OFF.has('ambient') ? 0 : 1 },
    uTerrK: { value: 0.36 }, // round 6 terrain: its build front runs 1 / 0.36 x as far (GROW_MAX 2.7 m -> 7.5 m)
    uSeamK: { value: OFF.has('seamglow') ? 0 : 1 }, // round 11 seam glow 0..1 (world.uniforms.uSeamK: a per-stop scale a director could ease)
  }
  const WORLD = !OFF.has('world')
  const TU = { uRakeDir: U.uRakeDir, uRakeK: U.uRakeK } // the terrain shader's rake (same uniform objects)
  if (WORLD) U.uFade.value.set(9, 10) // the island no longer dissolves into the void: it continues into the terrain

  // --- core top: same material as the stage table, opaque, UVs matching the disc so the AO bake lines up ---
  const src = table.material
  const topMat = src.clone()
  topMat.alphaMap = null; topMat.transparent = false; topMat.depthWrite = true
  patch(topMat, U, src.onBeforeCompile)
  const W = CORE.x1 - CORE.x0, D = CORE.z1 - CORE.z0
  const topGeo = new THREE.PlaneGeometry(W, D, 1, 1).rotateX(-Math.PI / 2)
  topGeo.translate(C.x, 0, C.y)
  const R = table.geometry.parameters.radius, tp = table.position
  const pos = topGeo.attributes.position, uv = topGeo.attributes.uv
  for (let i = 0; i < pos.count; i++) { // disc local (x, y) = (X - tp.x, -(Z - tp.z)); CircleGeometry uv = (local / R + 1) / 2
    uv.setXY(i, ((pos.getX(i) - tp.x) / R + 1) / 2, (-(pos.getZ(i) - tp.z) / R + 1) / 2)
  }
  const top = new THREE.Mesh(topGeo, topMat)
  top.position.y = TABLE_Y - 0.0015
  top.renderOrder = -2
  top.userData.aoReceiver = true
  // Cycles reference (render/flight_export.mjs): the same authored height as bump, planar over the core (x0, z0, sx, sz)
  top.userData.cycles = { bump: 'island_height.png', planar: [CORE.x0, CORE.z0, W, D], bumpDepth: 0.00414 }
  group.add(top)

  // --- edge blocks (and the core's skirt) on the grid pitch ---
  const blockMat = new THREE.MeshStandardMaterial({ color: src.color.clone().multiplyScalar(0.8).lerp(new THREE.Color(0x6b5a48), 0.25), roughness: 0.8, metalness: 0 })
  patch(blockMat, U)
  const cells = []
  const ring = (x, z) => { // distance (in pitches) outside the core, Chebyshev-ish
    const dx = Math.max(CORE.x0 - x, 0, x - CORE.x1) / PITCH_X, dz = Math.max(CORE.z0 - z, 0, z - CORE.z1) / PITCH_Z
    return Math.max(dx, dz)
  }
  const hash = (a, b) => { const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return s - Math.floor(s) }
  const standX = RING.pos.x, standZ = RING.pos.z
  for (let i = Math.floor((CORE.x0 - 0.62) / PITCH_X); i <= Math.ceil((CORE.x1 + 0.55) / PITCH_X); i++) {
    for (let j = Math.floor((CORE.z0 - 0.62) / PITCH_Z); j <= Math.ceil((CORE.z1 + 0.62) / PITCH_Z); j++) {
      const x = (i + 0.5) * PITCH_X, z = (j + 0.5) * PITCH_Z
      const inCore = x > CORE.x0 && x < CORE.x1 && z > CORE.z0 && z < CORE.z1
      if (inCore) continue
      const r = ring(x, z) + hash(i, j) * 1.3
      if (r > 5.2) continue
      const nearStand = Math.hypot(x - standX, z - standZ) < 0.16
      const step = nearStand ? 0 : Math.min(5, Math.floor(r * 0.9 + hash(j, i) * 0.8)) // 0..5 steps of 12 mm
      cells.push({ x, z, sink: step * 0.012, i, j })
    }
  }
  const BH = 0.06 // block height (their tops are what you see)
  const gap = 0.0022
  const blocks = new THREE.InstancedMesh(new THREE.BoxGeometry(PITCH_X - gap, BH, PITCH_Z - gap), blockMat, cells.length)
  const m4 = new THREE.Matrix4()
  cells.forEach((c, k) => { c.y0 = TABLE_Y - 0.0016 - BH / 2 - c.sink; m4.makeTranslation(c.x, c.y0, c.z); blocks.setMatrixAt(k, m4) })
  blocks.instanceMatrix.needsUpdate = true
  blocks.frustumCulled = false
  group.add(blocks)
  // core skirt: the table's thickness under its edge (same block material)
  const skirt = new THREE.Mesh(new THREE.BoxGeometry(W, 0.03, D), blockMat)
  skirt.position.set(C.x, TABLE_Y - 0.0016 - 0.015 - 0.0005, C.y)
  group.add(skirt)


  // --- round 6: the terrain the island belongs to (real geometry where the flight's travel shows parallax, ~0.3-6 m out;
  // the panorama beyond, world_far.js). Unit boxes on the grid pitch x k (k = 2 / 4 / 8 with distance, nested so they never
  // overlap), stepped tops at about the island's level: low cells sink into the live mist (fx.js), terraced mesas rise out
  // of it behind the ring and to the sides. Same material as the edge blocks => same program (vFlT tells them apart).
  let terrain = null, far = null, motes = null
  if (WORLD) {
    const occ = new Set(cells.map((c) => c.i + ',' + c.j))
    const coreCell = (i, j) => { const x = (i + 0.5) * PITCH_X, z = (j + 0.5) * PITCH_Z; return x > CORE.x0 && x < CORE.x1 && z > CORE.z0 && z < CORE.z1 }
    const taken = (i, j) => occ.has(i + ',' + j) || coreCell(i, j)
    const vn = (x, z, s) => { // value noise, smooth
      const xi = Math.floor(x), zi = Math.floor(z), fx = x - xi, fz = z - zi, u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz)
      const h2 = (a, b) => hash(a + s * 17.3, b - s * 9.1)
      return (h2(xi, zi) * (1 - u) + h2(xi + 1, zi) * u) * (1 - v) + (h2(xi, zi + 1) * (1 - u) + h2(xi + 1, zi + 1) * u) * v
    }
    const GA = Math.atan2(RING.pos.z - 0.12, RING.pos.x - 0.15) // bearing of the ring (and the horizon glow) from the island
    const heightAt = (x, z) => {
      const rn = ring(x, z), r = Math.hypot(x - C.x, z - C.y), th = Math.atan2(z - C.y, x - C.x)
      const far = Math.min(1, Math.max(0, (rn - 5) / 20))
      let h = -0.06 - 0.03 * far - 0.22 * far * Math.max(0, 0.5 - vn(x / 0.6, z / 0.9, 5)) * 2 // steps on past the edge; low ground sinks into the mist
      const n = 0.6 * vn(x / 0.9, z / 1.3, 1) + 0.4 * vn(x / 0.35, z / 0.5, 2)
      const da = Math.atan2(Math.sin(th - GA), Math.cos(th - GA))
      const behind = Math.exp(-((da / 1.25) ** 2)) // mesas mostly behind the ring and to its sides (what the flight looks at)
      const notch = P2 ? Math.exp(-((da / 0.6) ** 2)) : Math.exp(-((da / 0.22) ** 2)) * 0.85 // a low gap behind the ring: the horizon glow shows over it (pass 2: wide, so F1 and the halo see the band)
      const rise = Math.min(1, Math.max(0, (r - 1.5) / 2.0)) // nothing tall near the island
      const m = Math.max(0, (n - 0.42) / 0.3) * (0.35 + 0.65 * behind) * (1 - notch) * rise
      h += m * (P2 ? 0.1 + 0.16 * Math.min(1, Math.max(0, (r - 2.5) / 3)) : 0.18 + 0.3 * Math.min(1, Math.max(0, (r - 2.5) / 3)))
      const st = P2 ? (r < 2.5 ? 0.04 : 0.06) : (r < 2.5 ? 0.024 : 0.045) // terraces: quantised tops (pass 2: fewer, calmer steps)
      return Math.round(h / st) * st + (hash(x * 3.1, z * 7.7) - 0.5) * 0.006
    }
    const out = [] // [x, z, sx, sz, top]
    const RMAX = 6.5
    const place = (i0, j0, k) => { // a k x k block of base cells starting at (i0, j0)
      const x = (i0 + k / 2) * PITCH_X, z = (j0 + k / 2) * PITCH_Z
      if (Math.hypot(x - C.x, z - C.y) > RMAX) return
      let any = false, all = true
      for (let a = 0; a < k; a++) for (let b = 0; b < k; b++) { const t = taken(i0 + a, j0 + b); any = any || t; all = all && !t }
      const rn = ring(x, z)
      const want = P2 ? (rn < 14 ? 2 : rn < 30 ? 4 : 8) : (rn < 9 ? 1 : rn < 16 ? 2 : rn < 30 ? 4 : 8) // finer near the island, coarser out (pass 2: larger, calmer near cells; k = 1 only where the island's ragged edge forces it)
      if (all && k <= want) { out.push([x, z, k * PITCH_X, k * PITCH_Z, heightAt(x, z)]); return }
      if (k === 1) return // taken by the island
      const h = k / 2
      place(i0, j0, h); place(i0 + h, j0, h); place(i0, j0 + h, h); place(i0 + h, j0 + h, h)
    }
    const K = 8
    for (let i = Math.floor((C.x - RMAX) / PITCH_X / K) * K; i < (C.x + RMAX) / PITCH_X; i += K) {
      for (let j = Math.floor((C.y - RMAX) / PITCH_Z / K) * K; j < (C.y + RMAX) / PITCH_Z; j += K) place(i, j, K)
    }
    // Cost (RTX 3060, 1440x900 dsf 2): the full island material on every terrain cell (7 lights, two VSM shadows, the
    // surface maps) cost +1.4 ms at F1: the background is most of the frame. So only the first ring of cells (k = 1, next
    // to the island, where the arm's long shadow lands) wears the island's material; the rest wear a light terrain shader
    // (rake + ring glow + sky ambient + resin sheen, scene fog; no shadows). Both are sorted near-to-far from the flight
    // camera region (early depth rejects the hidden sides) and only as deep as their step down needs.
    const near = out.filter((c) => c[2] < PITCH_X * 1.5), farC = out.filter((c) => c[2] >= PITCH_X * 1.5)
    const byDist = (a, b) => Math.hypot(a[0] - FAR_C0.x, a[1] - FAR_C0.z) - Math.hypot(b[0] - FAR_C0.x, b[1] - FAR_C0.z)
    near.sort(byDist); farC.sort(byDist)
    const s3 = new THREE.Vector3(), p3 = new THREE.Vector3(), q0 = new THREE.Quaternion()
    const build = (list, mat) => {
      const im = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat, list.length)
      list.forEach(([x, z, sx, sz, top], k) => {
        const bot = top - 0.32 // deep enough for any neighbour's step (the mist hides the rest)
        s3.set(sx - gap * Math.sqrt(sx / PITCH_X), top - bot, sz - gap * Math.sqrt(sx / PITCH_X)); p3.set(x, (top + bot) / 2, z)
        im.setMatrixAt(k, m4.compose(p3, q0, s3))
      })
      im.instanceMatrix.needsUpdate = true
      im.frustumCulled = false
      return im
    }
    const tNear = build(near, blockMat)
    tNear.name = 'flight-terrain-near'
    const tFar = build(farC, createTerrainMaterial(U, blockMat.color, bg, TU, P2))
    tFar.name = 'flight-terrain'
    tFar.receiveShadow = false
    tFar.userData.noShadow = true
    terrain = new THREE.Group(); terrain.name = 'flight-terrain-group'; terrain.add(tNear, tFar)
    if (!OFF.has('terrain')) group.add(terrain)
    far = createFar(bg, U.uAmbT, U.uAmb)
    if (!OFF.has('far')) group.add(far)
    // the ambient clock ticks once per rendered frame (whichever world piece draws first)
    const RM = matchMedia('(prefers-reduced-motion: reduce)')
    let lastF = -1
    const tick = (r) => { const f = r.info.render.frame; if (f === lastF) return; lastF = f; if (!RM.matches && U.uAmb.value > 0) U.uAmbT.value = (performance.now() / 1000) % 3600 }
    far.onBeforeRender = tick
    if (!OFF.has('ambient')) { motes = createMotes(U.uAmbT); motes.points.onBeforeRender = (r) => { tick(r); motes.material.uniforms.uK.value = FAR_U.uFarA.value }; group.add(motes.points) } // motes dawn with the far world (in the opening's void they read as stars)
  }

  // --- reach: WHERE THE GRIPPER CAN GO (reachmap.js IK samples, top-down pick, 2 x 2.5 cm) as a lifted contour volume ---
  // The binary samples are smoothed (gaussian 3 cm) so the boundary is the envelope, not the sampling grid (no ragged
  // cell edge, no one-cell hole), then cut by marching squares at three levels: the outer ring on the table and two inset
  // rings stacked up to 6 cm, read as a soft terraced volume around the arm. A faint curtain rises off the outer ring.
  // Thin warm lines; drawn on by a sweep around the arm base, shown only on a beat (intro.js), never a permanent carpet.
  const SIG = 0.03, FX0 = -0.2, FX1 = 0.56, FZ0 = -0.48, FZ1 = 0.48, FS = 0.006
  const nx = Math.round((FX1 - FX0) / FS) + 1, nz = Math.round((FZ1 - FZ0) / FS) + 1
  const pts = []
  for (let r = 0; r < RROWS; r++) for (let c = 0; c < RCOLS; c++) pts.push([RX0 + r * RDX, RZ0 + c * RDZ, reachSample(RX0 + r * RDX, RZ0 + c * RDZ) ? 1 : 0])
  const F = new Float32Array(nx * nz)
  for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
    const x = FX0 + i * FS, z = FZ0 + j * FS
    let a = 0, w = 0
    for (const q of pts) { const dx = q[0] - x, dz = q[1] - z, d2 = dx * dx + dz * dz; if (d2 > 9 * SIG * SIG) continue; const g = Math.exp(-d2 / (2 * SIG * SIG)); a += g * q[2]; w += g }
    F[i * nz + j] = w > 0 ? a / w : 0
  }
  const LEVELS = [[0.5, 0.0025]] // (stacked inset rings read as squiggles from F1's low angle: one rim + area + curtain) // [field level, height]
  const seg = [], segA = [] // segments + their bearing around the arm base (draw-on order)
  const base = [] // outer-ring segments for the curtain
  for (const [lv, yh] of LEVELS) {
    for (let i = 0; i < nx - 1; i++) for (let j = 0; j < nz - 1; j++) {
      const v = [F[i * nz + j], F[(i + 1) * nz + j], F[(i + 1) * nz + j + 1], F[i * nz + j + 1]]
      const P = [[i, j], [i + 1, j], [i + 1, j + 1], [i, j + 1]]
      const cut = []
      for (let e = 0; e < 4; e++) {
        const a = v[e], b = v[(e + 1) % 4]
        if ((a >= lv) !== (b >= lv)) { const t = (lv - a) / (b - a), pa = P[e], pb = P[(e + 1) % 4]; cut.push([FX0 + (pa[0] + (pb[0] - pa[0]) * t) * FS, FZ0 + (pa[1] + (pb[1] - pa[1]) * t) * FS]) }
      }
      for (let k = 0; k + 1 < cut.length; k += 2) {
        const [a, b] = [cut[k], cut[k + 1]]
        seg.push([a[0], TABLE_Y + yh, a[1], b[0], TABLE_Y + yh, b[1]])
        segA.push(Math.atan2((a[1] + b[1]) / 2, (a[0] + b[0]) / 2) + yh * 4) // higher rings trail the sweep a little
        if (lv === 0.5) base.push([a, b])
      }
    }
  }
  const ord = seg.map((_, k) => k).sort((a, b) => segA[a] - segA[b])
  const lgeo = new LineSegmentsGeometry().setPositions(ord.flatMap((k) => seg[k]))
  const lmat = new LineMaterial({ color: 0xffe9cf, linewidth: 1.0, transparent: true, opacity: 0, depthWrite: false, worldUnits: false, blending: THREE.AdditiveBlending })
  const lattice = new LineSegments2(lgeo, lmat)
  lattice.userData.noAO = true
  lattice.frustumCulled = false
  lattice.renderOrder = 2
  group.add(lattice)
  // curtain: one quad per outer-ring segment, 6 cm tall, additive, fading upward; drawn on by the same sweep (uniform)
  const cP = [], cA = []
  const A0 = Math.min(...segA), A1 = Math.max(...segA)
  for (const [a, b] of base) {
    const an = (Math.atan2((a[1] + b[1]) / 2, (a[0] + b[0]) / 2) - A0) / (A1 - A0)
    const q = [[a, 0], [b, 0], [b, 1], [a, 0], [b, 1], [a, 1]]
    for (const [pt, v] of q) { cP.push(pt[0], TABLE_Y + 0.002 + v * 0.06, pt[1]); cA.push(v, an) }
  }
  const cgeo = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(cP, 3)).setAttribute('va', new THREE.Float32BufferAttribute(cA, 2))
  const cmat = new THREE.ShaderMaterial({
    vertexShader: /* glsl */ `attribute vec2 va; varying vec2 vA; void main(){ vA = va; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `uniform float uA; uniform float uSweep; uniform vec3 uCol; varying vec2 vA;
      void main(){ float s = smoothstep(uSweep, uSweep - 0.06, vA.y); float h = (1.0 - vA.x); gl_FragColor = vec4(uCol * h * h * h * uA * s * 0.16, 1.0); }`,
    uniforms: { uA: { value: 0 }, uSweep: { value: 0 }, uCol: { value: new THREE.Color(1.0, 0.86, 0.66) } },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false,
  })
  const curtain = new THREE.Mesh(cgeo, cmat)
  curtain.userData.noAO = true
  curtain.frustumCulled = false
  curtain.renderOrder = 2
  group.add(curtain)
  // area: the smoothed field itself on a plane, a faint warm tint inside the rim (so it reads as a zone, not a line drawing)
  const fd = new Uint8Array(nx * nz)
  for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) fd[j * nx + i] = Math.round(F[i * nz + j] * 255)
  const ftex = new THREE.DataTexture(fd, nx, nz, THREE.RedFormat)
  ftex.magFilter = ftex.minFilter = THREE.LinearFilter; ftex.needsUpdate = true
  const amat = new THREE.ShaderMaterial({
    vertexShader: /* glsl */ `varying vec2 vUv; varying vec2 vW; void main(){ vUv = uv; vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: /* glsl */ `uniform sampler2D tF; uniform float uA; uniform float uSweep; uniform vec2 uAng; uniform vec3 uCol; varying vec2 vUv; varying vec2 vW;
      void main(){
        float f = texture2D(tF, vUv).r;
        float inside = smoothstep(0.47, 0.6, f);
        float an = (atan(vW.y, vW.x) - uAng.x) / (uAng.y - uAng.x);
        float s = smoothstep(uSweep, uSweep - 0.08, an);
        float rim = exp(-pow((f - 0.5) / 0.05, 2.0)); // a soft glow hugging the rim line
        gl_FragColor = vec4(uCol * (inside * 0.05 + rim * 0.07) * uA * s, 1.0);
      }`,
    uniforms: { tF: { value: ftex }, uA: { value: 0 }, uSweep: { value: 0 }, uAng: { value: new THREE.Vector2(A0, A1) }, uCol: { value: new THREE.Color(1.0, 0.82, 0.58) } },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
  })
  // PlaneGeometry uv (0,0) = its min corner: x along u, z along v after the rotation below
  const area = new THREE.Mesh(new THREE.PlaneGeometry(FX1 - FX0, FZ1 - FZ0).rotateX(Math.PI / 2), amat)
  { const uv = area.geometry.attributes.uv, ps = area.geometry.attributes.position
    for (let k = 0; k < ps.count; k++) uv.setXY(k, (ps.getX(k) + (FX1 - FX0) / 2) / (FX1 - FX0), (ps.getZ(k) + (FZ1 - FZ0) / 2) / (FZ1 - FZ0)) }
  area.position.set((FX0 + FX1) / 2, TABLE_Y + 0.0012, (FZ0 + FZ1) / 2)
  area.userData.noAO = true; area.frustumCulled = false; area.renderOrder = 2
  group.add(area)
  const nSeg = seg.length
  // the label's anchor: the outer ring's point farthest along +x (in front of the arm, toward the camera side)
  let anchor = [0.3, TABLE_Y + 0.004, 0]
  for (const [a] of base) if (a[0] - Math.abs(a[1]) * 0.6 > anchor[0] - Math.abs(anchor[2]) * 0.6) anchor = [a[0], TABLE_Y + 0.004, a[1]]

  // --- rake: a low warm directional light from the ring's side (intro2 + F1), no shadow: stage.getRakeLight(), created with
  // the stage before its precompile, so no program is rebuilt for it; intensity 0 elsewhere (a uniform, never a recompile).
  const rake = getRake?.() || new THREE.DirectionalLight(0xffd9b0, 0) // the stage's dormant flight light (compiled at load)
  const RK = { az: 0, el: 0.16, k: 0 }

  // reach envelope radii at 4 bearings (for the HUD label): the farthest reachable sample along each bearing, in mm
  const envelope = {}
  for (const [name, deg] of [['0', 0], ['45', 45], ['-45', -45], ['90', 90]]) {
    let best = 0
    for (let d = 0; d < 0.6; d += 0.0025) { const a = THREE.MathUtils.degToRad(deg); if (reachSample(Math.cos(a) * d, Math.sin(a) * d)) best = d }
    envelope[name] = Math.round(best * 1000)
  }

  return {
    group, blocks, terrain, far, lattice, curtain, nSeg, envelope, uniforms: U, core: CORE, rake, reachAnchor: anchor,
    /** Rake light: az = bearing (rad, world xz, 0 = +x) the light comes FROM, el = elevation (rad), k = intensity. */
    setRake(az, el, k) {
      // round 6: a floor under the intro's rake (the world's low glow behind the ring keeps lighting the floor and throws the
      // arm's long shadow toward the camera all flight), dawning with the far world; ?off=world keeps the old curve
      if (WORLD && !OFF.has('rakefloor')) k = Math.max(k, RAKE_FLOOR * FAR_U.uFarA.value)
      // round 7: a cloud passing over the glow: the rake breathes +-18 % on a slow 14 s swell (light only: no shadow redraw)
      if (WORLD && U.uAmb.value > 0) k *= 1 + 0.18 * Math.sin(U.uAmbT.value * 0.4488) * Math.sin(U.uAmbT.value * 0.1309 + 1.0)
      if (az === RK.az && el === RK.el && k === RK.k) return
      RK.az = az; RK.el = el; RK.k = k
      const ce = Math.cos(el)
      rake.target.position.set(0.15, 0, 0.1)
      rake.position.set(0.15 + Math.cos(az) * ce * 3, Math.sin(el) * 3, 0.1 + Math.sin(az) * ce * 3)
      rake.intensity = k
      TU.uRakeDir.value.copy(rake.position).sub(rake.target.position).normalize(); TU.uRakeK.value = k
    },
    /** grow: island radius in m (9 = all), band 0..1 hot front; lat: lattice draw-on 0..1 and its opacity */
    set({ grow = 9, band = 0, lat = 1, latAlpha = 0.35 } = {}) {
      U.uGrow.value = grow; U.uBand.value = band
      // the far world dawns as the build front runs out (intro2: GROW_MAX 2.7 m; M1: 1.6 m), then holds
      FAR_U.uFarA.value = grow >= 8 ? 1 : Math.min(1, Math.max(0, (grow - 1.2) / 1.5)) ** 2
      lgeo.instanceCount = Math.max(0, Math.round(nSeg * Math.min(1, lat)))
      lmat.opacity = latAlpha
      cmat.uniforms.uA.value = latAlpha; cmat.uniforms.uSweep.value = lat * 1.08
      amat.uniforms.uA.value = latAlpha; amat.uniforms.uSweep.value = lat * 1.1
      lattice.visible = curtain.visible = area.visible = latAlpha > 0.003
    },
    setResolution(w, h, dpr) { lmat.resolution.set(w * dpr, h * dpr); lmat.linewidth = 1.0 * dpr; if (motes) motes.material.uniforms.uHalfH.value = h * dpr / 2 },
  }
}
