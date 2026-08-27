#!/usr/bin/env python3
"""Verify Hermes upstream overlay provenance and markers, and idempotence."""
from __future__ import annotations
import subprocess
import sys
from pathlib import Path

def find_root() -> Path:
    here = Path(__file__).resolve()
    if len(here.parents) >= 3 and (here.parents[2] / "package.json").exists():
        cand = here.parents[2]
        if (cand / "android" / "overlay").exists():
            return cand
    return Path.cwd().resolve()

ROOT = find_root()
PROVENANCE = ROOT / "android" / "overlay" / "UPSTREAM"
PATCH = ROOT / "android" / "overlay" / "hermes-fork.patch"

def require(rel: str, needle: str):
    p = ROOT / rel
    if not p.is_file():
        print(f"verify failed: missing file {rel}", file=sys.stderr)
        sys.exit(1)
    txt = p.read_text(errors="ignore")
    if needle not in txt:
        print(f"verify failed: {rel} missing {needle!r}", file=sys.stderr)
        sys.exit(1)

def require_absent(rel: str, needle: str):
    p = ROOT / rel
    if not p.is_file():
        return
    txt = p.read_text(errors="ignore")
    if needle in txt:
        print(f"verify failed: {rel} unexpectedly contains {needle!r}", file=sys.stderr)
        sys.exit(1)

def main() -> int:
    # 1. Provenance
    if not PROVENANCE.is_file():
        print(f"verify failed: provenance missing {PROVENANCE}", file=sys.stderr)
        return 1
    prov = PROVENANCE.read_text()
    for needle in ["upstream_url=https://github.com/chandra447/pi-hermes-memory.git", "upstream_branch=main", "overlay_format=patch-v1", "overlay_commit=f20e315"]:
        if needle not in prov:
            print(f"verify failed: provenance missing {needle!r}", file=sys.stderr)
            return 1
    if not PATCH.is_file() or PATCH.stat().st_size == 0:
        print(f"verify failed: patch missing or empty {PATCH}", file=sys.stderr)
        return 1

    # 2. Required runtime/export/Android markers (fork-specific)
    require("src/hermes-runtime.ts", "createHermesMemoryBackend")
    require("src/hermes-runtime.ts", "HermesBackendRuntime")
    require("index.ts", "createHermesMemoryBackend")
    require("index.ts", 'export { default } from "./src/index.ts"')
    require("src/index.ts", "createHermesMemoryBackend")
    require("src/index.ts", "from \"./hermes-runtime.js\"")
    require("package.json", '"./runtime"')
    require("package.json", "hermes-runtime")
    require("package.json", '"android"')
    require("package.json", "better-sqlite3")
    require("install-android.sh", "pi-hermes-memory")
    require("src/cortex-sync.ts", "syncToCortex")
    require("src/store/atomic-write.ts", "moveFileSafe")
    require("src/store/scored-index.ts", "scored")
    # Ensure mutable #main not leaked into pinned spec (if OMP pin exists, provenance covers it)
    # Fork install script must not contain node_modules embedding etc. (nothing to check)

    # 3. Second apply is no-op
    # Invoke apply script; it should report already applied
    apply = ROOT / "android" / "scripts" / "apply-upstream-overlay.py"
    if not apply.is_file():
        print(f"verify failed: apply script missing {apply}", file=sys.stderr)
        return 1
    # Snapshot mtimes/checksums of a few key files
    import hashlib
    def sha(p: Path) -> str | None:
        if not p.is_file():
            return None
        return hashlib.sha256(p.read_bytes()).hexdigest()
    snap = {rel: sha(ROOT / rel) for rel in ["src/hermes-runtime.ts", "index.ts", "src/index.ts", "package.json", "install-android.sh"]}
    res = subprocess.run([sys.executable, str(apply)], cwd=str(ROOT), capture_output=True, text=True)
    if res.returncode != 0:
        print(f"verify failed: second apply returned non-zero: {res.stderr.strip()}", file=sys.stderr)
        print(res.stdout.strip(), file=sys.stderr)
        return 1
    if "no-op" not in res.stdout and "already applied" not in res.stdout:
        print(f"verify failed: second apply not no-op: stdout={res.stdout!r}", file=sys.stderr)
        return 1
    # Ensure files unchanged after second apply
    for rel, before in snap.items():
        after = sha(ROOT / rel)
        if after != before:
            print(f"verify failed: {rel} changed on second apply (not idempotent)", file=sys.stderr)
            return 1

    print(f"verify-upstream-overlay: ok (provenance f20e315, {len(snap)} markers, idempotent)")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
