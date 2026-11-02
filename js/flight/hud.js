// Flight HUD: bench-instrument corners, the two-voice lines, the 4:3 overhead brackets, the episode counter, and the servo
// inspection callouts. Every callout string is computed from a real source at runtime (see buildCallouts); the provenance
// check (render/flight_check.mjs) re-derives each one and compares.
import { episodeAt, TOTAL_EPISODES } from '../stage/protocol.js'
import { PMAX } from './path.js'
import { scramble } from './scramble.js' // round 6: decode on entry (Igloo #7)
import { STOPS, mixWeights } from './nav.js' // round 12: text keyed to the camera's place between stops
// round 12: the COPY agent's js/flight/copy.js ({ intro, stops: [{ stop, kicker, headline, body, facts }] }, keyed by the
// nav.js STOPS index) when present; LINES below are the fallback
export const COPY = await import('./copy.js').then((m) => m.default).catch(() => null)
/** Stops 10+ (scenes 08-13) carry their own panels (scenes.js); the HUD text covers scenes 01-07 (round 13: 10 stops, was 14). */
export const HUD_STOPS = 10

const $ = (s) => document.querySelector(s)
const clamp01 = (x) => Math.min(1, Math.max(0, x))
const win = (p, a, b, f = 0.012) => clamp01(Math.min((p - a) / f, (b - p) / f)) // 0 -> 1 -> 0 over [a, b] with soft edges

// The big lines (Archivo wdth 125) and their small lines: copy condensed from index.html. `at`: where the frame is
// defocused / dark at that key.
export const LINES = [
  // round 6: one headline + one short line per hold (facts from the section copy below each scene, never new claims)
  { a: -0.02, b: 0.068, at: 'l', big: 'A robot arm that learns by watching.', small: 'Guided through one task 160 times, then tested on a spot it had never seen.' },
  { a: 0.082, b: 0.142, at: 'l', big: 'A sub-$300 arm.', small: '3D-printed links, six Feetech STS3215 servos. A person drives one arm by hand; the second arm copies it.' },
  { a: 0.212, b: 0.262, at: 'tl', big: 'One job: the noodle goes in the cup.', small: 'A run counts only if the noodle ends up in the cup.' },
  { a: 0.268, b: 0.318, at: 'tl', big: 'Eight cells teach. B2 stays empty.', small: 'A 3×3 grid, A1 to C3. The centre was left out on purpose.' },
  { a: 0.322, b: 0.452, at: 'l', narrow: true, big: '160 demonstrations, one hand at a time.', counter: true },
  { a: 0.5, b: 0.53, at: 'bl', big: '20 per cell. None in B2.', small: 'The noodle rotated through ±90° in 10° steps.' },
  { a: 0.528, b: 0.632, at: 'l', big: 'Two cameras. At the grasp, one goes blind.', small: 'Overhead and wrist, plus the arm’s own six joint positions.' },
  { a: 0.642, b: 0.702, at: 'l', big: 'Two policies, the same 160 episodes.', small: 'ACT, about 52M parameters. SmolVLA, about 450M.' },
  { a: 0.715, b: 0.87, at: 'tl', big: 'It never saw B2.', small: 'B2 appears in none of the 160 training episodes.' },
  { a: 0.874, b: 0.918, at: 'tl', big: 'It picked the noodle up anyway.', small: 'Both policies, several attempts each. Every one succeeded.' },
  // FULL SITE: scenes 08-13 carry their own panels (flight.html sections, js/flight/scenes.js): no more hand-off line
]
// small mono read-outs per range
const READOUTS = [
  // round 11b: 05 is no longer the overhead camera's view (a 3/4 over the table): no 4:3 bracket; the camera's 800×600 is
  // pinned on it at 05 two cameras (scenes.js PINS)
  // FULL SITE: frames / cameras / chunk specs moved into the scene cards; the honesty labels stay here
  { a: 0.322, b: 0.53, at: 'br2', lines: ['COUNTS REAL, POSITIONS ILLUSTRATIVE'] },
  { a: 0.642, b: 0.702, at: 'br2', lines: ['TRAIL ILLUSTRATES CHUNKING, NOT POLICY OUTPUT'] },
  { a: 0.72, b: 0.918, at: 'br2', lines: ['B2 LIGHT IS STAGED, RECONSTRUCTION'] },
  { a: 0.02, b: 0.075, at: 'br2', lines: [] }, // placeholder so the slot exists; filled with the reach envelope at load
]

const fmt = (x, d = 2) => (x >= 0 ? '+' : '−') + Math.abs(x).toFixed(d)

