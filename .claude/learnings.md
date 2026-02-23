# Tone - Project Learnings

## Architecture
- **Two-repo model**: Public code repo (GitHub, MIT) + private vault repo (local git on Pi). Fundamental separation — never mix personal data with public code.
- **Vault path**: `/mnt/data/tone-vault/` on Pi. Configurable via `VAULT_PATH` env var.
- **Code path**: `/mnt/data/tone/` on Pi (public repo clone).
- **Entry point**: `src/index.ts` — Telegraf bot, cron schedules, pipeline wiring.

## LLM Tiering (OpenRouter)
- **Tier 1** — Gemini Flash 2.0: Intent routing, filing classification, cheap/fast tasks
- **Tier 2** — Claude Sonnet 4.5: User-facing interactions, briefings, drafts, chat
- **Tier 3** — Claude Opus: Self-improvement, weekly analysis, code generation, nightly review

## Vault Structure
- `skills/` — Markdown skill definitions (read by loader.ts, used as LLM context)
- `config/` — personality.md, reward-signals.md, boundaries.md, about-user.md
- `feedback/` — corrections.md, autonomic.md, patterns.md, evolution.md
- `feedback/interactions/` — JSONL logs per day (YYYY-MM-DD.jsonl)
- `feedback/daily/` — Nightly review markdown per day
- `feedback/weekly/` — Weekly review markdown per week
- `tasks/` — active.md, completed.md, someday.md
- `threads/` — Topic-based note threads
- Immutable skills: reflect.md, adapt.md (user controls, Tone cannot modify)

## Feedback Loops
- **Loop 1 (Heartbeat)**: Immediate corrections → `correction:` git commits
- **Loop 2 (Circadian)**: Nightly 23:00 → analyse day → autonomic adjustments → `nightly:` git commit
- **Loop 3 (Adaptation)**: Friday 15:00 → propose changes on branch → user approves → `adapt:` merge commit

## Modification Boundaries
- **Immutable**: Approval mechanism, access permissions, feedback loop architecture, reward signal definitions, boundary definitions, skills marked IMMUTABLE
- **Evolvable** (needs approval): System prompt, skill definitions, briefing format, task logic, proactivity level
- **Autonomic** (no approval): Briefing timing/ordering, response verbosity, confidence thresholds, thread ranking

## Git Conventions (Vault Repo)
- Commit prefixes: `correction:`, `nightly:`, `adapt:`
- Auto-tags: `week-NN` (before Friday review), `base-vX.Y.Z` (version applied), `nightly-YYYY-MM-DD` (optional)
- Manual tags: `snapshot/<name>` (user-requested via Telegram)
- Rollbacks are always new commits — never rewrite history

## Key Dependencies
- `telegraf` — Telegram bot framework
- `simple-git` — Programmatic git operations on vault repo
- `node-cron` — Scheduling for briefings, nightly, weekly loops
- `@deepgram/sdk` — Voice transcription (default provider)
- Voxtral Mini (3B) — Future self-hosted transcription via Mistral (Apache 2.0, needs Beelink/GPU hardware)
- `dotenv` — Environment variable loading

## Tech Decisions
- TypeScript with strict mode (user preference, plan doc showed .js but converted to .ts)
- ES2022 target, NodeNext module resolution
- JSONL for interaction logs (structured, aggregatable), markdown for human-readable outputs
- evolution.ts in EPIC-4 (not EPIC-5) because both nightly and weekly loops depend on git ops
- Transcription is pluggable: TranscriptionProvider interface with Deepgram (cloud, Pi 4) and Voxtral Mini (self-hosted, Beelink) implementations. Provider selected via `TRANSCRIPTION_PROVIDER` env var.

