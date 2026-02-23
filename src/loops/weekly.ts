import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import cron, { type ScheduledTask } from 'node-cron';
import { Markup, type Context, type Telegraf } from 'telegraf';
import { config } from '../config.js';
import {
  appendEvolutionLogEntry,
  checkoutBranch,
  commit,
  createBranch,
  deleteBranch,
  getDefaultBranch,
  mergeBranch,
  tag,
} from '../evolution.js';
import { loadTriageWeightsWithBounds, type TriageWeightBounds } from '../integrations/gmail/triage.js';
import { complete } from '../llm.js';
import type { Interaction } from '../types.js';

interface EmailActionEntry {
  type?: string;
  details?: {
    triageAction?: {
      action?: string;
    };
  };
}

interface TriageScorecard {
  draftsGenerated: number;
  sendConfirmed: number;
  sendCanceled: number;
  snoozeCount: number;
  markedDone: number;
  markedNoReply: number;
  ignoredUrgent: number;
  totalActions: number;
}

interface TriageWeightProposal {
  key: string;
  currentValue: number;
  proposedValue: number;
  reason: string;
}

interface WeeklyModelPayload {
  summary?: unknown;
  skillChanges?: unknown;
  personalityTweaks?: unknown;
}

interface WeeklyProposal {
  summary: string;
  skillChanges: string[];
  personalityTweaks: string[];
}

interface ProposalSnapshot {
  summary: string;
  skillChanges: string[];
  personalityTweaks: string[];
  totalInteractions: number;
  positiveSignals: number;
  negativeSignals: number;
}

interface WeeklyReviewResult {
  weekKey: string;
  weekTag: string;
  branchName: string;
  proposalPath: string;
  totalInteractions: number;
  positiveSignals: number;
  negativeSignals: number;
  skillUsage: Record<string, number>;
  proposal: WeeklyProposal;
  triageScorecard: TriageScorecard;
  triageWeightProposals: TriageWeightProposal[];
  commitHash: string;
}

interface PendingWeeklyApproval {
  weekKey: string;
  weekTag: string;
  branchName: string;
  proposalPath: string;
  createdAt: string;
}

export interface WeeklyApprovalDecisionInput {
  decision: 'approve' | 'reject';
  weekKey: string;
  userId: string;
  reason?: string;
}

export interface WeeklyApprovalDecisionResult {
  status: 'approved' | 'rejected' | 'ignored';
  message: string;
}

export interface ScheduleWeeklyOptions {
  bot: Telegraf<Context>;
  chatId?: string | number;
}

function pendingStatePath(): string {
  const safeVaultName = config.vault.rootPath
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .toLowerCase();
  return path.join(os.tmpdir(), `tone-weekly-pending-${safeVaultName}.json`);
}

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

async function readPendingApproval(): Promise<PendingWeeklyApproval | null> {
  const raw = await readFileIfExists(pendingStatePath());
  if (!raw.trim()) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<PendingWeeklyApproval>;
    if (
      typeof parsed.weekKey === 'string' &&
      typeof parsed.weekTag === 'string' &&
      typeof parsed.branchName === 'string' &&
      typeof parsed.proposalPath === 'string' &&
      typeof parsed.createdAt === 'string'
    ) {
      return {
        weekKey: parsed.weekKey,
        weekTag: parsed.weekTag,
        branchName: parsed.branchName,
        proposalPath: parsed.proposalPath,
        createdAt: parsed.createdAt,
      };
    }
  } catch {
    // Ignore invalid pending state and treat as missing.
  }

  return null;
}

async function writePendingApproval(state: PendingWeeklyApproval | null): Promise<void> {
  const stateFile = pendingStatePath();
  if (!state) {
    try {
      await fs.unlink(stateFile);
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }
    }
    return;
  }

  await fs.writeFile(stateFile, JSON.stringify(state, null, 2), 'utf8');
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

