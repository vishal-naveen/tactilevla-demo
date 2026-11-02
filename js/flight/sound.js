// Flight sound v3 (flight.html): opt-in; tonal, warm and airy (owner on v2: "scary"; target "dreamy and smooth ... like
// igloo"). Everything pitched is in D major, each scene on a major-pentatonic voicing (I = D, IV = G, V = A: no minor
// seconds, no tritones), equal temperament at A440. Built from the robot's REAL recordings, sculpted offline into two
// small banks (assets/audio/bank_{mono,st}.{webm,m4a}, ~0.7 MB per browser): the STS3215 whine's own harmonic stack and
// line shape voice the pads, glints, blooms and chimes; the lab's room tone (frozen, re-phased) is the air and the
// breaths; the real gripper click excites the glass plucks; the real table impact is the thup's transient. Nothing is
// created or fetched before the SOUND toggle is clicked (the AudioContext is made inside that gesture, the banks are
// fetched + decoded after it); the choice is remembered per tab (sessionStorage, try/catch).
//
// Layers (createEngine), one master bus: layer outs -> (duck) -> dry + hall convolution -> glue compressor -> trim ->
// limiter -> fade -> destination.
//   room   the bed: three exactly periodic 16 s pads (D add9 / G maj9-ish / A 6/9) crossfaded by scene (2.5 s time
//          constant: a colour shift, never a hard change), each breathing over its loop; the bed is continuous across
//          stops. High-passed at 90 Hz (no sub), with the room tone's air above 4 kHz baked in.
//   hum    the ring light: a high glint (A5 / E6 / B6, octave partials) whose level follows ring gain x lit arc
//   servo  real mechanical texture, light: six voices of the real whine + gear-chatter loops, only while a joint moves
//   lane   a soft tuned tap per noodle landing (D pentatonic, the real impact as its transient, rate-limited); a soft
//          D add9 strike at 160; 'tick' = a glass pluck (the real gripper click through a tuned resonator, in key)
//   whoosh the room air band-passed by the camera's speed, + an airy breath (swept air + a tonal tail) on every scene change
//   b2     the glint an octave up opening with the B2 pool (others duck 6 dB); at the B2 grasp a gentle RISING chime
//   build  the opening: an airy rise (forward swell) -> a warm bloom into the D chord at INTRO_HIT -> settle; plus the glint
//          an octave up while the build runs
// Per frame the page calls update() (one boolean check while off). Drivers are sampled at 20 Hz and every parameter moves
// by setTargetAtTime: no per-frame allocation; nodes are only allocated for the rate-limited one-shots.
// Sources: scratchpad sound_work/py/design_v3.py (numpy, run on warden-pc; see CLAUDE.md "Sound v3"). v2: sound_work/sound_v2.js.
import { TOTAL_EPISODES } from '../stage/protocol.js'

const JOINTS = ['shoulder_pan', 'shoulder_lift', 'elbow_flex', 'wrist_flex', 'wrist_roll', 'gripper']
const STORE = 'tve-sound'
const dB = (d) => Math.pow(10, d / 20)
const clamp01 = (x) => Math.min(1, Math.max(0, x))
const smooth = (x) => { x = clamp01(x); return x * x * (3 - 2 * x) }

