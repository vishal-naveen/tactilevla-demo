import { $, $$, reduced } from './env.js';

// Joint-state HUD. Reads stage.getJointState() (~20 Hz, only while a HUD is on screen) and shows the
// reconstruction's joint angles in URDF convention. Decorative: the live numbers are aria-hidden.
// These are NOT readings from the physical arm, and the copy never says otherwise.

const LABEL = 'Joint state, live from the 3D reconstruction';
const ROWS = [
  ['shoulder_pan', 'Shoulder pan', 110], ['shoulder_lift', 'Shoulder lift', 110], ['elbow_flex', 'Elbow flex', 110],
  ['wrist_flex', 'Wrist flex', 110], ['wrist_roll', 'Wrist roll', 160],
];
const PLAY_I = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z"/></svg>';
const PAUSE_I = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/></svg>';
const PHASES = ['approach', 'descend', 'grasp', 'lift', 'carry', 'release', 'return'];
const cap = (s) => s[0].toUpperCase() + s.slice(1);
const DEG = 180 / Math.PI;
const fmt = (d) => {
  const v = Math.abs(d) < 0.05 ? 0 : d;
  return `${v < 0 ? '−' : '+'}${Math.abs(v).toFixed(1)}°`;
};

function build(variant) {
  const gauges = variant === 'full';
  const el = document.createElement('aside');
  el.className = `telemetry telemetry--${variant}`;
  el.innerHTML = `
    <p class="sr-only">A live readout of the 3D arm’s joint angles, in URDF convention, with the current step of the pick-and-place. It comes from the reconstruction, not the physical robot.${variant === 'full' ? ' The step buttons and the timeline slider replay or scrub the reconstruction’s last run.' : ''}</p>
    <div class="tm">
      <div class="tm-live" aria-hidden="true">
        <p class="tm-label">${LABEL}</p>
        ${variant === 'hero' ? '' : '<p class="tm-cell"><span class="tm-cell-n">Idle</span></p>'}
        <ul class="tm-rows">
          ${ROWS.map(([k, name]) => `<li data-k="${k}"><span class="tm-name">${name}</span><span class="tm-val">+0.0°</span>${gauges ? '<span class="tm-gauge"><i></i></span>' : ''}</li>`).join('')}
          <li data-k="gripper"><span class="tm-name">Gripper</span><span class="tm-val">open 0%</span>${gauges ? '<span class="tm-gauge tm-gauge--one"><i></i></span>' : ''}</li>
        </ul>
      </div>
      ${variant === 'full' ? `
      <ol class="tm-phase" aria-label="Steps of the pick-and-place">${PHASES.map((p) => `<li><button type="button" data-p="${p}" aria-disabled="true">${cap(p)}</button></li>`).join('')}</ol>
      <div class="tm-scrub" data-off="true">
        <button type="button" class="tm-play" aria-label="Play" aria-disabled="true"></button>
        <div class="tm-track" role="slider" tabindex="0" aria-label="Task timeline" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" aria-valuetext="No run yet" aria-disabled="true">
          <div class="tm-segs"></div><i class="tm-head"></i>
        </div>
      </div>` : ''}
    </div>`;
  return el;
}

