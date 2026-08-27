#!/data/data/com.termux/files/usr/bin/sh
set -e

echo "=== Installing pi-hermes-memory for Termux/Android ARM64 ==="
AGENT_NPM="${HOME}/.pi/agent/npm"
mkdir -p "$AGENT_NPM"

cd "$AGENT_NPM"

# 1) Install the package from git (builds better-sqlite3 from source if prebuilt unavailable)
echo "-> Installing pi-hermes-memory from git (CXXFLAGS=-std=c++20)"
CXXFLAGS="-std=c++20" npm install "https://github.com/sasazemzulin058-debug/pi-hermes-memory.git#main" --force --legacy-peer-deps

# 2) Resolve the exact Hermes better-sqlite3 addon path (contract: must be node_modules/better-sqlite3/build/Release/better_sqlite3.node)
# npm may dedupe better-sqlite3 to top-level or nest under pi-hermes-memory
CANDIDATES=""
for cand in \
  "$AGENT_NPM/node_modules/better-sqlite3/build/Release/better_sqlite3.node" \
  "$AGENT_NPM/node_modules/pi-hermes-memory/node_modules/better-sqlite3/build/Release/better_sqlite3.node"; do
  CANDIDATES="$CANDIDATES $cand"
done
ADDON=""
for p in $CANDIDATES; do
  if [ -f "$p" ]; then
    ADDON="$p"
    break
  fi
done

if [ -z "$ADDON" ]; then
  echo "error: better_sqlite3.node not found. Checked: $CANDIDATES" >&2
  echo "hint: ensure npm install completed and better-sqlite3 was rebuilt" >&2
  exit 1
fi

echo "-> Verifying addon at $ADDON"
if ! file "$ADDON" 2>&1 | tee /tmp/hermes_addon.file | grep -q "aarch64"; then
  echo "error: addon not aarch64: $(cat /tmp/hermes_addon.file)" >&2
  exit 1
fi
if ! grep -q "Android" /tmp/hermes_addon.file; then
  echo "error: addon not Android/Bionic: $(cat /tmp/hermes_addon.file)" >&2
  echo "hint: rebuild with pinned NDK: CXXFLAGS=\"-std=c++20\" npm rebuild better-sqlite3 --build-from-source" >&2
  echo "      or install prebuilt: see android/scripts/build-better-sqlite3-android.sh artifact" >&2
  exit 1
fi
if ! grep -q "shared object" /tmp/hermes_addon.file; then
  echo "error: addon not shared object: $(cat /tmp/hermes_addon.file)" >&2
  exit 1
fi

# 3) Optional prebuilt install: if a CI-built artifact is present locally or downloaded,
#    prefer it and verify checksum. This is the fast path for E2E testing without rebuilding.
#    Exact install path is still node_modules/better-sqlite3/build/Release/better_sqlite3.node
PREBUILT_SRC=""
# Local CI artifact (when testing with downloaded artifact)
for pre in \
  "$AGENT_NPM/android/build/better_sqlite3.node" \
  "$AGENT_NPM/better_sqlite3.node" \
  "$HOME/better_sqlite3.node" \
  "./android/build/better_sqlite3.node"; do
  if [ -f "$pre" ]; then
    PREBUILT_SRC="$pre"
    break
  fi
done

if [ -n "$PREBUILT_SRC" ]; then
  echo "-> Prebuilt artifact found at $PREBUILT_SRC — installing to $ADDON"
  # Verify prebuilt is Android arm64 before overwriting
  file "$PREBUILT_SRC" | tee /tmp/prebuilt.file
  if ! grep -q "aarch64" /tmp/prebuilt.file || ! grep -q "Android" /tmp/prebuilt.file; then
    echo "error: prebuilt is not Android aarch64: $(cat /tmp/prebuilt.file)" >&2
    exit 1
  fi
  # Verify checksum if sha256 file alongside
  PREBUILT_SHA="${PREBUILT_SRC}.sha256"
  if [ -f "$PREBUILT_SHA" ]; then
    echo "-> Verifying checksum $PREBUILT_SHA"
    (cd "$(dirname "$PREBUILT_SRC")" && sha256sum -c "$(basename "$PREBUILT_SHA")")
  else
    echo "warning: no checksum file $PREBUILT_SHA — skipping verify" >&2
  fi
  mkdir -p "$(dirname "$ADDON")"
  cp "$PREBUILT_SRC" "$ADDON"
  echo "-> Prebuilt installed to $ADDON"
  file "$ADDON"
fi

# 4) Final verification and guidance
echo "-> Final verification"
file "$ADDON"
META_CANDIDATES="$AGENT_NPM/android/build/better_sqlite3.metadata.json $AGENT_NPM/node_modules/pi-hermes-memory/android/build/better_sqlite3.metadata.json ./android/build/better_sqlite3.metadata.json"
for m in $META_CANDIDATES; do
  if [ -f "$m" ]; then
    echo "-> Metadata: $m"
    cat "$m" | head -n 30
    break
  fi
done

echo "✅ pi-hermes-memory successfully installed"
echo "   addon: $ADDON"
echo "   verify: file $ADDON | grep -q 'aarch64.*Android'"
echo "   install path (contract): node_modules/better-sqlite3/build/Release/better_sqlite3.node"
echo "   prebuilt artifact install: cp android/build/better_sqlite3.node \"\$AGENT_NPM/node_modules/pi-hermes-memory/node_modules/better-sqlite3/build/Release/better_sqlite3.node\" && sha256sum -c android/build/better_sqlite3.node.sha256 && file node_modules/better-sqlite3/build/Release/better_sqlite3.node"