## Calendar Integration (EPIC-8)
- Calendar reuses Gmail BYO OAuth — same Google Cloud project, `CALENDAR_SCOPES` added to auth flow when `CALENDAR_ENABLED=true`
- Auth scope injection is in `gmail/auth.ts:buildOAuthScopes()` — dynamically adds calendar.readonly scope
- Calendar client at `src/integrations/calendar/client.ts` — mirrors gmail client pattern (retry/backoff, typed errors, response normalization)
- Calendar skill at `src/skills/calendar.ts` — three actions: `today` (day agenda), `week` (multi-day preview grouped by date), `meeting_prep` (event detail with attendees/description)
- Calendar is read-only in v0.4.x — no event creation/modification
- `CALENDAR_SYNC_WINDOW_DAYS` controls how far ahead the week preview looks (1-30, default 7)

## Implementation Progress
- EPIC-1 / TONE-001 scaffold created:
  - `package.json` scripts: `build`, `dev`, `start`, `typecheck`
  - TypeScript config uses strict mode, `ES2022`, `NodeNext`, output to `dist/`
  - `.env.example` seeded with required vars (`TELEGRAM_BOT_TOKEN`, `OPENROUTER_API_KEY`, `DEEPGRAM_API_KEY`, `VAULT_PATH`, `TONE_TIMEZONE`)
  - `.gitignore` now excludes `node_modules/`, `.env`, `vault/`, `dist/`, `*.log`
- Dependencies installed and validated:
  - dev deps: `typescript`, `tsx`, `@types/node`
  - runtime dep: `dotenv`
  - `npm run typecheck` passes on initial scaffold
- EPIC-1 / TONE-002 vault template seeded:
  - Created full `vault-template/` directory tree with `.gitkeep` placeholders for empty folders
  - Added task seed files: `tasks/active.md`, `tasks/completed.md`, `tasks/someday.md`
  - Added six skill seed files with required sections (`Trigger Patterns`, `Input Format`, `Output Format`, `Examples`, `Constraints`)
  - Marked `skills/reflect.md` and `skills/adapt.md` as IMMUTABLE in content and constraints
  - Added `config/about-user.md`, `config/personality.md`, `config/reward-signals.md`, `config/boundaries.md`
  - Added feedback seed logs: `corrections.md`, `autonomic.md`, `patterns.md`, `evolution.md` with append-only placeholders
- EPIC-1 / TONE-003 scripts implemented:
  - `scripts/setup.sh`: checks prerequisites and required env vars, runs `npm install`, then initializes vault if missing
  - `scripts/init-vault.sh`: copies `vault-template/`, initializes git, creates initial commit, tags `base-v0.1.0`
  - `scripts/service.sh`: systemd lifecycle commands (`install`, `start`, `stop`, `restart`, `status`)
  - Safety/idempotency:
    - init script exits cleanly if vault already initialized
    - init script refuses overwrite of non-empty existing path
    - service install rewrites same unit deterministically and re-runs `daemon-reload`
  - Syntax validation completed: `bash -n` passes for all three scripts
- EPIC-1 / TONE-004 types + config completed:
  - `src/types.ts` now defines core interfaces: `Interaction`, `SkillDefinition`, `FeedbackEvent`, `VaultConfig`, `LLMTier`, `RouterResult`
  - `Interaction` explicitly models text/voice input plus intent, skill, response, and feedback signal
  - `FeedbackEvent` includes explicit corrections, thumbs up/down, and implicit signals (`engagement_timing`, `draft_acceptance`)
  - `src/config.ts` loads `.env` via `dotenv`, validates required vars, validates timezone, normalizes vault path, and exports typed `config`
  - Added typed default LLM tier configuration and OpenRouter metadata defaults for downstream services
  - LLM tier model names aligned to backlog naming (`gemini-2.0-flash`, `claude-sonnet-4-5`, `claude-opus-4`)
  - Post-change type safety check passes: `npm run typecheck`
