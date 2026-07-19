#!/usr/bin/env bash
# termchat client installer — the `curl … | sh` entry point.
#
#   curl -fsSL https://termchat.sh/install.sh | sh
#
# POSIX-ish shell with no app logic (it runs BEFORE Bun exists). Everything
# substantive happens in the TypeScript CLI (apps/cli). Re-runnable + idempotent:
# a second run updates the checkout and re-wires the hooks.
set -euo pipefail

log() { printf '  %s\n' "$*"; }

REPO_URL="${TERMCHAT_REPO_URL:-https://github.com/OviatoHQ/termchat-client.git}"
SRC="${TERMCHAT_SRC:-$HOME/.termchat/src}"
# The released client talks to production by default; override for staging/dev.
EDGE="${TERMCHAT_EDGE:-https://termchat.sh}"

# 1. Ensure Bun (the client ships no Node and never falls back to it).
if ! command -v bun >/dev/null 2>&1; then
  log "Installing Bun…"
  curl -fsSL https://bun.sh/install | bash
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"
fi

# 2. Fetch (or update) the client source. A piped `curl | sh` has no checkout,
#    so we clone it ourselves into a stable location.
if [ -d "$SRC/.git" ]; then
  log "Updating termchat client…"
  git -C "$SRC" pull --ff-only --quiet
else
  log "Cloning termchat client…"
  mkdir -p "$(dirname "$SRC")"
  git clone --depth 1 "$REPO_URL" "$SRC"
fi
cd "$SRC"

# 3. Install deps and wire the agent hooks + status line, pointed at prod.
log "Installing dependencies…"
bun install
log "Wiring Claude Code hooks + status line (edge: $EDGE)…"
bun apps/cli/src/cli.ts install --statusline --edge "$EDGE"

log "Done — open a Claude Code session and the status line shows who's online."