function getTimezoneDateParts(date: Date): { year: number; month: number; day: number } {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: config.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = formatter.formatToParts(date);

  const year = Number(parts.find((part) => part.type === 'year')?.value ?? 0);
  const month = Number(parts.find((part) => part.type === 'month')?.value ?? 1);
  const day = Number(parts.find((part) => part.type === 'day')?.value ?? 1);

  return { year, month, day };
}

function getIsoWeekInfo(date = new Date()): {
  isoYear: number;
  isoWeek: number;
  weekKey: string;
  weekTag: string;
  branchName: string;
} {
  const parts = getTimezoneDateParts(date);
  const workingDate = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  const weekday = workingDate.getUTCDay() || 7;
  workingDate.setUTCDate(workingDate.getUTCDate() + 4 - weekday);

  const isoYear = workingDate.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const dayOfYear = Math.floor((workingDate.getTime() - yearStart.getTime()) / 86400000) + 1;
  const isoWeek = Math.ceil(dayOfYear / 7);
  const weekSuffix = String(isoWeek).padStart(2, '0');

  return {
    isoYear,
    isoWeek,
    weekKey: `${isoYear}-W${weekSuffix}`,
    weekTag: `week-${weekSuffix}`,
    branchName: `adapt/week-${weekSuffix}`,
  };
}

function datesForPastDays(days: number, referenceDate = new Date()): string[] {
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(referenceDate);
    date.setUTCDate(date.getUTCDate() - (days - 1 - index));
    return dateStampInTimezone(date);
  });
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
    .filter((entry): entry is T => entry !== null);
}

