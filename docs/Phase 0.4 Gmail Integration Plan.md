# Tone Phase 0.4.x Plan (Gmail + Calendar Integration)

## Current Baseline

Reviewed context from:

- `/Users/jackpickard/Documents/repos/tone/.claude/learnings.md`
- `/Users/jackpickard/Documents/repos/tone/src/index.ts`
- `/Users/jackpickard/Documents/repos/tone/src/router.ts`
- `/Users/jackpickard/Documents/repos/tone/src/skills/draft.ts`
- `/Users/jackpickard/Documents/repos/tone/src/config.ts`
- `/Users/jackpickard/Documents/repos/tone/docs/backlog.json`

Working assumption: `v0.3.0` capability baseline is in place (weekly adaptation + approval flow implemented). The current implementation runway is EPIC-7 (email deterministic triage + quick actions), and this update widens `v0.4.x` scope to include Google Calendar context for day/week planning.

## Phase Goal

Add Gmail and Google Calendar as first-class Tone capabilities for inbox triage, draft/send control, and calendar-aware planning, while preserving:

1. Two-repo boundary (public code vs private vault data)
2. Explicit user approval on high-risk actions
3. Full observability via interaction logs and evolution loops

## Connection Model (Option 1 Only)

Use BYO OAuth only.

- Each user creates their own Google OAuth app in their own Google Cloud project.
- Tone never depends on a shared, platform-wide OAuth app managed by this repo.
- User-specific credentials are configured locally during onboarding.
- Tokens are stored locally on the user machine (outside git-tracked repo content).
- Gmail and Calendar scopes are requested only when those features are enabled.

## Non-Goals (v0.4.x)

- No autonomous email send without explicit confirmation
- No mailbox rule management
- No attachment parsing/indexing
- No automatic calendar event creation/deletion in first release (read-first planning)
- No multi-account support in first release
- No Slack API integration yet (still planned for `v0.5.0`)

## Definition Of Done (v0.4.x)

1. User can connect one Gmail account securely.
2. User can connect Google Calendar securely (same BYO OAuth project, optional enable).
3. Tone can fetch inbox messages and summarize actionable items.
4. Tone can fetch upcoming events and produce day/week planning views.
5. Tone can generate reply drafts grounded in thread context.
6. Tone can send email only after explicit Telegram confirmation.
7. Briefings include email + calendar context and clear next actions.
8. Failures (auth expiry, quota, network) degrade gracefully with clear user messaging.

## Product Scope

### Core User Flows

1. `Connect Google surfaces`  
User links Gmail and (optionally) Calendar once and can verify connection state for each.

2. `Inbox triage`  
User asks for inbox summary (priority messages, waiting-on-me items, quick actions).

3. `Day and week planning`  
User asks "plan my day" or "plan my week"; Tone returns a schedule-aware plan using tasks + email urgency + meetings.

4. `Meeting prep`  
User asks "prep my next meeting"; Tone summarizes attendees, agenda window, and relevant threads/tasks.

5. `Send with confirmation`  
Tone asks for explicit confirm/cancel in Telegram before sending.

6. `Daily briefing integration`  
Morning briefing includes email priorities and upcoming events with conflict/load hints.

### Triage And Planning Strategy (Simple v1)

Deterministic triage labels:

- `needs_reply`
- `waiting_on_them`
- `fyi`
- `no_reply_needed`

Priority score (for `needs_reply`) combines explicit signals:

- sender importance
- direct question detection
- deadline/date-language detection
- thread age
- unread count

Calendar planning signals:

- meeting density by time block
- time-to-next-meeting
- conflict windows between tasks and meetings
- high-load days (too many meetings, low focus time)
- prep-needed meetings (external, high-stakes, or first-time attendee combinations)

Daily cadence:

- morning: top 5 `needs_reply` + key meetings + top planning risks
- midday: unresolved high-priority reminder + remaining meeting prep
- evening: carry-over recap for email/tasks and tomorrow's first commitments

Quick actions in Telegram:

- `draft`
- `send` (confirmation required)
- `snooze 4h`
- `remind tomorrow`
- `mark no-reply`
- `done`
- `plan today`
- `prep next meeting`

Reinforcement sources:

- explicit: thumbs up/down on triage and planning suggestions
- implicit: send-after-reminder, repeated snooze, ignored urgent thread, missed prep window, plan-followed vs plan-abandoned

## Technical Design

### New Modules

- `src/integrations/gmail/auth.ts`
  - OAuth token lifecycle, refresh handling, connection status
- `src/integrations/gmail/client.ts`
  - Gmail API wrapper (list/get/modify/send)
