import { config as loadDotEnv } from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { resolveToneEnvPath } from './paths.js';
import type { LLMTier, VaultConfig } from './types.js';

const toneEnvPath = resolveToneEnvPath();
loadDotEnv({ path: toneEnvPath });

const localEnvPath = path.resolve(process.cwd(), '.env');
if (localEnvPath !== toneEnvPath && fs.existsSync(localEnvPath)) {
  loadDotEnv({ path: localEnvPath, override: true });
}

type TranscriptionProviderKind = 'none' | 'deepgram' | 'voxtral';
type ResponseVerbosity = 'concise' | 'balanced' | 'detailed';

interface AppConfig {
  telegramBotToken: string;
  telegram: {
    defaultChatId?: string;
  };
  openRouterApiKey: string;
  timezone: string;
  routing: {
    confidenceThreshold: number;
  };
  loops: {
    briefingCron: string;
    nightlyCron: string;
    weeklyCron: string;
    defaultResponseVerbosity: ResponseVerbosity;
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
    const setupHints: Partial<Record<string, string>> = {
      TELEGRAM_BOT_TOKEN: 'Set your Telegram bot token from BotFather.',
      OPENROUTER_API_KEY: 'Set your OpenRouter API key (https://openrouter.ai/keys).',
      DEEPGRAM_API_KEY: 'Set your Deepgram API key when TRANSCRIPTION_PROVIDER=deepgram.',
      VOXTRAL_ENDPOINT: 'Set your Voxtral transcription endpoint when TRANSCRIPTION_PROVIDER=voxtral.',
      VAULT_PATH: 'Set an absolute path where the Tone vault should live.',
      TONE_TIMEZONE: 'Set an IANA timezone, for example Europe/London.',
    };

    const hint = setupHints[name];
    throw new Error(
      hint
        ? `Missing required environment variable: ${name}. ${hint} Run "tone onboard" to configure Tone.`
        : `Missing required environment variable: ${name}. Run "tone onboard" to configure Tone.`,
    );
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
  const normalized = (rawProvider ?? 'none').trim().toLowerCase();
  if (normalized === 'none' || normalized === 'deepgram' || normalized === 'voxtral') {
    return normalized;
  }

  throw new Error(
    `Invalid TRANSCRIPTION_PROVIDER: \"${normalized}\". Expected \"none\", \"deepgram\", or \"voxtral\".`,
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

function parseCronExpression(
  envName: 'BRIEFING_CRON' | 'NIGHTLY_CRON' | 'WEEKLY_CRON',
  fallback: string,
): string {
  const rawValue = optionalEnv(envName);
  if (!rawValue) {
    return fallback;
  }

  const parts = rawValue.split(/\s+/).filter((part) => part.length > 0);
  if (parts.length !== 5 && parts.length !== 6) {
    throw new Error(
      `Invalid ${envName}: \"${rawValue}\". Expected a cron expression with 5 or 6 fields.`,
    );
  }

  return rawValue;
}

function parseResponseVerbosity(rawValue: string | undefined): ResponseVerbosity {
  const normalized = (rawValue ?? 'balanced').trim().toLowerCase();
  if (normalized === 'concise' || normalized === 'balanced' || normalized === 'detailed') {
    return normalized;
  }

  throw new Error(
    `Invalid DEFAULT_RESPONSE_VERBOSITY: \"${normalized}\". Expected \"concise\", \"balanced\", or \"detailed\".`,
  );
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

  if (provider === 'none') {
    return {
      provider,
      deepgramModel,
      voxtralModel,
    };
  }

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
const defaultChatId = optionalEnv('TELEGRAM_DEFAULT_CHAT_ID');
const briefingCron = parseCronExpression('BRIEFING_CRON', '30 7 * * *');
const nightlyCron = parseCronExpression('NIGHTLY_CRON', '0 23 * * *');
const weeklyCron = parseCronExpression('WEEKLY_CRON', '0 15 * * 5');
const defaultResponseVerbosity = parseResponseVerbosity(process.env.DEFAULT_RESPONSE_VERBOSITY);

export const config: AppConfig = {
  telegramBotToken: requiredEnv('TELEGRAM_BOT_TOKEN'),
  telegram: {
    ...(defaultChatId ? { defaultChatId } : {}),
  },
  openRouterApiKey: requiredEnv('OPENROUTER_API_KEY'),
  timezone,
  routing: {
    confidenceThreshold: routerConfidenceThreshold,
  },
  loops: {
    briefingCron,
    nightlyCron,
    weeklyCron,
    defaultResponseVerbosity,
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

export type { AppConfig, ResponseVerbosity, TranscriptionProviderKind };
