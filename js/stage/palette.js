// Live, theme-driven colours shared by the scene modules. themefx.js tweens these in place; modules read them every
// frame (never clone at build time), so a theme change recolours everything without rebuilding anything.
import * as THREE from 'three'

export const PAL = {
  trained: new THREE.Color('#3fb39a'), // trained cells, dots
  held: new THREE.Color('#f08a24'), // B2
  accent: new THREE.Color('#f4c430'), // highlights, wrist camera
  arc: new THREE.Color('#8fe3cf'), // ghost arcs, SmolVLA trail
  trail: new THREE.Color('#ffe08a'), // ACT action-chunk trail
  frustum: new THREE.Color('#9ff0dc'), // overhead camera frustum
  light: 0, // 0 = dark studio, 1 = light studio (tweened): glow (additive) becomes ink (normal blending)
  stamp: 0, // bumped whenever any colour changed, so baked-in vertex colours know to repaint
}

/** Value that is `dark` in a dark studio and `light` in a light one (smoothly in between). */
export const mixL = (dark, light) => dark + (light - dark) * PAL.light
export const isLightPal = () => PAL.light > 0.5
