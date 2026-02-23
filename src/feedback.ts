import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { commit } from './evolution.js';
import type { FeedbackEvent, Interaction } from './types.js';

export interface FeedbackSignalInput {
  interactionId: string;
  userId: string;
  signal: 'thumbs_up' | 'thumbs_down';
}

export interface CorrectionInput {
  userId: string;
  previousBehavior: string;
  desiredBehavior: string;
  learnedRule: string;
  interactionId?: string;
}

export interface ImplicitFeedbackInput {
  userId: string;
  signal: 'engagement_timing' | 'draft_acceptance';
  value: number;
  note?: string;
  interactionId?: string;
}

export interface TriageOutcomeInput {
  userId: string;
  action: 'triage_accepted' | 'snooze' | 'marked_done' | 'marked_no_reply' | 'ignored_urgent';
  threadId: string;
  snoozedUntil?: string;
  note?: string;
  interactionId?: string;
}

export interface EmailActionInput {
  userId: string;
  action: 'draft_generated' | 'send_confirmed' | 'send_canceled' | 'send_failed';
  draftRef: string;
  threadId?: string;
  confirmationId?: string;
  note?: string;
  interactionId?: string;
}

export interface CorrectionDetectionInput {
  text: string;
  previousInteraction?: Interaction | null;
}

function dateStampInTimezone(date: Date): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: config.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = formatter.formatToParts(date);

  const year = parts.find((part) => part.type === 'year')?.value ?? '0000';
  const month = parts.find((part) => part.type === 'month')?.value ?? '01';
  const day = parts.find((part) => part.type === 'day')?.value ?? '01';

  return `${year}-${month}-${day}`;
}

