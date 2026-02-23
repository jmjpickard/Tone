import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../../config.js';
import { CALENDAR_SCOPES } from '../calendar/types.js';
import {
  GMAIL_SCOPES,
  GmailIntegrationError,
  type GmailConnectionStatus,
  type StoredGmailTokens,
} from './types.js';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const TOKEN_REFRESH_GRACE_MS = 2 * 60 * 1000;

interface TokenEndpointSuccess {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
  token_type?: unknown;
}

interface TokenEndpointFailure {
  error?: unknown;
  error_description?: unknown;
}

function ensureGmailEnabled(): {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  tokenPath: string;
} {
  if (!config.gmail.enabled) {
    throw new GmailIntegrationError({
      code: 'gmail_disabled',
      message: 'Gmail integration is disabled in configuration.',
      safeMessage: 'Gmail integration is currently disabled. Run `tone onboard` to enable it.',
    });
  }

  const { clientId, clientSecret, redirectUri, tokenPath } = config.gmail;
  if (!clientId || !clientSecret || !redirectUri || !tokenPath) {
    throw new GmailIntegrationError({
      code: 'missing_credentials',
      message: 'Gmail credentials are missing from configuration.',
      safeMessage:
        'Gmail is enabled but credentials are incomplete. Re-run `tone onboard` to fix Gmail settings.',
    });
  }

  return {
    clientId,
    clientSecret,
    redirectUri,
    tokenPath,
  };
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'ENOENT'
  );
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseStoredTokens(raw: string): StoredGmailTokens | null {
  try {
    const parsed = JSON.parse(raw) as Partial<StoredGmailTokens>;
    if (
      typeof parsed.accessToken === 'string' &&
      typeof parsed.refreshToken === 'string' &&
      typeof parsed.tokenType === 'string' &&
      typeof parsed.scope === 'string' &&
      typeof parsed.expiryDateMs === 'number' &&
      Number.isFinite(parsed.expiryDateMs) &&
      typeof parsed.updatedAt === 'string'
    ) {
      return {
        accessToken: parsed.accessToken,
        refreshToken: parsed.refreshToken,
        tokenType: parsed.tokenType,
        scope: parsed.scope,
        expiryDateMs: parsed.expiryDateMs,
        updatedAt: parsed.updatedAt,
      };
    }
    return null;
  } catch {
    return null;
  }
}

async function readStoredTokens(): Promise<StoredGmailTokens | null> {
  const { tokenPath } = ensureGmailEnabled();

  try {
    const raw = await fs.readFile(tokenPath, 'utf8');
    return parseStoredTokens(raw);
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }

    throw error;
  }
}

async function writeStoredTokens(tokens: StoredGmailTokens): Promise<void> {
  const { tokenPath } = ensureGmailEnabled();
  await fs.mkdir(path.dirname(tokenPath), { recursive: true, mode: 0o700 });
  await fs.writeFile(tokenPath, JSON.stringify(tokens, null, 2), { encoding: 'utf8', mode: 0o600 });

  try {
    await fs.chmod(tokenPath, 0o600);
  } catch {
    // Best effort across filesystems.
  }
}

function parseExpiresInToMs(value: unknown): number {
  const seconds = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return Date.now() + 30 * 60 * 1000;
  }

  return Date.now() + Math.max(60, Math.floor(seconds)) * 1000;
}

function mapTokenError(status: number, payload: TokenEndpointFailure): GmailIntegrationError {
  const rawError = typeof payload.error === 'string' ? payload.error : '';
  const rawDescription = typeof payload.error_description === 'string' ? payload.error_description : '';
  const detail = [rawError, rawDescription].filter((part) => part.length > 0).join(' | ');

  if (rawError === 'invalid_grant') {
    return new GmailIntegrationError({
      code: 'invalid_grant',
      message: `OAuth invalid_grant from Google token endpoint. ${detail}`.trim(),
      safeMessage:
        'Your Gmail authorization expired or was revoked. Reconnect Gmail and re-run the authorization flow.',
      status,
    });
  }

  return new GmailIntegrationError({
    code: 'api_error',
    message: `Google token endpoint failed (${status}). ${detail}`.trim(),
    safeMessage: 'Failed to complete Gmail authentication. Please try again.',
    status,
    retryable: status >= 500,
  });
}

