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

An internet connection is needed for three.js, GSAP and Lenis (jsDelivr) and the Archivo font (Google Fonts).
Add `?nogl` to test the no-WebGL fallback.

## Credits and licenses

- Code: Apache-2.0 (see `LICENSE`).
- SO-101 URDF and STL meshes: [TheRobotStudio/SO-ARM100](https://github.com/TheRobotStudio/SO-ARM100),
  Apache-2.0. The meshes are decimated for the web; see `assets/so101/NOTICE.md`.
- Footage and images in `media/`: (c) Vishal Naveen, all rights reserved unless stated otherwise.
- Loaded from CDN, not redistributed: three.js (MIT), GSAP (GreenSock standard license), Lenis (MIT),
  Archivo (SIL OFL 1.1).
