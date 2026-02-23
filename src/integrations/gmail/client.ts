import {
  GmailIntegrationError,
  type GmailDraftRecord,
  type GmailInboxMessage,
  type GmailInboxPage,
  type GmailReplyDraftInput,
  type GmailSendInput,
  type GmailSendResult,
  type GmailThread,
  type GmailThreadMessage,
} from './types.js';
import { getAccessToken } from './auth.js';

const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1';
const MAX_RETRIES = 3;

interface GmailApiErrorReason {
  reason?: unknown;
  message?: unknown;
}

interface GmailApiErrorBody {
  error?: {
    code?: unknown;
    message?: unknown;
    status?: unknown;
    errors?: GmailApiErrorReason[];
  };
}

interface GmailApiListResponse {
  messages?: Array<{
    id?: unknown;
    threadId?: unknown;
  }>;
  nextPageToken?: unknown;
  resultSizeEstimate?: unknown;
}

interface GmailApiHeader {
  name?: unknown;
  value?: unknown;
}

interface GmailApiMessagePart {
  mimeType?: unknown;
  filename?: unknown;
  headers?: GmailApiHeader[];
  body?: {
    data?: unknown;
    size?: unknown;
  };
  parts?: GmailApiMessagePart[];
}

interface GmailApiMessage {
  id?: unknown;
  threadId?: unknown;
  labelIds?: unknown;
  snippet?: unknown;
  internalDate?: unknown;
  payload?: GmailApiMessagePart;
}

interface GmailApiThread {
  id?: unknown;
  historyId?: unknown;
  snippet?: unknown;
  messages?: GmailApiMessage[];
}

interface GmailApiDraftResponse {
  id?: unknown;
  message?: {
    id?: unknown;
    threadId?: unknown;
  };
}

interface GmailApiSendResponse {
  id?: unknown;
  threadId?: unknown;
}

interface GmailRequestOptions {
  method?: 'GET' | 'POST';
  query?: URLSearchParams;
  body?: unknown;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function parseErrorReason(body: GmailApiErrorBody): string {
  const firstReason = body.error?.errors?.[0];
  const reason = typeof firstReason?.reason === 'string' ? firstReason.reason : '';
  const status = typeof body.error?.status === 'string' ? body.error.status : '';

  if (reason) {
    return reason;
  }
  return status;
}

function mapApiError(status: number, body: GmailApiErrorBody): GmailIntegrationError {
  const reason = parseErrorReason(body).toLowerCase();
  const apiMessage = typeof body.error?.message === 'string' ? body.error.message : 'Unknown Gmail API error';

  if (reason === 'invalid_grant') {
    return new GmailIntegrationError({
      code: 'invalid_grant',
      message: `Google API returned invalid_grant: ${apiMessage}`,
      safeMessage: 'Gmail authorization has expired or been revoked. Reconnect your Gmail account.',
      status,
    });
  }

  if (reason.includes('quota') || reason.includes('limitexceeded')) {
    return new GmailIntegrationError({
      code: 'quota_exceeded',
      message: `Gmail API quota exceeded: ${apiMessage}`,
      safeMessage: 'Gmail quota limit reached. Please try again later.',
      status,
      retryable: true,
    });
  }

  if (status === 429 || reason.includes('ratelimit')) {
    return new GmailIntegrationError({
      code: 'rate_limited',
      message: `Gmail API rate limited request: ${apiMessage}`,
      safeMessage: 'Gmail rate limit hit. Retrying shortly may work.',
      status,
      retryable: true,
    });
  }

  if (status === 401) {
    return new GmailIntegrationError({
      code: 'refresh_failed',
      message: `Gmail API authentication failed: ${apiMessage}`,
      safeMessage: 'Gmail authentication failed. Reconnect your account and try again.',
      status,
    });
  }

  return new GmailIntegrationError({
    code: 'api_error',
    message: `Gmail API request failed (${status}): ${apiMessage}`,
    safeMessage: 'Gmail request failed. Please try again.',
    status,
    retryable: isRetryableStatus(status),
  });
}

function normalizeUrl(pathname: string, query?: URLSearchParams): string {
  const url = new URL(`${GMAIL_API_BASE}${pathname}`);
  if (query) {
    url.search = query.toString();
  }
  return url.toString();
}

async function gmailRequest<T>(pathname: string, options: GmailRequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  let lastError: GmailIntegrationError | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    const accessToken = await getAccessToken();
    let response: Response;

    try {
      response = await fetch(normalizeUrl(pathname, options.query), {
        method,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      });
    } catch (error) {
      lastError = new GmailIntegrationError({
        code: 'network_error',
        message: 'Network failure while requesting Gmail API.',
        safeMessage: 'Could not reach Gmail API. Check your network connection and try again.',
        cause: error,
        retryable: true,
      });

      if (attempt < MAX_RETRIES) {
        await sleep(250 * 2 ** (attempt - 1));
        continue;
      }

      throw lastError;
    }

    const raw = await response.text();
    let parsed: unknown;
    try {
      parsed = raw ? (JSON.parse(raw) as unknown) : {};
    } catch {
      parsed = {};
    }

    if (!response.ok) {
      lastError = mapApiError(response.status, (parsed ?? {}) as GmailApiErrorBody);

      if (lastError.retryable && attempt < MAX_RETRIES) {
        await sleep(250 * 2 ** (attempt - 1));
        continue;
      }

      throw lastError;
    }

    return parsed as T;
  }

