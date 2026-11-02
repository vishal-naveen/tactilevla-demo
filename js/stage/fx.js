// Post-processing: MSAA scene -> dual-filter bloom -> one merged final pass (bloom add + ring rays + tone map/sRGB + grade +
// AO, S-curve, vignette, grain). `merge: false` (?legacy, ?off=merge) keeps the old chain: bloom composited back into the
// MSAA buffer, OutputPass, (FXAA on low-end), finish.
import * as THREE from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { DualBloomPass } from './bloom.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js'
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js'
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js'
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js'

// Screen-space AO for what the per-vertex bake can't know: parts of the moving arm shading each other, and the arm, cup and
// noodle meeting the table. Only meshes that write depth take part (glows, lines and fades would leave halos), plus the
// table's shadow catcher, which stands in for the faded table top.
class SceneAOPass extends GTAOPass {
  // half resolution: AO is soft by nature, and at DPR 2 a full-size normal + AO + denoise chain costs more than the scene
  setSize(w, h) { super.setSize(Math.max(1, Math.round(w / 2)), Math.max(1, Math.round(h / 2))) }
  overrideVisibility() {
    const cache = this._visibilityCache
    this.scene.traverse((o) => {
      cache.set(o, o.visible)
      const m = o.material
      const fades = o.isMesh && m && !Array.isArray(m) && m.transparent && !m.depthWrite && !o.userData.aoReceiver
      if (o.isPoints || o.isLine || o.isLineSegments2 || o.isSprite || fades || o.userData.noAO) o.visible = false
    })
  }
}
// round 6: ?off=mirror keeps the round-5 sheen (sharp, F0 0.06 look-alike gain) for A/B
const OFF_LIST = typeof location !== 'undefined' ? (new URLSearchParams(location.search).get('off') || '').split(',') : []
const OFF_W2 = OFF_LIST.includes('world2') || OFF_LIST.includes('world') // round 6 pass 2 air (flight only: needs uAir)
const OFF_MIRROR = typeof location !== 'undefined' && (new URLSearchParams(location.search).get('off') || '').split(',').includes('mirror')
const WHITE = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1)
WHITE.needsUpdate = true
const BLACK = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1)
BLACK.needsUpdate = true

