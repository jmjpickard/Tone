import fs from 'node:fs/promises';
import path from 'node:path';
import cron, { type ScheduledTask } from 'node-cron';
import type { Context, Telegraf } from 'telegraf';
import { config, type ResponseVerbosity } from '../config.js';
import { logImplicitFeedback } from '../feedback.js';
import { getConnectionStatus } from '../integrations/gmail/auth.js';
import { loadLatestTriageSnapshot } from '../integrations/gmail/sync.js';
import type { EmailTriageSnapshot } from '../integrations/gmail/types.js';
import { complete } from '../llm.js';
import { formatBriefing, type BriefingPayload } from '../utils/telegram.js';

interface BriefingContextSnapshot {
  pendingTasks: string[];
  activeThreads: string[];
  recentDailyNotes: string[];
  personality: string;
  responseVerbosity: ResponseVerbosity;
  emailSnapshot: EmailTriageSnapshot | null;
}

interface BriefingModelPayload {
  headline?: unknown;
  priorities?: unknown;
  activeThreads?: unknown;
  pendingTasks?: unknown;
}

interface BriefingStateEntry {
  sentAt: string;
  engagedAt?: string;
}

type BriefingState = Record<string, BriefingStateEntry>;

export interface GeneratedBriefing {
  generatedAt: string;
  payload: BriefingPayload;
  text: string;
  source: 'llm' | 'fallback';
}

export interface ScheduleBriefingOptions {
  bot: Telegraf<Context>;
  chatId?: string | number;
}

const AUTONOMIC_SETTINGS_PATH = path.join(config.vault.configDir, 'autonomic-settings.json');
const BRIEFING_STATE_PATH = path.join(config.vault.feedbackDir, 'interactions', 'briefing-state.json');

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'ENOENT'
  );
}

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function parseChecklist(markdown: string): string[] {
  const tasks: string[] = [];
  const pattern = /^-\s*\[[ xX]\]\s*(.+)$/gm;

  let match = pattern.exec(markdown);
  while (match) {
    const text = normalizeWhitespace(match[1] ?? '');
    if (text.length > 0) {
      tasks.push(text);
    }
    match = pattern.exec(markdown);
  }

  return tasks;
}

async function readFileIfExists(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (isNotFoundError(error)) {
      return '';
    }
    throw error;
  }
}

async function readPendingTasks(): Promise<string[]> {
  const activeTasksPath = path.join(config.vault.tasksDir, 'active.md');
  const markdown = await readFileIfExists(activeTasksPath);
  return parseChecklist(markdown).slice(0, 12);
}

async function readRecentDailyNotes(limit = 3): Promise<string[]> {
  try {
    const entries = await fs.readdir(config.vault.dailyDir, { withFileTypes: true });
    const markdownFiles = entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
      .map((entry) => path.join(config.vault.dailyDir, entry.name));

    const withStats = await Promise.all(
      markdownFiles.map(async (filePath) => ({
        filePath,
        stats: await fs.stat(filePath),
      })),
    );

    const recent = withStats
      .sort((left, right) => right.stats.mtimeMs - left.stats.mtimeMs)
      .slice(0, limit);

    const snippets = await Promise.all(
      recent.map(async ({ filePath }) => {
        const raw = await readFileIfExists(filePath);
        const summaryLine =
          raw
            .split(/\r?\n/)
            .map((line) => line.trim())
            .find((line) => line.length > 0 && !line.startsWith('#') && !line.startsWith('<!--')) ??
          'No summary yet.';

        const noteName = path.basename(filePath, '.md');
        return `${noteName}: ${normalizeWhitespace(summaryLine)}`;
      }),
    );

    return snippets.filter((item) => item.length > 0);
  } catch (error) {
    if (isNotFoundError(error)) {
      return [];
    }
    throw error;
  }
}

