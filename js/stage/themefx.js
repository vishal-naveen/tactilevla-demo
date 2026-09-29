// Theme controller: tweens every stage colour/intensity from js/themes.js THEMES[name].stage (~0.6 s).
import * as THREE from 'three'
import { THEMES, DEFAULT_THEME } from '../themes.js'
import { PAL } from './palette.js'

const COLOR_KEYS = ['background', 'fog', 'table', 'ring', 'key', 'fill', 'rim', 'trained', 'held', 'accent', 'arc', 'trail', 'frustum']
const TWEEN_S = 0.6
const smooth = (t) => t * t * (3 - 2 * t)

function parse(stage) {
  const o = { colors: {}, exposure: stage.exposure ?? 1, bloom: stage.bloom ?? 1 }
  for (const k of COLOR_KEYS) o.colors[k] = new THREE.Color(stage[k])
  const bg = o.colors.background // linear luminance of the backdrop decides dark vs light studio
  o.light = 0.2126 * bg.r + 0.7152 * bg.g + 0.0722 * bg.b > 0.3 ? 1 : 0
  return o
}

export function createThemeFX({ studio, ground, fx }) {
  const cur = { colors: Object.fromEntries(COLOR_KEYS.map((k) => [k, new THREE.Color()])), exposure: 1, bloom: 1, light: 0 }
  let from = null
  let to = null
  let t = 1
  let name = null

  function apply() {
    for (const k of ['trained', 'held', 'accent', 'arc', 'trail', 'frustum']) PAL[k].copy(cur.colors[k])
    PAL.light = cur.light
    PAL.stamp++
    studio.applyTheme(cur.colors, cur.light)
    ground.applyTheme(cur.colors.table, cur.light)
    fx.bloom.strength = 0.45 * cur.bloom
    fx.finish.uniforms.uVig.value = 0.5 + (0.16 - 0.5) * cur.light // no grey corners on a bright set
  }

  function snapshot() {
    return { colors: Object.fromEntries(COLOR_KEYS.map((k) => [k, cur.colors[k].clone()])), exposure: cur.exposure, bloom: cur.bloom, light: cur.light }
  }

  return {
    /** @returns {boolean} whether the name was known */
    set(next, instant = false) {
      const theme = THEMES[next] ?? THEMES[DEFAULT_THEME]
      const known = !!THEMES[next]
      name = known ? next : DEFAULT_THEME
      to = parse(theme.stage)
      from = snapshot()
      t = instant ? 1 : 0
      if (t >= 1) { // jump straight to the target
        for (const k of COLOR_KEYS) cur.colors[k].copy(to.colors[k])
        cur.exposure = to.exposure; cur.bloom = to.bloom; cur.light = to.light
        apply()
      }
      return known
    },
    update(dt) {
      if (t >= 1) return
      t = Math.min(1, t + dt / TWEEN_S)
      const e = smooth(t)
      for (const k of COLOR_KEYS) cur.colors[k].copy(from.colors[k]).lerp(to.colors[k], e)
      cur.exposure = from.exposure + (to.exposure - from.exposure) * e
      cur.bloom = from.bloom + (to.bloom - from.bloom) * e
      cur.light = from.light + (to.light - from.light) * e
      apply()
    },
    get exposure() { return cur.exposure },
    get name() { return name },
  }
}
