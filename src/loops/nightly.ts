import fs from 'node:fs/promises';
import path from 'node:path';
import cron, { type ScheduledTask } from 'node-cron';
import type { Context, Telegraf } from 'telegraf';
import { config, type ResponseVerbosity } from '../config.js';
import { commit } from '../evolution.js';
import { complete } from '../llm.js';
import type { Interaction } from '../types.js';

interface FeedbackSignalEntry {
  type?: string;
}

interface ImplicitFeedbackEntry {
  type?: string;
  details?: {
    implicitSignal?: unknown;
    value?: unknown;
    note?: unknown;
  };
}

interface NightlySummary {
  date: string;
  totalInteractions: number;
  correctionsLogged: number;
  positiveSignals: number;
  negativeSignals: number;
  skillUsage: Record<string, number>;
  averageEngagement: number | null;
  reflectionMarkdown: string;
  extractedPatterns: string[];
  autonomicAdjustments: AutonomicAdjustment[];
  commitHash: string;
  committed: boolean;
}

interface NightlyModelPayload {
  reflectionMarkdown?: unknown;
  patterns?: unknown;
}

interface AutonomicSettings {
  briefingCron: string;
  responseVerbosity: ResponseVerbosity;
}

interface AutonomicAdjustment {
  target: 'briefing_timing' | 'response_verbosity';
  previousValue: string;
  nextValue: string;
  reason: string;
}

export interface ScheduleNightlyOptions {
  bot?: Telegraf<Context>;
  chatId?: string | number;
}

const AUTONOMIC_SETTINGS_PATH = path.join(config.vault.configDir, 'autonomic-settings.json');

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'ENOENT'
  );
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

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function extractJsonCandidate(raw: string): string | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }

  const firstBrace = raw.indexOf('{');
  const lastBrace = raw.lastIndexOf('}');
  if (firstBrace < 0 || lastBrace < 0 || firstBrace >= lastBrace) {
    return null;
  }

  return raw.slice(firstBrace, lastBrace + 1);
}

function parsePatterns(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => normalizeText(item))
    .filter((item) => item.length > 0)
    .slice(0, 8);
}

