#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SERVICE_NAME="tone"
UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}.service"
ENV_FILE="$REPO_ROOT/.env"

log() {
  printf '[service] %s\n' "$*"
}

error() {
  printf '[service] ERROR: %s\n' "$*" >&2
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    error "Missing required command: $1"
    exit 1
  fi
}

usage() {
  cat <<USAGE
Usage: scripts/service.sh <install|start|stop|restart|status>

Commands:
  install  Install or update the systemd service unit and enable it
  start    Start the Tone service
  stop     Stop the Tone service
  restart  Restart the Tone service
  status   Show service status
USAGE
}

install_service() {
  require_cmd systemctl
  require_cmd sudo

  if [[ ! -f "$ENV_FILE" ]]; then
    error "Expected env file at $ENV_FILE"
    exit 1
  fi

  log "Installing systemd unit at $UNIT_PATH"
  sudo tee "$UNIT_PATH" >/dev/null <<UNIT
[Unit]
Description=Tone personal AI agent
After=network.target

[Service]
Type=simple
WorkingDirectory=$REPO_ROOT
ExecStart=/usr/bin/env npm run start
Restart=always
RestartSec=5
EnvironmentFile=$ENV_FILE
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
UNIT

  sudo systemctl daemon-reload
  sudo systemctl enable "$SERVICE_NAME" >/dev/null
  log "Service installed and enabled"
}

run_systemctl() {
  require_cmd systemctl
  require_cmd sudo
  sudo systemctl "$1" "$SERVICE_NAME"
}

main() {
  if [[ $# -ne 1 ]]; then
    usage
    exit 1
  fi

  case "$1" in
    install)
      install_service
      ;;
    start)
      run_systemctl start
      ;;
    stop)
      run_systemctl stop
      ;;
    restart)
      run_systemctl restart
      ;;
    status)
      run_systemctl status
      ;;
    *)
      usage
      exit 1
      ;;
  esac
}

main "$@"
