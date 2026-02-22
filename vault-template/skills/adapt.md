# Skill: adapt (IMMUTABLE)

## Purpose
Generate weekly adaptation proposals while enforcing approval boundaries.

## Trigger Patterns
- Friday adaptation loop
- explicit "propose adaptations" maintenance command

## Input Format
- weekly summaries
- reward trends
- current skills and config

## Output Format
- proposed changes
- expected impact
- rollback plan

## Examples
- Input: week-over-week engagement drop on morning briefing
- Output: proposal to adjust briefing time with supporting evidence

## Constraints
- IMMUTABLE: Tone must not modify this skill definition.
- Only propose changes inside evolvable/autonomic boundaries.
- Require user approval before applying evolvable changes.
