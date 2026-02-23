# Tone Phase 0.3 Kickoff Plan (Real Weekly Adaptation)

## Context

From the current docs:

- `v0.1.0`: Telegram, voice, capture/tasks/draft/chat, briefing
- `v0.2.0`: feedback loops, evolution workflow, rollback/introspection
- Next target in `docs/Tone Implementation Plan.md`: `v0.3.0` = weekly adaptation producing real proposals

Current weekly flow already creates a summary proposal and approval decision.  
Phase `0.3` should turn that into concrete, safe, file-level behavior changes that are testable before merge.

## Phase Goal

Make weekly adaptation produce actionable, reviewable mutations to `vault/skills/*` and `vault/config/personality.md` with guardrails and measurable quality checks.

## Definition Of Done (Phase 0.3)

1. Weekly review produces concrete edits on an adaptation branch, not only narrative suggestions.
2. Every proposed change includes evidence and an estimated impact.
3. Immutable boundaries are enforced automatically before proposal creation.
4. Approval flow supports selective acceptance (not only all-or-nothing).
5. A replay/regression check runs before merge; failing proposals cannot merge.
6. Weekly artifacts are fully auditable in `vault/feedback/weekly/`.

## Proposed Tickets

| ID | Priority | Ticket | Dependencies |
|---|---|---|---|
| TONE-020 | P0 | Adaptation change generator (`skills/`, `personality.md`) | existing weekly loop |
| TONE-021 | P0 | Boundary enforcement validator (immutable/evolvable/autonomic) | TONE-020 |
| TONE-022 | P0 | Proposal artifact bundle (diff + rationale + evidence JSON) | TONE-020 |
| TONE-023 | P0 | Selective approval flow via Telegram buttons/callbacks | TONE-022 |
| TONE-024 | P0 | Replay evaluation gate using last 7-14 days interactions | TONE-020 |
| TONE-025 | P1 | Branch lifecycle hardening (resume/retry/idempotency) | TONE-023 |
| TONE-026 | P1 | Adaptation quality metrics and weekly scorecard | TONE-024 |
| TONE-027 | P1 | Docs and operator runbook for weekly adaptation | TONE-023, TONE-024 |

## Ticket Details (P0)

### TONE-020 — Adaptation Change Generator

Build a generator that transforms weekly insights into concrete file edits:

- Input: weekly metrics, daily excerpts, corrections, current skills/config
- Output: structured change set
  - target file
  - patch content
  - reason
  - expected outcome
- Scope limited to:
  - `vault/skills/*.md`
  - `vault/config/personality.md`

Acceptance criteria:

- At least one valid patch candidate produced when enough evidence exists
- No change generated for low-confidence insights
- Proposals remain explainable in plain language

### TONE-021 — Boundary Validator

Add validator that blocks any mutation outside allowed files/categories.

Acceptance criteria:

- Rejects edits touching immutable files/rules
- Validates changed files against `config/boundaries.md`
- Logs blocked proposals with reason in weekly artifact

### TONE-022 — Proposal Artifact Bundle

For each weekly proposal, write:

- `feedback/weekly/YYYY-WNN.md` (human summary)
- `feedback/weekly/YYYY-WNN.changes.json` (machine-readable plan)
- `feedback/weekly/YYYY-WNN.diff.patch` (exact proposed edits)

Acceptance criteria:

- Artifacts are generated deterministically for the same input set
- Markdown links each change to evidence from interaction/feedback logs
- Branch contains only proposal-related files and intended edits

### TONE-023 — Selective Approval Flow

Replace binary approval with per-change selection.

Acceptance criteria:

- Telegram flow supports:
  - approve all
  - approve selected change IDs
  - reject all
- Merge only applies approved changes
- Rejected items are preserved in log for future reconsideration

### TONE-024 — Replay Evaluation Gate

Before merge, run a replay check across recent interactions to estimate improvement/regression.

Acceptance criteria:

- Produces a scorecard:
  - routing confidence delta
  - thumbs up/down trend estimate
  - verbosity fit estimate
- Merge blocked when regression threshold exceeded
- Scorecard persisted with weekly artifacts

## Execution Plan (First 10 Working Days)

1. Day 1-2: Implement `TONE-020` skeleton with structured change objects and file patch writer.
2. Day 3: Implement `TONE-021` validator and hard fail behavior for disallowed mutations.
3. Day 4: Implement `TONE-022` artifacts and wire into current weekly generation.
4. Day 5-6: Implement `TONE-023` selective approval callbacks and merge logic.
5. Day 7-8: Implement `TONE-024` replay evaluator with merge gate.
6. Day 9: End-to-end dry run on sample vault data for one simulated week.
7. Day 10: Stabilize, document (`TONE-027` partial), cut `v0.3.0-rc1`.

## Immediate Start Checklist

1. Create branch: `codex/phase-0-3-kickoff`.
2. Add module scaffold:
   - `src/adaptation/generator.ts`
   - `src/adaptation/validator.ts`
   - `src/adaptation/evaluator.ts`
   - `src/adaptation/types.ts`
3. Refactor `src/loops/weekly.ts` to call adaptation modules.
4. Add one fixture dataset under `src/adaptation/__fixtures__/week-sample/`.
5. Add `npm` script for replay check (`adapt:replay`) and document usage.

## Risks To Manage Early

- Overfitting to one week of sparse data
- Unsafe broad edits to personality/skills
- Noisy signal quality from low feedback volume
- Branch drift if pending weekly proposal is left unresolved

## Release Gate For `v0.3.0`

Ship when all are true:

- Two consecutive weekly dry runs generate valid artifacts
- At least one selective-approval merge succeeds without manual git repair
- Replay gate blocks an intentionally bad proposal in testing
- Rollback from one approved adaptation is verified end-to-end
