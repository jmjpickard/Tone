# Tone — Technical Implementation Plan v4

> *"The vagus nerve of your life. Sense, regulate, adapt."*

---

## What Tone Is

Tone is an adaptive personal AI agent that runs on a Raspberry Pi. It acts as a cognitive extension — capturing thoughts, managing tasks, drafting messages, and keeping life organised. It learns how to help through interaction, not prescription. It evolves over time, and you can navigate its full evolutionary history.

Named after vagal tone — the measure of how well your autonomic nervous system self-regulates. Tone's job isn't to speed you up, it's to keep everything in balance.

**Public repo:** `github.com/[username]/tone` — build in public
**License:** MIT

---

## The Core Philosophy

### AlphaGo, Not Expert Systems

Don't encode every strategy. Define the rules of the game, provide a reward signal, and let the system discover optimal behaviours through interaction. Seed skills are the first random games — starting points that Tone evolves away from.

### Autonomic Nervous System

Two operating layers, like the body:
- **Autonomic:** filing, pattern-tracking, briefings, vault maintenance — happens without being asked
- **Voluntary:** explicit commands — capture, task, draft, chat

The vagus nerve (Tone) mediates between them. Feedback flows in both directions.

### Evolutionary Versioning

Tone's skills, personality, and config are its DNA. Git is the fossil record. Every mutation is a commit. Every state is recoverable. Every Tone instance diverges from the base version as it adapts to its owner — like species adapting to different environments.

Two people running Tone for six months will have completely different skill configurations. But they can always compare against the base, roll back to any previous state, or share interesting mutations with the community.

Evolution with an undo button. That's what makes it safe to let Tone experiment freely.

See `docs/evolution.md` for the full concept.

---

## Reward Signals

### Implicit (observed without input)
- Briefing engagement timing and depth
- Task completion speed or abandonment
- Whether filed notes get moved or revisited
- Draft acceptance rate (sent as-is, edited, ignored)
- Interaction frequency trends

### Explicit (direct feedback)
- Thumbs up / thumbs down on Telegram messages
- Verbal corrections and guidance
- Direction during Friday reviews

Personality starts neutral and evolves. Defined in `config/reward-signals.md` — editable by user, read by Tone during reviews.

---

## The Three Feedback Loops

### Loop 1 — Immediate (Heartbeat)
In-conversation corrections. Applied instantly, committed to git, logged to prevent repetition.

### Loop 2 — Daily (Circadian)
Nightly review at 23:00. Evaluates outcomes, updates patterns, makes autonomic adjustments. Each review is a git commit with a clear message.

### Loop 3 — Weekly (Adaptation)
Friday 15:00. Tone analyses the week, proposes behavioural changes on a git branch, sends summary via Telegram. Jack approves or rejects. Approved changes merge. Rejected changes are logged with reasoning. The pre-review state is tagged automatically (e.g. `week-08`).

---

## Modification Boundaries

### Immutable — user controls, Tone cannot touch
- The approval mechanism
- Access permissions and privacy constraints
- The feedback loop architecture
- The reward signals definition
- These boundary definitions
- Skills marked IMMUTABLE (reflect.md, adapt.md)

### Evolvable — Tone proposes Friday, user approves via git merge
- System prompt / personality
- Skill definitions + new skills
- Briefing format, task logic, filing heuristics
- Proactivity level, model routing

### Autonomic — Tone adjusts, committed to git, no approval needed
- Briefing timing and ordering
- Response verbosity
- Confidence thresholds
- Thread activity ranking

---

## Git Architecture

Two separate repositories. This separation is fundamental.

### Repo 1: Public Code (`github.com/[username]/tone`)

The base genome. Tone's source code, seed skills, documentation, vault template. Anyone can clone this and run their own instance.

Updated by Jack when new features or improved seeds are ready. Tagged with semver releases. Community can contribute.

### Repo 2: Private Vault (`/mnt/data/tone-vault/.git`)

The evolved organism. One per user, lives only on their machine. Contains personal data, evolved skills, feedback history, and the full evolutionary record.

