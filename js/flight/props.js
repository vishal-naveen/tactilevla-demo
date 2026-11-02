// Round 11 (flight.html only): small physical props that make the rig read as a real bench, plus the overhead stops'
// projector spill. Everything is plain geometry on two materials (compiled at load through stage.addToScene, no textures):
//  - a 4 mm anodised mounting plate under the base with four bolt heads (the SO-101 is bolted down, not floating),
//  - two cables (servo bus + USB) leaving the base's back, dropping to the table and running off the island past a small
//    bus-servo adapter board, as on the real bench,
//  - spill: the light a projector over the grid would throw round the cells (grid.js setGridStyle draws the cells
//    themselves), a soft additive pool driven per stop by the director (0 = off, zero cost: the mesh is hidden).
// The props appear with the arm (director: after the opening's print), cast + receive the key shadow, never move.
import * as THREE from 'three'
import { GRID_CENTER } from '../stage/layout.js'

const GLOW_FRAG = /* glsl */ `
uniform vec3 uColor; uniform float uA; uniform vec2 uO; uniform vec2 uS; varying vec2 vUv;
void main(){
  vec2 q = (vUv - uO) * uS;
  vec2 e = min(vUv, 1.0 - vUv);
  float k = exp(-dot(q, q)) * smoothstep(0.0, 0.06, e.x) * smoothstep(0.0, 0.06, e.y);
  gl_FragColor = vec4(uColor * (k * uA), 1.0);
}`
/** One additive glow program for every soft light pool on the table (runs screens, grid spill). */
export function glowMaterial(color, origin, scale) {
  return new THREE.ShaderMaterial({
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: GLOW_FRAG,
    uniforms: { uColor: { value: color.clone() }, uA: { value: 0 }, uO: { value: new THREE.Vector2(...origin) }, uS: { value: new THREE.Vector2(...scale) } },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
  })
}

export function createProps() {
  const group = new THREE.Group()
  group.name = 'bench-props'
  const dark = new THREE.MeshStandardMaterial({ color: 0x3b3f45, roughness: 0.42, metalness: 0.55 }) // anodised aluminium
  const cableMat = new THREE.MeshStandardMaterial({ color: 0x0b0c0d, roughness: 0.62, metalness: 0.0 })

  // mounting plate + bolts (the base link spans x -0.031..0.065, z +-0.055)
  const plate = new THREE.Mesh(new THREE.BoxGeometry(0.128, 0.004, 0.14), dark)
  plate.position.set(0.017, 0.002 - 0.0005, 0)
  const boltGeo = new THREE.CylinderGeometry(0.0042, 0.0042, 0.003, 12)
  for (const [x, z] of [[-0.04, -0.06], [-0.04, 0.06], [0.074, -0.06], [0.074, 0.06]]) {
    const b = new THREE.Mesh(boltGeo, dark); b.position.set(x, 0.005, z); group.add(b)
  }
  group.add(plate)

  // cables: out of the base's back, down to the table, off the island toward the far world (-x), past the adapter board
  const board = new THREE.Mesh(new THREE.BoxGeometry(0.046, 0.011, 0.034), dark)
  board.position.set(-0.19, 0.0055, 0.07); board.rotation.y = 0.35
  group.add(board)
  const tube = (pts, r) => new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(...p))), 96, r, 8), cableMat)
  group.add(tube([[-0.028, 0.032, 0.022], [-0.05, 0.03, 0.03], [-0.075, 0.012, 0.045], [-0.11, 0.003, 0.06], [-0.17, 0.003, 0.068]], 0.0026)) // bus -> board
  group.add(tube([[-0.21, 0.003, 0.078], [-0.3, 0.003, 0.1], [-0.45, 0.003, 0.08], [-0.62, 0.003, 0.13], [-0.85, 0.003, 0.11]], 0.0026)) // board -> supply
  group.add(tube([[-0.028, 0.024, -0.018], [-0.052, 0.018, -0.03], [-0.085, 0.004, -0.04], [-0.16, 0.0028, -0.02], [-0.3, 0.0028, -0.06], [-0.55, 0.0028, -0.03], [-0.85, 0.0028, -0.07]], 0.0021)) // USB
  group.visible = false

  // projector spill round the grid (overhead stops): a soft warm pool, wider than the 3x3, hottest at the grid centre
  const spillMat = glowMaterial(new THREE.Color(1.0, 0.92, 0.8), [0.5, 0.5], [2.3, 2.3])
  const spill = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.56).rotateX(-Math.PI / 2), spillMat)
  spill.position.set(GRID_CENTER.x, 0.0009, 0)
  spill.renderOrder = 1
  spill.userData.noAO = true
  spill.visible = false
  const fx = new THREE.Group(); fx.add(spill)

  return {
    group, fx,
    /** shown = the arm exists (after the opening's print); spillA = the projector spill level 0..1 */
    update(shown, spillA) {
      group.visible = shown
      spillMat.uniforms.uA.value = 0.07 * spillA
      spill.visible = spillA > 0.004
    },
  }
}
