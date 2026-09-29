/* TactileVLA-Edge service worker: makes the showcase installable and fully offline.

   Versioning: scripts/gen-sw-manifest.py writes sw-manifest.json (every site file with size + content hash) and stamps
   MANIFEST_HASH below with the hash of that manifest. Any content change therefore changes this file's bytes, which is what
   makes the browser install a new worker. The cache name is derived from the same hash.

   Tiers (set per file in the manifest):
     shell  HTML, CSS, JS, vendor, fonts, 3D models, posters. Precached at install (a few MB) in every browser.
     media  the mp4 videos (~11 MB). Cached when played (runtime), or all at once by the page when it runs as a Home Screen
            app (or with ?precache=all): js/ui/offline.js downloads them and puts them into this worker's cache.

   Updates: no skipWaiting. A new version installs in the background and takes over on the next launch, when no page is
   left using the old one, so a page never gets half old / half new files. Unchanged files (same hash) are copied from the
   previous cache instead of being downloaded again, and old caches are deleted on activation. */
'use strict';

const MANIFEST_HASH = '8d093c126bc4eeb9'; // stamped by scripts/gen-sw-manifest.py
const PREFIX = 'tvla-';
const CACHE = PREFIX + MANIFEST_HASH;
const SCOPE_URL = self.registration.scope;
const SCOPE_PATH = new URL(SCOPE_URL).pathname;
const NAV_TIMEOUT_MS = 2500;
const INSTALL_CONCURRENCY = 6;
const MANIFEST_URL = new URL('sw-manifest.json', SCOPE_URL).href;
const INDEX_URL = new URL('index.html', SCOPE_URL).href;
const VIDEO_RE = /\.(mp4|m4v|mov|webm)$/i;

const scopeUrl = (path) => new URL(path, SCOPE_URL).href;
const cleanUrl = (u) => { const x = new URL(u); x.search = ''; x.hash = ''; return x.href; };

async function sha256(buf) {
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// --- manifest ------------------------------------------------------------------------------------------------------
async function fetchManifest() {
  for (const cache of ['no-store', 'reload']) {
    const res = await fetch(MANIFEST_URL, { cache });
    if (!res.ok) continue;
    const raw = await res.arrayBuffer();
    if ((await sha256(raw)).slice(0, MANIFEST_HASH.length) === MANIFEST_HASH) {
      return { raw, files: JSON.parse(new TextDecoder().decode(raw)).files };
    }
  }
  throw new Error('sw-manifest.json does not match this worker (deploy in progress?)');
}

let manifestMemo = null;
function manifest() { // this worker's own manifest, read back from its cache (the worker can be restarted at any time)
  manifestMemo ||= caches.open(CACHE).then(async (c) => {
    const res = await c.match(MANIFEST_URL);
    if (!res) throw new Error('manifest not cached');
    return JSON.parse(await res.text()).files;
  });
  manifestMemo.catch(() => { manifestMemo = null; });
  return manifestMemo;
}
async function entryFor(url) {
  const path = new URL(url).pathname.slice(SCOPE_PATH.length);
  return (await manifest().catch(() => [])).find((f) => f.path === path) || null;
}

// --- download with verification --------------------------------------------------------------------------------------
async function fetchVerified(file) {
  const url = scopeUrl(file.path);
  for (const cache of ['default', 'reload']) {
    const res = await fetch(url, { cache });
    if (!res.ok || res.status !== 200) continue;
    const buf = await res.arrayBuffer();
    if (buf.byteLength !== file.size || (await sha256(buf)).slice(0, file.hash.length) !== file.hash) continue; // stale HTTP cache
    return new Response(buf, { status: 200, headers: { 'Content-Type': res.headers.get('Content-Type') || 'application/octet-stream' } });
  }
  throw new Error(`could not fetch a verified copy of ${file.path}`);
}

async function pool(items, limit, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

// --- install / activate ----------------------------------------------------------------------------------------------
// Older complete caches, each with its path -> hash map, so unchanged files can be carried over.
async function previousCaches() {
  const out = [];
  for (const key of await caches.keys()) {
    if (!key.startsWith(PREFIX) || key === CACHE) continue;
    const cache = await caches.open(key);
    const res = await cache.match(MANIFEST_URL);
    if (!res) continue; // incomplete install
    const hashes = new Map(JSON.parse(await res.text()).files.map((f) => [f.path, f.hash]));
    out.push({ cache, hashes });
  }
  return out;
}

async function install() {
  const { raw, files } = await fetchManifest();
  const cache = await caches.open(CACHE);
  const previous = await previousCaches();
  await pool(files, INSTALL_CONCURRENCY, async (file) => {
    const url = scopeUrl(file.path);
    if (await cache.match(url)) return; // resuming an interrupted install of this same version
    for (const old of previous) {
      if (old.hashes.get(file.path) !== file.hash) continue;
      const hit = await old.cache.match(url);
      if (hit) { await cache.put(url, hit); return; }
    }
    if (file.tier === 'shell') await cache.put(url, await fetchVerified(file));
  });
  // Written last: a cache without its manifest is an incomplete install and is never trusted.
  await cache.put(MANIFEST_URL, new Response(raw, { headers: { 'Content-Type': 'application/json' } }));
}

async function activate() {
  for (const key of await caches.keys()) if (key.startsWith(PREFIX) && key !== CACHE) await caches.delete(key);
  await self.clients.claim();
}

self.addEventListener('install', (event) => event.waitUntil(install()));
self.addEventListener('activate', (event) => event.waitUntil(activate()));

// --- messages from the page ------------------------------------------------------------------------------------------
async function state() {
  const files = await manifest();
  const cache = await caches.open(CACHE);
  const have = new Set((await cache.keys()).map((r) => new URL(r.url).pathname.slice(SCOPE_PATH.length)));
  return { version: MANIFEST_HASH, cache: CACHE, scope: SCOPE_URL, files, missing: files.filter((f) => !have.has(f.path)).map((f) => f.path) };
}
self.addEventListener('message', (event) => {
  const msg = event.data || {};
  if (msg.type === 'STATE') {
    event.waitUntil(state().then((s) => event.ports[0]?.postMessage(s), (err) => event.ports[0]?.postMessage({ error: String(err) })));
  } else if (msg.type === 'SKIP_WAITING') { // test hook only; the page never sends this
    self.skipWaiting();
  }
});

// --- fetch -----------------------------------------------------------------------------------------------------------
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || req.headers.has('x-tvla-precache')) return; // page-driven downloads go straight to the network
  const url = new URL(req.url);
  if (url.origin !== location.origin || !url.pathname.startsWith(SCOPE_PATH)) return;
  const path = url.pathname.slice(SCOPE_PATH.length);
  if (path === 'sw.js' || path === 'sw-manifest.json') return;

  if (req.mode === 'navigate') {
    if (path === '' || path === 'index.html') event.respondWith(navigation(event));
  } else if (VIDEO_RE.test(path)) {
    videoRequest(event);
  } else {
    event.respondWith(asset(event));
  }
});