  throw (
    lastError ??
    new GmailIntegrationError({
      code: 'api_error',
      message: 'Gmail API request failed after retries.',
      safeMessage: 'Gmail request failed after retries.',
    })
  );
}

function headerValue(headers: GmailApiHeader[] | undefined, name: string): string {
  if (!headers || headers.length === 0) {
    return '';
  }

  const normalizedName = name.toLowerCase();
  for (const header of headers) {
    const headerName = typeof header.name === 'string' ? header.name.toLowerCase() : '';
    if (headerName === normalizedName) {
      return typeof header.value === 'string' ? header.value : '';
    }
  }

  return '';
}

function decodeBase64Url(data: string): string {
  const normalized = data.replace(/-/g, '+').replace(/_/g, '/');
  const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  return Buffer.from(`${normalized}${padding}`, 'base64').toString('utf8');
}

function extractTextBody(part: GmailApiMessagePart | undefined): string {
  if (!part) {
    return '';
  }

  const mimeType = typeof part.mimeType === 'string' ? part.mimeType.toLowerCase() : '';
  const bodyData = typeof part.body?.data === 'string' ? part.body.data : '';
  if ((mimeType === 'text/plain' || mimeType === 'text/html') && bodyData) {
    return decodeBase64Url(bodyData).trim();
  }

  if (Array.isArray(part.parts)) {
    for (const child of part.parts) {
      const extracted = extractTextBody(child);
      if (extracted) {
        return extracted;
      }
    }
  }

  return '';
}

function toIsoDate(internalDate: unknown): string {
  const timestamp = typeof internalDate === 'string' ? Number(internalDate) : Number.NaN;
  if (!Number.isFinite(timestamp)) {
    return new Date().toISOString();
  }

  return new Date(timestamp).toISOString();
}

function toInboxMessage(message: GmailApiMessage): GmailInboxMessage {
  const id = typeof message.id === 'string' ? message.id : '';
  const threadId = typeof message.threadId === 'string' ? message.threadId : '';
  if (!id || !threadId) {
    throw new GmailIntegrationError({
      code: 'invalid_response',
      message: 'Gmail message metadata response missing id/threadId.',
      safeMessage: 'Gmail returned incomplete message metadata.',
    });
  }

  const headers = Array.isArray(message.payload?.headers) ? message.payload.headers : [];
  const labelIds = Array.isArray(message.labelIds)
    ? message.labelIds.filter((label): label is string => typeof label === 'string')
    : [];

  return {
    id,
    threadId,
    snippet: typeof message.snippet === 'string' ? message.snippet.trim() : '',
    subject: headerValue(headers, 'Subject') || '(No subject)',
    from: headerValue(headers, 'From') || '(Unknown sender)',
    internalDate: toIsoDate(message.internalDate),
    unread: labelIds.includes('UNREAD'),
  };
}