/** URDF facts for one joint, read from the URDF text itself (not from a table in this file). */
export function urdfJoint(urdfText, name) {
  const doc = new DOMParser().parseFromString(urdfText, 'application/xml')
  const j = [...doc.querySelectorAll('robot > joint')].find((e) => e.getAttribute('name') === name)
  const lim = j?.querySelector('limit')
  return j && lim ? { type: j.getAttribute('type'), lower: Number(lim.getAttribute('lower')), upper: Number(lim.getAttribute('upper')) } : null
}

/** The inspection callouts: [label, value, source] rows. `q` is filled per frame. */
export function buildCallouts(info) {
  const uj = urdfJoint(info.urdf, info.joint)
  const deg = (r) => Math.round((r * 180) / Math.PI)
  const [w, d, h] = info.sizeMM.map((v) => v.toFixed(1))
  return [
    { k: 'PART', v: info.file.toUpperCase(), src: 'urdf:mesh' },
    { k: 'SERVO', v: 'FEETECH STS3215', src: 'brief' },
    { k: 'JOINT', v: `${info.joint.toUpperCase()} · ${uj.type.toUpperCase()}`, src: 'urdf:joint' },
    { k: 'LIMITS', v: `${fmt(uj.lower)} … ${fmt(uj.upper)} RAD  (${fmt(deg(uj.lower), 0)}° … ${fmt(deg(uj.upper), 0)}°)`, src: 'urdf:limit' },
    { k: 'BBOX', v: `${w} × ${d} × ${h} MM`, src: 'box3' },
    { k: 'LINK', v: info.link.toUpperCase(), src: 'urdf:link' },
    { k: 'q', v: '', src: 'jointstate', live: true },
  ]
}

