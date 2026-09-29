// Video hardening shared by the looping clips (media.js) and the film reels (film.js).
//
// The failure it fixes: on iOS Safari a <video> shows solid black from the moment play() is called until its first frame is
// decoded, and again whenever the browser reclaims its decoder (iOS keeps only a few videos decoding at once) or a lazy
// src swap has not produced a frame yet. So:
//   - the poster is ALSO painted as the box's own background, and the <video> stays transparent until a decoded frame is
//     really on screen (requestVideoFrameCallback, with a timeout so it can never stay hidden), then fades in;
//   - every video is muted-inline-capable (muted + playsinline) so autoplay policy never blocks the first frame;
//   - unload() drops the src (the poster comes back) to free the decoder; the next start() puts it back;
//   - error / stall / background-resume recovery reloads the src at the last position instead of leaving a dead frame.
const FRAME_TIMEOUT = 2500;
const STALL_MS = 2500;
const MAX_RETRIES = 3;

/** A film reel the visitor engaged (sound on) owns the decoders: looping clips pause while it is set. */
export const playback = { exclusive: null };
export const setExclusive = (owner) => {
  playback.exclusive = owner;
  document.dispatchEvent(new CustomEvent('media:exclusive'));
};

export function guardVideo(box, v, { muted = true } = {}) {
  const src = v.getAttribute('src') || v.currentSrc || '';
  const poster = v.getAttribute('poster') || '';
  v.setAttribute('playsinline', '');
  v.setAttribute('webkit-playsinline', '');
  v.playsInline = true;
  if (muted) { v.defaultMuted = true; v.muted = true; v.setAttribute('muted', ''); }
  v.disableRemotePlayback = true;
  if (poster) {
    Object.assign(box.style, {
      backgroundImage: `url("${poster}")`, backgroundSize: 'cover', backgroundPosition: 'center',
      backgroundRepeat: 'no-repeat', backgroundOrigin: 'content-box', backgroundClip: 'content-box',
    });
  }
  v.style.transition = 'opacity 0.25s';

  let frameShown = false;
  let want = false;      // the caller wants it playing: recovery may resume it
  let retries = 0;
  let watchTimer = 0;
  let lastT = -1;
  let stuck = 0;

  const show = () => { v.style.opacity = '1'; };
  const hide = () => { v.style.opacity = '0'; };
  const ensureSrc = () => {
    if (!v.getAttribute('src') && src) { v.setAttribute('src', src); v.load(); }
  };
  const whenFrame = () => new Promise((resolve) => {
    let done = false;
    const fin = () => { if (done) return; done = true; clearTimeout(t); resolve(); };
    const t = setTimeout(fin, FRAME_TIMEOUT);
    if ('requestVideoFrameCallback' in v) v.requestVideoFrameCallback(fin);
    else v.addEventListener('timeupdate', fin, { once: true });
  });

  function stopWatch() { clearInterval(watchTimer); watchTimer = 0; }
  function watch() {
    stopWatch();
    lastT = -1; stuck = 0;
    watchTimer = setInterval(() => {
      if (!want || v.paused || v.ended) { stuck = 0; return; }
      if (v.currentTime !== lastT) { lastT = v.currentTime; stuck = 0; retries = 0; return; }
      stuck += 1000;
      if (stuck >= STALL_MS) { stuck = 0; recover('stalled'); }
    }, 1000);
  }

  function recover(why) {
    if (!want || retries >= MAX_RETRIES) return;
    retries++;
    const t = v.currentTime || 0;
    stopWatch();
    v.removeAttribute('src');
    v.load();                       // drop the wedged decoder
    frameShown = false;
    setTimeout(() => {
      if (!want) return;
      ensureSrc();
      const seek = () => { try { v.currentTime = t; } catch { /* not seekable yet */ } };
      v.addEventListener('loadedmetadata', seek, { once: true });
      start().catch(() => {});
    }, 300 * retries);
    v.dataset.recovered = why;
  }

  async function start() {
    want = true;
    ensureSrc();
    if (!frameShown) hide();
    try {
      await v.play();
    } catch (err) {
      show();
      throw err;
    }
    if (!frameShown) { await whenFrame(); frameShown = true; }
    show();
    watch();
  }

  function pause() {
    want = false;
    stopWatch();
    if (!v.paused) v.pause();
  }

  /** Drop the src so the decoder is freed; the poster (attribute + box background) is what shows again. */
  function unload() {
    want = false;
    stopWatch();
    v.pause();
    if (v.getAttribute('src')) { v.removeAttribute('src'); v.load(); }
    frameShown = false;
    show();
  }

  /** From the first frame: a loaded clip seeks to 0, an unloaded one simply starts there. */
  function rewind() {
    if (v.getAttribute('src')) { try { v.currentTime = 0; } catch { /* not seekable yet */ } }
  }

  v.addEventListener('error', () => recover('error'));
  v.addEventListener('emptied', () => { if (!v.getAttribute('src')) frameShown = false; });
  v.addEventListener('waiting', () => { lastT = -1; });
  document.addEventListener('visibilitychange', () => {
    // iOS pauses inline video when the page is backgrounded; bring back the ones that should be playing
    if (!document.hidden && want && v.paused && !v.ended) start().catch(() => {});
  });

  return { v, start, pause, unload, rewind, ensureSrc, get playing() { return !v.paused; }, get want() { return want; } };
}