async function readThreadActivity(limit = 6): Promise<string[]> {
  try {
    const entries = await fs.readdir(config.vault.threadsDir, { withFileTypes: true });
    const markdownFiles = entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
      .map((entry) => path.join(config.vault.threadsDir, entry.name));

    const withStats = await Promise.all(
      markdownFiles.map(async (filePath) => ({
        filePath,
        stats: await fs.stat(filePath),
      })),
    );

    return withStats
      .sort((left, right) => right.stats.mtimeMs - left.stats.mtimeMs)
      .slice(0, limit)
      .map(({ filePath }) => path.basename(filePath, '.md').replace(/[-_]/g, ' '));
  } catch (error) {
    if (isNotFoundError(error)) {
      return [];
    }
    throw error;
  }
}

async function readResponseVerbosity(): Promise<ResponseVerbosity> {
  const raw = await readFileIfExists(AUTONOMIC_SETTINGS_PATH);
  if (!raw.trim()) {
    return config.loops.defaultResponseVerbosity;
  }

  try {
    const parsed = JSON.parse(raw) as { responseVerbosity?: unknown };
    const verbosity = parsed.responseVerbosity;
    if (verbosity === 'concise' || verbosity === 'balanced' || verbosity === 'detailed') {
      return verbosity;
    }
  } catch {
    // Ignore invalid JSON and fall back to configured default.
  }

  return config.loops.defaultResponseVerbosity;
}

async function readBriefingContext(): Promise<BriefingContextSnapshot> {
  const [pendingTasks, activeThreads, recentDailyNotes, personality, responseVerbosity, emailSnapshot, gmailStatus] =
    await Promise.all([
      readPendingTasks(),
      readThreadActivity(),
      readRecentDailyNotes(),
      readFileIfExists(path.join(config.vault.configDir, 'personality.md')),
      readResponseVerbosity(),
      loadLatestTriageSnapshot(),
      getConnectionStatus(),
    ]);

  const normalizedEmailSnapshot =
    emailSnapshot ??
    (gmailStatus.state === 'connected'
      ? {
          generatedAt: new Date().toISOString(),
          source: 'fallback',
          status: 'available',
          needsReply: [],
          waitingOnThem: [],
          staleThreads: [],
        }
      : {
          generatedAt: new Date().toISOString(),
          source: 'fallback',
          status: 'unavailable',
          unavailableReason: gmailStatus.message,
          needsReply: [],
          waitingOnThem: [],
          staleThreads: [],
        });

  return {
    pendingTasks,
    activeThreads,
    recentDailyNotes,
    personality: personality.trim(),
    responseVerbosity,
    emailSnapshot: normalizedEmailSnapshot,
  };
}

function formatEmailPromptSummary(emailSnapshot: EmailTriageSnapshot | null): string {
  if (!emailSnapshot) {
    return '(no triage snapshot available yet)';
  }

  if (emailSnapshot.status === 'unavailable') {
    return `Email unavailable: ${emailSnapshot.unavailableReason ?? 'Unknown reason'}`;
  }

  const topNeedsReply =
    emailSnapshot.needsReply.length > 0
      ? emailSnapshot.needsReply.slice(0, 5).map((item) => `${item.subject} (${item.from})`).join('\n')
      : '(none)';
  const waitingOnThem =
    emailSnapshot.waitingOnThem.length > 0
      ? emailSnapshot.waitingOnThem
          .slice(0, 4)
          .map((item) => `${item.subject} (${item.from})`)
          .join('\n')
      : '(none)';
  const staleThreads =
    emailSnapshot.staleThreads.length > 0
      ? emailSnapshot.staleThreads.slice(0, 4).map((item) => `${item.subject} (${item.from})`).join('\n')
      : '(none)';

  return [
    'Needs reply:',
    topNeedsReply,
    '',
    'Waiting on them:',
    waitingOnThem,
    '',
    'Stale threads:',
    staleThreads,
  ].join('\n');
}

