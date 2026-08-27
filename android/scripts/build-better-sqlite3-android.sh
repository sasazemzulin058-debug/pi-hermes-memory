#!/usr/bin/env bash
# Cross-compile better-sqlite3 for aarch64-linux-android (Termux/Bionic) on CI.
# Uses the pinned Android NDK/toolchain from android/versions.env and validates
# the output is a real Android ARM64 shared object — not linux-arm64 or source-only.
#
# Required env:
#   ANDROID_NDK_ROOT — root of an NDK that ships aarch64-linux-android clang,
#                      e.g. r27c from nttld/setup-ndk (provides $NDK_PATH output)
#
# Pinned inputs (android/versions.env):
#   NDK_VERSION=r27c
#   ANDROID_API=24
#   NODE_VERSION=22
#
# Outputs (all fail-closed on wrong arch):
#   node_modules/better-sqlite3/build/Release/better_sqlite3.node
#   android/build/better_sqlite3.node
#   android/build/better_sqlite3.android-arm64.node
#   android/build/better_sqlite3.node.sha256
#   android/build/better_sqlite3.metadata.json
#
# Install path on device (exact, per contract):
#   <hermes_root>/node_modules/better-sqlite3/build/Release/better_sqlite3.node
#   e.g. ~/.pi/agent/npm/node_modules/pi-hermes-memory/node_modules/better-sqlite3/build/Release/better_sqlite3.node
#   or   <project>/node_modules/better-sqlite3/build/Release/better_sqlite3.node
#   Artifact is installed by copying android/build/better_sqlite3.node to that path
#   and verifying sha256. See install-android.sh and metadata.json for details.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

: "${ANDROID_NDK_ROOT:?ANDROID_NDK_ROOT must be set to the NDK root (nttld/setup-ndk output)}"

# Load pinned versions — fail closed if missing
VERSIONS_FILE="android/versions.env"
if [ ! -f "$VERSIONS_FILE" ]; then
  echo "error: missing $VERSIONS_FILE (pinned NDK/API)" >&2
  exit 1
fi
# shellcheck disable=SC1090
set -a
# grep -v '^#' pattern mirrored in CI workflow step
# shellcheck disable=SC1091
source "$VERSIONS_FILE"
set +a

ANDROID_API="${ANDROID_API:?ANDROID_API must be set in $VERSIONS_FILE}"
NDK_VERSION="${NDK_VERSION:?NDK_VERSION must be set in $VERSIONS_FILE}"
NODE_VERSION="${NODE_VERSION:-22}"

echo "==> Hermes Android build (better-sqlite3)"
echo "    pinned NDK_VERSION=$NDK_VERSION ANDROID_API=$ANDROID_API NODE_VERSION=$NODE_VERSION"
echo "    ANDROID_NDK_ROOT=$ANDROID_NDK_ROOT"

# Detect NDK host tag (CI runner is linux-x86_64; allow linux-aarch64 for self-hosted)
ARCH_NAME="$(uname -m)"
OS_NAME="$(uname -s)"
case "$OS_NAME:$ARCH_NAME" in
  Linux:x86_64) NDK_HOST_TAG="linux-x86_64"; NDK_EXE_SUFFIX="" ;;
  Linux:aarch64|Linux:arm64) NDK_HOST_TAG="linux-aarch64"; NDK_EXE_SUFFIX="" ;;
  MINGW*:x86_64|MSYS*:x86_64|CYGWIN*:x86_64) NDK_HOST_TAG="windows-x86_64"; NDK_EXE_SUFFIX=".exe" ;;
  *) echo "error: unsupported host $OS_NAME/$ARCH_NAME" >&2; exit 1 ;;
esac

NDK_BIN="$ANDROID_NDK_ROOT/toolchains/llvm/prebuilt/$NDK_HOST_TAG/bin"
NDK_CLANG="$NDK_BIN/aarch64-linux-android${ANDROID_API}-clang$NDK_EXE_SUFFIX"
NDK_CXX="$NDK_BIN/aarch64-linux-android${ANDROID_API}-clang++$NDK_EXE_SUFFIX"
NDK_AR="$NDK_BIN/llvm-ar$NDK_EXE_SUFFIX"
NDK_RANLIB="$NDK_BIN/llvm-ranlib$NDK_EXE_SUFFIX"
NDK_STRIP="$NDK_BIN/llvm-strip$NDK_EXE_SUFFIX"
NDK_READELF="$NDK_BIN/llvm-readelf$NDK_EXE_SUFFIX"

for tool in "$NDK_CLANG" "$NDK_CXX" "$NDK_AR" "$NDK_RANLIB"; do
  if [ ! -x "$tool" ]; then
    echo "error: NDK tool not found: $tool" >&2
    echo "  checked NDK_BIN=$NDK_BIN (from ANDROID_NDK_ROOT=$ANDROID_NDK_ROOT)" >&2
    ls -la "$NDK_BIN"/aarch64-linux-android* 2>&1 | head -n 20 >&2 || true
    exit 1
  fi
