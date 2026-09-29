import { $, $$, reduced } from './env.js';

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
  const reels = $$('.reel:not(.reel--wide)');
  let engaged = null;

  const preview = (reel) => {
    if (reduced || engaged === reel) return;
    const v = $('video', reel);
    v.muted = true;
    v.play().catch(() => {});
    reel.classList.add('is-previewing');
  };
  const stopPreview = (reel) => {
    if (engaged === reel) return;
    const v = $('video', reel);
    v.pause();
    v.currentTime = 0;
    reel.classList.remove('is-previewing');
  };
  const disengage = (reel) => {
    const v = $('video', reel);
    v.pause(); v.muted = true; v.currentTime = 0;
    reel.classList.remove('is-engaged', 'is-previewing');
    if (engaged === reel) engaged = null;
  };
  const engage = (reel) => {
    if (engaged && engaged !== reel) disengage(engaged);
    engaged = reel;
    const v = $('video', reel);
    v.controls = false;
    if (!$('.vc', reel)) buildControls($('.frame', reel), v);
    v.currentTime = 0; v.muted = false;
    reel.classList.add('is-engaged');
    reel.classList.remove('is-previewing');
    v.play().catch(() => { v.muted = true; v.play().catch(() => {}); });
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
