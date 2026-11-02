// Light rendered offline in Cycles (tactilevla-redesign/render/render_pc.py on the RTX 3060) and shipped as data, plus the
// material detail a real printed arm has:
//  - per-vertex ambient occlusion for every arm part (assets/so101/ao.bin: one byte per vertex, in the order the parts are met
//    walking rig.root, each link baked on its own so a servo sitting in its holder darkens the pocket around it) and the cup
//    (assets/props/cup_ao.bin);
//  - the table's static contact shading (assets/props/table_ao.png, 1024 px over the 5.2 m disc: 5 mm a texel, ~5 MB on a
//    phone GPU; baked at 2048 and downsampled), in the disc's UVs: arm base, cup, ring and stand,
//    replacing the painted blob shadows;
//  - an HDR probe of each theme's studio seen from the arm (assets/env/<theme>.hdr). The arm's and cup's REFLECTIONS come from
//    it (the ring light, the lit wall, the table), while diffuse fill stays the art-directed room light: the physical probe of
//    a navy studio would tint the ivory blue-grey;
//  - printed PLA: each part a slightly different ivory (separate prints, separate spool lots) and a faint mottle in colour and
//    gloss. Real 0.2 mm layer lines are sub-pixel at every camera on this page, so they are not drawn.
// All optional: the page renders as before until (and unless) the files load.
import * as THREE from 'three'
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js'

const url = (p) => new URL(`../../assets/${p}`, import.meta.url).href

// How much of the baked occlusion reaches each light term. Indirect light is what AO is; the direct share stands in for the
// soft key light the shadow map is too coarse to stop inside 1 cm pockets.
const AO_INDIRECT = 1.0
const AO_DIRECT = 0.45
const TABLE_AO_DIRECT = 0.7 // the table is mostly lit by the key spot: contact shading must reach it to read at all
// Probe radiance scale. 1 = as Cycles lit the studio (same units as the page's lights).
const PROBE_GAIN = 1.6

const isPart = (o) => o.isMesh && /\.stl$/i.test(o.userData.file || '')
const probe = { tProbe: { value: null }, uProbe: { value: 0 } } // shared by every patched material

const NOISE = /* glsl */ `
float bkHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float bkNoise(vec3 x) {
  vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(bkHash(i), bkHash(i + vec3(1,0,0)), f.x), mix(bkHash(i + vec3(0,1,0)), bkHash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(bkHash(i + vec3(0,0,1)), bkHash(i + vec3(1,0,1)), f.x), mix(bkHash(i + vec3(0,1,1)), bkHash(i + vec3(1,1,1)), f.x), f.y), f.z);
}`

/**
 * One shader patch for every baked feature. `ao`: per-vertex `bakedAO` attribute; `printed`: PLA tint + mottle (needs
 * `partTint`); `probe`: reflections from the studio probe; `aoMap`: the material's own aoMap also darkens direct light.
 */
