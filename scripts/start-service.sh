#!/usr/bin/env bash
set -euo pipefail
editor_project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"
mkdir -p "$editor_project_dir/.state"
systemd-run --user --unit=xangi-editor-prototype \
  --property="WorkingDirectory=$editor_project_dir" \
  --property="StandardOutput=append:$editor_project_dir/.state/server.log" \
  --property="StandardError=append:$editor_project_dir/.state/server.log" \
  /usr/bin/env "EDITOR_HOST=${EDITOR_HOST:-127.0.0.1}" \
  "EDITOR_PORT=${EDITOR_PORT:-18930}" \
  "EDITOR_BASE_URL=${EDITOR_BASE_URL:-http://${EDITOR_HOST:-127.0.0.1}:${EDITOR_PORT:-18930}}" \
  "$(command -v node)" server/main.mjs