function buildSkillUsage(interactions: Interaction[]): Record<string, number> {
  return interactions.reduce<Record<string, number>>((acc, interaction) => {
    const key = interaction.skillUsed || 'unknown';
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
}

function summarizeSkillUsage(skillUsage: Record<string, number>): string {
  const entries = Object.entries(skillUsage).sort((left, right) => right[1] - left[1]);
  if (entries.length === 0) {
    return '(none)';
  }
  return entries.map(([skill, count]) => `- ${skill}: ${count}`).join('\n');
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

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => normalizeText(item))
    .filter((item) => item.length > 0)
    .slice(0, 8);
}

function parseWeeklyModel(raw: string): WeeklyProposal | null {
  const candidate = extractJsonCandidate(raw);
  if (!candidate) {
    return null;
  }

  try {
    const parsed = JSON.parse(candidate) as WeeklyModelPayload;
    const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
    const skillChanges = normalizeStringArray(parsed.skillChanges);
    const personalityTweaks = normalizeStringArray(parsed.personalityTweaks);

    if (!summary && skillChanges.length === 0 && personalityTweaks.length === 0) {
      return null;
    }

    return {
      summary: summary || 'No high-confidence weekly changes identified.',
      skillChanges,
      personalityTweaks,
    };
  } catch {
    return null;
  }
}

function fallbackProposal(
  weekKey: string,
  totalInteractions: number,
  positiveSignals: number,
  negativeSignals: number,
  skillUsage: Record<string, number>,
): WeeklyProposal {
  const topSkill = Object.entries(skillUsage).sort((left, right) => right[1] - left[1])[0]?.[0];
  const summary = `Week ${weekKey}: ${totalInteractions} interactions, +${positiveSignals}/-${negativeSignals} explicit feedback.`;

  const skillChanges = topSkill
    ? [`Review ${topSkill} skill prompts and examples for this user's most frequent workflows.`]
    : ['Collect more interaction data before proposing skill edits.'];

  const personalityTweaks =
    negativeSignals > positiveSignals
      ? ['Shift responses to concise mode for the coming week.']
      : ['Keep balanced response style and monitor engagement consistency.'];

  return {
    summary,
    skillChanges,
    personalityTweaks,
  };
}

function renderWeeklyProposalMarkdown(
  weekKey: string,
  totals: {
    totalInteractions: number;
    positiveSignals: number;
    negativeSignals: number;
  },
  skillUsage: Record<string, number>,
  dailyReviewExcerpts: string[],
  proposal: WeeklyProposal,
  branchName: string,
  weekTag: string,
  triageScorecard: TriageScorecard,
  triageWeightProposals: TriageWeightProposal[],
): string {
  const dailyReviewBlock =
    dailyReviewExcerpts.length > 0 ? dailyReviewExcerpts.map((line) => `- ${line}`).join('\n') : '- None';

  const skillChangesBlock =
    proposal.skillChanges.length > 0
      ? proposal.skillChanges.map((item) => `- ${item}`).join('\n')
      : '- None proposed.';

  const personalityTweaksBlock =
    proposal.personalityTweaks.length > 0
      ? proposal.personalityTweaks.map((item) => `- ${item}`).join('\n')
      : '- None proposed.';

  return [
    `# Weekly Adaptation Review — ${weekKey}`,
    '',
    '## Metrics',
    `- Total interactions: ${totals.totalInteractions}`,
    `- Positive signals: ${totals.positiveSignals}`,
    `- Negative signals: ${totals.negativeSignals}`,
    '',
    '## Skill Usage',
    summarizeSkillUsage(skillUsage),
    '',
    '## Daily Review Highlights',
    dailyReviewBlock,
    '',
    '## Proposed Skill Modifications',
    skillChangesBlock,
    '',
    '## Suggested Personality Tweaks',
    personalityTweaksBlock,
    '',
    '## Summary',
    proposal.summary,
    '',
    '## Email Triage Scorecard',
    `- Drafts generated: ${triageScorecard.draftsGenerated}`,
    `- Sends confirmed: ${triageScorecard.sendConfirmed}`,
    `- Sends canceled: ${triageScorecard.sendCanceled}`,
    `- Snoozes: ${triageScorecard.snoozeCount}`,
    `- Marked done: ${triageScorecard.markedDone}`,
    `- Marked no-reply: ${triageScorecard.markedNoReply}`,
    `- Ignored urgent: ${triageScorecard.ignoredUrgent}`,
    `- Total actions: ${triageScorecard.totalActions}`,
    '',
    '## Proposed Triage Weight Changes',
    triageWeightProposals.length > 0
      ? triageWeightProposals
          .map((p) => `- ${p.key}: ${p.currentValue} -> ${p.proposedValue} (${p.reason})`)
          .join('\n')
      : '- None proposed.',
    '',
    '## Approval',
    `- Status: pending`,
    `- Snapshot tag: ${weekTag}`,
    `- Proposal branch: ${branchName}`,
  ].join('\n');
}

function buildWeeklyPrompt(
  weekKey: string,
  totalInteractions: number,
  positiveSignals: number,
  negativeSignals: number,
  skillUsage: Record<string, number>,
  dailyReviewExcerpts: string[],
): string {
  return [
    'You are generating a weekly adaptation proposal for a personal assistant.',
    'Return strict JSON with keys: summary, skillChanges, personalityTweaks.',
    'summary: one concise paragraph.',
    'skillChanges: array of concrete proposed skill modifications.',
    'personalityTweaks: array of concise communication/personality adjustments.',
    '',
    `Week: ${weekKey}`,
    `Interactions: ${totalInteractions}`,
    `Positive signals: ${positiveSignals}`,
    `Negative signals: ${negativeSignals}`,
    '',
    'Skill usage distribution:',
    summarizeSkillUsage(skillUsage),
    '',
    `Daily review excerpts:\n${dailyReviewExcerpts.length > 0 ? dailyReviewExcerpts.join('\n') : '(none)'}`,
  ].join('\n');
}

function parseProposalSnapshot(markdown: string): ProposalSnapshot {
  const summaryMatch = markdown.match(/## Summary\s+([\s\S]*?)(?=\n##\s+|$)/i);
  const summary = normalizeText(summaryMatch?.[1] ?? 'No summary available.');

  const skillSection = markdown.match(/## Proposed Skill Modifications\s+([\s\S]*?)(?=\n##\s+|$)/i)?.[1] ?? '';
  const personalitySection =
    markdown.match(/## Suggested Personality Tweaks\s+([\s\S]*?)(?=\n##\s+|$)/i)?.[1] ?? '';

  const parseBullets = (section: string): string[] =>
    section
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith('- '))
      .map((line) => normalizeText(line.slice(2)))
      .filter((line) => line.length > 0 && line.toLowerCase() !== 'none proposed.');

  const totalInteractions = Number(markdown.match(/Total interactions:\s*(\d+)/i)?.[1] ?? 0);
  const positiveSignals = Number(markdown.match(/Positive signals:\s*(\d+)/i)?.[1] ?? 0);
  const negativeSignals = Number(markdown.match(/Negative signals:\s*(\d+)/i)?.[1] ?? 0);

  return {
    summary,
    skillChanges: parseBullets(skillSection),
    personalityTweaks: parseBullets(personalitySection),
    totalInteractions: Number.isFinite(totalInteractions) ? totalInteractions : 0,
    positiveSignals: Number.isFinite(positiveSignals) ? positiveSignals : 0,
    negativeSignals: Number.isFinite(negativeSignals) ? negativeSignals : 0,
  };
}

function resolveChatId(inputChatId: string | number | undefined): string | null {
  if (typeof inputChatId === 'number') {
    return String(inputChatId);
  }

  if (typeof inputChatId === 'string' && inputChatId.trim().length > 0) {
    return inputChatId.trim();
  }

  return config.telegram.defaultChatId ?? null;
}

async function appendDecisionToProposal(
  proposalPath: string,
  input: {
    decision: 'approved' | 'rejected';
    userId: string;
    reason: string;
  },
): Promise<void> {
  const absoluteProposalPath = path.join(config.vault.rootPath, proposalPath);
  const existing = await readFileIfExists(absoluteProposalPath);
  if (!existing.trim()) {
    return;
  }

  const section = [
    '',
    '## Decision',
    `- Status: ${input.decision}`,
    `- Timestamp: ${new Date().toISOString()}`,
    `- User: ${input.userId}`,
    `- Reason: ${input.reason}`,
  ].join('\n');

  await fs.writeFile(absoluteProposalPath, `${existing.trimEnd()}\n${section}\n`, 'utf8');
}

function clampToRange(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value * 100) / 100));
}

