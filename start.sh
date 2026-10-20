#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$project_dir"

runtime_dir="$project_dir/.narad"
env_file="$runtime_dir/compose.env"
tts_pid_file="$runtime_dir/tts.pid"
tts_log_file="$runtime_dir/tts.log"
compose_command=()

usage() {
  cat <<'EOF'
Usage: ./start.sh start|restart|kill|status|login codex|claude

  start          Build and start the agent/API containers and macOS MLX TTS host
  restart        Rebuild and restart all Narad services
  kill           Stop containers and the macOS TTS host
  status         Show container, API, and TTS status
  login codex    Authenticate Codex inside its private container volume
  login claude   Authenticate Claude inside its private container volume
EOF
}

find_compose() {
  if docker compose version >/dev/null 2>&1; then compose_command=(docker compose)
  elif command -v docker-compose >/dev/null 2>&1; then compose_command=(docker-compose)
  else
    echo "Docker Compose is required. Install Docker Desktop or the docker-compose plugin." >&2
    return 1
  fi
}

random_token() {
  if command -v openssl >/dev/null 2>&1; then openssl rand -hex 32
  else node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))"
  fi
}

ensure_runtime() {
  umask 077
  mkdir -p "$runtime_dir" data/library data/preparations data/tutor
  if [[ ! -f "$env_file" ]]; then
    cat >"$env_file" <<EOF
NARAD_AGENT_TOKEN=$(random_token)
NARAD_TTS_TOKEN=$(random_token)
EOF
  fi
  if ! grep -q '^NARAD_UID=' "$env_file"; then
    printf 'NARAD_UID=%s\n' "$(id -u)" >>"$env_file"
  fi
  set -a
  # shellcheck disable=SC1090
  source "$env_file"
  set +a
}

compose() {
  "${compose_command[@]}" --env-file "$env_file" -f compose.yaml "$@"
}

tts_running() {
  [[ -f "$tts_pid_file" ]] || return 1
  local pid recorded_start current_start command
  pid="$(sed -n '1p' "$tts_pid_file")"
  recorded_start="$(sed -n '2p' "$tts_pid_file")"
  [[ "$pid" =~ ^[0-9]+$ ]] && [[ -n "$recorded_start" ]] && kill -0 "$pid" 2>/dev/null || return 1
  current_start="$(ps -p "$pid" -o lstart= 2>/dev/null | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  command="$(ps -p "$pid" -o command= 2>/dev/null)"
  [[ "$current_start" == "$recorded_start" && "$command" == *"$project_dir/server/tts-host.ts"* ]]
}

tts_health_response() {
  curl --max-time 3 -fsS -H "Authorization: Bearer $NARAD_TTS_TOKEN" http://127.0.0.1:4321/health
}

tts_healthy() {
  local response
  response="$(tts_health_response)" || return 1
  [[ "$response" == *'"state":'* ]]
}

start_tts() {
  if tts_running; then
    if tts_healthy; then return 0; fi
    echo "The macOS TTS host process is running but its health check failed; restarting it."
    stop_tts
  fi
  rm -f "$tts_pid_file"
  if [[ ! -x speech/.venv/bin/python || ! -f data/models/qwen3-tts/model.safetensors ]]; then
    echo "MLX speech is not installed on this Mac. Run ./setup.sh --with-speech first." >&2
    return 1
  fi
  if ! command -v node >/dev/null 2>&1 || [[ ! -f node_modules/tsx/package.json ]]; then
    echo "Host JavaScript dependencies are missing. Run ./setup.sh --with-speech first." >&2
    return 1
  fi
  NARAD_TTS_TOKEN="$NARAD_TTS_TOKEN" NARAD_TTS_BIND_HOST=0.0.0.0 NARAD_TTS_PORT=4321 \
    nohup node --import tsx "$project_dir/server/tts-host.ts" >>"$tts_log_file" 2>&1 &
  local pid=$!
  local process_start
  process_start="$(ps -p "$pid" -o lstart= 2>/dev/null | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  printf '%s\n%s\n' "$pid" "$process_start" >"$tts_pid_file"
  for _ in {1..40}; do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "The macOS TTS host stopped during startup. See $tts_log_file" >&2
      return 1
    fi
    if tts_healthy; then return 0; fi
    sleep 0.25
  done
  echo "The macOS TTS host did not become ready. See $tts_log_file" >&2
  stop_tts
  return 1
}