Tone commits to this repo as it evolves. Each commit has a clear type and message:

```
# Loop 1 — Heartbeat commits
correction: IoT topics filed to home-automation, not clinical-ops

# Loop 2 — Circadian commits  
nightly: daily review 2026-02-21 | 12 interactions | briefing shifted to 08:45

# Loop 3 — Adaptation commits
adapt: week 8 approved — briefing at 09:00, talking points for close colleagues
```

### Tags — Named Evolutionary States

Automatic tags:
- `week-NN` — before each Friday review
- `base-vX.Y.Z` — when a base version update is applied
- `nightly-YYYY-MM-DD` — optional, for granular rollback

Manual tags (via Telegram):
- "Tone, save this state as 'good-at-briefings'" → creates tag `snapshot/good-at-briefings`
- "Tone, bookmark this before I experiment" → creates tag `snapshot/pre-experiment`

### Rollback Flows

**Via Telegram (natural language):**
- "Tone, go back to how you were in week 6" → reverts skills/config to `week-06` tag
- "Tone, your briefings were better last month, revert just that" → reverts only `skills/briefing.md`
- "Tone, what's changed about you since week 4?" → shows diff in plain English
- "Tone, undo last Friday's changes" → reverts the most recent adaptation commit

**Via git (direct):**
```bash
git diff week-04..HEAD -- skills/ config/          # What evolved
git checkout week-06 -- skills/briefing.md          # Surgical rollback
git log --oneline -- config/personality.md          # Personality history
```

Rollbacks are always new commits — history is never rewritten. The full evolutionary record is always preserved.

### Sharing Mutations

If your Tone evolves a good skill, extract and share it:
```bash
git diff base-v0.1.0..HEAD -- skills/recurring-tasks.md
```
Other users drop the skill into their vault. Their feedback loops adapt it further. Beneficial mutations propagate through the community.

### Base Updates Without Losing Evolution

