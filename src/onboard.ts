import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createInterface, type Interface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { resolveToneEnvPath, resolveToneHomePath } from './paths.js';

const execFileAsync = promisify(execFile);
const BASE_TAG = 'base-v0.1.0';
const VALID_TRANSCRIPTION_PROVIDERS = new Set(['none', 'deepgram', 'voxtral']);

type TranscriptionProvider = 'none' | 'deepgram' | 'voxtral';

interface OnboardingAnswers {
  telegramBotToken: string;
  telegramDefaultChatId: string;
  openRouterApiKey: string;
  gmailEnabled: boolean;
  gmailClientId: string;
  gmailClientSecret: string;
  gmailRedirectUri: string;
  gmailTokenPath: string;
  calendarEnabled: boolean;
  calendarSyncWindowDays: number;
  vaultPath: string;
  timezone: string;
  transcriptionProvider: TranscriptionProvider;
  deepgramApiKey: string;
  voxtralEndpoint: string;
  voxtralApiKey: string;
}

function parseEnvValue(rawValue: string): string {
  const trimmed = rawValue.trim();
  if (trimmed.length === 0) {
    return '';
  }

  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    const quote = trimmed[0];
    const inner = trimmed.slice(1, -1);
    if (quote === '"') {
      return inner.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
    return inner;
  }

  return trimmed;
}

function escapeEnvValue(value: string): string {
  if (value.length === 0) {
    return '';
  }

  if (/^[A-Za-z0-9_./:@-]+$/.test(value)) {
    return value;
  }

  return `"${value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"')}"`;
}

function formatEnvFile(entries: Record<string, string>): string {
  const orderedKeys = [
    'TELEGRAM_BOT_TOKEN',
    'TELEGRAM_DEFAULT_CHAT_ID',
    'OPENROUTER_API_KEY',
    'GMAIL_ENABLED',
    'GMAIL_CLIENT_ID',
    'GMAIL_CLIENT_SECRET',
    'GMAIL_REDIRECT_URI',
    'GMAIL_TOKEN_PATH',
    'CALENDAR_ENABLED',
    'CALENDAR_SYNC_WINDOW_DAYS',
    'DEEPGRAM_API_KEY',
    'VAULT_PATH',
    'TONE_TIMEZONE',
    'ROUTER_CONFIDENCE_THRESHOLD',
    'BRIEFING_CRON',
    'NIGHTLY_CRON',
    'WEEKLY_CRON',
    'DEFAULT_RESPONSE_VERBOSITY',
    'TRANSCRIPTION_PROVIDER',
    'VOXTRAL_ENDPOINT',
    'VOXTRAL_API_KEY',
    'VOXTRAL_MODEL',
    'DEEPGRAM_MODEL',
    'OPENROUTER_HTTP_REFERER',
    'OPENROUTER_X_TITLE',
  ];

  const seen = new Set<string>();
  const lines: string[] = [];

  for (const key of orderedKeys) {
    seen.add(key);
    lines.push(`${key}=${escapeEnvValue(entries[key] ?? '')}`);
  }

  const remainingKeys = Object.keys(entries)
    .filter((key) => !seen.has(key))
    .sort((a, b) => a.localeCompare(b));

  for (const key of remainingKeys) {
    lines.push(`${key}=${escapeEnvValue(entries[key] ?? '')}`);
  }

  return `${lines.join('\n')}\n`;
}

async function loadExistingEnv(envPath: string): Promise<Record<string, string>> {
  try {
    const raw = await fs.readFile(envPath, 'utf8');
    const parsed: Record<string, string> = {};

    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith('#')) {
        continue;
      }

      const separatorIndex = trimmed.indexOf('=');
      if (separatorIndex <= 0) {
        continue;
      }

      const key = trimmed.slice(0, separatorIndex).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        continue;
      }

      const value = trimmed.slice(separatorIndex + 1);
      parsed[key] = parseEnvValue(value);
    }

    return parsed;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return {};
    }
    throw error;
  }
}

function validateTimezone(timezone: string): boolean {
  try {
    Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function normalizeProvider(raw: string): TranscriptionProvider | null {
  const normalized = raw.trim().toLowerCase();
  if (VALID_TRANSCRIPTION_PROVIDERS.has(normalized)) {
    return normalized as TranscriptionProvider;
  }
  return null;
}

function parseBooleanInput(raw: string): boolean | null {
  const normalized = raw.trim().toLowerCase();
  if (normalized.length === 0) {
    return null;
  }

  if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'y') {
    return true;
  }

  if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'n') {
    return false;
  }

  return null;
}