stop_tts() {
  if ! tts_running; then rm -f "$tts_pid_file"; return 0; fi
  local pid children child command active
  pid="$(sed -n '1p' "$tts_pid_file")"
  children="$(pgrep -P "$pid" 2>/dev/null || true)"
  for child in $children; do
    command="$(ps -p "$child" -o command= 2>/dev/null || true)"
    if [[ "$command" == *"$project_dir/server/tts-host.ts"* ]]; then kill "$child" 2>/dev/null || true; fi
  done
  kill "$pid" 2>/dev/null || true
  for _ in {1..20}; do
    active=0
    kill -0 "$pid" 2>/dev/null && active=1
    for child in $children; do
      command="$(ps -p "$child" -o command= 2>/dev/null || true)"
      if [[ "$command" == *"$project_dir/server/tts-host.ts"* ]] && kill -0 "$child" 2>/dev/null; then active=1; fi
    done
    [[ "$active" == 0 ]] && break
    sleep 0.1
  done
  if kill -0 "$pid" 2>/dev/null; then kill -KILL "$pid" 2>/dev/null || true; fi
  for child in $children; do
    command="$(ps -p "$child" -o command= 2>/dev/null || true)"
    if [[ "$command" == *"$project_dir/server/tts-host.ts"* ]] && kill -0 "$child" 2>/dev/null; then kill -KILL "$child" 2>/dev/null || true; fi
  done
  rm -f "$tts_pid_file"
}

show_tts_status() {
  local response state pid
  pid="$(sed -n '1p' "$tts_pid_file" 2>/dev/null || true)"
  if response="$(tts_health_response 2>/dev/null)"; then
    state="$(printf '%s\n' "$response" | sed -n 's/.*"state":"\([^"]*\)".*/\1/p')"
    if tts_running; then
      echo "macOS TTS: responding (state: ${state:-unknown}, PID $pid)"
    else
      echo "macOS TTS: responding (state: ${state:-unknown}, not managed by start.sh)"
    fi
  elif tts_running; then
    echo "macOS TTS: process running (PID $pid), but health check failed"
  else
    echo "macOS TTS: stopped or unreachable"
  fi
}

show_status() {
  echo "Containers:"
  if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then echo "  Docker daemon is stopped."
  elif find_compose >/dev/null 2>&1 && [[ -f "$env_file" ]]; then compose ps || true
  else echo "  Docker Compose or runtime configuration is not available."
  fi
  echo
  show_tts_status
  if curl -fsS http://127.0.0.1:${NARAD_PORT:-4318}/api/health >/dev/null 2>&1; then echo "Narad API: ready at http://127.0.0.1:${NARAD_PORT:-4318}"
  else echo "Narad API: unavailable"
  fi
}

start_all() {
  command -v docker >/dev/null 2>&1 || { echo "Docker is required." >&2; return 1; }
  docker info >/dev/null 2>&1 || { echo "The Docker daemon is not running. Start Docker Desktop or your Docker runtime." >&2; return 1; }
  find_compose;ensure_runtime;start_tts
  compose up --detach --build
  show_status
}

kill_all() {
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 && find_compose >/dev/null 2>&1 && [[ -f "$env_file" ]]; then compose down || true; fi
  stop_tts
}

login_provider() {
  local provider="${1:-}"
  [[ "$provider" == codex || "$provider" == claude ]] || { usage; return 2; }
  command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 || { echo "The Docker daemon is not running." >&2; return 1; }
  find_compose;ensure_runtime
  if [[ "$provider" == codex ]]; then compose run --rm --entrypoint codex agent login --device-auth
  else compose run --rm --entrypoint claude agent auth login --claudeai
  fi
}

case "${1:-}" in
  start) start_all ;;
  restart) kill_all; start_all ;;
  kill|stop) kill_all; ensure_runtime; show_status ;;
  status) ensure_runtime; show_status ;;
  login) login_provider "${2:-}" ;;
  *) usage; exit 2 ;;
esac