function parseNightlyModel(raw: string): { reflectionMarkdown: string; patterns: string[] } | null {
  const candidate = extractJsonCandidate(raw);
  if (!candidate) {
    return null;
  }

  try {
    const parsed = JSON.parse(candidate) as NightlyModelPayload;
    const reflectionMarkdown =
      typeof parsed.reflectionMarkdown === 'string' ? parsed.reflectionMarkdown.trim() : '';
    const patterns = parsePatterns(parsed.patterns);

    if (!reflectionMarkdown && patterns.length === 0) {
      return null;
    }

    return {
      reflectionMarkdown,
      patterns,
    };
  } catch {
    return null;
  }
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

function buildSkillUsage(interactions: Interaction[]): Record<string, number> {
  return interactions.reduce<Record<string, number>>((distribution, interaction) => {
    const key = interaction.skillUsed || 'unknown';
    distribution[key] = (distribution[key] ?? 0) + 1;
    return distribution;
  }, {});
}

function summarizeSkillUsage(skillUsage: Record<string, number>): string {
  const entries = Object.entries(skillUsage).sort((left, right) => right[1] - left[1]);
  if (entries.length === 0) {
    return '(no skill usage recorded)';
  }
  return entries.map(([skill, count]) => `- ${skill}: ${count}`).join('\n');
}

function average(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const total = values.reduce((sum, value) => sum + value, 0);
  return Math.round((total / values.length) * 1000) / 1000;
}

function parseDailyTime(cronExpression: string): { minute: number; hour: number } | null {
  const parts = cronExpression.trim().split(/\s+/);
  if (parts.length < 2) {
    return null;
  }

  const minute = Number(parts[0]);
  const hour = Number(parts[1]);
  if (!Number.isInteger(minute) || !Number.isInteger(hour)) {
    return null;
  }

  if (minute < 0 || minute > 59 || hour < 0 || hour > 23) {
    return null;
  }

  return { minute, hour };
}

function shiftClockByMinutes(
  clock: {
    minute: number;
    hour: number;
  },
  deltaMinutes: number,
): {
  minute: number;
  hour: number;
} {
  const totalMinutes = clock.hour * 60 + clock.minute + deltaMinutes;
  const minutesInDay = 24 * 60;
  const normalized = ((totalMinutes % minutesInDay) + minutesInDay) % minutesInDay;

  return {
    hour: Math.floor(normalized / 60),
    minute: normalized % 60,
  };
}

function serializeDailyTime(time: { minute: number; hour: number }): string {
  return `${time.minute} ${time.hour} * * *`;
}

async function readAutonomicSettings(): Promise<AutonomicSettings> {
  const raw = await readFileIfExists(AUTONOMIC_SETTINGS_PATH);
  if (!raw.trim()) {
    return {
      briefingCron: config.loops.briefingCron,
      responseVerbosity: config.loops.defaultResponseVerbosity,
    };
  }

  try {
    const parsed = JSON.parse(raw) as {
      briefingCron?: unknown;
      responseVerbosity?: unknown;
    };

    const briefingCron =
      typeof parsed.briefingCron === 'string' && parsed.briefingCron.trim().length > 0
        ? parsed.briefingCron.trim()
        : config.loops.briefingCron;

    const responseVerbosity =
      parsed.responseVerbosity === 'concise' ||
      parsed.responseVerbosity === 'balanced' ||
      parsed.responseVerbosity === 'detailed'
        ? parsed.responseVerbosity
        : config.loops.defaultResponseVerbosity;

    return {
      briefingCron,
      responseVerbosity,
    };
  } catch {
    return {
      briefingCron: config.loops.briefingCron,
      responseVerbosity: config.loops.defaultResponseVerbosity,
    };
  }
}

async function writeAutonomicSettings(settings: AutonomicSettings): Promise<void> {
  await fs.mkdir(config.vault.configDir, { recursive: true });
  await fs.writeFile(
    AUTONOMIC_SETTINGS_PATH,
    JSON.stringify(
      {
        ...settings,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    'utf8',
  );
}

function deriveAutonomicAdjustments(
  settings: AutonomicSettings,
  averageEngagement: number | null,
  positiveSignals: number,
  negativeSignals: number,
): {
  nextSettings: AutonomicSettings;
  adjustments: AutonomicAdjustment[];
} {
  const nextSettings: AutonomicSettings = { ...settings };
  const adjustments: AutonomicAdjustment[] = [];

  if (averageEngagement !== null) {
    const clock = parseDailyTime(settings.briefingCron);
    if (clock) {
      if (averageEngagement < 0.35) {
        const shifted = serializeDailyTime(shiftClockByMinutes(clock, 30));
        if (shifted !== settings.briefingCron) {
          nextSettings.briefingCron = shifted;
          adjustments.push({
            target: 'briefing_timing',
            previousValue: settings.briefingCron,
            nextValue: shifted,
            reason: `Average briefing engagement ${averageEngagement.toFixed(2)} is low; shift later by 30 minutes.`,
          });
        }
      } else if (averageEngagement > 0.8) {
        const shifted = serializeDailyTime(shiftClockByMinutes(clock, -15));
        if (shifted !== settings.briefingCron) {
          nextSettings.briefingCron = shifted;
          adjustments.push({
            target: 'briefing_timing',
            previousValue: settings.briefingCron,
            nextValue: shifted,
            reason: `Average briefing engagement ${averageEngagement.toFixed(2)} is high; move 15 minutes earlier.`,
          });
        }
      }
    }
  }

  let targetVerbosity: ResponseVerbosity = 'balanced';
  if (negativeSignals > positiveSignals) {
    targetVerbosity = 'concise';
  } else if (positiveSignals >= negativeSignals + 3) {
    targetVerbosity = 'detailed';
  }

  if (targetVerbosity !== settings.responseVerbosity) {
    nextSettings.responseVerbosity = targetVerbosity;
    adjustments.push({
      target: 'response_verbosity',
      previousValue: settings.responseVerbosity,
      nextValue: targetVerbosity,
      reason:
        targetVerbosity === 'concise'
          ? 'Negative feedback exceeded positive feedback; reduce verbosity.'
          : targetVerbosity === 'detailed'
            ? 'Positive feedback significantly exceeded negative feedback; increase depth.'
            : 'Feedback balance normalized; use balanced verbosity.',
    });
  }

  return {
    nextSettings,
    adjustments,
  };
}

function fallbackReflection(
  date: string,
  totalInteractions: number,
  correctionsLogged: number,
  positiveSignals: number,
  negativeSignals: number,
  skillUsage: Record<string, number>,
  averageEngagement: number | null,
): string {
  return [
    `# Nightly Review — ${date}`,
    '',
    `- Interactions: ${totalInteractions}`,
    `- Corrections logged: ${correctionsLogged}`,
    `- Positive signals: ${positiveSignals}`,
    `- Negative signals: ${negativeSignals}`,
    `- Average briefing engagement: ${
      averageEngagement === null ? 'not enough data' : averageEngagement.toFixed(2)
    }`,
    '',
    '## Skill Usage',
    summarizeSkillUsage(skillUsage),
  ].join('\n');
}

function fallbackPatterns(
  positiveSignals: number,
  negativeSignals: number,
  skillUsage: Record<string, number>,
): string[] {
  const topSkill = Object.entries(skillUsage).sort((left, right) => right[1] - left[1])[0]?.[0];
  const patterns: string[] = [];

  if (topSkill) {
    patterns.push(`Most-used skill today was "${topSkill}".`);
  }

  if (positiveSignals > negativeSignals) {
    patterns.push('Positive feedback outweighed negative feedback.');
  } else if (negativeSignals > positiveSignals) {
    patterns.push('Negative feedback outweighed positive feedback.');
  } else {
    patterns.push('Positive and negative feedback were balanced.');
  }

  return patterns;
}

async function appendPatterns(date: string, patterns: string[]): Promise<void> {
  if (patterns.length === 0) {
    return;
  }

  const patternsPath = path.join(config.vault.feedbackDir, 'patterns.md');
  await fs.mkdir(path.dirname(patternsPath), { recursive: true });

  const section = [
    '',
    `## ${date}`,
    ...patterns.map((pattern) => `- ${pattern}`),
  ].join('\n');

  await fs.appendFile(patternsPath, section, 'utf8');
}

async function appendAutonomicLog(date: string, adjustments: AutonomicAdjustment[]): Promise<void> {
  const autonomicPath = path.join(config.vault.feedbackDir, 'autonomic.md');
  await fs.mkdir(path.dirname(autonomicPath), { recursive: true });

  const lines =
    adjustments.length > 0
      ? adjustments.map(
          (adjustment) =>
            `- ${adjustment.target}: ${adjustment.previousValue} -> ${adjustment.nextValue} (${adjustment.reason})`,
        )
      : ['- No autonomic adjustments were applied.'];

  const section = ['', `## ${date}`, ...lines].join('\n');
  await fs.appendFile(autonomicPath, section, 'utf8');
}

function resolveChatId(chatId: string | number | undefined): string | null {
  if (typeof chatId === 'number') {
    return String(chatId);
  }

  if (typeof chatId === 'string' && chatId.trim()) {
    return chatId.trim();
  }

  return config.telegram.defaultChatId ?? null;
}

function buildNightlyPrompt(
  date: string,
  totalInteractions: number,
  correctionsLogged: number,
  positiveSignals: number,
  negativeSignals: number,
  skillUsage: Record<string, number>,
  averageEngagement: number | null,
): string {
  return [
    'You are generating a nightly reflection for an adaptive assistant.',
    'Return strict JSON with keys: reflectionMarkdown, patterns.',
    'reflectionMarkdown: markdown text for a daily review.',
    'patterns: array of short behavior patterns observed today.',
    '',
    `Date: ${date}`,
    `Total interactions: ${totalInteractions}`,
    `Corrections logged: ${correctionsLogged}`,
    `Positive feedback signals: ${positiveSignals}`,
    `Negative feedback signals: ${negativeSignals}`,
    `Average briefing engagement (0..1): ${averageEngagement === null ? 'null' : averageEngagement.toFixed(3)}`,
    '',
    'Skill usage distribution:',
    summarizeSkillUsage(skillUsage),
  ].join('\n');
}

export async function generateNightlyReview(date = new Date()): Promise<NightlySummary> {
  const dateStamp = dateStampInTimezone(date);
  const interactionLogPath = path.join(config.vault.feedbackDir, 'interactions', `${dateStamp}.jsonl`);
  const signalLogPath = path.join(
    config.vault.feedbackDir,
    'interactions',
    `feedback-signals-${dateStamp}.jsonl`,
  );
  const implicitLogPath = path.join(config.vault.feedbackDir, 'interactions', `implicit-${dateStamp}.jsonl`);
  const correctionsLogPath = path.join(
    config.vault.feedbackDir,
    'interactions',
    `corrections-${dateStamp}.jsonl`,
  );

  const [interactionsRaw, signalsRaw, implicitRaw, correctionsRaw] = await Promise.all([
    readFileIfExists(interactionLogPath),
    readFileIfExists(signalLogPath),
    readFileIfExists(implicitLogPath),
    readFileIfExists(correctionsLogPath),
  ]);

  const interactions = parseJsonLines<Interaction>(interactionsRaw);
  const feedbackSignals = parseJsonLines<FeedbackSignalEntry>(signalsRaw);
  const implicitSignals = parseJsonLines<ImplicitFeedbackEntry>(implicitRaw);
  const corrections = parseJsonLines<{ id?: string }>(correctionsRaw);

  const totalInteractions = interactions.length;
  const correctionsLogged = corrections.length;
  const positiveSignals = feedbackSignals.filter((entry) => entry.type === 'thumbs_up').length;
  const negativeSignals = feedbackSignals.filter((entry) => entry.type === 'thumbs_down').length;
  const skillUsage = buildSkillUsage(interactions);
  const engagementValues = implicitSignals
    .filter((entry) => entry.details?.implicitSignal === 'engagement_timing')
    .map((entry) => entry.details?.value)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  const averageEngagement = average(engagementValues);

  const prompt = buildNightlyPrompt(
    dateStamp,
    totalInteractions,
    correctionsLogged,
    positiveSignals,
    negativeSignals,
    skillUsage,
    averageEngagement,
  );
  const completion = await complete(prompt, 'tier3');
  const parsedModel = completion.ok ? parseNightlyModel(completion.data.text) : null;

  const reflectionMarkdown =
    parsedModel?.reflectionMarkdown ||
    fallbackReflection(
      dateStamp,
      totalInteractions,
      correctionsLogged,
      positiveSignals,
      negativeSignals,
      skillUsage,
      averageEngagement,
    );
  const extractedPatterns =
    parsedModel?.patterns || fallbackPatterns(positiveSignals, negativeSignals, skillUsage);

  const settings = await readAutonomicSettings();
  const { nextSettings, adjustments } = deriveAutonomicAdjustments(
    settings,
    averageEngagement,
    positiveSignals,
    negativeSignals,
  );

  const dailyReviewPath = path.join(config.vault.feedbackDir, 'daily', `${dateStamp}.md`);
  await fs.mkdir(path.dirname(dailyReviewPath), { recursive: true });
  await fs.writeFile(dailyReviewPath, reflectionMarkdown, 'utf8');
  await appendPatterns(dateStamp, extractedPatterns);
  await appendAutonomicLog(dateStamp, adjustments);
  await writeAutonomicSettings(nextSettings);

  const nightlyCommit = await commit(
    `daily review ${dateStamp} | ${totalInteractions} interactions | +${positiveSignals}/-${negativeSignals}`,
    'nightly',
  );

  return {
    date: dateStamp,
    totalInteractions,
    correctionsLogged,
    positiveSignals,
    negativeSignals,
    skillUsage,
    averageEngagement,
    reflectionMarkdown,
    extractedPatterns,
    autonomicAdjustments: adjustments,
    commitHash: nightlyCommit.hash,
    committed: nightlyCommit.committed,
  };
}

export function scheduleNightly(options?: ScheduleNightlyOptions): ScheduledTask {
  return cron.schedule(
    config.loops.nightlyCron,
    async () => {
      try {
        const review = await generateNightlyReview();
        const chatId = resolveChatId(options?.chatId);
        if (options?.bot && chatId) {
          await options.bot.telegram.sendMessage(
            chatId,
            `Nightly review complete for ${review.date}. Interactions: ${review.totalInteractions}. Adjustments: ${review.autonomicAdjustments.length}.`,
          );
        }
      } catch (error) {
        console.error('[tone] nightly review failed', error);
      }
    },
    {
      timezone: config.timezone,
    },
  );
}

export type { NightlySummary };
