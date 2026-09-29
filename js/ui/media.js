import { $, $$, reduced } from './env.js';
import { guardVideo, playback } from './video-guard.js';

const PAUSE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/></svg>';
const PLAY_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z"/></svg>';

// Muted looping clips play only while in view, and always carry a visible pause/play toggle (WCAG 2.2.2).
// With reduced motion they stay paused on the poster. If the browser refuses autoplay (iOS Low Power
// Mode), the big play button is revealed instead of leaving a dead frame.
//
// iOS decodes only a few videos at once, so exactly ONE clip plays at a time (the one most in view, and none while a film
// reel the visitor engaged owns the decoders); every other clip is paused, and once fully out of view for a few seconds it is
// unloaded (src dropped, poster shown) to free its decoder. Each clip is wrapped by guardVideo(): poster painted behind the
// video until a decoded frame exists (no black box), error/stall recovery, background-resume.
const UNLOAD_AFTER_MS = 3000;
const PLAY_RATIO = 0.4;

export function initClips() {
  const clips = [];
  const arbitrate = () => {
    let best = null;
    if (playback.fullscreen) {
      best = clips.find((c) => c.g.v === playback.fullscreen) || null; // fullscreen video wins; every other loop rests
    } else if (!playback.exclusive && !document.hidden) {
      for (const c of clips) if (!c.userPaused && c.ratio >= PLAY_RATIO && (!best || c.ratio > best.ratio)) best = c;
    }
    for (const c of clips) {
      if (c === best) {
        clearTimeout(c.unloadTimer);
        if (c.g.v.paused) c.tryPlay();
      } else {
        c.g.pause();
        if (c.ratio === 0 && !playback.fullscreen) {
          clearTimeout(c.unloadTimer);
          c.unloadTimer = setTimeout(() => { if (c.ratio === 0 && c.g.v.paused) c.g.unload(); }, UNLOAD_AFTER_MS);
        }
      }
    }
  };

  $$('[data-clip]').forEach((box) => {
    const v = $('video', box);
    const bigPlay = $('.clip-play', box);
    if (!v || !bigPlay) return;
    v.removeAttribute('autoplay'); // one player at a time: the arbiter below decides, not the attribute
    const g = guardVideo(box, v);
    const clip = { box, g, ratio: 0, userPaused: reduced, unloadTimer: 0, tryPlay: () => {} };

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
      if (v.paused) { clip.userPaused = false; clip.tryPlay(); bigPlay.hidden = true; }
      else { clip.userPaused = true; g.pause(); }
    });

    bigPlay.addEventListener('click', () => {
      clip.userPaused = false;
      clip.tryPlay();
      bigPlay.hidden = true;
    });

    if (reduced) {
      v.autoplay = false; v.pause();
      bigPlay.hidden = false;
      paint();
      return;
    }
    paint();
    clip.tryPlay = () => g.start().then(() => { bigPlay.hidden = true; }).catch(() => { bigPlay.hidden = false; });
    clips.push(clip);
    new IntersectionObserver((entries) => {
      entries.forEach((e) => { clip.ratio = e.isIntersecting ? e.intersectionRatio : 0; });
      arbitrate();
    }, { threshold: [0, 0.15, 0.4, 0.7, 1] }).observe(box);
  });

  document.addEventListener('media:exclusive', arbitrate);
  document.addEventListener('visibilitychange', arbitrate);
}
