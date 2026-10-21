#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$project_dir"

port="${NARAD_PORT:-4318}"

if [[ "$(uname -s)" != Darwin ]]; then
  echo "start_tailscale.sh is intended for macOS, where the Tailscale app and Narad's local speech worker run." >&2
  exit 1
fi

if ! command -v tailscale >/dev/null 2>&1; then
  echo "Tailscale CLI not found. Install and open the Tailscale app, then retry." >&2
  exit 1
fi

if ! open -a Tailscale >/dev/null 2>&1; then
  echo "Could not open the Tailscale app. Install Tailscale and sign in, then retry." >&2
  exit 1
fi

echo "Connecting this Mac to Tailscale..."
tailscale up

dns_name=""
for _ in {1..20}; do
  if status_json="$(tailscale status --json 2>/dev/null)"; then
    dns_name="$(printf '%s' "$status_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).Self?.DNSName||"")}catch{}})')"
    dns_name="${dns_name%.}"
    [[ -n "$dns_name" ]] && break
  fi
  sleep 1
done

if [[ -z "$dns_name" ]]; then
  echo "Tailscale did not report this Mac's tailnet DNS name. Finish signing in to Tailscale, then retry." >&2
  exit 1
fi

web_origin="https://$dns_name"

# Initialize generated secrets and the compose env file without displaying them.
./start.sh status >/dev/null
env_file="$project_dir/.narad/compose.env"
if [[ ! -f "$env_file" ]]; then
  echo "Narad runtime configuration was not created at $env_file." >&2
  exit 1
fi
tmp_env="$(mktemp "$project_dir/.narad/compose.env.XXXXXX")"
trap 'rm -f "$tmp_env"' EXIT
awk -v origin="$web_origin" '
  /^NARAD_WEB_ORIGIN=/ {
    if (!written) print "NARAD_WEB_ORIGIN=" origin
    written=1
    next
  }
  { print }
  END { if (!written) print "NARAD_WEB_ORIGIN=" origin }
' "$env_file" > "$tmp_env"
chmod 600 "$tmp_env"
mv "$tmp_env" "$env_file"
trap - EXIT

echo "Starting Narad services..."
./start.sh start

echo "Waiting for Narad API on port $port..."
ready=0
for _ in {1..60}; do
  if curl --max-time 2 -fsS "http://127.0.0.1:$port/api/health" >/dev/null; then
    ready=1
    break
  fi
  sleep 1
done
if [[ "$ready" != 1 ]]; then
  echo "Narad API did not become healthy. Check ./start.sh status and the service logs." >&2
  exit 1
fi

echo "Configuring private Tailscale Serve..."
tailscale serve --bg "$port"
echo
echo "Narad is available to your tailnet at: $web_origin"
echo "Serve status:"
tailscale serve status
