// Field recorder (local test env only): logs what the owner's own browser does while he scrolls (frame times, camera
// motion, wheel/touch input, long animation frames with script attribution) and posts it to serve_nostore.py
// (POST /__perf -> ../tactilevla-redesign/render/out/perf_log/). Headless numbers said "smooth" while he said it was not
// (2026-11-01): this measures his machine, display and input device instead of a simulation. Never on the published site.
// Round 12: with js/flight/pace.js installed this tick runs inside pace's batch, so `frames` holds PRESENTED (worked)
// frames only. Added per frame, `pace`: [t, hz (120 | 60 | 0 = not measured yet), gap (vsyncs since the previous batch:
// 1 at 120, 2 at locked 60, more = a missed vsync), cpu ms of the previous batch, moving (1 = the camera travels, from
// stage.js trackMotion; trials at 120 wait for 0)]; and per post
// `paceLog` (mode switches since the last post: {t, kind, div}) + `paceState`. Without pace (?pace=off) `pace` is empty.
// Automated browsers (Playwright / headless test runs: navigator.webdriver) never post, so perf_log holds only real
// sessions (round 12: 40 headless test runs had landed beside the owner's one log); `?rec` forces it for a test of rec.js.
if ((location.hostname === 'localhost' || location.hostname === '127.0.0.1') && (!navigator.webdriver || new URLSearchParams(location.search).has('rec'))) {
  const id = Date.now().toString(36)
  let frames = [], input = [], loaf = [], pace = [], last = 0, sent = 0, logSeen = 0
  const tick = (t) => {
    const st = window.__flight?.stage, cam = st?.getCamera?.() || st?.camera
    const p = cam?.position, q = cam?.quaternion
    // this callback runs before the stage's batch, so the pose read here is the one rendered in the PREVIOUS frame: stamp
    // it with that frame's time (stamping it with t made the owner's log show a fake 26 % p90 speed wobble, 2026-11-01)
    const ts = last || t
    frames.push(p ? [+ts.toFixed(2), +p.x.toFixed(5), +p.y.toFixed(5), +p.z.toFixed(5), +q.x.toFixed(5), +q.y.toFixed(5), +q.z.toFixed(5), +q.w.toFixed(5)] : [+ts.toFixed(2)])
    const P = window.__pace
    if (P) pace.push([+t.toFixed(2), P.hz, P.gap, +P.cpu.toFixed(2), P.moving ? 1 : 0])
    last = t
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
  const onIn = (e) => input.push([+performance.now().toFixed(2), e.type, e.deltaY ?? (e.touches?.[0]?.clientY ?? 0), e.deltaMode ?? 0])
  for (const ty of ['wheel', 'touchmove', 'keydown']) addEventListener(ty, onIn, { passive: true, capture: true })
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) loaf.push({ t: +e.startTime.toFixed(1), dur: +e.duration.toFixed(1), block: +(e.blockingDuration || 0).toFixed(1),
        scripts: (e.scripts || []).slice(0, 4).map((s) => [s.invoker, (s.sourceURL || '').split('/').pop(), s.sourceFunctionName, +s.duration.toFixed(1)]) })
    }).observe({ type: 'long-animation-frame', buffered: true })
  } catch { /* not supported */ }
  const paceLog = () => { // new switches only (pace keeps its last 80)
    const L = window.__pace?.log || [], last = logSeen
    logSeen = L.length ? L[L.length - 1].t : logSeen
    return L.filter((e) => e.t > last)
  }
  const flush = () => {
    if (!frames.length) return
    const body = JSON.stringify({ id, seq: sent++, ua: navigator.userAgent, dpr: devicePixelRatio, w: innerWidth, h: innerHeight,
      vis: document.visibilityState, view: window.__flight?.stage?.getView?.(), frames, input, loaf,
      pace, paceLog: paceLog(), paceState: window.__pace?.state ?? null })
    frames = []; input = []; loaf = []; pace = []
    fetch('/__perf', { method: 'POST', body, keepalive: body.length < 60000 }).catch(() => {})
  }
  setInterval(flush, 4000)
  addEventListener('pagehide', flush)
}