function toThreadMessage(message: GmailApiMessage): GmailThreadMessage {
  const id = typeof message.id === 'string' ? message.id : '';
  const threadId = typeof message.threadId === 'string' ? message.threadId : '';
  if (!id || !threadId) {
    throw new GmailIntegrationError({
      code: 'invalid_response',
      message: 'Gmail thread message missing id/threadId.',
      safeMessage: 'Gmail returned an incomplete thread record.',
    });
  }

  const headers = Array.isArray(message.payload?.headers) ? message.payload.headers : [];
  const toHeader = headerValue(headers, 'To');
  const ccHeader = headerValue(headers, 'Cc');
  const internetMessageId = headerValue(headers, 'Message-Id');
  const references = headerValue(headers, 'References');

  return {
    id,
    threadId,
    from: headerValue(headers, 'From') || '(Unknown sender)',
    to: toHeader
      ? toHeader
          .split(',')
          .map((value) => value.trim())
          .filter((value) => value.length > 0)
      : [],
    cc: ccHeader
      ? ccHeader
          .split(',')
          .map((value) => value.trim())
          .filter((value) => value.length > 0)
      : [],
    subject: headerValue(headers, 'Subject') || '(No subject)',
    snippet: typeof message.snippet === 'string' ? message.snippet.trim() : '',
    bodyText: extractTextBody(message.payload),
    internalDate: toIsoDate(message.internalDate),
    ...(internetMessageId ? { internetMessageId } : {}),
    ...(references ? { references } : {}),
  };
}

