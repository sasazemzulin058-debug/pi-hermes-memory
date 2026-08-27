#!/usr/bin/env python3
"""Apply Hermes fork overlay onto a clean upstream checkout.

Deterministic: applies committed patch artifact via `git apply --3way`.
Idempotent: second apply is a no-op (detected via `git apply --reverse --check`).
Fails loudly on marker mismatch / conflicts.

Layout:
  ROOT/
    android/overlay/hermes-fork.patch  # generated via `git diff upstream/main..HEAD`
    android/overlay/UPSTREAM           # provenance
    android/scripts/apply-upstream-overlay.py  # this file

Usage:
  python3 android/scripts/apply-upstream-overlay.py [--root <path>] [--check]
  # When run from repo root, --root defaults to cwd.
  # --check only verifies patch applicability without mutating.
"""
from __future__ import annotations
import argparse
import subprocess
import sys
from pathlib import Path

def find_root(explicit: str | None) -> Path:
    if explicit:
        return Path(explicit).resolve()
    # If invoked as android/scripts/apply-upstream-overlay.py, repo root is parents[2]
    # Otherwise fall back to cwd.
    here = Path(__file__).resolve()
    if len(here.parents) >= 3 and (here.parents[2] / "package.json").exists():
        # Heuristic: repo root contains package.json and android/
        cand = here.parents[2]
        if (cand / "android" / "overlay").exists():
            return cand
    return Path.cwd().resolve()

def run_git(args: list[str], cwd: Path) -> subprocess.CompletedProcess:
    return subprocess.run(["git"] + args, cwd=str(cwd), capture_output=True, text=True)

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=None, help="repo root (default: auto-detect)")
    ap.add_argument("--check", action="store_true", help="only check, do not apply")
    args = ap.parse_args()
    root = find_root(args.root)
    patch = root / "android" / "overlay" / "hermes-fork.patch"
    provenance = root / "android" / "overlay" / "UPSTREAM"

    if not patch.is_file():
        print(f"overlay missing patch: {patch}", file=sys.stderr)
        return 1
    if patch.stat().st_size == 0:
        print(f"overlay patch is empty: {patch}", file=sys.stderr)
        return 1
    if provenance.is_file():
        txt = provenance.read_text()
        if "upstream_url=" not in txt or "upstream_branch=" not in txt or "overlay_format=" not in txt:
            print(f"provenance malformed: {provenance}", file=sys.stderr)
            return 1
        if "overlay_commit=f20e315" not in txt:
            print(f"provenance overlay commit mismatch (expected f20e315): {provenance}", file=sys.stderr)
            return 1
    else:
        print(f"warning: provenance missing: {provenance}", file=sys.stderr)

    # Reject if working tree has .pi/node_modules artifacts that would be embedded
    # (script never reads them, but fail if caller asks to embed — nothing to do)
    # Idempotence: if patch already applied, reverse check succeeds
    rev = run_git(["apply", "--check", "--reverse", str(patch)], root)
    if rev.returncode == 0:
        print("overlay already applied: no-op")
        return 0

    # Check forward applicability (without --3way first for loud failure)
    fwd = run_git(["apply", "--check", str(patch)], root)
    if fwd.returncode != 0:
        # Try with --3way check: git doesn't have --check --3way exactly, but we can attempt
        # Fall through to loud failure reporting original error
        print("overlay marker mismatch / conflict: patch does not apply", file=sys.stderr)
        if fwd.stderr:
            print(fwd.stderr.strip(), file=sys.stderr)
        if fwd.stdout:
            print(fwd.stdout.strip(), file=sys.stderr)
        # Also report git apply --3way --check style attempt
        return 1

    if args.check:
        print("overlay patch applies cleanly (check only)")
        return 0

    # Apply with 3-way for robustness (preserves upstream history for merges)
    res = run_git(["apply", "--3way", str(patch)], root)
    if res.returncode != 0:
        print("overlay apply failed", file=sys.stderr)
        if res.stderr:
            print(res.stderr.strip(), file=sys.stderr)
        if res.stdout:
            print(res.stdout.strip(), file=sys.stderr)
        return 1

    print("overlay applied")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
