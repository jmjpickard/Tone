# Tone - Planning Scratchpad

## Current Work: Finish EPIC-7, Start EPIC-8

### Status Assessment

**EPIC-7 (Email Triage & Reinforcement):**
- TONE-046 ✅ Deterministic triage + scoring — complete
- TONE-047 ✅ Reminder cadence + quick actions — complete
- TONE-048 ✅ Reinforcement instrumentation — complete
- TONE-049 ✅ Weekly adaptation tuning — complete
- TONE-050 ⏭️ Hardening/release — deferred (docs/runbook)

**EPIC-8 (Google Calendar):**
- TONE-051 ✅ Calendar onboarding + config — complete (CalendarConfig, onboard prompts, 'calendar' intent)
- TONE-052 ✅ Calendar API client — complete (listUpcomingEvents, getEventDetails, getFreeBusy)
- TONE-053 ✅ Calendar skill + routing — complete (today/week/meeting_prep actions, router heuristics)
- TONE-054 ❌ Briefing synthesis — not started (integrate calendar into morning briefing)
- TONE-055 ❌ Planning feedback — not started

### Implementation Plan

#### Phase A: TONE-047 — Midday/Evening Reminders + Quick Actions

**Files to modify:**
- `src/loops/briefing.ts` — add `scheduleMidday()` and `scheduleEvening()` cron jobs
- `src/skills/email.ts` — add snooze_4h, remind_tomorrow, mark_no_reply, done quick actions
- `src/index.ts` — wire midday/evening crons, add email quick action callback handlers
- `src/integrations/gmail/sync.ts` — update triage thread state for snooze/done

**Approach:**
- Midday cron (12:30): surfaces unresolved high-priority items from latest triage snapshot
- Evening cron (20:00): lists carry-over items for next day
- Quick actions via inline keyboard on triage items
- Snooze updates `snoozedUntil` in triage state map
- Done/no-reply updates `status` in triage state map

#### Phase B: TONE-048 — Reinforcement Instrumentation

**Files to modify:**
- `src/types.ts` — add triage outcome feedback event types
- `src/feedback.ts` — add `logTriageOutcome()` function
- `src/loops/nightly.ts` — aggregate email-specific metrics in nightly review

**New FeedbackEventTypes:**
- `email_triage_accepted` — user acted on triage suggestion
- `email_snooze` — user snoozed an item
- `email_marked_done` — user marked item done
- `email_marked_no_reply` — user marked no-reply
- `email_ignored_urgent` — high-priority item went unacted for >24h

#### Phase C: TONE-049 — Weekly Triage Tuning

**Files to modify:**
- `src/loops/weekly.ts` — add triage scorecard section, propose bounded weight changes
- `src/integrations/gmail/triage.ts` — expose weight range constants for weekly loop

**Approach:**
- Weekly review reads email action JSONL for the week
- Calculates: accuracy rate, false-positive rate, snooze frequency
- Proposes ±10% weight changes within predefined bounds
- Changes go through existing approval flow

#### Phase D: TONE-051 — Calendar Onboarding

**Files to modify:**
- `.env.example` — add CALENDAR_ENABLED, CALENDAR_SCOPES, CALENDAR_SYNC_WINDOW_DAYS
- `src/config.ts` — add CalendarConfig type, buildCalendarConfig(), validate
- `src/onboard.ts` — add calendar prompts after Gmail section
- `src/types.ts` — add 'calendar' to InteractionIntent

#### Phase E: TONE-052 — Calendar API Client

**New files:**
- `src/integrations/calendar/types.ts` — CalendarEvent, FreeBusyWindow, CalendarError types
- `src/integrations/calendar/client.ts` — listUpcomingEvents, getEventDetails, getFreeBusy

**Approach:**
- Reuse Gmail's BYO OAuth tokens (same Google project, add calendar scope)
- Use googleapis or raw REST calls
- Typed error mapping matching Gmail pattern
- Retry/backoff for 429/5xx

#### Phase F: TONE-053 — Calendar Skill + Routing

**New files:**
- `src/skills/calendar.ts` — today agenda, week preview, meeting prep

**Files to modify:**
- `src/router.ts` — add calendar/planning heuristics
- `src/skills/index.ts` — register calendar skill
- `src/types.ts` — add 'calendar' intent

### Key Design Decisions

1. **Calendar reuses Gmail OAuth** — same Google Cloud project, just add calendar scope. No separate token flow.
2. **Midday/evening reminders** — lightweight crons that read existing triage snapshot, no new Gmail API calls.
3. **Quick actions** — inline keyboard buttons on triage messages, callbacks in index.ts.
4. **Weekly triage tuning** — bounded ±10% weight changes, never outside predefined min/max ranges already in triage.ts.
5. **Calendar is read-only** — no event creation/deletion in v0.4.x.