When a new Tone version is released:
1. Pull code updates to the public repo (normal git pull)
2. For vault-template changes, Tone compares against your evolved vault:
   - Files you haven't modified → update automatically
   - Files you HAVE evolved → show diff, you decide: keep yours, take new, or merge

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    INTERFACES                            │
│  Telegram Bot (voice + text)  │  Web Dashboard (later)  │
└──────────────────┬──────────────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────────────┐
│                  TONE CORE (Node.js on Pi)               │
│                                                          │
│  Router → Transcriber → Skills → Task Engine             │
│                                                          │
│  ┌─────────────────────────────────────────────────────┐ │
│  │  FEEDBACK ENGINE                                     │ │
│  │  Logger → Outcome Tracker → Loops 1/2/3 → Git       │ │
│  └─────────────────────────────────────────────────────┘ │
│                                                          │
│  ┌─────────────────────────────────────────────────────┐ │
│  │  ADAPTIVE SKILL SYSTEM                               │ │
│  │  Skills = markdown in vault, git-versioned            │ │
│  │  Seed skills → evolve → branch → approve → merge     │ │
│  └─────────────────────────────────────────────────────┘ │
└──────────────────┬──────────────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────────────┐
│  KNOWLEDGE LAYER — Obsidian Vault (private git repo)     │
│  /mnt/data/tone-vault/                                   │
│                                                          │
│  📁 _inbox/    📁 threads/    📁 tasks/    📁 projects/  │
│  📁 people/    📁 daily/      📁 skills/   📁 config/    │
│  📁 feedback/                                            │
│    📁 interactions/   📁 daily/   📁 weekly/             │
│    📄 corrections.md  📄 autonomic.md  📄 patterns.md    │
│    📄 evolution.md    ← narrative history of changes     │
└──────────────────┬──────────────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────────────┐
│  LLM LAYER (OpenRouter)                                  │
│  Tier 1: Gemini Flash 2.0  │  Tier 2: Claude Sonnet 4.5 │
│  Tier 3: Claude Opus (self-improvement, code gen)        │
└─────────────────────────────────────────────────────────┘
```

---

## Public Repo Structure

```
tone/                              # github.com/[username]/tone
├── README.md
├── LICENSE                        # MIT
├── CHANGELOG.md
├── package.json
├── .env.example
├── .gitignore
│
├── src/
│   ├── index.js                   # Entry point: bot, cron
│   ├── router.js                  # Intent classification + confidence
│   ├── transcriber.js             # Voice → text (Deepgram)
│   ├── llm.js                     # OpenRouter client, tier routing
│   ├── vault.js                   # Obsidian CRUD, wiki-links
│   ├── feedback.js                # Interaction logging + outcome tracking
│   ├── evolution.js               # Git operations: commit, tag, branch,
│   │                              #   rollback, diff, merge
│   ├── skills/
│   │   ├── loader.js              # Reads skill defs from vault
│   │   ├── capture.js             # Seed: thought capture
│   │   ├── task.js                # Seed: task management
│   │   ├── draft.js               # Seed: message drafting
│   │   └── chat.js                # Fallback: conversation
│   ├── loops/
│   │   ├── briefing.js            # Morning briefing
│   │   ├── nightly.js             # Loop 2: daily review + git commit
│   │   └── weekly.js              # Loop 3: Friday review + git branch
│   └── utils/
│       └── telegram.js            # Formatting, reactions, voice
│
├── vault-template/                # Base genome — ships with repo
│   ├── _inbox/
│   ├── threads/
│   ├── tasks/
│   │   ├── active.md
│   │   ├── completed.md
│   │   └── someday.md
│   ├── projects/
│   ├── people/
│   ├── daily/
│   ├── feedback/
│   │   ├── interactions/
│   │   ├── daily/
│   │   ├── weekly/
│   │   ├── corrections.md
│   │   ├── autonomic.md
│   │   ├── patterns.md
│   │   └── evolution.md
│   ├── skills/
│   │   ├── capture.md
│   │   ├── task.md
│   │   ├── draft.md
│   │   ├── briefing.md
│   │   ├── reflect.md             # IMMUTABLE
│   │   └── adapt.md               # IMMUTABLE
│   └── config/
│       ├── about-user.md          # Template
│       ├── personality.md         # Neutral start
│       ├── reward-signals.md
│       └── boundaries.md
│
├── scripts/
│   ├── setup.sh                   # First-run: deps, vault init, git init
│   ├── init-vault.sh              # Copy template, init private git repo
│   └── service.sh                 # systemd install/management
│
└── docs/
    ├── philosophy.md              # AlphaGo + autonomic nervous system
    ├── architecture.md            # Technical deep-dive
    ├── evolution.md               # Git versioning, rollback, divergence
    ├── feedback-loops.md          # The three loops
    ├── skills.md                  # Writing and evolving skills
    ├── deployment.md              # Pi setup, hardware
    └── configuration.md           # Config reference
