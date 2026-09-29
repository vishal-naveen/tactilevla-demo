#!/usr/bin/env python3
"""Write sw-manifest.json (every site file: size + content hash + tier) and stamp its hash into sw.js.

The service worker's version is the hash of the manifest, so ANY change to a shipped file changes sw.js's bytes
and the browser installs a new worker. Run it after every edit, before publishing:

    python3 scripts/gen-sw-manifest.py            # write
    python3 scripts/gen-sw-manifest.py --check    # exit 1 if the committed manifest / sw.js are stale

Tiers: "media" = videos (cached when played, or all at once in the Home Screen app); "shell" = everything else.
"""
import hashlib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MANIFEST = ROOT / "sw-manifest.json"
SW = ROOT / "sw.js"

SKIP_DIRS = {".git", "node_modules", "scripts", "tools", "__pycache__"}
SKIP_NAMES = {".git", ".DS_Store", "sw.js", "sw-manifest.json", "dev.html", "LICENSE", "404.html", ".nojekyll", ".gitignore"}
SKIP_SUFFIXES = {".md", ".py", ".log"}
MEDIA_SUFFIXES = {".mp4", ".m4v", ".mov", ".webm"}


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()[:20]


def collect() -> list[dict]:
    files = []
    for p in sorted(ROOT.rglob("*")):
        rel = p.relative_to(ROOT)
        if not p.is_file() or set(rel.parts[:-1]) & SKIP_DIRS:
            continue
        if p.name in SKIP_NAMES or p.suffix in SKIP_SUFFIXES:
            continue
        files.append({
            "path": rel.as_posix(),
            "size": p.stat().st_size,
            "hash": digest(p),
            "tier": "media" if p.suffix.lower() in MEDIA_SUFFIXES else "shell",
        })
    return files


def main() -> int:
    body = json.dumps({"v": 1, "files": collect()}, indent=1, sort_keys=True) + "\n"
    version = hashlib.sha256(body.encode()).hexdigest()[:16]
    sw = SW.read_text()
    stamped, n = re.subn(r"const MANIFEST_HASH = '[0-9a-f]*';", f"const MANIFEST_HASH = '{version}';", sw, count=1)
    if n != 1:
        raise SystemExit("sw.js has no MANIFEST_HASH line to stamp")
    if "--check" in sys.argv:
        fresh = MANIFEST.exists() and MANIFEST.read_text() == body and stamped == sw
        print("up to date" if fresh else "STALE: run python3 scripts/gen-sw-manifest.py")
        return 0 if fresh else 1
    MANIFEST.write_text(body)
    SW.write_text(stamped)
    data = json.loads(body)["files"]
    shell = sum(f["size"] for f in data if f["tier"] == "shell")
    media = sum(f["size"] for f in data if f["tier"] == "media")
    print(f"version {version}: {len(data)} files, shell {shell / 1e6:.2f} MB, media {media / 1e6:.2f} MB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
