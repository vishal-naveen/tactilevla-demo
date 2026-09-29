import { $$, reduced } from './env.js';
import { guards, playback, setFullscreen } from './video-guard.js';

// A "Watch fullscreen" button on every <video> (hero inset, time-lapse, camera streams, film reels).
// Click: start playback if paused (stays muted unless the reel was already engaged with sound), then put the VIDEO ELEMENT
// itself in fullscreen (Fullscreen API, then webkit-prefixed, then iOS Safari's webkitEnterFullscreen: the only route on
// iPhone). Native controls are added for the duration so people can scrub, and removed again on exit. Captions (<track>)
// keep working because the element that goes fullscreen is the video. Everything else that cares (stage, tour, film reels,
// the one-clip-at-a-time arbiter) hears about it through the 'media:fullscreen' event and video-guard's playback state.
const ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const fsElement = () => document.fullscreenElement || document.webkitFullscreenElement || null;

function wire(v) {
  const box = v.parentElement;
  if (!box || box.querySelector(':scope > .fs-btn')) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'fs-btn';
  btn.setAttribute('aria-label', 'Watch fullscreen');
  btn.innerHTML = ICON;
  box.append(btn);

  let active = false;
  let hadControls = false;
  let iosFs = false;

  const enter = () => {
    if (active) return;
    active = true;
    hadControls = v.controls;
    v.controls = true;
    setFullscreen(v);
    document.dispatchEvent(new CustomEvent('media:fullscreen', { detail: { on: true, video: v } }));
  };
  const leave = () => {
    if (!active) return;
    active = false;
    v.controls = hadControls;
    setFullscreen(null);
    if (reduced) guards.get(v)?.pause();
    document.dispatchEvent(new CustomEvent('media:fullscreen', { detail: { on: false, video: v } }));
  };
  const sync = () => {
    const now = fsElement() === v || iosFs;
    if (now) enter(); else leave();
  };
  ['fullscreenchange', 'webkitfullscreenchange'].forEach((ev) => document.addEventListener(ev, sync));
  v.addEventListener('webkitbeginfullscreen', () => { iosFs = true; sync(); });
  v.addEventListener('webkitendfullscreen', () => { iosFs = false; sync(); });

  const iosEnter = () => {
    if (!v.webkitEnterFullscreen) return;
    const go = () => { try { v.webkitEnterFullscreen(); } catch { /* not ready: the play button still works inline */ } };
    if (v.readyState >= 1) { go(); return; }
    v.addEventListener('loadedmetadata', go, { once: true });
  };
  const request = () => {
    if (v.requestFullscreen) {
      const p = v.requestFullscreen();
      if (p?.catch) p.catch(iosEnter);
    } else if (v.webkitRequestFullscreen) {
      v.webkitRequestFullscreen();
    } else {
      iosEnter();
    }
  };

  btn.addEventListener('click', (e) => {
    e.stopPropagation(); // never reaches the reel/clip handlers, so nothing runs twice
    const g = guards.get(v);
    setFullscreen(v); // lock in before the arbiter can react to the request
    if (g) g.start().catch(() => {}); else v.play()?.catch?.(() => {});
    request();
    // if the browser never confirms (request refused), release the lock so the arbiter and reels behave normally again
    setTimeout(() => { if (!active && playback.fullscreen === v) setFullscreen(null); }, 4000);
  });
}

export function initFullscreen() {
  $$('video').forEach(wire);
}
