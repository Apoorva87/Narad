#!/usr/bin/env bash
# Install the narad-prepare skill for Codex and Claude Code, pointing at this checkout.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/install-skills.sh [--codex] [--claude] [--uninstall]
  With no tool flag, installs for both Codex and Claude Code.
  Codex:  ${CODEX_HOME:-~/.codex}/skills/narad-prepare/SKILL.md
  Claude: ${CLAUDE_CONFIG_DIR:-~/.claude}/skills/narad-prepare/SKILL.md
  Re-run after moving the Narad folder; the skill records this checkout's path.
EOF
}

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
codex=0 claude=0 uninstall=0
for arg in "$@"; do
  case "$arg" in
    --codex) codex=1 ;;
    --claude) claude=1 ;;
    --uninstall) uninstall=1 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 1 ;;
  esac
done
if [[ $codex -eq 0 && $claude -eq 0 ]]; then codex=1 claude=1; fi

install_one() { # <tool> <template> <skills dir>
  local target="$3/narad-prepare"
  if [[ $uninstall -eq 1 ]]; then
    rm -rf "$target" && echo "Removed $1 skill: $target"
    return
  fi
  mkdir -p "$target"
  # Escape characters that are special in a sed replacement.
  local escaped
  escaped=$(printf '%s' "$repo" | sed 's/[&|\\]/\\&/g')
  sed "s|{{NARAD_DIR}}|$escaped|g" "$2" >"$target/SKILL.md.tmp"
  mv "$target/SKILL.md.tmp" "$target/SKILL.md"
  echo "Installed $1 skill: $target/SKILL.md"
}

[[ $codex -eq 1 ]] && install_one Codex "$repo/skills/narad-prepare/codex/SKILL.md" "${CODEX_HOME:-$HOME/.codex}/skills"
[[ $claude -eq 1 ]] && install_one "Claude Code" "$repo/skills/narad-prepare/claude/SKILL.md" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills"
if [[ $uninstall -eq 0 ]]; then
  echo "Restart Codex / Claude Code sessions to pick up the skill. Ask for example: \"make a Narad lesson from <link>\"."
fi