// --- the banks ---------------------------------------------------------------------------------------------------------
// [start s, length s] of each item in the decoded file (design_v3.py bank.json). Every item sits after 0.12 s of silence;
// loops carry 60 ms of their own wrap-around either side (a lossy codec rings at a hard edge into silence, and that ring
// landed on the loop seam). SYNC = where each bank's first sample above 0.02 is (mono: a loop's wrap at 0.06; st: the
// chime's first pluck), so a decoder that leaves encoder priming in shifts every slice by the same amount.
const BANK = {
  mono: { servo_whine: [0.12, 2.0], servo_grind: [2.3, 7.6], bed_I: [10.08, 16.0], bed_IV: [26.26, 16.0], bed_V: [42.44, 16.0], ring: [58.62, 8.0], air: [66.8, 6.0], pluck0: [72.98, 0.75], pluck1: [73.85, 0.75], pluck2: [74.72, 0.75], pluck3: [75.59, 0.75], pluck4: [76.46, 0.75], thup0: [77.33, 0.45], thup1: [77.9, 0.45], thup2: [78.47, 0.45], thup3: [79.04, 0.45], breath0: [79.61, 3.4], breath1: [83.13, 3.4] },
  st: { chime: [0.12, 3.2], hit: [3.44, 4.0], intro: [7.56, 5.6] },
}
const SYNC = { mono: 0.06, st: 0.12137 }
export const INTRO_HIT = 2.4 // s into the intro cue: the bloom (director: the island finishes growing at introT 2.4)
// scenes (path.js SCENES p1 bounds) -> bed voicing 0 = I (D), 1 = IV (G), 2 = V (A). B2 (07) sits on A: its chime is in A.
const SCENE_P1 = [0.067, 0.2, 0.3, 0.517, 0.633, 0.7, 0.917, 1.1, 1.255, 1.37, 1.5, 1.7]
const VOICING = [0, 1, 0, 0, 2, 1, 2, 0, 1, 1, 0, 2, 0]
// which plucks (A5 B5 D6 E6 F#6) and thups (D4 E4 F#4 A4) belong to each voicing's pentatonic
const PLUCKS = [[0, 1, 2, 3, 4], [0, 1, 2, 3], [0, 1, 3, 4]]
const THUPS = [[0, 1, 2, 3], [0, 1, 3], [1, 2, 3]]
const sceneOf = (p) => { let i = 0; while (i < SCENE_P1.length && p >= SCENE_P1[i]) i++; return i }
const AUDIO_DIR = new URL('../../assets/audio/', import.meta.url)
function exts() {
  let opus = false
  try { opus = !!(typeof Audio !== 'undefined' && new Audio().canPlayType('audio/webm; codecs="opus"')) } catch { /* no media element */ }
  return opus ? ['webm', 'm4a'] : ['m4a', 'webm']
}
const fetched = {} // one download per page per format (decoded per context: decodeAudioData detaches its input)
function fetchBank(ext) {
  return (fetched[ext] ||= Promise.all(['bank_mono', 'bank_st'].map((n) => fetch(new URL(`${n}.${ext}`, AUDIO_DIR)).then((r) => {
    if (!r.ok) throw new Error(`sound: ${n}.${ext} ${r.status}`)
    return r.arrayBuffer()
  }))))
}
const decode = (ctx, ab) => new Promise((res, rej) => { const p = ctx.decodeAudioData(ab, res, rej); if (p && p.then) p.then(res, rej) })

function sliceBank(ctx, buf, table, sync) {
  const sr = buf.sampleRate, d = buf.getChannelData(0), lim = Math.min(d.length, Math.round(sr * 0.4))
  let i = 0
  while (i < lim && Math.abs(d[i]) < 0.02) i++
  // only a real priming offset moves the slices (>= 6.5 ms: Opus pre-skip, 21 ms: AAC); Chrome's decoders land within
  // 0.7 ms of SYNC for both formats, and lossy pre-echo must not nudge a loop off its seam
  const dt = i < lim ? i / sr - sync : 0, shift = Math.abs(dt) > 0.004 ? Math.max(-0.08, Math.min(0.08, dt)) : 0
  const out = {}
  for (const k in table) {
    const [t, len] = table[k], a = Math.max(0, Math.round((t + shift) * sr)), n = Math.round(len * sr)
    const b = ctx.createBuffer(buf.numberOfChannels, n, sr)
    for (let c = 0; c < buf.numberOfChannels; c++) b.getChannelData(c).set(buf.getChannelData(c).subarray(a, a + n))
    out[k] = b
  }
  return out
}
async function loadBank(ctx) {
  let err
  for (const ext of exts()) {
    try {
      const [m, s] = await fetchBank(ext)
      const [bm, bs] = await Promise.all([decode(ctx, m.slice(0)), decode(ctx, s.slice(0))])
      return { ...sliceBank(ctx, bm, BANK.mono, SYNC.mono), ...sliceBank(ctx, bs, BANK.st, SYNC.st), ext }
    } catch (e) { err = e }
  }
  throw err
}

