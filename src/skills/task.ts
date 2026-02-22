import { formatTaskList } from '../utils/telegram.js';
import { readNote, writeNote } from '../vault.js';
import type { SkillExecutionInput, SkillHandler, SkillResult } from './types.js';

type TaskAction = 'add' | 'complete' | 'list' | 'someday';

const ACTIVE_PATH = 'tasks/active.md';
const COMPLETED_PATH = 'tasks/completed.md';
const SOMEDAY_PATH = 'tasks/someday.md';

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'ENOENT'
  );
}

function normalizeTaskText(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function taskMatchKey(value: string): string {
  return normalizeTaskText(value).toLowerCase();
}

function extractTasks(markdown: string): string[] {
  const tasks: string[] = [];
  const regex = /^-\s*\[[ xX]\]\s*(.*)$/gm;

  let match = regex.exec(markdown);
  while (match) {
    const taskText = normalizeTaskText(match[1] ?? '');
    if (taskText.length > 0) {
      tasks.push(taskText);
    }
    match = regex.exec(markdown);
  }

  return tasks;
}

async function readTaskList(notePath: string): Promise<string[]> {
  try {
    const note = await readNote(notePath);
    return extractTasks(note.content);
  } catch (error) {
    if (isNotFoundError(error)) {
      return [];
    }

    throw error;
  }
}

async function writeActiveTasks(tasks: string[]): Promise<void> {
  const body = tasks.length > 0 ? tasks.map((task) => `- [ ] ${task}`).join('\n') : '- [ ]';
  await writeNote(ACTIVE_PATH, `# Active Tasks\n\n${body}`);
}

async function writeSomedayTasks(tasks: string[]): Promise<void> {
  const body = tasks.length > 0 ? tasks.map((task) => `- [ ] ${task}`).join('\n') : '- [ ]';
  await writeNote(SOMEDAY_PATH, `# Someday Tasks\n\n${body}`);
}

async function writeCompletedTasks(tasks: string[]): Promise<void> {
  const body = tasks.length > 0 ? tasks.map((task) => `- [x] ${task}`).join('\n') : '- [x]';
  await writeNote(COMPLETED_PATH, `# Completed Tasks\n\n## Archive\n\n${body}`);
}

function detectAction(input: SkillExecutionInput): TaskAction {
  const entityAction = input.entities.action;
  if (typeof entityAction === 'string') {
    const normalized = entityAction.trim().toLowerCase();
    if (normalized === 'add' || normalized === 'complete' || normalized === 'list' || normalized === 'someday') {
      return normalized;
    }
  }

  const lowered = input.text.toLowerCase();

  if (/\b(list tasks|show tasks|what.*tasks)\b/.test(lowered)) {
    return 'list';
  }

  if (/\b(complete task|mark .* complete|done|finish)\b/.test(lowered)) {
    return 'complete';
  }

  if (/\b(someday|later)\b/.test(lowered)) {
    return 'someday';
  }

  return 'add';
}

function extractTaskText(input: SkillExecutionInput): string {
  const taskEntity = input.entities.task;
  if (typeof taskEntity === 'string') {
    return normalizeTaskText(taskEntity);
  }

  const quoted = input.text.match(/"([^"]+)"|'([^']+)'/);
  if (quoted?.[1] || quoted?.[2]) {
    return normalizeTaskText((quoted[1] ?? quoted[2]) || '');
  }

  const commandMatch = input.text.match(
    /(?:add task|task|complete task|move(?: this)? to someday|someday)\s*:?\s*(.+)$/i,
  );
  if (commandMatch?.[1]) {
    return normalizeTaskText(commandMatch[1]);
  }

  return '';
}

function findTaskIndex(tasks: string[], query: string): number {
  const normalizedQuery = taskMatchKey(query);
  if (!normalizedQuery) {
    return -1;
  }

  const exactIndex = tasks.findIndex((task) => taskMatchKey(task) === normalizedQuery);
  if (exactIndex >= 0) {
    return exactIndex;
  }

  return tasks.findIndex((task) => {
    const key = taskMatchKey(task);
    return key.includes(normalizedQuery) || normalizedQuery.includes(key);
  });
}

function addTaskUnique(tasks: string[], task: string): { tasks: string[]; added: boolean } {
  const normalized = taskMatchKey(task);
  if (!normalized) {
    return {
      tasks,
      added: false,
    };
  }

  if (tasks.some((existing) => taskMatchKey(existing) === normalized)) {
    return {
      tasks,
      added: false,
    };
  }

  return {
    tasks: [...tasks, normalizeTaskText(task)],
    added: true,
  };
}

