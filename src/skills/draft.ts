import path from 'node:path';
import { complete } from '../llm.js';
import { listNotes, readNote } from '../vault.js';
import type { SkillExecutionInput, SkillHandler, SkillResult } from './types.js';

interface DraftPayload {
  subject?: unknown;
  draft?: unknown;
  rationale?: unknown;
}

function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function extractRecipient(input: SkillExecutionInput): string {
  const recipientEntity = input.entities.recipient;
  if (typeof recipientEntity === 'string' && recipientEntity.trim().length > 0) {
    return recipientEntity.trim();
  }

  const quoted = input.text.match(/(?:to|for)\s+"([^"]+)"/i);
  if (quoted?.[1]) {
    return quoted[1].trim();
  }

  const inline = input.text.match(/(?:to|for)\s+([^,.!?:\n]+)/i);
  if (inline?.[1]) {
    return inline[1].trim();
  }

  return '';
}

function extractIntent(input: SkillExecutionInput): string {
  const intentEntity = input.entities.intent;
  if (typeof intentEntity === 'string' && intentEntity.trim().length > 0) {
    return intentEntity.trim();
  }

  const aboutMatch = input.text.match(/(?:about|regarding)\s+(.+)$/i);
  if (aboutMatch?.[1]) {
    return aboutMatch[1].trim();
  }

  const colonMatch = input.text.match(/:\s*(.+)$/);
  if (colonMatch?.[1]) {
    return colonMatch[1].trim();
  }

  return input.text.trim();
}

async function readOptionalMarkdown(notePath: string): Promise<string> {
  try {
    const note = await readNote(notePath);
    return note.content.trim();
  } catch {
    return '';
  }
}

async function loadRecipientContext(recipient: string): Promise<string> {
  try {
    const notes = await listNotes('people');
    const normalizedRecipient = normalizeName(recipient);

    const match = notes.find((note) => {
      const basename = path.basename(note.path, '.md');
      const normalizedBase = normalizeName(basename);
      return (
        normalizedBase === normalizedRecipient ||
        normalizedBase.includes(normalizedRecipient) ||
        normalizedRecipient.includes(normalizedBase)
      );
    });

    if (!match) {
      return '';
    }

    const recipientNote = await readOptionalMarkdown(match.path);
    if (!recipientNote) {
      return '';
    }

    return `Source: ${match.path}\n${recipientNote.slice(0, 1500)}`;
  } catch {
    return '';
  }
}

function extractJsonCandidate(text: string): string | undefined {
  const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch?.[1]) {
    return fencedMatch[1].trim();
  }

  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || firstBrace > lastBrace) {
    return undefined;
  }

  return text.slice(firstBrace, lastBrace + 1);
}

function parseDraftPayload(raw: string): { subject?: string; draft: string; rationale?: string } | undefined {
  const candidate = extractJsonCandidate(raw);
  if (!candidate) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(candidate) as DraftPayload;
    const draft = typeof parsed.draft === 'string' ? parsed.draft.trim() : '';
    if (!draft) {
      return undefined;
    }

    return {
      draft,
      ...(typeof parsed.subject === 'string' && parsed.subject.trim().length > 0
        ? { subject: parsed.subject.trim() }
        : {}),
      ...(typeof parsed.rationale === 'string' && parsed.rationale.trim().length > 0
        ? { rationale: parsed.rationale.trim() }
        : {}),
    };
  } catch {
    return undefined;
  }
}

function buildPrompt(args: {
  recipient: string;
  intent: string;
  personality: string;
  recipientContext: string;
  originalRequest: string;
}): string {
  return [
    'Generate a concise communication draft for the user.',
    'Return strict JSON only with keys: subject, draft, rationale.',
    'If no subject is needed, set subject to an empty string.',
    'Do not include markdown code fences.',
    '',
    'Personality guidance:',
    args.personality || '(no explicit personality file found)',
    '',
    `Recipient: ${args.recipient}`,
    `Intent: ${args.intent}`,
    '',
    'Recipient context:',
    args.recipientContext || '(no recipient context found)',
    '',
    'Original request:',
    args.originalRequest,
  ].join('\n');
}

export const draftSkill: SkillHandler = {
  name: 'draft',
  async execute(input): Promise<SkillResult> {
    const recipient = extractRecipient(input);
    if (!recipient) {
      return {
        status: 'needs_clarification',
        intent: 'draft',
        response: 'Who should this draft be for?',
      };
    }

    const intentSummary = extractIntent(input);
    const [personality, recipientContext] = await Promise.all([
      readOptionalMarkdown('config/personality.md'),
      loadRecipientContext(recipient),
    ]);

    const completion = await complete(
      buildPrompt({
        recipient,
        intent: intentSummary,
        personality,
        recipientContext,
        originalRequest: input.text,
      }),
      'tier2',
    );

    if (!completion.ok) {
      return {
        status: 'error',
        intent: 'draft',
        response: 'I could not generate a draft right now. Please try again.',
      };
    }

    const parsedPayload = parseDraftPayload(completion.data.text);
    if (!parsedPayload) {
      return {
        status: 'success',
        intent: 'draft',
        response: completion.data.text.trim() || 'I generated an empty draft.',
      };
    }

    const outputLines = [`Draft for ${recipient}`];
    if (parsedPayload.subject) {
      outputLines.push(`Subject: ${parsedPayload.subject}`);
    }
    outputLines.push('', parsedPayload.draft);
    if (parsedPayload.rationale) {
      outputLines.push('', `Rationale: ${parsedPayload.rationale}`);
    }

    return {
      status: 'success',
      intent: 'draft',
      response: outputLines.join('\n'),
      metadata: {
        recipient,
      },
    };
  },
};