```

### .gitignore
```
node_modules/
.env
vault/
*.log
```

---

## Build Plan

### Session 1: Foundation (~2 hours)

**Goal:** Bot on Pi, responds via LLM, repo live on GitHub.

1. Create public GitHub repo `tone`
2. Clone to Pi at `/mnt/data/tone/`
3. `npm init`, install: `telegraf`, `node-cron`, `dotenv`
4. Create `.env.example`, `.gitignore`, `README.md`
5. Build `vault-template/` with full folder structure
6. Write `scripts/init-vault.sh` — copies template to `/mnt/data/tone-vault/`, inits private git repo with initial commit tagged `base-v0.1.0`
7. Run init script, seed vault with personal threads and config
8. Create Telegram bot via BotFather
9. Build `src/index.js` — Telegram bot
10. Build `src/llm.js` — OpenRouter client with tier routing
11. Wire: message → LLM → response
12. Build `src/evolution.js` — git commit, tag, log helpers for vault repo
13. First commit + push to GitHub

**Milestone:** Text Tone on Telegram, get a response. Public repo is live. Vault has its first git commit.

### Session 2: Voice + Vault + Logging (~2 hours)

**Goal:** Voice notes transcribed, thoughts captured, interactions logged, corrections committed.

1. Build `src/transcriber.js` — Deepgram integration
2. Build `src/vault.js` — markdown CRUD, wiki-links
3. Build `src/router.js` — intent classification + confidence
4. Build `src/feedback.js` — interaction event logging
5. Build `src/skills/loader.js` — reads skill markdown from vault
6. Build `src/skills/capture.js` — seed implementation
7. Wire Telegram reactions (thumbs up/down) as feedback
8. Wire Loop 1: corrections auto-committed to vault repo

**Milestone:** Voice note → transcribed → filed in vault → interaction logged → correction committed to git.

### Session 3: Tasks + Briefing + Draft (~2 hours)

**Goal:** Full interaction loop, morning briefing.

1. Build `src/skills/task.js`, `draft.js`, `chat.js`
2. Build `src/loops/briefing.js`
3. Set up cron: briefing at 07:30
4. Test all four interaction types end-to-end
5. Push to GitHub, tag: **v0.1.0**

**Milestone:** Tone handles capture, task, draft, chat. Briefing arrives. Everything logged. First release.

### Session 4: Feedback Loops + Evolution (~2 hours)

**Goal:** Nightly review commits, weekly review branches, rollback works.

1. Build `src/loops/nightly.js` — outcome tracking, reflection, autonomic adjustments, git commit
2. Build `src/loops/weekly.js` — pattern analysis, proposals on git branch, Telegram summary
3. Implement auto-tagging: `week-NN` before each Friday review
4. Implement rollback via Telegram: "go back to week N" / "revert briefing skill"
5. Implement "what's changed" query: diff in plain English
6. Build evolution log writer — appends to `feedback/evolution.md`
7. Test full cycle: interact → log → nightly commit → weekly branch → approve → merge → tag
8. Push to GitHub, tag: **v0.2.0**

**Milestone:** After a day of use, Tone writes its first reflection and commits it. After a week, it proposes changes on a branch. You can ask "what's changed about you?" and get a meaningful answer.

---

## Future Phases

| Version | Phase | Target |
|---------|-------|--------|
| 0.1.0 | Telegram + voice + capture + tasks + briefing | Weekend 1 |
| 0.2.0 | Feedback loops + evolutionary versioning | Weekend 1-2 |
| 0.3.0 | Weekly adaptation producing real proposals | Week 3 |
| 0.4.0 | Gmail integration | Month 1-2 |
| 0.5.0 | Slack integration | Month 1-2 |
| 0.6.0 | GitHub integration + code execution | Month 2-3 |
| 0.7.0 | Web dashboard | Month 3 |
| 0.8.0 | IoT / home automation | Month 3+ |
| 1.0.0 | Stable, battle-tested | Month 4+ |

---

## Hardware

**Current:** Raspberry Pi 4 (4GB), 1TB SSD, Ethernet.
**Future:** Beelink mini PC (32GB) for local inference. Pi stays as IoT controller.

## Monthly Costs

| Item | Cost |
|------|------|
| OpenRouter | £5-15 |
| Deepgram | £2-5 |
| Pi electricity | ~£1 |
| **Total** | **~£8-21/month** |

---

## Decisions Log

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Name | Tone | Vagal tone metaphor |
| Personality | Neutral, evolves via feedback | AlphaGo principle |
| Interface | Telegram (V1) | Voice native, fast to build |
| Obsidian mobile | Not initially | Reassess later |
| Feedback style | Explicit (thumbs + verbal) | Jack willing to train actively |
| Weekly review | Friday 15:00 | Reflective wind-down |
| Repo | Public GitHub, MIT | Build in public, portfolio piece |
| Vault | Private, separate git repo | Personal data stays local |
| Versioning | Git on vault, tagged states | Evolution with an undo button |

## Initial Threads

| Thread | Area |
|--------|------|
| home-automation | IoT, Pi, sensors, smart home |
| tone-development | Building Tone itself |
| hertility-engineering | Work: eng leadership |
| rosalind-agent | Work: Slack coding agent |
| clinical-ops-agent | Side business idea |
| career-direction | DeepMind, AI + cardiac biology |
| personal-admin | Expenses, emails, life tasks |