function toBriefingEmailSection(emailSnapshot: EmailTriageSnapshot | null): BriefingPayload['email'] | undefined {
  if (!emailSnapshot) {
    return undefined;
  }

  if (emailSnapshot.status === 'unavailable') {
    return {
      status: 'unavailable',
      needsReply: [],
      waitingOnThem: [],
      staleThreads: [],
      note: emailSnapshot.unavailableReason ?? 'Gmail is currently unavailable.',
    };
  }

  return {
    status: 'available',
    needsReply: emailSnapshot.needsReply.slice(0, 5).map((item) => item.subject),
    waitingOnThem: emailSnapshot.waitingOnThem.slice(0, 4).map((item) => item.subject),
    staleThreads: emailSnapshot.staleThreads.slice(0, 4).map((item) => item.subject),
  };
}

function extractJsonCandidate(raw: string): string | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }

  const firstBrace = raw.indexOf('{');
  const lastBrace = raw.lastIndexOf('}');
  if (firstBrace < 0 || lastBrace < 0 || lastBrace <= firstBrace) {
    return null;
  }

  return raw.slice(firstBrace, lastBrace + 1);
}

function normalizeStringArray(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => normalizeWhitespace(item))
    .filter((item) => item.length > 0)
    .slice(0, maxItems);
}

function parseModelPayload(raw: string): BriefingPayload | null {
  const candidate = extractJsonCandidate(raw);
  if (!candidate) {
    return null;
  }

  try {
    const parsed = JSON.parse(candidate) as BriefingModelPayload;
    const headline = typeof parsed.headline === 'string' ? normalizeWhitespace(parsed.headline) : '';
    const priorities = normalizeStringArray(parsed.priorities, 6);
    const activeThreads = normalizeStringArray(parsed.activeThreads, 8);
    const pendingTasks = normalizeStringArray(parsed.pendingTasks, 10);

    if (priorities.length === 0 && activeThreads.length === 0 && pendingTasks.length === 0) {
      return null;
    }

    return {
      ...(headline ? { headline } : {}),
      priorities,
      activeThreads,
      pendingTasks,
    };
  } catch {
    return null;
  }
}

function fallbackPayload(snapshot: BriefingContextSnapshot): BriefingPayload {
  const prioritiesFromTasks = snapshot.pendingTasks.slice(0, 3);
  const prioritiesFromDaily = snapshot.recentDailyNotes.slice(0, 2);
  const priorities = prioritiesFromTasks.length > 0 ? prioritiesFromTasks : prioritiesFromDaily;
  const emailSection = toBriefingEmailSection(snapshot.emailSnapshot);

  return {
    headline: 'Morning Briefing',
    priorities,
    activeThreads: snapshot.activeThreads.slice(0, 6),
    pendingTasks: snapshot.pendingTasks.slice(0, 8),
    ...(emailSection ? { email: emailSection } : {}),
  };
}

function buildBriefingPrompt(snapshot: BriefingContextSnapshot): string {
  return [
    'You are generating a morning briefing for the user.',
    'Write in the personality style provided below.',
    `Target response verbosity: ${snapshot.responseVerbosity}.`,
    'Return strict JSON only with keys: headline, priorities, activeThreads, pendingTasks.',
    'priorities: 2-5 concise bullets.',
    'activeThreads: 0-6 concise names.',
    'pendingTasks: 0-8 concrete task lines.',
    '',
    'Personality:',
    snapshot.personality || 'Neutral and concise.',
    '',
    `Pending tasks:\n${snapshot.pendingTasks.length > 0 ? snapshot.pendingTasks.join('\n') : '(none)'}`,
    '',
    `Recent daily notes:\n${snapshot.recentDailyNotes.length > 0 ? snapshot.recentDailyNotes.join('\n') : '(none)'}`,
    '',
    `Recent thread activity:\n${snapshot.activeThreads.length > 0 ? snapshot.activeThreads.join('\n') : '(none)'}`,
    '',
    `Latest email triage snapshot:\n${formatEmailPromptSummary(snapshot.emailSnapshot)}`,
  ].join('\n');
}

