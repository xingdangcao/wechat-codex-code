#!/bin/bash
set -euo pipefail

DATA_DIR="${WCC_DATA_DIR:-${HOME}/.wechat-codex-code}"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SERVICE_NAME="wechat-codex-code"
PID_FILE="${DATA_DIR}/${SERVICE_NAME}.pid"

node_bin() {
  command -v node 2>/dev/null || echo "/usr/bin/node"
}

ensure_dirs() {
  mkdir -p "${DATA_DIR}/logs"
}

is_running() {
  local pid="${1:-}"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

start_direct() {
  ensure_dirs
  if [ -f "$PID_FILE" ]; then
    local old_pid
    old_pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if is_running "$old_pid"; then
      echo "Already running (PID: $old_pid)"
      exit 0
    fi
    rm -f "$PID_FILE"
  fi

  if [ ! -f "${PROJECT_DIR}/dist/main.js" ]; then
    echo "dist/main.js not found. Run npm run build first." >&2
    exit 1
  fi

  if ! ls "${DATA_DIR}/accounts/"*.json >/dev/null 2>&1; then
    echo "No WeChat account is bound yet. Run npm run setup first." >&2
    exit 1
  fi

  nohup "$(node_bin)" "${PROJECT_DIR}/dist/main.js" start \
    >> "${DATA_DIR}/logs/stdout.log" \
    2>> "${DATA_DIR}/logs/stderr.log" &
  local pid=$!
  echo "$pid" > "$PID_FILE"
  echo "Started ${SERVICE_NAME} daemon (PID: $pid)"
}

stop_direct() {
  if [ ! -f "$PID_FILE" ]; then
    echo "Not running"
    exit 0
  fi

  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if is_running "$pid"; then
    kill "$pid" 2>/dev/null || true
    sleep 1
    kill -9 "$pid" 2>/dev/null || true
    echo "Stopped (PID: $pid)"
  else
    echo "Not running (stale PID file cleaned)"
  fi
  rm -f "$PID_FILE"
}

status_direct() {
  if [ ! -f "$PID_FILE" ]; then
    echo "Not running"
    exit 0
  fi

  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if is_running "$pid"; then
    echo "Running (PID: $pid)"
  else
    echo "Not running (stale PID file)"
  fi
}

logs_direct() {
  local printed=0
  for f in "${DATA_DIR}"/logs/bridge-*.log "${DATA_DIR}/logs/stdout.log" "${DATA_DIR}/logs/stderr.log"; do
    if [ -f "$f" ]; then
      printed=1
      echo "=== $f ==="
      tail -80 "$f"
      echo
    fi
  done
  if [ "$printed" -eq 0 ]; then
    echo "No logs found"
  fi
}

case "${1:-}" in
  start) start_direct ;;
  stop) stop_direct ;;
  restart) stop_direct; start_direct ;;
  status) status_direct ;;
  logs) logs_direct ;;
  *)
    echo "Usage: daemon.sh {start|stop|restart|status|logs}"
    exit 1
    ;;
esac
