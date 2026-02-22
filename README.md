# Tone

Tone is an adaptive personal AI agent for Telegram + Obsidian vault workflows.
It runs locally (for example on a Raspberry Pi), logs interactions, and evolves behavior through feedback loops with git-backed rollback and introspection.

## Current Capabilities

- Text and voice interactions through Telegram
- Intent routing and skill execution (`capture`, `task`, `draft`, `chat`)
- Interaction + feedback logging to vault JSONL/Markdown
- Proactive loops:
  - Morning briefing
  - Nightly circadian review with autonomic adjustments
  - Weekly adaptation proposal + approve/reject flow
- Evolution tooling:
  - Typed vault git commits (`correction:`, `nightly:`, `adapt:`)
  - Tags, branches, diff, rollback, snapshot support
  - "What's changed since X?" introspection summary
  - Weekly narrative evolution log updates

## Repository Model

- Public code repo: this repository
- Private vault repo: your local vault path (set by `VAULT_PATH`), initialized as a separate git repository

Keep personal data in the vault repo only.

## Requirements

- Node.js 20+
- `npm`
- `git`
- Linux host (Raspberry Pi supported)
- Telegram bot token
- OpenRouter API key
- Either Deepgram or Voxtral transcription provider

## Environment

Copy `.env.example` to `.env` and set required values:

- Required:
  - `TELEGRAM_BOT_TOKEN`
  - `TELEGRAM_DEFAULT_CHAT_ID` (needed for proactive loops to send messages)
  - `OPENROUTER_API_KEY`
  - `VAULT_PATH`
  - `TONE_TIMEZONE`
- Transcription:
  - `TRANSCRIPTION_PROVIDER=deepgram` and `DEEPGRAM_API_KEY`
  - or `TRANSCRIPTION_PROVIDER=voxtral` and `VOXTRAL_ENDPOINT`
- Loop scheduling defaults:
  - `BRIEFING_CRON=30 7 * * *`
  - `NIGHTLY_CRON=0 23 * * *`
  - `WEEKLY_CRON=0 15 * * 5`
  - `DEFAULT_RESPONSE_VERBOSITY=balanced`

## Quickstart (Install + Start)

To make the `tone` command available globally, install Tone from this repository and then run `tone start`:

```bash
cd /path/to/tone
npm install
npm run build
npm install --global .
tone start
```

If you update Tone later, rebuild and reinstall globally:

```bash
cd /path/to/tone
git pull
npm install
npm run build
npm install --global .
```

## Raspberry Pi Deploy (Fresh)

```bash
sudo apt update
sudo apt install -y git curl build-essential
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

```bash
mkdir -p /mnt/data
cd /mnt/data
git clone <YOUR_REPO_URL> tone
cd /mnt/data/tone
cp .env.example .env
# edit .env
./scripts/setup.sh
npm run build
./scripts/service.sh install
./scripts/service.sh start
./scripts/service.sh status
```

## Update Existing Pi Install

```bash
cd /mnt/data/tone
git pull
npm install
npm run build
./scripts/service.sh restart
./scripts/service.sh status
```

## Startup Troubleshooting

If the app fails during startup with a missing environment variable error, update `.env` with the required keys and restart:

- `OPENROUTER_API_KEY` (OpenRouter key)
- `TELEGRAM_BOT_TOKEN` (Telegram bot token)
- `DEEPGRAM_API_KEY` (when `TRANSCRIPTION_PROVIDER=deepgram`)
- `VOXTRAL_ENDPOINT` (when `TRANSCRIPTION_PROVIDER=voxtral`)

Also set `TELEGRAM_DEFAULT_CHAT_ID` if you want scheduled briefings/nightly/weekly messages to be delivered automatically.

## Operational Smoke Checks

After startup in Telegram, test:

- `/start`
- `save this state as preflight`
- `what's changed since week 01`
- `go back to week 01` and use confirm/cancel buttons

Then verify vault git activity:

```bash
cd /mnt/data/tone-vault
git log --oneline --decorate -n 30
git tag -l | tail -n 20
```

## GitHub Releases

Yes, you can and should use GitHub Releases.

Recommended flow:

1. Tag a version in this repo (for example `v0.2.0`).
2. Create a GitHub Release from that tag with release notes.
3. On Pi, deploy by tag instead of branch head:

```bash
cd /mnt/data/tone
git fetch --tags
git checkout v0.2.0
npm install
npm run build
./scripts/service.sh restart
```

This gives you reproducible deployments and easier rollback (`git checkout <older-tag>`).

## Scripts

- `scripts/setup.sh`
  - Installs dependencies, validates env, initializes vault if needed
- `scripts/init-vault.sh`
  - Creates vault from template and initializes vault git repo
- `scripts/service.sh`
  - Installs and manages systemd service (`install|start|stop|restart|status`)
