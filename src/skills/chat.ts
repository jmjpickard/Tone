import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { chat } from '../llm.js';
import { readNote } from '../vault.js';
import type { Interaction } from '../types.js';
import type { SkillHandler, SkillResult } from './types.js';

interface InteractionPreview {
  timestamp: string;
  userMessage: string;
  assistantResponse: string;
}

const ONBOARDING_CONTEXT_THRESHOLD = 8;
const MIN_PROFILE_FACTS = 3;

function extractInputText(input: Interaction['input'] | unknown): string {
  if (!input || typeof input !== 'object' || !('type' in input)) {
    return '';
  }

  const typedInput = input as Interaction['input'];
  if (typedInput.type === 'text') {
    return typedInput.text;
  }

  if (typedInput.type === 'voice') {
    return typedInput.transcript;
  }

  return '';
}

function parseInteractionLine(line: string): InteractionPreview | undefined {
  if (!line.trim()) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(line) as Partial<Interaction>;
    if (typeof parsed.timestamp !== 'string' || typeof parsed.response !== 'string') {
      return undefined;
    }

    const userMessage = extractInputText(parsed.input);
    if (!userMessage.trim()) {
      return undefined;
    }

    return {
      timestamp: parsed.timestamp,
      userMessage: userMessage.trim(),
      assistantResponse: parsed.response.trim(),
    };
  } catch {
    return undefined;
  }
}

async function loadRecentInteractionPreviews(limit: number): Promise<InteractionPreview[]> {
  const interactionsDir = path.join(config.vault.feedbackDir, 'interactions');

  let fileNames: string[];
  try {
    fileNames = await fs.readdir(interactionsDir);
  } catch {
    return [];
  }

  const dailyFiles = fileNames
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
    .sort((a, b) => b.localeCompare(a));

  const collected: InteractionPreview[] = [];

  for (const fileName of dailyFiles) {
    const absolutePath = path.join(interactionsDir, fileName);
    let raw = '';

    try {
      raw = await fs.readFile(absolutePath, 'utf8');
    } catch {
      continue;
    }

    const lines = raw.split(/\r?\n/);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index];
      if (!line) {
        continue;
      }

      const parsed = parseInteractionLine(line);
      if (!parsed) {
        continue;
      }

      collected.push(parsed);
      if (collected.length >= limit) {
        return collected.reverse();
      }
    }
  }

  return collected.reverse();
}

async function readPersonality(): Promise<string> {
  try {
    const note = await readNote('config/personality.md');
    return note.content.trim();
  } catch {
    return '';
  }
}

async function readAboutUser(): Promise<string> {
  try {
    const note = await readNote('config/about-user.md');
    return note.content.trim();
  } catch {
    return '';
  }
}

function countProfileFacts(aboutUser: string): number {
  return aboutUser
    .split(/\r?\n/)
    .map((line) => line.trim())
    .reduce((count, line) => {
      if (!line.startsWith('-')) {
        return count;
      }

      const value = line.slice(1).trim();
      if (!value) {
        return count;
      }

      const separatorIndex = value.indexOf(':');
      if (separatorIndex === -1) {
        return count + 1;
      }

      const fieldValue = value.slice(separatorIndex + 1).trim();
      return fieldValue.length > 0 ? count + 1 : count;
    }, 0);
}

function shouldUseOnboardingMode(aboutUser: string, previews: InteractionPreview[]): boolean {
  const profileFacts = countProfileFacts(aboutUser);
  return profileFacts < MIN_PROFILE_FACTS || previews.length < ONBOARDING_CONTEXT_THRESHOLD;
}

function formatRecentContext(previews: InteractionPreview[]): string {
  if (previews.length === 0) {
    return '(none)';
  }

  return previews
    .map((preview) => {
      const user = preview.userMessage.replace(/\s+/g, ' ').trim();
      const assistant = preview.assistantResponse.replace(/\s+/g, ' ').trim();
      return `${preview.timestamp}\nuser: ${user}\nassistant: ${assistant}`;
    })
    .join('\n\n');
}

export const chatSkill: SkillHandler = {
  name: 'chat',
  async execute(input): Promise<SkillResult> {
    const [personality, aboutUser, recentPreviews] = await Promise.all([
      readPersonality(),
      readAboutUser(),
      loadRecentInteractionPreviews(6),
    ]);
    const onboardingMode = shouldUseOnboardingMode(aboutUser, recentPreviews);
    const onboardingGuidance = onboardingMode
      ? [
          'Onboarding mode is active.',
          'Sound engaged, curious, and owner-focused.',
          'In each response: answer the user directly, ask up to two focused follow-up questions, and suggest one concrete way Tone can help this week.',
          'Avoid detached or generic phrasing.',
        ].join('\n')
      : 'Continue adapting to the user context while remaining concise and practical.';

    const messages = [
      {
        role: 'system' as const,
        content: [
          'You are Tone, a personal AI assistant.',
          'Your primary mission is to understand this specific user and make yourself progressively more useful to them.',
          'Respond concisely, clearly, and pragmatically.',
          'Do not fabricate facts or private context.',
          '',
          onboardingGuidance,
          '',
          'Personality guidance:',
          personality || '(no personality file found)',
          '',
          'About user note:',
          aboutUser || '(no about-user note found)',
          '',
          'Recent interaction context:',
          formatRecentContext(recentPreviews),
        ].join('\n'),
      },
      {
        role: 'user' as const,
        content: input.text,
      },
    ];

    const completion = await chat(messages, 'tier2');
    if (!completion.ok) {
      return {
        status: 'error',
        intent: 'chat',
        response: 'I could not generate a response right now. Please try again.',
      };
    }

    const responseText = completion.data.text.trim();

    return {
      status: 'success',
      intent: 'chat',
      response: responseText || 'I do not have a response yet.',
    };
  },
};