async function requestToken(params: URLSearchParams): Promise<TokenEndpointSuccess> {
  let response: Response;
  try {
    response = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params,
    });
  } catch (error) {
    throw new GmailIntegrationError({
      code: 'network_error',
      message: 'Network error while contacting Google token endpoint.',
      safeMessage: 'Could not reach Google OAuth service. Check connectivity and try again.',
      cause: error,
      retryable: true,
    });
  }

  const raw = await response.text();
  let parsed: unknown;
  try {
    parsed = raw ? (JSON.parse(raw) as unknown) : {};
  } catch {
    parsed = {};
  }

  if (!response.ok) {
    const failure = (parsed ?? {}) as TokenEndpointFailure;
    throw mapTokenError(response.status, failure);
  }

  return (parsed ?? {}) as TokenEndpointSuccess;
}

function toConnectionStatus(tokens: StoredGmailTokens | null): GmailConnectionStatus {
  if (!tokens) {
    return {
      state: 'disconnected',
      message: 'No Gmail OAuth tokens found. Connect Gmail to continue.',
    };
  }

  if (!tokens.accessToken || !tokens.refreshToken || !Number.isFinite(tokens.expiryDateMs)) {
    return {
      state: 'invalid',
      message: 'Stored Gmail token file is invalid. Reconnect Gmail to continue.',
    };
  }

  const expiresAt = new Date(tokens.expiryDateMs).toISOString();
  if (tokens.expiryDateMs <= Date.now()) {
    return {
      state: 'expired',
      message: 'Gmail access token is expired and needs refresh.',
      expiresAt,
    };
  }

  return {
    state: 'connected',
    message: 'Gmail is connected.',
    expiresAt,
  };
}

function buildOAuthScopes(): string {
  const scopes: string[] = [...GMAIL_SCOPES];
  if (config.calendar.enabled) {
    for (const scope of CALENDAR_SCOPES) {
      scopes.push(scope);
    }
  }
  return scopes.join(' ');
}

export function startAuth(options?: { state?: string }): { url: string; state: string } {
  const { clientId, redirectUri } = ensureGmailEnabled();
  const state = options?.state ?? randomUUID();

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    access_type: 'offline',
    prompt: 'consent',
    scope: buildOAuthScopes(),
    state,
  });

  return {
    url: `${GOOGLE_AUTH_URL}?${params.toString()}`,
    state,
  };
}