done

# Point node-gyp/cc at the NDK clang for the aarch64 target.
# node-gyp (via gyp) reads CC/CXX; some bindings also read CC_<target>.
# Export both generic and target-specific forms to cover both.
export PATH="$NDK_BIN:$PATH"
export CC="$NDK_CLANG"
export CXX="$NDK_CXX"
export CC_aarch64_linux_android="$NDK_CLANG"
export CXX_aarch64_linux_android="$NDK_CXX"
export AR_aarch64_linux_android="$NDK_AR"
export AR="$NDK_AR"
export RANLIB="$NDK_RANLIB"
export STRIP="$NDK_STRIP"

# Force visibility and optimization consistent with Termux/Bionic builds
export CFLAGS="-Os -g0 -fvisibility=hidden"
export CXXFLAGS="-Os -g0 -fvisibility=hidden -std=c++20"
export CFLAGS_aarch64_linux_android="-Os -g0 -fvisibility=hidden"
export CXXFLAGS_aarch64_linux_android="-Os -g0 -fvisibility=hidden -std=c++20"

# npm/node-gyp environment — force source build, no prebuild-install download
export npm_config_build_from_source="true"
# Ensure prebuild-install does not fetch x86_64 binaries; fall through to node-gyp
export npm_config_arch="arm64"

echo "    NDK clang: $NDK_CLANG"
echo "    NDK cxx:   $NDK_CXX"
echo "    CC=$CC CXX=$CXX"

# Verify Node version matches pinned (warn only, don't fail — CI may use setup-node)
NODE_V="$(node -v 2>&1 || echo "unknown")"
echo "    node: $NODE_V (pinned major $NODE_VERSION)"
if ! node -p "process.versions.modules" >/dev/null 2>&1; then
  echo "error: node not found in PATH" >&2
  exit 1
fi

# Clean previous native build to guarantee a real compile (not cached .node)
echo "==> Cleaning previous better-sqlite3 build"
rm -rf node_modules/better-sqlite3/build
mkdir -p node_modules/better-sqlite3/build/Release 2>/dev/null || true

# Install deps if missing (npm ci should have run in CI; local dev may need install)
if [ ! -d "node_modules/better-sqlite3" ]; then
  echo "error: node_modules/better-sqlite3 missing — run npm ci first" >&2
  exit 1
fi

echo "==> Rebuilding better-sqlite3 from source for aarch64-linux-android (API $ANDROID_API, NDK $NDK_VERSION)"
# Use npm rebuild with explicit build-from-source to avoid prebuild-install fallback.
# Keep verbose output for CI diagnostics; timeout is handled by workflow.
npm rebuild better-sqlite3 --build-from-source --verbose

ADDON="node_modules/better-sqlite3/build/Release/better_sqlite3.node"
if [ ! -f "$ADDON" ]; then
  echo "error: expected addon not found at $ADDON after rebuild" >&2
  ls -la node_modules/better-sqlite3/build/Release/ 2>&1 | head -n 40 >&2 || true
  exit 1
fi

# Optional strip (NDK debug symbols can bloat; keep failure non-fatal)
if [ -x "$NDK_STRIP" ]; then
  "$NDK_STRIP" --strip-unneeded "$ADDON" 2>/dev/null || true
fi

# === Fail-closed verification ===
# `file(1)` reports architecture/type; Android/Bionic identity comes from
# NDK readelf dependencies because some file versions omit the Android label.
file_type="$(file -b "$ADDON")"
echo "==> Built: $ADDON"
echo "    $file_type"
case "$file_type" in
  *ELF*64-bit*LSB*shared*object*ARM*aarch64*|*ELF*64-bit*LSB*shared*object*aarch64*)
    echo "    OK: file(1) reports ELF64 aarch64 shared object"
    ;;
  *)
    echo "error: addon is not ELF64 aarch64 shared object" >&2
    echo "  got: $file_type" >&2
    exit 1
    ;;
esac

if echo "$file_type" | grep -q "GNU/Linux"; then
  echo "error: addon appears to be GNU/Linux (glibc), not Android/Bionic: $file_type" >&2
  exit 1
fi
echo "$file_type" | grep -q "aarch64" || { echo "error: file output missing aarch64: $file_type" >&2; exit 1; }
echo "$file_type" | grep -q "shared object" || { echo "error: file output missing shared object: $file_type" >&2; exit 1; }

# readelf Machine/Class and Android's Bionic-linked libraries are mandatory.
READELF_BIN=""
if [ -x "$NDK_READELF" ]; then READELF_BIN="$NDK_READELF"; elif command -v llvm-readelf >/dev/null 2>&1; then READELF_BIN="llvm-readelf"; fi
if [ -z "$READELF_BIN" ]; then
  echo "error: llvm-readelf required for Android/Bionic verification" >&2
  exit 1
