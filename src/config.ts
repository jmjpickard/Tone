import { config as loadDotEnv } from 'dotenv';
import path from 'node:path';
import type { LLMTier, VaultConfig } from './types.js';

loadDotEnv();

interface AppConfig {
  telegramBotToken: string;
  openRouterApiKey: string;
  deepgramApiKey: string;
  timezone: string;
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
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
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

const timezone = validateTimezone(requiredEnv('TONE_TIMEZONE'));
const vaultRoot = validateVaultPath(requiredEnv('VAULT_PATH'));

export const config: AppConfig = {
  telegramBotToken: requiredEnv('TELEGRAM_BOT_TOKEN'),
  openRouterApiKey: requiredEnv('OPENROUTER_API_KEY'),
  deepgramApiKey: requiredEnv('DEEPGRAM_API_KEY'),
  timezone,
  vault: buildVaultConfig(vaultRoot),
  openRouter: {
    baseUrl: process.env.OPENROUTER_BASE_URL?.trim() || 'https://openrouter.ai/api/v1',
    httpReferer: process.env.OPENROUTER_HTTP_REFERER?.trim() || 'https://github.com/tone',
    xTitle: process.env.OPENROUTER_X_TITLE?.trim() || 'Tone',
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
      model: 'claude-sonnet-4-5',
      temperature: 0.4,
      maxTokens: 2400,
    },
    tier3: {
      id: 'tier3',
      model: 'claude-opus-4',
      temperature: 0.3,
      maxTokens: 3200,
    },
  },
};

export type { AppConfig };
