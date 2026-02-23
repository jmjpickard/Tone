import fs from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { config } from '../../config.js';
import type { EmailTriageItem, EmailTriageLabel, EmailTriageSnapshot, GmailInboxMessage } from './types.js';

interface EmailTriageWeights {
  senderImportance: number;
  directQuestion: number;
  deadlineLanguage: number;
  threadAgeHours: number;
  unreadCount: number;
  automatedSenderPenalty: number;
}

interface EmailTriageThresholds {
  needsReply: number;
  staleHours: number;
}

interface EmailTriageConfig {
  weights: EmailTriageWeights;
  thresholds: EmailTriageThresholds;
}

const TRIAGE_CONFIG_PATH = path.join(config.vault.configDir, 'email-triage.md');
const MAX_THREAD_AGE_HOURS = 120;
const MAX_UNREAD_COUNT = 5;

const AUTOMATED_SENDER_PATTERN = /\b(noreply|no-reply|notification|newsletter|updates?|alerts?|receipt)\b/i;
const HIGH_IMPORTANCE_SENDER_PATTERN = /\b(ceo|founder|manager|director|lead|vp|chief|partner)\b/i;
const DIRECT_QUESTION_PATTERN =
  /\?|(?:\bcan you\b|\bcould you\b|\bwould you\b|\bplease\b|\bneed you to\b|\bkindly\b)/i;
const DEADLINE_PATTERN =
  /\b(today|tomorrow|eod|end of day|deadline|due|asap|this week|by (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|[a-z]+ \d{1,2}|\d{1,2}\/\d{1,2}))\b/i;
const WAITING_ON_THEM_PATTERN =
  /\b(waiting on|let me know|i(?:'ll| will) get back|will revert|follow up next week|will update)\b/i;
const FYI_PATTERN = /\b(fyi|for your information|just sharing|heads up|no action needed)\b/i;

const DEFAULT_TRIAGE_CONFIG: EmailTriageConfig = {
  weights: {
    senderImportance: 1.5,
    directQuestion: 2,
    deadlineLanguage: 2,
    threadAgeHours: 0.03,
    unreadCount: 0.75,
    automatedSenderPenalty: 2,
  },
  thresholds: {
    needsReply: 3.5,
    staleHours: 48,
  },
};

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'ENOENT'
  );
}

function extractFrontmatter(markdown: string): string | null {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return match?.[1] ?? null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function normalizeNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }

  if (value < min) {
    return min;
  }

  if (value > max) {
    return max;
  }

  return value;
}

async function loadTriageConfig(): Promise<EmailTriageConfig> {
  let raw: string;
  try {
    raw = await fs.readFile(TRIAGE_CONFIG_PATH, 'utf8');
  } catch (error) {
    if (isNotFoundError(error)) {
      return DEFAULT_TRIAGE_CONFIG;
    }
    throw error;
  }

  const frontmatter = extractFrontmatter(raw);
  if (!frontmatter) {
    return DEFAULT_TRIAGE_CONFIG;
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(frontmatter);
  } catch {
    return DEFAULT_TRIAGE_CONFIG;
  }

  const root = asRecord(parsed);
  if (!root) {
    return DEFAULT_TRIAGE_CONFIG;
  }

  const weights = asRecord(root.weights);
  const thresholds = asRecord(root.thresholds);

  return {
    weights: {
      senderImportance: normalizeNumber(
        weights?.senderImportance,
        DEFAULT_TRIAGE_CONFIG.weights.senderImportance,
        -3,
        5,
      ),
      directQuestion: normalizeNumber(
        weights?.directQuestion,
        DEFAULT_TRIAGE_CONFIG.weights.directQuestion,
        0,
        6,
      ),
      deadlineLanguage: normalizeNumber(
        weights?.deadlineLanguage,
        DEFAULT_TRIAGE_CONFIG.weights.deadlineLanguage,
        0,
        6,
      ),
      threadAgeHours: normalizeNumber(
        weights?.threadAgeHours,
        DEFAULT_TRIAGE_CONFIG.weights.threadAgeHours,
        0,
        0.5,
      ),
      unreadCount: normalizeNumber(weights?.unreadCount, DEFAULT_TRIAGE_CONFIG.weights.unreadCount, 0, 3),
      automatedSenderPenalty: normalizeNumber(
        weights?.automatedSenderPenalty,
        DEFAULT_TRIAGE_CONFIG.weights.automatedSenderPenalty,
        0,
        6,
      ),
    },
    thresholds: {
      needsReply: normalizeNumber(
        thresholds?.needsReply,
        DEFAULT_TRIAGE_CONFIG.thresholds.needsReply,
        0,
        10,
      ),
      staleHours: normalizeNumber(
        thresholds?.staleHours,
        DEFAULT_TRIAGE_CONFIG.thresholds.staleHours,
        1,
        720,
      ),
    },
  };
}