async function appendJsonLine(filePath: string, payload: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(payload)}\n`, 'utf8');
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function parseJsonLines<T>(raw: string): T[] {
  if (!raw.trim()) {
    return [];
  }

  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      try {
        return JSON.parse(line) as T;
      } catch {
        return null;
      }
    })
    .filter((item): item is T => item !== null);
}

function formatPreviousBehavior(interaction: Interaction | null | undefined): string {
  if (!interaction) {
    return 'No prior interaction context was available.';
  }

  const preview = normalizeText(interaction.response).slice(0, 180);
  return `Interaction ${interaction.id}: ${preview || '(empty response)'}`;
}

function inferLearnedRule(text: string): string {
  const lowered = text.toLowerCase();

  const destinationMatch = lowered.match(/\b(?:to|into|under|in)\s+([a-z0-9_\-/]+)/i);
  if (destinationMatch?.[1]) {
    return `When corrected, prioritize explicit destination "${destinationMatch[1]}" over inferred filing rules.`;
  }

  if (/\b(refile|move|put this|file this|wrong thread|wrong folder)\b/.test(lowered)) {
    return 'When user re-files content, preserve the user-specified destination and update filing heuristics.';
  }

  if (/^(no|nope|nah|actually|instead|wrong|not that)\b/.test(lowered)) {
    return 'When user issues an explicit correction, prefer the new instruction and avoid repeating the prior behavior.';
  }

  return 'Treat this message as corrective feedback and bias toward the user-provided behavior.';
}

export function detectCorrection(input: CorrectionDetectionInput): Omit<CorrectionInput, 'userId'> | null {
  const text = normalizeText(input.text);
  if (!text) {
    return null;
  }

  const lowered = text.toLowerCase();
  const startsWithCorrection = /^(no|nope|nah|actually|instead|wrong|not that|you should|do this)\b/.test(
    lowered,
  );
  const mentionsRefiling =
    /\b(refile|file this|move this|put this|wrong thread|wrong folder|wrong project)\b/.test(lowered);
  const explicitOverride = /\b(do x|do y|do this|should be|use .* instead)\b/.test(lowered);

  if (!startsWithCorrection && !mentionsRefiling && !explicitOverride) {
    return null;
  }

  const previousBehavior = formatPreviousBehavior(input.previousInteraction);
  const desiredBehavior = text;
  const learnedRule = inferLearnedRule(text);

  return {
    ...(input.previousInteraction?.id ? { interactionId: input.previousInteraction.id } : {}),
    previousBehavior,
    desiredBehavior,
    learnedRule,
  };
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'ENOENT'
  );
}

async function listInteractionLogs(): Promise<string[]> {
  const interactionDir = path.join(config.vault.feedbackDir, 'interactions');

  try {
    const entries = await fs.readdir(interactionDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(entry.name))
      .map((entry) => path.join(interactionDir, entry.name))
      .sort((left, right) => right.localeCompare(left));
  } catch (error) {
    if (isNotFoundError(error)) {
      return [];
    }
    throw error;
  }
}

export async function findMostRecentInteractionForUser(
  userId: string,
  lookbackDays = 7,
): Promise<Interaction | null> {
  const normalizedUserId = userId.trim();
  if (!normalizedUserId) {
    return null;
  }

  const files = await listInteractionLogs();
  const limitedFiles = files.slice(0, Math.max(1, lookbackDays));

  for (const filePath of limitedFiles) {
    const raw = await fs.readFile(filePath, 'utf8');
    const interactions = parseJsonLines<Interaction>(raw)
      .filter((interaction) => interaction.userId === normalizedUserId)
      .sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp));

    const found = interactions[0];
    if (found) {
      return found;
    }
  }

  return null;
}

export async function logInteraction(interaction: Interaction): Promise<void> {
  const dateStamp = dateStampInTimezone(new Date(interaction.timestamp));
  const interactionLogPath = path.join(config.vault.feedbackDir, 'interactions', `${dateStamp}.jsonl`);
  await appendJsonLine(interactionLogPath, interaction);
}

export async function logFeedbackSignal(input: FeedbackSignalInput): Promise<FeedbackEvent> {
  const timestamp = new Date().toISOString();

  const event: FeedbackEvent = {
    id: randomUUID(),
    timestamp,
    interactionId: input.interactionId,
    type: input.signal,
    details: {
      reaction: input.signal,
    },
  };

  const dateStamp = dateStampInTimezone(new Date(timestamp));
  const signalLogPath = path.join(
    config.vault.feedbackDir,
    'interactions',
    `feedback-signals-${dateStamp}.jsonl`,
  );

  await appendJsonLine(signalLogPath, {
    ...event,
    userId: input.userId,
  });

  return event;
}

export async function logCorrection(input: CorrectionInput): Promise<FeedbackEvent> {
  const timestamp = new Date().toISOString();

  const event: FeedbackEvent = {
    id: randomUUID(),
    timestamp,
    ...(input.interactionId ? { interactionId: input.interactionId } : {}),
    type: 'correction',
    details: {
      correction: {
        previousBehavior: input.previousBehavior,
        desiredBehavior: input.desiredBehavior,
        learnedRule: input.learnedRule,
      },
    },
  };

  const markdownEntry = [
    '',
    `## ${timestamp}`,
    `- Interaction: ${input.interactionId ?? 'n/a'}`,
    `- Previous behavior: ${input.previousBehavior}`,
    `- Desired behavior: ${input.desiredBehavior}`,
    `- Learned rule: ${input.learnedRule}`,
  ].join('\n');

  const correctionsPath = path.join(config.vault.feedbackDir, 'corrections.md');
  await fs.mkdir(path.dirname(correctionsPath), { recursive: true });
  await fs.appendFile(correctionsPath, markdownEntry, 'utf8');

  const dateStamp = dateStampInTimezone(new Date(timestamp));
  const jsonlPath = path.join(config.vault.feedbackDir, 'interactions', `corrections-${dateStamp}.jsonl`);
  await appendJsonLine(jsonlPath, {
    ...event,
    userId: input.userId,
  });

  await commit(`learned correction from user ${input.userId} | ${input.learnedRule}`, 'correction');

  return event;
}

