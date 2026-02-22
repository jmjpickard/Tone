# Evolution — How Tone Grows and How You Stay in Control

> *"Evolution isn't a straight line — it's a branching tree with dead ends. Git gives you the map."*

## The Core Idea

Tone is a self-improving system. Through feedback loops, it modifies its own skills, personality, filing heuristics, and behaviours over time. Every Tone instance diverges from the base version as it adapts to its owner.

This is powerful, but it's only safe if every change is trackable, reviewable, and reversible. Git provides that safety net. Tone's vault is a git repository, and every mutation Tone makes to itself is a commit. You have the full evolutionary history — every change, when it happened, why it happened — and the ability to revert to any previous state.

Think of it biologically: Tone's skills, personality, and config files are its DNA. When Tone evolves, it's mutating its own DNA. Git is the fossil record.

## What Gets Versioned

Everything in the vault that defines Tone's behaviour:

```
vault/
├── skills/          # How Tone handles different types of requests
├── config/
│   ├── personality.md      # How Tone communicates
│   ├── reward-signals.md   # What "good" looks like
│   └── boundaries.md       # What Tone can and can't modify
├── feedback/
│   ├── patterns.md         # Accumulated behavioural model
│   ├── corrections.md      # Learned mistakes
│   └── autonomic.md        # Silent adjustment history
```

Your personal content (threads, tasks, notes, people) is also in the vault and versioned, but the evolutionary story is primarily about the files above — the ones that define *how Tone behaves* rather than *what Tone knows about you*.

## Commit Types

Tone makes three types of commits, corresponding to the three feedback loops:

### Heartbeat Commits (Loop 1 — Immediate)

When you correct Tone mid-conversation, the correction gets logged to `feedback/corrections.md`. These are small, frequent commits.

```
commit a3f7e2b
Author: tone-agent
Date:   Fri Feb 21 14:32:00 2026

    correction: IoT topics filed to home-automation, not clinical-ops
    
    User corrected filing of smart plug note. Updated correction log
    with new heuristic: IoT/smart home keywords → threads/home-automation.md
```

### Circadian Commits (Loop 2 — Nightly)

The nightly review produces a daily reflection and may make autonomic adjustments. Each nightly review is a single commit bundling all changes from that cycle.

```
commit 8d1f4ca
Author: tone-agent
Date:   Fri Feb 21 23:15:00 2026

    nightly: daily review for 2026-02-21
    
    Interactions: 12 | Positive signals: 7 | Negative: 2
    
    Autonomic adjustments:
    - Briefing time shifted from 07:30 → 08:45 (engagement pattern)
    - Reduced briefing verbosity (calendar section consistently skipped)
    
    New patterns noted in patterns.md:
    - Drafts for close colleagues ignored 40% of time
```

### Adaptation Commits (Loop 3 — Weekly)

Friday reviews produce proposed changes on a git branch. When approved, they merge as a commit with full context.

```
commit e92c1a7
Author: tone-agent
Date:   Fri Feb 21 15:30:00 2026

    adapt: week 8 approved changes
    
    Proposals approved:
    - [x] Shift briefing to 09:00 (formalise autonomic finding)
    - [x] Use talking points instead of full drafts for close colleagues
    - [ ] REJECTED: Add deadline prompt for all new tasks
    
    Evidence: 7 days of data, 84 interactions, patterns detailed
    in feedback/weekly/2026-w08.md
    
    Approved by user at 15:28 via Telegram
```

## Navigating Tone's Evolution

### Tags — Named Evolutionary States

At meaningful moments, the vault gets tagged. These are bookmarks in Tone's evolutionary history that you can return to by name.

Tags are created automatically at:
- Each weekly review (e.g. `week-08`, `week-09`)
- Each public release version applied (e.g. `base-v0.1.0`, `base-v0.2.0`)
- Any user-requested snapshot ("Tone, save this state as 'good-at-briefings'")

And can be created manually:
- Before a major experiment ("let me try making Tone very terse for a week")
- When Tone feels particularly well-calibrated
- Before applying a new base version update

```bash
# See Tone's evolutionary timeline
git log --oneline --decorate

# See all named states
git tag -l

# Compare current Tone to how it was 4 weeks ago
git diff week-04..HEAD -- skills/ config/

# See what changed in Tone's personality over time
git log -p -- config/personality.md
```

### Rolling Back

There are several ways to navigate Tone's history:

**Full rollback** — revert Tone entirely to a previous state:
```bash
# Via git
git checkout week-06 -- skills/ config/

# Via Telegram
"Tone, go back to how you were in week 6"
```

