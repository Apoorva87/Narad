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
  mkdir -p "$runtime_dir" data/preparations data/tutor
  if [[ ! -f "$env_file" ]]; then
    cat >"$env_file" <<EOF
NARAD_AGENT_TOKEN=$(random_token)
NARAD_TTS_TOKEN=$(random_token)
EOF
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
  local pid
  pid="$(cat "$tts_pid_file")"
  [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null
}

start_tts() {
  if tts_running; then return 0; fi
  rm -f "$tts_pid_file"
  if [[ ! -x speech/.venv/bin/python || ! -f data/models/qwen3-tts/model.safetensors ]]; then
    echo "MLX speech is not installed on this Mac. Run ./setup.sh --with-speech first." >&2
    return 1
  fi
  if [[ ! -x node_modules/.bin/tsx ]]; then
    echo "Host JavaScript dependencies are missing. Run ./setup.sh --with-speech first." >&2
    return 1
  fi
  NARAD_TTS_TOKEN="$NARAD_TTS_TOKEN" NARAD_TTS_BIND_HOST=0.0.0.0 NARAD_TTS_PORT=4321 \
    nohup node_modules/.bin/tsx server/tts-host.ts >>"$tts_log_file" 2>&1 &
  local pid=$!
  echo "$pid" >"$tts_pid_file"
  for _ in {1..40}; do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "The macOS TTS host stopped during startup. See $tts_log_file" >&2
      return 1
    fi
    if curl -fsS -H "Authorization: Bearer $NARAD_TTS_TOKEN" http://127.0.0.1:4321/health >/dev/null 2>&1; then return 0; fi
    sleep 0.25
  done
  echo "The macOS TTS host did not become ready. See $tts_log_file" >&2
  return 1
}

stop_tts() {
  if ! tts_running; then rm -f "$tts_pid_file"; return 0; fi
  local pid
  pid="$(cat "$tts_pid_file")"
  kill "$pid" 2>/dev/null || true
  for _ in {1..20}; do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
  if kill -0 "$pid" 2>/dev/null; then kill -KILL "$pid" 2>/dev/null || true; fi
  rm -f "$tts_pid_file"
}

show_status() {
  echo "Containers:"
  if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then echo "  Docker daemon is stopped."
  elif find_compose >/dev/null 2>&1 && [[ -f "$env_file" ]]; then compose ps || true
  else echo "  Docker Compose or runtime configuration is not available."
  fi
  echo
  if tts_running; then echo "macOS TTS: running (PID $(cat "$tts_pid_file"))"
  else echo "macOS TTS: stopped"
  fi
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
  if [[ "$provider" == codex ]]; then compose run --rm --entrypoint codex agent login
  else compose run --rm --entrypoint claude agent
  fi
}

case "${1:-}" in
  start) start_all ;;
  restart) kill_all; start_all ;;
  kill|stop) kill_all ;;
  status) ensure_runtime; show_status ;;
  login) login_provider "${2:-}" ;;
  *) usage; exit 2 ;;
esac