function toTimestamp(isoDate: string): number {
  const parsed = Date.parse(isoDate);
  if (!Number.isFinite(parsed)) {
    return 0;
  }

  return parsed;
}

function computeAgeHours(isoDate: string, nowMs: number): number {
  const receivedAtMs = toTimestamp(isoDate);
  if (!receivedAtMs) {
    return 0;
  }

  return Math.max(0, (nowMs - receivedAtMs) / (60 * 60 * 1000));
}

function buildUnreadCountByThread(messages: GmailInboxMessage[]): Map<string, number> {
  const counts = new Map<string, number>();

  for (const message of messages) {
    if (!message.unread) {
      continue;
    }

    const previous = counts.get(message.threadId) ?? 0;
    counts.set(message.threadId, previous + 1);
  }

  return counts;
}

function latestMessagePerThread(messages: GmailInboxMessage[]): GmailInboxMessage[] {
  const byThread = new Map<string, GmailInboxMessage>();

  for (const message of messages) {
    const existing = byThread.get(message.threadId);
    if (!existing) {
      byThread.set(message.threadId, message);
      continue;
    }

    if (toTimestamp(message.internalDate) > toTimestamp(existing.internalDate)) {
      byThread.set(message.threadId, message);
    }
  }

  return Array.from(byThread.values());
}

function senderImportanceSignal(sender: string): { value: number; automated: boolean; reason: string } {
  if (AUTOMATED_SENDER_PATTERN.test(sender)) {
    return {
      value: -1,
      automated: true,
      reason: 'automated sender pattern detected',
    };
  }

  if (HIGH_IMPORTANCE_SENDER_PATTERN.test(sender)) {
    return {
      value: 2,
      automated: false,
      reason: 'high-importance sender title detected',
    };
  }

  return {
    value: 1,
    automated: false,
    reason: 'direct human sender detected',
  };
}

function normalizeText(input: string): string {
  return input.trim().replace(/\s+/g, ' ');
}