function encodeBase64Url(value: string): string {
  return Buffer.from(value, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function normalizeReplySubject(subject: string): string {
  const trimmed = subject.trim();
  if (!trimmed) {
    return 'Re:';
  }

  if (/^re:/i.test(trimmed)) {
    return trimmed;
  }

  return `Re: ${trimmed}`;
}

function buildRawReply(input: GmailReplyDraftInput): string {
  const lines: string[] = [];
  lines.push(`To: ${input.to}`);
  lines.push(`Subject: ${normalizeReplySubject(input.subject)}`);

  if (input.inReplyToMessageId) {
    lines.push(`In-Reply-To: ${input.inReplyToMessageId}`);
  }

  if (input.references) {
    lines.push(`References: ${input.references}`);
  }

  lines.push('MIME-Version: 1.0');
  lines.push('Content-Type: text/plain; charset="UTF-8"');
  lines.push('Content-Transfer-Encoding: 7bit');
  lines.push('');
  lines.push(input.bodyText);

  return lines.join('\r\n');
}

function extractEmailAddress(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return '';
  }

  const bracketed = trimmed.match(/<([^>]+)>/);
  if (bracketed?.[1]) {
    return bracketed[1].trim();
  }

  return trimmed;
}

export async function listInbox(options?: {
  maxResults?: number;
  pageToken?: string;
  query?: string;
  labelIds?: string[];
}): Promise<GmailInboxPage> {
  const maxResults = Math.max(1, Math.min(50, options?.maxResults ?? 10));
  const query = new URLSearchParams({
    maxResults: String(maxResults),
  });

  if (options?.pageToken?.trim()) {
    query.set('pageToken', options.pageToken.trim());
  }

  if (options?.query?.trim()) {
    query.set('q', options.query.trim());
  }

  const labelIds = options?.labelIds?.length ? options.labelIds : ['INBOX'];
  for (const labelId of labelIds) {
    query.append('labelIds', labelId);
  }

  const listing = await gmailRequest<GmailApiListResponse>('/users/me/messages', {
    method: 'GET',
    query,
  });

  const messageRefs = Array.isArray(listing.messages) ? listing.messages : [];
  const messageIds = messageRefs
    .map((entry) => (typeof entry.id === 'string' ? entry.id : ''))
    .filter((id) => id.length > 0)
    .slice(0, maxResults);

  const messages = await Promise.all(
    messageIds.map(async (messageId) => {
      const metadataQuery = new URLSearchParams({
        format: 'metadata',
      });
      metadataQuery.append('metadataHeaders', 'From');
      metadataQuery.append('metadataHeaders', 'Subject');

      const details = await gmailRequest<GmailApiMessage>(`/users/me/messages/${messageId}`, {
        method: 'GET',
        query: metadataQuery,
      });

      return toInboxMessage(details);
    }),
  );

  const sortedMessages = messages.sort(
    (left, right) => Date.parse(right.internalDate) - Date.parse(left.internalDate),
  );

  return {
    messages: sortedMessages,
    ...(typeof listing.nextPageToken === 'string' && listing.nextPageToken.trim()
      ? { nextPageToken: listing.nextPageToken.trim() }
      : {}),
    ...(typeof listing.resultSizeEstimate === 'number' && Number.isFinite(listing.resultSizeEstimate)
      ? { resultSizeEstimate: listing.resultSizeEstimate }
      : {}),
  };
}

export async function getThread(threadId: string): Promise<GmailThread> {
  const normalizedThreadId = threadId.trim();
  if (!normalizedThreadId) {
    throw new GmailIntegrationError({
      code: 'invalid_response',
      message: 'Thread id is required for getThread.',
      safeMessage: 'Thread reference is missing.',
    });
  }

  const query = new URLSearchParams({
    format: 'full',
  });

  const thread = await gmailRequest<GmailApiThread>(`/users/me/threads/${normalizedThreadId}`, {
    method: 'GET',
    query,
  });

  const id = typeof thread.id === 'string' ? thread.id : '';
  if (!id) {
    throw new GmailIntegrationError({
      code: 'invalid_response',
      message: 'Gmail thread response missing id.',
      safeMessage: 'Gmail returned an invalid thread payload.',
    });
  }

  const messages = Array.isArray(thread.messages) ? thread.messages.map(toThreadMessage) : [];
  messages.sort((left, right) => Date.parse(left.internalDate) - Date.parse(right.internalDate));

  return {
    id,
    snippet: typeof thread.snippet === 'string' ? thread.snippet.trim() : '',
    ...(typeof thread.historyId === 'string' ? { historyId: thread.historyId } : {}),
    messages,
  };
}

export async function createReplyDraft(input: GmailReplyDraftInput): Promise<GmailDraftRecord> {
  const to = extractEmailAddress(input.to);
  if (!to) {
    throw new GmailIntegrationError({
      code: 'invalid_response',
      message: 'Reply draft requires a valid recipient address.',
      safeMessage: 'Could not determine recipient for this email draft.',
    });
  }

  const raw = buildRawReply({
    ...input,
    to,
  });

  const created = await gmailRequest<GmailApiDraftResponse>('/users/me/drafts', {
    method: 'POST',
    body: {
      message: {
        threadId: input.threadId,
        raw: encodeBase64Url(raw),
      },
    },
  });

  const draftId = typeof created.id === 'string' ? created.id : '';
  const messageId = typeof created.message?.id === 'string' ? created.message.id : '';
  const threadId = typeof created.message?.threadId === 'string' ? created.message.threadId : input.threadId;

  if (!draftId || !messageId || !threadId) {
    throw new GmailIntegrationError({
      code: 'invalid_response',
      message: 'Gmail draft creation response missing identifiers.',
      safeMessage: 'Gmail returned an invalid draft response.',
    });
  }

  return {
    draftId,
    messageId,
    threadId,
  };
}

export async function sendReply(input: GmailSendInput): Promise<GmailSendResult> {
  if ('draftId' in input) {
    const draftId = input.draftId.trim();
    if (!draftId) {
      throw new GmailIntegrationError({
        code: 'invalid_response',
        message: 'Draft id is required to send a saved Gmail draft.',
        safeMessage: 'Draft reference is missing.',
      });
    }

    const sent = await gmailRequest<GmailApiSendResponse>('/users/me/drafts/send', {
      method: 'POST',
      body: {
        id: draftId,
      },
    });

    const id = typeof sent.id === 'string' ? sent.id : '';
    const threadId = typeof sent.threadId === 'string' ? sent.threadId : '';
    if (!id || !threadId) {
      throw new GmailIntegrationError({
        code: 'invalid_response',
        message: 'Gmail send response missing id/threadId.',
        safeMessage: 'Gmail returned an incomplete send response.',
      });
    }

    return {
      id,
      threadId,
    };
  }

  const raw = buildRawReply({
    threadId: input.threadId,
    to: input.to,
    subject: input.subject,
    bodyText: input.bodyText,
    ...(input.inReplyToMessageId ? { inReplyToMessageId: input.inReplyToMessageId } : {}),
    ...(input.references ? { references: input.references } : {}),
  });

  const sent = await gmailRequest<GmailApiSendResponse>('/users/me/messages/send', {
    method: 'POST',
    body: {
      threadId: input.threadId,
      raw: encodeBase64Url(raw),
    },
  });

  const id = typeof sent.id === 'string' ? sent.id : '';
  const threadId = typeof sent.threadId === 'string' ? sent.threadId : '';
  if (!id || !threadId) {
    throw new GmailIntegrationError({
      code: 'invalid_response',
      message: 'Gmail send response missing id/threadId.',
      safeMessage: 'Gmail returned an incomplete send response.',
    });
  }

  return {
    id,
    threadId,
  };
}