async function promptValue(
  rl: Interface,
  prompt: string,
  defaultValue = '',
): Promise<string> {
  const suffix = defaultValue.length > 0 ? ` [${defaultValue}]` : '';
  const answer = (await rl.question(`${prompt}${suffix}: `)).trim();
  if (answer.length > 0) {
    return answer;
  }
  return defaultValue;
}

async function promptRequired(
  rl: Interface,
  prompt: string,
  defaultValue = '',
  validator?: (value: string) => boolean,
  invalidMessage?: string,
): Promise<string> {
  // Loop until a non-empty, valid value is supplied.
  while (true) {
    const value = await promptValue(rl, prompt, defaultValue);
    if (value.length === 0) {
      console.log('This value is required.');
      continue;
    }

    if (validator && !validator(value)) {
      console.log(invalidMessage ?? 'Invalid value.');
      continue;
    }

    return value;
  }
}

async function promptBoolean(rl: Interface, prompt: string, defaultValue: boolean): Promise<boolean> {
  const hint = defaultValue ? 'Y/n' : 'y/N';
  while (true) {
    const answer = (await rl.question(`${prompt} [${hint}]: `)).trim();
    if (answer.length === 0) {
      return defaultValue;
    }

    const parsed = parseBooleanInput(answer);
    if (parsed === null) {
      console.log('Enter yes or no.');
      continue;
    }

    return parsed;
  }
}

async function checkCommand(command: string): Promise<void> {
  try {
    await execFileAsync(command, ['--version']);
  } catch {
    throw new Error(`Missing required command: ${command}`);
  }
}

async function commandSucceeds(file: string, args: string[], cwd: string): Promise<boolean> {
  try {
    await execFileAsync(file, args, { cwd });
    return true;
  } catch {
    return false;
  }
}

async function initializeVault(vaultPath: string, templateDir: string): Promise<'created' | 'existing'> {
  const gitDir = path.join(vaultPath, '.git');

  try {
    const gitStats = await fs.stat(gitDir);
    if (gitStats.isDirectory()) {
      return 'existing';
    }
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
      throw error;
    }
  }

  let exists = false;
  let isDirectory = false;
  try {
    const stats = await fs.stat(vaultPath);
    exists = true;
    isDirectory = stats.isDirectory();
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
      throw error;
    }
  }

  if (exists && !isDirectory) {
    throw new Error(`VAULT_PATH exists and is not a directory: ${vaultPath}`);
  }

  if (exists && isDirectory) {
    const entries = await fs.readdir(vaultPath);
    if (entries.length > 0) {
      throw new Error(`VAULT_PATH already exists and is not empty: ${vaultPath}`);
    }
  } else {
    await fs.mkdir(vaultPath, { recursive: true });
  }

  await fs.cp(templateDir, vaultPath, { recursive: true });

  await execFileAsync('git', ['init'], { cwd: vaultPath });

  if (!(await commandSucceeds('git', ['config', '--get', 'user.name'], vaultPath))) {
    await execFileAsync('git', ['config', 'user.name', 'tone-agent'], { cwd: vaultPath });
  }

  if (!(await commandSucceeds('git', ['config', '--get', 'user.email'], vaultPath))) {
    await execFileAsync('git', ['config', 'user.email', 'tone@local'], { cwd: vaultPath });
  }

  if (!(await commandSucceeds('git', ['rev-parse', '--verify', 'HEAD'], vaultPath))) {
    await execFileAsync('git', ['add', '.'], { cwd: vaultPath });
    await execFileAsync('git', ['commit', '-m', 'chore: initialize vault from template'], {
      cwd: vaultPath,
    });
  }

  if (!(await commandSucceeds('git', ['rev-parse', '--verify', `refs/tags/${BASE_TAG}`], vaultPath))) {
    await execFileAsync('git', ['tag', BASE_TAG], { cwd: vaultPath });
  }

  return 'created';
}

function packageRootFromModuleUrl(moduleUrl: string): string {
  const moduleDir = path.dirname(fileURLToPath(moduleUrl));
  return path.resolve(moduleDir, '..');
}