// --- the room (made once per context): 1.0 s (the long airy tails are baked into the one-shots; frame cost), decorrelated
// L/R, soft onset, only gently darker as it decays (v2's was dark) ------------
function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) / 4294967296) * 2 - 1 } }
function hallImpulse(ctx) {
  const sr = ctx.sampleRate, n = Math.round(sr * 1.0), b = ctx.createBuffer(2, n, sr)
  for (let c = 0; c < 2; c++) {
    const d = b.getChannelData(c), r = rng(4242 + c * 31), pre = Math.round(sr * 0.02)
    let lp = 0, e = 0
    for (let i = pre; i < n; i++) {
      const t = (i - pre) / sr, a = 0.05 + 0.35 * Math.min(1, t / 0.9) // one-pole: a little darker with time
      lp = lp * a + r() * (1 - a)
      d[i] = lp * Math.exp(-t / 0.3) * Math.min(1, t / 0.05) * Math.min(1, (n - i) / (0.15 * sr))
    }
    for (let i = 0; i < n; i++) e += d[i] * d[i]
    const g = 1 / Math.sqrt(e)
    for (let i = 0; i < n; i++) d[i] *= g
  }
  return b
}

// --- the engine: works on an AudioContext or an OfflineAudioContext ------------------------------------------------
/**
 * @param {BaseAudioContext} ctx
 * Returns { out (fade gain, the last node), layers {name: GainNode}, comp, ready (Promise: the banks are decoded and every
 * loop is running), loaded, drive(f), thup(level), pulse(), chime(), intro(offsetSec), cue(name, level), solo(name|null) }.
 * drive f: { ring 0..1, b2 0..1, cam m/s, build 0..1, rise 0..1, servo Float32Array(6) rad/s, motion 0..1, p (flight
 * progress; optional: the bed voicing + scene breaths follow it) }.
 * Until ready, drive() moves the gains as usual and the one-shots are no-ops (return false).
 */