- `src/integrations/gmail/sync.ts`
  - Pull selected message metadata/content and write vault snapshots
- `src/integrations/gmail/triage.ts`
  - Deterministic label and scoring logic
- `src/integrations/gmail/types.ts`
  - Gmail domain models normalized for Tone
- `src/integrations/calendar/client.ts`
  - Google Calendar API wrapper (list events, event details, free/busy windows)
- `src/integrations/calendar/sync.ts`
  - Pull upcoming event snapshots and write planning context to vault
- `src/integrations/calendar/planner.ts`
  - Day/week planning synthesis from events + tasks + email urgency
- `src/integrations/calendar/types.ts`
  - Calendar domain models normalized for Tone

### Existing Modules To Extend

- `src/types.ts`
  - Add email + calendar intents, entities, and feedback signals
- `src/router.ts`
  - Recognize intents (`inbox`, `email_draft`, `email_send`, `plan_day`, `plan_week`, `meeting_prep`)
- `src/skills/index.ts`
  - Register `email` and `calendar` skill handlers
- `src/skills/email.ts`
  - Execute inbox summary, drafting, quick actions, and send confirmation handoff
- `src/skills/calendar.ts` (new)
  - Execute day/week planning and meeting prep generation
- `src/index.ts`
  - Handle callback actions for send confirm/cancel and planning quick actions
- `src/loops/briefing.ts`
  - Include Gmail + Calendar sections in briefing synthesis
- `src/feedback.ts`
  - Log email and planning outcomes (`draft_accepted`, `send_confirmed`, `plan_followed`, `prep_missed`)
- `src/config.ts`, `.env.example`, `src/onboard.ts`
  - Add Calendar env/config surface and onboarding prompts

### Vault Additions (Private Repo)

- `email/threads/` (message snapshots used for context)
- `email/drafts/` (generated drafts + decision metadata)
- `calendar/events/` (upcoming event snapshots for grounding)
- `calendar/plans/` (day/week planning artifacts + decisions)
- `feedback/interactions/` (existing JSONL files gain email + planning action events)

## Safety Model

1. Least-privilege OAuth scopes only for required features.
2. Never store Gmail/Calendar secrets in public repo.
3. Token storage stays outside git-tracked project files.
4. BYO OAuth only: no central shared credentials.
5. Default mode is read + draft; email send remains confirmation-gated.
6. Calendar starts read-only in first release.
7. Every send/planning action records actor, timestamp, source interaction, and status.

## Proposed Tickets

| ID | Priority | Ticket | Dependencies |
|---|---|---|---|
| TONE-040 | P0 | BYO OAuth onboarding + config surface | none |
| TONE-041 | P0 | Gmail auth/token lifecycle service (local storage only) | TONE-040 |
| TONE-042 | P0 | Gmail API client (list/get/draft/send + error mapping) | TONE-041 |
| TONE-043 | P0 | Email skill (`inbox triage` + `draft`) + router wiring | TONE-042 |
| TONE-044 | P0 | Send confirmation callbacks for email replies | TONE-043 |
| TONE-045 | P0 | Vault sync + briefing email section | TONE-042, TONE-043 |
| TONE-046 | P1 | Deterministic triage labels and scoring | TONE-043 |
| TONE-047 | P1 | Reminder cadence + quick actions | TONE-046 |
| TONE-048 | P1 | Reinforcement instrumentation for triage outcomes | TONE-046, TONE-047 |
| TONE-049 | P1 | Weekly adaptation tuning for triage weights/thresholds | TONE-048 |
| TONE-050 | P1 | Hardening + runbook + `v0.4.0` Gmail release checklist | all P0 |
| TONE-051 | P0 | Calendar onboarding and OAuth scope extension | TONE-040 |
| TONE-052 | P0 | Google Calendar API client (events/free-busy + error mapping) | TONE-051 |
| TONE-053 | P0 | Calendar skill + router intents (`plan_day`, `plan_week`, `meeting_prep`) | TONE-052, TONE-043 |
| TONE-054 | P1 | Briefing synthesis across email + calendar + tasks | TONE-047, TONE-053 |
| TONE-055 | P1 | Planning reinforcement and weekly tuning hooks | TONE-048, TONE-054 |

## Acceptance Criteria (P0 Core)

### TONE-040: BYO OAuth Onboarding

- `.env.example` and onboarding prompts include per-user Gmail OAuth fields.
- Documentation states each user creates their own Google OAuth app.
- Tone runs normally with Gmail disabled.

### TONE-041: Gmail Auth/Token Service