async function deriveTriageWeightProposals(scorecard: TriageScorecard): Promise<TriageWeightProposal[]> {
  const proposals: TriageWeightProposal[] = [];

  let weights: TriageWeightBounds[];
  try {
    weights = await loadTriageWeightsWithBounds();
  } catch {
    return proposals;
  }

  if (scorecard.totalActions < 5) {
    return proposals;
  }

  const snoozeRate = scorecard.snoozeCount / scorecard.totalActions;
  const noReplyRate = scorecard.markedNoReply / scorecard.totalActions;

  if (snoozeRate > 0.3) {
    const deadlineWeight = weights.find((w) => w.key === 'deadlineLanguage');
    if (deadlineWeight) {
      const delta = deadlineWeight.current * 0.1;
      const proposed = clampToRange(deadlineWeight.current - delta, deadlineWeight.min, deadlineWeight.max);
      if (proposed !== deadlineWeight.current) {
        proposals.push({
          key: 'deadlineLanguage',
          currentValue: deadlineWeight.current,
          proposedValue: proposed,
          reason: `High snooze rate (${(snoozeRate * 100).toFixed(0)}%) suggests deadline scoring is too aggressive.`,
        });
      }
    }
  }

  if (noReplyRate > 0.25) {
    const needsReplyThreshold = weights.find((w) => w.key === 'senderImportance');
    if (needsReplyThreshold) {
      const delta = needsReplyThreshold.current * 0.1;
      const proposed = clampToRange(needsReplyThreshold.current - delta, needsReplyThreshold.min, needsReplyThreshold.max);
      if (proposed !== needsReplyThreshold.current) {
        proposals.push({
          key: 'senderImportance',
          currentValue: needsReplyThreshold.current,
          proposedValue: proposed,
          reason: `High no-reply rate (${(noReplyRate * 100).toFixed(0)}%) suggests sender importance is over-weighted.`,
        });
      }
    }
  }

  if (scorecard.ignoredUrgent > 0 && scorecard.totalActions > 10) {
    const questionWeight = weights.find((w) => w.key === 'directQuestion');
    if (questionWeight) {
      const delta = questionWeight.current * 0.1;
      const proposed = clampToRange(questionWeight.current + delta, questionWeight.min, questionWeight.max);
      if (proposed !== questionWeight.current) {
        proposals.push({
          key: 'directQuestion',
          currentValue: questionWeight.current,
          proposedValue: proposed,
          reason: `${scorecard.ignoredUrgent} urgent thread(s) were ignored; increase direct question weight.`,
        });
      }
    }
  }

  return proposals;
}