export function createEngine(ctx) {
  const G = (v = 1) => { const g = ctx.createGain(); g.gain.value = v; return g }
  const F = (type, f, Q = 0.707) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = Q; return b }
  const P = (v) => { if (!ctx.createStereoPanner) return G(1); const p = ctx.createStereoPanner(); p.pan.value = v; return p }
  const O = (f) => { const o = ctx.createOscillator(); o.frequency.value = f; o.start(ctx.currentTime); return o }

  // master: dry + room -> glue compressor -> trim -> limiter -> post -> out (the toggle's fade)
  const sum = G(1), wetIn = G(1), conv = ctx.createConvolver(), wet = G(dB(-6))
  conv.normalize = false; conv.buffer = hallImpulse(ctx)
  wetIn.connect(conv).connect(wet).connect(sum)
  const comp = ctx.createDynamicsCompressor()
  comp.threshold.value = -22; comp.knee.value = 14; comp.ratio.value = 2; comp.attack.value = 0.02; comp.release.value = 0.4
  const lim = ctx.createDynamicsCompressor()
  lim.threshold.value = -8; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.001; lim.release.value = 0.12
  // trim/post: calibrated on the recorded real-flight drivers (pc_sound_mix.mjs) against Chrome's automatic make-up gain
  const trim = G(dB(-4)), post = G(dB(-3)), out = G(1)
  sum.connect(comp).connect(trim).connect(lim).connect(post).connect(out)
  out.connect(ctx.destination)
  const duck = G(1) // S7: the bed and the air give way to the B2 glint (-6 dB at a full pool)
  duck.connect(sum)

  const layers = {}
  const layer = (name, send, ducked) => { const g = G(1); g.connect(ducked ? duck : sum); if (send) g.connect(G(send)).connect(wetIn); layers[name] = g; return g }

  // the static graph (gains/filters exist from the start; the loops plug in when the banks are decoded)
  // 1. the bed: three voicings -> one high-pass (no sub) -> a slow brightness drift (30 s) -> level
  const room = layer('room', 0.3, true), bedHp = F('highpass', 90, 0.6), bedLp = F('lowpass', 10500, 0.5), bedG = G(dB(-27))
  bedHp.connect(bedLp).connect(bedG).connect(room)
  O(1 / 30).connect(G(2500)).connect(bedLp.frequency)
  const vG = [G(0), G(0), G(0)]; vG.forEach((g) => g.connect(bedHp))

  // 2. the ring's glint
  const hum = layer('hum', 0.35, false), humG = G(0), humLp = F('lowpass', 3000, 0.5)
  humLp.connect(humG).connect(hum)

  // 3. servos (light: only while a joint moves; high-passed so they never add low-mid mass)
  const servo = layer('servo', 0.12, false), servoBus = F('lowpass', 7000, 0.5), servoHp = F('highpass', 420, 0.6)
  servoBus.connect(servoHp).connect(servo)
  const RATE = [0.8, 0.86, 0.93, 1.0, 1.08, 1.17] // each joint its own gear train: bigger joints lower
  const PAN = [0, -0.3, 0.22, -0.14, 0.32, 0.12]
  const wBp = [], wG = [], gG = [], vIn = []
  for (let i = 0; i < 6; i++) {
    const pan = P(PAN[i]); pan.connect(servoBus)
    const bp = F('bandpass', 4200 * RATE[i], 0.9), g = G(0); bp.connect(g).connect(pan)
    const gg = G(0); gg.connect(pan)
    wBp.push(bp); wG.push(g); gG.push(gg); vIn.push([bp, gg])
  }

  // 4. lane: taps, plucks and the 160 strike into a shared gain
  const lane = layer('lane', 0.3, false), laneG = G(dB(-9))
  laneG.connect(lane)

  // 5. air: camera speed + the scene breaths
  const whoosh = layer('whoosh', 0.25, true), wBand = F('bandpass', 700, 0.5), wGain = G(0), breathG = G(dB(-15))
  wBand.connect(wGain).connect(whoosh); breathG.connect(whoosh)

  // 6. B2: the glint an octave up + the rising chime
  const b2 = layer('b2', 0.35, false), b2G = G(0), b2Hp = F('highpass', 1500, 0.6)
  b2Hp.connect(b2G).connect(b2)
  const pulseG = G(dB(-5)); pulseG.connect(b2)

  // 7. build-in: the intro cue + the glint an octave up while the build runs
  const build = layer('build', 0.4, false), introG = G(dB(-3)), shimG = G(0), shimHp = F('highpass', 1500, 0.6)
  introG.connect(build); shimHp.connect(shimG).connect(build)

  // --- plug the recordings in -------------------------------------------------------------------------------------
  let B = null
  const loops = { whine: [], grind: [], air: null }
  const loop = (buf, offset, rate = 1) => { const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true; s.playbackRate.value = rate; s.start(ctx.currentTime, offset % buf.duration); return s }
  const ready = loadBank(ctx).then((bank) => {
    B = bank
    ;['bed_I', 'bed_IV', 'bed_V'].forEach((k, i) => loop(B[k], 0).connect(vG[i]))
    loop(B.ring, 0).connect(humLp)
    loop(B.ring, 2.1, 2).connect(b2Hp) // an octave up: still only A / E / B
    loop(B.ring, 5.3, 2).connect(shimHp)
    for (let i = 0; i < 6; i++) {
      const w = loop(B.servo_whine, i * 0.31, RATE[i]); w.connect(vIn[i][0]); loops.whine.push(w)
      const g = loop(B.servo_grind, i * 1.27, RATE[i]); g.connect(vIn[i][1]); loops.grind.push(g)
    }
    loops.air = loop(B.air, 0); loops.air.connect(wBand)
    return B.ext
  })
  ready.catch(() => {}) // a failed download leaves the page silent, never broken

  // --- driving ------------------------------------------------------------------------------------------------------
  const last = new Float64Array(80).fill(NaN)
  let slot = 0
  const tg = (param, v, tau, eps) => { const s = slot++; if (!(Math.abs(v - last[s]) <= eps)) { last[s] = v; param.setTargetAtTime(v, ctx.currentTime, tau) } }
  let lastThup = -1, density = 0, scene = -1, voicing = 0, lastBreath = -9, breathN = 0, lastTick = -1
  const one = (buf, dest, rate = 1, level = 1, pan = 0, offset = 0) => {
    const s = ctx.createBufferSource(); s.buffer = buf; s.playbackRate.value = rate
    let n = s
    if (level !== 1) n = n.connect(G(level))
    if (pan) n = n.connect(P(pan))
    n.connect(dest); s.start(ctx.currentTime, offset)
    return s
  }
  const pick = (arr) => arr[(Math.random() * arr.length) | 0]
  const fadeIn = (s, dest, tau) => { const g = G(0); s.disconnect(); s.connect(g).connect(dest); g.gain.setTargetAtTime(1, ctx.currentTime, tau) }

  return {
    out, layers, comp, ready,
    get loaded() { return !!B },
    get voicing() { return voicing },
    drive(f) {
      slot = 0
      const m = f.motion
      tg(duck.gain, 1 - (1 - dB(-6)) * f.b2, 0.5, 1e-3)
      // the bed's voicing follows the scene: a slow crossfade (a colour shift), and one airy breath per scene change
      if (typeof f.p === 'number') {
        const si = sceneOf(f.p)
        if (si !== scene) {
          const first = scene < 0
          scene = si; voicing = VOICING[si]
          for (let k = 0; k < 3; k++) { vG[k].gain.setTargetAtTime(k === voicing ? 1 : 0, ctx.currentTime, first ? 0.05 : 2.5) }
          if (!first && B && ctx.currentTime - lastBreath > 1.5) { lastBreath = ctx.currentTime; one(B['breath' + (breathN++ & 1)], breathG, 1, 1, (breathN & 1 ? 0.15 : -0.15)) }
        }
      } else if (scene < 0) { scene = 0; vG[0].gain.setTargetAtTime(1, ctx.currentTime, 0.05) }
      // the ring's glint: level follows the ring; it opens a little as it brightens
      const r = clamp01(f.ring)
      tg(humG.gain, dB(-30) * r, 0.25, 1e-5)
      tg(humLp.frequency, 2600 + 6000 * r * r, 0.4, 4)
      // servos: light, only while a joint actually moves
      for (let i = 0; i < 6; i++) {
        const w = f.servo[i], s = Math.min(1, w / 3)
        const gate = smooth((w - 0.08) / 0.8) // idle = silent
        tg(wG[i].gain, dB(-27) * gate * (0.45 + 0.55 * s) * m, 0.06, 1e-5)
        tg(gG[i].gain, dB(-31) * gate * (0.35 + 0.65 * s) * m, 0.06, 1e-5)
        if (B) {
          tg(loops.whine[i].playbackRate, RATE[i] * (0.84 + 0.36 * s), 0.08, 2e-3)
          tg(loops.grind[i].playbackRate, RATE[i] * (0.9 + 0.25 * s), 0.08, 2e-3)
        } else slot += 2
        tg(wBp[i].frequency, 4200 * RATE[i] * (0.85 + 0.4 * s), 0.08, 5)
      }
      // air: camera speed -> level + a band that lifts (a soft rush, never a roar)
      const k = clamp01((f.cam - 0.05) / 1.1)
      tg(wGain.gain, dB(-17) * Math.pow(k, 1.6) * m, 0.12, 1e-5)
      tg(wBand.frequency, 600 + 2600 * k, 0.15, 4)
      // B2: the glint an octave up opens with the pool
      tg(b2G.gain, dB(-24) * clamp01(f.b2), 0.6, 1e-5)
      // build-in glint
      tg(shimG.gain, dB(-30) * clamp01(f.build) * m, 0.2, 1e-5)
      density *= 0.9
      tg(laneG.gain, dB(-9) / (1 + 0.1 * density), 0.05, 1e-4)
    },
    /** One noodle landing: a soft tuned tap from the voicing's pentatonic. Rate-limited (>= 70-100 ms apart). */
    thup(level = 1) {
      if (!B) return false
      const t = ctx.currentTime
      if (t - lastThup < 0.07 + Math.random() * 0.03) return false
      lastThup = t; density += 1
      one(B['thup' + pick(THUPS[voicing])], laneG, 1, level * (0.7 + 0.3 * Math.random()), (Math.random() * 2 - 1) * 0.35)
      return true
    },
    /** The B2 grasp: a gentle rising chime (A pentatonic, its hall baked in). */
    pulse() { if (B) one(B.hit, pulseG) },
    /** 160 landed: a soft D add9 strike. */
    chime() { if (B) one(B.chime, lane, 1, dB(-5)) },
    /** The opening cue from `offset` s (INTRO_HIT = the bloom). Returns false if the banks are not decoded yet. */
    intro(offset = 0) {
      if (!B || offset >= B.intro.duration - 0.2) return false
      const s = one(B.intro, introG, 1, 1, 0, Math.max(0, offset))
      if (offset > 0.05) fadeIn(s, introG, 0.08) // joined late: no click
      return true
    },
    /** One-shots for other scenes: 'ignite' (a swell into the bloom), 'hit' (the rising chime), 'tick' (a glass pluck),
     *  'thup', 'chime'. level 0..1. Returns false while the banks are loading. */
    cue(name, level = 1) {
      if (!B) return false
      if (name === 'ignite') { const s = one(B.intro, introG, 1, level, 0, INTRO_HIT - 0.3); fadeIn(s, introG, 0.1) }
      else if (name === 'hit') one(B.hit, pulseG, 1, level)
      else if (name === 'tick') {
        if (ctx.currentTime - lastTick < 0.06) return false
        lastTick = ctx.currentTime
        one(B['pluck' + pick(PLUCKS[voicing])], lane, 1, dB(-12) * level * (0.8 + 0.2 * Math.random()), (Math.random() * 2 - 1) * 0.4)
      }
      else if (name === 'thup') return this.thup(level)
      else if (name === 'chime') one(B.chime, lane, 1, dB(-5) * level)
      else return false
      return true
    },
    /** Tests: hear one layer only (null = all). */
    solo(name) { for (const n in layers) layers[n].gain.setValueAtTime(name === null || n === name ? 1 : 0, ctx.currentTime) },
  }
}

