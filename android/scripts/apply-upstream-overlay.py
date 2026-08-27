#!/usr/bin/env python3
"""Apply Hermes fork overlay onto a clean upstream checkout.

Hybrid deterministic overlay:
  1. Validates provenance and upstream base SHA
  2. Applies git patch (if base matches) via `git apply --3way`
  3. Copies deterministic hermes-files overlay (android/overlay/hermes-files/ -> repo root)

Fails loudly on base mismatch or marker conflict. Idempotent: second apply is no-op.
Excludes android scaffolding from patch (preserved via rsync --exclude android/).

Layout:
  ROOT/
    android/overlay/hermes-fork.patch      # git diff upstream..HEAD excluding android+transients
    android/overlay/hermes-files/          # deterministic copy of fork-owned new files
    android/overlay/UPSTREAM               # provenance
    android/scripts/apply-upstream-overlay.py  # this file
    android/scripts/regenerate-upstream-overlay.py

Usage:
  python3 android/scripts/apply-upstream-overlay.py [--root <path>] [--check]
"""
from __future__ import annotations
import os

import argparse
import hashlib
import shutil
import subprocess
import sys
from pathlib import Path

def find_root(explicit: str | None) -> Path:
    if explicit:
        return Path(explicit).resolve()
    here = Path(__file__).resolve()
    if len(here.parents) >= 3 and (here.parents[2] / "package.json").exists():
        cand = here.parents[2]
        if (cand / "android" / "overlay").exists():
            return cand
    return Path.cwd().resolve()

def run_git(args: list[str], cwd: Path) -> subprocess.CompletedProcess:
    return subprocess.run(["git"] + args, cwd=str(cwd), capture_output=True, text=True)

def parse_provenance(p: Path) -> dict[str, str]:
    data: dict[str,str] = {}
    if not p.is_file():
        return data
    for line in p.read_text().splitlines():
        line=line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" in line:
            k,v = line.split("=",1)
            data[k.strip()] = v.strip()
    return data

def get_upstream_sha(root: Path) -> str | None:
    for ref in ["upstream/main", "refs/remotes/upstream/main", "FETCH_HEAD"]:
        res = run_git(["rev-parse", ref], root)
        if res.returncode==0:
            sha=res.stdout.strip()
            if len(sha)>=7 and all(c in "0123456789abcdef" for c in sha.lower()):
                return sha
    return None

