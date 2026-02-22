#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$REPO_ROOT/.env"
TEMPLATE_DIR="$REPO_ROOT/vault-template"
BASE_TAG="base-v0.1.0"

log() {
  printf '[init-vault] %s\n' "$*"
}

error() {
  printf '[init-vault] ERROR: %s\n' "$*" >&2
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    error "Missing required command: $1"
    exit 1
  fi
}

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

if [[ -z "${VAULT_PATH:-}" ]]; then
  error "VAULT_PATH is not set. Define it in $ENV_FILE or export it before running."
  exit 1
fi

if [[ ! -d "$TEMPLATE_DIR" ]]; then
  error "Vault template not found: $TEMPLATE_DIR"
  exit 1
fi

require_cmd cp
require_cmd git
require_cmd mkdir

if [[ -d "$VAULT_PATH/.git" ]]; then
  log "Vault already initialized at $VAULT_PATH; nothing to do"
  exit 0
fi

if [[ -e "$VAULT_PATH" ]]; then
  if [[ -d "$VAULT_PATH" && -z "$(ls -A "$VAULT_PATH")" ]]; then
    log "Using existing empty directory at $VAULT_PATH"
  else
    error "Refusing to overwrite existing path: $VAULT_PATH"
    error "Choose a new VAULT_PATH or move/remove the existing directory."
    exit 1
  fi
else
  mkdir -p "$VAULT_PATH"
fi

log "Copying vault template into $VAULT_PATH"
cp -R "$TEMPLATE_DIR"/. "$VAULT_PATH"/

log "Initializing git repository"
(
  cd "$VAULT_PATH"
  git init >/dev/null

  if ! git config --get user.name >/dev/null 2>&1; then
    git config user.name tone-agent
  fi

  if ! git config --get user.email >/dev/null 2>&1; then
    git config user.email tone@local
  fi

  if ! git rev-parse --verify HEAD >/dev/null 2>&1; then
    git add .
    git commit -m "chore: initialize vault from template" >/dev/null
    log "Created initial commit"
  else
    log "Initial commit already exists"
  fi

  if ! git tag -l "$BASE_TAG" | grep -q "$BASE_TAG"; then
    git tag "$BASE_TAG"
    log "Created tag $BASE_TAG"
  else
    log "Tag $BASE_TAG already exists"
  fi
)

log "Vault initialization complete"