function classifyMessage(
  message: GmailInboxMessage,
  unreadCount: number,
  triageConfig: EmailTriageConfig,
  nowMs: number,
): EmailTriageItem {
  const combinedText = `${message.subject} ${message.snippet}`;
  const senderSignal = senderImportanceSignal(message.from);
  const directQuestion = DIRECT_QUESTION_PATTERN.test(combinedText);
  const deadlineLanguage = DEADLINE_PATTERN.test(combinedText);
  const waitingOnThem = WAITING_ON_THEM_PATTERN.test(combinedText);
  const informational = FYI_PATTERN.test(combinedText);

  const ageHours = computeAgeHours(message.internalDate, nowMs);
  const boundedAgeHours = Math.min(ageHours, MAX_THREAD_AGE_HOURS);
  const boundedUnreadCount = Math.min(Math.max(0, unreadCount), MAX_UNREAD_COUNT);

  const reasoning: string[] = [];
  let score = 0;

  const senderContribution = senderSignal.value * triageConfig.weights.senderImportance;
  score += senderContribution;
  reasoning.push(
    `sender importance (${senderSignal.reason}): ${senderContribution >= 0 ? '+' : ''}${senderContribution.toFixed(2)}`,
  );

  if (senderSignal.automated) {
    score -= triageConfig.weights.automatedSenderPenalty;
    reasoning.push(
      `automated sender penalty: -${triageConfig.weights.automatedSenderPenalty.toFixed(2)}`,
    );
  }

  if (directQuestion) {
    score += triageConfig.weights.directQuestion;
    reasoning.push(`direct question/ask detected: +${triageConfig.weights.directQuestion.toFixed(2)}`);
  }

  if (deadlineLanguage) {
    score += triageConfig.weights.deadlineLanguage;
    reasoning.push(`deadline language detected: +${triageConfig.weights.deadlineLanguage.toFixed(2)}`);
  }

  const ageContribution = boundedAgeHours * triageConfig.weights.threadAgeHours;
  score += ageContribution;
  if (ageContribution > 0) {
    reasoning.push(`thread age ${Math.floor(ageHours)}h: +${ageContribution.toFixed(2)}`);
  }

  const unreadContribution = boundedUnreadCount * triageConfig.weights.unreadCount;
  score += unreadContribution;
  if (unreadContribution > 0) {
    reasoning.push(`unread count ${boundedUnreadCount}: +${unreadContribution.toFixed(2)}`);
  }

  const priorityScore = Number(Math.max(0, Math.min(10, score)).toFixed(2));

  let label: EmailTriageLabel = 'fyi';
  if (senderSignal.automated && !directQuestion && !deadlineLanguage) {
    label = 'no_reply_needed';
    reasoning.push('classified as no_reply_needed due to automated sender with no direct ask');
  } else if (waitingOnThem && !directQuestion && !deadlineLanguage) {
    label = 'waiting_on_them';
    reasoning.push('classified as waiting_on_them due to waiting language');
  } else if (
    priorityScore >= triageConfig.thresholds.needsReply ||
    directQuestion ||
    deadlineLanguage
  ) {
    label = 'needs_reply';
    reasoning.push(
      `classified as needs_reply (score ${priorityScore.toFixed(2)} >= threshold ${triageConfig.thresholds.needsReply.toFixed(2)})`,
    );
  } else if (informational) {
    label = 'fyi';
    reasoning.push('classified as fyi due to informational wording');
  } else {
    reasoning.push('classified as fyi due to low action signals');
  }

  return {
    threadId: message.threadId,
    messageId: message.id,
    subject: normalizeText(message.subject || '(No subject)'),
    from: normalizeText(message.from || '(Unknown sender)'),
    snippet: normalizeText(message.snippet),
    receivedAt: message.internalDate,
    unread: message.unread,
    label,
    priorityScore,
    reasoning,
  };
}

export interface TriageWeightBounds {
  key: string;
  min: number;
  max: number;
  current: number;
}

export async function loadTriageWeightsWithBounds(): Promise<TriageWeightBounds[]> {
  const triageConfig = await loadTriageConfig();
  return [
    { key: 'senderImportance', min: -3, max: 5, current: triageConfig.weights.senderImportance },
    { key: 'directQuestion', min: 0, max: 6, current: triageConfig.weights.directQuestion },
    { key: 'deadlineLanguage', min: 0, max: 6, current: triageConfig.weights.deadlineLanguage },
    { key: 'threadAgeHours', min: 0, max: 0.5, current: triageConfig.weights.threadAgeHours },
    { key: 'unreadCount', min: 0, max: 3, current: triageConfig.weights.unreadCount },
    { key: 'automatedSenderPenalty', min: 0, max: 6, current: triageConfig.weights.automatedSenderPenalty },
  ];
}

export async function triageInbox(messages: GmailInboxMessage[]): Promise<EmailTriageSnapshot> {
  const triageConfig = await loadTriageConfig();
  const nowMs = Date.now();
  const unreadCountByThread = buildUnreadCountByThread(messages);
  const latestMessages = latestMessagePerThread(messages);

  const triagedItems = latestMessages.map((message) =>
    classifyMessage(message, unreadCountByThread.get(message.threadId) ?? 0, triageConfig, nowMs),
  );

  const needsReply = triagedItems
    .filter((item) => item.label === 'needs_reply')
    .sort((left, right) => {
      if (right.priorityScore !== left.priorityScore) {
        return right.priorityScore - left.priorityScore;
      }
      return toTimestamp(right.receivedAt) - toTimestamp(left.receivedAt);
    });

  const waitingOnThem = triagedItems
    .filter((item) => item.label === 'waiting_on_them')
    .sort((left, right) => toTimestamp(right.receivedAt) - toTimestamp(left.receivedAt));

  const staleThreads = needsReply.filter(
    (item) => computeAgeHours(item.receivedAt, nowMs) >= triageConfig.thresholds.staleHours,
  );

  return {
    generatedAt: new Date(nowMs).toISOString(),
    source: 'gmail',
    status: 'available',
    needsReply,
    waitingOnThem,
    staleThreads,
  };
}
