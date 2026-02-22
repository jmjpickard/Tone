import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
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

  return event;
}