export async function logImplicitFeedback(input: ImplicitFeedbackInput): Promise<FeedbackEvent> {
  const timestamp = new Date().toISOString();
  const normalizedValue = Number.isFinite(input.value) ? Math.max(0, Math.min(1, input.value)) : 0;
  const eventType =
    input.signal === 'engagement_timing' ? 'implicit_engagement_timing' : 'implicit_draft_acceptance';

  const event: FeedbackEvent = {
    id: randomUUID(),
    timestamp,
    ...(input.interactionId ? { interactionId: input.interactionId } : {}),
    type: eventType,
    details: {
      implicitSignal: input.signal,
      value: normalizedValue,
      ...(input.note ? { note: input.note } : {}),
    },
  };

  const dateStamp = dateStampInTimezone(new Date(timestamp));
  const jsonlPath = path.join(config.vault.feedbackDir, 'interactions', `implicit-${dateStamp}.jsonl`);
  await appendJsonLine(jsonlPath, {
    ...event,
    userId: input.userId,
  });

  return event;
}

function mapTriageActionToEventType(
  action: TriageOutcomeInput['action'],
): FeedbackEvent['type'] {
  if (action === 'triage_accepted') return 'email_triage_accepted';
  if (action === 'snooze') return 'email_snooze';
  if (action === 'marked_done') return 'email_marked_done';
  if (action === 'marked_no_reply') return 'email_marked_no_reply';
  return 'email_ignored_urgent';
}

export async function logTriageOutcome(input: TriageOutcomeInput): Promise<FeedbackEvent> {
  const timestamp = new Date().toISOString();
  const event: FeedbackEvent = {
    id: randomUUID(),
    timestamp,
    ...(input.interactionId ? { interactionId: input.interactionId } : {}),
    type: mapTriageActionToEventType(input.action),
    details: {
      triageAction: {
        action: input.action,
        threadId: input.threadId,
        ...(input.snoozedUntil ? { snoozedUntil: input.snoozedUntil } : {}),
        ...(input.note ? { note: input.note } : {}),
      },
    },
  };

  const dateStamp = dateStampInTimezone(new Date(timestamp));
  const jsonlPath = path.join(config.vault.feedbackDir, 'interactions', `email-actions-${dateStamp}.jsonl`);
  await appendJsonLine(jsonlPath, {
    ...event,
    userId: input.userId,
  });

  return event;
}

function mapEmailActionToEventType(
  action: EmailActionInput['action'],
): FeedbackEvent['type'] {
  if (action === 'draft_generated') {
    return 'email_draft_generated';
  }
  if (action === 'send_confirmed') {
    return 'email_send_confirmed';
  }
  if (action === 'send_canceled') {
    return 'email_send_canceled';
  }
  return 'email_send_failed';
}

export async function logEmailAction(input: EmailActionInput): Promise<FeedbackEvent> {
  const timestamp = new Date().toISOString();
  const event: FeedbackEvent = {
    id: randomUUID(),
    timestamp,
    ...(input.interactionId ? { interactionId: input.interactionId } : {}),
    type: mapEmailActionToEventType(input.action),
    details: {
      emailAction: {
        action: input.action,
        draftRef: input.draftRef,
        ...(input.threadId ? { threadId: input.threadId } : {}),
        ...(input.confirmationId ? { confirmationId: input.confirmationId } : {}),
        ...(input.note ? { note: input.note } : {}),
      },
    },
  };

  const dateStamp = dateStampInTimezone(new Date(timestamp));
  const jsonlPath = path.join(config.vault.feedbackDir, 'interactions', `email-actions-${dateStamp}.jsonl`);
  await appendJsonLine(jsonlPath, {
    ...event,
    userId: input.userId,
  });

  return event;
}
