// Coach mark for the sandbox: tells visitors they can click anywhere on the table. It sits just above the
// stage's pulsing ghost target (stage.setPlaceHint / getPlaceHintScreenPos, both feature-detected) and
// retires for the visit the first time anything runs in the sandbox.
import { $, reducedQuery } from './env.js';

const KEY = 'tvla.placeHint.dismissed';
const DELAY_MS = 600;
const GAP = 30;    // px between the target point and the pill's bottom edge
const EDGE = 12;   // min distance from viewport edges
const store = {
  get() { try { return sessionStorage.getItem(KEY) === '1'; } catch { return false; } },
  set() { try { sessionStorage.setItem(KEY, '1'); } catch { /* storage blocked: fine */ } },
};

const ICON = `<svg class="place-hint__icon" viewBox="2 2 20 20" width="26" height="26" aria-hidden="true" focusable="false">
  <circle class="ph-ripple" cx="9" cy="9" r="4.5" fill="none" stroke="currentColor" stroke-width="1.4"/>
  <circle class="ph-ripple ph-ripple--2" cx="9" cy="9" r="4.5" fill="none" stroke="currentColor" stroke-width="1.4"/>
  <path class="ph-cursor" d="M9 9l4.2 11.2 2.1-4.6 4.6-2.1z" fill="currentColor" stroke="var(--on-accent)" stroke-width="1.1" stroke-linejoin="round"/>
</svg>`;