const FinishShader = {
  uniforms: { tDiffuse: { value: null }, tAO: { value: WHITE }, uAO: { value: 0 }, uTime: { value: 0 }, uGrain: { value: 0.03 }, uVig: { value: 0.5 } },
  vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse; uniform sampler2D tAO; uniform float uAO; uniform float uTime; uniform float uGrain; uniform float uVig;
    varying vec2 vUv;
    float hash(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
    void main(){
      vec4 c = texture2D(tDiffuse, vUv);
      c.rgb *= mix(1.0, texture2D(tAO, vUv).r, uAO);
      vec2 d = vUv - 0.5;
      float v = smoothstep(0.85, 0.18, length(d * vec2(1.0, 0.92)));
      c.rgb = mix(c.rgb, c.rgb * c.rgb * (3.0 - 2.0 * c.rgb), 0.2); // gentle S-curve
      c.rgb *= mix(1.0 - uVig, 1.0, v);
      float n = hash(vUv * 1400.0 + fract(uTime) * 91.7) - 0.5;
      float luma = dot(c.rgb, vec3(0.299,0.587,0.114));
      c.rgb += n * uGrain * (1.15 - luma);
      gl_FragColor = vec4(c.rgb, 1.0);
    }`,
}

// The merged tail. Same maths and order as bloom composite -> OutputPass -> finish, in one full-screen pass that reads the
// resolved MSAA scene and writes the canvas: no second MSAA load/store/resolve, no 8-bit intermediate, no buffer swaps (so
// the MSAA target stays the composer's read buffer for good). Bloom T0 is sampled with 4 bilinear taps at +-0.5 texel,
// which is the old 9-tap [1 2 1]^2 tent at texel centres. Additions, all uniform-driven (never a recompile):
//  - rays: the ring's light shafts (RaysMarch below), added with the bloom before tone mapping;
//  - keep-out: bloom and rays fade out over the page's text column, so glow never sits under the copy;
//  - grade: warm highlights / cool shadows after the tone curve;
//  - Stage B: the section hand-off (row shear + spectral fringe on bright edges, uHand) and the lane dive's focus falloff
//    (uTilt). Both are coherent uniform branches: zero cost while they rest at 0.
const MERGE_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tScene; uniform sampler2D tBloom; uniform vec2 uBloomTexel; uniform float uBloomGain;
uniform sampler2D tRays; uniform float uRays;
uniform vec4 uKeep; // x: 0 = text on the left (keep-out along x), 1 = text below (along y); y: edge (uv); z: feather (uv); w: floor
uniform float uGrade;
uniform sampler2D tAO; uniform float uAO; uniform float uTime; uniform float uGrain; uniform float uVig;
uniform float uHand; uniform float uHandDir; uniform float uHandSeed; uniform float uHandSpread; uniform float uSeamHaze; // Stage B section hand-off (+ round 6 seam)
uniform float uTilt; uniform float uTiltY; uniform vec2 uPx; uniform float uSceneKeep; // Stage B lane dive: focus falloff (no depth), scene dimmed under the text
// Flight (createFX depth: true): real depth of field (half-res gather, DofGather below) + atmospheric air from the resolved depth
uniform sampler2D tDof; uniform float uDofOn;
uniform sampler2D tDepth; uniform float uAir; uniform mat4 uInvProj; uniform mat4 uCamWorld; uniform vec3 uAirCol; uniform vec3 uAirWarm;
uniform vec3 uAirSun; uniform vec4 uAirP; // x: density /m, y: height falloff /m, z: base height (m), w: max distance (m)
uniform vec4 uMist; uniform vec3 uMistCol; // a low mist layer (same maths, a few cm thick): x density, y falloff, z base height
uniform sampler2D tSheen; uniform float uSheen; uniform vec2 uSheenTexel; // flight: the table's glossy sheen (TableSheen below)
uniform float uW2; uniform vec3 uHzCol; uniform vec2 uGlowDir;
uniform float uVeil; uniform vec3 uVeilCol; uniform float uVeilDepth; uniform float uVeilT; uniform vec2 uVeilPan; uniform vec2 uVeilVel; uniform float uVeilWarm; uniform vec2 uRingUv; uniform float uRingR; uniform float uRingVis; // round 7: stage.setVeil (a depth-aware fog/light wall) // round 6 pass 2: the pano keeps its own air; the live distance lifts toward the band
#include <tonemapping_pars_fragment>
#include <colorspace_pars_fragment>
varying vec2 vUv;
float hash(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y); }
float vfbm(vec2 p){ return 0.55 * vnoise(p) + 0.3 * vnoise(p * 2.07 + 1.7) + 0.15 * vnoise(p * 4.13 + 4.1); }
void main(){
  vec2 uv = vUv;
  vec3 c;
  if (uHand > 0.0) {
    // Hand-off between section groups (Igloo's transition, restrained): a few bands of rows shear sideways in steps,
    // more toward the right and never at the frame edges (no clamp smear)...
    // (Polish: a few thick bands, all sliding the scroll's way, read as a swipe; thin rows going both ways read as a bug.)
    float tq = floor(uHand * 6.0);
    float ry = floor(vUv.y * 16.0);
    float band = step(1.0 - 0.26 * uHand, hash(vec2(ry * 0.37 + uHandSeed * 13.0, tq + 1.7)));
    float amt = 0.4 + 0.6 * hash(vec2(ry + 3.1, tq + uHandSeed * 7.0));
    uv.x += band * amt * uHandDir * 0.016 * uHand * (0.3 + 0.7 * vUv.x) * smoothstep(0.0, 0.06, vUv.x) * smoothstep(1.0, 0.94, vUv.x);
    // ...and a spectral fringe: six taps along x, each a hue, mixed in only where a bright edge is (navy flats stay clean)
    vec3 acc = vec3(0.0), ws = vec3(0.0); float lo = 1e4, hi = 0.0;
    for (int i = 0; i < 6; i++) {
      float f = float(i) / 5.0;
      vec3 w = max(vec3(0.0), 1.0 - abs(vec3(f) - vec3(0.0, 0.5, 1.0)) * vec3(2.0, 2.4, 2.0)) + vec3(0.12);
      vec3 sm = texture2D(tScene, uv + vec2((f - 0.5) * uHandSpread * uHand * uHandDir, 0.0)).rgb;
      float l = dot(sm, vec3(0.2126, 0.7152, 0.0722)); lo = min(lo, l); hi = max(hi, l);
      acc += sm * w; ws += w;
    }
    c = texture2D(tScene, uv).rgb;
    float edge = smoothstep(0.03, 0.25, hi - lo) * smoothstep(0.08, 0.4, hi);
    c = mix(c, acc / ws, edge);
    if (uSeamHaze > 0.0) { // round 6 seam: a haze breath rises from the frame's foot and sinks back (lifted ink, a warm hint)
      float top = 0.25 + 0.75 * uHand;
      float hz = smoothstep(top, top - 0.55, vUv.y + 0.08 * sin(vUv.x * 9.0 + uHandSeed * 6.0)) * uHand;
      c = mix(c, uMistCol * 2.2 + vec3(0.012, 0.009, 0.006), hz * 0.55);
    }
  } else c = texture2D(tScene, uv).rgb;
  if (uDofOn > 0.0) { // real DoF: the half-res layer carries its own blend (CoC + near-field coverage), bilinear upsampled
    vec2 h = uPx * 1.5; // a 4-tap tent at ~0.75 half-res texel: smooths the gather's per-pixel rotation noise
    vec4 dl = (texture2D(tDof, uv + vec2(-h.x, -h.y)) + texture2D(tDof, uv + vec2(h.x, -h.y)) + texture2D(tDof, uv + vec2(-h.x, h.y)) + texture2D(tDof, uv + vec2(h.x, h.y))) * 0.25;
    c = mix(c, dl.rgb, dl.a);
  }
  if (uSheen > 0.0) { // the table top's faint mirror (quarter res, already Fresnel-weighted): a 4-tap tent smooths its jitter
    vec2 h = uSheenTexel * 0.75;
    c += (texture2D(tSheen, uv + vec2(-h.x, -h.y)).rgb + texture2D(tSheen, uv + vec2(h.x, -h.y)).rgb
        + texture2D(tSheen, uv + vec2(-h.x, h.y)).rgb + texture2D(tSheen, uv + vec2(h.x, h.y)).rgb) * 0.25 * uSheen;
  }
  if (uAir > 0.0) {
    // Air between the camera and what it sees: exponential height fog integrated along the view ray to the resolved depth
    // (clamped at uAirP.w for the empty background), in-scatter warmed toward the ring. Linear HDR, before bloom + tone map.
    float dz = texture2D(tDepth, vUv).r;
    vec4 vp = uInvProj * vec4(vUv * 2.0 - 1.0, dz * 2.0 - 1.0, 1.0); vp.xyz /= vp.w;
    float dist = min(length(vp.xyz), uAirP.w);
    vec3 rd = normalize(mat3(uCamWorld) * vp.xyz);
    float b = uAirP.y, ry = rd.y * b;
    float hk = exp(-b * (uCamWorld[3].y - uAirP.z)) * (abs(ry) > 1e-4 ? (1.0 - exp(-ry * dist)) / ry : dist);
    float f = (1.0 - exp(-uAirP.x * hk)) * uAir;
    // low mist: the same integral with a cm-scale falloff, in log space (the void under the island would overflow exp)
    float mb = uMist.y, mr = rd.y * mb;
    float e0 = -mb * (uCamWorld[3].y - uMist.z), e1 = min(-mb * (uCamWorld[3].y + rd.y * dist - uMist.z), 30.0);
    float mk = abs(mr) > 1e-4 ? (exp(e0) - exp(e1)) / mr : dist * exp(e0);
    float fm = (1.0 - exp(-uMist.x * max(mk, 0.0))) * uAir;
    // pass 2: the far world (an 18 m sphere) carries its own aerial perspective; the ink air and the low mist step aside there
    float rawd = length(vp.xyz);
    float farK = uW2 * smoothstep(9.0, 14.0, rawd);
    f *= 1.0 - 0.92 * farK; fm *= 1.0 - 0.85 * farK;
    float cs = max(dot(rd, uAirSun), 0.0); float ph = pow(cs, 36.0) + 0.05 * pow(cs, 5.0); // tight warm core round the ring + a faint wide lobe
    // round 6: the warm lobe added on the blue ink read mauve near the ring; there the blue base gives way and the warm
    // term leans gold (more green, less red-violet), so the ring's air is amber haze, never lilac
    float wk = clamp(ph * 5.0, 0.0, 0.85);
    vec3 warm = uAirWarm * vec3(0.9, 1.2, 0.8) * ph;
    c = mix(c, uAirCol * (1.0 - wk) + warm, f);
    c = mix(c, uMistCol * (1.0 - wk * 0.7) + warm * 0.5, fm);
    if (uW2 > 0.0) { // pass 2: aerial perspective the Igloo way round: the live terrain lifts toward the luminous band with
      // distance (near stays deep, mid grey-blue, far pale), gold-rose toward the glow, cool pale elsewhere (= sky.py mist_col)
      vec2 h2 = rd.xz / max(length(rd.xz), 1e-4);
      float g = pow(max(dot(h2, uGlowDir), 0.0), 7.0);
      // round 11: warm ivory on the flanks, gold at the glow (the old rose flank, 1.0/0.6/0.56, read mauve round the ring)
      vec3 gc = mix(vec3(0.95, 0.88, 0.78), vec3(1.0, 0.74, 0.46), g * g);
      // under the page's text column (uKeep: the same keep-out the bloom uses) the distance stays deeper: copy over a pale
      // band would lose contrast (white type on gold haze)
      float ta = uKeep.x > 0.5 ? vUv.y : vUv.x;
      float txt = 1.0 - smoothstep(uKeep.y - uKeep.z * 0.25, uKeep.y + uKeep.z, ta);
      float hk = uW2 * uAir * smoothstep(0.9, 7.5, rawd) * (1.0 - farK) * 0.6 * (1.0 - 0.6 * txt);
      c = mix(c, uHzCol + gc * (0.10 * g + 0.10 * g * g * g), hk);
      c *= 1.0 - 0.5 * txt * farK;
    }
  }
  if (uTilt > 0.0) {
    // Not depth of field: looking along the table plane, screen height stands in for distance, so rows below the focus
    // line (nearer) defocus most. 12 golden-angle taps on a per-pixel rotation; used only during the lane's dive.
    float dy = vUv.y - uTiltY;
    float rad = uTilt * smoothstep(0.02, 0.2, abs(dy)) * (dy < 0.0 ? 1.0 : 0.8);
    if (rad > 0.5) {
      float rot = 6.2832 * fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
      vec3 acc = c; float n = 1.0;
      for (int i = 0; i < 12; i++) {
        float a = float(i) * 2.39996 + rot, rr = sqrt((float(i) + 0.5) / 12.0) * rad;
        acc += texture2D(tScene, uv + vec2(cos(a), sin(a)) * rr * uPx).rgb; n += 1.0;
      }
      c = acc / n;
    }
  }
  vec2 t = uBloomTexel * 0.5;
  vec3 b = (texture2D(tBloom, uv + vec2(-t.x, -t.y)).rgb + texture2D(tBloom, uv + vec2(t.x, -t.y)).rgb
          + texture2D(tBloom, uv + vec2(-t.x, t.y)).rgb + texture2D(tBloom, uv + vec2(t.x, t.y)).rgb) * (0.25 * uBloomGain);
  vec3 r = uRays > 0.0 ? texture2D(tRays, vUv).rgb * uRays : vec3(0.0);
  float a = uKeep.x > 0.5 ? vUv.y : vUv.x;
  float keep = mix(uKeep.w, 1.0, smoothstep(uKeep.y - uKeep.z * 0.25, uKeep.y + uKeep.z, a));
  c += (b + r) * keep;
  if (uVeil > 0.0) {
    // Veil (stage.setVeil, B's chapter jumps; round 8): flying through cloud, not a fade to a flat colour. Zero cost at 0.
    //  - depth-aware: the far world goes first, near objects last (volume);
    //  - three fbm mist layers, panned by the camera's own screen motion at three depths (uVeilPan: parallax) + drift, so
    //    it never stops moving, even at the peak; coverage tops out at ~0.94 with the texture, so shapes ghost through;
    //  - the ring's warm light (and every bloomed highlight) glows through it; the warm veil is a luminous gradient;
    //  - sparse warm specks streak through it along the camera's motion (the ambient motes, inside the haze).
    float nd = 0.6;
    if (uVeilDepth > 0.0) {
      float vz = texture2D(tDepth, vUv).r;
      vec4 vq = uInvProj * vec4(vUv * 2.0 - 1.0, vz * 2.0 - 1.0, 1.0); vq.xyz /= vq.w;
      nd = clamp(log(max(length(vq.xyz), 0.15) / 0.15) / 4.9, 0.0, 1.0); // 0 at 15 cm .. 1 at ~20 m
    }
    float asp = uPx.y / uPx.x;
    vec2 sp = vec2(vUv.x * asp, vUv.y);
    float vt = uVeilT;
    float m1 = vfbm(sp * 1.5 + uVeilPan * 0.55 + vec2(vt * 0.035, vt * 0.012));
    float m2 = vfbm(sp * 3.1 + uVeilPan * 1.25 + vec2(-vt * 0.06, vt * 0.02) + 7.1);
    float m3 = vfbm(sp * 6.3 + uVeilPan * 2.6 + vec2(vt * 0.11, -vt * 0.035) + 3.3);
    float dens = 0.45 * m1 + 0.35 * m2 + 0.2 * m3;
    float w = clamp(uVeil * 1.65 - (1.0 - nd) * 0.6 + (dens - 0.5) * (0.5 + 0.7 * uVeil), 0.0, 1.0);
    // peak ~0.92-0.98 by the mist's own density (shapes ghost through); only at a ~ 1 (the camera's cut) it closes fully,
    // and even then the wall itself is textured, drifting mist
    w = w * w * (3.0 - 2.0 * w) * min(1.0, 0.86 + 0.12 * smoothstep(0.3, 0.7, dens) + 0.14 * smoothstep(0.97, 1.0, uVeil));
    vec2 rd2 = (vUv - uRingUv) * vec2(asp, 1.0);
    float rg = uRingVis * exp(-dot(rd2, rd2) / max(uRingR * uRingR * 5.0, 1e-4));
    vec3 vc;
    if (uVeilWarm > 1.5) { // 'light': a pale silver haze, luminous high up, faintly warm where the ring is
      vc = vec3(0.40, 0.395, 0.38) * (0.6 + 0.5 * vUv.y + 0.25 * rg) * (0.66 + 0.7 * dens);
    } else if (uVeilWarm > 0.0) { // a luminous gold-rose wall: brighter high up and toward the ring, wisps lighter than the troughs
      vc = uVeilCol * (0.62 + 0.5 * vUv.y + 0.4 * rg) * (0.62 + 0.8 * dens);
      vc = mix(vc, vc * vec3(1.02, 0.9, 0.94), smoothstep(0.55, 0.1, vUv.y)); // dusty rose toward the foot
    } else { // ink haze with lighter wisps, the ring's warmth glowing through
      vc = uVeilCol * (0.6 + 0.9 * dens) + vec3(0.016, 0.024, 0.042) * smoothstep(0.38, 0.78, dens) * 1.6 + vec3(0.42, 0.25, 0.11) * rg * 0.35; // lighter blue wisps on the ink
    }
    vc += b * 0.55 * keep; // what blooms (the ring, lit highlights) scatters through the haze
    // motes streaking through: one speck per ~3% cell, drawn as a short segment along the screen motion
    vec2 vel = uVeilVel; float vl = length(vel);
    vec2 cs = sp / 0.032; vec2 ci = floor(cs);
    float hh = hash(ci + 0.5);
    if (hh > 0.94) {
      vec2 ctr = (ci + 0.2 + 0.6 * vec2(hash(ci + 3.7), hash(ci + 9.1))) * 0.032;
      vec2 dir = vl > 1e-4 ? vel / vl : vec2(1.0, 0.0);
      vec2 dv = sp - ctr; float al = dot(dv, dir); float pe = length(dv - dir * al);
      float L = clamp(vl * 0.05, 0.0015, 0.014);
      float sk = smoothstep(0.0013, 0.0, pe) * smoothstep(L, 0.0, abs(al)) * (0.4 + 0.6 * hash(ci + 1.3));
      vc += vec3(1.0, 0.74, 0.46) * sk * (uVeilWarm > 0.0 ? 0.22 : 0.16) * smoothstep(0.2, 0.8, uVeil) * smoothstep(0.4, 2.0, vl); // only while moving
    }
    c = mix(c, vc, w);
  }
  if (uSceneKeep > 0.0) { // dive only: a scrim behind the copy, and the near (defocused) rows sink toward the frame's foot,
    // where the time-lapse card sits, so the card never lands on the brightest part of the frame
    c *= mix(1.0 - uSceneKeep, 1.0, smoothstep(uKeep.y - uKeep.z * 0.25, uKeep.y + uKeep.z * 1.5, a));
    c *= mix(1.0 - 0.75 * uSceneKeep, 1.0, smoothstep(0.02, 0.42, vUv.y));
  }
  vec4 o = vec4(c, 1.0);
  #ifdef LINEAR_TONE_MAPPING
    o.rgb = LinearToneMapping(o.rgb);
  #elif defined(REINHARD_TONE_MAPPING)
    o.rgb = ReinhardToneMapping(o.rgb);
  #elif defined(CINEON_TONE_MAPPING)
    o.rgb = CineonToneMapping(o.rgb);
  #elif defined(ACES_FILMIC_TONE_MAPPING)
    o.rgb = ACESFilmicToneMapping(o.rgb);
  #elif defined(AGX_TONE_MAPPING)
    o.rgb = AgXToneMapping(o.rgb);
  #elif defined(NEUTRAL_TONE_MAPPING)
    o.rgb = NeutralToneMapping(o.rgb);
  #endif
  if (uGrade > 0.0) { // split tone: shadows lean to the navy room, highlights to the warm key
    float l = dot(o.rgb, vec3(0.2126, 0.7152, 0.0722));
    vec3 tint = mix(vec3(0.86, 0.95, 1.12), vec3(1.07, 1.0, 0.9), smoothstep(0.015, 0.32, l));
    o.rgb = max(mix(o.rgb, o.rgb * tint, uGrade), 0.0);
  }
  #ifdef SRGB_TRANSFER
    o = sRGBTransferOETF(o);
  #endif
  o.rgb *= mix(1.0, texture2D(tAO, vUv).r, uAO);
  vec2 d = vUv - 0.5;
  float v = smoothstep(0.85, 0.18, length(d * vec2(1.0, 0.92)));
  o.rgb = mix(o.rgb, o.rgb * o.rgb * (3.0 - 2.0 * o.rgb), 0.2); // gentle S-curve
  o.rgb *= mix(1.0 - uVig, 1.0, v);
  float n = hash(vUv * 1400.0 + fract(uTime) * 91.7) - 0.5;
  float luma = dot(o.rgb, vec3(0.299,0.587,0.114));
  o.rgb += n * uGrain * (1.15 - luma);
  gl_FragColor = vec4(o.rgb, 1.0);
}`
const QUAD_VERT = /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`
const RAW_VERT = /* glsl */ `precision highp float; attribute vec3 position; attribute vec2 uv; varying vec2 vUv;
void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`

const TM_DEFINE = {
  [THREE.LinearToneMapping]: 'LINEAR_TONE_MAPPING', [THREE.ReinhardToneMapping]: 'REINHARD_TONE_MAPPING',
  [THREE.CineonToneMapping]: 'CINEON_TONE_MAPPING', [THREE.ACESFilmicToneMapping]: 'ACES_FILMIC_TONE_MAPPING',
  [THREE.AgXToneMapping]: 'AGX_TONE_MAPPING', [THREE.NeutralToneMapping]: 'NEUTRAL_TONE_MAPPING',
}

class MergedPass extends Pass {
  constructor(bloom, rays) {
    super()
    this.needsSwap = false
    this.bloom = bloom
    this.rays = rays
    this.uniforms = {
      tScene: { value: null }, tBloom: { value: null }, uBloomTexel: { value: new THREE.Vector2() }, uBloomGain: { value: 0 },
      tRays: { value: BLACK }, uRays: { value: 0 }, uKeep: { value: new THREE.Vector4(0, 0, 0.1, 1) }, uGrade: { value: 0 },
      toneMappingExposure: { value: 1 },
      tAO: { value: WHITE }, uAO: { value: 0 }, uTime: { value: 0 }, uGrain: { value: 0.03 }, uVig: { value: 0.5 },
      uHand: { value: 0 }, uHandDir: { value: 1 }, uHandSeed: { value: 0 }, uHandSpread: { value: 6 / 1440 }, uSeamHaze: { value: 0 },
      uTilt: { value: 0 }, uTiltY: { value: 0.5 }, uPx: { value: new THREE.Vector2(1, 1) }, uSceneKeep: { value: 0 },
      tDof: { value: BLACK }, uDofOn: { value: 0 },
      tDepth: { value: BLACK }, uAir: { value: 0 }, uInvProj: { value: new THREE.Matrix4() }, uCamWorld: { value: new THREE.Matrix4() },
      uAirCol: { value: new THREE.Color(0.012, 0.016, 0.028) }, uAirWarm: { value: new THREE.Color(0.05, 0.028, 0.012) },
      uAirSun: { value: new THREE.Vector3(0, 0, 1) }, uAirP: { value: new THREE.Vector4(0.35, 3.0, 0.0, 4.0) },
      uMist: { value: new THREE.Vector4(0, 40, -0.02, 0) }, uMistCol: { value: new THREE.Color() },
      tSheen: { value: BLACK }, uSheen: { value: 0 }, uSheenTexel: { value: new THREE.Vector2(1, 1) },
      uW2: { value: OFF_W2 ? 0 : 1 }, uVeil: { value: 0 }, uVeilCol: { value: new THREE.Color() }, uVeilDepth: { value: 0 }, uVeilT: { value: 0 }, uVeilPan: { value: new THREE.Vector2() }, uVeilVel: { value: new THREE.Vector2() }, uVeilWarm: { value: 0 }, uRingUv: { value: new THREE.Vector2(0.5, 0.5) }, uRingR: { value: 0.1 }, uRingVis: { value: 0 }, uHzCol: { value: new THREE.Color(0.063, 0.078, 0.11) }, uGlowDir: { value: new THREE.Vector2(Math.cos(138 * Math.PI / 180), Math.sin(138 * Math.PI / 180)) },
    }
    this.sheen = null // TableSheen (createFX depth: true)
    this.dof = null // DofGather (createFX depth: true)
    this.camera = null
    // raw, like OutputPass: a plain ShaderMaterial would get three's own colour-space chunk prepended (duplicate symbols)
    this.material = new THREE.RawShaderMaterial({ uniforms: this.uniforms, vertexShader: RAW_VERT, fragmentShader: MERGE_FRAG, depthTest: false, depthWrite: false })
    this.quad = new FullScreenQuad(this.material)
    this._key = null
  }
  render(renderer, writeBuffer, readBuffer) {
    const u = this.uniforms
    const key = renderer.outputColorSpace + '|' + renderer.toneMapping
    if (key !== this._key) { // set once at load (the tone curve only changes with ?tm=)
      this._key = key
      this.material.defines = {}
      if (THREE.ColorManagement.getTransfer(renderer.outputColorSpace) === THREE.SRGBTransfer) this.material.defines.SRGB_TRANSFER = ''
      const tm = TM_DEFINE[renderer.toneMapping]
      if (tm) this.material.defines[tm] = ''
      this.material.needsUpdate = true
    }
    u.tScene.value = readBuffer.texture
    u.uPx.value.set(1 / readBuffer.width, 1 / readBuffer.height)
    const T0 = this.bloom.targets[0]
    u.tBloom.value = T0.texture
    u.uBloomTexel.value.set(1 / T0.width, 1 / T0.height)
    u.uBloomGain.value = this.bloom.compositeGain
    u.toneMappingExposure.value = renderer.toneMappingExposure
    const rg = this.rays?.active ? this.rays.gain : 0
    u.uRays.value = rg
    u.tRays.value = rg > 0 ? this.rays.rt.texture : BLACK
    const dt = readBuffer.depthTexture
    if (dt && this.camera) { // flight: depth-driven DoF + air (the MSAA resolve blits depth into dt; see createFX)
      u.tDepth.value = dt
      u.uInvProj.value.copy(this.camera.projectionMatrixInverse)
      u.uCamWorld.value.copy(this.camera.matrixWorld)
      const on = this.dof.run(renderer, readBuffer, this.camera)
      u.uDofOn.value = on ? 1 : 0
      u.tDof.value = on ? this.dof.out.texture : BLACK
      this.sheen.time = u.uTime.value
      const sh = u.uSheen.value > 0 && this.sheen.run(renderer, readBuffer, this.camera)
      u.tSheen.value = sh ? this.sheen.rt.texture : BLACK
      if (sh) u.uSheenTexel.value.set(1 / this.sheen.rt.width, 1 / this.sheen.rt.height)
      else if (this.sheen.warm) this.sheen.run(renderer, readBuffer, this.camera) // the precompile's warm frame builds it
    }
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer)
    this.quad.render(renderer)
  }
  dispose() { this.material.dispose(); this.quad.dispose() }
}

// Ring light shafts, screen space, at a quarter of the resolution. Marches the resolved scene towards the ring's centre,
// taking light only from a band around the ring's tube and only warm light (the ivory arm crossing it does not streak), so
// the WHOLE ring glows into the haze, not just its lit arc (at the top of the page that arc is a sliver, which threw a
// single pillar). Writes a small target the merged pass adds before tone mapping; never touches the MSAA buffer.
const RAYS_FRAG = /* glsl */ `
uniform sampler2D tSrc; uniform vec2 uLight; uniform float uAspect; uniform float uR; uniform float uLen;
varying vec2 vUv;
void main() {
  // static per-pixel offset (interleaved gradient noise): no stepped ghost rings, and no shimmer (there is no TAA to hide it)
  float ign = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  vec2 dir = (uLight - vUv) * (uLen / 24.0);
  vec2 uv = vUv + dir * ign; float w = 1.0; vec3 acc = vec3(0.0);
  for (int i = 0; i < 24; i++) {
    vec2 q = (uv - uLight) * vec2(uAspect, 1.0);
    float src = 1.0 - smoothstep(uR * 0.08, uR * 0.3, abs(length(q) - uR)); // only the ring's tube emits shafts
    float inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
    vec3 c = texture2D(tSrc, uv).rgb;
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    c = c / max(l, 1e-3) * min(l, 0.5) * clamp((c.r - c.b) * 2.0, 0.0, 1.0); // lit arc and unlit tube alike (no seam, no pillar), warm only
    acc += c * (src * inside * w);
    
    w *= 0.9; uv += dir;
  }
  vec2 dd = (vUv - uLight) * vec2(uAspect, 1.0);
  float out1 = smoothstep(uR * 0.9, uR * 1.4, length(dd)); // shafts leave the ring outward; its inside stays clean
  gl_FragColor = vec4(acc / 24.0 * out1 * exp(-dot(dd, dd) * 3.0) * 2.2, 1.0);
}`
export class RaysMarch {
  constructor() {
    this.rt = new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType, depthBuffer: false, generateMipmaps: false })
    this.quad = new FullScreenQuad(new THREE.ShaderMaterial({
      vertexShader: QUAD_VERT, fragmentShader: RAYS_FRAG, depthTest: false, depthWrite: false,
      uniforms: { tSrc: { value: null }, uLight: { value: new THREE.Vector2(0.5, 0.5) }, uAspect: { value: 1 }, uR: { value: 0.1 }, uLen: { value: 0.32 } },
    }))
    this.gain = 0
    this.active = false
  }
  /** uv of the ring's centre (0..1, y up), its radius as a fraction of the viewport height, and the shafts' strength. */
  set(x, y, r, gain, aspect) {
    const u = this.quad.material.uniforms
    u.uLight.value.set(x, y); u.uR.value = r; u.uAspect.value = aspect
    this.gain = gain
  }
  run(renderer, src, size) {
    this.active = this.gain > 0.001
    if (!this.active) return
    if (this.rt.width !== size.width || this.rt.height !== size.height) this.rt.setSize(size.width, size.height)
    this.quad.material.uniforms.tSrc.value = src.texture
    renderer.setRenderTarget(this.rt)
    this.quad.render(renderer)
  }
  dispose() { this.rt.dispose(); this.quad.dispose() }
}

// Depth of field from the resolved scene depth (flight only). Two half-res passes, never touching the MSAA buffer:
//  1. prep: colour (one bilinear tap = the 2x2 average) + signed CoC from the NEAREST of the 2x2 depths (so thin near edges
//     keep their blur), CoC = aperture * (z - focus) / z (thin lens, in half-res px; far saturates at the aperture, near clamps);
//  2. gather: 28 golden-angle taps on a per-pixel rotation over max(own CoC, the near search radius). Far field: taps whose own
//     CoC covers their distance (in-focus foreground never smears into blurred background). Near field: scatter-as-gather,
//     each near tap weighted by 1 / its CoC area, so a defocused foreground spills over the sharp background behind its edge
//     (the lane dive look). Output rgb = far blur under near blur, a = blend factor for the merged pass (bilinear upsample).
// Cost at 1440x900 dsf 2 (half res 1440x900): 4 depth + 1 colour taps, then a 16-tap near-CoC tile max at 1/16 res, then 9 + 33 taps. Skipped entirely while aperture is 0.
const DOF_PREP = /* glsl */ `
uniform sampler2D tSrc; uniform sampler2D tDepth; uniform vec2 uTexel; uniform float uNear; uniform float uFar;
uniform float uFocus; uniform float uAper; uniform float uMaxNear; uniform float uNearK;
varying vec2 vUv;
float lin(float d) { return uNear * uFar / (uFar - d * (uFar - uNear)); }
void main() {
  vec4 d4 = vec4(texture2D(tDepth, vUv + uTexel * vec2(-0.25, -0.25)).r, texture2D(tDepth, vUv + uTexel * vec2(0.25, -0.25)).r,
                 texture2D(tDepth, vUv + uTexel * vec2(-0.25, 0.25)).r, texture2D(tDepth, vUv + uTexel * vec2(0.25, 0.25)).r);
  float z = lin(min(min(d4.x, d4.y), min(d4.z, d4.w)));
  float coc = uAper * (z - uFocus) / z;
  coc = clamp(coc < 0.0 ? coc * uNearK : coc, -uMaxNear, uAper); // a macro look: the near field falls off faster than a thin lens
  gl_FragColor = vec4(texture2D(tSrc, vUv).rgb, coc);
}`
// near CoC dilation: max near CoC per 8x8 half-res tile (so the gather knows how far a defocused foreground can spill)
const DOF_TILE = /* glsl */ `
uniform sampler2D tSrc; uniform vec2 uTexel;
varying vec2 vUv;
void main() {
  float m = 0.0;
  for (int y = 0; y < 4; y++) for (int x = 0; x < 4; x++) // 16 bilinear-free taps on the 8x8 tile (2 px stride)
    m = max(m, -texture2D(tSrc, vUv + (vec2(float(x), float(y)) * 2.0 - 3.0) * uTexel).a);
  gl_FragColor = vec4(m, 0.0, 0.0, 1.0);
}`
const DOF_GATHER = /* glsl */ `
uniform sampler2D tSrc; uniform sampler2D tTile; uniform vec2 uTexel; uniform vec2 uTileTexel; uniform float uMaxNear;
uniform float uN; // round 11: taps this frame (32 at rest, 16 while the camera moves: same program, a uniform loop bound)
varying vec2 vUv;
void main() {
  vec4 c0 = texture2D(tSrc, vUv);
  float cc = c0.a;
  float nd = 0.0; // dilated near CoC: 3x3 tiles around this one
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) nd = max(nd, texture2D(tTile, vUv + vec2(float(x), float(y)) * uTileTexel).r);
  float R = clamp(max(abs(cc), nd), 1.0, uMaxNear);
  float rot = 6.2832 * fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  vec3 fa = c0.rgb; float fw = 1.0;
  vec3 na = vec3(0.0); float nw = 0.0; float nc = 0.0;
  float tapA = R * R / uN; // disc area per tap (px^2 / pi)
  for (int i = 0; i < 32; i++) {
    if (float(i) >= uN) break;
    float r = sqrt((float(i) + 0.5) / uN) * R;
    float a = float(i) * 2.39996 + rot;
    vec4 s = texture2D(tSrc, vUv + vec2(cos(a), sin(a)) * r * uTexel);
    // far: inside the centre's own disc and the tap's own (positive) CoC reaches back here
    float wf = step(r, cc) * clamp(s.a - r + 1.0, 0.0, 1.0);
    fa += s.rgb * wf; fw += wf;
    // near: the tap's near disc covers this pixel; weight = its share of that disc
    float sn = -s.a;
    float wn = step(1.0, sn) * clamp(sn - r + 1.0, 0.0, 1.0) * min(1.0, tapA / max(sn * sn, 1.0));
    na += s.rgb * wn; nw += wn; nc = max(nc, sn * step(r, sn));
  }
  vec3 far = fa / fw;
  float nA = clamp(nw * 1.15, 0.0, 1.0) * smoothstep(0.6, 2.0, nc);
  vec3 col = mix(far, na / max(nw, 1e-4), nA);
  float a = max(smoothstep(0.5, 1.6, abs(cc)), nA);
  gl_FragColor = vec4(col, a);
}`
export class DofGather {
  constructor() {
    const o = { type: THREE.HalfFloatType, depthBuffer: false, generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter }
    this.prep = new THREE.WebGLRenderTarget(2, 2, o)
    this.out = new THREE.WebGLRenderTarget(2, 2, o)
    this.tile = new THREE.WebGLRenderTarget(2, 2, { ...o, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter })
    this.qTile = new FullScreenQuad(new THREE.ShaderMaterial({
      vertexShader: QUAD_VERT, fragmentShader: DOF_TILE, depthTest: false, depthWrite: false,
      uniforms: { tSrc: { value: this.prep.texture }, uTexel: { value: new THREE.Vector2() } },
    }))
    this.qPrep = new FullScreenQuad(new THREE.ShaderMaterial({
      vertexShader: QUAD_VERT, fragmentShader: DOF_PREP, depthTest: false, depthWrite: false,
      uniforms: { tSrc: { value: null }, tDepth: { value: null }, uTexel: { value: new THREE.Vector2() }, uNear: { value: 0.1 }, uFar: { value: 10 }, uFocus: { value: 1 }, uAper: { value: 0 }, uMaxNear: { value: 1 }, uNearK: { value: 2.3 } },
    }))
    this.qGather = new FullScreenQuad(new THREE.ShaderMaterial({
      vertexShader: QUAD_VERT, fragmentShader: DOF_GATHER, depthTest: false, depthWrite: false,
      uniforms: { tSrc: { value: this.prep.texture }, tTile: { value: this.tile.texture }, uTexel: { value: new THREE.Vector2() }, uTileTexel: { value: new THREE.Vector2() }, uMaxNear: { value: 1 }, uN: { value: 32 } },
    }))
    this.focus = 1 // view depth in focus (m)
    this.aperture = 0 // far-field CoC at infinity, FULL-res device px (0 = off: both passes skipped)
    this.maxNear = 2.2 // near CoC clamp, x aperture
    this.nearK = 2.3 // near-field CoC gain (the old dive blurred its near rows hardest; a plain thin lens read too timid)
    this.warm = true // the first render (stage precompile) runs both passes so their programs exist at load
    this.moving = false // round 11: stage.js sets it while the camera moves (half the gather taps: CoC is lower mid-move
    // and motion hides the extra noise; measured -0.3 ms median at 1512x982 dsf 2 for the whole DoF on the M3 Pro)
  }
  run(renderer, src, camera) {
    if (!(this.aperture > 0.25) && !this.warm) return false
    this.warm = false
    const w = Math.max(1, src.width >> 1), h = Math.max(1, src.height >> 1)
    const tw = Math.ceil(w / 8), th = Math.ceil(h / 8)
    if (this.prep.width !== w || this.prep.height !== h) { this.prep.setSize(w, h); this.out.setSize(w, h); this.tile.setSize(tw, th) }
    const ap = Math.max(0.5, this.aperture * 0.5) // half-res px
    const mn = Math.min(ap * this.maxNear, 26)
    const up = this.qPrep.material.uniforms, ug = this.qGather.material.uniforms
    up.tSrc.value = src.texture; up.tDepth.value = src.depthTexture
    up.uTexel.value.set(1 / src.width, 1 / src.height)
    up.uNear.value = camera.near; up.uFar.value = camera.far
    up.uFocus.value = Math.max(0.02, this.focus); up.uAper.value = ap; up.uMaxNear.value = mn; up.uNearK.value = this.nearK
    ug.uTexel.value.set(1 / w, 1 / h); ug.uTileTexel.value.set(1 / tw, 1 / th); ug.uMaxNear.value = mn
    ug.uN.value = this.moving ? 16 : 32
    this.qTile.material.uniforms.uTexel.value.set(1 / w, 1 / h)
    renderer.setRenderTarget(this.prep); this.qPrep.render(renderer)
    renderer.setRenderTarget(this.tile); this.qTile.render(renderer)
    renderer.setRenderTarget(this.out); this.qGather.render(renderer)
    return true
  }
  dispose() { this.prep.dispose(); this.out.dispose(); this.tile.dispose(); this.qPrep.dispose(); this.qTile.dispose(); this.qGather.dispose() }
}

// The table top as a faint glossy mirror (flight only; Igloo's floor sheen, cheaply): for each quarter-res pixel whose resolved
// depth lands on the plane y = uPlaneY (the island top), the view ray is mirrored about the plane and marched 14 steps
// (exponential, 1 cm .. 1.2 m, per-pixel jitter) against the resolved depth; the first crossing within a thickness that grows
// with distance takes the scene colour there. Fresnel (Schlick, F0 0.04 lifted for the waxed top) and a distance + screen-edge
// fade weight it; the merged pass adds it (x uSheen) before the air, bloom and tone curve. What it can show is what is on
// screen: the ring tube, the lit arm, the noodles. Off-screen or behind-geometry rays find nothing (no false mirror).
const SHEEN_FRAG = /* glsl */ `
uniform sampler2D tSrc; uniform sampler2D tDepth; uniform mat4 uInvProj; uniform mat4 uProj; uniform mat4 uView; uniform mat4 uCamWorld;
uniform float uPlaneY; uniform float uNear; uniform float uFar; uniform float uRough; uniform float uAspInv; uniform float uGainS; uniform float uTimeS; uniform float uShim;
varying vec2 vUv;
float lin(float d) { return uNear * uFar / (uFar - d * (uFar - uNear)); }
void main() {
  float d = texture2D(tDepth, vUv).r;
  vec3 o = vec3(0.0);
  if (d < 1.0) {
    vec4 vp = uInvProj * vec4(vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0); vp.xyz /= vp.w;
    vec3 wp = (uCamWorld * vec4(vp.xyz, 1.0)).xyz;
    if (abs(wp.y - uPlaneY) < 0.0035 && length(wp - uCamWorld[3].xyz) < 8.0) { // (round 6: the far world's 18 m sphere crosses the plane's height at its horizon: a thin band of it read as table and mirrored into dashes)
      vec3 co = uCamWorld[3].xyz; vec3 v = normalize(wp - co); vec3 r = vec3(v.x, -v.y, v.z);
      float ign = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
      for (int i = 0; i < 14; i++) {
        float t = 0.012 * pow(1.4, float(i) + ign);
        vec3 p = wp + r * t + vec3(sin(wp.z * 23.0 + uTimeS * 0.7), 0.0, sin(wp.x * 19.0 - uTimeS * 0.55)) * (0.0035 * t * uShim); // round 7: a slow shimmer in the resin's mirror
        vec4 cv = uView * vec4(p, 1.0);
        vec4 cl = uProj * cv;
        vec2 uv = cl.xy / cl.w * 0.5 + 0.5;
        if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) break;
        float sz = lin(texture2D(tDepth, uv).r), rz = -cv.z;
        if (rz > sz + 0.002 && rz - sz < 0.03 + t * 0.25) {
          vec2 e = smoothstep(0.0, 0.08, uv) * smoothstep(1.0, 0.92, uv);
          float fr = 0.09 + 0.91 * pow(1.0 - max(-v.y, 0.0), 5.0); // round 6: a glossier resin (F0 0.06 -> 0.09)
          // round 6: roughness blur: the reflection's footprint grows with the reflected distance (a resin top, not glass):
          // 4 taps (centre + 3 on a ring of radius ~ t / view depth, rotated per pixel; the merged pass's tent and the
          // per-pixel rotation fill the disc in; 7 taps cost +0.35 ms at F1)
          float br = uRough * (0.003 + t * 0.06) / max(rz, 0.05);
          vec3 acc = texture2D(tSrc, uv).rgb; float rot = ign * 6.2832;
          for (int k = 0; k < 3; k++) { float a = float(k) * 2.0944 + rot; acc += texture2D(tSrc, uv + vec2(cos(a) * uAspInv, sin(a)) * br).rgb; }
          o = acc * 0.25 * fr * e.x * e.y * exp(-t * 0.8) * uGainS;
          break;
        }
      }
    }
  }
  gl_FragColor = vec4(o, 1.0);
}`
export class TableSheen {
  constructor() {
    this.rt = new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType, depthBuffer: false, generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter })
    this.q = new FullScreenQuad(new THREE.ShaderMaterial({
      vertexShader: QUAD_VERT, fragmentShader: SHEEN_FRAG, depthTest: false, depthWrite: false,
      uniforms: { tSrc: { value: null }, tDepth: { value: null }, uInvProj: { value: new THREE.Matrix4() }, uProj: { value: new THREE.Matrix4() }, uView: { value: new THREE.Matrix4() }, uCamWorld: { value: new THREE.Matrix4() }, uPlaneY: { value: -0.0015 }, uNear: { value: 0.1 }, uFar: { value: 10 }, uRough: { value: OFF_MIRROR ? 0 : 1 }, uAspInv: { value: 1 }, uGainS: { value: OFF_MIRROR ? 1 : 1.7 }, uTimeS: { value: 0 }, uShim: { value: OFF_LIST.includes('ambient') ? 0 : 1 } },
    }))
    this.warm = true
  }
  run(renderer, src, camera) {
    this.warm = false
    const w = Math.max(1, src.width >> 2), h = Math.max(1, src.height >> 2) // quarter res: the sheen is soft anyway (half res cost ~4x)
    if (this.rt.width !== w || this.rt.height !== h) this.rt.setSize(w, h)
    const u = this.q.material.uniforms
    u.tSrc.value = src.texture; u.tDepth.value = src.depthTexture
    u.uInvProj.value.copy(camera.projectionMatrixInverse); u.uProj.value.copy(camera.projectionMatrix)
    u.uView.value.copy(camera.matrixWorldInverse); u.uCamWorld.value.copy(camera.matrixWorld)
    u.uNear.value = camera.near; u.uFar.value = camera.far; u.uAspInv.value = src.height / src.width; u.uTimeS.value = this.time || 0
    renderer.setRenderTarget(this.rt); this.q.render(renderer)
    return true
  }
  dispose() { this.rt.dispose(); this.q.dispose() }
}

const MB = 1024 * 1024

/**
 * GPU memory (MB) the render pipeline holds for a drawing buffer of W x H device pixels: the MSAA half-float scene target
 * (resolve texture + N-sample colour + N-sample depth renderbuffers), the 8-bit finish target (legacy chain only), the
 * half-float bloom chain (~1/3 of a full target), the canvas back buffers, and the two VSM shadow targets (map + blur pass,
 * 16 B/texel). Used to pick an iOS-safe DPR / sample count / shadow size before anything is allocated.
 */
export function estimateGpuMB(W, H, { samples = 2, low = false, shadowSize = 2048, merge = false } = {}) {
  const px = W * H
  const scene = px * 8 + (samples > 0 ? samples * px * (8 + 4) : px * 4)
  const out = low ? px * (8 + 4) : merge ? 0 : px * 4
  const bloom = px * 8 * 0.34 + (merge ? px * 8 / 16 : 0) // + the quarter-res rays target
  const back = px * 4 * 2
  const shadow = shadowSize * shadowSize * 16
  return (scene + out + bloom + back + shadow) / MB
}

export function createFX(renderer, scene, camera, { low, width, height, dpr, samples = low ? 0 : 2, ao = false, merge = true, depth = false }) {
  merge = merge && !low // the FXAA chain needs its odd swap count and both full buffers (see below)
  const rt = new THREE.WebGLRenderTarget(width * dpr, height * dpr, { type: THREE.HalfFloatType, samples })
  const composer = new EffectComposer(renderer, rt)
  // Only the scene pass needs MSAA + depth. It renders into the composer's read buffer. Merged chain: no pass swaps, so that
  // buffer never moves and the write buffer is never drawn (kept at 1x1). Legacy chain: the two swapping passes (OutputPass,
  // finish) keep the read buffer stable; the FXAA path (odd swap count) alternates buffers, so it keeps both full.
  composer.readBuffer.samples = samples
  composer.writeBuffer.samples = 0
  if (!low) {
    // The write buffer only ever holds the tone-mapped, sRGB-encoded OutputPass result: 8 bit is exactly what the canvas
    // stores anyway (the finish pass adds dither grain), and it needs no depth. Saves ~ 8 B/px on a phone.
    composer.renderTarget1.depthBuffer = false
    composer.renderTarget1.texture.type = THREE.UnsignedByteType
  }
  // Flight only (createStage depth: true; the default page never asks): the MSAA read buffer resolves its depth into a texture
  // (three blits DEPTH_BUFFER_BIT with the colour), read by the merged pass for DoF + air. No extra scene pass, no buffer swap.
  depth = depth && merge
  if (depth) composer.readBuffer.depthTexture = new THREE.DepthTexture(width * dpr, height * dpr, THREE.UnsignedIntType)
  const shrinkWrite = () => { if (merge) composer.writeBuffer.setSize(1, 1) }
  composer.setPixelRatio(dpr)
  composer.setSize(width, height)
  shrinkWrite()
  // AO first: it draws its own normal + depth pass and leaves the result in a target the finish pass reads (no buffer swap)
  let gtao = null
  if (ao) {
    gtao = new SceneAOPass(scene, camera, width * dpr, height * dpr, undefined,
      { radius: 0.05, distanceExponent: 1.6, thickness: 0.03, scale: 1, samples: 8, distanceFallOff: 1, screenSpaceRadius: false },
      { lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 8 })
    gtao.output = GTAOPass.OUTPUT.Off
    gtao.needsSwap = false
    composer.addPass(gtao)
  }
  composer.addPass(new RenderPass(scene, camera))

  // Bloom starts at half resolution with a proper prefilter and a smooth tent upsample (see bloom.js).
  const bloom = new DualBloomPass(new THREE.Vector2(width * dpr, height * dpr).multiplyScalar(0.5), 0.45, 0.32, 1.6)
  composer.addPass(bloom)

  let fxaa = null, finish, rays = null
  if (merge) {
    rays = new RaysMarch()
    bloom.composite = false // the merged pass adds it
    bloom.onDown = (r, T, src) => rays.run(r, src, T[1]) // quarter res: soft shafts at a sixteenth of the full march cost
    finish = new MergedPass(bloom, rays)
    if (depth) { finish.dof = new DofGather(); finish.sheen = new TableSheen(); finish.camera = camera }
    composer.addPass(finish)
  } else {
    composer.addPass(new OutputPass())
    if (low) {
      fxaa = new ShaderPass(FXAAShader)
      composer.addPass(fxaa)
    }
    finish = new ShaderPass(FinishShader)
    composer.addPass(finish)
  }
  if (gtao) { finish.uniforms.tAO.value = gtao.pdRenderTarget.texture; gtao.enabled = false } // stage.js decides when it runs

  let curW = width, curH = height
  function setPixelRatio(d) {
    composer.setPixelRatio(d)
    composer.setSize(curW, curH)
    shrinkWrite()
    if (fxaa) fxaa.material.uniforms.resolution.value.set(1 / (curW * d), 1 / (curH * d))
    dpr = d
  }

  function setSize(w, h) {
    curW = w; curH = h
    composer.setSize(w, h)
    shrinkWrite()
    if (fxaa) fxaa.material.uniforms.resolution.value.set(1 / (w * dpr), 1 / (h * dpr))
  }
  setSize(width, height)

  return {
    composer, bloom, finish, gtao, rays, merged: merge, dof: depth ? finish.dof : null,
    setSize, setPixelRatio,
    render(dt, time) {
      finish.uniforms.uTime.value = time
      composer.render(dt)
    },
    dispose() {
      composer.passes.forEach((p) => p.dispose?.())
      rays?.dispose()
      finish.dof?.dispose(); finish.sheen?.dispose()
      rt.dispose()
      composer.renderTarget1.dispose()
      composer.renderTarget2.dispose()
    },
  }
}
