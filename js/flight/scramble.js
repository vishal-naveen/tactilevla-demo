// Round 6 (Igloo #7 / #11): text decode on section entry and type-on for pinned labels. A JS string swap on TEXT NODES
// only (nodeValue), so nested markup survives, no class is toggled and nothing outside the element restyles. Spaces and
// punctuation stay put (word boundaries hold, so a balanced headline keeps its line breaks while it decodes). Idle cost:
// one empty-array check per frame.
const GLYPHS = 'ABCDEFGHJKLMNPRSTUVXYZ0123456789/<>#+=_'
const KEEP = /[\s.,:;!?'’"“”()\-–—…×°$%]/

const jobs = []
let seed = 1
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 }

/** One frame of a decode: chars before `k` (0..1 of the length) are real, a short band after it is noise, the rest is
 *  real-but-noised (mode 'decode', length kept) or absent (mode 'type'). */
export function decodeText(full, k, mode = 'decode', band = 4) {
  const n = full.length, at = Math.floor(n * Math.min(1, Math.max(0, k)))
  if (at >= n) return full
  let s = full.slice(0, at)
  const end = mode === 'type' ? Math.min(n, at + band) : n
  for (let i = at; i < end; i++) {
    const c = full[i]
    s += KEEP.test(c) ? c : GLYPHS[(rnd() * GLYPHS.length) | 0]
  }
  return s
}

/** Decode every text node under `el` over `dur` seconds (left to right, staggered across nodes). */
export function scramble(el, dur = 0.55, mode = 'decode') {
  if (!el) return
  const prev = jobs.findIndex((j) => j.el === el)
  if (prev >= 0) { finish(jobs[prev]); jobs.splice(prev, 1) }
  const nodes = []
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  for (let n = w.nextNode(); n; n = w.nextNode()) if (n.nodeValue.trim()) nodes.push({ n, full: n.nodeValue })
  if (!nodes.length) return
  const total = nodes.reduce((a, x) => a + x.full.length, 0)
  let off = 0
  for (const x of nodes) { x.a = off / total; x.b = (off + x.full.length) / total; off += x.full.length }
  const job = { el, nodes, t: 0, dur, mode, last: -1 }
  jobs.push(job)
  step(job, 0)
}

function finish(j) { for (const x of j.nodes) if (x.n.nodeValue !== x.full) x.n.nodeValue = x.full }

function step(j, dt) {
  j.t += dt
  const k = j.t / j.dur
  // a 30 Hz glyph clock: noise that changes every frame at 120 Hz reads as flicker, not as decoding
  const tick = Math.floor(j.t * 30)
  if (tick === j.last && k < 1) return k >= 1
  j.last = tick
  for (const x of j.nodes) {
    const lk = (k - x.a) / Math.max(1e-3, x.b - x.a)
    const v = decodeText(x.full, lk, j.mode)
    if (x.n.nodeValue !== v) x.n.nodeValue = v
  }
  return k >= 1
}

/** Advance every running decode (call once per frame); `instant` completes them (capture, reduced motion). */
export function tickScramble(dt, instant = false) {
  if (!jobs.length) return
  for (let i = jobs.length - 1; i >= 0; i--) {
    const j = jobs[i]
    if (instant || !j.el.isConnected) { finish(j); jobs.splice(i, 1); continue }
    if (step(j, dt)) { finish(j); jobs.splice(i, 1) }
  }
}