- Validation checkpoints:
  - `npm run build` passes (TypeScript emits successfully to `dist/`)
  - `src/index.ts` kept empty for TONE-001 acceptance; compile still passes
  - Script executables verified for all three shell scripts
  - Required `.env.example` keys confirmed present
  - Required `vault-template` files from TONE-002 confirmed present
  - `scripts/init-vault.sh` functional checks:
    - fresh path initializes vault, creates initial commit + `base-v0.1.0` tag
    - rerun on initialized vault exits cleanly (idempotent)
    - non-empty existing path is rejected (overwrite safety)
  - `scripts/setup.sh` functional checks:
    - runs `npm install`, validates env vars, skips init when vault already initialized
    - rejects non-initialized existing `VAULT_PATH` with explicit error
- EPIC-2 in progress:
  - Backlog now defines transcription as pluggable provider architecture (Deepgram + Voxtral), selected by `TRANSCRIPTION_PROVIDER`
  - Added env/config surface for transcription provider selection (`TRANSCRIPTION_PROVIDER`, `VOXTRAL_ENDPOINT`, `VOXTRAL_API_KEY`, model names)
  - Added dependency plan for EPIC-2 services:
    - `telegraf` for bot wiring and callback reactions
    - `yaml` for vault frontmatter parsing
  - Implemented initial service files:
    - `src/llm.ts` with tiered OpenRouter routing, headers, usage parsing, typed errors, retry/backoff, and stream variant
    - `src/transcriber.ts` with `TranscriptionProvider` interface, Deepgram provider, Voxtral provider, and `createTranscriber()` factory
    - `src/vault.ts` with path-safety checks, CRUD, full-text search, frontmatter parsing, and wiki-link resolution
    - `src/utils/telegram.ts` with `formatBriefing`, `formatTaskList`, `sendWithReactions`, and `downloadVoice`
    - `src/index.ts` now wires Telegraf handlers for `/start`, text, voice, callbacks, and centralized error handling
- EPIC-2 implementation details confirmed:
  - LLM client (`src/llm.ts`):
    - exports `complete`, `chat`, and `streamChat`
    - sends OpenRouter-required headers (`HTTP-Referer`, `X-Title`)
    - includes exponential backoff for retryable statuses (`429`, `503`, `504`)
    - normalizes token usage from API responses and returns it with completions
    - returns typed error objects (`network_error`, `rate_limited`, `api_error`, `invalid_response`)
  - Transcription service (`src/transcriber.ts`):
    - `TranscriptionProvider` interface and `createTranscriber()` factory implemented
    - provider-select via `TRANSCRIPTION_PROVIDER` (`deepgram` default, `voxtral` optional)
    - `TranscriptionResult` shape: `text`, `confidence`, `provider`, `durationMs`
    - Deepgram and Voxtral providers both handle empty audio with non-error empty result
  - Vault service (`src/vault.ts`):
    - exports `readNote`, `writeNote`, `appendNote`, `listNotes`, `searchNotes`, `resolveWikiLink`
    - enforces vault-root path boundary to prevent traversal
    - parses/writes YAML frontmatter in markdown notes
  - Telegram utilities and bot wiring:
    - reactions encoded as callback payloads (`feedback:up/down:<interactionId>`)
    - callback handler emits typed `FeedbackEvent` objects (currently logged)
    - `/start`, text, voice handlers and centralized bot error trap added
- EPIC-2 validation:
  - Added runtime deps: `telegraf`, `yaml`
  - `npm run typecheck` passes after strictness fixes (`exactOptionalPropertyTypes`)
  - `npm run build` passes
  - `scripts/setup.sh` provider-mode smoke tests pass:
    - `TRANSCRIPTION_PROVIDER=voxtral` works with `VOXTRAL_ENDPOINT` and without `DEEPGRAM_API_KEY`
    - `TRANSCRIPTION_PROVIDER=deepgram` works with `DEEPGRAM_API_KEY`
  - Post-smoke normalization re-run completed: `npm install`, `npm run typecheck`, `npm run build` all pass
