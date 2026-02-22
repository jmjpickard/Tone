#!/usr/bin/env bash
set -euo pipefail

TONE_HOME="${TONE_HOME:-$HOME/.tone}"
TONE_APP_PATH="${TONE_APP_PATH:-$TONE_HOME/app}"
TONE_REPO_URL="${TONE_REPO_URL:-https://github.com/jmjpickard/Tone.git}"
TONE_BRANCH="${TONE_BRANCH:-main}"

log() {
  printf '[install] %s\n' "$*"
}

error() {
  printf '[install] ERROR: %s\n' "$*" >&2
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    error "Missing required command: $1"
    exit 1
  fi
}

require_cmd git
require_cmd node
require_cmd npm

NODE_MAJOR="$(node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || echo 0)"
if [[ "$NODE_MAJOR" -lt 20 ]]; then
  error "Node.js 20+ is required. Current version: $(node -v)"
  exit 1
fi

mkdir -p "$TONE_HOME"

if [[ -d "$TONE_APP_PATH/.git" ]]; then
  log "Updating existing Tone checkout at $TONE_APP_PATH"
  (
    cd "$TONE_APP_PATH"
    git fetch origin "$TONE_BRANCH"
    git checkout "$TONE_BRANCH"
    git pull --ff-only origin "$TONE_BRANCH"
  )
elif [[ -e "$TONE_APP_PATH" ]]; then
  error "Path exists and is not a Tone git checkout: $TONE_APP_PATH"
  exit 1
else
  log "Cloning Tone into $TONE_APP_PATH"
  git clone --branch "$TONE_BRANCH" --depth 1 "$TONE_REPO_URL" "$TONE_APP_PATH"
fi

log "Installing dependencies"
(
  cd "$TONE_APP_PATH"
  npm install
)

log "Building Tone"
(
  cd "$TONE_APP_PATH"
  npm run build
)

if [[ -f "$TONE_APP_PATH/dist/cli.js" ]]; then
  chmod +x "$TONE_APP_PATH/dist/cli.js"
fi

log "Installing Tone CLI globally"
if ! (
  cd "$TONE_APP_PATH"
  npm install --global .
); then
  error "Global npm install failed."
  error "Configure your npm global prefix or rerun with elevated privileges if required."
  exit 1
fi

GLOBAL_NODE_MODULES="$(npm root --global)"
if [[ -f "$GLOBAL_NODE_MODULES/tone/dist/cli.js" ]]; then
  chmod +x "$GLOBAL_NODE_MODULES/tone/dist/cli.js"
fi

log "Tone CLI installed."
log "Next steps:"
log "  1) tone onboard"
log "  2) tone start"
log "  3) tone status"
