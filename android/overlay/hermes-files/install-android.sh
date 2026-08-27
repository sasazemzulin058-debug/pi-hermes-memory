#!/data/data/com.termux/files/usr/bin/sh
set -e

echo "=== Installing pi-hermes-memory for Termux/Android ARM64 ==="
AGENT_NPM="${HOME}/.pi/agent/npm"
mkdir -p "$AGENT_NPM"

cd "$AGENT_NPM"
CXXFLAGS="-std=c++20" npm install "https://github.com/sasazemzulin058-debug/pi-hermes-memory.git#main" --force --legacy-peer-deps

echo "✅ pi-hermes-memory successfully installed"
