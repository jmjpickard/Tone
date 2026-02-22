import { config } from './config.js';
import type { LLMTier } from './types.js';

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface LLMUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface LLMCompletion {
  text: string;
  usage: LLMUsage;
  tier: LLMTier['id'];
  model: string;
}

export type LLMErrorCode = 'network_error' | 'rate_limited' | 'api_error' | 'invalid_response';

export interface LLMErrorResponse {
  code: LLMErrorCode;
  message: string;
  status?: number;
  retryAfterMs?: number;
  details?: unknown;
}

export type LLMResult<T> =
  | {
      ok: true;
      data: T;
    }
  | {
      ok: false;
      error: LLMErrorResponse;
    };

export type LLMStreamChunk =
  | {
      type: 'delta';
      content: string;
    }
  | {
      type: 'done';
      completion: LLMCompletion;
    }
  | {
      type: 'error';
      error: LLMErrorResponse;
    };

interface OpenRouterUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

interface OpenRouterChoice {
  message?: {
    content?: string | Array<{ type?: string; text?: string }>;
  };
}

interface OpenRouterResponse {
  model?: string;
  usage?: OpenRouterUsage;
  choices?: OpenRouterChoice[];
}

const RETRYABLE_STATUSES = new Set([429, 503, 504]);
const MAX_ATTEMPTS = 4;
const BASE_BACKOFF_MS = 400;

function tierToConfig(tier: LLMTier['id']): LLMTier {
  return config.llmTiers[tier];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function parseRetryAfterMs(headerValue: string | null): number | undefined {
  if (!headerValue) {
    return undefined;
  }

  const asNumber = Number(headerValue);
  if (Number.isFinite(asNumber)) {
    return Math.max(0, asNumber) * 1000;
  }

  const asDate = Date.parse(headerValue);
  if (Number.isFinite(asDate)) {
    return Math.max(0, asDate - Date.now());
  }

  return undefined;
}

function extractTextContent(
  content: string | Array<{ type?: string; text?: string }> | undefined,
): string {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .filter((item) => item?.type === 'text' && typeof item.text === 'string')
      .map((item) => item.text)
      .join('');
  }

  return '';
}

function normalizeUsage(usage?: OpenRouterUsage): LLMUsage {
  return {
    promptTokens: usage?.prompt_tokens ?? 0,
    completionTokens: usage?.completion_tokens ?? 0,
    totalTokens:
      usage?.total_tokens ?? (usage?.prompt_tokens ?? 0) + (usage?.completion_tokens ?? 0),
  };
}

async function parseApiError(response: Response): Promise<LLMErrorResponse> {
  let details: unknown;
  let message = `OpenRouter request failed with status ${response.status}`;

  try {
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      details = await response.json();
      if (
        details &&
        typeof details === 'object' &&
        'error' in details &&
        details.error &&
        typeof details.error === 'object' &&
        'message' in details.error &&
        typeof details.error.message === 'string'
      ) {
        message = details.error.message;
      }
    } else {
      const bodyText = await response.text();
      if (bodyText.trim().length > 0) {
        details = bodyText;
        message = bodyText;
      }
    }
  } catch {
    // Swallow parse errors and keep fallback message.
  }

  const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));

  return {
    code: response.status === 429 ? 'rate_limited' : 'api_error',
    status: response.status,
    message,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    ...(details === undefined ? {} : { details }),
  };
}