export async function onboard(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('tone onboard requires an interactive terminal.');
  }

  await checkCommand('git');

  const toneHomePath = resolveToneHomePath();
  const envPath = resolveToneEnvPath();
  const packageRoot = packageRootFromModuleUrl(import.meta.url);
  const templateDir = path.join(packageRoot, 'vault-template');

  try {
    const templateStats = await fs.stat(templateDir);
    if (!templateStats.isDirectory()) {
      throw new Error();
    }
  } catch {
    throw new Error(`Vault template not found: ${templateDir}`);
  }

  const existingEnv = await loadExistingEnv(envPath);
  const timezoneFallback = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const vaultFallback = path.join(toneHomePath, 'vault');

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    console.log('Tone onboarding');
    console.log('Enter values now. Press Enter to accept defaults.');
    console.log('Get Telegram token from @BotFather and OpenRouter key at https://openrouter.ai/keys');
    console.log('Gmail is optional and BYO OAuth only (each user supplies their own Google OAuth app).');
    console.log('');

    const telegramBotToken = await promptRequired(
      rl,
      'Telegram bot token',
      existingEnv.TELEGRAM_BOT_TOKEN ?? '',
    );
    const telegramDefaultChatId = await promptValue(
      rl,
      'Telegram default chat ID (optional for scheduled briefings)',
      existingEnv.TELEGRAM_DEFAULT_CHAT_ID ?? '',
    );
    const openRouterApiKey = await promptRequired(
      rl,
      'OpenRouter API key',
      existingEnv.OPENROUTER_API_KEY ?? '',
    );
    const existingGmailEnabled = parseBooleanInput(existingEnv.GMAIL_ENABLED ?? '') ?? false;
    const gmailEnabled = await promptBoolean(
      rl,
      'Enable Gmail integration (BYO OAuth app per user)',
      existingGmailEnabled,
    );

    let gmailClientId = existingEnv.GMAIL_CLIENT_ID ?? '';
    let gmailClientSecret = existingEnv.GMAIL_CLIENT_SECRET ?? '';
    let gmailRedirectUri = existingEnv.GMAIL_REDIRECT_URI ?? '';
    let gmailTokenPath = existingEnv.GMAIL_TOKEN_PATH ?? path.join(toneHomePath, 'gmail-token.json');

    if (gmailEnabled) {
      console.log('');
      console.log('Gmail OAuth setup:');
      console.log('  1. Go to https://console.cloud.google.com/ and create an OAuth 2.0 Client ID.');
      console.log('  2. Set the application type to "Desktop app".');
      console.log('  3. Add http://localhost:8085/oauth2/callback as an authorized redirect URI.');
      console.log('  4. Paste the client ID and secret below.');
      console.log('  After setup, run /connect in Telegram to authorize via your browser.');
      console.log('');

      gmailClientId = await promptRequired(rl, 'Gmail OAuth client ID', gmailClientId);
      gmailClientSecret = await promptRequired(rl, 'Gmail OAuth client secret', gmailClientSecret);
      gmailRedirectUri = await promptRequired(
        rl,
        'Gmail OAuth redirect URI',
        gmailRedirectUri || 'http://localhost:8085/oauth2/callback',
      );
      const rawTokenPath = await promptRequired(rl, 'Local Gmail token path', gmailTokenPath);
      gmailTokenPath = path.resolve(rawTokenPath);
    } else {
      gmailClientId = '';
      gmailClientSecret = '';
      gmailRedirectUri = '';
      gmailTokenPath = '';
    }

    const existingCalendarEnabled = parseBooleanInput(existingEnv.CALENDAR_ENABLED ?? '') ?? false;
    const calendarEnabled = await promptBoolean(
      rl,
      'Enable Google Calendar integration (read-only, reuses Gmail OAuth)',
      existingCalendarEnabled,
    );

    let calendarSyncWindowDays = 7;
    if (calendarEnabled) {
      const rawSyncWindow = await promptValue(
        rl,
        'Calendar sync window in days (1-30)',
        existingEnv.CALENDAR_SYNC_WINDOW_DAYS ?? '7',
      );
      const parsed = Number(rawSyncWindow);
      if (!Number.isFinite(parsed) || parsed < 1 || parsed > 30) {
        console.log('Invalid sync window, using default of 7 days.');
        calendarSyncWindowDays = 7;
      } else {
        calendarSyncWindowDays = parsed;
      }
    }

    const rawVaultPath = await promptRequired(rl, 'Vault path', existingEnv.VAULT_PATH ?? vaultFallback);
    const vaultPath = path.resolve(rawVaultPath);
    const timezone = await promptRequired(
      rl,
      'Timezone (IANA, e.g. Europe/London)',
      existingEnv.TONE_TIMEZONE ?? timezoneFallback,
      validateTimezone,
      'Invalid timezone. Use an IANA zone like Europe/London or America/Los_Angeles.',
    );

    const providerDefault = normalizeProvider(existingEnv.TRANSCRIPTION_PROVIDER ?? 'none') ?? 'none';
    const transcriptionProvider = await promptRequired(
      rl,
      'Transcription provider (none/deepgram/voxtral)',
      providerDefault,
      (value) => normalizeProvider(value) !== null,
      'Expected one of: none, deepgram, voxtral.',
    );
    const normalizedProvider = normalizeProvider(transcriptionProvider) ?? 'none';

    let deepgramApiKey = existingEnv.DEEPGRAM_API_KEY ?? '';
    let voxtralEndpoint = existingEnv.VOXTRAL_ENDPOINT ?? '';
    let voxtralApiKey = existingEnv.VOXTRAL_API_KEY ?? '';

    if (normalizedProvider === 'deepgram') {
      deepgramApiKey = await promptRequired(rl, 'Deepgram API key', deepgramApiKey);
      voxtralEndpoint = '';
      voxtralApiKey = '';
    } else if (normalizedProvider === 'voxtral') {
      voxtralEndpoint = await promptRequired(rl, 'Voxtral endpoint URL', voxtralEndpoint);
      voxtralApiKey = await promptValue(rl, 'Voxtral API key (optional)', voxtralApiKey);
      deepgramApiKey = '';
    } else {
      deepgramApiKey = '';
      voxtralEndpoint = '';
      voxtralApiKey = '';
    }

    const answers: OnboardingAnswers = {
      telegramBotToken,
      telegramDefaultChatId,
      openRouterApiKey,
      gmailEnabled,
      gmailClientId,
      gmailClientSecret,
      gmailRedirectUri,
      gmailTokenPath,
      calendarEnabled,
      calendarSyncWindowDays,
      vaultPath,
      timezone,
      transcriptionProvider: normalizedProvider,
      deepgramApiKey,
      voxtralEndpoint,
      voxtralApiKey,
    };

    const envEntries: Record<string, string> = {
      ...existingEnv,
      TELEGRAM_BOT_TOKEN: answers.telegramBotToken,
      TELEGRAM_DEFAULT_CHAT_ID: answers.telegramDefaultChatId,
      OPENROUTER_API_KEY: answers.openRouterApiKey,
      GMAIL_ENABLED: answers.gmailEnabled ? 'true' : 'false',
      GMAIL_CLIENT_ID: answers.gmailClientId,
      GMAIL_CLIENT_SECRET: answers.gmailClientSecret,
      GMAIL_REDIRECT_URI: answers.gmailRedirectUri,
      GMAIL_TOKEN_PATH: answers.gmailTokenPath,
      CALENDAR_ENABLED: answers.calendarEnabled ? 'true' : 'false',
      CALENDAR_SYNC_WINDOW_DAYS: String(answers.calendarSyncWindowDays),
      DEEPGRAM_API_KEY: answers.deepgramApiKey,
      VAULT_PATH: answers.vaultPath,
      TONE_TIMEZONE: answers.timezone,
      ROUTER_CONFIDENCE_THRESHOLD: existingEnv.ROUTER_CONFIDENCE_THRESHOLD ?? '0.7',
      BRIEFING_CRON: existingEnv.BRIEFING_CRON ?? '30 7 * * *',
      NIGHTLY_CRON: existingEnv.NIGHTLY_CRON ?? '0 23 * * *',
      WEEKLY_CRON: existingEnv.WEEKLY_CRON ?? '0 15 * * 5',
      DEFAULT_RESPONSE_VERBOSITY: existingEnv.DEFAULT_RESPONSE_VERBOSITY ?? 'balanced',
      TRANSCRIPTION_PROVIDER: answers.transcriptionProvider,
      VOXTRAL_ENDPOINT: answers.voxtralEndpoint,
      VOXTRAL_API_KEY: answers.voxtralApiKey,
      VOXTRAL_MODEL: existingEnv.VOXTRAL_MODEL ?? 'mistral-voxtral-mini-latest',
      DEEPGRAM_MODEL: existingEnv.DEEPGRAM_MODEL ?? 'nova-2',
      OPENROUTER_HTTP_REFERER: existingEnv.OPENROUTER_HTTP_REFERER ?? 'https://github.com/tone',
      OPENROUTER_X_TITLE: existingEnv.OPENROUTER_X_TITLE ?? 'Tone',
    };

    await fs.mkdir(path.dirname(envPath), { recursive: true });
    await fs.writeFile(envPath, formatEnvFile(envEntries), 'utf8');
    try {
      await fs.chmod(envPath, 0o600);
    } catch {
      // Best-effort permission hardening; ignore platform-specific failures.
    }

    const vaultStatus = await initializeVault(answers.vaultPath, templateDir);

    console.log('');
    console.log(`Saved configuration to ${envPath}`);
    if (vaultStatus === 'created') {
      console.log(`Initialized vault at ${answers.vaultPath}`);
    } else {
      console.log(`Using existing vault at ${answers.vaultPath}`);
    }
    console.log('');
    console.log('Next: run `tone start` (background mode), then `tone status` and `tone logs`.');
    if (answers.gmailEnabled) {
      console.log('Then send /connect in Telegram to authorize Google access via your browser.');
    }
  } finally {
    rl.close();
  }
}
