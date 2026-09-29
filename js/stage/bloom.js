// Dual-filter bloom (13-tap Karis-averaged downsample chain + 9-tap tent upsample chain).
//
// Replaces three's UnrealBloomPass, whose gaussian mips start at 1/4 resolution and are magnified with plain bilinear
// filtering: a 1 px HDR line (the camera frustum edges) sampled at 1/4 resolution without a prefilter becomes isolated
// hot texels, and the coarse levels (12x21 texels on a phone) magnify into hard-edged, stair-stepped squares. Here every
// level is a properly prefiltered average of the one above, and every upsample is a smooth tent, so a glow is always a
// soft round falloff regardless of resolution or how the GPU filters half-float textures.
//
// Also cheaper on memory: one half-float chain starting at 1/2 resolution (~1/3 of a full-size target in total).
import * as THREE from 'three'
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js'

const VERT = /* glsl */ `
varying vec2 vUv;
void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`

const DOWN_FRAG = /* glsl */ `
uniform sampler2D tSrc; uniform vec2 uTexel; uniform float uThr; uniform float uKnee;
varying vec2 vUv;
float luma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 fetch(vec2 o){
  vec3 c = texture2D(tSrc, vUv + o * uTexel).rgb;
  #ifdef FIRST
    // soft-knee threshold: continuous in the pixel value, so a 1 px line at 40% coverage still contributes proportionally
    float l = max(luma(c), 1e-4);
    float s = clamp(l - uThr + uKnee, 0.0, 2.0 * uKnee);
    s = s * s / (4.0 * uKnee + 1e-4);
    c *= max(s, l - uThr) / l;
  #endif
  return min(c, vec3(64.0)); // half-float safe
}
void main(){
  vec3 a = fetch(vec2(-2.0,-2.0)), b = fetch(vec2(0.0,-2.0)), c = fetch(vec2(2.0,-2.0));
  vec3 d = fetch(vec2(-2.0, 0.0)), e = fetch(vec2(0.0, 0.0)), f = fetch(vec2(2.0, 0.0));
  vec3 g = fetch(vec2(-2.0, 2.0)), h = fetch(vec2(0.0, 2.0)), i = fetch(vec2(2.0, 2.0));
  vec3 j = fetch(vec2(-1.0,-1.0)), k = fetch(vec2(1.0,-1.0));
  vec3 l = fetch(vec2(-1.0, 1.0)), m = fetch(vec2(1.0, 1.0));
  #ifdef FIRST
    // Karis average: weight each 2x2 group by 1/(1+luma) so a single hot pixel cannot dominate (no fireflies, no blocks)
    vec3 g0 = (a + b + d + e) * 0.25, g1 = (b + c + e + f) * 0.25, g2 = (d + e + g + h) * 0.25, g3 = (e + f + h + i) * 0.25, g4 = (j + k + l + m) * 0.25;
    float w0 = 0.125 / (1.0 + luma(g0)), w1 = 0.125 / (1.0 + luma(g1)), w2 = 0.125 / (1.0 + luma(g2)), w3 = 0.125 / (1.0 + luma(g3)), w4 = 0.5 / (1.0 + luma(g4));
    vec3 o = (g0 * w0 + g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4) / (w0 + w1 + w2 + w3 + w4);
  #else
    vec3 o = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  #endif
  gl_FragColor = vec4(o, 1.0);
}`

const UP_FRAG = /* glsl */ `
uniform sampler2D tSrc; uniform vec2 uTexel; uniform float uGain;
varying vec2 vUv;
void main(){
  vec3 s = texture2D(tSrc, vUv + vec2(-1.0, 1.0) * uTexel).rgb + texture2D(tSrc, vUv + vec2(1.0, 1.0) * uTexel).rgb
         + texture2D(tSrc, vUv + vec2(-1.0,-1.0) * uTexel).rgb + texture2D(tSrc, vUv + vec2(1.0,-1.0) * uTexel).rgb;
  vec3 e = texture2D(tSrc, vUv + vec2(0.0, 1.0) * uTexel).rgb + texture2D(tSrc, vUv + vec2(0.0,-1.0) * uTexel).rgb
         + texture2D(tSrc, vUv + vec2(-1.0, 0.0) * uTexel).rgb + texture2D(tSrc, vUv + vec2(1.0, 0.0) * uTexel).rgb;
  vec3 c = texture2D(tSrc, vUv).rgb;
  gl_FragColor = vec4((s + 2.0 * e + 4.0 * c) * (uGain / 16.0), 1.0);
}`