async function requestJson(
  messages: ChatMessage[],
  tier: LLMTier['id'],
): Promise<LLMResult<LLMCompletion>> {
  const tierConfig = tierToConfig(tier);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let response: Response;

    try {
      response = await fetch(`${config.openRouter.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.openRouterApiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': config.openRouter.httpReferer,
          'X-Title': config.openRouter.xTitle,
        },
        body: JSON.stringify({
          model: tierConfig.model,
          temperature: tierConfig.temperature,
          max_tokens: tierConfig.maxTokens,
          messages,
        }),
      });
    } catch (error) {
      const canRetry = attempt < MAX_ATTEMPTS;
      if (canRetry) {
        await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
        continue;
      }

      return {
        ok: false,
        error: {
          code: 'network_error',
          message: error instanceof Error ? error.message : 'Network error while calling OpenRouter',
        },
      };
    }

    if (response.ok) {
      let payload: OpenRouterResponse;
      try {
        payload = (await response.json()) as OpenRouterResponse;
      } catch {
        return {
          ok: false,
          error: {
            code: 'invalid_response',
            status: response.status,
            message: 'OpenRouter returned non-JSON response.',
          },
        };
      }

      const text = extractTextContent(payload.choices?.[0]?.message?.content);

      return {
        ok: true,
        data: {
          text,
          usage: normalizeUsage(payload.usage),
          tier,
          model: payload.model ?? tierConfig.model,
        },
      };
    }

    const parsedError = await parseApiError(response);
    const canRetry = attempt < MAX_ATTEMPTS && RETRYABLE_STATUSES.has(response.status);
    if (canRetry) {
      const waitMs = parsedError.retryAfterMs ?? BASE_BACKOFF_MS * 2 ** (attempt - 1);
      await sleep(waitMs);
      continue;
    }

    return {
      ok: false,
      error: parsedError,
    };
  }

  return {
    ok: false,
    error: {
      code: 'api_error',
      message: 'OpenRouter request exhausted retries.',
    },
  };
}

export async function complete(
  prompt: string,
  tier: LLMTier['id'] = 'tier2',
): Promise<LLMResult<LLMCompletion>> {
  return requestJson([{ role: 'user', content: prompt }], tier);
}

export async function chat(
  messages: ChatMessage[],
  tier: LLMTier['id'] = 'tier2',
): Promise<LLMResult<LLMCompletion>> {
  return requestJson(messages, tier);
}

export async function* streamChat(
  messages: ChatMessage[],
  tier: LLMTier['id'] = 'tier2',
): AsyncGenerator<LLMStreamChunk> {
  const tierConfig = tierToConfig(tier);

  let response: Response;
  try {
    response = await fetch(`${config.openRouter.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.openRouterApiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': config.openRouter.httpReferer,
        'X-Title': config.openRouter.xTitle,
      },
      body: JSON.stringify({
        model: tierConfig.model,
        temperature: tierConfig.temperature,
        max_tokens: tierConfig.maxTokens,
        messages,
        stream: true,
        stream_options: { include_usage: true },
      }),
    });
  } catch (error) {
    yield {
      type: 'error',
      error: {
        code: 'network_error',
        message: error instanceof Error ? error.message : 'Network error while streaming from OpenRouter',
      },
    };
    return;
  }

  if (!response.ok) {
    const parsedError = await parseApiError(response);
    yield {
      type: 'error',
      error: parsedError,
    };
    return;
  }

  if (!response.body) {
    yield {
      type: 'error',
      error: {
        code: 'invalid_response',
        status: response.status,
        message: 'OpenRouter stream response had no body.',
      },
    };
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullText = '';
  let usage: LLMUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  let model = tierConfig.model;

  while (true) {
    const chunk = await reader.read();
    if (chunk.done) {
      break;
    }

    buffer += decoder.decode(chunk.value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) {
        continue;
      }

      const payloadText = trimmed.slice(5).trim();
      if (payloadText === '[DONE]') {
        continue;
      }

      try {
        const payload = JSON.parse(payloadText) as {
          model?: string;
          usage?: OpenRouterUsage;
          choices?: Array<{
            delta?: {
              content?: string;
            };
          }>;
        };

        if (payload.model) {
          model = payload.model;
        }

        if (payload.usage) {
          usage = normalizeUsage(payload.usage);
        }

        const delta = payload.choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta.length > 0) {
          fullText += delta;
          yield {
            type: 'delta',
            content: delta,
          };
        }
      } catch {
        yield {
          type: 'error',
          error: {
            code: 'invalid_response',
            message: 'Failed to parse streaming payload from OpenRouter.',
          },
        };
        return;
      }
    }
  }

  yield {
    type: 'done',
    completion: {
      text: fullText,
      usage,
      tier,
      model,
    },
  };
}