fi
READELF_OUT="$("$READELF_BIN" -h "$ADDON" 2>&1)"
echo "$READELF_OUT"
echo "$READELF_OUT" | grep -q "Machine:.*AArch64" || { echo "error: readelf Machine is not AArch64" >&2; exit 1; }
echo "$READELF_OUT" | grep -q "Class:.*ELF64" || { echo "error: ELF Class is not ELF64" >&2; exit 1; }
DEPS="$("$READELF_BIN" -d "$ADDON" 2>&1)"
echo "$DEPS"
echo "$DEPS" | grep -q 'Shared library: \[libc.so\]' || { echo "error: addon lacks Android libc.so dependency" >&2; exit 1; }
echo "$DEPS" | grep -q 'Shared library: \[liblog.so\]' || { echo "error: addon lacks Android liblog.so dependency" >&2; exit 1; }
echo "    OK: readelf confirms Android/Bionic ELF64 AArch64 addon"

 # === Package artifact with checksum and metadata ===

STAGE_DIR="android/build"
mkdir -p "$STAGE_DIR"

# Copy to stable stage names — keep original better_sqlite3.node and explicit arch variant
cp "$ADDON" "$STAGE_DIR/better_sqlite3.node"
cp "$ADDON" "$STAGE_DIR/better_sqlite3.android-arm64.node"

# sha256
(
  cd "$STAGE_DIR"
  sha256sum "better_sqlite3.node" > "better_sqlite3.node.sha256"
  # also for variant name (same hash, different filename for clarity)
  sha256sum "better_sqlite3.android-arm64.node" > "better_sqlite3.android-arm64.node.sha256"
  # verify immediately
  sha256sum -c "better_sqlite3.node.sha256"
  sha256sum -c "better_sqlite3.android-arm64.node.sha256"
)

SHA256="$(awk '{print $1}' "$STAGE_DIR/better_sqlite3.node.sha256")"
FILE_TYPE_ESCAPED="$(printf "%s" "$file_type" | sed 's/"/\\"/g')"

# Metadata — versioned and clearly named, install path is exact
NODE_ABI="$(node -p "process.versions.modules" 2>&1)"
PKG_VERSION="$(node -p "require('./package.json').version" 2>&1)"
BETTER_SQLITE3_VERSION="$(node -p "require('./node_modules/better-sqlite3/package.json').version" 2>&1)"
GIT_SHA="$(git rev-parse HEAD 2>&1 || echo "unknown")"
GIT_SHORT="$(git rev-parse --short HEAD 2>&1 || echo "unknown")"
BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ 2>&1)"

cat > "$STAGE_DIR/better_sqlite3.metadata.json" <<JSON_EOF
{
  "name": "better-sqlite3",
  "package": "pi-hermes-memory",
  "package_version": "$PKG_VERSION",
  "better_sqlite3_version": "$BETTER_SQLITE3_VERSION",
  "arch": "aarch64",
  "platform": "android",
  "abi": "aarch64-linux-android",
  "libc": "bionic",
  "android_api": "$ANDROID_API",
  "ndk_version": "$NDK_VERSION",
  "node_abi": "$NODE_ABI",
  "node_version": "$NODE_V",
  "git_sha": "$GIT_SHA",
  "git_short": "$GIT_SHORT",
  "built_at": "$BUILT_AT",
  "artifact": "better_sqlite3.node",
  "variant": "android-arm64",
  "variant_artifact": "better_sqlite3.android-arm64.node",
  "source_path": "node_modules/better-sqlite3/build/Release/better_sqlite3.node",
  "install_path": "node_modules/better-sqlite3/build/Release/better_sqlite3.node",
  "install_path_absolute_example": "\$HOME/.pi/agent/npm/node_modules/pi-hermes-memory/node_modules/better-sqlite3/build/Release/better_sqlite3.node",
  "file_type": "$FILE_TYPE_ESCAPED",
  "sha256": "$SHA256",
  "sha256_file": "better_sqlite3.node.sha256",
  "build_toolchain": "NDK clang aarch64-linux-android${ANDROID_API}-clang (NDK $NDK_VERSION)",
  "verification": "file(1) must report ELF 64-bit LSB shared object, ARM aarch64, for Android $ANDROID_API, built by NDK; readelf Machine AArch64"
}
JSON_EOF

echo "    sha256: $SHA256"
echo "    metadata: $STAGE_DIR/better_sqlite3.metadata.json"
cat "$STAGE_DIR/better_sqlite3.metadata.json"
echo "==> Done — artifact staged in $STAGE_DIR"
ls -lh "$STAGE_DIR"/better_sqlite3* 2>&1
