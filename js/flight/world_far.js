// Round 6 A: the distant world. A Cycles-rendered panorama (PC: render/r6a world_pc.py + compose.py + sky.py) of stepped
// mesas on the grid motif (cells 0.061 x 0.126 m x16), a misty valley and a low warm horizon glow behind the ring, drawn on
// a sphere (radius 18 m) around the flight camera region's centre C0, so it has a little parallax while the live terrain
// (world.js) carries the near parallax. Equirect in three's convention: u = (atan2(z, x) + pi) / 2pi, v = 0 at LAT1 down to
// LAT0 (linear in latitude); stored sRGB as linear radiance / G (8 bit, dithered). Outside the band: the top blends to the
// page background, the bottom holds the band's last row (mist). Placeholder first, KTX2 swaps in (a sampler: no recompile).
import * as THREE from 'three'

// pass 2 (default): the high-key panorama (world_far.ktx2, G 0.8: a lifted ink sky over a luminous gold/rose band, pale
// hazed distance, lit valley mist); ?off=world2 = pass 1 (world_far_p1.ktx2, G 0.35, dark backlit mesas)
export const P2 = !(new URLSearchParams(location.search).get('off')?.split(',') || []).includes('world2')
export const FAR = { C0: new THREE.Vector3(0.55, 0.28, -0.45), R: 18, LAT0: THREE.MathUtils.degToRad(-33), LAT1: THREE.MathUtils.degToRad(27), G: P2 ? 0.8 : 0.35, file: P2 ? 'world_far.ktx2' : 'world_far_p1.ktx2' }

const px = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1); px.needsUpdate = true

export const FAR_U = { tFar: { value: px }, uFarOn: { value: 0 }, uFarA: { value: 0 }, uFarG: { value: FAR.G } }

/** @param {THREE.Color} bg the scene background (shared, linear) */
export function createFar(bg, uAmbT = { value: 0 }, uAmb = { value: 0 }) {
  const mat = new THREE.ShaderMaterial({
    uniforms: { ...FAR_U, uBg: { value: bg }, uW2: { value: P2 ? 1 : 0 }, uAmbT, uAmb, uC0: { value: FAR.C0 }, uLat: { value: new THREE.Vector2(FAR.LAT0, FAR.LAT1) } },
    vertexShader: /* glsl */ `varying vec3 vW;
      void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: /* glsl */ `uniform sampler2D tFar; uniform float uFarOn; uniform float uFarA; uniform float uFarG; uniform vec3 uBg; uniform float uW2;
      uniform vec3 uC0; uniform vec2 uLat; varying vec3 vW; uniform float uAmbT; uniform float uAmb;
      float h2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float vn(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(h2(i), h2(i + vec2(1.0, 0.0)), f.x), mix(h2(i + vec2(0.0, 1.0)), h2(i + vec2(1.0, 1.0)), f.x), f.y); }
      void main(){
        vec3 d = normalize(vW - uC0);
        float lat = asin(clamp(d.y, -1.0, 1.0));
        vec2 uv = vec2(atan(d.z, d.x) / 6.2831853 + 0.5, clamp((uLat.y - lat) / (uLat.y - uLat.x), 0.0005, 0.9995));
        vec3 c = texture2D(tFar, uv).rgb * uFarG;
        // pass 1: the band's top meets the page background; pass 2: the lifted ink sky holds above it, deepening slowly
        c = uW2 > 0.0 ? mix(c, uBg * 4.0, smoothstep(uLat.y, uLat.y + 0.7, lat)) : mix(c, uBg, smoothstep(uLat.y - 0.06, uLat.y, lat));
        if (uAmb > 0.0 && uW2 > 0.0) {
          // round 7 ambient: mist bands drifting along the horizon at two speeds (the nearer layer faster: parallax), and slow
          // cloud shadows passing over the far mesas (periods of minutes; a few px per second on screen)
          float lon = atan(d.z, d.x), t = uAmbT;
          float band = exp(-pow((lat + 0.03) / 0.1, 2.0));
          float n1 = vn(vec2(lon * 7.0 + t * 0.010, lat * 26.0)), n2 = vn(vec2(lon * 15.0 - t * 0.024, lat * 48.0 + 7.0));
          float haze = band * smoothstep(0.3, 0.8, 0.6 * n1 + 0.4 * n2);
          c = mix(c, max(c * 1.4, vec3(0.11, 0.115, 0.135)), haze * 0.8);
          float cl = vn(vec2(lon * 3.0 + t * 0.006, 1.7));
          c *= mix(1.0, 0.86 + 0.24 * cl, smoothstep(0.08, -0.02, lat));
        }
        if (uW2 > 0.0) { // round 11 palette: the baked band's dusty-rose flanks read mauve beside the ring. Split-tone the
          // panorama into the page's two colours instead: ink blue in the shadows, warm ivory in the light, gold kept at the glow
          float lu = dot(c, vec3(0.2126, 0.7152, 0.0722));
          vec3 pal = lu * mix(vec3(0.8, 0.92, 1.22), vec3(1.1, 1.0, 0.84), smoothstep(0.04, 0.3, lu));
          float gold = smoothstep(0.08, 0.25, c.r - c.b) * smoothstep(-0.02, 0.06, c.g - c.b * 1.1); // already gold: keep
          c = mix(c, pal, 0.7 * (1.0 - gold));
        }
        gl_FragColor = vec4(mix(uBg, c, uFarA * uFarOn), 1.0);
      }`,
    side: THREE.BackSide, depthWrite: true, fog: false,
  })
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(FAR.R, 96, 48), mat)
  mesh.position.copy(FAR.C0)
  mesh.renderOrder = -10
  mesh.frustumCulled = false
  mesh.userData.noAO = true
  mesh.name = 'flight-far'
  return mesh
}

/** KTX2 (sRGB UASTC, no mips: it is always magnified) -> the sampler. Called from surface.js loadSurfaces. */
export function farTexture(t) {
  t.colorSpace = THREE.SRGBColorSpace
  t.wrapS = THREE.RepeatWrapping; t.wrapT = THREE.ClampToEdgeWrapping
  t.minFilter = THREE.LinearFilter; t.magFilter = THREE.LinearFilter; t.generateMipmaps = false
  FAR_U.tFar.value = t
  FAR_U.uFarOn.value = 1
}
