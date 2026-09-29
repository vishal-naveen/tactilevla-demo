import { $, $$, reduced } from './env.js';
import { guardVideo, setExclusive } from './video-guard.js';

const ICON = {
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/></svg>',
  sound: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4zM15 8.5a5 5 0 0 1 0 7M17.5 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="#f3ead6" stroke-width="1.6" stroke-linecap="round"/></svg>',
  muted: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9.5l5 5m0-5l-5 5" fill="none" stroke="#f3ead6" stroke-width="1.6" stroke-linecap="round"/></svg>',
};

// Minimal controls: play/pause, scrub bar, mute. Native controls remain the no-JS / failsafe fallback.
function buildControls(frame, v) {
  const bar = document.createElement('div');
  bar.className = 'vc';
  bar.innerHTML = `<button type="button" class="vc-play" aria-label="Pause"></button>
    <div class="vc-bar" role="slider" tabindex="0" aria-label="Seek" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span><i></i></span></div>
    <button type="button" class="vc-mute" aria-label="Mute"></button>
    ${v.textTracks && v.textTracks.length ? '<button type="button" class="vc-cc" aria-label="Captions" aria-pressed="false">CC</button>' : ''}`;
  frame.append(bar);
  const play = $('.vc-play', bar), mute = $('.vc-mute', bar), seek = $('.vc-bar', bar), prog = $('i', bar);
  const sync = () => {
    play.innerHTML = v.paused ? ICON.play : ICON.pause;
    play.setAttribute('aria-label', v.paused ? 'Play' : 'Pause');
    mute.innerHTML = v.muted ? ICON.muted : ICON.sound;
    mute.setAttribute('aria-label', v.muted ? 'Unmute' : 'Mute');
  };
  const frac = () => (v.duration ? v.currentTime / v.duration : 0);
  const paint = () => { prog.style.setProperty('--t', frac().toFixed(4)); seek.setAttribute('aria-valuenow', String(Math.round(frac() * 100))); };
  const seekTo = (clientX) => {
    const r = seek.getBoundingClientRect();
    if (v.duration) v.currentTime = Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * v.duration;
  };
  const cc = $('.vc-cc', bar);
  if (cc) {
    const track = v.textTracks[0];
    track.mode = 'disabled';
    cc.addEventListener('click', () => {
      const on = track.mode !== 'showing';
      track.mode = on ? 'showing' : 'disabled';
      cc.setAttribute('aria-pressed', String(on));
    });
  }
  play.addEventListener('click', () => (v.paused ? v.play() : v.pause()));
  mute.addEventListener('click', () => { v.muted = !v.muted; sync(); });
  seek.addEventListener('pointerdown', (e) => { seek.setPointerCapture(e.pointerId); seekTo(e.clientX); seek.onpointermove = (m) => seekTo(m.clientX); });
  seek.addEventListener('pointerup', () => { seek.onpointermove = null; });
  seek.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') v.currentTime = Math.min(v.duration || 0, v.currentTime + 2);
    if (e.key === 'ArrowLeft') v.currentTime = Math.max(0, v.currentTime - 2);
  });
  ['play', 'pause', 'volumechange'].forEach((ev) => v.addEventListener(ev, sync));
  v.addEventListener('timeupdate', paint);
  v.addEventListener('click', () => (v.paused ? v.play() : v.pause()));
  sync();
}

export function initFilm() {
  const reels = $$('.reel');
  let engaged = null;
  // Each reel's video is wrapped once: poster painted behind it until a real frame exists, error/stall recovery, and
  // unload() (src dropped, poster back) whenever it is not the one playing, so iOS never holds more than one decoder here.
  const guards = new Map(reels.map((reel) => [reel, guardVideo($('.frame', reel), $('video', reel))]));

  const preview = (reel) => {
    if (reduced || engaged === reel) return;
    guards.get(reel).start().catch(() => {});
    reel.classList.add('is-previewing');
  };
  const stopPreview = (reel) => {
    if (engaged === reel) return;
    guards.get(reel).unload();
    reel.classList.remove('is-previewing');
  };
  const disengage = (reel) => {
    const v = $('video', reel);
    v.muted = true;
    guards.get(reel).unload();
    reel.classList.remove('is-engaged', 'is-previewing');
    if (engaged === reel) { engaged = null; setExclusive(null); }
  };
  const engage = (reel) => {
    if (engaged && engaged !== reel) disengage(engaged);
    engaged = reel;
    setExclusive(reel); // loops elsewhere on the page pause so this reel gets the decoder
    const v = $('video', reel);
    const g = guards.get(reel);
    v.controls = false;
    if (!$('.vc', reel)) buildControls($('.frame', reel), v);
    g.ensureSrc();
    g.rewind();
    v.muted = false;
    reel.classList.add('is-engaged');
    reel.classList.remove('is-previewing');
    // an unloaded video comes back with its caption track reset: re-apply the CC button's state once metadata is there
    const cc = $('.vc-cc', reel);
    if (cc && v.textTracks[0]) v.addEventListener('loadedmetadata', () => { v.textTracks[0].mode = cc.getAttribute('aria-pressed') === 'true' ? 'showing' : 'disabled'; }, { once: true });
    g.start().catch(() => { v.muted = true; g.start().catch(() => {}); });
    $('.vc-play', reel).focus();
  };

  reels.forEach((reel) => {
    const v = $('video', reel);
    const btn = $('.reel-play', reel);
    reel.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') preview(reel); });
    reel.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') stopPreview(reel); });
    btn.addEventListener('focus', () => { reel.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: reduced ? 'auto' : 'smooth' }); preview(reel); });
    btn.addEventListener('blur', () => stopPreview(reel));
    btn.addEventListener('click', () => engage(reel));
    v.addEventListener('ended', () => disengage(reel));
  });

  // The first reel (ACT in B2, the key clip) plays muted while it is on screen, so the proof is moving without a click.
  // Hover previews and engaged reels still take over; reduced motion keeps it on the poster.
  if (!reduced && reels[0]) {
    new IntersectionObserver((entries) => {
      entries.forEach((e) => { e.isIntersecting ? preview(reels[0]) : stopPreview(reels[0]); });
    }, { threshold: 0.6 }).observe(reels[0]);
  }

  // Prev / next buttons and the progress bar follow the strip.
  const strip = $('#strip');
  const wrap = $('.strip-wrap');
  const step = (dir) => {
    const w = ($('.reel', strip)?.getBoundingClientRect().width ?? 300) * 1.3;
    strip.scrollBy({ left: dir * w, behavior: reduced ? 'auto' : 'smooth' });
  };
  $('#strip-prev').addEventListener('click', () => step(-1));
  $('#strip-next').addEventListener('click', () => step(1));
  const prev = $('#strip-prev'), next = $('#strip-next');
  const paintProgress = () => {
    const f = strip.scrollWidth ? (strip.scrollLeft + strip.clientWidth) / strip.scrollWidth : 1;
    wrap.style.setProperty('--sp', Math.min(1, Math.max(0.05, f)).toFixed(4));
    prev.setAttribute('aria-disabled', String(strip.scrollLeft < 4));
    next.setAttribute('aria-disabled', String(strip.scrollLeft + strip.clientWidth >= strip.scrollWidth - 4));
  };
  strip.addEventListener('scroll', paintProgress, { passive: true });
  addEventListener('resize', paintProgress);
  paintProgress();

  // Leaving the chapter stops any sound.
  new IntersectionObserver((entries) => {
    if (!entries[0].isIntersecting && engaged) disengage(engaged);
  }, { threshold: 0 }).observe(strip);
}
