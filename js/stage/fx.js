// Post-processing: MSAA scene -> dual-filter bloom -> tone map/sRGB -> (FXAA on low-end) -> vignette + film grain.
import * as THREE from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { DualBloomPass } from './bloom.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js'
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js'

const FinishShader = {
  uniforms: { tDiffuse: { value: null }, uTime: { value: 0 }, uGrain: { value: 0.03 }, uVig: { value: 0.5 } },
  vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse; uniform float uTime; uniform float uGrain; uniform float uVig;
    varying vec2 vUv;
    float hash(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
    void main(){
      vec4 c = texture2D(tDiffuse, vUv);
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

const MB = 1024 * 1024

/**
 * GPU memory (MB) the render pipeline holds for a drawing buffer of W x H device pixels: the MSAA half-float scene target
 * (resolve texture + N-sample colour + N-sample depth renderbuffers), the 8-bit finish target, the half-float bloom chain
 * (~1/3 of a full target), the canvas back buffers, and the two VSM shadow targets (map + blur pass, 16 B/texel).
 * Used to pick an iOS-safe DPR / sample count / shadow size before anything is allocated.
 */
export function estimateGpuMB(W, H, { samples = 2, low = false, shadowSize = 2048 } = {}) {
  const px = W * H
  const scene = px * 8 + (samples > 0 ? samples * px * (8 + 4) : px * 4)
  const out = low ? px * (8 + 4) : px * 4
  const bloom = px * 8 * 0.34
  const back = px * 4 * 2
  const shadow = shadowSize * shadowSize * 16
  return (scene + out + bloom + back + shadow) / MB
}

export function createFX(renderer, scene, camera, { low, width, height, dpr, samples = low ? 0 : 2 }) {
  const rt = new THREE.WebGLRenderTarget(width * dpr, height * dpr, { type: THREE.HalfFloatType, samples })
  const composer = new EffectComposer(renderer, rt)
  // Only the scene pass needs MSAA + depth. It renders into the composer's read buffer, and the two swapping passes
  // (OutputPass, finish) keep that buffer stable; the FXAA path (odd swap count) alternates buffers, so it keeps both full.
  composer.readBuffer.samples = samples
  composer.writeBuffer.samples = 0
  if (!low) {
    // The write buffer only ever holds the tone-mapped, sRGB-encoded OutputPass result: 8 bit is exactly what the canvas
    // stores anyway (the finish pass adds dither grain), and it needs no depth. Saves ~ 8 B/px on a phone.
    composer.renderTarget1.depthBuffer = false
    composer.renderTarget1.texture.type = THREE.UnsignedByteType
  }
  composer.setPixelRatio(dpr)
  composer.setSize(width, height)
  composer.addPass(new RenderPass(scene, camera))

  // Bloom starts at half resolution with a proper prefilter and a smooth tent upsample (see bloom.js).
  const bloom = new DualBloomPass(new THREE.Vector2(width * dpr, height * dpr).multiplyScalar(0.5), 0.45, 0.32, 1.6)
  composer.addPass(bloom)
  composer.addPass(new OutputPass())

  let fxaa = null
  if (low) {
    fxaa = new ShaderPass(FXAAShader)
    composer.addPass(fxaa)
  }
  const finish = new ShaderPass(FinishShader)
  composer.addPass(finish)

  let curW = width, curH = height
  function setPixelRatio(d) {
    composer.setPixelRatio(d)
    composer.setSize(curW, curH)
    if (fxaa) fxaa.material.uniforms.resolution.value.set(1 / (curW * d), 1 / (curH * d))
    dpr = d
  }

  function setSize(w, h) {
    curW = w; curH = h
    composer.setSize(w, h)
    if (fxaa) fxaa.material.uniforms.resolution.value.set(1 / (w * dpr), 1 / (h * dpr))
  }
  setSize(width, height)

  return {
    composer, bloom, finish,
    setSize, setPixelRatio,
    render(dt, time) {
      finish.uniforms.uTime.value = time
      composer.render(dt)
    },
    dispose() {
      composer.passes.forEach((p) => p.dispose?.())
      rt.dispose()
      composer.renderTarget1.dispose()
      composer.renderTarget2.dispose()
    },
  }
}
