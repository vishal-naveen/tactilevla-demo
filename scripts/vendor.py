#!/usr/bin/env python3
"""Vendor the third-party runtime (three.js + used addons, GSAP, Lenis, Archivo font) into ./vendor.

The site imports everything from same-origin ./vendor/ so it can run offline as a Home Screen app.
Re-run only when bumping a pinned version:  python3 scripts/vendor.py
"""
import re
import shutil
import subprocess
from pathlib import Path
from urllib.parse import urljoin

ROOT = Path(__file__).resolve().parent.parent
VENDOR = ROOT / "vendor"

THREE = "https://cdn.jsdelivr.net/npm/three@0.170.0/"
GSAP = "https://cdn.jsdelivr.net/npm/gsap@3.12.5/"
LENIS_BASE = "https://cdn.jsdelivr.net/npm/lenis@1.1.18/"
FONT_CSS = "https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,100..900&display=swap"
OFL = "https://raw.githubusercontent.com/Omnibus-Type/Archivo/master/OFL.txt"
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
IMPORT_RE = re.compile(r"""(?:\bfrom\s*|\bimport\s*\(?\s*)['"]([^'"]+)['"]""")


def fetch(url: str) -> bytes:
    out = subprocess.run(["curl", "-fsSL", "--max-time", "60", "-A", UA, url], capture_output=True)
    if out.returncode != 0:
        raise SystemExit(f"download failed ({out.returncode}): {url}\n{out.stderr.decode()}")
    return out.stdout


def vendor_modules(entries: list[str], base: str, dest: Path) -> int:
    seen, queue = set(), list(entries)
    while queue:
        url = queue.pop()
        if url in seen:
            continue
        seen.add(url)
        body = fetch(url)
        path = dest / url[len(base):]
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(body)
        for spec in IMPORT_RE.findall(body.decode("utf-8", "replace")):
            if spec.startswith("."):
                queue.append(urljoin(url, spec))
    return len(seen)


def addon_entries() -> list[str]:
    """Every three/addons/* module the site's own JS imports (dev harness and tools excluded)."""
    specs = set()
    for js in (ROOT / "js").rglob("*.js"):
        if "tools" in js.parts:
            continue
        specs.update(m for m in IMPORT_RE.findall(js.read_text("utf-8")) if m.startswith("three/addons/"))
    return sorted(THREE + "examples/jsm/" + s[len("three/addons/"):] for s in specs)


def vendor_font(dest: Path) -> None:
    css = fetch(FONT_CSS).decode()
    dest.mkdir(parents=True, exist_ok=True)
    for i, url in enumerate(dict.fromkeys(re.findall(r"url\((https://[^)]+)\)", css))):
        name = f"archivo-{i}.woff2"
        (dest / name).write_bytes(fetch(url))
        css = css.replace(url, name)
    (dest / "archivo.css").write_text(css)


def main() -> None:
    if VENDOR.exists():
        shutil.rmtree(VENDOR)
    n = vendor_modules([THREE + "build/three.module.js"], THREE, VENDOR / "three")
    n += vendor_modules(addon_entries(), THREE, VENDOR / "three")
    n += vendor_modules([GSAP + "index.js", GSAP + "ScrollTrigger.js"], GSAP, VENDOR / "gsap")
    n += vendor_modules([LENIS_BASE + "dist/lenis.mjs"], LENIS_BASE + "dist/", VENDOR / "lenis")
    vendor_font(VENDOR / "fonts")
    (VENDOR / "licenses").mkdir(parents=True, exist_ok=True)
    (VENDOR / "licenses" / "three.LICENSE.txt").write_bytes(fetch(THREE + "LICENSE"))
    (VENDOR / "licenses" / "lenis.LICENSE.txt").write_bytes(fetch(LENIS_BASE + "LICENSE"))
    (VENDOR / "licenses" / "archivo.OFL.txt").write_bytes(fetch(OFL))
    print(f"vendored {n} modules into {VENDOR}")


if __name__ == "__main__":
    main()
