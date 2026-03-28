#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "[Redline] node not found in PATH" >&2
  exit 1
fi

exec node "$SCRIPT_DIR/index.js" "$@"
