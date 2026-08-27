#!/usr/bin/env python3
"""Regenerate Hermes overlay patch from current upstream + fork tree.

Deterministic maintenance: compares upstream/main to current HEAD,
excludes android scaffolding and hermes-files-owned paths, writes
android/overlay/hermes-fork.patch and updates android/overlay/UPSTREAM
provenance.

Excludes:
  - android/ (overlay scaffolding, preserved via rsync --exclude android/)
  - node_modules/, .pi/, .tmp/, transient caches
  - any file already represented in android/overlay/hermes-files/ (deterministic copy)

Usage:
  python3 android/scripts/regenerate-upstream-overlay.py [--root <path>] [--upstream <ref>] [--check]

  --check: only report what would be generated, do not write.

Provenance is updated to reflect new upstream base and overlay commit.
"""
from __future__ import annotations
import argparse
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

def parse_provenance(path: Path) -> dict[str, str]:
    data: dict[str, str] = {}
    if path.is_file():
        for line in path.read_text().splitlines():
            line=line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" in line:
                k,v=line.split("=",1)
                data[k.strip()]=v.strip()
    return data

def get_upstream_sha(root: Path, ref: str) -> str | None:
    for candidate in [ref, "upstream/main", "refs/remotes/upstream/main", "FETCH_HEAD"]:
        res = run_git(["rev-parse", candidate], root)
        if res.returncode==0:
            sha=res.stdout.strip()
            if len(sha)>=7:
                return sha
    return None

