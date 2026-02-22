import { config as loadDotEnv } from 'dotenv';
import path from 'node:path';
import type { LLMTier, VaultConfig } from './types.js';

loadDotEnv();

type TranscriptionProviderKind = 'deepgram' | 'voxtral';

interface AppConfig {
  telegramBotToken: string;
  openRouterApiKey: string;
  timezone: string;
  routing: {
    confidenceThreshold: number;
  };
  vault: VaultConfig;
  openRouter: {
    baseUrl: string;
    httpReferer: string;
    xTitle: string;
  };
  llmTiers: {
    tier1: LLMTier;
    tier2: LLMTier;
    tier3: LLMTier;
  };
  transcription: {
    provider: TranscriptionProviderKind;
    deepgramModel: string;
    voxtralModel: string;
    deepgramApiKey?: string;
    voxtralEndpoint?: string;
    voxtralApiKey?: string;
  };
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value.trim();
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    return undefined;
  }

  return value.trim();
}

function validateTimezone(timezone: string): string {
  try {
    Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
    return timezone;
  } catch {
    throw new Error(
      `Invalid TONE_TIMEZONE: \"${timezone}\". Example valid value: \"Europe/London\".`,
    );
  }
}

function validateVaultPath(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (trimmed.length === 0) {
    throw new Error('VAULT_PATH must not be empty.');
  }

  return path.resolve(trimmed);
}

function validateTranscriptionProvider(rawProvider: string | undefined): TranscriptionProviderKind {
  const normalized = (rawProvider ?? 'deepgram').trim().toLowerCase();
  if (normalized === 'deepgram' || normalized === 'voxtral') {
    return normalized;
  }

  throw new Error(
    `Invalid TRANSCRIPTION_PROVIDER: \"${normalized}\". Expected \"deepgram\" or \"voxtral\".`,
  );
}

function parseConfidenceThreshold(rawValue: string | undefined): number {
  if (rawValue === undefined || rawValue.trim() === '') {
    return 0.7;
  }

  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(
      `Invalid ROUTER_CONFIDENCE_THRESHOLD: \"${rawValue}\". Expected a number between 0 and 1.`,
    );
  }

  return parsed;
}

function buildVaultConfig(rootPath: string): VaultConfig {
  return {
    rootPath,
    inboxDir: path.join(rootPath, '_inbox'),
    threadsDir: path.join(rootPath, 'threads'),
    tasksDir: path.join(rootPath, 'tasks'),
    projectsDir: path.join(rootPath, 'projects'),
    peopleDir: path.join(rootPath, 'people'),
    dailyDir: path.join(rootPath, 'daily'),
    skillsDir: path.join(rootPath, 'skills'),
    configDir: path.join(rootPath, 'config'),
    feedbackDir: path.join(rootPath, 'feedback'),
  };
}

function buildTranscriptionConfig(provider: TranscriptionProviderKind): AppConfig['transcription'] {
  const deepgramModel = optionalEnv('DEEPGRAM_MODEL') ?? 'nova-2';
  const voxtralModel = optionalEnv('VOXTRAL_MODEL') ?? 'mistral-voxtral-mini-latest';

  if (provider === 'deepgram') {
    const deepgramApiKey = requiredEnv('DEEPGRAM_API_KEY');
    return {
      provider,
      deepgramModel,
      voxtralModel,
      deepgramApiKey,
    };
  }

  const voxtralEndpoint = requiredEnv('VOXTRAL_ENDPOINT');
  const voxtralApiKey = optionalEnv('VOXTRAL_API_KEY');

  return {
    provider,
    deepgramModel,
    voxtralModel,
    voxtralEndpoint,
    ...(voxtralApiKey ? { voxtralApiKey } : {}),
  };
}

const timezone = validateTimezone(requiredEnv('TONE_TIMEZONE'));
const vaultRoot = validateVaultPath(requiredEnv('VAULT_PATH'));
const transcriptionProvider = validateTranscriptionProvider(process.env.TRANSCRIPTION_PROVIDER);
const routerConfidenceThreshold = parseConfidenceThreshold(process.env.ROUTER_CONFIDENCE_THRESHOLD);

export const config: AppConfig = {
  telegramBotToken: requiredEnv('TELEGRAM_BOT_TOKEN'),
  openRouterApiKey: requiredEnv('OPENROUTER_API_KEY'),
  timezone,
  routing: {
    confidenceThreshold: routerConfidenceThreshold,
  },
  vault: buildVaultConfig(vaultRoot),
  openRouter: {
    baseUrl: optionalEnv('OPENROUTER_BASE_URL') ?? 'https://openrouter.ai/api/v1',
    httpReferer: optionalEnv('OPENROUTER_HTTP_REFERER') ?? 'https://github.com/tone',
    xTitle: optionalEnv('OPENROUTER_X_TITLE') ?? 'Tone',
  },
  llmTiers: {
    tier1: {
      id: 'tier1',
      model: 'gemini-2.0-flash',
      temperature: 0.2,
      maxTokens: 1200,
    },
    tier2: {
      id: 'tier2',
      model: 'minimax/minimax-m2.5',
      temperature: 0.4,
      maxTokens: 2400,
    },
    tier3: {
      id: 'tier3',
      model: 'google/gemini-3.1-pro-preview',
      temperature: 0.3,
      maxTokens: 3200,
    },
  },
  transcription: buildTranscriptionConfig(transcriptionProvider),
};

export type { AppConfig, TranscriptionProviderKind };