export function initPlaceHint(stage) {
  const root = document.documentElement;
  const coarse = matchMedia('(pointer: coarse)');
  const narrow = matchMedia('(max-width: 820px)');

  const wrap = document.createElement('div');
  wrap.className = 'place-hint';
  wrap.hidden = true;
  const pill = document.createElement('div');
  pill.className = 'place-hint__pill';
  pill.innerHTML = ICON;
  const text = document.createElement('span');
  text.className = 'place-hint__text';
  text.setAttribute('role', 'status');
  text.setAttribute('aria-live', 'polite');
  pill.append(text);
  wrap.append(pill);
  document.body.append(wrap);

  const state = { dismissed: store.get(), chapter: document.body.dataset.chapter || 'hero', running: false, shown: false };
  let timer = 0, raf = 0, hinted = null, hintedReal = null, cur = null;

  const taskRunning = () => { try { return !!stage.getTaskProgress?.()?.running; } catch { return false; } };
  const want = () => state.chapter === 'sandbox' && !state.dismissed && !state.running && !taskRunning()
    && stage.available !== false && !root.classList.contains('no-stage') && !root.classList.contains('no-webgl') && !document.hidden;

  // Re-sent when the real stage attaches late, since it never saw the earlier call.
  const setHint = (on) => { if (hinted !== on || hintedReal !== stage.real) { hinted = on; hintedReal = stage.real; try { stage.setPlaceHint?.(on); } catch (e) { console.warn('setPlaceHint failed', e); } } };

  // Where the pill goes: above the stage's target, kept clear of the text column (or, on phones, of the picker).
  function place() {
    const w = pill.offsetWidth, h = pill.offsetHeight, vw = innerWidth, vh = innerHeight;
    const top = ($('#topbar')?.getBoundingClientRect().bottom ?? 68) + 8;
    let minX = EDGE, maxBottom = vh - EDGE, minTop = top, sure = false;
    let pos = null;
    try { pos = stage.getPlaceHintScreenPos?.() ?? null; } catch { pos = null; }
    if (pos && !(Number.isFinite(pos.x) && Number.isFinite(pos.y))) pos = null;

    if (narrow.matches) {
      // Portrait: the text panel rises over the lower scene. Keep to the strip between the top bar (and the
      // "3D: kinematic reconstruction" badge that sits under it) and the top of the panel.
      const panel = $('#sandbox .panel')?.getBoundingClientRect();
      const badge = $('.stage-badge');
      const br = badge && +getComputedStyle(badge).opacity > 0.1 ? badge.getBoundingClientRect() : null;
      if (br) minTop = Math.max(minTop, br.bottom + 8);
      if (panel) maxBottom = Math.min(maxBottom, panel.top - 8);
      if (maxBottom - minTop < h) maxBottom = minTop + h;
    } else {
      const col = ['.sandbox-intro', '.sandbox-row', '.picker-status', '.disclaimer']
        .map((s) => $(s)?.getBoundingClientRect().right ?? 0);
      minX = Math.min(Math.max(minX, Math.max(...col) + 24), vw - w - EDGE);
    }
    let x, y;
    // desktop: hang the pill below the target, over open table, so it never covers the grid
    const below = !!pos && !narrow.matches;
    if (pos) { x = pos.x; y = below ? pos.y + GAP + h : pos.y - GAP; sure = true; }
    else if (narrow.matches) { x = vw / 2; y = minTop + h; }
    else { x = (minX + vw) / 2; y = vh * 0.74; }
    const cx = Math.min(Math.max(x, minX + w / 2), vw - EDGE - w / 2);
    const by = Math.min(Math.max(y, minTop + h), maxBottom);
    return { x: cx, y: by, below, caret: sure && by === y ? x - cx : null };
  }

  function frame() {
    raf = 0;
    if (!state.shown) return;
    if (!want()) { hide(); return; }
    setHint(true);
    const t = place();
    const snap = reducedQuery.matches || !cur;
    cur = snap ? t : { x: cur.x + (t.x - cur.x) * 0.35, y: cur.y + (t.y - cur.y) * 0.35, caret: t.caret };
    wrap.style.transform = `translate3d(${cur.x.toFixed(1)}px, ${cur.y.toFixed(1)}px, 0)`;
    pill.classList.toggle('is-below', !!t.below);
    if (cur.caret === null) pill.classList.add('is-nocaret');
    else { pill.classList.remove('is-nocaret'); pill.style.setProperty('--caret-x', `${(t.caret ?? 0).toFixed(1)}px`); }
    raf = requestAnimationFrame(frame);
  }

  function show() {
    if (state.shown || !want()) return;
    state.shown = true;
    text.innerHTML = `<strong>${coarse.matches ? 'Tap' : 'Click'} anywhere on the table</strong><br>The arm will plan a path and pick it up there`;
    wrap.hidden = false;
    cur = null;
    pill.classList.remove('is-in');
    setHint(true);
    place(); // measure before revealing
    frame();
    void pill.offsetWidth;
    pill.classList.add('is-in');
  }

  function hide() {
    cancelAnimationFrame(raf); raf = 0;
    state.shown = false;
    wrap.hidden = true;
    pill.classList.remove('is-in');
    text.textContent = '';
    setHint(false);
  }

  // The stage may be mid-task when the chapter opens (its own intro run), so poll: show once the sandbox
  // has been idle and in view for DELAY_MS.
  let readySince = 0;
  const poll = () => {
    if (state.shown) return;
    if (!want()) { readySince = 0; return; }
    readySince ||= performance.now();
    if (performance.now() - readySince >= DELAY_MS) show();
  };
  const schedule = () => {
    clearInterval(timer); timer = 0; readySince = 0;
    if (state.chapter !== 'sandbox') { hide(); return; }
    if (!state.dismissed) timer = setInterval(poll, 120);
  };

  document.addEventListener('chapterchange', (e) => { state.chapter = e.detail; schedule(); });
  document.addEventListener('sandbox:run', (e) => {
    state.running = !!e.detail?.running;
    if (state.running) { state.dismissed = true; store.set(); hide(); clearInterval(timer); timer = 0; }
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) hide(); else schedule(); });
  schedule();
  return { show, hide, dismiss: () => { state.dismissed = true; store.set(); hide(); clearInterval(timer); timer = 0; } };
}
