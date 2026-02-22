# Tone - Planning Scratchpad

## What is Tone?
Adaptive personal AI agent on Raspberry Pi. Telegram interface (voice + text). Obsidian vault as knowledge layer. Three feedback loops (immediate corrections, nightly review, weekly adaptation). Git-versioned skills that evolve per user.

## Key Architectural Decisions
- Two repos: public code (GitHub, MIT) + private vault (local git, personal data)
- Skills = markdown definitions in vault + TypeScript implementations in code
- LLM tiering via OpenRouter: Gemini Flash (routing/filing), Claude Sonnet (interactions), Claude Opus (self-improvement)
- Deepgram for voice transcription
- Interaction logs as JSONL (structured for aggregation), reviews/evolution as markdown (human-readable)
- evolution.ts wraps simple-git for vault repo operations - critical dependency for all feedback loops

## Backlog Status
- `docs/backlog.json` created with 5 epics, 19 tickets
- Total estimate: ~39.5hrs
- Dependency graph validated — no circular deps, all refs consistent

## Epic Breakdown
1. **Foundation** (4 tickets, ~5.5hrs): Project init, vault template, scripts, types/config
2. **Core Services** (4 tickets, ~7.5hrs): LLM client, transcriber, vault CRUD, Telegram bot
3. **Interaction Pipeline** (4 tickets, ~10hrs): Router, skill loader + capture, task/draft/chat skills, feedback logger + wiring
4. **Proactive Loops** (4 tickets, ~10hrs): Briefing, nightly review, evolution git module, weekly adaptation
5. **Rollback & Introspection** (3 tickets, ~6.5hrs): Loop 1 corrections, rollback commands, introspection + evolution log

## Dependency Insights
- evolution.ts (TONE-015) must exist before any loop can commit — pulled into EPIC-4
- TONE-012 (feedback + wiring) is the integration ticket for the whole pipeline — depends on all services
- TONE-016 (weekly loop) is the largest ticket (~3hrs) due to approval flow complexity
- index.ts is touched by multiple tickets (TONE-008, TONE-012) — careful about merge conflicts

## Implementation Order (9 phases)
```
Phase 1: TONE-001, TONE-002 (parallel, no deps)
Phase 2: TONE-003 (needs 001+002), TONE-004 (needs 001)
Phase 3: TONE-005, TONE-006, TONE-007, TONE-008, TONE-015 (all need 004, parallel)
Phase 4: TONE-010 (needs 005+007)
Phase 5: TONE-009 (needs 005+010), TONE-011 (needs 010)
Phase 6: TONE-012 (needs 006+008+009+011) — integration ticket
Phase 7: TONE-013, TONE-014, TONE-017, TONE-018 (need 012 and/or 015)
Phase 8: TONE-016 (needs 014+015)
Phase 9: TONE-019 (needs 015+016)
```

## Open Questions
- TypeScript or JavaScript? Plan doc shows .js, user prefers TypeScript — going with .ts
- Testing strategy? No tests in plan. Should add as we go.
- Where does this run initially? Pi is target but dev likely happens locally first.
