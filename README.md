# TactileVLA-Edge: interactive demo

A scroll-driven page for the [TactileVLA-Edge](https://github.com/vishal-naveen/TactileVLA-Edge) project.
A sub-$300 SO-101 arm, trained on 160 human demonstrations, picked up a foam noodle from a table cell
(B2) that no demonstration ever touched. The page shows the real footage, a 3D kinematic reconstruction
of the arm, and the numbers, including what they do not establish.

**Live:** https://vishal-naveen.github.io/tactilevla-demo/
**Project site:** https://vishal-naveen.github.io/TactileVLA-Edge/
**Main repository (code, data, results):** https://github.com/vishal-naveen/TactileVLA-Edge

The 3D arm is a reconstruction driven by the SO-101 URDF, not policy output. The videos are the real runs.

## Run locally

It is a static site (HTML, CSS, ES modules). There is no build step. Serve the folder over HTTP;
`file://` will not work because browsers block module and `fetch` requests from it.

```bash
npx http-server . -p 8000    # or: python3 -m http.server 8000
# open http://localhost:8000/
```

No internet connection is needed: three.js, GSAP, Lenis and the Archivo font are vendored in `vendor/`
(`python3 scripts/vendor.py` re-downloads them at the pinned versions).
Add `?nogl` to test the no-WebGL fallback.

## Install it as an app (works offline)

On iPhone or iPad, open the live URL in Safari once, tap Share, then Add to Home Screen. The first time you open
the icon it saves everything (about 17 MB, including the seven videos) and shows "Ready offline" when done; after
that it runs with no connection. In a normal browser tab only the app shell (about 7 MB) is cached and each
video is kept once it has been played. `?precache=all` saves everything from a tab too, and `?nosw` skips the
service worker.

`sw.js` is the service worker. **After changing any shipped file, run `python3 scripts/gen-sw-manifest.py`**
(it rewrites `sw-manifest.json` and stamps its hash into `sw.js`; `--check` reports a stale one). A new version is
picked up on the next launch; nothing reloads mid-view.

## Credits and licenses

- Code: Apache-2.0 (see `LICENSE`).
- SO-101 URDF and STL meshes: [TheRobotStudio/SO-ARM100](https://github.com/TheRobotStudio/SO-ARM100),
  Apache-2.0. The meshes are decimated for the web; see `assets/so101/NOTICE.md`.
- Footage and images in `media/`: (c) Vishal Naveen, all rights reserved unless stated otherwise.
- Vendored in `vendor/`, with license texts in `vendor/licenses/`: three.js (MIT), Lenis (MIT), GSAP and ScrollTrigger
  (GreenSock standard "no charge" license, https://gsap.com/standard-license), Archivo (SIL OFL 1.1).