// --- the page controller: toggle, persistence, drivers from the stage/director ----------------------------------------
/**
 * @param {{ stage: any, button: HTMLButtonElement, introS: number }} o
 * update(dt, p, introT, reduced) is called once per frame by the director.
 */
export function createSound({ stage, button, introS }) {
  let on = false, ctx = null, eng = null, offTimer = 0, acc = 0, primed = false, analyser = null, introDone = false
  try { on = sessionStorage.getItem(STORE) === '1' } catch { /* storage blocked: start off */ }
  const prevQ = new Float64Array(6), cam = new Float64Array(3)
  const f = { ring: 0, b2: 0, cam: 0, build: 0, rise: 0, servo: new Float32Array(6), motion: 1, p: 0 }
  let lastCount = -1, chimed = false, pulsed = false, studio = null, moments = null

  function render() {
    button.setAttribute('aria-pressed', on ? 'true' : 'false')
    button.querySelector('span').textContent = on ? 'ON' : 'OFF'
  }
  function start() { // only ever called from a user gesture
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext
      if (!AC) return
      ctx = new AC({ latencyHint: 'playback' }) // bigger buffers, fewer audio-thread wakeups: measured frame cost
      eng = createEngine(ctx) // fetches + decodes the banks now (after the click), never before
      eng.out.gain.value = 0
      studio = stage.debug?.studio; moments = stage.debug?.moments // read-only: the ring's live uniforms, the B2 pool level
    }
    clearTimeout(offTimer)
    primed = false
    ctx.resume()
    eng.out.gain.setTargetAtTime(1, ctx.currentTime, 0.25)
  }
  function stop() {
    if (!ctx) return
    eng.out.gain.setTargetAtTime(0, ctx.currentTime, 0.06)
    clearTimeout(offTimer)
    offTimer = setTimeout(() => { if (!on) ctx.suspend() }, 400)
  }
  function persist() { try { sessionStorage.setItem(STORE, on ? '1' : '0') } catch { /* fine without it */ } }

  button.addEventListener('click', () => { on = !on; persist(); render(); if (on) start(); else stop() })
  if (on) { // remembered on: the context still waits for the first gesture (autoplay rules)
    const arm = () => { removeEventListener('pointerdown', arm, true); removeEventListener('keydown', arm, true); if (on && !ctx) start() }
    addEventListener('pointerdown', arm, true); addEventListener('keydown', arm, true)
  }
  document.addEventListener('visibilitychange', () => { if (!ctx) return; if (document.hidden) ctx.suspend(); else if (on) ctx.resume() })
  render()

  return {
    get ctx() { return ctx }, get engine() { return eng }, get on() { return on }, get drivers() { return f },
    /** Tests: RMS (dBFS) of the master over the analyser window. */
    meter() {
      if (!ctx) return null
      if (!analyser) { analyser = ctx.createAnalyser(); analyser.fftSize = 8192; eng.out.connect(analyser); analyser.buf = new Float32Array(8192) }
      analyser.getFloatTimeDomainData(analyser.buf)
      let s = 0, pk = 0
      for (const x of analyser.buf) { s += x * x; pk = Math.max(pk, Math.abs(x)) }
      return { rms: 20 * Math.log10(Math.sqrt(s / analyser.buf.length) + 1e-12), peak: 20 * Math.log10(pk + 1e-12) }
    },
    /** Hook for other scenes: a one-shot by name (see engine.cue); a no-op while sound is off or still loading. */
    cue(name, level = 1) { return on && eng && ctx.state === 'running' ? eng.cue(name, level) : false },
    update(dt, p, introT, reduced) {
      if (!on || !eng || ctx.state !== 'running') return
      acc += dt
      if (acc < 1 / 20) return
      const el = acc; acc = 0
      // joints + camera, differenced over the sample interval (primed on the first sample so turning on is silent)
      const st = stage.getJointState(), js = st.joints, cp = stage.getCamera().position
      for (let i = 0; i < 6; i++) { const q = js[JOINTS[i]]; f.servo[i] = primed ? f.servo[i] * 0.4 + 0.6 * Math.abs(q - prevQ[i]) / el : 0; prevQ[i] = q }
      const v = primed ? Math.hypot(cp.x - cam[0], cp.y - cam[1], cp.z - cam[2]) / el : 0
      f.cam = f.cam * 0.5 + 0.5 * v
      cam[0] = cp.x; cam[1] = cp.y; cam[2] = cp.z
      primed = true
      // ring: the lit arc's gain x how much of the arc is lit (the S7 drain is heard as well as seen)
      if (studio) { const u = studio.ringMat.uniforms; f.ring = clamp01(u.uGain.value) * (0.35 + 0.65 * clamp01(u.uProg.value)) }
      f.b2 = moments ? clamp01(moments.b2Level) : 0
      // build-in: lattice draws 0-1.0 s, the island grows 1.0-2.4 s, then the shimmer lets go (director.js timings)
      const it = introT
      f.build = it >= introS ? 0 : it < 2.4 ? 0.3 + 0.7 * smooth(it / 2.4) : 1 - smooth((it - 2.4) / 1.0)
      f.rise = clamp01(it / 2.4)
      f.motion = reduced ? 0.5 : 1
      f.p = p // v3: the bed's voicing + the scene breaths
      if (reduced) f.cam = 0 // calm mode cuts between holds: a cut is not a flight
      eng.drive(f)
      // the opening, once. intro2 (intro.js) holds this clock at 0 until its rake starts and lights the ring at 0.5 s:
      // the ring lighting while the clock is still 0 = that ignition -> the hit + settle alone. Otherwise (the M1
      // build-in, or joining during the rake) the rise plays from the clock and lands its hit at 2.4 = the island grown.
      if (!introDone && eng.loaded) {
        if (reduced || it >= INTRO_HIT - 0.15) introDone = true
        else if (it === 0 && f.ring > 0.08) { introDone = true; eng.cue('ignite') }
        else if (it > 0) { introDone = true; eng.intro(it) }
      }
      // lane: one thup per episode the count advances (director: 160 land over p 0.30-0.45)
      const count = Math.round(clamp01((p - 0.3) / 0.15) * TOTAL_EPISODES) // = episodeAt(k).count, without its object
      if (lastCount >= 0 && count > lastCount) {
        eng.thup(reduced ? 0.6 : 1)
        if (count >= TOTAL_EPISODES && !chimed) { chimed = true; eng.chime() }
      }
      if (count < TOTAL_EPISODES) chimed = false
      lastCount = count
      // B2: one rising chime at the grasp, once per pool
      if (f.b2 > 0.2 && !pulsed && st.cell === 'B2' && st.phase === 'grasp') { pulsed = true; eng.pulse() }
      if (f.b2 < 0.02) pulsed = false
    },
  }
}
