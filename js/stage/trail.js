// Action-chunk trail: n glowing points sampled along the gripper tip's future path at 1/30 s spacing.
import * as THREE from 'three'
import { HZ } from './tasks.js'
import { PAL, isLightPal } from './palette.js'

const MAX = 100

export function createTrail(scene) {
  const pos = new Float32Array(MAX * 3)
  const idx = new Float32Array(MAX)
  for (let i = 0; i < MAX; i++) idx[i] = i + 1
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geo.setAttribute('aIdx', new THREE.BufferAttribute(idx, 1))
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
    uniforms: {
      uCount: { value: 100 }, uPx: { value: 1 }, uAlpha: { value: 0 }, uLight: { value: 0 },
      uColor: { value: new THREE.Color(1.0, 0.82, 0.38) },
    },
    vertexShader: /* glsl */ `
      attribute float aIdx; uniform float uCount; uniform float uPx; varying float vA;
      void main(){
        float f = aIdx / uCount;
        float present = smoothstep(uCount + 0.5, uCount - 1.5, aIdx);
        vA = (1.0 - f) * present;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = uPx * (3.0 + 8.0 * (1.0 - f)) * (0.35 + 0.65 * present) * (0.8 / max(0.2, -mv.z));
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; uniform float uAlpha; uniform float uLight; varying float vA;
      void main(){
        vec2 p = gl_PointCoord - 0.5;
        float d = length(p);
        float a = smoothstep(0.5, 0.0, d);
        // colour + alpha (works for additive glow on dark and normal-blended ink on light)
        float k = mix((1.2 + 2.6 * vA) * 1.6, 1.0, uLight);
        float al = a * mix(vA, 0.45 + 0.55 * vA, uLight) * uAlpha;
        gl_FragColor = vec4(uColor * k, clamp(al, 0.0, 1.0));
      }`,
  })
  const points = new THREE.Points(geo, mat)
  points.frustumCulled = false
  points.renderOrder = 6
  points.visible = false
  scene.add(points)

  let n = 100
  const a = new THREE.Vector3(), b = new THREE.Vector3()
  return {
    points,
    setPixelRatio(px) { mat.uniforms.uPx.value = px },
    /** planTime: seconds into the current plan or null. */
    update(dt, { plan, planTime, targetN, alpha, color }) {
      n += (targetN - n) * (1 - Math.exp(-dt * 4.5))
      const light = isLightPal()
      if (mat.userData.light !== light) { mat.userData.light = light; mat.blending = light ? THREE.NormalBlending : THREE.AdditiveBlending; mat.needsUpdate = true }
      mat.uniforms.uLight.value = PAL.light
      mat.uniforms.uCount.value = n
      mat.uniforms.uAlpha.value = alpha
      mat.uniforms.uColor.value.lerp(color, 1 - Math.exp(-dt * 5))
      points.visible = alpha > 0.01 && !!plan
      if (!points.visible) return
      const path = plan.tcpPath
      const last = path.length / 3 - 1
      const f0 = planTime * HZ
      for (let i = 0; i < MAX; i++) {
        const f = Math.min(last, f0 + i + 1)
        const i0 = Math.floor(f), i1 = Math.min(last, i0 + 1), s = f - i0
        a.fromArray(path, i0 * 3); b.fromArray(path, i1 * 3)
        a.lerp(b, s)
        pos[i * 3] = a.x; pos[i * 3 + 1] = a.y; pos[i * 3 + 2] = a.z
      }
      geo.attributes.position.needsUpdate = true
    },
    dispose() { geo.dispose(); mat.dispose(); points.removeFromParent() },
  }
}
