export const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.send',
] as const;

export type GmailScope = (typeof GMAIL_SCOPES)[number];

export interface StoredGmailTokens {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  scope: string;
  expiryDateMs: number;
  updatedAt: string;
}

export type GmailConnectionState = 'connected' | 'disconnected' | 'expired' | 'invalid';

export interface GmailConnectionStatus {
  state: GmailConnectionState;
  message: string;
  expiresAt?: string;
}

export type GmailErrorCode =
  | 'gmail_disabled'
  | 'missing_credentials'
  | 'disconnected'
  | 'invalid_grant'
  | 'refresh_failed'
  | 'rate_limited'
  | 'quota_exceeded'
  | 'network_error'
  | 'invalid_response'
  | 'api_error';

export interface GmailErrorOptions {
  code: GmailErrorCode;
  message: string;
  safeMessage: string;
  status?: number;
  retryable?: boolean;
  cause?: unknown;
}

export class GmailIntegrationError extends Error {
  readonly code: GmailErrorCode;
  readonly safeMessage: string;
  readonly status: number | undefined;
  readonly retryable: boolean;

  constructor(options: GmailErrorOptions) {
    super(options.message);
    this.name = 'GmailIntegrationError';
    this.code = options.code;
    this.safeMessage = options.safeMessage;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
    if (options.cause !== undefined) {
      (this as Error & { cause: unknown }).cause = options.cause;
    }
  }
}

export interface GmailInboxMessage {
  id: string;
  threadId: string;
  snippet: string;
  subject: string;
  from: string;
  internalDate: string;
  unread: boolean;
}

export interface GmailInboxPage {
  messages: GmailInboxMessage[];
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

export interface GmailThreadMessage {
  id: string;
  threadId: string;
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  snippet: string;
  bodyText: string;
  internalDate: string;
  internetMessageId?: string;
  references?: string;
}

export interface GmailThread {
  id: string;
  snippet: string;
  historyId?: string;
  messages: GmailThreadMessage[];
}

export interface GmailReplyDraftInput {
  threadId: string;
  to: string;
  subject: string;
  bodyText: string;
  inReplyToMessageId?: string;
  references?: string;
}

export interface GmailDraftRecord {
  draftId: string;
  messageId: string;
  threadId: string;
}

export type GmailSendInput =
  | {
      draftId: string;
    }
  | ({
      threadId: string;
    } & Omit<GmailReplyDraftInput, 'threadId'>);

export interface GmailSendResult {
  id: string;
  threadId: string;
}

export type EmailTriageLabel = 'needs_reply' | 'waiting_on_them' | 'fyi' | 'no_reply_needed';

export interface EmailTriageItem {
  threadId: string;
  messageId: string;
  subject: string;
  from: string;
  snippet: string;
  receivedAt: string;
  unread: boolean;
  label: EmailTriageLabel;
  priorityScore: number;
  reasoning: string[];
}

export interface EmailTriageSnapshot {
  generatedAt: string;
  source: 'gmail' | 'fallback';
  status: 'available' | 'unavailable';
  unavailableReason?: string;
  needsReply: EmailTriageItem[];
  waitingOnThem: EmailTriageItem[];
  staleThreads: EmailTriageItem[];
}

export type EmailTriageWorkflowStatus = 'active' | 'done' | 'no_reply_needed';

export interface EmailTriageThreadState {
  threadId: string;
  status: EmailTriageWorkflowStatus;
  updatedAt: string;
  updatedBy?: string;
  snoozedUntil?: string;
}

export type EmailTriageThreadStateMap = Record<string, EmailTriageThreadState>;

export type EmailTriageQuickAction =
  | 'draft'
  | 'send'
  | 'snooze_4h'
  | 'remind_tomorrow'
  | 'mark_no_reply'
  | 'done';

export type EmailDraftStatus =
  | 'drafted'
  | 'pending_send_confirmation'
  | 'sent'
  | 'canceled'
  | 'failed';

export interface EmailDraftArtifact {
  draftRef: string;
  interactionId: string;
  createdAt: string;
  updatedAt: string;
  threadId: string;
  gmailDraftId: string;
  gmailMessageId: string;
  to: string;
  subject: string;
  bodyText: string;
  status: EmailDraftStatus;
  sendMessageId?: string;
  confirmationId?: string;
  note?: string;
}

export type PendingSendStatus = 'pending' | 'confirmed' | 'canceled' | 'failed';

export interface PendingEmailSendRequest {
  confirmationId: string;
  draftRef: string;
  createdAt: string;
  status: PendingSendStatus;
  resolvedAt?: string;
  resolvedBy?: string;
  note?: string;
}

export type PendingEmailSendState = Record<string, PendingEmailSendRequest>;
