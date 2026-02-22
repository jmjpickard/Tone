#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$REPO_ROOT/.env"

log() {
  printf '[setup] %s\n' "$*"
}

error() {
  printf '[setup] ERROR: %s\n' "$*" >&2
}

print_env_guidance() {
  cat >&2 <<'GUIDE'
[setup] Please add the missing keys to your .env file before starting Tone.
[setup] Example required values:
[setup]   TELEGRAM_BOT_TOKEN=<telegram bot token>
[setup]   OPENROUTER_API_KEY=<openrouter api key>
[setup]   VAULT_PATH=/absolute/path/to/your/vault
[setup]   TONE_TIMEZONE=Europe/London
[setup]   TRANSCRIPTION_PROVIDER=none
[setup]   # Optional voice notes:
[setup]   # TRANSCRIPTION_PROVIDER=deepgram
[setup]   # DEEPGRAM_API_KEY=<deepgram api key>
[setup]   # or TRANSCRIPTION_PROVIDER=voxtral
[setup]   # VOXTRAL_ENDPOINT=<voxtral endpoint url>
[setup] Optional but recommended for proactive loops:
[setup]   TELEGRAM_DEFAULT_CHAT_ID=<telegram chat id>
GUIDE
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
else
  log "No .env file found at $ENV_FILE. Using process environment variables only."
fi

require_cmd npm
require_cmd git
require_cmd cp

required_vars=(
  TELEGRAM_BOT_TOKEN
  OPENROUTER_API_KEY
  VAULT_PATH
  TONE_TIMEZONE
)

missing_vars=()
for var_name in "${required_vars[@]}"; do
  if [[ -z "${!var_name:-}" ]]; then
    missing_vars+=("$var_name")
  fi
done

transcription_provider="${TRANSCRIPTION_PROVIDER:-none}"
case "$transcription_provider" in
  none)
    ;;
  deepgram)
    if [[ -z "${DEEPGRAM_API_KEY:-}" ]]; then
      missing_vars+=("DEEPGRAM_API_KEY")
    fi
    ;;
  voxtral)
    if [[ -z "${VOXTRAL_ENDPOINT:-}" ]]; then
      missing_vars+=("VOXTRAL_ENDPOINT")
    fi
    ;;
  *)
    error "Invalid TRANSCRIPTION_PROVIDER: $transcription_provider (expected 'none', 'deepgram', or 'voxtral')"
    exit 1
    ;;
esac

if (( ${#missing_vars[@]} > 0 )); then
  error "Missing required environment variables: ${missing_vars[*]}"
  error "Set them in $ENV_FILE or export them before running setup."
  print_env_guidance
  exit 1
fi

if [[ -z "${TELEGRAM_DEFAULT_CHAT_ID:-}" ]]; then
  log "TELEGRAM_DEFAULT_CHAT_ID is not set; proactive loops cannot send scheduled messages until it is configured."
fi

log "Installing Node.js dependencies"
(
  cd "$REPO_ROOT"
  npm install
)

if [[ -d "$VAULT_PATH/.git" ]]; then
  log "Vault already initialized at $VAULT_PATH; skipping init-vault"
elif [[ -e "$VAULT_PATH" ]]; then
  error "VAULT_PATH exists but is not an initialized vault: $VAULT_PATH"
  error "Refusing to continue; run scripts/init-vault.sh manually after checking this path."
  exit 1
else
  log "Initializing vault at $VAULT_PATH"
  "$SCRIPT_DIR/init-vault.sh"
fi

log "Setup complete"