def copy_hermes_files(root: Path, check_only: bool = False) -> tuple[int,int,int]:
    """Copy hermes-files overlay deterministically. Returns (copied, total, skipped)."""
    src_root = root / "android" / "overlay" / "hermes-files"
    if not src_root.is_dir():
        return (0,0,0)
    files = [p for p in src_root.rglob("*") if p.is_file()]
    total = len(files)
    copied = 0
    for src in files:
        rel = src.relative_to(src_root)
        dest = root / rel
        # Skip copying overlay scaffolding into itself? dest would be inside android/overlay/hermes-files itself if rel starts with android, but hermes-files doesn't contain android prefix for overlay files? It does contain .github etc. So fine.
        # Avoid copying provenance patch itself (already excluded)
        if dest.resolve() == src.resolve():
            continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        if dest.is_file():
            # compare hash
            src_hash = hashlib.sha256(src.read_bytes()).hexdigest()
            dest_hash = hashlib.sha256(dest.read_bytes()).hexdigest()
            if src_hash == dest_hash:
                continue
        if check_only:
            # In check mode, just count would-be copies but don't mutate
            copied += 1
            continue
        shutil.copy2(src, dest)
        copied += 1
    return (copied, total, total-copied)

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=None, help="repo root (default: auto-detect)")
    ap.add_argument("--check", action="store_true", help="only check, do not apply")
    args = ap.parse_args()
    root = find_root(args.root)
    patch = root / "android" / "overlay" / "hermes-fork.patch"
    provenance = root / "android" / "overlay" / "UPSTREAM"
    hermes_files_dir = root / "android" / "overlay" / "hermes-files"

    if not patch.is_file():
        # Allow missing patch if hermes-files exists (deterministic-only overlay)
        if hermes_files_dir.is_dir() and any(hermes_files_dir.rglob("*")):
            print(f"warning: patch missing {patch}, but hermes-files exists — proceeding with deterministic copy only", file=sys.stderr)
        else:
            print(f"overlay missing patch: {patch}", file=sys.stderr)
            return 1
    elif patch.stat().st_size == 0:
        print(f"warning: overlay patch is empty: {patch}", file=sys.stderr)
        # Empty patch is allowed if hermes-files covers all

    prov = parse_provenance(provenance) if provenance.is_file() else {}
    if provenance.is_file():
        txt = provenance.read_text()
        # Validate basic provenance shape, not hardcoded SHAs
        if "upstream_url=" not in txt or "upstream_branch=" not in txt or "overlay_format=" not in txt:
            print(f"provenance malformed: {provenance}", file=sys.stderr)
            return 1
        if "upstream_commit=" not in txt and "upstream_base=" not in txt:
            print(f"provenance missing upstream commit/base: {provenance}", file=sys.stderr)
            return 1
        if "overlay_commit=" not in txt:
            print(f"provenance missing overlay_commit: {provenance}", file=sys.stderr)
            return 1
        # Validate overlay_format contains patch or hermes-files
        fmt = prov.get("overlay_format","")
        if "patch" not in fmt and "hermes" not in fmt:
            print(f"provenance overlay_format unexpected: {fmt}", file=sys.stderr)
            return 1
    else:
        print(f"warning: provenance missing: {provenance}", file=sys.stderr)
        prov = {}

    # CI records one immutable upstream SHA before import; do not re-resolve
    # moving upstream/main between overlay passes.
    upstream_sha = os.environ.get("upstream_SHA") or get_upstream_sha(root)
    provenance_base = prov.get("upstream_base") or (prov.get("upstream_commit","")[:7] if prov.get("upstream_commit") else "")
    provenance_full = prov.get("upstream_commit","")
    if upstream_sha and provenance_base:
        # Compare provenance base as prefix of upstream_sha
        if not upstream_sha.startswith(provenance_base):
            # Try full SHA equality too
            if provenance_full and provenance_full != upstream_sha and not upstream_sha.startswith(provenance_full[:7]):
                # Base mismatch — deterministic hermes-files can still be copied, but patch is stale
                # Copy hermes-files as fallback before failing (so at least new files present)
                copied,total,skipped = copy_hermes_files(root, check_only=args.check)
                if copied>0 and not args.check:
                    print(f"hermes-files: copied {copied}/{total} files (deterministic fallback despite base mismatch)")
                print(f"overlay base mismatch: provenance base {provenance_base} ({provenance_full[:12] if provenance_full else 'unknown'}) != upstream {upstream_sha} ({upstream_sha[:7]})", file=sys.stderr)
                print(f"upstream has advanced beyond recorded base {provenance_base}. Patch {patch.name} was generated against {provenance_base} and may conflict.", file=sys.stderr)
                print(f"action required: regenerate patch from current upstream + fork tree:", file=sys.stderr)
                print(f"  python3 android/scripts/regenerate-upstream-overlay.py --upstream upstream/main", file=sys.stderr)
                print(f"  git add {patch.relative_to(root)} {provenance.relative_to(root)} && git commit -m \"chore(overlay): regenerate patch base {upstream_sha[:7]}\"", file=sys.stderr)
                print(f"or if hermes-files deterministic overlay is sufficient, verify that all required markers are satisfied via hermes-files and marker transforms.", file=sys.stderr)
                # Fail before tests — never partial tree claim success
                return 1
        else:
            print(f"provenance base ok: {provenance_base} matches upstream {upstream_sha[:7]}")
    elif upstream_sha:
        print(f"warning: cannot validate provenance base (provenance missing base), upstream is {upstream_sha[:7]}", file=sys.stderr)
    else:
        print(f"warning: cannot resolve upstream SHA (no upstream/main or FETCH_HEAD), skipping base check", file=sys.stderr)

    # Handle patch application (if patch exists and non-empty)
    patch_already_applied = False
    patch_applied_this_run = False
    patch_exists = patch.is_file() and patch.stat().st_size > 0

    if patch_exists:
        # Idempotence check: reverse applies -> already applied
        rev = run_git(["apply", "--check", "--reverse", str(patch)], root)
        if rev.returncode == 0:
            patch_already_applied = True
            print("patch already applied: no-op (reverse check succeeded)")
        else:
            fwd = run_git(["apply", "--check", str(patch)], root)
            if fwd.returncode != 0:
                print("overlay marker mismatch / conflict: patch does not apply", file=sys.stderr)
                if fwd.stderr:
                    print(fwd.stderr.strip(), file=sys.stderr)
                if fwd.stdout:
                    print(fwd.stdout.strip(), file=sys.stderr)
                # Suggest regeneration
                if upstream_sha:
                    print(f"hint: upstream base may have changed or patch conflicted. Regenerate via:", file=sys.stderr)
                    print(f"  python3 android/scripts/regenerate-upstream-overlay.py", file=sys.stderr)
                return 1
            if args.check:
                print("overlay patch applies cleanly (check only)")
                # In check mode, also report hermes-files would-be copies
                copied,total,_ = copy_hermes_files(root, check_only=True)
                if copied>0:
                    print(f"hermes-files: would copy {copied}/{total} files")
                return 0
            res = run_git(["apply", "--3way", str(patch)], root)
            if res.returncode != 0:
                print("overlay apply failed (git apply --3way)", file=sys.stderr)
                if res.stderr:
                    print(res.stderr.strip(), file=sys.stderr)
                if res.stdout:
                    print(res.stdout.strip(), file=sys.stderr)
                return 1
            patch_applied_this_run = True
            print("patch applied via git apply --3way")
    else:
        if args.check:
            print("patch empty or missing, check skipped")
        else:
            print("patch empty or missing, skipping patch apply")

    # Deterministic hermes-files copy (after patch to avoid duplicate 'already exists' for old patch)
    copied,total,skipped = copy_hermes_files(root, check_only=args.check)
    if args.check:
        if copied>0:
            print(f"hermes-files: would copy {copied}/{total} files (check only)")
        else:
            print(f"hermes-files: {total} files already present (check ok)")
        # Overall check success if patch also ok
        if patch_already_applied or not patch_exists:
            print("overlay check ok: patch and hermes-files consistent")
        return 0

    if copied>0:
        print(f"hermes-files: copied {copied}/{total} files")
    else:
        if total>0:
            print(f"hermes-files: {total} files already present (no-op)")
        else:
            print(f"hermes-files: no files to copy (dir missing or empty)")

    # Final idempotence reporting
    if patch_already_applied and copied==0:
        print("overlay already applied: no-op")
        return 0
    if patch_applied_this_run or copied>0:
        print(f"overlay applied: patch {'already' if patch_already_applied else 'applied' if patch_applied_this_run else 'skipped'}, hermes-files {copied} copied")
        return 0
    # No changes but not already-applied? Means first run had nothing to do but still ok
    print("overlay applied (no changes)")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