export function createHud({ envelope, quiet = false }) { // quiet: reduced motion / capture (no decode)
  const root = $('#fl-hud')
  const scene = $('#fl-scene'), bar = $('#fl-bar i')
  const counterEl = $('#fl-counter')
  const bracket = $('#fl-bracket'), ro = $('#fl-readout')
  const call = $('#fl-callouts'), svg = $('#fl-leader'), lead = svg.querySelector('path'), dot = svg.querySelector('circle')
  READOUTS[READOUTS.length - 1].lines = [`REACH / TOP-DOWN PICK / IK, NOT POLICY`, `ENVELOPE 0° ${envelope['0']} MM, ±45° ${envelope['45']}/${envelope['-45']} MM`]
  READOUTS[READOUTS.length - 1].a = -0.02; READOUTS[READOUTS.length - 1].b = 0.03 // FULL SITE: visible at the first stop (p 0)
  let sceneTxt = '', rows = null, rowEls = [], roIdx = -2, typed = 0, lastCount = -1

  // round 12 (owner: "explain it better ... if I scroll through too quick it messes everything up"): one prebuilt text
  // block per distinct stop text (kicker, headline, explanatory body, facts), all in the DOM from load. Each frame the two
  // blocks either side of the camera get an opacity from its place between their stops (nav.mix -> mixWeights); every
  // other block stays hidden. No clock, no exit-on-move / enter-after-settle, nothing queued: scrolling back and forth at
  // any speed only ever moves those two numbers, and two texts are never both visible (the windows leave a gap).
  const phoneNow = () => innerWidth < 700 || innerWidth / innerHeight < 1
  const lineAt = (p) => LINES.find((L) => p >= L.a - 1e-6 && p <= L.b + 1e-6)
  function textOf(i) {
    if (i >= HUD_STOPS) return null
    const L = lineAt(STOPS[i].p) || null
    const c = COPY?.stops?.find((x) => x.stop === i)
    const pos = { at: (L?.at) || 'l', narrow: !!L?.narrow, counter: !!L?.counter }
    if (c) {
      const intro = i === 0 && COPY.intro && !phoneNow() ? COPY.intro : null // the opening hold: what the project is, whole
      return { ...pos, kicker: c.kicker, big: c.headline, small: intro?.body || c.body, more: c.more || [], note: intro?.look || '', facts: (c.facts || []) }
    }
    return L ? { ...pos, kicker: L.kicker || '', big: L.big, small: L.small || '', more: [], note: '', facts: [] } : null
  }
  const host = document.createElement('div'); host.id = 'fl-text'; host.className = 'fl-text'
  $('#fl-lines')?.replaceWith(host) // the round 7 single line block is retired
  let blocks = [], blockOf = []
  function build() {
    host.innerHTML = ''; blocks = []; blockOf = []
    let prevKey = null
    for (let i = 0; i < STOPS.length; i++) {
      const T = textOf(i)
      if (!T) { blockOf.push(-1); prevKey = null; continue }
      const key = T.big + '|' + T.at
      if (key === prevKey) { blockOf.push(blocks.length - 1); continue }
      prevKey = key
      const el = document.createElement('div')
      el.className = 'fl-lines fl-tx at-' + T.at + (T.narrow ? ' narrow' : '') + (T.counter ? ' has-counter' : '') + (Math.abs(STOPS[i].p - 0.17) < 1e-6 ? ' ph-top' : '') // the servo inspection
      el.innerHTML = (T.kicker ? `<p class="fl-kicker">${T.kicker}</p>` : '') + `<h2 class="fl-big">${T.big}</h2>` +
        (T.small ? `<p class="fl-small">${T.small}</p>` : '') +
        T.more.map((m) => `<p class="fl-small fl-more2"><b>${m.headline}</b> ${m.body}</p>`).join('') + (T.note ? `<p class="fl-note-l">${T.note}</p>` : '') +
        (T.facts.length ? `<ul class="fl-facts">${T.facts.map((f) => `<li>${f}</li>`).join('')}</ul>` : '')
      if (T.counter && counterEl) el.appendChild(counterEl) // the 160 counter rides in its block, under the text
      el.style.setProperty('--a', '0'); el.style.visibility = 'hidden'
      host.appendChild(el)
      blocks.push({ el, a: 0, counter: T.counter })
      blockOf.push(blocks.length - 1)
    }
  }
  // Responsive fit (owner 2026-11-02: "make it responsive to all screen sizes"; on short windows the opening ran into the
  // top-left chip and the Explore / Sound controls). Desktop layout only (phones stack at the foot with their own clamps):
  // every block must sit between the top-left chrome (brand + the chip, which moves there at some stops) and the controls
  // above Sound. A block that doesn't fit gives way in order: fact tags, the note, type -10 %, type -20 %, the merged
  // paragraphs, a 4-line body. Then it is nudged inside the box. Measured at build, on resize and once fonts load.
  const FIT = ['fit-1', 'fit-2', 'fit-3', 'fit-4', 'fit-5', 'fit-6']
  // the fitted rects, cached for scenes.js: a pin label that would land on the text in view hides itself
  const cacheRects = () => { host.__rects = blocks.map(({ el }) => ({ el, r: el.getBoundingClientRect() })) }
  function fit() {
    for (const b of blocks) { b.el.classList.remove(...FIT); b.el.style.translate = '' }
    if (phoneNow()) return cacheRects()
    const tl = $('.fl-tl')?.getBoundingClientRect(), chip = $('.fl-chip')?.getBoundingClientRect(), snd = $('#fl-sound')?.getBoundingClientRect()
    const top = (tl ? tl.bottom : 60) + (chip ? chip.height : 24) + 22
    const bottom = (snd && snd.height ? snd.top : innerHeight - 70) - 44
    for (const { el } of blocks) {
      let r = el.getBoundingClientRect()
      for (let k = 0; k < FIT.length && r.height > bottom - top; k++) { el.classList.add(FIT[k]); r = el.getBoundingClientRect() }
      const dy = r.top < top ? top - r.top : r.bottom > bottom ? Math.max(top - r.top, bottom - r.bottom) : 0
      if (dy) el.style.translate = `0 ${Math.round(dy)}px`
    }
    cacheRects()
  }
  build(); fit()
  document.fonts?.ready.then(fit)
  let wasPhone = phoneNow(), fitRaf = 0
  addEventListener('resize', () => {
    const ph = phoneNow(); if (ph !== wasPhone) { wasPhone = ph; build() } // stop 0 swaps intro <-> short copy
    cancelAnimationFrame(fitRaf); fitRaf = requestAnimationFrame(fit)
  })
  const want = []
  function setBlocks(mix, gate) {
    for (let k = 0; k < blocks.length; k++) want[k] = 0
    if (mix) {
      const ba = blockOf[mix.a] ?? -1, bb = blockOf[mix.b] ?? -1
      const w = mixWeights(mix, ba >= 0 && ba === bb)
      if (ba >= 0) want[ba] = Math.max(want[ba], w[0])
      if (bb >= 0) want[bb] = Math.max(want[bb], w[1])
    }
    let ca = 0
    for (let k = 0; k < blocks.length; k++) {
      const B = blocks[k], a = Math.round(want[k] * gate * 100) / 100
      if (B.counter) ca = a
      if (a === B.a) continue
      if (a > 0 && B.a === 0) B.el.style.visibility = ''
      if (a === 0) B.el.style.visibility = 'hidden'
      B.el.style.setProperty('--a', String(a)); B.a = a
    }
    return ca
  }
  function showReadout(i) {
    roIdx = i
    ro.innerHTML = i < 0 ? '' : READOUTS[i].lines.map((l) => `<div>${l}</div>`).join('')
    ro.className = 'fl-readout at-' + (i < 0 ? 'none' : READOUTS[i].at)
  }

  return {
    setCallouts(info) {
      rows = buildCallouts(info)
      call.innerHTML = '<div class="fl-c-title">INSPECT / ELBOW SERVO</div>' + rows.map((r) => `<div class="fl-c-row" data-src="${r.src}"><b>${r.k}</b><span></span></div>`).join('')
      rowEls = [...call.querySelectorAll('.fl-c-row span')]
    },
    /** p: flight progress; ctx: { sceneIdx, scenes, insp (0..1), anchor {x,y} CSS px or null, q, dt, phone } */
    update(p, ctx) {
      root.style.setProperty('--fl-p', p.toFixed(4))
      const si = ctx.sceneIdx
      const txt = `${String(si + 1).padStart(2, '0')} / ${String(ctx.scenes.length).padStart(2, '0')}  ${ctx.scenes[si].name}`
      if (txt !== sceneTxt) { sceneTxt = txt; scene.textContent = txt; if (!quiet && !ctx.instant) scramble(scene, 0.5) }
      if (ctx.progress != null) { // round 10: progress round the loop; it fades out into the wrap and in after it (never runs back visibly)
        const g = ctx.progress, o = Math.min(1, g / 0.015, (1 - g) / 0.015)
        bar.style.transform = `scaleX(${g.toFixed(4)})`; bar.style.opacity = o.toFixed(3)
      } else bar.style.transform = `scaleX(${(p / PMAX).toFixed(4)})` // FULL SITE: the whole flight

      // text: a pure function of where the camera is (round 12); the opening holds it until the crane lands (ctx.gate)
      const ca = setBlocks(ctx.mix, ctx.gate ?? 1)
      if (ca > 0) {
        const k = clamp01((p - 0.3) / (0.45 - 0.3)) // counts with the stage's lane (director maps the same range)
        const e = episodeAt(k)
        if (e.count !== lastCount) {
          lastCount = e.count
          counterEl.innerHTML = `<b>${String(e.count).padStart(3, '0')}</b> / ${TOTAL_EPISODES}<span>${e.cell ? `CELL ${e.cell}, ROUND ${e.round}` : 'B2 HELD OUT'}</span>`
        }
      }

      // read-outs
      let ri = -1, ra = 0
      for (let i = 0; i < READOUTS.length; i++) { const a = win(p, READOUTS[i].a, READOUTS[i].b, 0.008); if (a > ra) { ra = a; ri = i } }
      if (ri !== roIdx) showReadout(ri)
      ro.style.opacity = ra
      const bk = 0 // round 11b: no overhead bracket (05 is a 3/4 now)
      bracket.style.opacity = bk

      // inspection callouts: type on after the servo settles, leave before it moves back
      const ins = ctx.insp // round 12: the inspection window itself (a function of p); the rows still type on once whole
      call.style.opacity = ins
      svg.style.opacity = ins
      if (rows) {
        const want = ins > 0.98 ? 1 : 0
        typed = Math.max(0, Math.min(1, typed + (want ? ctx.dt / 0.45 : -ctx.dt / 0.2)))
        if (ctx.instant) typed = want
        rows.forEach((r, i) => {
          const full = r.live ? `${fmt(ctx.q)} RAD  ·  LIVE` : r.v
          const k = clamp01(typed * 1.6 - i * 0.09)
          const n = Math.round(full.length * k)
          const scr = '▮▯/\\-_·'
          let s = full.slice(0, n)
          if (k < 1 && n < full.length) s += scr[(n + i) % scr.length]
          if (rowEls[i].textContent !== s) rowEls[i].textContent = s
        })
        if (ctx.anchor && ins > 0.01) {
          const rc = call.getBoundingClientRect()
          const ax = ctx.anchor.x, ay = ctx.anchor.y
          const tx = rc.left - 10, ty = rc.top + 12
          const kx = tx - Math.min(60, Math.abs(tx - ax) * 0.35)
          lead.setAttribute('d', `M${ax.toFixed(1)},${ay.toFixed(1)} L${kx.toFixed(1)},${ty.toFixed(1)} L${tx.toFixed(1)},${ty.toFixed(1)}`)
          dot.setAttribute('cx', ax.toFixed(1)); dot.setAttribute('cy', ay.toFixed(1))
        }
      }
    },
  }
}
