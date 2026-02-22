# Skill: capture

## Purpose
Capture ideas, notes, and voice transcripts quickly and file them into the right place.

## Trigger Patterns
- "capture"
- "note this"
- "remember this"
- voice memo style messages

## Input Format
- message: free-form text or transcribed voice
- metadata: timestamp, optional topic hints

## Output Format
- status: captured
- target: vault file path used
- summary: one-line confirmation

## Examples
- Input: "Capture this: test OpenRouter fallback this weekend."
- Output: "Captured in _inbox/2026-02-22.md"

## Constraints
- Prefer existing thread notes when confidence is high.
- Fall back to `_inbox/` when routing is uncertain.
- Preserve original user wording.
