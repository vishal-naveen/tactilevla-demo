// Round 7 A: ambient motes. Fine warm specks drifting through the ring's light, over the table and out over the terrain,
// slow (periods 9-20 s), brighter near the ring, and focus-aware: a mote far from the focal distance grows into a soft
// disc of the same energy (so the macro shots, the dive and B2, carry drifting bokeh). One Points draw, additive, compiled
// at load; time comes from the world's ambient clock (uAmbT).
import * as THREE from 'three'
import { RING } from '../stage/layout.js'

export function createMotes(uAmbT, { count = 1400 } = {}) {
  let s = 0x5eed
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 }
  const pos = new Float32Array(count * 3), seed = new Float32Array(count * 4)
  for (let i = 0; i < count; i++) {
    const wide = i % 3 === 0 // a third of them spread out over the terrain (sparse), the rest round the island and the ring
    const x = wide ? -2.5 + rnd() * 5 : -0.75 + rnd() * 1.6
    const z = wide ? -2.5 + rnd() * 5 : -0.7 + rnd() * 1.8
    pos.set([x, 0.01 + rnd() * (wide ? 0.9 : 0.55), z], i * 3)
    seed.set([rnd(), rnd(), rnd(), rnd() ** 2], i * 4)
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setAttribute('seed', new THREE.BufferAttribute(seed, 4))
  const mat = new THREE.ShaderMaterial({
    uniforms: { uAmbT, uHalfH: { value: 450 }, uRing: { value: RING.pos.clone() }, uFocusAt: { value: new THREE.Vector3(0.15, 0.12, 0.05) }, uK: { value: 1 } },
    vertexShader: /* glsl */ `
      attribute vec4 seed; uniform float uAmbT; uniform float uHalfH; uniform vec3 uRing; uniform vec3 uFocusAt;
      varying float vA; varying float vS;
      void main(){
        float t = uAmbT;
        vec3 p = position;
        // slow drift: a lazy loop per mote + a gentle rise that wraps (never a jump: faded at both ends)
        float w1 = 6.2831 / (9.0 + 11.0 * seed.x), ph = seed.y * 6.2831;
        p.x += 0.035 * sin(t * w1 + ph) + 0.02 * sin(t * w1 * 0.37 + ph * 2.0);
        p.z += 0.035 * cos(t * w1 * 0.83 + ph);
        float rise = fract(seed.z + t * (0.004 + 0.006 * seed.w));
        p.y += rise * 0.12;
        float life = smoothstep(0.0, 0.15, rise) * smoothstep(1.0, 0.8, rise);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        float z = -mv.z;
        // focus-aware size: the focal distance = the camera to the subject; out of focus -> a bigger, dimmer disc
        float fz = length(cameraPosition - uFocusAt);
        float coc = abs(1.0 - fz / max(z, 0.02)) * 9.0;
        float px = clamp((0.9 + 1.4 * seed.w) * uHalfH / 450.0 + coc * uHalfH / 450.0, 1.0, 22.0);
        gl_PointSize = px;
        vS = px;
        // brighter in the ring's light, faint elsewhere; energy kept as the disc grows
        float dr = length(p - uRing);
        float lit = 0.45 + 1.3 * exp(-dr * dr / 0.18);
        // out-of-focus discs keep more than their area share (bokeh reads as soft light, not as nothing)
        vA = life * lit * (0.5 + seed.w) * 1.7 / pow(px, 1.35) * (z > 0.03 ? 1.0 : 0.0);
        vA *= mix(1.6, 6.0, smoothstep(2.0, 8.0, px)); // bokeh discs carry the dreamy depth; in-focus specks stay fine
      }`,
    fragmentShader: /* glsl */ `
      uniform float uK; varying float vA; varying float vS;
      void main(){
        vec2 d = gl_PointCoord * 2.0 - 1.0; float r = dot(d, d);
        if (r > 1.0) discard;
        float disc = vS > 3.0 ? smoothstep(1.0, 0.7, r) * (0.75 + 0.25 * r) : exp(-r * 3.0); // bokeh: a soft-rimmed disc
        gl_FragColor = vec4(vec3(1.0, 0.78, 0.52) * vA * disc * uK, 1.0);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
  })
  const pts = new THREE.Points(g, mat)
  pts.frustumCulled = false
  pts.userData.noAO = true
  pts.renderOrder = 3
  pts.name = 'flight-motes'
  return { points: pts, material: mat }
}
