#!/usr/bin/env bash
# Starts an ISOLATED, KEY-LESS copy of the Worker for QA:
#   - config dir /tmp/qa-worker (wrangler.jsonc + empty .dev.vars), generated here, nothing committed
#   - serves workers/api/src/index.ts on http://localhost:8788 (never 8787, the dev Worker)
#   - talks to the SEPARATE database `credential-reaper-qa` on the local SpacetimeDB (localhost:3000)
#   - has NO NVIDIA_API_KEY (not in vars, .dev.vars is empty, the variable is unset for the process),
#     so every investigation uses the scripted mock provider and reports source "mock"
# It never reads workers/api/.dev.vars.
#
# Optional env: QA_DB (default credential-reaper-qa), QA_TOKEN_FILE (file holding a SPACETIME_AUTH_TOKEN
# for a registered service identity; its content goes into the generated .dev.vars, never into logs).
#
#   workers/api/scripts/qa-worker.sh start   # idempotent: refuses if 8788 is already taken
#   workers/api/scripts/qa-worker.sh stop    # kills only the process group this script started
#   workers/api/scripts/qa-worker.sh status
set -euo pipefail

API_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
QA_DIR=/tmp/qa-worker
PORT=${QA_PORT:-8788}
DB_NAME=${QA_DB:-credential-reaper-qa}
TOKEN_FILE=${QA_TOKEN_FILE:-}
PIDFILE="$QA_DIR/pid"
LOG="$QA_DIR/wrangler.log"

write_config() {
  mkdir -p "$QA_DIR"
  ( umask 077; : > "$QA_DIR/.dev.vars" )
  if [ -n "$TOKEN_FILE" ]; then
    ( umask 077; printf 'SPACETIME_AUTH_TOKEN=%s\n' "$(cat "$TOKEN_FILE")" > "$QA_DIR/.dev.vars" )
  fi
  cat > "$QA_DIR/wrangler.jsonc" <<JSON
{
  "name": "credential-reaper-api-qa",
  "main": "$API_DIR/src/index.ts",
  "compatibility_date": "2026-11-01",
  "compatibility_flags": ["nodejs_compat"],
  "vars": {
    "ENVIRONMENT": "qa",
    "SPACETIME_URL": "http://localhost:3000",
    "SPACETIME_DB_NAME": "$DB_NAME"
  }
}
JSON
}

case "${1:-}" in
  start)
    if (echo > "/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then
      echo "port $PORT is already in use; refusing to start (stop the owner first)" >&2
      exit 1
    fi
    write_config
    cd "$QA_DIR"
    env -u NVIDIA_API_KEY -u NEMOTRON_MODEL setsid nohup "$API_DIR/node_modules/.bin/wrangler" dev --config "$QA_DIR/wrangler.jsonc" --port "$PORT" --ip 127.0.0.1 > "$LOG" 2>&1 &
    echo $! > "$PIDFILE"
    for _ in $(seq 1 60); do
      if (echo > "/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then echo "qa worker up on http://localhost:$PORT (pid $(cat "$PIDFILE"), log $LOG)"; exit 0; fi
      sleep 1
    done
    echo "qa worker did not come up; see $LOG" >&2
    exit 1
    ;;
  stop)
    if [ -f "$PIDFILE" ]; then
      pid="$(cat "$PIDFILE")"
      kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
      rm -f "$PIDFILE"
      echo "stopped qa worker (pid $pid)"
    else
      echo "no pid file; nothing to stop"
    fi
    ;;
  status)
    if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then echo "running (pid $(cat "$PIDFILE"))"; else echo "not running"; fi
    ;;
  *)
    echo "usage: $0 start|stop|status" >&2
    exit 2
    ;;
esac
