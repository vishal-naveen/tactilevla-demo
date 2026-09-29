import { $$, reduced } from './env.js';

// 20 trial dots per row: `k` filled first, then hollow. No per-trial order exists, so this is a count.
export function initResults() {
  const rows = $$('#rows .row');
  rows.forEach((row) => {
    const k = Number(row.dataset.k);
    const dots = row.querySelector('.dots');
    for (let i = 0; i < 20; i++) {
      const d = document.createElement('span');
      d.className = 'dot' + (i < k ? ' is-hit' : '');
      dots.append(d);
    }
  });
  if (reduced) return;

  // Armed = empty. Entering view fades the filled dots in together and opens each interval from its estimate.
  rows.forEach((row) => {
    row.querySelector('.dots').classList.add('is-armed');
    row.querySelector('.interval').classList.add('is-armed');
  });
  const io = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      io.unobserve(entry.target);
      const row = entry.target;
      const filled = [...row.querySelectorAll('.dot.is-hit')];
      // All at once: a left-to-right stagger would imply trial order, and none exists.
      filled.forEach((d) => d.classList.add('is-on'));
      row.querySelector('.dots').classList.add('is-lit');
      setTimeout(() => row.querySelector('.interval').classList.remove('is-armed'), 500);
    });
  }, { threshold: 0.7 });
  rows.forEach((r) => io.observe(r));
}