async function listTasksResponse(): Promise<SkillResult> {
  const [activeTasks, somedayTasks] = await Promise.all([
    readTaskList(ACTIVE_PATH),
    readTaskList(SOMEDAY_PATH),
  ]);

  const activeBlock = formatTaskList(activeTasks, 'Active Tasks');
  const somedayBlock = formatTaskList(somedayTasks, 'Someday Tasks');

  return {
    status: 'success',
    intent: 'task',
    response: `${activeBlock}\n\n${somedayBlock}`,
    metadata: {
      activeCount: activeTasks.length,
      somedayCount: somedayTasks.length,
    },
  };
}

async function addTask(taskText: string): Promise<SkillResult> {
  if (taskText.length === 0) {
    return {
      status: 'needs_clarification',
      intent: 'task',
      response: 'Tell me the task to add. Example: "Add task: send weekly update".',
    };
  }

  const activeTasks = await readTaskList(ACTIVE_PATH);
  const result = addTaskUnique(activeTasks, taskText);

  if (!result.added) {
    return {
      status: 'success',
      intent: 'task',
      response: `Task already exists in active list: ${taskText}`,
    };
  }

  await writeActiveTasks(result.tasks);

  return {
    status: 'success',
    intent: 'task',
    response: `Added to active tasks: ${taskText}`,
    metadata: {
      action: 'add',
    },
  };
}

async function completeTask(taskText: string): Promise<SkillResult> {
  if (taskText.length === 0) {
    return {
      status: 'needs_clarification',
      intent: 'task',
      response: 'Tell me which task to mark complete.',
    };
  }

  const [activeTasks, completedTasks] = await Promise.all([
    readTaskList(ACTIVE_PATH),
    readTaskList(COMPLETED_PATH),
  ]);

  const index = findTaskIndex(activeTasks, taskText);
  if (index < 0) {
    return {
      status: 'not_found',
      intent: 'task',
      response: `I could not find that active task: ${taskText}`,
    };
  }

  const [resolvedTask] = activeTasks.splice(index, 1);
  if (!resolvedTask) {
    return {
      status: 'not_found',
      intent: 'task',
      response: `I could not find that active task: ${taskText}`,
    };
  }

  const completionResult = addTaskUnique(completedTasks, resolvedTask);

  await Promise.all([writeActiveTasks(activeTasks), writeCompletedTasks(completionResult.tasks)]);

  return {
    status: 'success',
    intent: 'task',
    response: `Marked complete: ${resolvedTask}`,
    metadata: {
      action: 'complete',
    },
  };
}

async function moveTaskToSomeday(taskText: string): Promise<SkillResult> {
  if (taskText.length === 0) {
    return {
      status: 'needs_clarification',
      intent: 'task',
      response: 'Tell me which task should move to someday.',
    };
  }

  const [activeTasks, somedayTasks] = await Promise.all([
    readTaskList(ACTIVE_PATH),
    readTaskList(SOMEDAY_PATH),
  ]);

  const activeIndex = findTaskIndex(activeTasks, taskText);
  const fallbackTask = normalizeTaskText(taskText);
  const resolvedTaskFromActive = activeIndex >= 0 ? activeTasks.splice(activeIndex, 1)[0] : undefined;
  const resolvedTask = resolvedTaskFromActive ? normalizeTaskText(resolvedTaskFromActive) : fallbackTask;

  const updatedSomeday = addTaskUnique(somedayTasks, resolvedTask);

  await Promise.all([writeActiveTasks(activeTasks), writeSomedayTasks(updatedSomeday.tasks)]);

  return {
    status: 'success',
    intent: 'task',
    response:
      activeIndex >= 0
        ? `Moved to someday: ${resolvedTask}`
        : `Added to someday tasks: ${resolvedTask}`,
    metadata: {
      action: 'someday',
    },
  };
}

export const taskSkill: SkillHandler = {
  name: 'task',
  async execute(input): Promise<SkillResult> {
    const action = detectAction(input);

    if (action === 'list') {
      return listTasksResponse();
    }

    const taskText = extractTaskText(input);

    if (action === 'complete') {
      return completeTask(taskText);
    }

    if (action === 'someday') {
      return moveTaskToSomeday(taskText);
    }

    return addTask(taskText);
  },
};