export async function generateWeeklyReview(referenceDate = new Date()): Promise<WeeklyReviewResult> {
  const weekInfo = getIsoWeekInfo(referenceDate);
  const dayStamps = datesForPastDays(7, referenceDate);

  const [interactionLogs, signalLogs, dailyReviews] = await Promise.all([
    Promise.all(
      dayStamps.map((dateStamp) =>
        readFileIfExists(path.join(config.vault.feedbackDir, 'interactions', `${dateStamp}.jsonl`)),
      ),
    ),
    Promise.all(
      dayStamps.map((dateStamp) =>
        readFileIfExists(
          path.join(config.vault.feedbackDir, 'interactions', `feedback-signals-${dateStamp}.jsonl`),
        ),
      ),
    ),
    Promise.all(
      dayStamps.map((dateStamp) => readFileIfExists(path.join(config.vault.feedbackDir, 'daily', `${dateStamp}.md`))),
    ),
  ]);

  const interactions = interactionLogs.flatMap((raw) => parseJsonLines<Interaction>(raw));
  const signalEvents = signalLogs.flatMap((raw) => parseJsonLines<{ type?: string }>(raw));
  const totalInteractions = interactions.length;
  const positiveSignals = signalEvents.filter((event) => event.type === 'thumbs_up').length;
  const negativeSignals = signalEvents.filter((event) => event.type === 'thumbs_down').length;
  const skillUsage = buildSkillUsage(interactions);
  const dailyReviewExcerpts = dailyReviews
    .map((review, index) => {
      if (!review.trim()) {
        return '';
      }

      const firstSentence =
        review
          .split(/\r?\n/)
          .map((line) => line.trim())
          .find((line) => line.length > 0 && !line.startsWith('#')) ?? 'Review logged.';
      return `${dayStamps[index]}: ${normalizeText(firstSentence)}`;
    })
    .filter((item) => item.length > 0)
    .slice(-7);

  const emailActionLogs = await Promise.all(
    dayStamps.map((dateStamp) =>
      readFileIfExists(path.join(config.vault.feedbackDir, 'interactions', `email-actions-${dateStamp}.jsonl`)),
    ),
  );
  const emailActions = emailActionLogs.flatMap((raw) => parseJsonLines<EmailActionEntry>(raw));

  const countType = (type: string): number =>
    emailActions.filter((entry) => entry.type === type).length;
  const countTriageAction = (action: string): number =>
    emailActions.filter((entry) => entry.details?.triageAction?.action === action).length;

  const triageScorecard: TriageScorecard = {
    draftsGenerated: countType('email_draft_generated'),
    sendConfirmed: countType('email_send_confirmed'),
    sendCanceled: countType('email_send_canceled'),
    snoozeCount: countTriageAction('snooze'),
    markedDone: countTriageAction('marked_done'),
    markedNoReply: countTriageAction('marked_no_reply'),
    ignoredUrgent: countTriageAction('ignored_urgent'),
    totalActions:
      countType('email_draft_generated') +
      countType('email_send_confirmed') +
      countTriageAction('snooze') +
      countTriageAction('marked_done') +
      countTriageAction('marked_no_reply'),
  };

  const triageWeightProposals = await deriveTriageWeightProposals(triageScorecard);

  const prompt = buildWeeklyPrompt(
    weekInfo.weekKey,
    totalInteractions,
    positiveSignals,
    negativeSignals,
    skillUsage,
    dailyReviewExcerpts,
  );
  const completion = await complete(prompt, 'tier3');
  const proposal =
    completion.ok && completion.data.text
      ? parseWeeklyModel(completion.data.text) ??
        fallbackProposal(
          weekInfo.weekKey,
          totalInteractions,
          positiveSignals,
          negativeSignals,
          skillUsage,
        )
      : fallbackProposal(
          weekInfo.weekKey,
          totalInteractions,
          positiveSignals,
          negativeSignals,
          skillUsage,
        );

  const proposalRelativePath = path.join('feedback', 'weekly', `${weekInfo.weekKey}.md`);
  const proposalAbsolutePath = path.join(config.vault.rootPath, proposalRelativePath);
  const proposalMarkdown = renderWeeklyProposalMarkdown(
    weekInfo.weekKey,
    { totalInteractions, positiveSignals, negativeSignals },
    skillUsage,
    dailyReviewExcerpts,
    proposal,
    weekInfo.branchName,
    weekInfo.weekTag,
    triageScorecard,
    triageWeightProposals,
  );

  const defaultBranch = await getDefaultBranch();
  await checkoutBranch(defaultBranch);
  await tag(weekInfo.weekTag);
  await createBranch(weekInfo.branchName);

  await fs.mkdir(path.dirname(proposalAbsolutePath), { recursive: true });
  await fs.writeFile(proposalAbsolutePath, proposalMarkdown, 'utf8');

  const branchCommit = await commit(`week ${weekInfo.weekKey} adaptation proposal`, 'adapt');
  await checkoutBranch(defaultBranch);

  await writePendingApproval({
    weekKey: weekInfo.weekKey,
    weekTag: weekInfo.weekTag,
    branchName: weekInfo.branchName,
    proposalPath: proposalRelativePath,
    createdAt: new Date().toISOString(),
  });

  return {
    weekKey: weekInfo.weekKey,
    weekTag: weekInfo.weekTag,
    branchName: weekInfo.branchName,
    proposalPath: proposalRelativePath,
    totalInteractions,
    positiveSignals,
    negativeSignals,
    skillUsage,
    proposal,
    triageScorecard,
    triageWeightProposals,
    commitHash: branchCommit.hash,
  };
}