async function loadBriefingState(): Promise<BriefingState> {
  const raw = await readFileIfExists(BRIEFING_STATE_PATH);
  if (!raw.trim()) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const entries = Object.entries(parsed).filter(
      (entry): entry is [string, BriefingStateEntry] =>
        typeof entry[0] === 'string' &&
        typeof entry[1] === 'object' &&
        entry[1] !== null &&
        'sentAt' in entry[1] &&
        typeof (entry[1] as { sentAt?: unknown }).sentAt === 'string',
    );
    return Object.fromEntries(entries);
  } catch {
    return {};
  }
}

async function saveBriefingState(state: BriefingState): Promise<void> {
  await fs.mkdir(path.dirname(BRIEFING_STATE_PATH), { recursive: true });
  await fs.writeFile(BRIEFING_STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
}

async function recordBriefingDispatch(userId: string, sentAt: string): Promise<void> {
  const state = await loadBriefingState();
  state[userId] = { sentAt };
  await saveBriefingState(state);
}

function resolveChatId(inputChatId?: string | number): string | null {
  if (typeof inputChatId === 'number') {
    return String(inputChatId);
  }

  if (typeof inputChatId === 'string' && inputChatId.trim().length > 0) {
    return inputChatId.trim();
  }

  if (config.telegram.defaultChatId) {
    return config.telegram.defaultChatId;
  }

  return null;
}

export async function trackBriefingEngagement(userId: string): Promise<void> {
  const normalizedUserId = userId.trim();
  if (!normalizedUserId) {
    return;
  }

  const state = await loadBriefingState();
  const entry = state[normalizedUserId];
  if (!entry || entry.engagedAt) {
    return;
  }

  const sentAt = Date.parse(entry.sentAt);
  if (!Number.isFinite(sentAt)) {
    return;
  }

  const now = Date.now();
  const elapsedMinutes = (now - sentAt) / (60 * 1000);
  if (elapsedMinutes < 0 || elapsedMinutes > 24 * 60) {
    return;
  }

  const score = Math.max(0, 1 - elapsedMinutes / 240);
  const roundedScore = Math.round(score * 1000) / 1000;

  await logImplicitFeedback({
    userId: normalizedUserId,
    signal: 'engagement_timing',
    value: roundedScore,
    note: `briefing_response_delay_minutes=${Math.round(elapsedMinutes)}`,
  });

  state[normalizedUserId] = {
    sentAt: entry.sentAt,
    engagedAt: new Date().toISOString(),
  };
  await saveBriefingState(state);
}

export async function generateBriefing(): Promise<GeneratedBriefing> {
  const generatedAt = new Date().toISOString();
  const contextSnapshot = await readBriefingContext();
  const prompt = buildBriefingPrompt(contextSnapshot);

  const completion = await complete(prompt, 'tier2');
  const emailSection = toBriefingEmailSection(contextSnapshot.emailSnapshot);
  if (completion.ok) {
    const parsed = parseModelPayload(completion.data.text);
    if (parsed) {
      return {
        generatedAt,
        payload: {
          ...parsed,
          ...(emailSection ? { email: emailSection } : {}),
        },
        text: formatBriefing({
          ...parsed,
          ...(emailSection ? { email: emailSection } : {}),
        }),
        source: 'llm',
      };
    }
  }

  const fallback = fallbackPayload(contextSnapshot);
  return {
    generatedAt,
    payload: fallback,
    text: formatBriefing(fallback),
    source: 'fallback',
  };
}

async function runBriefing(options: ScheduleBriefingOptions): Promise<void> {
  const chatId = resolveChatId(options.chatId);
  if (!chatId) {
    console.warn('[tone] skipping morning briefing: TELEGRAM_DEFAULT_CHAT_ID is not configured');
    return;
  }

  const briefing = await generateBriefing();
  await options.bot.telegram.sendMessage(chatId, briefing.text, {
    parse_mode: 'Markdown',
  });
  await recordBriefingDispatch(chatId, briefing.generatedAt);
}

async function runMiddayReminder(options: ScheduleBriefingOptions): Promise<void> {
  const chatId = resolveChatId(options.chatId);
  if (!chatId) {
    return;
  }

  const emailSnapshot = await loadLatestTriageSnapshot();
  if (!emailSnapshot || emailSnapshot.status !== 'available') {
    return;
  }

  const unresolvedHighPriority = emailSnapshot.needsReply.filter((item) => item.priorityScore >= 5);
  if (unresolvedHighPriority.length === 0) {
    return;
  }

  const lines = [
    '*Midday Email Reminder*',
    '',
    `${unresolvedHighPriority.length} high-priority thread(s) still need a reply:`,
    ...unresolvedHighPriority.slice(0, 5).map((item) => `- ${item.subject} (${item.from})`),
    '',
    'Quick actions: snooze, remind tomorrow, mark done, or draft a reply.',
  ];

  await options.bot.telegram.sendMessage(chatId, lines.join('\n'), { parse_mode: 'Markdown' });
}

async function runEveningRecap(options: ScheduleBriefingOptions): Promise<void> {
  const chatId = resolveChatId(options.chatId);
  if (!chatId) {
    return;
  }

  const emailSnapshot = await loadLatestTriageSnapshot();
  const pendingTasks = await readPendingTasks();

  const carryOverEmails = emailSnapshot?.status === 'available'
    ? emailSnapshot.needsReply.slice(0, 5)
    : [];
  const carryOverTasks = pendingTasks.slice(0, 5);

  if (carryOverEmails.length === 0 && carryOverTasks.length === 0) {
    return;
  }

  const lines = ['*Evening Recap*', ''];

  if (carryOverEmails.length > 0) {
    lines.push(
      '*Email carry-over for tomorrow:*',
      ...carryOverEmails.map((item) => `- ${item.subject} (${item.from})`),
      '',
    );
  }

  if (carryOverTasks.length > 0) {
    lines.push(
      '*Task carry-over:*',
      ...carryOverTasks.map((task) => `- ${task}`),
    );
  }

  await options.bot.telegram.sendMessage(chatId, lines.join('\n'), { parse_mode: 'Markdown' });
}

export function scheduleMiddayReminder(options: ScheduleBriefingOptions): ScheduledTask | null {
  const chatId = resolveChatId(options.chatId);
  if (!chatId) {
    return null;
  }

  return cron.schedule(
    config.loops.middayCron,
    async () => {
      try {
        await runMiddayReminder({ ...options, chatId });
      } catch (error) {
        console.error('[tone] midday reminder failed', error);
      }
    },
    { timezone: config.timezone },
  );
}

export function scheduleEveningRecap(options: ScheduleBriefingOptions): ScheduledTask | null {
  const chatId = resolveChatId(options.chatId);
  if (!chatId) {
    return null;
  }

  return cron.schedule(
    config.loops.eveningCron,
    async () => {
      try {
        await runEveningRecap({ ...options, chatId });
      } catch (error) {
        console.error('[tone] evening recap failed', error);
      }
    },
    { timezone: config.timezone },
  );
}

export function scheduleBriefing(options: ScheduleBriefingOptions): ScheduledTask | null {
  const chatId = resolveChatId(options.chatId);
  if (!chatId) {
    console.warn('[tone] briefing scheduler disabled: no target Telegram chat id configured');
    return null;
  }

  const task = cron.schedule(
    config.loops.briefingCron,
    async () => {
      try {
        await runBriefing({
          ...options,
          chatId,
        });
      } catch (error) {
        console.error('[tone] morning briefing run failed', error);
      }
    },
    {
      timezone: config.timezone,
    },
  );

  return task;
}