const withTimeout = (promise, ms) => Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

// Network first (2.5 s), else the cached page. If the network hands back a NEWER index.html than this version's, serve the
// cached one (its scripts and styles are the ones in this cache) and start installing the new version for the next launch.
async function navigation(event) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(INDEX_URL);
  if (!cached) return fetch(event.request);
  try {
    const res = await withTimeout(fetch(event.request), NAV_TIMEOUT_MS);
    if (res.status !== 200) return res.status >= 500 ? cached : res;
    const entry = await entryFor(INDEX_URL);
    if (entry && (await sha256(await res.clone().arrayBuffer())).slice(0, entry.hash.length) !== entry.hash) {
      event.waitUntil(self.registration.update().catch(() => {}));
      return cached;
    }
    return res;
  } catch {
    return cached;
  }
}

async function asset(event) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(event.request, { ignoreSearch: true });
  if (hit) return hit;
  const res = await fetch(event.request);
  if (res.status === 200 && res.type === 'basic') event.waitUntil(cache.put(cleanUrl(event.request.url), res.clone()));
  return res;
}

// --- video: Range support --------------------------------------------------------------------------------------------
// iOS Safari only plays a <video> served by a worker if Range requests get proper 206 Partial Content answers.
function rangeResponse(blob, type, header) {
  const size = blob.size;
  const base = { 'Content-Type': type, 'Accept-Ranges': 'bytes' };
  const m = /^bytes=(\d*)-(\d*)$/.exec((header || '').trim());
  if (!m || (m[1] === '' && m[2] === '')) return new Response(blob, { status: 200, headers: { ...base, 'Content-Length': String(size) } });
  let start, end;
  if (m[1] === '') { start = Math.max(0, size - Number(m[2])); end = size - 1; }
  else { start = Number(m[1]); end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1); }
  if (start >= size || start > end) return new Response(null, { status: 416, headers: { ...base, 'Content-Range': `bytes */${size}` } });
  return new Response(blob.slice(start, end + 1, type), {
    status: 206,
    headers: { ...base, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) },
  });
}

const inflight = new Map();
function cacheVideoInBackground(url) {
  const key = cleanUrl(url);
  if (inflight.has(key)) return inflight.get(key);
  const job = (async () => {
    const file = await entryFor(key);
    if (!file) return; // only files this version knows about
    const cache = await caches.open(CACHE);
    if (await cache.match(key)) return;
    await cache.put(key, await fetchVerified(file));
  })().catch(() => {}).finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

function videoRequest(event) {
  const key = cleanUrl(event.request.url);
  const range = event.request.headers.get('range');
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(key);
    if (hit) return rangeResponse(await hit.blob(), hit.headers.get('Content-Type') || 'video/mp4', range);
    // Not cached yet: let the browser stream it from the network (native Range handling) and keep a full copy for offline.
    event.waitUntil(cacheVideoInBackground(key));
    return fetch(event.request);
  })());
}