export async function handleWeeklyApprovalDecision(
  input: WeeklyApprovalDecisionInput,
): Promise<WeeklyApprovalDecisionResult> {
  const pending = await readPendingApproval();
  if (!pending) {
    return {
      status: 'ignored',
      message: 'No pending weekly adaptation proposal found.',
    };
  }

  if (pending.weekKey !== input.weekKey) {
    return {
      status: 'ignored',
      message: `Pending proposal is ${pending.weekKey}, not ${input.weekKey}.`,
    };
  }

  const reason = input.reason?.trim() || `Decision recorded by user ${input.userId}`;
  const defaultBranch = await getDefaultBranch();

  if (input.decision === 'approve') {
    await checkoutBranch(pending.branchName);
    const proposalAbsolutePath = path.join(config.vault.rootPath, pending.proposalPath);
    const proposalFromBranch = await readFileIfExists(proposalAbsolutePath);
    const snapshot = parseProposalSnapshot(proposalFromBranch);
    await appendDecisionToProposal(pending.proposalPath, {
      decision: 'approved',
      userId: input.userId,
      reason,
    });
    await commit(`week ${pending.weekKey} approval metadata`, 'adapt');
    await checkoutBranch(defaultBranch);
    await writePendingApproval(null);
    await mergeBranch(pending.branchName, {
      commitMessage: `week ${pending.weekKey} approved changes`,
      commitType: 'adapt',
    });
    await deleteBranch(pending.branchName, true);
    await appendEvolutionLogEntry({
      weekKey: pending.weekKey,
      decision: 'approved',
      weekTag: pending.weekTag,
      totalInteractions: snapshot.totalInteractions,
      positiveSignals: snapshot.positiveSignals,
      negativeSignals: snapshot.negativeSignals,
      summary: snapshot.summary,
      skillChanges: snapshot.skillChanges,
      personalityTweaks: snapshot.personalityTweaks,
    });
    await commit(`week ${pending.weekKey} evolution log updated`, 'adapt');

    return {
      status: 'approved',
      message: `Approved and merged weekly proposal ${pending.weekKey}.`,
    };
  }

  await checkoutBranch(pending.branchName);
  const proposalAbsolutePath = path.join(config.vault.rootPath, pending.proposalPath);
  const proposalFromBranch = await readFileIfExists(proposalAbsolutePath);
  const snapshot = parseProposalSnapshot(proposalFromBranch);
  await checkoutBranch(defaultBranch);
  await fs.mkdir(path.dirname(proposalAbsolutePath), { recursive: true });
  const rejectionBlock = [
    proposalFromBranch.trimEnd(),
    '',
    '## Decision',
    `- Status: rejected`,
    `- Timestamp: ${new Date().toISOString()}`,
    `- User: ${input.userId}`,
    `- Reason: ${reason}`,
  ].join('\n');
  await fs.writeFile(proposalAbsolutePath, `${rejectionBlock}\n`, 'utf8');
  await commit(`week ${pending.weekKey} rejected proposal`, 'adapt');
  await deleteBranch(pending.branchName, true);
  await appendEvolutionLogEntry({
    weekKey: pending.weekKey,
    decision: 'rejected',
    weekTag: pending.weekTag,
    totalInteractions: snapshot.totalInteractions,
    positiveSignals: snapshot.positiveSignals,
    negativeSignals: snapshot.negativeSignals,
    summary: snapshot.summary,
    skillChanges: snapshot.skillChanges,
    personalityTweaks: snapshot.personalityTweaks,
  });
  await commit(`week ${pending.weekKey} evolution log updated`, 'adapt');
  await writePendingApproval(null);

  return {
    status: 'rejected',
    message: `Rejected weekly proposal ${pending.weekKey}; branch deleted and notes retained in ${pending.proposalPath}.`,
  };
}

