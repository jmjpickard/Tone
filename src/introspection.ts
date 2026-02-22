import {
  getCurrentTag,
  refExists,
  summarizeDiffInPlainEnglish,
  type EvolutionSummaryOptions,
} from './evolution.js';
import type { RouterResult } from './types.js';

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function parseEntityString(entities: RouterResult['extractedEntities'], key: string): string | null {
  const value = entities[key];
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = normalizeText(value);
  return normalized || null;
}

function parseWeekReference(input: string): string | null {
  const match = input.match(/week\s+(\d{1,2})/i);
  if (!match?.[1]) {
    return null;
  }
  return `week-${match[1].padStart(2, '0')}`;
}

function parseSincePhrase(text: string): string | null {
  const match = text.match(/\bsince\s+([^?.!]+)/i);
  if (!match?.[1]) {
    return null;
  }

  const candidate = normalizeText(match[1]).replace(/^tag\s+/i, '');
  return candidate || null;
}

async function resolveFromReference(
  text: string,
  entities: RouterResult['extractedEntities'],
): Promise<string> {
  const entityReference = parseEntityString(entities, 'reference');
  const entitySince = parseEntityString(entities, 'since');
  const weekFromText = parseWeekReference(text);
  const sinceFromText = parseSincePhrase(text);
  const currentTag = await getCurrentTag();

  const candidates = [
    entityReference,
    entitySince ? parseWeekReference(entitySince) ?? entitySince : null,
    weekFromText,
    sinceFromText ? parseWeekReference(sinceFromText) ?? sinceFromText : null,
    currentTag,
    'HEAD~20',
    'HEAD~10',
  ].filter((candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0);

  for (const candidate of candidates) {
    if (await refExists(candidate)) {
      return candidate;
    }
  }

  return 'HEAD';
}

export async function generateIntrospectionSummary(
  input: {
    text: string;
    entities: RouterResult['extractedEntities'];
    paths?: EvolutionSummaryOptions['paths'];
  },
): Promise<{
  fromRef: string;
  summary: string;
}> {
  const fromRef = await resolveFromReference(input.text, input.entities);
  const summary = await summarizeDiffInPlainEnglish(fromRef, 'HEAD', {
    paths:
      input.paths ?? ['skills', 'config', 'feedback/autonomic.md', 'feedback/weekly', 'feedback/patterns.md'],
    maxCommits: 30,
  });

  return {
    fromRef,
    summary,
  };
}
