---
weights:
  senderImportance: 1.5
  directQuestion: 2
  deadlineLanguage: 2
  threadAgeHours: 0.03
  unreadCount: 0.75
  automatedSenderPenalty: 2
thresholds:
  needsReply: 3.5
  staleHours: 48
---
# Email Triage Weights

Tune deterministic email triage behavior by editing the frontmatter values above.

- `weights.senderImportance`: base impact from sender profile signal.
- `weights.directQuestion`: bonus when direct asks/questions are detected.
- `weights.deadlineLanguage`: bonus for urgency/deadline wording.
- `weights.threadAgeHours`: score added per hour of thread age (capped in code).
- `weights.unreadCount`: score added per unread message in thread (capped in code).
- `weights.automatedSenderPenalty`: penalty for automated/no-reply senders.
- `thresholds.needsReply`: minimum priority score for `needs_reply`.
- `thresholds.staleHours`: age threshold used for stale thread reminders.