export function scheduleWeekly(options: ScheduleWeeklyOptions): ScheduledTask | null {
  const chatId = resolveChatId(options.chatId);
  if (!chatId) {
    console.warn('[tone] weekly scheduler disabled: no target Telegram chat id configured');
    return null;
  }

  return cron.schedule(
    config.loops.weeklyCron,
    async () => {
      try {
        const review = await generateWeeklyReview();
        const summaryLines = [
          `Weekly adaptation review (${review.weekKey})`,
          `Interactions: ${review.totalInteractions} | +${review.positiveSignals} / -${review.negativeSignals}`,
          '',
          `Summary: ${review.proposal.summary}`,
          '',
          'Top proposed skill changes:',
          ...(review.proposal.skillChanges.length > 0
            ? review.proposal.skillChanges.slice(0, 3).map((line) => `- ${line}`)
            : ['- None']),
        ];

        await options.bot.telegram.sendMessage(chatId, summaryLines.join('\n'), {
          reply_markup: Markup.inlineKeyboard([
            [
              Markup.button.callback('Approve', `weekly:approve:${review.weekKey}`),
              Markup.button.callback('Reject', `weekly:reject:${review.weekKey}`),
            ],
          ]).reply_markup,
        });
      } catch (error) {
        console.error('[tone] weekly review failed', error);
      }
    },
    {
      timezone: config.timezone,
    },
  );
}

export type { WeeklyReviewResult };