const FACTORS = [1.0, 0.8, 0.6, 0.4, 0.2] // same per-level weighting curve UnrealBloomPass used
const lerp = (a, b, t) => a * (1 - t) + b * t

export class DualBloomPass extends Pass {
  constructor(resolution, strength = 0.45, radius = 0.32, threshold = 1.6, levels = 5) {
    super()
    this.strength = strength
    this.radius = radius
    this.threshold = threshold
    this.knee = 0.5
    this.levels = levels
    this.needsSwap = false
    this.targets = []
    this._w = 0; this._h = 0
    const mk = (defines) => new THREE.ShaderMaterial({
      defines, vertexShader: VERT, fragmentShader: DOWN_FRAG, depthTest: false, depthWrite: false, blending: THREE.NoBlending,
      uniforms: { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uThr: { value: threshold }, uKnee: { value: 0.5 } },
    })
    this.firstMat = mk({ FIRST: 1 })
    this.downMat = mk({})
    const additive = { depthTest: false, depthWrite: false, blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor }
    this.upMat = new THREE.ShaderMaterial({ ...additive, vertexShader: VERT, fragmentShader: UP_FRAG, uniforms: { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uGain: { value: 1 } } })
    this.compMat = new THREE.ShaderMaterial({ ...additive, vertexShader: VERT, fragmentShader: UP_FRAG, uniforms: { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uGain: { value: 1 } } })
    this.quad = new FullScreenQuad(null)
    this.setSize(resolution.x * 2, resolution.y * 2)
  }

  /** Bytes of GPU memory held by the chain (half-float RGBA). */
  get bytes() { return this.targets.reduce((n, t) => n + t.width * t.height * 8, 0) }

  setSize(width, height) {
    width = Math.max(2, Math.round(width)); height = Math.max(2, Math.round(height))
    if (width === this._w && height === this._h && this.targets.length) return
    this._w = width; this._h = height
    this.targets.forEach((t) => t.dispose())
    this.targets = []
    let w = Math.ceil(width / 2), h = Math.ceil(height / 2)
    for (let i = 0; i < this.levels; i++) {
      const t = new THREE.WebGLRenderTarget(Math.max(2, w), Math.max(2, h), {
        type: THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
        depthBuffer: false, generateMipmaps: false,
      })
      t.texture.name = `bloom.L${i}`
      this.targets.push(t)
      w = Math.ceil(w / 2); h = Math.ceil(h / 2)
    }
  }

  render(renderer, writeBuffer, readBuffer) {
    const T = this.targets
    const n = T.length
    const oldAuto = renderer.autoClear
    renderer.autoClear = false
    const q = this.quad
    // downsample chain
    const dm = this.firstMat
    dm.uniforms.tSrc.value = readBuffer.texture
    dm.uniforms.uTexel.value.set(1 / readBuffer.width, 1 / readBuffer.height)
    dm.uniforms.uThr.value = this.threshold
    dm.uniforms.uKnee.value = this.knee
    q.material = dm
    renderer.setRenderTarget(T[0]); q.render(renderer)
    q.material = this.downMat
    for (let i = 1; i < n; i++) {
      const u = this.downMat.uniforms
      u.tSrc.value = T[i - 1].texture
      u.uTexel.value.set(1 / T[i - 1].width, 1 / T[i - 1].height)
      renderer.setRenderTarget(T[i]); q.render(renderer)
    }
    // upsample chain, accumulating level i+1 into level i with weight f(i+1)/f(i)
    const f = (i) => lerp(FACTORS[i] ?? 0.2, 1.2 - (FACTORS[i] ?? 0.2), this.radius)
    q.material = this.upMat
    for (let i = n - 2; i >= 0; i--) {
      const u = this.upMat.uniforms
      u.tSrc.value = T[i + 1].texture
      u.uTexel.value.set(1 / T[i + 1].width, 1 / T[i + 1].height)
      u.uGain.value = f(i + 1) / f(i)
      renderer.setRenderTarget(T[i]); q.render(renderer)
    }
    // composite onto the scene
    const cu = this.compMat.uniforms
    cu.tSrc.value = T[0].texture
    cu.uTexel.value.set(1 / T[0].width, 1 / T[0].height)
    cu.uGain.value = this.strength * f(0)
    q.material = this.compMat
    renderer.setRenderTarget(this.renderToScreen ? null : readBuffer)
    q.render(renderer)
    renderer.autoClear = oldAuto
  }

  dispose() {
    this.targets.forEach((t) => t.dispose())
    this.targets = []
    for (const m of [this.firstMat, this.downMat, this.upMat, this.compMat]) m.dispose()
    this.quad.dispose()
  }
}
