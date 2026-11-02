// Igloo-grade effects on the existing stage:
//  - assembly ("lit into being", once, on reveal): a thin wireframe of the arm draws on from the base up, light pours off the
//    ring as particles that fly onto the arm's surface (they ride the links, so they land wherever the arm is), and the arm
//    resolves into solid plastic from the base up behind a hot edge, like a print;
//  - dust: motes drifting through the room, lit only where they cross the key light's cone.
// The ring's light shafts live in fx.js (RaysMarch, merged into the final pass). Everything here is built and compiled at
// load and driven by uniforms; the intro wears CLONED arm materials (with the dissolve's discard) and hands the arm back its
// own, discard-free ones when it ends, so the costliest shader on the page never stays alpha-tested.
import * as THREE from 'three'
import { KEEP, KEEP_GLSL } from './look.js'

const isPart = (o) => o.isMesh && /\.stl$/i.test(o.userData.file || '')
const smooth = (t) => t * t * (3 - 2 * t)
const clamp01 = (t) => Math.min(1, Math.max(0, t))

// Intro timeline (s after reveal): wire draws on 0.1-1.3; particles leave the ring 0.25-1.6 and land within 0.65 s;
// dissolve 0.9-2.5; wire fades 1.7-2.6; particles fade 2.2-3.0.
export const ASSEMBLE_S = 3.0
// Flight round 6 ('fine', set by js/flight/intro.js at import, before createStage): Igloo #15-style print. ~5x more,
// far finer motes (sub-pixel to ~2 px) bud off the ring's tube into a slow disc of light inside it, then drain base-first
// down one pinched stream into the arm; brightness follows each mote's own speed (moving = warm-white hot, settled = ivory),
// and the solid resolves up through the settled cloud. Positions AND speed come from the vertex shader (time uniform); the
// JS side only copies 8 link matrices per frame. The default page keeps 'v1' (same programs, same look).
let STYLE = 'v1'
export function setAssemblyStyle(s) { STYLE = s }
const FINE_S = 3.1

