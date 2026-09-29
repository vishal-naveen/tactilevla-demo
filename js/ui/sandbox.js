import { $ } from './env.js';

const ROWS = [['A1', 'B1', 'C1'], ['A2', 'B2', 'C2'], ['A3', 'B3', 'C3']]; // row 1 nearest the arm
const SITE = 'vishal-naveen.github.io/TactileVLA-Edge';

// Composite the stage's clean frame with a caption strip and download it.
async function saveFrame(stage, status) {
  try {
    const blob = await stage.snapshot();
    const bmp = await createImageBitmap(blob);
    const strip = Math.max(64, Math.round(bmp.width * 0.045));
    const canvas = document.createElement('canvas');
    canvas.width = bmp.width; canvas.height = bmp.height + strip;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bmp, 0, 0);
    const css = getComputedStyle(document.documentElement);
    const tok = (n, d) => css.getPropertyValue(n).trim() || d;
    ctx.fillStyle = tok('--wall-2', '#060b15');
    ctx.fillRect(0, bmp.height, canvas.width, strip);
    const pad = Math.round(strip * 0.4);
    ctx.textBaseline = 'middle';
    ctx.font = `600 ${Math.round(strip * 0.32)}px Archivo, system-ui, sans-serif`;
    ctx.fillStyle = tok('--ivory', '#f4ecd8'); ctx.textAlign = 'left';
    ctx.fillText('TactileVLA-Edge — kinematic reconstruction, vision-only', pad, bmp.height + strip / 2);
    ctx.font = `400 ${Math.round(strip * 0.28)}px Archivo, system-ui, sans-serif`;
    ctx.fillStyle = tok('--dim', '#a3b3c6'); ctx.textAlign = 'right';
    ctx.fillText(SITE, canvas.width - pad, bmp.height + strip / 2);
    const out = await new Promise((res) => canvas.toBlob(res, 'image/png'));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(out); a.download = 'tactilevla-edge-frame.png';
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    status.textContent = 'Frame saved.';
  } catch (err) {
    console.warn('snapshot failed', err);
    status.textContent = 'Couldn’t save that frame.';
  }
}

export function initSandbox(stage) {
  const picker = $('#picker');
  const status = $('#picker-status');
  const save = $('#save-frame');
  const buttons = new Map();
  let running = false;
  // Lets the place-hint coach mark (and anything else) follow runs without touching this module's state.
  const announce = (on) => document.dispatchEvent(new CustomEvent('sandbox:run', { detail: { running: on } }));

  // aria-disabled (not `disabled`) so keyboard focus survives a run.
  const setBusy = (busy, active) => buttons.forEach((b, c) => {
    b.setAttribute('aria-disabled', String(busy));
    b.classList.toggle('is-running', busy && c === active);
  });

  ROWS.flat().forEach((cell) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'cell-btn' + (cell === 'B2' ? ' cell-btn--held' : '');
    b.textContent = cell;
    b.setAttribute('aria-label', cell === 'B2' ? 'Replay the scripted task at B2 (held out)' : `Replay the scripted task at ${cell}`);
    b.setAttribute('aria-disabled', 'false');
    b.addEventListener('click', () => run(cell));
    picker.append(b);
    buttons.set(cell, b);
  });

  if (save) save.addEventListener('click', () => saveFrame(stage, status));

  // Disabled until a stage exists; enable() is called when it attaches (possibly late).
  const disable = (msg = 'The 3D reconstruction is still loading…') => {
    document.documentElement.classList.add('no-webgl');
    setBusy(true);
    running = true; // guard: nothing to run without a stage
    if (save) save.hidden = true;
    status.textContent = msg;
  };
  const enable = () => {
    document.documentElement.classList.remove('no-webgl');
    running = false;
    setBusy(false);
    status.textContent = 'Choose a cell.';
    if (save && typeof stage.snapshot === 'function') save.hidden = false;
  };
  if (stage.available === false) disable(); else enable();

  async function run(cell) {
    if (running) return;
    running = true;
    announce(true);
    setBusy(true, cell);
    status.textContent = `Replaying ${cell}…`;
    try { await stage.runTask(cell); }
    catch (err) { console.warn('runTask failed', err); }
    finally {
      running = false;
      announce(false);
      setBusy(false);
      status.textContent = `Replayed ${cell}. Pick another cell.`;
    }
  }

  // Clicking anywhere on the table plans a pick from that point (cells still go through the picker path).
  const m = (v) => `${Number(v).toFixed(2)} m`;
  async function runAt(point, cell) {
    if (running) return;
    running = true;
    announce(true);
    setBusy(true, cell || null);
    status.textContent = 'Planning…';
    const where = cell ? `cell ${cell}` : `${m(point.x)}, ${m(point.z)}`;
    let settled = false;
    const later = setTimeout(() => { if (!settled) status.textContent = `Replaying at ${where}…`; }, 350);
    let result = 'ok';
    try { result = await stage.runTaskAt(point); }
    catch (err) { console.warn('runTaskAt failed', err); result = 'unreachable'; }
    finally {
      settled = true; clearTimeout(later);
      running = false;
      announce(false);
      setBusy(false);
      status.textContent = result === 'unreachable'
        ? 'Out of reach — try closer to the arm.'
        : `Replayed at ${where}. Pick another cell, or click the table.`;
    }
  }
  stage.onTableClick((point, cell) => runAt(point, cell));

  // Clicking cells in the 3D scene takes the same path as the picker.
  stage.onCellClick((cell) => run(cell));
  return { enable, disable };
}