**Surgical rollback** — revert a specific skill or behaviour:
```bash
# Just the briefing skill
git checkout week-06 -- skills/briefing.md

# Via Telegram
"Tone, your briefings were better last month. Revert just that."
```

**Comparison** — see what changed between two states:
```bash
# What evolved between week 4 and now?
git diff week-04..HEAD -- skills/

# Via Telegram
"Tone, what's changed about you since week 4?"
```

**Branch and experiment** — try something without committing:
```bash
# Tone creates an experiment branch
git checkout -b experiment/terse-personality

# If it works, merge. If not, delete the branch.
```

When you ask Tone to roll back via Telegram, it:
1. Identifies the relevant commits or tag
2. Shows you what would change (the diff, in plain English)
3. Waits for confirmation
4. Applies the revert as a new commit (preserving history, not rewriting it)
5. Tags the pre-rollback state so you can return if the rollback was a mistake

Rolling back is never destructive. It's always a new commit that happens to restore a previous state. The full history is always preserved.

## Divergence — Every Tone Is Unique

When someone installs Tone from the public repo, they get the base genome — seed skills, neutral personality, default reward signals. As they use it, their instance evolves independently.

Two people running Tone for six months will have completely different:
- Skill definitions (one might have evolved a sophisticated project management skill, another might have developed an excellent journaling flow)
- Personality files (matching their communication style)
- Filing heuristics (shaped by their topics and thinking patterns)
- Reward signals (tuned to what they actually care about)

Their Tones have diverged like species adapting to different environments. But they share a common ancestor (the base version), and both can:
- Pull updates from the base repo (new features, bug fixes, improved seed skills)
- Compare their evolved state against the base
- Share interesting mutations with the community

### Sharing Evolved Skills

If your Tone develops a particularly good skill — say an elegant way of handling recurring tasks — you could extract just that skill definition and share it:

```bash
# Export a skill for sharing
git diff base-v0.1.0..HEAD -- skills/recurring-tasks.md > my-recurring-tasks-skill.patch
```

Or simply share the markdown file. Other Tone users can drop it into their vault and let their own feedback loops adapt it further. Skills propagate through the community like beneficial mutations through a population.

## Applying Base Updates

When a new version of Tone is released (new features, improved seed skills, bug fixes), you can pull the update without losing your evolved state:

```bash
# In the code repo (public)
git pull origin main

# The vault-template may have new seed skills or config changes
# Tone's update process:
# 1. Compare new vault-template against your current vault
# 2. For files you haven't modified: update automatically
# 3. For files you HAVE evolved: show the diff, let you decide
#    - Keep your evolved version
#    - Take the new base version
#    - Merge (incorporate new base features into your evolved version)
```

This is analogous to how organisms can acquire new genetic material (horizontal gene transfer) while preserving the adaptations they've already developed.

## The Evolution Log

Tone maintains a human-readable evolution log in the vault — a narrative account of how it's changed over time:

```markdown
<!-- vault/feedback/evolution.md (append-only, auto-generated) -->

## Week 8 (17-21 Feb 2026)

### State at start of week
- Briefing: 07:30, full format with calendar section
- Drafting: Full message drafts for all contacts
- Filing: 89% accuracy, IoT misclassification fixed in week 7

### Changes this week

**Autonomic (Loop 2):**
- Briefing shifted to 08:45 based on engagement timing
- Calendar section removed from briefing (consistently skipped)

**Approved adaptations (Loop 3):**
- Briefing formalised to 09:00
- Close colleagues now get talking points, not full drafts
- Rejected: mandatory deadline prompt for tasks

### State at end of week
- Briefing: 09:00, compact format without calendar
- Drafting: Full drafts for most, talking points for close colleagues
- Filing: 91% accuracy (improving)

### Reward trend
Positive signals up 12% from week 7. Briefing engagement
increased significantly after timing and format changes.
```

This log is itself a fascinating document over time — a readable narrative of how your AI assistant learned to help you. For the public repo, anonymised versions of evolution logs could be shared as case studies showing how different users' Tones diverged.

## Safety and the Evolutionary Metaphor

Evolution in nature has no undo button. That's what makes it both powerful and dangerous — most mutations are harmful, and organisms can't roll back.

Tone has an undo button. That's the whole point.

The git history means you're getting the exploratory power of evolution (Tone tries things, adapts, discovers what works) with the safety of version control (nothing is ever truly lost, every state is recoverable). This is what makes it safe to let Tone experiment freely with its own behaviour — the worst case is always a `git revert` away.

The immutable boundaries (approval mechanism, feedback loops, safety rails) are like the laws of physics in Tone's universe. Evolution can produce any organism, but it can't change gravity. Tone can evolve any behaviour, but it can't disable the systems that keep it accountable.