// seeded PRNG (mulberry32): the same arm and the same flight every load, so snapshots diff cleanly
function rng(seed) {
  let a = seed >>> 0
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

// Point sprites sized in world units: projection + drawing-buffer height (tracks DPR, resize and the camera's animated FOV).
// Under 1.5 px a sprite keeps 1.5 px and fades by area instead of shimmering.
const POINT_SIZE = /* glsl */ `
uniform float uHalfH;
float pointPx(float worldSize, float viewZ, out float fade) {
  float px = worldSize * projectionMatrix[1][1] * uHalfH / max(1e-3, -viewZ);
  fade = min(1.0, (px * px) / (1.5 * 1.5));
  return max(px, 1.5);
}`

// ---------------------------------------------------------------------------------------------------------- assembly
/** Area-weighted surface samples in each link's frame: position + normal (link space), link index, seed. Typed arrays only. */
function sampleSurface(parts, links, count, rand) {
  const inv = new THREE.Matrix4(), rel = new THREE.Matrix4(), nm = new THREE.Matrix3()
  let nTri = 0
  for (const o of parts) { const g = o.geometry; nTri += (g.index ? g.index.count : g.attributes.position.count) / 3 }
  const cdf = new Float64Array(nTri), corner = new Float32Array(nTri * 9), triLink = new Uint8Array(nTri)
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3()
  let t = 0, total = 0
  for (const o of parts) {
    let link = o.parent; while (link && !link.isURDFLink) link = link.parent
    const li = links.indexOf(link)
    inv.copy(link.matrixWorld).invert(); rel.multiplyMatrices(inv, o.matrixWorld)
    const pos = o.geometry.attributes.position, idx = o.geometry.index
    const n = idx ? idx.count : pos.count
    for (let i = 0; i < n; i += 3, t++) {
      a.fromBufferAttribute(pos, idx ? idx.getX(i) : i).applyMatrix4(rel)
      b.fromBufferAttribute(pos, idx ? idx.getX(i + 1) : i + 1).applyMatrix4(rel)
      c.fromBufferAttribute(pos, idx ? idx.getX(i + 2) : i + 2).applyMatrix4(rel)
      total += e1.subVectors(b, a).cross(e2.subVectors(c, a)).length() / 2
      cdf[t] = total; triLink[t] = li
      a.toArray(corner, t * 9); b.toArray(corner, t * 9 + 3); c.toArray(corner, t * 9 + 6)
    }
  }
  const pos = new Float32Array(count * 3), nrm = new Float32Array(count * 3), link = new Float32Array(count), seed = new Float32Array(count * 4)
  const ys = new Float32Array(count)
  let hiY = -Infinity, loY = Infinity
  for (let k = 0; k < count; k++) {
    const r = rand() * total
    let lo = 0, hi = nTri - 1
    while (lo < hi) { const m = (lo + hi) >> 1; if (cdf[m] < r) lo = m + 1; else hi = m }
    const q = lo * 9
    let u = rand(), v = rand(); if (u + v > 1) { u = 1 - u; v = 1 - v }
    for (let j = 0; j < 3; j++) pos[k * 3 + j] = corner[q + j] + (corner[q + 3 + j] - corner[q + j]) * u + (corner[q + 6 + j] - corner[q + j]) * v
    a.fromArray(corner, q); b.fromArray(corner, q + 3); c.fromArray(corner, q + 6)
    e1.subVectors(b, a).cross(e2.subVectors(c, a)).normalize().toArray(nrm, k * 3)
    link[k] = triLink[lo]
    a.fromArray(pos, k * 3).applyMatrix4(links[triLink[lo]].matrixWorld)
    ys[k] = a.y; hiY = Math.max(hiY, a.y); loY = Math.min(loY, a.y)
    seed[k * 4] = rand(); seed[k * 4 + 1] = rand(); seed[k * 4 + 2] = rand(); seed[k * 4 + 3] = rand()
  }
  // arrival order: base first, then up the arm, with jitter (seed.w)
  for (let k = 0; k < count; k++) seed[k * 4 + 3] = 0.78 * (ys[k] - loY) / Math.max(1e-3, hiY - loY) + 0.22 * seed[k * 4 + 3]
  return { pos, nrm, link, seed }
}

const ASM_VERT = /* glsl */ `
uniform mat4 uLink[8]; uniform vec3 uFrom; uniform vec3 uFromAxis; uniform float uFromR; uniform float uT; uniform float uSize;
attribute vec3 nrm; attribute float link; attribute vec4 seed;
varying float vA; varying float vHot;
${POINT_SIZE}
void main() {
  mat4 L = uLink[int(link + 0.5)];
  vec3 target = (L * vec4(position + nrm * 0.0012, 1.0)).xyz; // a hair off the surface: no z-fight once the arm is solid
  // leave the ring's tube at a random angle
  float ang = seed.x * 6.2831853;
  vec3 ax = normalize(uFromAxis), t1 = normalize(cross(ax, vec3(0.0, 1.0, 0.0))), t2 = cross(ax, t1);
  vec3 start = uFrom + (t1 * cos(ang) + t2 * sin(ang)) * uFromR * (0.96 + 0.08 * seed.y);
  float t0 = 0.25 + seed.w * 1.35;
  float p = clamp((uT - t0) / 0.65, 0.0, 1.0);
  float e = p * p * (3.0 - 2.0 * p);
  // a lifted arc from the ring to the arm, plus a curl that settles to zero on arrival
  vec3 mid = mix(start, target, 0.45) + vec3(0.0, 0.06 + 0.12 * seed.z, 0.0);
  vec3 pos = mix(mix(start, mid, e), mix(mid, target, e), e);
  pos += vec3(sin(seed.y * 40.0 + uT * 6.0), cos(seed.z * 37.0 + uT * 5.0), sin(seed.x * 31.0 + uT * 7.0)) * 0.012 * (1.0 - e) * e;
  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mv;
  float fade;
  gl_PointSize = pointPx(uSize, mv.z, fade);
  float landed = uT - t0 - 0.65;
  vHot = exp(-max(landed, 0.0) * 9.0) * step(0.0, landed); // a brief flash where it lands, then it is plastic
  vA = fade * step(0.001, p) * smoothstep(0.0, 0.15, p) * (1.0 - smoothstep(0.0, 0.35, landed)) * (1.0 - smoothstep(2.4, 3.0, uT));
}`
const ASM_FRAG = /* glsl */ `
uniform vec3 uColor; uniform float uGain; varying float vA; varying float vHot;
void main() {
  vec2 d = gl_PointCoord - 0.5; float r = dot(d, d);
  if (r > 0.25) discard;
  float soft = 1.0 - smoothstep(0.0, 0.25, r);
  // peak ~1.3 HDR per particle: only the hot leading ones and real overlaps cross the bloom threshold (no white blob)
  gl_FragColor = vec4(mix(uColor, vec3(1.0, 0.95, 0.85), vHot * 0.5) * (0.7 + 0.7 * vHot) * soft * vA * uGain, 1.0);
}`

const FINE_VERT = /* glsl */ `
uniform mat4 uLink[8]; uniform vec3 uFrom; uniform vec3 uFromAxis; uniform float uFromR; uniform float uT; uniform float uSize;
uniform vec3 uMid; uniform float uDis; uniform vec3 uHot; uniform vec3 uIvory; uniform vec3 uRingC;
attribute vec3 nrm; attribute float link; attribute vec4 seed;
varying vec3 vC;
uniform float uHalfH;
vec3 gTarget; vec3 gT1; vec3 gT2; vec3 gAx;
float sstep(float x) { x = clamp(x, 0.0, 1.0); return x * x * x * (x * (6.0 * x - 15.0) + 10.0); }
// the ring's light: each mote buds off the tube at its own moment and is drawn inward into a slowly turning disc
vec3 cloud(float t) {
  float te = seed.x * 0.45;
  float e = sstep((t - te) / 0.6);
  float rr = 0.015 + 0.85 * pow(seed.y, 1.4); // denser toward the centre: a core, not a membrane (and no hole in it)
  float r = uFromR * mix(0.985, rr, e);
  float a = seed.z * 6.2831853 + max(t - te, 0.0) * (0.3 + 1.1 * (1.0 - seed.y)) * e;
  return uFrom + (gT1 * cos(a) + gT2 * sin(a)) * r + gAx * (seed.w - 0.5) * 0.16 * (1.0 - rr) * e; // lens-thick
}
float tDep() { return 0.3 + seed.w * 0.95; } // departure: base first (seed.w = arrival order)
vec3 P(float t) {
  float td = tDep();
  if (t <= td) return cloud(t);
  float D = 0.55 + 0.2 * fract(seed.x * 7.13);
  float e = sstep((t - td) / D);
  vec3 S = cloud(td);
  // half-pinched: each mote bends toward one shared stream point, so the light pours as one stream without a knot
  vec3 M = mix(mix(S, gTarget, 0.5), uMid, 0.55) + (vec3(fract(seed.y * 13.7), fract(seed.z * 5.3), fract(seed.x * 3.1)) - 0.5) * 0.05;
  vec3 q = mix(mix(S, M, e), mix(M, gTarget, e), e);
  q += vec3(sin(seed.y * 40.0 + t * 7.0), cos(seed.z * 37.0 + t * 6.0), sin(seed.x * 31.0 + t * 8.0)) * 0.008 * e * (1.0 - e);
  return q;
}
void main() {
  mat4 L = uLink[int(link + 0.5)];
  gTarget = (L * vec4(position + nrm * 0.0012, 1.0)).xyz;
  gAx = normalize(uFromAxis); gT1 = normalize(cross(gAx, vec3(0.0, 1.0, 0.0))); gT2 = cross(gAx, gT1);
  vec3 pos = P(uT);
  float speed = length(pos - P(uT - 1.0 / 60.0)) * 60.0; // m/s, this mote's own
  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mv;
  // sub-pixel to ~2 px: a world size, floored at one device pixel with the rest carried by alpha (area)
  float px = uSize * (0.45 + 0.9 * seed.y * seed.y) * projectionMatrix[1][1] * uHalfH / max(1e-3, -mv.z);
  gl_PointSize = max(px, 1.0);
  float area = min(1.0, px * px);
  float te = seed.x * 0.45;
  float born = smoothstep(te, te + 0.18, uT);
  float hot = smoothstep(0.15, 1.1, speed);
  float inCloud = 1.0 - step(tDep(), uT);
  // settled = ivory; drifting in the ring = its warm light (brighter at the core); moving = warm-white hot
  vec3 c = mix(mix(uIvory * 0.36, (uRingC * 0.6 + uIvory * 0.4) * (0.8 - 0.45 * seed.y), inCloud), uHot * 1.8, hot);
  // the solid resolves up through the settled cloud: a mote goes as the dissolve front (vfx DISSOLVE, same height map) passes it
  float h01 = clamp(gTarget.y / 0.42, 0.0, 1.0);
  float gone = smoothstep(0.0, 0.08, uDis * 1.25 - (h01 * 0.8 + 0.16)) * (1.0 - inCloud);
  vC = c * area * born * (1.0 - gone) * (1.0 - smoothstep(FINE_END - 0.25, FINE_END, uT));
}`.split('FINE_END').join(FINE_S.toFixed(2))
const FINE_FRAG = /* glsl */ `
uniform float uGain; varying vec3 vC;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  if (dot(d, d) > 0.25) discard;
  gl_FragColor = vec4(vC * uGain, 1.0);
}`

// wireframe: crease edges of every part, drawn on from the base up (world height), ring-coloured and thin
const WIRE_VERT = /* glsl */ `varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`
const WIRE_FRAG = /* glsl */ `
uniform vec3 uColor; uniform float uDraw; uniform float uA; varying vec3 vW;
void main() {
  float h = clamp(vW.y / 0.42, 0.0, 1.0);
  float d = uDraw * 1.15 - h;
  if (d < 0.0) discard;
  float front = 1.0 - smoothstep(0.0, 0.05, d); // the drawing tip glows a little
  gl_FragColor = vec4(uColor * (0.55 + 1.4 * front) * uA, 1.0);
}`

const DISSOLVE_PARS = /* glsl */ `
varying vec3 vVfxW; uniform float uDissolve; uniform vec3 uEdgeColor;
float vfxH(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float vfxN(vec3 x) { vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(vfxH(i), vfxH(i + vec3(1,0,0)), f.x), mix(vfxH(i + vec3(0,1,0)), vfxH(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(vfxH(i + vec3(0,0,1)), vfxH(i + vec3(1,0,1)), f.x), mix(vfxH(i + vec3(0,1,1)), vfxH(i + vec3(1,1,1)), f.x), f.y), f.z); }`

/**
 * @param {THREE.Scene} scene
 * @param {any} rig
 * @param {{ ring: THREE.Object3D, ringRadius: number, ringColor: THREE.Color, onLight?: (k: number) => void, table?: THREE.Mesh, count: number }} o
 */
export function createAssembly(scene, rig, { ring, ringRadius, ringColor, onLight, table, count }) {
  const parts = []
  rig.root.traverse((o) => { if (isPart(o)) parts.push(o) })
  rig.root.updateMatrixWorld(true)
  const links = []
  for (const o of parts) { let l = o.parent; while (l && !l.isURDFLink) l = l.parent; if (!links.includes(l)) links.push(l) }
  if (links.length > 8) throw new Error(`vfx: ${links.length} arm links, the particle shader holds 8`)

  const fine = STYLE === 'fine'
  const END = fine ? FINE_S : ASSEMBLE_S
  const N = fine ? count * 5 : count
  const { pos, nrm, link, seed } = sampleSurface(parts, links, N, rng(0x5101))
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3)) // link-local surface point (uLink places it)
  g.setAttribute('nrm', new THREE.BufferAttribute(nrm, 3))
  g.setAttribute('link', new THREE.BufferAttribute(link, 1))
  g.setAttribute('seed', new THREE.BufferAttribute(seed, 4))
  const uLink = Array.from({ length: 8 }, () => new THREE.Matrix4())
  const dissolve = { uDissolve: { value: 0 }, uEdgeColor: { value: ringColor.clone().multiplyScalar(5.0) } }
  const mat = new THREE.ShaderMaterial({
    vertexShader: fine ? FINE_VERT : ASM_VERT, fragmentShader: fine ? FINE_FRAG : ASM_FRAG,
    uniforms: {
      uLink: { value: uLink }, uFrom: { value: new THREE.Vector3() }, uFromAxis: { value: new THREE.Vector3(0, 0, 1) }, uFromR: { value: ringRadius },
      uT: { value: 0 }, uSize: { value: fine ? 0.0011 : 0.0017 }, uHalfH: { value: 500 }, uColor: { value: ringColor.clone() },
      uGain: { value: fine ? 1 : 1 / Math.sqrt(N / 16000) },
      ...(fine ? {
        uMid: { value: new THREE.Vector3() }, uDis: dissolve.uDissolve, uRingC: { value: ringColor.clone() },
        uHot: { value: new THREE.Color(1.0, 0.93, 0.82) }, uIvory: { value: new THREE.Color(0.93, 0.89, 0.8) },
      } : {}),
    },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
  })
  const pts = new THREE.Points(g, mat)
  pts.frustumCulled = false
  pts.visible = false
  pts.renderOrder = 3
  scene.add(pts)

  // wireframe children ride their part
  const wireMat = new THREE.ShaderMaterial({
    vertexShader: WIRE_VERT, fragmentShader: WIRE_FRAG,
    uniforms: { uColor: { value: fine ? new THREE.Color(0.55, 0.52, 0.47) : ringColor.clone() }, uDraw: { value: 0 }, uA: { value: 0 } },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
  })
  const wires = []
  const edgeCache = new Map()
  for (const o of parts) {
    let eg = edgeCache.get(o.geometry)
    if (!eg) { eg = new THREE.EdgesGeometry(o.geometry, 32); edgeCache.set(o.geometry, eg) }
    const w = new THREE.LineSegments(eg, wireMat)
    w.visible = false
    w.userData.noAO = true
    w.renderOrder = 3
    o.add(w)
    wires.push(w)
  }

  // the arm: cloned materials with the dissolve patch (discard + hot edge), worn only during the intro
  const clones = new Map()
  for (const o of parts) {
    const m = o.material
    if (clones.has(m)) continue
    const c = m.clone()
    c.onBeforeCompile = (sh, r) => {
      m.onBeforeCompile?.call(c, sh, r)
      sh.uniforms.uDissolve = dissolve.uDissolve
      sh.uniforms.uEdgeColor = dissolve.uEdgeColor
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vVfxW;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvVfxW = (modelMatrix * vec4(transformed, 1.0)).xyz;')
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\n' + DISSOLVE_PARS)
        .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
          // base first: height carries the sweep, noise breaks the line into a printed, slightly ragged front
          float vfxF = clamp(vVfxW.y / 0.42, 0.0, 1.0) * 0.8 + vfxN(vVfxW * 60.0) * 0.2;
          float vfxD = uDissolve * 1.25 - vfxF;
          if (vfxD < 0.0) discard;
          float vfxEdge = 1.0 - smoothstep(0.0, 0.035, vfxD);`)
        // after every material patch (servo heat, baked AO): the edge is added to the final colour, never scaled by them
        .replace('#include <opaque_fragment>', `outgoingLight = mix(outgoingLight, uEdgeColor, vfxEdge * vfxEdge);${fine ? `
          // round 11 (flight 'fine' only): the plastic leaves the seam warm and cools to ivory behind it, a glow that decays
          // with the distance the front has moved on (~0.2 s; 1.6 x / 0.14 blew the parts out to white blobs) and is gone by the time the dissolve completes (no pop at the
          // hand-back to the own materials)
          outgoingLight += vec3(1.0, 0.58, 0.28) * 0.5 * exp(-vfxD / 0.09) * (1.0 - vfxEdge) * (1.0 - smoothstep(0.8, 0.97, uDissolve));` : ''}
          #include <opaque_fragment>`)
    }
    const key = m.customProgramCacheKey()
    c.customProgramCacheKey = () => 'vfx|' + key
    clones.set(m, c)
  }
  const own = new Map(parts.map((o) => [o, o.material]))
  let wearing = false
  function wear(intro) {
    if (wearing === intro) return
    wearing = intro
    for (const o of parts) { o.material = intro ? clones.get(own.get(o)) : own.get(o); o.userData.noAO = intro }
  }

  const ringPos = new THREE.Vector3(), ringAxis = new THREE.Vector3(), _q = new THREE.Quaternion(), _mid = new THREE.Vector3()
  let t = -1 // < 0: idle
  // How built the arm is. The key light comes up with it (studio.setIntroLight, via the `light` callback), so the arm's
  // shadow and the table's baked contact arrive with the plastic instead of lying on an empty table.
  function setK(k, lightK = k) {
    dissolve.uDissolve.value = k
    if (table?.material.aoMap) table.material.aoMapIntensity = k
    onLight?.(lightK)
  }
  function finish() {
    t = -1; pts.visible = false; for (const w of wires) w.visible = false
    wear(false); setK(1)
  }
  return {
    get count() { return N },
    /** Hide the arm before the reveal (the loader covers the page until then). */
    arm() { wear(true); setK(0) },
    /** Precompile hook: wear the intro (true) or own (false) materials so both program sets are built at load. */
    wear,
    /** Start the intro; `instant` (reduced motion) just shows the arm. */
    play(instant = false) {
      if (instant) { finish(); return }
      t = 0
      pts.visible = true
      for (const w of wires) w.visible = true
    },
    setColor(c) {
      mat.uniforms.uColor.value.copy(c); mat.uniforms.uRingC?.value.copy(c)
      if (!fine) wireMat.uniforms.uColor.value.copy(c)
      dissolve.uEdgeColor.value.copy(c).multiplyScalar(5.0)
    },
    /** Drawing-buffer height in px (DPR included). */
    setViewport(hPx) { mat.uniforms.uHalfH.value = hPx / 2 },
    get playing() { return t >= 0 },
    update(dt) {
      if (t < 0) return
      t += dt
      for (let i = 0; i < links.length; i++) uLink[i].copy(links[i].matrixWorld)
      ring.getWorldPosition(ringPos)
      ringAxis.set(0, 0, 1).applyQuaternion(ring.getWorldQuaternion(_q))
      mat.uniforms.uFrom.value.copy(ringPos)
      mat.uniforms.uFromAxis.value.copy(ringAxis)
      mat.uniforms.uT.value = t
      if (fine) {
        // the stream pinches halfway between the ring's centre and the arm's middle, a little low
        links[0].getWorldPosition(_mid); _mid.y += 0.17
        mat.uniforms.uMid.value.lerpVectors(ringPos, _mid, 0.5).y -= 0.03
        // the CAD trace draws first (0-0.8 s), then gives way to the motes landing on it
        wireMat.uniforms.uDraw.value = smooth(clamp01((t - 0.02) / 0.8))
        wireMat.uniforms.uA.value = 0.75 * smooth(clamp01(t / 0.2)) * (1 - smooth(clamp01((t - 0.8) / 0.8)))
        // the solid follows the landings up the arm: each height holds as a settled point cloud ~0.4-0.8 s first
        setK(smooth(clamp01((t - 1.35) / 1.6)), smooth(clamp01((t - 0.5) / 2.3)))
      } else {
        wireMat.uniforms.uDraw.value = smooth(clamp01((t - 0.1) / 1.2))
        wireMat.uniforms.uA.value = smooth(clamp01((t - 0.05) / 0.3)) * (1 - smooth(clamp01((t - 1.7) / 0.9)))
        setK(smooth(clamp01((t - 0.9) / 1.6)), smooth(clamp01((t - 0.6) / 2.2)))
      }
      if (t >= END) finish()
    },
  }
}

