#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$project_dir"

with_speech=false
if [[ "${1:-}" == "--with-speech" ]]; then
  with_speech=true
elif [[ -n "${1:-}" ]]; then
  echo "Usage: ./setup.sh [--with-speech]" >&2
  exit 2
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 24 or newer is required: https://nodejs.org/" >&2
  exit 1
fi
node_major="$(node -p "process.versions.node.split('.')[0]")"
if (( node_major < 24 )); then
  echo "Node.js 24 or newer is required; found $(node --version)." >&2
  exit 1
fi

if [[ -f package-lock.json ]]; then npm ci; else npm install; fi
mkdir -p data

if [[ "$with_speech" == true ]]; then
  if ! command -v uv >/dev/null 2>&1; then
    echo "uv is required for local speech: https://docs.astral.sh/uv/" >&2
    exit 1
  fi
  npm run speech:setup
fi

npm run build
echo
echo "Narad is ready. Run: npm run dev"
if [[ "$with_speech" == false ]]; then
  echo "For local voices (Breeze TTS 2, about 7.6 GB), run: ./setup.sh --with-speech"
fi