function patchMaterial(m, { ao = false, printed = false, reflect = false, aoMapDirect = 0 } = {}) {
  if (m.userData.baked) return
  m.userData.baked = true
  const prev = m.onBeforeCompile
  const prevKey = m.customProgramCacheKey()
  m.onBeforeCompile = (sh, r) => {
    prev?.call(m, sh, r)
    let vs = sh.vertexShader, fs = sh.fragmentShader
    if (ao) {
      vs = vs.replace('#include <common>', '#include <common>\nattribute float bakedAO;\nvarying float vBakedAO;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBakedAO = bakedAO;')
      fs = fs.replace('#include <common>', '#include <common>\nvarying float vBakedAO;')
        .replace('#include <aomap_fragment>', `#include <aomap_fragment>
          float bakedOcc = vBakedAO * vBakedAO * (3.0 - 2.0 * vBakedAO); // the bake's linear ramp reads flat; ease it
          reflectedLight.indirectDiffuse *= mix(1.0, bakedOcc, ${AO_INDIRECT.toFixed(2)});
          reflectedLight.indirectSpecular *= mix(1.0, bakedOcc, ${AO_INDIRECT.toFixed(2)});
          reflectedLight.directDiffuse *= mix(1.0, bakedOcc, ${AO_DIRECT.toFixed(2)});
          reflectedLight.directSpecular *= mix(1.0, bakedOcc, ${AO_DIRECT.toFixed(2)});`)
    }
    if (aoMapDirect > 0) {
      fs = fs.replace('#include <aomap_fragment>', `#include <aomap_fragment>
        #ifdef USE_AOMAP
          reflectedLight.directDiffuse *= mix(1.0, ambientOcclusion, ${aoMapDirect.toFixed(2)});
        #endif`)
    }
    if (printed) {
      vs = vs.replace('#include <common>', '#include <common>\nattribute float partTint;\nvarying float vPartTint;\nvarying vec3 vPrint;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvPartTint = partTint;\nvPrint = position;')
      fs = fs.replace('#include <common>', `#include <common>\nvarying float vPartTint;\nvarying vec3 vPrint;\n${NOISE}`)
        .replace('#include <color_fragment>', `#include <color_fragment>
          // mottle at ~4 mm and ~1.2 mm, faded out where a cell gets smaller than a few pixels (no shimmer at a distance)
          vec3 pp = vPrint * 250.0;
          float fade = 1.0 - smoothstep(0.35, 0.9, length(fwidth(pp)));
          float mottle = ((bkNoise(pp) - 0.5) + 0.5 * (bkNoise(pp * 3.3) - 0.5)) * fade;
          float t = vPartTint * 2.0 - 1.0;
          diffuseColor.rgb *= vec3(1.0 + 0.035 * t, 1.0 + 0.012 * t, 1.0 - 0.03 * t) * (1.0 + 0.045 * mottle);`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
          roughnessFactor = clamp(roughnessFactor + 0.09 * mottle + 0.03 * t, 0.04, 1.0);`)
    }
    if (reflect) {
      sh.uniforms.tProbe = probe.tProbe
      sh.uniforms.uProbe = probe.uProbe
      fs = fs.replace('#include <common>', `#include <common>
          uniform sampler2D tProbe; uniform float uProbe;
          // GGX-ish blur from the probe's mip chain: alpha = roughness^2 widens the lobe; 1024 px equirect
          vec3 probeRadiance(vec3 viewDir, vec3 n, float rough) {
            vec3 r = inverseTransformDirection(reflect(-viewDir, n), viewMatrix);
            float a = rough * rough;
            return textureLod(tProbe, equirectUv(r), log2(1.0 + 160.0 * a)).rgb;
          }`)
        .replace('#include <lights_fragment_maps>', `#include <lights_fragment_maps>
          #if defined( RE_IndirectSpecular )
            if (uProbe > 0.0) {
              radiance = probeRadiance(geometryViewDir, geometryNormal, material.roughness) * uProbe;
              #ifdef USE_CLEARCOAT
                clearcoatRadiance = probeRadiance(geometryViewDir, geometryClearcoatNormal, material.clearcoatRoughness) * uProbe;
              #endif
            }
          #endif`)
    }
    sh.vertexShader = vs
    sh.fragmentShader = fs
  }
  const key = `baked${+ao}${+printed}${+reflect}${aoMapDirect}|`
  m.customProgramCacheKey = () => key + prevKey
  m.needsUpdate = true
}

async function fetchBytes(path) {
  try {
    const res = await fetch(url(path))
    return res.ok ? new Uint8Array(await res.arrayBuffer()) : null
  } catch { return null }
}

const hash01 = (i) => { const x = Math.sin(i * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x) }

/** Baked AO + printed detail + probe reflections on the arm. Resolves false (changing nothing) on a missing/mismatched file. */
export async function applyBakedArm(rig) {
  const buf = await fetchBytes('so101/ao.bin')
  if (!buf) return false
  const parts = []
  rig.root.traverse((o) => { if (isPart(o)) parts.push(o) })
  const total = parts.reduce((n, o) => n + o.geometry.attributes.position.count, 0)
  if (total !== buf.length) { console.warn(`baked AO: ${buf.length} values for ${total} vertices, skipped`); return false }
  const seen = new Set()
  let off = 0
  parts.forEach((o, i) => {
    // the servo STL is shared by six joints: each instance gets its own occlusion, so each gets its own geometry
    if (seen.has(o.geometry)) o.geometry = o.geometry.clone()
    seen.add(o.geometry)
    const n = o.geometry.attributes.position.count
    o.geometry.setAttribute('bakedAO', new THREE.BufferAttribute(buf.subarray(off, off + n), 1, true))
    o.geometry.setAttribute('partTint', new THREE.BufferAttribute(new Uint8Array(n).fill(Math.round(hash01(i) * 255)), 1, true))
    off += n
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      patchMaterial(m, { ao: true, printed: m === rig.mats.ivory, reflect: true }) // servos are moulded, not printed
    }
  })
  return true
}

/** The cup: baked AO (its inside, its foot on the table) and studio reflections in its glaze. */
export async function applyBakedCup(cup) {
  const buf = await fetchBytes('props/cup_ao.bin')
  if (!buf || buf.length !== cup.geometry.attributes.position.count) return false
  cup.geometry.setAttribute('bakedAO', new THREE.BufferAttribute(buf, 1, true))
  patchMaterial(cup.material, { ao: true, reflect: true })
  return true
}

/** The table's contact shading (arm base, cup, ring, stand), in place of the ground's painted blobs. */
export function applyBakedTable(table, ground) {
  return new Promise((resolve) => {
    new THREE.TextureLoader().load(url('props/table_ao.png'), (tex) => {
      tex.colorSpace = THREE.NoColorSpace
      tex.anisotropy = 4
      table.material.aoMap = tex
      table.material.aoMapIntensity = 1
      patchMaterial(table.material, { aoMapDirect: TABLE_AO_DIRECT })
      ground.useBakedContact()
      resolve(true)
    }, undefined, () => resolve(false))
  })
}

/** Load a theme's HDR probe and route reflections through it. Resolves false if it can't be loaded. */
export function applyProbe(theme) {
  return new Promise((resolve) => {
    new RGBELoader().setDataType(THREE.HalfFloatType).load(url(`env/${theme}.hdr`), (tex) => {
      tex.generateMipmaps = true
      tex.minFilter = THREE.LinearMipmapLinearFilter
      tex.wrapS = THREE.RepeatWrapping // the seam behind the arm
      tex.needsUpdate = true
      probe.tProbe.value?.dispose()
      probe.tProbe.value = tex
      probe.uProbe.value = PROBE_GAIN
      resolve(true)
    }, undefined, () => resolve(false))
  })
}