// -------------------------------------------------------------------------------------------------------------- dust
const DUST_VERT = /* glsl */ `
uniform float uTime; uniform vec3 uLightPos; uniform vec3 uLightDir; uniform float uCosOuter; uniform float uCosInner; uniform float uFocus;
attribute vec4 seed; varying float vA;
${POINT_SIZE}
void main() {
  vec3 p = position; // world space: the points object sits unparented at the origin
  p += vec3(sin(uTime * 0.11 + seed.x * 40.0), sin(uTime * 0.07 + seed.y * 30.0) * 0.6 - 0.15 * fract(uTime * 0.004 + seed.z), cos(uTime * 0.09 + seed.z * 50.0)) * 0.05;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float c = dot(normalize(p - uLightPos), uLightDir);
  float lit = smoothstep(uCosOuter, uCosInner, c);
  float defocus = 1.0 + 2.2 * smoothstep(0.25, 1.4, abs(-mv.z - uFocus)); // off the focus plane: bigger and softer
  float fade;
  gl_PointSize = pointPx((0.0007 + 0.0016 * seed.w) * defocus, mv.z, fade);
  vA = fade * lit * (0.3 + 0.7 * seed.w) / (defocus * defocus);
  vA *= 0.55 + 0.45 * sin(uTime * (0.6 + seed.x) + seed.y * 20.0); // glints as motes turn
  // a sharp pinpoint high in the beam reads as a star on the dark wall: fade motes with height, and dim the smallest ones
  vA *= (1.0 - 0.92 * smoothstep(0.14, 0.34, p.y)) * mix(0.3, 1.0, smoothstep(1.5, 3.5, gl_PointSize));
}`
const DUST_FRAG = /* glsl */ `
uniform vec3 uColor; varying float vA;
${KEEP_GLSL}
void main() {
  vec2 d = gl_PointCoord - 0.5; float r = dot(d, d);
  if (r > 0.25) discard;
  gl_FragColor = vec4(uColor * vA * (1.0 - smoothstep(0.0, 0.25, r)) * keepOut(), 1.0);
}`

