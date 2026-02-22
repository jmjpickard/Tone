import { config } from './config.js';

export type TranscriptionProviderName = 'none' | 'deepgram' | 'voxtral';

export interface TranscriptionResult {
  text: string;
  confidence: number;
  provider: TranscriptionProviderName;
  durationMs: number;
}

export interface TranscriptionProvider {
  transcribe(audioBuffer: Buffer, mimeType: string): Promise<TranscriptionResult>;
}

export type TranscriptionErrorCode =
  | 'network_error'
  | 'api_error'
  | 'invalid_response'
  | 'configuration_error';

export class TranscriptionError extends Error {
  readonly code: TranscriptionErrorCode;
  readonly status?: number;
  readonly details?: unknown;

  constructor(message: string, code: TranscriptionErrorCode, status?: number, details?: unknown) {
    super(message);
    this.name = 'TranscriptionError';
    this.code = code;
    if (status !== undefined) {
      this.status = status;
    }
    if (details !== undefined) {
      this.details = details;
    }
  }
}

function emptyResult(provider: TranscriptionProviderName): TranscriptionResult {
  return {
    text: '',
    confidence: 0,
    provider,
    durationMs: 0,
  };
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

function resolveVoxtralBaseUrl(rawEndpoint: string): string {
  return rawEndpoint.endsWith('/') ? rawEndpoint.slice(0, -1) : rawEndpoint;
}

class DeepgramProvider implements TranscriptionProvider {
  private readonly apiKey: string;
  private readonly model: string;

  constructor(apiKey: string, model: string) {
    this.apiKey = apiKey;
    this.model = model;
  }

  async transcribe(audioBuffer: Buffer, mimeType: string): Promise<TranscriptionResult> {
    if (audioBuffer.length === 0) {
      return emptyResult('deepgram');
    }

    let response: Response;
    try {
      response = await fetch(
        `https://api.deepgram.com/v1/listen?model=${encodeURIComponent(this.model)}&smart_format=true`,
        {
          method: 'POST',
          headers: {
            Authorization: `Token ${this.apiKey}`,
            'Content-Type': mimeType,
          },
          body: new Uint8Array(audioBuffer),
        },
      );
    } catch (error) {
      throw new TranscriptionError(
        error instanceof Error ? error.message : 'Network error while calling Deepgram',
        'network_error',
      );
    }

    if (!response.ok) {
      let details: unknown;
      try {
        details = await response.json();
      } catch {
        details = await response.text();
      }

      throw new TranscriptionError(
        `Deepgram transcription failed with status ${response.status}`,
        'api_error',
        response.status,
        details,
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new TranscriptionError('Deepgram returned invalid JSON response.', 'invalid_response');
    }

    if (!payload || typeof payload !== 'object') {
      throw new TranscriptionError('Deepgram response missing payload object.', 'invalid_response');
    }

    const resultObj = payload as {
      results?: {
        channels?: Array<{
          alternatives?: Array<{
            transcript?: string;
            confidence?: number;
          }>;
        }>;
      };
      metadata?: {
        duration?: number;
      };
    };

    const alternative = resultObj.results?.channels?.[0]?.alternatives?.[0];
    const transcript = alternative?.transcript?.trim() ?? '';

    if (transcript.length === 0) {
      return emptyResult('deepgram');
    }

    return {
      text: transcript,
      confidence: normalizeConfidence(alternative?.confidence),
      provider: 'deepgram',
      durationMs: Math.max(0, Math.round((resultObj.metadata?.duration ?? 0) * 1000)),
    };
  }
}

class VoxtralProvider implements TranscriptionProvider {
  private readonly endpoint: string;
  private readonly model: string;
  private readonly apiKey?: string;

  constructor(endpoint: string, model: string, apiKey?: string) {
    this.endpoint = resolveVoxtralBaseUrl(endpoint);
    this.model = model;
    if (apiKey !== undefined) {
      this.apiKey = apiKey;
    }
  }

  async transcribe(audioBuffer: Buffer, mimeType: string): Promise<TranscriptionResult> {
    if (audioBuffer.length === 0) {
      return emptyResult('voxtral');
    }

    const formData = new FormData();
    formData.set('model', this.model);
    formData.set(
      'file',
      new Blob([new Uint8Array(audioBuffer)], { type: mimeType }),
      `audio.${mimeType.includes('ogg') ? 'ogg' : 'dat'}`,
    );

    const headers: Record<string, string> = {};
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    let response: Response;
    try {
      response = await fetch(`${this.endpoint}/audio/transcriptions`, {
        method: 'POST',
        headers,
        body: formData,
      });
    } catch (error) {
      throw new TranscriptionError(
        error instanceof Error ? error.message : 'Network error while calling Voxtral endpoint',
        'network_error',
      );
    }

    if (!response.ok) {
      let details: unknown;
      try {
        details = await response.json();
      } catch {
        details = await response.text();
      }

      throw new TranscriptionError(
        `Voxtral transcription failed with status ${response.status}`,
        'api_error',
        response.status,
        details,
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new TranscriptionError('Voxtral returned invalid JSON response.', 'invalid_response');
    }

    if (!payload || typeof payload !== 'object') {
      throw new TranscriptionError('Voxtral response missing payload object.', 'invalid_response');
    }

    const resultObj = payload as {
      text?: string;
      confidence?: number;
      duration?: number;
      segments?: Array<{
        end?: number;
        confidence?: number;
        avg_logprob?: number;
      }>;
    };

    const text = resultObj.text?.trim() ?? '';
    if (text.length === 0) {
      return emptyResult('voxtral');
    }

    const segmentConfidence =
      resultObj.segments
        ?.map((segment) => {
          if (typeof segment.confidence === 'number') {
            return segment.confidence;
          }
          if (typeof segment.avg_logprob === 'number') {
            return Math.max(0, Math.min(1, Math.exp(segment.avg_logprob)));
          }
          return undefined;
        })
        .filter((value): value is number => typeof value === 'number') ?? [];

    const inferredConfidence =
      typeof resultObj.confidence === 'number'
        ? resultObj.confidence
        : segmentConfidence.length > 0
          ? segmentConfidence.reduce((sum, value) => sum + value, 0) / segmentConfidence.length
          : 0;

    const inferredDurationFromSegments =
      resultObj.segments && resultObj.segments.length > 0
        ? Math.max(...resultObj.segments.map((segment) => segment.end ?? 0))
        : 0;

    return {
      text,
      confidence: normalizeConfidence(inferredConfidence),
      provider: 'voxtral',
      durationMs: Math.max(
        0,
        Math.round((typeof resultObj.duration === 'number' ? resultObj.duration : inferredDurationFromSegments) * 1000),
      ),
    };
  }
}

class DisabledProvider implements TranscriptionProvider {
  async transcribe(): Promise<TranscriptionResult> {
    throw new TranscriptionError(
      'Voice transcription is disabled. Set TRANSCRIPTION_PROVIDER to deepgram or voxtral.',
      'configuration_error',
    );
  }
}

export function createTranscriber(
  provider: TranscriptionProviderName = config.transcription.provider,
): TranscriptionProvider {
  if (provider === 'none') {
    return new DisabledProvider();
  }

  if (provider === 'deepgram') {
    const apiKey = config.transcription.deepgramApiKey;
    if (!apiKey) {
      throw new TranscriptionError(
        'DEEPGRAM_API_KEY is required when TRANSCRIPTION_PROVIDER=deepgram.',
        'configuration_error',
      );
    }
    return new DeepgramProvider(apiKey, config.transcription.deepgramModel);
  }

  const endpoint = config.transcription.voxtralEndpoint;
  if (!endpoint) {
    throw new TranscriptionError(
      'VOXTRAL_ENDPOINT is required when TRANSCRIPTION_PROVIDER=voxtral.',
      'configuration_error',
    );
  }

  return new VoxtralProvider(endpoint, config.transcription.voxtralModel, config.transcription.voxtralApiKey);
}
