// Round 6 A: the light terrain shader for the far terrain cells (world.js). The island's own material on every cell cost
// +1.4 ms at F1 (7 lights, two VSM shadows, surface maps over most of the frame). This one: the rake (the low glow behind
// the ring, world.setRake), a warm falloff from the ring, a sky/ground ambient, a resin sheen toward the glow, per-cell
// tone, the scene's exp2 fog to the background, and the same build-in mask as the island (grow front + rise). No shadows.
import * as THREE from 'three'
import { RING } from '../stage/layout.js'

// Round 11: glowing seams (Igloo's lit cracks, echoing the ring): the cut between cells carries a thin warm light, brightest
// near the ring stand and fading out over ~1.5 m; a third of the cells keep a faint steady line, and a slow pulse rolls out
// from the ring through all of them (one ring of light every ~9 s). Rides the tops' existing ~1.5 px outline mask (no
// extra derivatives), near cells only and never at grazing angles (same guard as the lit rims). Additive HDR under the
// bloom threshold except at the pulse's crest. Shared with world.js (island blocks). uSeamK 0 (?off=seamglow) = off, same program.
export const SEAM_GLSL = /* glsl */ `
  vec3 seamGlow(vec3 w, vec2 cellC, vec3 n, float rim) {
    vec2 rs = vec2(${RING.pos.x.toFixed(3)}, ${RING.pos.z.toFixed(3)});
    float d = length(w.xz - rs);
    float pick = step(0.62, fract(sin(dot(cellC, vec2(41.3, 289.1))) * 43758.5453));
    float ph = d * 3.4 - uAmbT * 0.7;
    float pulse = pow(0.5 + 0.5 * sin(ph), 8.0);
    vec3 vd = normalize(cameraPosition - w);
    float nk = (1.0 - smoothstep(1.8, 4.5, length(cameraPosition - w))) * smoothstep(0.06, 0.22, abs(dot(n, vd)));
    float k = rim * nk * exp(-d * 0.6) * (0.26 * pick + 1.3 * pulse * (0.25 + 0.75 * pick));
    return vec3(1.0, 0.68, 0.38) * k * uSeamK;
  }`


/**
 * @param {object} U world.js uniforms (uGrow, uO, uAniso, uTerrK, uRise, uBand, uBandP)
 * @param {THREE.Color} albedo the edge blocks' colour
 * @param {THREE.Color} bg the scene background (fog colour, shared)
 * @param {object} TU { uRakeDir, uRakeK }
 */
