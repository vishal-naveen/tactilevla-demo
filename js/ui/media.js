import { $, $$, reduced } from './env.js';

const PAUSE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/></svg>';
const PLAY_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z"/></svg>';

// Muted looping clips play only while in view, and always carry a visible pause/play toggle (WCAG 2.2.2).
// With reduced motion they stay paused on the poster. If the browser refuses autoplay (iOS Low Power
// Mode), the big play button is revealed instead of leaving a dead frame.
export function initClips() {
  $$('[data-clip]').forEach((box) => {
    const v = $('video', box);
    const bigPlay = $('.clip-play', box);
    if (!v || !bigPlay) return;
    let userPaused = reduced;

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'clip-toggle';
    toggle.setAttribute('aria-label', 'Pause looping video');
    box.append(toggle);
    const paint = () => {
      toggle.setAttribute('aria-pressed', String(v.paused));
      toggle.innerHTML = v.paused ? PLAY_ICON : PAUSE_ICON;
    };
    ['play', 'pause'].forEach((ev) => v.addEventListener(ev, paint));
    toggle.addEventListener('click', () => {
      if (v.paused) { userPaused = false; v.play().catch(() => {}); bigPlay.hidden = true; }
      else { userPaused = true; v.pause(); }
    });

    bigPlay.addEventListener('click', () => {
      userPaused = false;
      v.play().catch(() => {});
      bigPlay.hidden = true;
    });

    if (reduced) {
      v.autoplay = false; v.removeAttribute('autoplay'); v.pause();
      bigPlay.hidden = false;
      paint();
      return;
    }
    paint();
    const tryPlay = () => v.play().then(() => { bigPlay.hidden = true; }).catch(() => { bigPlay.hidden = false; });
    new IntersectionObserver((entries) => {
      entries.forEach((e) => { if (e.isIntersecting) { if (!userPaused) tryPlay(); } else v.pause(); });
    }, { threshold: 0.4 }).observe(box);
  });
}
