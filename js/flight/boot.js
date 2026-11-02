// FULL SITE boot (flight.html): the page is a readable document (all copy + the real footage) until the 3D flight is
// running; then html.fl-live turns the same sections into the flight's panels. The same fallbacks as the old site
// (js/main.js): no hardware WebGL2 -> the document + a note; the stage failing or not ready in time -> the document; a GPU
// that boots but cannot keep the scene moving (ui/stage-health.js) -> the document + "Try 3D anyway".
import './pace.js' // round 12: frame pacing first, before any module schedules a frame (one batch per presented frame)
import { probeGL, showHardwareNote, showSlowNote } from '../ui/gl-probe.js'
import { watchStageHealth } from '../ui/stage-health.js'
import { initDom, docMode, liveMode } from './scenes.js'

const root = document.documentElement
const q = new URLSearchParams(location.search)
const forced = (() => { try { return sessionStorage.getItem('tve-force-3d') === '1' } catch { return false } })()
const SOFT_MAX_MS = q.has('capture') ? 120000 : 15000 // never hold the loader longer than this

try { initDom() } catch (e) { console.warn('flight dom', e) }
// the sound toggle is on screen from the first frame; until sound.js exists (the stage is still loading) a click only
// remembers the choice (sound.js reads it and starts at the next gesture, its own rule for a remembered ON)
const sb = document.getElementById('fl-sound')
const early = () => {
  if (window.__flight) return
  const on = sb.getAttribute('aria-pressed') !== 'true'
  sb.setAttribute('aria-pressed', String(on)); sb.querySelector('span').textContent = on ? 'ON' : 'OFF'
  try { sessionStorage.setItem('tve-sound', on ? '1' : '0') } catch { /* fine */ }
}
sb?.addEventListener('click', early)

// the document layout's sticky chapter bar: anchor jumps clear it (css: html:not(.fl-live) .fls { scroll-margin-top })
function measureIndexBar() {
  const bar = document.getElementById('fl-index')
  if (bar && !root.classList.contains('fl-live')) root.style.setProperty('--fl-idx-h', bar.offsetHeight + 'px')
}
addEventListener('resize', measureIndexBar)

function toDocument() {
  root.classList.remove('fl-live', 'fl-loading')
  root.classList.add('fl-doc')
  try { docMode() } catch { /* fine */ }
  measureIndexBar()
}

async function boot() {
  if (q.has('nogl')) return toDocument()
  const gl = probeGL()
  if (!gl.ok) { toDocument(); showHardwareNote(gl.renderer); return }
  root.classList.add('fl-live') // the director lays out the flight; the loader veil covers it until the first frame
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; toDocument() }, SOFT_MAX_MS)
  try {
    await import('./director.js')
  } catch (e) {
    clearTimeout(timer)
    console.info('3D flight unavailable, showing the document.', e?.message)
    toDocument()
    return
  }
  clearTimeout(timer)
  const stage = window.__flight?.stage
  if (timedOut) { stage?.pause(); offerRetry(stage); return }
  root.classList.remove('fl-doc')
  if (forced || !stage) return
  watchStageHealth({
    getFrames: () => stage.getFrameCount(),
    isActive: () => !document.hidden && root.classList.contains('fl-live'),
    onUnhealthy: (fps) => {
      console.info(`3D flight too slow here (${fps.toFixed(1)} fps): showing the document.`)
      stage.pause(); toDocument(); offerRetry(stage)
    },
  })
}
function offerRetry(stage) {
  if (!stage) return
  showSlowNote(() => {
    root.classList.remove('fl-doc'); root.classList.add('fl-live'); stage.resume()
    try { liveMode() } catch { /* fine */ } // the sandbox is back too, and the stale html.no-webgl goes (docMode added it)
  })
}
boot()
