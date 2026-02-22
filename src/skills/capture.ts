import { config } from '../config.js';
import { complete } from '../llm.js';
import { appendNote, listNotes } from '../vault.js';
import type { SkillHandler, SkillResult } from './types.js';

interface CaptureTargetDecision {
  target?: unknown;
  threadPath?: unknown;
  topic?: unknown;
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

function extractJsonCandidate(text: string): string | undefined {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }

  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || firstBrace > lastBrace) {
    return undefined;
  }

  return text.slice(firstBrace, lastBrace + 1);
}

function parseDecision(raw: string): CaptureTargetDecision | undefined {
  const jsonCandidate = extractJsonCandidate(raw);
  if (!jsonCandidate) {
    return undefined;
  }

  try {
    return JSON.parse(jsonCandidate) as CaptureTargetDecision;
  } catch {
    return undefined;
  }
}

async function listThreadCandidates(): Promise<string[]> {
  try {
    const notes = await listNotes('threads');
    return notes
      .map((note) => note.path)
      .filter((notePath) => notePath.toLowerCase().endsWith('.md'))
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function buildRoutingPrompt(text: string, threadCandidates: string[]): string {
  return [
    'Choose where to file this captured note.',
    'Output strict JSON only with keys: target, threadPath, topic.',
    'target must be either "thread" or "inbox".',
    'Set threadPath to one of the provided thread paths when target=thread.',
    'Set threadPath to null when target=inbox.',
    'topic should be a short classification label.',
    '',
    `Thread candidates (${threadCandidates.length}):`,
    threadCandidates.length > 0 ? threadCandidates.map((path) => `- ${path}`).join('\n') : '- (none)',
    '',
    'Captured message:',
    text,
  ].join('\n');
}

async function chooseTargetFile(text: string): Promise<{ targetPath: string; topic: string | null }> {
  const threadCandidates = await listThreadCandidates();
  const fallbackPath = `_inbox/${dateStampInTimezone(new Date())}.md`;

  if (threadCandidates.length === 0) {
    return {
      targetPath: fallbackPath,
      topic: null,
    };
  }

  const completion = await complete(buildRoutingPrompt(text, threadCandidates), 'tier1');
  if (!completion.ok) {
    return {
      targetPath: fallbackPath,
      topic: null,
    };
  }

  const parsed = parseDecision(completion.data.text);
  if (!parsed) {
    return {
      targetPath: fallbackPath,
      topic: null,
    };
  }

  const target = typeof parsed.target === 'string' ? parsed.target.trim().toLowerCase() : '';
  const threadPath = typeof parsed.threadPath === 'string' ? parsed.threadPath.trim() : '';
  const topic = typeof parsed.topic === 'string' && parsed.topic.trim().length > 0 ? parsed.topic.trim() : null;

  if (target === 'thread' && threadCandidates.includes(threadPath)) {
    return {
      targetPath: threadPath,
      topic,
    };
  }

  return {
    targetPath: fallbackPath,
    topic,
  };
}

export const captureSkill: SkillHandler = {
  name: 'capture',
  async execute(input): Promise<SkillResult> {
    const normalizedText = input.text.trim();
    if (normalizedText.length === 0) {
      return {
        status: 'needs_clarification',
        intent: 'capture',
        response: 'I need some text to capture. Send a note or voice message with content.',
      };
    }

    const chosen = await chooseTargetFile(normalizedText);
    const sourceLabel = input.input.type === 'voice' ? 'voice' : 'text';
    const timestamp = new Date().toISOString();
    const line = `- [${timestamp}] (${sourceLabel}) ${normalizedText}`;

    await appendNote(chosen.targetPath, line);

    const topicSuffix = chosen.topic ? ` Topic: ${chosen.topic}.` : '';

    return {
      status: 'success',
      intent: 'capture',
      response: `Captured in ${chosen.targetPath}.${topicSuffix}`,
      metadata: {
        targetPath: chosen.targetPath,
        source: sourceLabel,
      },
    };
  },
};