export function initTelemetry(stage) {
  const instances = [];
  const cellVar = { current: '' };
  let visibleCount = 0;
  let raf = 0, lastPoll = 0;
  const interval = reduced ? 250 : 50; // 4 Hz reduced, ~20 Hz otherwise

  function make(host, variant, { prepend = false } = {}) {
    if (!host) return null;
    const el = build(variant);
    prepend ? host.prepend(el) : host.append(el);
    const inst = {
      el, variant, visible: false,
      rows: Object.fromEntries($$('li[data-k]', el).map((li) => [li.dataset.k, {
        val: $('.tm-val', li), bar: $('.tm-gauge i', li), cur: 0, txt: '',
      }])),
      phases: $$('.tm-phase button', el), tp: null, cellN: $('.tm-cell-n', el), lastPhase: null,
    };
    if (variant === 'full') {
      Object.assign(inst, {
        scrub: $('.tm-scrub', el), play: $('.tm-play', el), track: $('.tm-track', el),
        segs: $('.tm-segs', el), head: $('.tm-head', el), enabled: false, sig: '', playing: null,
      });
      inst.play.innerHTML = PLAY_I;
      inst.play.setAttribute('aria-label', 'Play');
      wireScrub(inst);
    }
    new IntersectionObserver((entries) => {
      const v = entries[0].isIntersecting;
      if (v === inst.visible) return;
      inst.visible = v;
      visibleCount += v ? 1 : -1;
      if (visibleCount > 0) start();
    }, { threshold: 0.2 }).observe(el);
    instances.push(inst);
    return inst;
  }

  function paint(inst, s) {
    const ease = reduced ? 1 : 0.35;
    for (const [k, , range] of ROWS) {
      const r = inst.rows[k];
      const tgt = (s.joints?.[k] ?? 0) * DEG;
      r.cur += (tgt - r.cur) * ease;
      const txt = fmt(r.cur);
      if (txt !== r.txt) { r.val.textContent = txt; r.txt = txt; }
      if (r.bar) {
        const f = Math.max(-1, Math.min(1, r.cur / range));
        r.bar.style.setProperty('--a', f.toFixed(3));
      }
    }
    const g = inst.rows.gripper;
    g.cur += ((s.gripperOpen ?? 0) - g.cur) * ease;
    const gt = `open ${Math.round(g.cur * 100)}%`;
    if (gt !== g.txt) { g.val.textContent = gt; g.txt = gt; }
    if (g.bar) g.bar.style.setProperty('--a', g.cur.toFixed(3));

    if (s.phase !== inst.lastPhase) {
      inst.lastPhase = s.phase;
      inst.phases.forEach((b) => b.classList.toggle('is-on', b.dataset.p === s.phase));
      if (inst.cellN) {
        const p = s.phase && s.phase !== 'idle' ? cap(s.phase) : 'Idle';
        inst.cellN.textContent = inst.variant === 'full'
          ? (s.cell ? `Cell ${s.cell}` : 'No task running')
          : `${p}${s.cell ? `, cell ${s.cell}` : ''}`;
        cellVar.current = s.cell || '';
      }
    } else if (inst.cellN && inst.variant === 'full') {
      const t = s.cell ? `Cell ${s.cell}` : 'No task running';
      if (inst.cellN.textContent !== t) inst.cellN.textContent = t;
    }
  }

  // ---- Task timeline (full variant): a scrubber over the stage's last task --------------------------
  const PH_SEG = ['approach', 'descend', 'grasp', 'lift', 'carry', 'release', 'return'];
  const task = { sig: '', timeline: [], enabled: false, dragging: false };
  const phaseWord = (p) => (p ? cap(p) : '');
  const canScrub = () => stage.has('scrubTask');
  function scrubTo(t) { const c = Math.max(0, Math.min(1, t)); task.last = c; task.lastAt = performance.now(); stage.scrubTask(c); }
  function setEnabled(inst, on) {
    if (inst.enabled === on) return;
    inst.enabled = on;
    inst.scrub.dataset.off = String(!on);
    [inst.play, inst.track, ...inst.phases].forEach((n) => n.setAttribute('aria-disabled', String(!on)));
  }
  function paintTask(inst, tp) {
    const usable = !!tp && Array.isArray(tp.timeline) && tp.timeline.length > 0 && (tp.running || tp.paused || tp.t > 0);
    setEnabled(inst, usable && canScrub());
    if (!tp || !Array.isArray(tp.timeline)) return;
    const sig = tp.timeline.map((x) => `${x.phase}:${(x.t1 - x.t0).toFixed(3)}`).join('|');
    if (sig !== inst.sig) {
      inst.sig = sig;
      task.timeline = tp.timeline;
      inst.segs.innerHTML = tp.timeline.map((x) => `<span data-p="${x.phase}" style="flex-grow:${Math.max(0.001, x.t1 - x.t0)}" title="${phaseWord(x.phase)}"></span>`).join('');
    }
    const t = Math.max(0, Math.min(1, tp.t || 0));
    inst.head.style.left = `${(t * 100).toFixed(2)}%`;
    inst.segs.querySelectorAll('span').forEach((sp) => sp.classList.toggle('is-on', sp.dataset.p === tp.phase && usable));
    const pct = Math.round(t * 100);
    inst.track.setAttribute('aria-valuenow', String(pct));
    inst.track.setAttribute('aria-valuetext', usable ? `${phaseWord(tp.phase) || 'Done'}, ${pct}%` : 'No run yet');
    const playing = tp.running && !tp.paused;
    if (inst.playing !== playing) {
      inst.playing = playing;
      inst.play.innerHTML = playing ? PAUSE_I : PLAY_I;
      inst.play.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    }
  }
  function wireScrub(inst) {
    const { track, play } = inst;
    const frac = (x) => { const r = track.getBoundingClientRect(); return (x - r.left) / r.width; };
    track.addEventListener('pointerdown', (e) => {
      if (!inst.enabled) return;
      e.preventDefault(); track.setPointerCapture(e.pointerId); task.dragging = true; scrubTo(frac(e.clientX));
    });
    track.addEventListener('pointermove', (e) => { if (task.dragging) scrubTo(frac(e.clientX)); });
    const end = () => { task.dragging = false; };
    track.addEventListener('pointerup', end); track.addEventListener('pointercancel', end);
    track.addEventListener('keydown', (e) => {
      if (!inst.enabled) return;
      // use the value we just sent while a scrub is in flight (the polled value can lag a frame or two)
      const now = performance.now() - (task.lastAt || 0) < 400 && task.last !== undefined ? task.last : Number(track.getAttribute('aria-valuenow')) / 100;
      const step = { ArrowLeft: -0.02, ArrowDown: -0.02, ArrowRight: 0.02, ArrowUp: 0.02, PageDown: -0.1, PageUp: 0.1 }[e.key];
      if (step !== undefined) { e.preventDefault(); scrubTo(now + step); }
      else if (e.key === 'Home') { e.preventDefault(); scrubTo(0); }
      else if (e.key === 'End') { e.preventDefault(); scrubTo(1); }
    });
    play.addEventListener('click', () => {
      if (!inst.enabled) return;
      const tp = stage.getTaskProgress();
      if (!tp) return;
      if (tp.running && !tp.paused) stage.pauseTask();
      else { if (tp.t >= 0.999) scrubTo(0); stage.resumeTask(); }
    });
    inst.phases.forEach((b) => b.addEventListener('click', () => jumpToPhase(b.dataset.p)));
  }
  function jumpToPhase(p) {
    const inst = instances.find((i) => i.variant === 'full');
    if (!inst?.enabled) return;
    const seg = (task.timeline.length ? task.timeline : stage.getTaskProgress()?.timeline || []).find((x) => x.phase === p);
    if (seg) scrubTo(seg.t0);
  }
  stage.onPhaseClick(jumpToPhase);

  function tick(now) {
    raf = 0;
    if (visibleCount <= 0) return;
    if (now - lastPoll >= interval) {
      lastPoll = now;
      const real = stage.real;
      const s = real && typeof real.getJointState === 'function' ? safeState(real) : null;
      if (s) instances.forEach((i) => { if (i.visible) paint(i, s); });
      const tp = stage.getTaskProgress();
      instances.forEach((i) => { if (i.variant === 'full' && i.visible) paintTask(i, tp); });
    }
    raf = requestAnimationFrame(tick);
  }
  function start() { if (!raf) raf = requestAnimationFrame(tick); }
  const safeState = (real) => { try { return real.getJointState(); } catch { return null; } };

  // 3D angle arcs on in sandbox/policies; phase words on in the sandbox only (the hero stays plain)
  const want = { gauges: false, markers: false };
  const sent = { gauges: null, markers: null };
  function flush() {
    const real = stage.real;
    if (!real) return;
    if (sent.gauges !== want.gauges && typeof real.setJointGauges === 'function') { real.setJointGauges(want.gauges); sent.gauges = want.gauges; }
    if (sent.markers !== want.markers && typeof real.setPhaseMarkers === 'function') { real.setPhaseMarkers(want.markers); sent.markers = want.markers; }
  }
  document.addEventListener('chapterchange', (e) => {
    want.gauges = e.detail === 'sandbox' || e.detail === 'policies';
    want.markers = e.detail === 'sandbox';
    flush();
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && visibleCount > 0) start(); });

  make($('.chapter--hero'), 'hero');
  make($('#policies .policies-hud'), 'compact');
  const sbHost = $('#sandbox .sandbox-hud');
  make(sbHost, 'full');
  return {
    resync() { sent.gauges = null; sent.markers = null; flush(); if (visibleCount > 0) start(); },
  };
}