export function createTerrainMaterial(U, albedo, bg, TU, P2 = true) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uGrow: U.uGrow, uO: U.uO, uAniso: U.uAniso, uTerrK: U.uTerrK, uRise: U.uRise, uBand: U.uBand, uBandP: U.uBandP,
      uRakeDir: TU.uRakeDir, uRakeK: TU.uRakeK, uBg: { value: bg },
      uAlb: { value: albedo.clone().multiplyScalar(P2 ? 0.38 : 0.6) }, // = the island blocks' terrain darkening (world.js vFlT)
      uRing: { value: RING.pos.clone() }, uW2: { value: P2 ? 1 : 0 }, uAmbT: U.uAmbT, uAmb: U.uAmb, uSeamK: U.uSeamK,
    },
    vertexShader: /* glsl */ `
      uniform float uGrow; uniform vec2 uO; uniform vec2 uAniso; uniform float uTerrK; uniform float uRise; uniform float uAmbT; uniform float uAmb;
      varying vec3 vW; varying vec3 vN; varying float vH; varying vec2 vC; varying vec2 vS; varying float vTop;
      void main(){
        vec2 ib = instanceMatrix[3].xz;
        float h = fract(sin(dot(ib, vec2(127.1, 311.7))) * 43758.5453);
        vH = h; vC = ib; vS = 0.5 * vec2(length(instanceMatrix[0].xyz), length(instanceMatrix[2].xyz));
        float k = clamp((uGrow - length((ib - uO) * uAniso) * uTerrK) / (0.05 + 0.05 * h), 0.0, 1.0);
        vec4 w = modelMatrix * instanceMatrix * vec4(position, 1.0);
        w.y -= uRise * 0.07 * (1.0 - k * k * (3.0 - 2.0 * k));
        w.y += uAmb * 0.004 * sin(uAmbT * (0.55 + 0.3 * h) + h * 6.2831) * step(0.0, position.y); // round 7: the cells breathe (Igloo #5: a few mm, 7-11 s)
        vW = w.xyz; vN = normal; // unit boxes, translated + scaled only: the object normal is the world normal
        vTop = w.y + (0.5 - position.y) * length(instanceMatrix[1].xyz); // round 11: this cell's top (the riser seams)
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uGrow; uniform vec2 uO; uniform vec2 uAniso; uniform float uTerrK; uniform float uBand; uniform vec3 uBandP;
      uniform vec3 uRakeDir; uniform float uRakeK; uniform vec3 uBg; uniform vec3 uAlb; uniform vec3 uRing; uniform float uW2; uniform float uAmbT; uniform float uAmb;
      float h2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float vn(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(h2(i), h2(i + vec2(1.0, 0.0)), f.x), mix(h2(i + vec2(0.0, 1.0)), h2(i + vec2(1.0, 1.0)), f.x), f.y); }
      varying vec3 vW; varying vec3 vN; varying float vH; varying vec2 vC; varying vec2 vS; varying float vTop;
      uniform float uSeamK;
      ${SEAM_GLSL}
      void main(){
        float cd = length((vC - uO) * uAniso) * uTerrK;
        if (cd > uGrow) discard;
        vec3 N = normalize(vN);
        vec3 V = normalize(cameraPosition - vW);
        vec3 alb = uAlb * (0.85 + 0.3 * vH);
        // light: the rake (warm, low, from the ring's side), the ring's own warm spill (inverse square, soft), sky ambient
        // (three's units: irradiance x albedo / pi, as the island's material) + the studio's cool rim and soft fill, so the
        // first cells (island material) and these meet without a step
        vec3 rake = vec3(1.0, 0.85, 0.69) * uRakeK * max(dot(N, uRakeDir), 0.0);
        vec3 rim = vec3(0.6, 0.666, 0.8) * max(dot(N, vec3(-0.565, 0.432, 0.707)), 0.0);
        vec3 fill = vec3(0.34, 0.325, 0.306) * max(dot(N, vec3(0.715, 0.506, 0.536)), 0.0);
        vec3 lr = uRing - vW; float d2 = dot(lr, lr);
        vec3 ring = vec3(1.0, 0.62, 0.3) * 0.6 * max(dot(N, lr * inversesqrt(d2)), 0.0) / (d2 + 0.2);
        vec3 amb = mix(vec3(0.05, 0.055, 0.065), vec3(0.16, 0.17, 0.2), N.y * 0.5 + 0.5); // ~ the room env at 0.4
        // round 7: slow cloud-light sweeping the terrain (soft pools drifting ~3 cm/s): the rake and the sky breathe in and out
        float pool = uAmb > 0.0 ? smoothstep(0.3, 0.85, vn(vW.xz * 0.45 + uAmbT * vec2(0.03, 0.017))) : 0.5;
        rake *= 0.55 + 0.9 * pool; amb *= 0.85 + 0.3 * pool;
        vec3 c = alb * ((rake + rim + fill + ring) * 0.3183 + amb);
        if (uW2 > 0.0) c *= 1.0 - 0.55 * (1.0 - smoothstep(0.3, 0.6, N.y)); // pass 2: deep sides, light on the rims
        vec2 lcR = vW.xz - vC; vec2 epR = (vS - abs(lcR)) / max(fwidth(lcR), vec2(1e-5)); // (derivatives outside the branch)
        float rkR = step(0.5, N.y) * (1.0 - smoothstep(0.6, 2.4, min(epR.x, epR.y)));
        if (uW2 > 0.0 && N.y > 0.5) { // pass 2: a thin rim of light on each top's outline (~1.5 px), brightest on the edges facing
          // the rake: the cells read as cut, lit edges on dark faces instead of lit cream blocks
          vec2 lc = lcR; vec2 ep = epR;
          float k = rkR;
          vec2 ne = ep.x < ep.y ? vec2(sign(lc.x), 0.0) : vec2(0.0, sign(lc.y));
          float face = 0.25 + 0.75 * max(dot(ne, normalize(uRakeDir.xz + 1e-5)), 0.0);
          // near cells only, and not at grazing angles (a far top seen edge-on is all edge: it drew long bright dashes)
          float nk = (1.0 - smoothstep(1.2, 3.5, length(cameraPosition - vW))) * smoothstep(0.12, 0.35, dot(N, V));
          c += vec3(1.0, 0.8, 0.6) * k * face * nk * (0.03 + 0.22 * uRakeK);
        }
        float lip = (1.0 - step(0.5, N.y)) * (1.0 - smoothstep(0.6, 2.2, (vTop - vW.y) / max(fwidth(vW.y), 1e-5))); // riser lips
        if (uSeamK > 0.0) c += seamGlow(vW, vC, N, max(rkR, lip)); // round 11: the glowing seams carry on out here
        // resin sheen: the low glow mirrored in the tops (Schlick, a broad lobe)
        vec3 H = normalize(uRakeDir + V);
        float fr = 0.04 + 0.96 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
        c += vec3(1.0, 0.8, 0.6) * uRakeK * fr * pow(max(dot(N, H), 0.0), 24.0) * 0.35 * step(0.5, N.y);
        c += vec3(0.02, 0.03, 0.05) * fr * step(0.5, N.y) * 0.5; // the sky in the tops at grazing angles
        // build-in front (as the island's): a hot band riding the front + a warm wake
        float band = 0.25 * uBand * (1.0 - smoothstep(0.0, uBandP.x, uGrow - cd)); // big cells: a hot front on them glared
        band *= mix(1.0, step(0.5, N.y) * (0.05 + 2.4 * rkR), uW2); // round 8: the front rides the tops' rims only
        c += (vec3(1.0, 0.76, 0.5) * band * uBandP.y + vec3(1.0, 0.62, 0.32) * 0.5 * uBand * uBandP.z * exp(-(uGrow - cd) / 0.3) * mix(1.0, step(0.5, N.y) * (0.05 + 1.4 * rkR), uW2)) * alb * 8.0;
        // scene fog (studio FogExp2 0.1 to the background colour)
        float fd = length(cameraPosition - vW) * 0.1;
        c = mix(c, uBg, 1.0 - exp(-fd * fd));
        gl_FragColor = vec4(c, 1.0);
      }`,
  })
}
