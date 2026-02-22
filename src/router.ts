import { config } from './config.js';
import { complete } from './llm.js';
import type { InteractionIntent, RouterResult, SkillDefinition } from './types.js';

export interface RouteOptions {
  skillDefinitions?: SkillDefinition[];
  confidenceThreshold?: number;
}

interface RouterModelPayload {
  intent?: unknown;
  confidence?: unknown;
  extractedEntities?: unknown;
}

const ROUTER_INTENTS: InteractionIntent[] = [
  'capture',
  'task',
  'draft',
  'chat',
  'rollback',
  'introspection',
];

const DEFAULT_THRESHOLD = 0.7;

function normalizeThreshold(value: number | undefined): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return DEFAULT_THRESHOLD;
  }

  if (value < 0) {
    return 0;
  }

  if (value > 1) {
    return 1;
  }

  return value;
}

function normalizeIntent(value: unknown): InteractionIntent {
  if (typeof value !== 'string') {
    return 'chat';
  }

  const normalized = value.trim().toLowerCase();
  if (ROUTER_INTENTS.includes(normalized as InteractionIntent)) {
    return normalized as InteractionIntent;
  }

  return 'chat';
}

function normalizeConfidence(value: unknown): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return 0;
  }

  if (value < 0) {
    return 0;
  }

  if (value > 1) {
    return 1;
  }

  return value;
}

function normalizeEntities(value: unknown): RouterResult['extractedEntities'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const entries = Object.entries(value as Record<string, unknown>);
  const normalizedEntries = entries
    .map(([key, rawValue]) => {
      if (
        typeof rawValue === 'string' ||
        typeof rawValue === 'number' ||
        typeof rawValue === 'boolean' ||
        rawValue === null
      ) {
        return [key, rawValue] as const;
      }

      return null;
    })
    .filter((entry): entry is readonly [string, string | number | boolean | null] => entry !== null);

  return Object.fromEntries(normalizedEntries);
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

function parseModelPayload(rawText: string): RouterResult | undefined {
  const jsonCandidate = extractJsonCandidate(rawText);
  if (!jsonCandidate) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(jsonCandidate) as RouterModelPayload;
    return {
      intent: normalizeIntent(parsed.intent),
      confidence: normalizeConfidence(parsed.confidence),
      extractedEntities: normalizeEntities(parsed.extractedEntities),
    };
  } catch {
    return undefined;
  }
}

function summarizeSkillDefinitions(skillDefinitions: SkillDefinition[]): string {
  if (skillDefinitions.length === 0) {
    return 'No skills loaded from vault.';
  }

  return skillDefinitions
    .map((skill) => {
      const triggerSummary = skill.triggers.length > 0 ? skill.triggers.join(', ') : '(none)';
      return `- ${skill.name}: triggers=${triggerSummary}`;
    })
    .join('\n');
}

function heuristicIntent(message: string): RouterResult {
  const lowered = message.toLowerCase();
  const entities: RouterResult['extractedEntities'] = {};

  if (/\b(rollback|revert|undo|go back|snapshot)\b/.test(lowered)) {
    const weekMatch = lowered.match(/week\s+(\d{1,2})/);
    if (weekMatch?.[1]) {
      entities.reference = `week-${weekMatch[1].padStart(2, '0')}`;
    }

    return {
      intent: 'rollback',
      confidence: 0.82,
      extractedEntities: entities,
    };
  }

  if (/\b(what'?s changed|how have you evolved|since week|since)\b/.test(lowered)) {
    const sinceMatch = lowered.match(/since\s+([^?.!]+)/);
    if (sinceMatch?.[1]) {
      entities.since = sinceMatch[1].trim();
    }

    return {
      intent: 'introspection',
      confidence: 0.8,
      extractedEntities: entities,
    };
  }

  if (/\b(add task|complete task|list tasks|someday|task)\b/.test(lowered)) {
    if (/\b(list tasks|show tasks|what.*tasks)\b/.test(lowered)) {
      entities.action = 'list';
    } else if (/\b(complete task|done|finish|mark .*complete)\b/.test(lowered)) {
      entities.action = 'complete';
    } else if (/\b(someday|later)\b/.test(lowered)) {
      entities.action = 'someday';
    } else {
      entities.action = 'add';
    }

    const taskMatch = message.match(/(?:add task|task|complete task|someday)\s*:?\s*(.+)$/i);
    if (taskMatch?.[1]) {
      entities.task = taskMatch[1].trim();
    }

    return {
      intent: 'task',
      confidence: 0.8,
      extractedEntities: entities,
    };
  }

  if (/\b(draft|write a message|compose|reply to)\b/.test(lowered)) {
    const recipientMatch = message.match(/(?:to|for)\s+([^,.!?:\n]+)/i);
    if (recipientMatch?.[1]) {
      entities.recipient = recipientMatch[1].trim();
    }

    return {
      intent: 'draft',
      confidence: 0.78,
      extractedEntities: entities,
    };
  }

  if (/\b(capture|note this|remember this|log this)\b/.test(lowered)) {
    const captureMatch = message.match(/(?:capture|note this|remember this)\s*:?\s*(.+)$/i);
    if (captureMatch?.[1]) {
      entities.topic = captureMatch[1].trim();
    }

    return {
      intent: 'capture',
      confidence: 0.77,
      extractedEntities: entities,
    };
  }

  return {
    intent: 'chat',
    confidence: 0.74,
    extractedEntities: {},
  };
}

function buildRoutingPrompt(message: string, skillDefinitions: SkillDefinition[]): string {
  const skillSummary = summarizeSkillDefinitions(skillDefinitions);

  return [
    'You are an intent router for a Telegram personal assistant.',
    'Classify the user message into one intent from this exact set:',
    'capture, task, draft, chat, rollback, introspection.',
    'Use skill trigger hints when relevant.',
    'Return strict JSON only with keys: intent, confidence, extractedEntities.',
    'Confidence must be a number between 0 and 1.',
    'extractedEntities must be a flat object of primitive values.',
    '',
    'Skill trigger hints:',
    skillSummary,
    '',
    'User message:',
    message,
  ].join('\n');
}

export async function route(message: string, options?: RouteOptions): Promise<RouterResult> {
  const trimmedMessage = message.trim();
  if (trimmedMessage.length === 0) {
    return {
      intent: 'chat',
      confidence: 1,
      extractedEntities: {},
    };
  }

  const confidenceThreshold = normalizeThreshold(
    options?.confidenceThreshold ?? config.routing?.confidenceThreshold ?? DEFAULT_THRESHOLD,
  );

  const skillDefinitions = options?.skillDefinitions ?? [];
  const prompt = buildRoutingPrompt(trimmedMessage, skillDefinitions);

  let routed = heuristicIntent(trimmedMessage);

  const completion = await complete(prompt, 'tier1');
  if (completion.ok) {
    const parsed = parseModelPayload(completion.data.text);
    if (parsed) {
      routed = parsed;
    }
  }

  if (routed.confidence < confidenceThreshold) {
    return {
      intent: 'chat',
      confidence: routed.confidence,
      extractedEntities: routed.extractedEntities,
    };
  }

  return routed;
}
