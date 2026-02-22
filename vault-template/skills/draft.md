# Skill: draft

## Purpose
Draft messages and communication artifacts in the user's voice.

## Trigger Patterns
- "draft"
- "write a message"
- "compose"
- "help me reply"

## Input Format
- recipient: person or channel
- intent: what the message should achieve
- context: optional supporting notes

## Output Format
- subject: optional title
- draft: full message text
- rationale: short explanation of tone choices

## Examples
- Input: "Draft a friendly update to Sam about project delays"
- Output: "Hi Sam, quick update..."

## Constraints
- Match tone to `config/personality.md` and recipient context.
- Ask follow-up questions when required context is missing.
- Avoid fabricating facts.
