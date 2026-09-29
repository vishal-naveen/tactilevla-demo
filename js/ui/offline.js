// Offline support: registers the service worker (sw.js) and, when the page runs as a Home Screen app (or with ?precache=all),
// downloads the videos so the whole showcase works without a network. In a normal browser tab only the small app shell is
// cached (by the worker, at install) and videos are kept as they are played, so a visitor on a phone never pays for 11 MB.
//
// The download runs here in the page rather than in the worker: iOS can stop an idle worker mid-download, whereas a visible
// page keeps going, and the progress shown in the toast is real bytes. It is resumable: whatever is missing is fetched on
// the next launch.
import { params } from './env.js';

const CONCURRENCY = 2;
const RETRIES = 3;
const READY_MS = 3200;

const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sha256hex(buf) {
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function askState(worker) {
  return new Promise((resolve, reject) => {
    const ch = new MessageChannel();
    const timer = setTimeout(() => reject(new Error('service worker did not answer')), 10000);
    ch.port1.onmessage = (e) => { clearTimeout(timer); e.data?.error ? reject(new Error(e.data.error)) : resolve(e.data); };
    worker.postMessage({ type: 'STATE' }, [ch.port2]);
  });
}

// --- the toast ---------------------------------------------------------------------------------------------------------
function createToast() {
  const el = document.createElement('div');
  el.className = 'offline-toast';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.innerHTML = '<i class="offline-toast__dot" aria-hidden="true"></i><span class="offline-toast__text"></span><span class="offline-toast__bar" aria-hidden="true"><i></i></span>';
  document.body.append(el);
  const text = el.querySelector('.offline-toast__text');
  let hideTimer = 0;
  return {
    el,
    saving(fraction) {
      clearTimeout(hideTimer);
      const pct = Math.min(99, Math.floor(fraction * 100));
      el.dataset.state = 'saving';
      el.style.setProperty('--p', String(fraction));
      text.textContent = `Saving for offline… ${pct}%`;
      el.classList.add('is-shown');
    },
    ready() {
      clearTimeout(hideTimer);
      el.dataset.state = 'ready';
      el.style.setProperty('--p', '1');
      text.textContent = 'Ready offline';
      el.classList.add('is-shown');
      hideTimer = setTimeout(() => el.classList.remove('is-shown'), READY_MS);
    },
    problem() {
      clearTimeout(hideTimer);
      el.dataset.state = 'problem';
      text.textContent = 'Offline copy paused. It will finish when you are back online.';
      el.classList.add('is-shown');
      hideTimer = setTimeout(() => el.classList.remove('is-shown'), 6000);
    },
  };
}

// --- downloading the missing files -----------------------------------------------------------------------------------
async function downloadOne(cache, scope, file, onBytes) {
  const url = new URL(file.path, scope).href;
  let lastError;
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    let received = 0;
    try {
      const res = await fetch(url, { cache: attempt ? 'reload' : 'default', headers: { 'x-tvla-precache': '1' } });
      if (!res.ok || res.status !== 200) throw new Error(`HTTP ${res.status}`);
      const reader = res.body.getReader();
      const chunks = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        onBytes(value.length);
      }
      const blob = new Blob(chunks, { type: res.headers.get('Content-Type') || 'application/octet-stream' });
      if (blob.size !== file.size || (await sha256hex(await blob.arrayBuffer())).slice(0, file.hash.length) !== file.hash) {
        throw new Error('size or hash mismatch (stale copy)');
      }
      await cache.put(url, new Response(blob, { status: 200, headers: { 'Content-Type': blob.type, 'Content-Length': String(blob.size) } }));
      return;
    } catch (err) {
      lastError = err;
      onBytes(-received); // this attempt's bytes do not count
      await sleep(600 * (attempt + 1));
    }
  }
  throw lastError;
}

async function precacheAll(worker, info, toast) {
  const st = await askState(worker);
  info.version = st.version;
  const missing = st.files.filter((f) => st.missing.includes(f.path));
  info.total = st.files.reduce((n, f) => n + f.size, 0);
  info.missingCount = missing.length;
  if (!missing.length) { info.state = 'ready'; info.progress = 1; info.cachedBytes = info.total; return; }

  const cache = await caches.open(st.cache);
  let done = info.total - missing.reduce((n, f) => n + f.size, 0);
  let shown = -1;
  const paint = () => {
    info.cachedBytes = done;
    info.progress = done / info.total;
    const step = Math.floor(info.progress * 100);
    if (step !== shown) { shown = step; toast.saving(info.progress); }
  };
  info.state = 'saving';
  paint();

  const queue = [...missing].sort((a, b) => a.size - b.size); // small files first: something usable early, big videos last
  let failed = false;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length && !failed) {
      const file = queue.shift();
      try { await downloadOne(cache, st.scope, file, (n) => { done += n; paint(); }); }
      catch (err) { failed = true; console.warn('offline: could not save', file.path, err); }
    }
  }));

  if (failed) {
    info.state = 'paused';
    toast.problem();
    addEventListener('online', () => precacheAll(worker, info, toast).catch(() => {}), { once: true });
    return;
  }
  info.state = 'ready';
  info.progress = 1;
  info.cachedBytes = info.total;
  toast.ready();
  navigator.storage?.persist?.().catch(() => {});
}

// --- entry point ---------------------------------------------------------------------------------------------------------
export function initOffline({ swUrl = './sw.js', scope = './' } = {}) {
  const standalone = isStandalone();
  const wantAll = standalone || params.get('precache') === 'all';
  const info = (window.__offline = { supported: 'serviceWorker' in navigator, standalone, wantAll, state: 'idle', progress: 0, version: null });
  if (!info.supported || params.has('nosw')) return;

  const start = async () => {
    try {
      const reg = await navigator.serviceWorker.register(swUrl, { scope, updateViaCache: 'none' });
      info.registered = true;
      // A newer version installs in the background and takes over on the next launch. Nothing reloads under the visitor.
      reg.addEventListener('updatefound', () => {
        const replacing = !!navigator.serviceWorker.controller; // false on the very first install
        const worker = reg.installing;
        if (replacing) info.update = 'installing';
        worker?.addEventListener('statechange', () => { if (replacing && worker.state === 'installed') info.update = 'waiting'; });
      });
      if (navigator.serviceWorker.controller) info.update = reg.waiting ? 'waiting' : reg.installing ? 'installing' : undefined;
      document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}); });
      const ready = await navigator.serviceWorker.ready;
      info.active = true;
      if (wantAll && ready.active) await precacheAll(ready.active, info, createToast());
    } catch (err) {
      info.state = 'error';
      info.error = String(err?.message || err);
      console.warn('offline support unavailable', err);
    }
  };
  // Start once the page has finished loading, so the worker's first downloads never compete with the 3D scene's.
  const go = () => setTimeout(start, 1200);
  document.readyState === 'complete' ? go() : addEventListener('load', go, { once: true });
}
