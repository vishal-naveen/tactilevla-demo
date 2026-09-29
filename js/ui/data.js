import { $, useMock } from './env.js';
import { onScrub } from './scroll.js';

// Prefer the stage's own protocol so the counter and the 3D grid can never disagree.
async function loadProtocol() {
  if (!useMock) {
    try { return await import('../stage/protocol.js'); } catch { /* fall through */ }
  }
  return import('./protocol-local.js');
}

export async function initData() {
  const proto = await loadProtocol();
  const { episodeAt } = proto;
  const fillEnd = Number.isFinite(proto.DATA_FILL_END) && proto.DATA_FILL_END > 0 ? proto.DATA_FILL_END : 0.55; // the stage fills all 160 episodes by here
  const counter = $('#counter');
  const n = $('#counter-n');
  const sub = $('#counter-sub');

  let lastCount = -1;
  const render = (p) => {
    const e = episodeAt(Math.min(1, p / fillEnd));
    if (e.count === lastCount) return;
    lastCount = e.count;
    n.textContent = String(e.count);
    counter.classList.toggle('is-full', e.count === 160);
    sub.textContent = e.cell ? `Cell ${e.cell}, round ${e.round}` : 'No episodes recorded yet';
  };
  render(0);
  onScrub('data', render);
}
