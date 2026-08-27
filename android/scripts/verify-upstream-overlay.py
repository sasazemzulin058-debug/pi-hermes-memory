#!/usr/bin/env python3
"""Verify Hermes upstream overlay provenance and markers, and idempotence."""
from __future__ import annotations
import hashlib
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
HERMES_FILES = ROOT / "android" / "overlay" / "hermes-files"

def require(rel: str, needle: str):
    p = ROOT / rel
    if not p.is_file():
        print(f"verify failed: missing file {rel}", file=sys.stderr)
        sys.exit(1)
    txt = p.read_text(errors="ignore")
    if needle not in txt:
        print(f"verify failed: {rel} missing {needle!r}", file=sys.stderr)
        sys.exit(1)

def sha(p: Path) -> str | None:
    if not p.is_file():
        return None
    return hashlib.sha256(p.read_bytes()).hexdigest()

def parse_provenance() -> dict[str,str]:
    data: dict[str,str] = {}
    txt = PROVENANCE.read_text()
    for line in txt.splitlines():
        line=line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" in line:
            k,v=line.split("=",1)
            data[k.strip()]=v.strip()
    return data

def main() -> int:
    # 1. Provenance
    if not PROVENANCE.is_file():
        print(f"verify failed: provenance missing {PROVENANCE}", file=sys.stderr)
        return 1
    prov = PROVENANCE.read_text()
    for needle in ["upstream_url=https://github.com/chandra447/pi-hermes-memory.git", "upstream_branch=main"]:
        if needle not in prov:
            print(f"verify failed: provenance missing {needle!r}", file=sys.stderr)
            return 1
    data = parse_provenance()
    fmt = data.get("overlay_format","")
    if "patch" not in fmt and "hermes" not in fmt:
        print(f"verify failed: provenance overlay_format missing patch/hermes: {fmt!r}", file=sys.stderr)
        return 1
    if "upstream_commit" not in data and "upstream_base" not in data:
        print(f"verify failed: provenance missing upstream_commit/upstream_base", file=sys.stderr)
        return 1
    if "overlay_commit" not in data:
        print(f"verify failed: provenance missing overlay_commit", file=sys.stderr)
        return 1
    # Validate upstream_commit looks like hex
    uc = data.get("upstream_commit","") or data.get("upstream_base","")
    if len(uc) < 7 or not all(c in "0123456789abcdef" for c in uc.lower()):
        print(f"verify failed: provenance upstream_commit not hex: {uc!r}", file=sys.stderr)
        return 1
    # Check hermes_files provenance if present
    if "hermes_files" in data:
        hf = data["hermes_files"]
        if hf != "android/overlay/hermes-files":
            print(f"verify failed: unexpected hermes_files path {hf!r}", file=sys.stderr)
            return 1
        if not HERMES_FILES.is_dir():
            print(f"verify failed: hermes_files dir missing {HERMES_FILES}", file=sys.stderr)
            return 1
    elif HERMES_FILES.is_dir():
        # New provenance should mention hermes_files, but old allowed
        print(f"warning: provenance missing hermes_files but dir exists", file=sys.stderr)

    if not PATCH.is_file():
        # Allow missing patch if hermes-files exists and covers overlay
        if HERMES_FILES.is_dir() and any(HERMES_FILES.rglob("*")):
            print(f"warning: patch missing but hermes-files present — deterministic-only overlay", file=sys.stderr)
        else:
            print(f"verify failed: patch missing {PATCH}", file=sys.stderr)
            return 1
    elif PATCH.stat().st_size == 0:
        print(f"warning: patch is empty {PATCH}", file=sys.stderr)
    else:
        patch_text = PATCH.read_text(errors="ignore")
        if "diff --git a/android/overlay" in patch_text or "diff --git a/android/scripts" in patch_text or "\n+++ b/android/overlay" in patch_text or "\n+++ b/android/scripts" in patch_text:
            print(f"verify failed: patch unexpectedly contains android scaffolding diff headers", file=sys.stderr)
            return 1
        # Check patch applicability (either forward or reverse should succeed on current tree, which is post-overlay)
        rev_check = subprocess.run(["git", "apply", "--check", "--reverse", str(PATCH)], cwd=str(ROOT), capture_output=True, text=True)
        fwd_check = subprocess.run(["git", "apply", "--check", str(PATCH)], cwd=str(ROOT), capture_output=True, text=True)
        if rev_check.returncode != 0 and fwd_check.returncode != 0:
            print(f"verify failed: patch neither applies forward nor reverse on current tree (base mismatch/conflict)", file=sys.stderr)
            if fwd_check.stderr:
                print(fwd_check.stderr.strip(), file=sys.stderr)
            if rev_check.stderr:
                print(rev_check.stderr.strip(), file=sys.stderr)
            # Provide actionable regen hint
            prova = parse_provenance()
            base = prova.get("upstream_base") or prova.get("upstream_commit","")[:7]
            # Try to get current upstream sha
            up = subprocess.run(["git","rev-parse","upstream/main"], cwd=str(ROOT), capture_output=True, text=True)
            up_sha = up.stdout.strip() if up.returncode==0 else "unknown"
            print(f"hint: provenance base {base} vs upstream {up_sha[:7] if up_sha!='unknown' else up_sha}. Regenerate via:", file=sys.stderr)
            print(f"  python3 android/scripts/regenerate-upstream-overlay.py", file=sys.stderr)
            return 1
        # If patch empty, skip checks
    # Check hermes-files consistency: each file in hermes-files should match dest if dest exists, or at least be present in hermes-files
    if HERMES_FILES.is_dir():
        missing_hermes = []
        mismatch = []
        for src in HERMES_FILES.rglob("*"):
            if not src.is_file():
                continue
            rel = src.relative_to(HERMES_FILES)
            dest = ROOT / rel
            if not dest.is_file():
                # File in hermes-files but not in repo — should have been copied by apply script
                # Allow .github/workflows/sync-upstream.yml to be missing if workflow not yet applied? But verify after apply should have it
                missing_hermes.append(str(rel))
                continue
            if sha(src) != sha(dest):
                mismatch.append(str(rel))
        if missing_hermes:
            print(f"verify failed: hermes-files not applied for: {', '.join(missing_hermes[:5])}", file=sys.stderr)
            return 1
        if mismatch:
            print(f"verify failed: hermes-files mismatch for: {', '.join(mismatch[:5])}", file=sys.stderr)
            print(f"  hermes-files copy differs from working tree; run apply script", file=sys.stderr)
            return 1
        total = sum(1 for _ in HERMES_FILES.rglob("*") if _.is_file())
        print(f"hermes-files: {total} files consistent")

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

    # 3. Second apply is no-op (idempotence)
    apply = ROOT / "android" / "scripts" / "apply-upstream-overlay.py"
    if not apply.is_file():
        print(f"verify failed: apply script missing {apply}", file=sys.stderr)
        return 1
    snap = {rel: sha(ROOT / rel) for rel in ["src/hermes-runtime.ts", "index.ts", "src/index.ts", "package.json", "install-android.sh", "src/cortex-sync.ts", "src/store/atomic-write.ts"]}
    # Include a hermes-files file if exists
    if (ROOT / "src/store/scored-index.ts").is_file():
        snap["src/store/scored-index.ts"] = sha(ROOT / "src/store/scored-index.ts")
    res = subprocess.run([sys.executable, str(apply)], cwd=str(ROOT), capture_output=True, text=True)
    if res.returncode != 0:
        print(f"verify failed: second apply returned non-zero: {res.stderr.strip()}", file=sys.stderr)
        print(res.stdout.strip(), file=sys.stderr)
        return 1
    if "no-op" not in res.stdout and "already applied" not in res.stdout:
        # Allow "overlay applied" with no changes? But idempotent should be no-op
        # Check if second apply reported copied 0 files and no patch change, it should be no-op
        if "0 copied" not in res.stdout and "already present" not in res.stdout:
            print(f"verify failed: second apply not no-op: stdout={res.stdout!r}", file=sys.stderr)
            return 1
    for rel, before in snap.items():
        after = sha(ROOT / rel)
        if after != before:
            print(f"verify failed: {rel} changed on second apply (not idempotent)", file=sys.stderr)
            return 1

    base = data.get("upstream_base") or data.get("upstream_commit","")[:7]
    oc = data.get("overlay_commit","")
    print(f"verify-upstream-overlay: ok (provenance {oc} base {base}, {len(snap)} markers, hermes-files, idempotent)")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
