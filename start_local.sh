#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$project_dir"

runtime_dir="${NARAD_LOCAL_RUNTIME_DIR:-$project_dir/.narad}"
pid_file="$runtime_dir/local.pid"
log_file="$runtime_dir/local.log"

usage() {
  cat <<'EOF'
Usage: ./start_local.sh start|restart|kill|status|logs|login codex|claude

  start          Start the local API and Vite development server in the background
  restart        Restart the local development services
  kill           Stop the local development services
  status         Show local process, API, and web status
  logs           Follow the local development log
  login codex    Authenticate the host Codex CLI
  login claude   Authenticate the host Claude CLI
EOF
}

local_running() {
  [[ -f "$pid_file" ]] || return 1
  local pid recorded_start current_start command
  pid="$(sed -n '1p' "$pid_file")"
  recorded_start="$(sed -n '2p' "$pid_file")"
  [[ "$pid" =~ ^[0-9]+$ ]] && [[ -n "$recorded_start" ]] && kill -0 "$pid" 2>/dev/null || return 1
  current_start="$(ps -p "$pid" -o lstart= 2>/dev/null | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  command="$(ps -p "$pid" -o command= 2>/dev/null)"
  [[ "$current_start" == "$recorded_start" && "$command" == *"scripts/local-dev-daemon.mjs"* ]]
}

show_status() {
  if local_running; then
    echo "Local Narad: running (PID $(sed -n '1p' "$pid_file"))"
    if curl -fsS http://127.0.0.1:4318/api/health >/dev/null 2>&1; then echo "API: ready at http://127.0.0.1:4318"
    else echo "API: unavailable"
    fi
    if curl -fsS http://127.0.0.1:5178/ >/dev/null 2>&1; then echo "Web: ready at http://127.0.0.1:5178"
    else echo "Web: unavailable"
    fi
  else
    rm -f "$pid_file"
    echo "Local Narad: stopped"
    echo "API: unavailable"
    echo "Web: unavailable"
  fi
  echo "Log: $log_file"
}

start_local() {
  if local_running; then show_status;return 0;fi
  command -v node >/dev/null 2>&1 || { echo "Node.js 24 or newer is required." >&2;return 1; }
  command -v npm >/dev/null 2>&1 || { echo "npm is required." >&2;return 1; }
  [[ -x node_modules/.bin/tsx && -x node_modules/.bin/vite ]] || { echo "JavaScript dependencies are missing. Run ./setup.sh first." >&2;return 1; }
  if curl -fsS http://127.0.0.1:4318/api/health >/dev/null 2>&1 || curl -fsS http://127.0.0.1:5178/ >/dev/null 2>&1; then
    echo "Narad ports are already in use. Stop the Docker stack with ./start.sh kill or stop the other local process first." >&2
    return 1
  fi
  umask 077;mkdir -p "$runtime_dir";touch "$log_file"
  nohup node "$project_dir/scripts/local-dev-daemon.mjs" >>"$log_file" 2>&1 &
  local pid=$! process_start
  process_start="$(ps -p "$pid" -o lstart= 2>/dev/null | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  printf '%s\n%s\n' "$pid" "$process_start" >"$pid_file"
  for _ in {1..80};do
    if ! local_running;then echo "Local Narad stopped during startup. See $log_file" >&2;tail -n 40 "$log_file" >&2;return 1;fi
    if curl -fsS http://127.0.0.1:4318/api/health >/dev/null 2>&1 && curl -fsS http://127.0.0.1:5178/ >/dev/null 2>&1;then show_status;return 0;fi
    sleep 0.25
  done
  echo "Local Narad did not become ready. See $log_file" >&2;return 1
}

stop_local() {
  if ! local_running;then rm -f "$pid_file";echo "Local Narad is already stopped.";return 0;fi
  local pid;pid="$(sed -n '1p' "$pid_file")";kill "$pid"
  for _ in {1..50};do kill -0 "$pid" 2>/dev/null || break;sleep 0.1;done
  if kill -0 "$pid" 2>/dev/null;then kill -KILL "$pid" 2>/dev/null||true;fi
  rm -f "$pid_file";echo "Local Narad stopped."
}

login_provider() {
  local provider="${1:-}"
  case "$provider" in
    codex) command -v codex >/dev/null 2>&1||{ echo "Codex is not installed on the host." >&2;return 1;};codex login ;;
    claude) command -v claude >/dev/null 2>&1||{ echo "Claude is not installed on the host." >&2;return 1;};claude auth login --claudeai ;;
    *) usage;return 2 ;;
  esac
}

case "${1:-}" in
  start) start_local ;;
  restart) stop_local;start_local ;;
  kill|stop) stop_local ;;
  status) mkdir -p "$runtime_dir";show_status ;;
  logs) mkdir -p "$runtime_dir";touch "$log_file";tail -n 200 -f "$log_file" ;;
  login) login_provider "${2:-}" ;;
  *) usage;exit 2 ;;
esac
