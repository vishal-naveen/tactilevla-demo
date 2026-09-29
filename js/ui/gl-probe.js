// Is there a real GPU behind WebGL2? On a software renderer (hardware acceleration switched off) the 3D
// scene would crawl at about 1 fps, so the page skips it and says why instead.
const SOFTWARE = /SwiftShader|llvmpipe|Software|Basic Render/i;
const KEY = 'tve-gl-note-dismissed';

// The probe only ever says "software" when it has positive evidence (a software renderer string, or the
// browser refusing a hardware-only context AND the retry naming a software renderer). Anything uncertain,
// such as a busy GPU, Chrome's context limit or a throw, counts as hardware and createStage is the judge.
function readRenderer(gl) {
  try {
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    return info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL) || '') : '';
  } catch { return ''; }
}
function release(gl) {
  try { gl.getExtension('WEBGL_lose_context')?.loseContext(); } catch { /* already gone */ }
}

export function probeGL() {
  try {
    // 1. Ask for hardware only. A context here means a real GPU.
    const strict = document.createElement('canvas').getContext('webgl2', { failIfMajorPerformanceCaveat: true });
    if (strict) {
      const renderer = readRenderer(strict);
      release(strict);
      return SOFTWARE.test(renderer) ? { ok: false, reason: 'software', renderer } : { ok: true, reason: '', renderer };
    }
    // 2. Refused. That can be transient (busy GPU, several contexts), so retry without the caveat flag and
    //    decide only from the renderer string.
    const loose = document.createElement('canvas').getContext('webgl2');
    if (!loose) return { ok: true, reason: 'probe-inconclusive', renderer: '' }; // context limit or no WebGL2: createStage decides
    const renderer = readRenderer(loose);
    release(loose);
    return SOFTWARE.test(renderer) ? { ok: false, reason: 'software', renderer } : { ok: true, reason: '', renderer };
  } catch {
    return { ok: true, reason: 'probe-threw', renderer: '' };
  }
}

const dismissed = () => { try { return localStorage.getItem(KEY) === '1'; } catch { return false; } };
const remember = () => { try { localStorage.setItem(KEY, '1'); } catch { /* private mode */ }; };

// Small dismissible pill, bottom-left. Not a banner.
export function showHardwareNote(renderer = '') {
  if (dismissed()) return;
  const chrome = /Chrome\//.test(navigator.userAgent) && !/Edg\/|OPR\//.test(navigator.userAgent);
  const note = document.createElement('div');
  note.className = 'gl-note';
  note.setAttribute('role', 'note');
  const text = document.createElement('p');
  text.textContent = 'The 3D scene needs hardware acceleration. Turn it on in your browser settings and reload to see it.'
    + (chrome ? ' In Chrome: Settings → System → “Use graphics acceleration when available”, then relaunch Chrome.' : '')
    + (renderer ? ` (Your browser reports: ${renderer}.)` : '');
  const close = document.createElement('button');
  close.type = 'button';
  close.setAttribute('aria-label', 'Dismiss this note');
  close.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  close.addEventListener('click', () => { remember(); note.remove(); });
  note.append(text, close);
  document.body.append(note);
}
