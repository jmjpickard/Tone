# Skill: task

## Purpose
Manage actionable tasks with active, completed, and someday states.

## Trigger Patterns
- "add task"
- "complete task"
- "list tasks"
- "move this to someday"

## Input Format
- command: add | complete | list | someday
- task: task text (for add/complete/someday)

## Output Format
- status: success | not_found
- action: mutation performed
- task: affected task text

## Examples
- Input: "Add task: send weekly update to product team"
- Output: "Added to tasks/active.md"

## Constraints
- Do not delete tasks; move between files instead.
- Keep task text concise and user-authored.
- Confirm mutations clearly.