- OAuth flow can be initiated/completed on headless Pi workflow.
- Token refresh handled automatically.
- Tokens stored locally outside git-tracked repo files.
- Clear statuses: connected, disconnected, expired, invalid.

### TONE-042: Gmail Client

- Can list inbox messages with pagination.
- Can fetch thread/message content needed for context.
- Can send message replies with thread linkage.
- Maps API failures to typed, user-safe errors.

### TONE-043: Email Skill

- Router resolves email requests to `email` skill reliably.
- Skill supports inbox triage summary, draft generation, and next actions.
- Draft output includes message reference for send confirmation.

### TONE-044: Send Confirmation

- Sending requires explicit confirm callback from Telegram.
- Cancel path leaves draft intact and logs cancellation.
- Duplicate callback events are idempotent.

### TONE-045: Vault Sync + Briefing

- Stores minimal email context for LLM grounding.
- Persists draft artifacts and decision history.
- File paths remain within vault boundary checks.
- Briefing includes an email section with top `needs_reply`, `waiting_on_them`, and stale reminders.

### TONE-051: Calendar Onboarding

- `.env.example` and onboarding support optional Calendar enablement (`CALENDAR_ENABLED`) and scope setup.
- Reuses per-user BYO OAuth project model (no shared OAuth app).
- Tone runs normally with Calendar disabled.

### TONE-052: Calendar Client

- Can list upcoming events in configurable windows (today/this week).
- Can fetch event metadata needed for planning and prep.
- Supports free/busy window queries for focus-time planning.
- Maps API failures to typed, user-safe errors.

### TONE-053: Calendar Skill + Planning

- Router resolves planning requests (`plan my day`, `plan my week`, `prep next meeting`) to `calendar` skill.
- Skill synthesizes tasks + urgent email triage + meetings into a structured plan.
- Meeting prep output links relevant tasks and email threads where available.
- Graceful fallback when Calendar is unavailable.

## Rollout Plan (4 Weeks)

1. Week 1:
   - TONE-040, TONE-041, TONE-042
   - Smoke test BYO auth + inbox fetch in isolation
2. Week 2:
   - TONE-043, TONE-044, TONE-045
   - End-to-end: inbox -> draft -> confirm send -> log
3. Week 3:
   - TONE-046 to TONE-050 (complete EPIC-7 deterministic triage + quick actions)
   - Validate reminder cadence and reinforcement telemetry
4. Week 4:
   - TONE-051 to TONE-055 (calendar context + planning synthesis)
   - Validate day/week planning quality, docs, and `v0.4.x` release notes

## Test Strategy

1. Unit tests for auth state handling and API error mapping (Gmail + Calendar).
2. Unit tests for deterministic triage scoring and planning heuristics.
3. Integration tests with Gmail/Calendar mocked responses.
4. End-to-end dry run in Telegram callback loop with fixture emails, events, and tasks.
5. Regression test for existing `capture/task/draft/chat/rollback/introspection` flows.

## Observability

Track at least:

- `gmail.auth.connected` / `gmail.auth.refresh_failed`
- `gmail.inbox.fetch.success` / `gmail.inbox.fetch.error`
- `gmail.draft.generated`
- `gmail.send.confirmed` / `gmail.send.canceled` / `gmail.send.failed`
- `calendar.auth.connected` / `calendar.auth.refresh_failed`
- `calendar.events.fetch.success` / `calendar.events.fetch.error`
- `calendar.plan.day.generated` / `calendar.plan.week.generated`
- `calendar.meeting.prep.generated`

Persist key outcomes into existing feedback JSONL for nightly/weekly loops.

## Release Gates

Ship `v0.4.x` when all pass:

1. Gmail and Calendar connect + reconnect flows work on Raspberry Pi target.
2. At least 20 real inbox interactions processed with no data-loss bugs.
3. Send confirmation cannot be bypassed.
4. Day/week planning produces stable outputs from real calendar data.
5. Nightly and weekly loops continue to run with Gmail + Calendar enabled.
6. Rollback of integration-related skill/config changes verified.
7. Version metadata aligned (`package.json`, changelog, git tag/release notes).

## Immediate Next Steps

1. Implement EPIC-7 first: `TONE-046` and `TONE-047` (deterministic triage + quick actions).
2. Add `TONE-048` and `TONE-049` instrumentation before hardening (`TONE-050`).
3. Scaffold `src/integrations/calendar/` and `src/skills/calendar.ts` for EPIC-8.
4. Extend `src/types.ts` + `src/router.ts` for planning intents.
5. Add Calendar env/onboarding placeholders and start with read-only upcoming-events flow.