export function createDust(scene, light, count) {
  const N = count
  const rand = rng(0xd057)
  const pos = new Float32Array(N * 3), seed = new Float32Array(N * 4)
  for (let i = 0; i < N; i++) {
    pos[i * 3] = -0.45 + rand() * 1.1; pos[i * 3 + 1] = 0.02 + rand() * 0.5; pos[i * 3 + 2] = -0.4 + rand() * 1.2 // the air the beam falls through
    seed[i * 4] = rand(); seed[i * 4 + 1] = rand(); seed[i * 4 + 2] = rand(); seed[i * 4 + 3] = rand() ** 3
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setAttribute('seed', new THREE.BufferAttribute(seed, 4))
  const mat = new THREE.ShaderMaterial({
    vertexShader: DUST_VERT, fragmentShader: DUST_FRAG,
    uniforms: {
      uTime: { value: 0 }, uHalfH: { value: 500 }, uColor: { value: new THREE.Color() }, uFocus: { value: 1.2 },
      uLightPos: { value: new THREE.Vector3() }, uLightDir: { value: new THREE.Vector3(0, -1, 0) },
      uCosOuter: { value: Math.cos(0.55) }, uCosInner: { value: Math.cos(0.3) }, ...KEEP,
    },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
  })
  const pts = new THREE.Points(g, mat)
  pts.frustumCulled = false
  pts.userData.noAO = true
  pts.renderOrder = 2
  scene.add(pts)
  const tp = new THREE.Vector3()
  return {
    points: pts,
    setViewport(hPx) { mat.uniforms.uHalfH.value = hPx / 2 },
    /** gain 0 hides the motes; focus = camera distance that stays sharp. */
    update(time, gain, focus) {
      const u = mat.uniforms
      u.uTime.value = time
      u.uFocus.value = focus
      light.getWorldPosition(u.uLightPos.value)
      light.target.getWorldPosition(tp)
      u.uLightDir.value.subVectors(tp, u.uLightPos.value).normalize()
      u.uCosOuter.value = Math.cos(light.angle * 0.62) // the beam's core: motes outside it stay dark (no starfield)
      u.uCosInner.value = Math.cos(light.angle * 0.28)
      pts.visible = gain > 0.01
      u.uColor.value.copy(light.color).multiplyScalar(gain * light.intensity / 1.7)
    },
  }
}