export async function exchangeCode(code: string): Promise<GmailConnectionStatus> {
  const trimmedCode = code.trim();
  if (!trimmedCode) {
    throw new GmailIntegrationError({
      code: 'missing_credentials',
      message: 'OAuth authorization code is required.',
      safeMessage: 'Authorization code is missing. Paste the code from Google OAuth callback.',
    });
  }

  const { clientId, clientSecret, redirectUri } = ensureGmailEnabled();

  const existingTokens = await readStoredTokens();
  const payload = await requestToken(
    new URLSearchParams({
      code: trimmedCode,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  );

  const accessToken = typeof payload.access_token === 'string' ? payload.access_token : '';
  const refreshTokenFromPayload =
    typeof payload.refresh_token === 'string' ? payload.refresh_token : existingTokens?.refreshToken;
  const tokenType = typeof payload.token_type === 'string' ? payload.token_type : 'Bearer';
  const scope = typeof payload.scope === 'string' ? payload.scope : buildOAuthScopes();

  if (!accessToken || !refreshTokenFromPayload) {
    throw new GmailIntegrationError({
      code: 'invalid_response',
      message: 'Google token response did not include access/refresh token.',
      safeMessage: 'Google OAuth did not return required tokens. Re-run authorization with consent prompt.',
    });
  }

  const stored: StoredGmailTokens = {
    accessToken,
    refreshToken: refreshTokenFromPayload,
    tokenType,
    scope,
    expiryDateMs: parseExpiresInToMs(payload.expires_in),
    updatedAt: nowIso(),
  };

  await writeStoredTokens(stored);
  return toConnectionStatus(stored);
}

export async function refreshAccessToken(): Promise<StoredGmailTokens> {
  const { clientId, clientSecret } = ensureGmailEnabled();
  const existingTokens = await readStoredTokens();

  if (!existingTokens) {
    throw new GmailIntegrationError({
      code: 'disconnected',
      message: 'No Gmail token file found while attempting token refresh.',
      safeMessage: 'Gmail is not connected yet. Connect Gmail before using email features.',
    });
  }

  if (!existingTokens.refreshToken) {
    throw new GmailIntegrationError({
      code: 'missing_credentials',
      message: 'Refresh token missing in stored Gmail token set.',
      safeMessage: 'Stored Gmail token is incomplete. Reconnect Gmail to continue.',
    });
  }

  let payload: TokenEndpointSuccess;
  try {
    payload = await requestToken(
      new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: existingTokens.refreshToken,
        grant_type: 'refresh_token',
      }),
    );
  } catch (error) {
    if (error instanceof GmailIntegrationError && error.code === 'invalid_grant') {
      throw error;
    }

    throw new GmailIntegrationError({
      code: 'refresh_failed',
      message:
        error instanceof Error
          ? `Failed to refresh Gmail access token: ${error.message}`
          : 'Failed to refresh Gmail access token.',
      safeMessage: 'Could not refresh Gmail token automatically. Please reconnect Gmail.',
      cause: error,
      retryable: true,
    });
  }

  const accessToken = typeof payload.access_token === 'string' ? payload.access_token : '';
  if (!accessToken) {
    throw new GmailIntegrationError({
      code: 'refresh_failed',
      message: 'Google refresh response did not include a new access token.',
      safeMessage: 'Google token refresh returned an invalid response. Reconnect Gmail and try again.',
    });
  }

  const updated: StoredGmailTokens = {
    accessToken,
    refreshToken: existingTokens.refreshToken,
    tokenType: typeof payload.token_type === 'string' ? payload.token_type : existingTokens.tokenType,
    scope: typeof payload.scope === 'string' ? payload.scope : existingTokens.scope,
    expiryDateMs: parseExpiresInToMs(payload.expires_in),
    updatedAt: nowIso(),
  };

  await writeStoredTokens(updated);
  return updated;
}

export async function getConnectionStatus(): Promise<GmailConnectionStatus> {
  if (!config.gmail.enabled) {
    return {
      state: 'disconnected',
      message: 'Gmail integration is disabled in configuration.',
    };
  }

  const tokens = await readStoredTokens();
  return toConnectionStatus(tokens);
}

export async function getAccessToken(): Promise<string> {
  const connectionStatus = await getConnectionStatus();
  if (connectionStatus.state === 'disconnected') {
    throw new GmailIntegrationError({
      code: 'disconnected',
      message: connectionStatus.message,
      safeMessage: 'Gmail is not connected yet. Connect your account first.',
    });
  }

  if (connectionStatus.state === 'invalid') {
    throw new GmailIntegrationError({
      code: 'invalid_response',
      message: connectionStatus.message,
      safeMessage: 'Stored Gmail credentials are invalid. Reconnect your account.',
    });
  }

  const stored = await readStoredTokens();
  if (!stored) {
    throw new GmailIntegrationError({
      code: 'disconnected',
      message: 'Token state became unavailable during access token retrieval.',
      safeMessage: 'Gmail token state is unavailable. Reconnect your account.',
    });
  }

  if (stored.expiryDateMs - Date.now() <= TOKEN_REFRESH_GRACE_MS) {
    const refreshed = await refreshAccessToken();
    return refreshed.accessToken;
  }

  return stored.accessToken;
}

export async function clearStoredTokens(): Promise<void> {
  if (!config.gmail.enabled) {
    return;
  }

  const tokenPath = config.gmail.tokenPath;
  try {
    await fs.unlink(tokenPath);
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
  }
}
