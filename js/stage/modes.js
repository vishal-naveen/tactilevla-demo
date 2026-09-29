// Per-chapter scene modes: which loop runs, where the arm parks, what the grid/FX show.
export const LOOPS = {
  hero: ['B2', 'A1', 'B2', 'C3', 'B2', 'A3', 'B2', 'C1'],
  calm: ['B2', 'C2', 'B2', 'A1', 'B2', 'C3', 'B2', 'A2'],
  test: ['B2'],
  slow: ['B2', 'A3', 'B2', 'C1', 'B2', 'A1', 'B2', 'C3'],
}

const base = {
  shot: 'hero', loop: null, speed: 1, pose: 'home', noodle: 'auto', noodleCell: 'B2',
  line: 0.4, fill: 0.6, label: 0, cross: 0.7, dim: 0, pulse: 0.25,
  dots: 0, arcs: 0, path: 0, kick: 1, exposure: 1, testLight: 0, heat: 0, frustum: 0, trail: 0, explode: 0, ringFull: 0,
  ambient: false, orbit: false, drift: true, gauges: false, phases: null,
}

const M = (o) => ({ ...base, ...o })

export const MODES = {
  hero: M({ shot: 'hero', loop: 'hero', speed: 1, line: 0.45, fill: 0.5, pulse: 0.3, phases: 'subtle' }),
  arm: M({ shot: 'arm', pose: 'home', noodle: 'table', line: 0.18, fill: 0.25, pulse: 0.1, explode: 1, kick: 2.6 }),
  data: M({ shot: 'data', pose: 'rest', noodle: 'hidden', line: 1, fill: 1, label: 1, cross: 0, dots: 1, arcs: 1, path: 1, pulse: 0.2 }),
  sees: M({ shot: 'sees', pose: 'sees', noodle: 'sees', line: 0.5, fill: 0.5, label: 0, pulse: 0.1, frustum: 1 }),
  policies: M({ shot: 'policies', loop: 'calm', speed: 0.78, line: 0.35, fill: 0.4, pulse: 0.2, trail: 1, gauges: true }),
  test: M({ shot: 'test', loop: 'test', speed: 0.9, line: 0.9, fill: 0.9, label: 1, dim: 1, pulse: 1, testLight: 1 }),
  results: M({ shot: 'results', loop: 'slow', speed: 0.6, line: 0.3, fill: 0.35, pulse: 0.15, exposure: 0.85, ambient: true }),
  film: M({ shot: 'film', loop: 'slow', speed: 0.6, line: 0.3, fill: 0.35, pulse: 0.15, exposure: 0.85, ambient: true }),
  limits: M({ shot: 'limits', pose: 'rest', noodle: 'hidden', speed: 0.6, line: 0.22, fill: 0.25, pulse: 0.1, exposure: 0.85, ringFull: 1 }),
  touch: M({ shot: 'touch', pose: 'touch', noodle: 'held', line: 0.2, fill: 0.25, pulse: 0.1, heat: 1, kick: 1.5 }),
  sandbox: M({ shot: 'sandbox', pose: 'rest', noodle: 'hidden', speed: 0.85, line: 0.85, fill: 0.9, label: 1, pulse: 0.35, orbit: true, drift: false, gauges: true, phases: 'full' }),
}

/** Smoothly-approached scene parameters (every key that varies continuously). */
export const PARAM_KEYS = ['line', 'fill', 'label', 'cross', 'dim', 'pulse', 'dots', 'arcs', 'path', 'ringFull', 'kick', 'exposure', 'testLight', 'heat', 'frustum', 'trail']