def collect_hermes_files_excludes(root: Path) -> list[str]:
    hermes_dir = root / "android" / "overlay" / "hermes-files"
    excludes: list[str] = []
    if hermes_dir.is_dir():
        for p in hermes_dir.rglob("*"):
            if p.is_file():
                rel = p.relative_to(hermes_dir).as_posix()
                # git pathspec exclude
                excludes.append(f":!{rel}")
    return excludes

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=None, help="repo root")
    ap.add_argument("--upstream", default="upstream/main", help="upstream ref")
    ap.add_argument("--check", action="store_true", help="dry-run, do not write")
    args = ap.parse_args()
    root = find_root(args.root)
    patch_path = root / "android" / "overlay" / "hermes-fork.patch"
    prov_path = root / "android" / "overlay" / "UPSTREAM"
    hermes_dir = root / "android" / "overlay" / "hermes-files"

    upstream_sha = get_upstream_sha(root, args.upstream)
    if not upstream_sha:
        print(f"error: cannot resolve upstream ref {args.upstream}; run 'git fetch upstream main' first", file=sys.stderr)
        return 1
    short_base = upstream_sha[:7]
    head_res = run_git(["rev-parse", "HEAD"], root)
    if head_res.returncode!=0:
        print(f"error: cannot resolve HEAD", file=sys.stderr)
        return 1
    head_sha = head_res.stdout.strip()
    head_short = head_sha[:7]

    print(f"upstream {args.upstream} -> {upstream_sha} ({short_base})")
    print(f"HEAD -> {head_sha} ({head_short})")
    if hermes_dir.is_dir():
        cnt = sum(1 for _ in hermes_dir.rglob("*") if _.is_file())
        print(f"hermes-files: {cnt} files in {hermes_dir.relative_to(root)}")
    else:
        print(f"warning: hermes-files dir missing: {hermes_dir}", file=sys.stderr)

    # Build git diff pathspecs
    excludes = [":!android", ":!node_modules", ":!.pi", ":!.tmp", ":!tmp", ":!*.log"]
    excludes += collect_hermes_files_excludes(root)
    # git diff upstream/main -- . ':!android' ...
    diff_args = ["diff", f"{args.upstream}..HEAD", "--patch", "--", "."]
    diff_args += excludes
    print(f"running: git {' '.join(diff_args)}")
    res = run_git(diff_args, root)
    if res.returncode!=0:
        print(f"git diff failed: {res.stderr.strip()}", file=sys.stderr)
        return 1
    patch_text = res.stdout
    # Normalize: ensure patch ends with newline, strip trailing whitespace on blank lines? Keep as git produced but ensure final newline.
    if patch_text and not patch_text.endswith("\n"):
        patch_text += "\n"
    # Count stats
    diff_stat = run_git(["diff", "--stat", f"{args.upstream}..HEAD", "--", "."] + excludes, root)
    stat = diff_stat.stdout.strip() if diff_stat.returncode==0 else "(stat unavailable)"
    print(stat.splitlines()[-1] if stat else "no diff stat")
    # Check for android scaffolding leak
    if "diff --git a/android/overlay" in patch_text or "diff --git a/android/scripts" in patch_text:
        print("error: generated patch unexpectedly contains android scaffolding (exclusion failed)", file=sys.stderr)
        return 1
    if not patch_text.strip():
        print("warning: generated patch is empty (no diff between upstream and HEAD after exclusions)", file=sys.stderr)
        if args.check:
            return 0
        # Still update provenance to reflect base, but keep empty patch? Better to error.
        # For hermes-files-only overlay, empty patch is okay if hermes-files covers all.
        # Allow empty but warn.
    if args.check:
        print(f"dry-run: would write {len(patch_text)} bytes to {patch_path}")
        print(f"dry-run: would update {prov_path}")
        return 0

    # Write patch atomically
    if patch_text.strip():
        patch_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = patch_path.with_suffix(".tmp")
        tmp.write_text(patch_text, encoding="utf-8")
        tmp.replace(patch_path)
        print(f"wrote patch {patch_path} ({len(patch_text)} bytes, {patch_text.count('diff --git') } files)")
    else:
        # Keep existing patch if empty? For now write empty with newline
        patch_path.write_text("", encoding="utf-8")
        print(f"wrote empty patch {patch_path}")

    # Update provenance
    prov = parse_provenance(prov_path)
    # Preserve upstream_url/branch if present, else defaults
    prov.setdefault("upstream_url", "https://github.com/chandra447/pi-hermes-memory.git")
    prov.setdefault("upstream_branch", "main")
    prov["overlay_format"] = "patch-v1+hermes-files-v1"
    prov["overlay_commit"] = head_short
    prov["upstream_commit"] = upstream_sha
    prov["upstream_base"] = short_base
    prov["overlay_patch"] = "android/overlay/hermes-fork.patch"
    prov["hermes_files"] = "android/overlay/hermes-files"
    prov["generated_from"] = f"{args.upstream}..{head_short}"
    prov["overlay_version"] = str(int(prov.get("overlay_version","1"))+1 if prov.get("overlay_version") else "2")
    # hermes_files_count
    hermes_count = sum(1 for _ in hermes_dir.rglob("*") if _.is_file()) if hermes_dir.is_dir() else 0
    prov["hermes_files_count"] = str(hermes_count)

    # Write provenance sorted with header
    lines = ["# Hermes upstream provenance — do not edit manually"]
    order = ["upstream_url","upstream_branch","overlay_format","overlay_commit","upstream_commit","upstream_base","overlay_patch","hermes_files","generated_from","overlay_version","hermes_files_count"]
    for k in order:
        if k in prov:
            lines.append(f"{k}={prov[k]}")
    # Add any extra keys not in order
    for k,v in prov.items():
        if k not in order:
            lines.append(f"{k}={v}")
    prov_text = "\n".join(lines) + "\n"
    prov_path.write_text(prov_text, encoding="utf-8")
    print(f"updated provenance {prov_path}:")
    print(prov_text.strip())
    # Verify patch applies correctly on current tree (reverse check should succeed)
    # Since we generated from HEAD vs upstream, current tree is HEAD, so patch should be reverse-applicable (already applied)
    rev = run_git(["apply", "--check", "--reverse", str(patch_path)], root)
    fwd = run_git(["apply", "--check", str(patch_path)], root)
    if patch_text.strip():
        if rev.returncode==0:
            print("verify: patch reverse-applies on current HEAD (already applied) — ok")
        elif fwd.returncode==0:
            print("verify: patch forward-applies on current HEAD (would apply) — unexpected, HEAD should already contain fork files")
        else:
            print("warning: generated patch neither forward nor reverse applies on current HEAD (check exclusions)", file=sys.stderr)
            if fwd.stderr:
                print(fwd.stderr[:500], file=sys.stderr)
    print("regeneration complete. Next steps:")
    print(f"  git add {patch_path.relative_to(root)} {prov_path.relative_to(root)}")
    print(f"  git commit -m \"chore(overlay): regenerate patch base {short_base} overlay {head_short}\"")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
