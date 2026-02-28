import { randomUUID } from 'node:crypto';
import { logEmailAction, logTriageOutcome } from '../feedback.js';
import { complete } from '../llm.js';
import { exchangeCode, getConnectionStatus, startAuth } from '../integrations/gmail/auth.js';
import { createReplyDraft, getThread, listInbox, sendReply } from '../integrations/gmail/client.js';
import { triageInbox } from '../integrations/gmail/triage.js';
import {
  applyTriageThreadState,
  findLatestDraftForThread,
  loadLatestRawTriageSnapshot,
  loadPendingSendState,
  loadTriageThreadStateMap,
  persistDraftArtifact,
  persistThreadSnapshot,
  persistThreadSummary,
  persistTriageSnapshot,
  readDraftArtifact,
  saveTriageThreadStateMap,
  savePendingSendState,
} from '../integrations/gmail/sync.js';
import {
  GmailIntegrationError,
  type EmailTriageQuickAction,
  type EmailTriageThreadStateMap,
  type EmailDraftArtifact,
  type EmailTriageItem,
  type EmailTriageSnapshot,
  type GmailThread,
} from '../integrations/gmail/types.js';
import type { SkillExecutionContext, SkillExecutionInput, SkillHandler, SkillResult } from './types.js';

type EmailAction = 'status' | 'connect' | 'auth_code' | 'inbox' | 'draft' | 'send' | 'snooze' | 'remind_tomorrow' | 'mark_no_reply' | 'mark_done';

interface DraftModelPayload {
  subject?: unknown;
  body?: unknown;
}

interface EmailSendDecision {
  status: 'sent' | 'canceled' | 'ignored' | 'failed';
  message: string;
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function detectAction(input: SkillExecutionInput): EmailAction {
  const entityAction = typeof input.entities.action === 'string' ? input.entities.action.trim().toLowerCase() : '';
  if (
    entityAction === 'status' ||
    entityAction === 'connect' ||
    entityAction === 'auth_code' ||
    entityAction === 'inbox' ||
    entityAction === 'draft' ||
    entityAction === 'send'
  ) {
    return entityAction;
  }

  const lowered = input.text.toLowerCase();

  if (/\b(connect|link|authorize|auth)\s+gmail\b/.test(lowered)) {
    return 'connect';
  }

  if (/\b(gmail\s+code|oauth\s+code|authorization\s+code)\b/.test(lowered)) {
    return 'auth_code';
  }

  if (/\b(send)\b/.test(lowered) && /\b(draft|email|reply)\b/.test(lowered)) {
    return 'send';
  }

  if (/\b(draft|reply|compose)\b/.test(lowered) && /\b(email|gmail|thread|message|inbox)\b/.test(lowered)) {
    return 'draft';
  }

  if (/\b(inbox|triage|emails|email summary|mailbox)\b/.test(lowered)) {
    return 'inbox';
  }

  if (/\b(snooze)\b/.test(lowered)) {
    return 'snooze';
  }

  if (/\b(remind\s+tomorrow|remind\s+me\s+tomorrow)\b/.test(lowered)) {
    return 'remind_tomorrow';
  }

  if (/\b(no[\s-]?reply|mark\s+no[\s-]?reply|no\s+action)\b/.test(lowered)) {
    return 'mark_no_reply';
  }

  if (/\b(mark\s+done|done\s+with|resolved|handled)\b/.test(lowered)) {
    return 'mark_done';
  }

  // Detect pasted OAuth callback URLs or bare Google auth codes
  if (/oauth2\/callback/i.test(input.text) && /[?&]code=/i.test(input.text)) {
    return 'auth_code';
  }

  for (const token of input.text.split(/\s+/)) {
    if (looksLikeGoogleAuthCode(token)) return 'auth_code';
  }

  return 'status';
}

function extractCodeFromCallbackUrl(text: string): string {
  const urlMatch = text.match(/(https?:\/\/[^\s]+oauth2\/callback[^\s]*)/i);
  if (!urlMatch?.[1]) return '';

  try {
    const url = new URL(urlMatch[1]);
    return url.searchParams.get('code')?.trim() ?? '';
  } catch {
    const codeParam = urlMatch[1].match(/[?&]code=([^&\s]+)/);
    return codeParam?.[1] ? decodeURIComponent(codeParam[1]).trim() : '';
  }
}

function looksLikeGoogleAuthCode(value: string): boolean {
  return /^4\/0A[a-zA-Z0-9_-]{20,}/.test(value.trim());
}

function extractAuthCode(input: SkillExecutionInput): string {
  const entityCode = typeof input.entities.code === 'string' ? input.entities.code.trim() : '';
  if (entityCode && looksLikeGoogleAuthCode(entityCode)) {
    return entityCode;
  }

  // Try extracting code from a pasted callback URL first
  const urlCode = extractCodeFromCallbackUrl(input.text);
  if (urlCode) return urlCode;

  // Match "gmail code <code>" / "oauth code <code>" patterns
  const inlineCodeMatch = input.text.match(/(?:gmail\s+code|oauth\s+code|code)\s*[:=]?\s*([^\s]+)/i);
  if (inlineCodeMatch?.[1] && looksLikeGoogleAuthCode(inlineCodeMatch[1])) {
    return inlineCodeMatch[1].trim();
  }

  // Try bare auth code (the whole message or a token in it)
  for (const token of input.text.split(/\s+/)) {
    if (looksLikeGoogleAuthCode(token)) return token.trim();
  }

  // Fall back to entity code even if it doesn't match the Google pattern
  if (entityCode) return entityCode;

  return '';
}

function extractThreadId(input: SkillExecutionInput): string {
  const entityThread = typeof input.entities.threadId === 'string' ? input.entities.threadId.trim() : '';
  if (entityThread) {
    return entityThread;
  }

  const explicit = input.text.match(/thread\s*[:#]?\s*([a-zA-Z0-9_-]{8,})/i);
  if (explicit?.[1]) {
    return explicit[1].trim();
  }

  const token = input.text.match(/\b([a-f0-9]{12,})\b/i);
  if (token?.[1]) {
    return token[1].trim();
  }

  return '';
}

function extractDraftRef(input: SkillExecutionInput): string {
  const entityDraftRef = typeof input.entities.draftRef === 'string' ? input.entities.draftRef.trim() : '';
  if (entityDraftRef) {
    return entityDraftRef;
  }

  const explicit = input.text.match(/draft(?:\s+ref)?\s*[:#]?\s*([a-zA-Z0-9_-]{6,})/i);
  if (explicit?.[1]) {
    return explicit[1].trim();
  }

  return '';
}

function extractEmailAddress(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }

  const bracketed = trimmed.match(/<([^>]+)>/);
  if (bracketed?.[1]) {
    return bracketed[1].trim();
  }

  return trimmed;
}

function renderTriageItem(item: EmailTriageItem): string {
  const from = normalizeText(item.from);
  const subject = normalizeText(item.subject || '(No subject)');
  const score = item.priorityScore;
  return `- [${score}] ${subject} - ${from} (ThreadRef: ${item.threadId})`;
}

function summarizeInboxSnapshot(snapshot: EmailTriageSnapshot): string {
  if (snapshot.status === 'unavailable') {
    return `Email triage unavailable: ${snapshot.unavailableReason ?? 'Gmail is disconnected.'}`;
  }

  const topNeedsReply = snapshot.needsReply.slice(0, 5);
  const waiting = snapshot.waitingOnThem.slice(0, 3);
  const stale = snapshot.staleThreads.slice(0, 3);

  const needsReplyBlock =
    topNeedsReply.length > 0
      ? topNeedsReply.map(renderTriageItem).join('\n')
      : '- No urgent reply candidates right now.';

  const waitingBlock =
    waiting.length > 0 ? waiting.map(renderTriageItem).join('\n') : '- Nothing currently marked waiting_on_them.';

  const staleBlock =
    stale.length > 0 ? stale.map(renderTriageItem).join('\n') : '- No stale reply threads.';

  return [
    '*Gmail Inbox Triage*',
    '',
    '*Needs Reply (Top 5)*',
    needsReplyBlock,
    '',
    '*Waiting On Them*',
    waitingBlock,
    '',
    '*Stale Threads*',
    staleBlock,
    '',
    'Quick actions:',
    '- Draft: "draft email reply for thread <ThreadRef>"',
    '- Send: "send email draft <DraftRef>"',
  ].join('\n');
}

function extractJsonCandidate(raw: string): string | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }

  const firstBrace = raw.indexOf('{');
  const lastBrace = raw.lastIndexOf('}');
  if (firstBrace < 0 || lastBrace < 0 || firstBrace >= lastBrace) {
    return null;
  }

  return raw.slice(firstBrace, lastBrace + 1);
}

function parseDraftModelPayload(raw: string): { subject: string; body: string } | null {
  const candidate = extractJsonCandidate(raw);
  if (!candidate) {
    return null;
  }

  try {
    const parsed = JSON.parse(candidate) as DraftModelPayload;
    const subject = typeof parsed.subject === 'string' ? normalizeText(parsed.subject) : '';
    const body = typeof parsed.body === 'string' ? parsed.body.trim() : '';

    if (!body) {
      return null;
    }

    return {
      subject,
      body,
    };
  } catch {
    return null;
  }
}

function buildThreadContext(thread: GmailThread): string {
  return thread.messages
    .slice(Math.max(0, thread.messages.length - 4))
    .map((message) => {
      const content = message.bodyText || message.snippet;
      return [
        `From: ${message.from}`,
        `Date: ${message.internalDate}`,
        `Subject: ${message.subject}`,
        `Content: ${content.slice(0, 1400)}`,
      ].join('\n');
    })
    .join('\n\n---\n\n');
}

async function generateReplyDraft(
  thread: GmailThread,
  userRequest: string,
): Promise<{ to: string; subject: string; bodyText: string; inReplyToMessageId?: string; references?: string }> {
  const latestMessage = thread.messages[thread.messages.length - 1];
  if (!latestMessage) {
    throw new GmailIntegrationError({
      code: 'invalid_response',
      message: `Cannot draft reply for thread ${thread.id}; no messages found.`,
      safeMessage: 'Selected thread has no message content to draft from.',
    });
  }

  const recipient = extractEmailAddress(latestMessage.from);
  if (!recipient) {
    throw new GmailIntegrationError({
      code: 'invalid_response',
      message: `Cannot draft reply for thread ${thread.id}; recipient parsing failed.`,
      safeMessage: 'Could not determine recipient from the selected thread.',
    });
  }

  const prompt = [
    'You are drafting an email reply for the user.',
    'Return strict JSON with keys: subject, body.',
    'body should be concise and ready to send.',
    'Do not include markdown code fences.',
    '',
    'User request:',
    userRequest,
    '',
    'Latest thread context:',
    buildThreadContext(thread),
  ].join('\n');

  const completion = await complete(prompt, 'tier2');

  if (!completion.ok) {
    return {
      to: recipient,
      subject: latestMessage.subject,
      bodyText: 'Thanks for the update. I will review and get back to you shortly.',
      ...(latestMessage.internetMessageId ? { inReplyToMessageId: latestMessage.internetMessageId } : {}),
      ...(latestMessage.references ? { references: latestMessage.references } : {}),
    };
  }

  const parsed = parseDraftModelPayload(completion.data.text);
  if (!parsed) {
    return {
      to: recipient,
      subject: latestMessage.subject,
      bodyText: completion.data.text.trim() || 'Thanks for the update. I will follow up shortly.',
      ...(latestMessage.internetMessageId ? { inReplyToMessageId: latestMessage.internetMessageId } : {}),
      ...(latestMessage.references ? { references: latestMessage.references } : {}),
    };
  }

  return {
    to: recipient,
    subject: parsed.subject || latestMessage.subject,
    bodyText: parsed.body,
    ...(latestMessage.internetMessageId ? { inReplyToMessageId: latestMessage.internetMessageId } : {}),
    ...(latestMessage.references ? { references: latestMessage.references } : {}),
  };
}

function buildUnavailableResponse(error: unknown): string {
  if (error instanceof GmailIntegrationError) {
    if (error.code === 'disconnected' || error.code === 'invalid_grant') {
      try {
        const auth = startAuth();
        return [
          `${error.safeMessage}`,
          '',
          'Reconnect Gmail:',
          `1) Open this URL: ${auth.url}`,
          '2) Authorize access',
          '3) Send me: gmail code <authorization_code>',
        ].join('\n');
      } catch {
        return error.safeMessage;
      }
    }

    return error.safeMessage;
  }

  return 'Gmail action failed due to an unexpected error.';
}

async function handleStatusAction(): Promise<SkillResult> {
  const status = await getConnectionStatus();

  if (status.state === 'connected') {
    return {
      status: 'success',
      intent: 'email',
      response: `Gmail is connected.${status.expiresAt ? ` Access token expires at ${status.expiresAt}.` : ''}`,
    };
  }

  if (status.state === 'disconnected') {
    return {
      status: 'success',
      intent: 'email',
      response: 'Gmail is not connected yet. Connect your account first.\n\nUse /connect to start the authorization flow.',
    };
  }

  return {
    status: 'success',
    intent: 'email',
    response: status.message,
  };
}

async function handleConnectAction(): Promise<SkillResult> {
  const auth = startAuth();
  return {
    status: 'success',
    intent: 'email',
    response: [
      'Start Gmail BYO OAuth connection:',
      `1) Open: ${auth.url}`,
      '2) Grant access to your Gmail account',
      '3) Send me: gmail code <authorization_code>',
      '',
      `State: ${auth.state}`,
    ].join('\n'),
  };
}

async function handleAuthCodeAction(input: SkillExecutionInput): Promise<SkillResult> {
  const code = extractAuthCode(input);
  if (!code) {
    return {
      status: 'needs_clarification',
      intent: 'email',
      response: 'Missing authorization code. Send: gmail code <authorization_code>.',
    };
  }

  const status = await exchangeCode(code);
  return {
    status: 'success',
    intent: 'email',
    response: `Gmail authorization updated. Status: ${status.state}. ${status.message}`,
  };
}

async function handleInboxAction(): Promise<SkillResult> {
  try {
    const page = await listInbox({
      maxResults: 20,
      labelIds: ['INBOX'],
    });

    if (page.messages.length === 0) {
      const emptySnapshot: EmailTriageSnapshot = {
        generatedAt: new Date().toISOString(),
        source: 'gmail',
        status: 'available',
        needsReply: [],
        waitingOnThem: [],
        staleThreads: [],
      };

      await persistTriageSnapshot(emptySnapshot);
      return {
        status: 'success',
        intent: 'email',
        response: 'Inbox is clear right now. No messages found in INBOX.',
      };
    }

    await Promise.all(page.messages.map((message) => persistThreadSummary(message)));

    const triageSnapshot = await triageInbox(page.messages);
    await persistTriageSnapshot(triageSnapshot);

    return {
      status: 'success',
      intent: 'email',
      response: summarizeInboxSnapshot(triageSnapshot),
      metadata: {
        needsReplyCount: triageSnapshot.needsReply.length,
        waitingOnThemCount: triageSnapshot.waitingOnThem.length,
      },
    };
  } catch (error) {
    const unavailableSnapshot: EmailTriageSnapshot = {
      generatedAt: new Date().toISOString(),
      source: 'fallback',
      status: 'unavailable',
      unavailableReason:
        error instanceof GmailIntegrationError ? error.safeMessage : 'Unexpected Gmail inbox fetch failure.',
      needsReply: [],
      waitingOnThem: [],
      staleThreads: [],
    };

    await persistTriageSnapshot(unavailableSnapshot);

    return {
      status: 'error',
      intent: 'email',
      response: buildUnavailableResponse(error),
    };
  }
}

async function handleDraftAction(input: SkillExecutionInput, context: SkillExecutionContext): Promise<SkillResult> {
  const threadId = extractThreadId(input);
  if (!threadId) {
    return {
      status: 'needs_clarification',
      intent: 'email',
      response: 'Tell me which thread to draft for. Example: draft email reply for thread <ThreadRef>.',
    };
  }

  try {
    const thread = await getThread(threadId);
    await persistThreadSnapshot(thread);

    const draftContent = await generateReplyDraft(thread, input.text);
    const gmailDraft = await createReplyDraft({
      threadId: thread.id,
      to: draftContent.to,
      subject: draftContent.subject,
      bodyText: draftContent.bodyText,
      ...(draftContent.inReplyToMessageId
        ? {
            inReplyToMessageId: draftContent.inReplyToMessageId,
          }
        : {}),
      ...(draftContent.references
        ? {
            references: draftContent.references,
          }
        : {}),
    });

    const now = new Date().toISOString();
    const draftRef = randomUUID().slice(0, 12);

    const artifact: EmailDraftArtifact = {
      draftRef,
      interactionId: context.interactionId,
      createdAt: now,
      updatedAt: now,
      threadId: gmailDraft.threadId,
      gmailDraftId: gmailDraft.draftId,
      gmailMessageId: gmailDraft.messageId,
      to: draftContent.to,
      subject: draftContent.subject,
      bodyText: draftContent.bodyText,
      status: 'drafted',
    };

    await persistDraftArtifact(artifact);
    await logEmailAction({
      userId: context.userId,
      interactionId: context.interactionId,
      action: 'draft_generated',
      draftRef,
      threadId: artifact.threadId,
    });

    return {
      status: 'success',
      intent: 'email',
      response: [
        `Draft created for thread ${thread.id}.`,
        `DraftRef: ${draftRef}`,
        `To: ${artifact.to}`,
        `Subject: ${artifact.subject}`,
        '',
        artifact.bodyText,
        '',
        `When ready, send: send email draft ${draftRef}`,
      ].join('\n'),
      metadata: {
        draftRef,
        threadId: thread.id,
      },
    };
  } catch (error) {
    return {
      status: 'error',
      intent: 'email',
      response: buildUnavailableResponse(error),
    };
  }
}

async function handleSendAction(input: SkillExecutionInput): Promise<SkillResult> {
  const draftRef = extractDraftRef(input);
  if (!draftRef) {
    return {
      status: 'needs_clarification',
      intent: 'email',
      response: 'Tell me the draft reference to send. Example: send email draft <DraftRef>.',
    };
  }

  const artifact = await readDraftArtifact(draftRef);
  if (!artifact) {
    return {
      status: 'not_found',
      intent: 'email',
      response: `I could not find draft ${draftRef}.`,
    };
  }

  if (artifact.status === 'sent') {
    return {
      status: 'success',
      intent: 'email',
      response: `Draft ${draftRef} has already been sent.`,
    };
  }

  const confirmationId = randomUUID();
  const now = new Date().toISOString();

  const pendingState = await loadPendingSendState();
  pendingState[confirmationId] = {
    confirmationId,
    draftRef,
    createdAt: now,
    status: 'pending',
  };
  await savePendingSendState(pendingState);

  const updatedArtifact: EmailDraftArtifact = {
    ...artifact,
    updatedAt: now,
    status: 'pending_send_confirmation',
    confirmationId,
    note: 'Awaiting explicit Telegram callback confirmation before send.',
  };
  await persistDraftArtifact(updatedArtifact);

  return {
    status: 'success',
    intent: 'email',
    response: [
      `Ready to send draft ${draftRef}.`,
      `To: ${artifact.to}`,
      `Subject: ${artifact.subject}`,
      '',
      'Tap confirm or cancel below.',
    ].join('\n'),
    metadata: {
      emailSendConfirmationId: confirmationId,
      emailDraftRef: draftRef,
    },
  };
}

export async function confirmPendingEmailSend(
  confirmationId: string,
  userId: string,
): Promise<EmailSendDecision> {
  const trimmedId = confirmationId.trim();
  if (!trimmedId) {
    return {
      status: 'ignored',
      message: 'Missing email send confirmation id.',
    };
  }

  const pendingState = await loadPendingSendState();
  const pending = pendingState[trimmedId];
  if (!pending) {
    return {
      status: 'ignored',
      message: 'This email confirmation request was not found (maybe already resolved).',
    };
  }

  if (pending.status === 'confirmed') {
    return {
      status: 'ignored',
      message: `Email draft ${pending.draftRef} was already sent.`,
    };
  }

  if (pending.status === 'canceled') {
    return {
      status: 'ignored',
      message: `Email draft ${pending.draftRef} was already canceled.`,
    };
  }

  const artifact = await readDraftArtifact(pending.draftRef);
  if (!artifact) {
    const now = new Date().toISOString();
    pendingState[trimmedId] = {
      ...pending,
      status: 'failed',
      resolvedAt: now,
      resolvedBy: userId,
      note: 'Draft artifact missing during confirmation.',
    };
    await savePendingSendState(pendingState);

    return {
      status: 'failed',
      message: `Cannot send draft ${pending.draftRef} because its artifact could not be found.`,
    };
  }

  try {
    const sent = await sendReply({
      draftId: artifact.gmailDraftId,
    });

    const now = new Date().toISOString();
    pendingState[trimmedId] = {
      ...pending,
      status: 'confirmed',
      resolvedAt: now,
      resolvedBy: userId,
      note: `Sent Gmail message ${sent.id}.`,
    };
    await savePendingSendState(pendingState);

    await persistDraftArtifact({
      ...artifact,
      status: 'sent',
      updatedAt: now,
      sendMessageId: sent.id,
      confirmationId: trimmedId,
      note: 'Sent via explicit Telegram confirmation callback.',
    });

    await logEmailAction({
      userId,
      interactionId: artifact.interactionId,
      action: 'send_confirmed',
      draftRef: artifact.draftRef,
      threadId: artifact.threadId,
      confirmationId: trimmedId,
      note: `gmail_message_id=${sent.id}`,
    });

    return {
      status: 'sent',
      message: `Email sent successfully for draft ${artifact.draftRef}.`,
    };
  } catch (error) {
    const now = new Date().toISOString();
    const safeMessage = error instanceof GmailIntegrationError ? error.safeMessage : 'Unexpected Gmail send failure.';

    pendingState[trimmedId] = {
      ...pending,
      status: 'failed',
      resolvedAt: now,
      resolvedBy: userId,
      note: safeMessage,
    };
    await savePendingSendState(pendingState);

    await persistDraftArtifact({
      ...artifact,
      status: 'failed',
      updatedAt: now,
      confirmationId: trimmedId,
      note: safeMessage,
    });

    await logEmailAction({
      userId,
      interactionId: artifact.interactionId,
      action: 'send_failed',
      draftRef: artifact.draftRef,
      threadId: artifact.threadId,
      confirmationId: trimmedId,
      note: safeMessage,
    });

    return {
      status: 'failed',
      message: `Failed to send draft ${artifact.draftRef}: ${safeMessage}`,
    };
  }
}

export async function cancelPendingEmailSend(
  confirmationId: string,
  userId: string,
): Promise<EmailSendDecision> {
  const trimmedId = confirmationId.trim();
  if (!trimmedId) {
    return {
      status: 'ignored',
      message: 'Missing email send confirmation id.',
    };
  }

  const pendingState = await loadPendingSendState();
  const pending = pendingState[trimmedId];
  if (!pending) {
    return {
      status: 'ignored',
      message: 'This email confirmation request was not found (maybe already resolved).',
    };
  }

  if (pending.status === 'canceled') {
    return {
      status: 'ignored',
      message: `Email draft ${pending.draftRef} was already canceled.`,
    };
  }

  if (pending.status === 'confirmed') {
    return {
      status: 'ignored',
      message: `Email draft ${pending.draftRef} was already sent and cannot be canceled now.`,
    };
  }

  const now = new Date().toISOString();
  pendingState[trimmedId] = {
    ...pending,
    status: 'canceled',
    resolvedAt: now,
    resolvedBy: userId,
    note: 'Canceled via Telegram confirmation callback.',
  };
  await savePendingSendState(pendingState);

  const artifact = await readDraftArtifact(pending.draftRef);
  if (artifact) {
    await persistDraftArtifact({
      ...artifact,
      status: 'canceled',
      updatedAt: now,
      confirmationId: trimmedId,
      note: 'Send canceled by user. Draft preserved for later edits.',
    });

    await logEmailAction({
      userId,
      interactionId: artifact.interactionId,
      action: 'send_canceled',
      draftRef: artifact.draftRef,
      threadId: artifact.threadId,
      confirmationId: trimmedId,
    });
  }

  return {
    status: 'canceled',
    message: `Canceled send for draft ${pending.draftRef}. Draft remains saved.`,
  };
}

async function handleSnoozeAction(input: SkillExecutionInput, context: SkillExecutionContext): Promise<SkillResult> {
  const threadId = extractThreadId(input);
  if (!threadId) {
    return {
      status: 'needs_clarification',
      intent: 'email',
      response: 'Tell me which thread to snooze. Example: snooze thread <ThreadRef>.',
    };
  }

  const stateMap = await loadTriageThreadStateMap();
  const now = new Date();
  const snoozedUntil = new Date(now.getTime() + 4 * 60 * 60 * 1000);

  stateMap[threadId] = {
    threadId,
    status: 'active',
    updatedAt: now.toISOString(),
    updatedBy: context.userId,
    snoozedUntil: snoozedUntil.toISOString(),
  };

  await saveTriageThreadStateMap(stateMap);

  await logTriageOutcome({
    userId: context.userId,
    action: 'snooze',
    threadId,
    snoozedUntil: snoozedUntil.toISOString(),
    interactionId: context.interactionId,
  });

  return {
    status: 'success',
    intent: 'email',
    response: `Snoozed thread ${threadId} for 4 hours (until ${snoozedUntil.toLocaleTimeString()}).`,
    metadata: { threadId, snoozedUntil: snoozedUntil.toISOString() },
  };
}

async function handleRemindTomorrowAction(input: SkillExecutionInput, context: SkillExecutionContext): Promise<SkillResult> {
  const threadId = extractThreadId(input);
  if (!threadId) {
    return {
      status: 'needs_clarification',
      intent: 'email',
      response: 'Tell me which thread to remind about tomorrow. Example: remind tomorrow thread <ThreadRef>.',
    };
  }

  const stateMap = await loadTriageThreadStateMap();
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(8, 0, 0, 0);

  stateMap[threadId] = {
    threadId,
    status: 'active',
    updatedAt: now.toISOString(),
    updatedBy: context.userId,
    snoozedUntil: tomorrow.toISOString(),
  };

  await saveTriageThreadStateMap(stateMap);

  await logTriageOutcome({
    userId: context.userId,
    action: 'snooze',
    threadId,
    snoozedUntil: tomorrow.toISOString(),
    note: 'remind_tomorrow',
    interactionId: context.interactionId,
  });

  return {
    status: 'success',
    intent: 'email',
    response: `Will remind you about thread ${threadId} tomorrow morning.`,
    metadata: { threadId, snoozedUntil: tomorrow.toISOString() },
  };
}

async function handleMarkNoReplyAction(input: SkillExecutionInput, context: SkillExecutionContext): Promise<SkillResult> {
  const threadId = extractThreadId(input);
  if (!threadId) {
    return {
      status: 'needs_clarification',
      intent: 'email',
      response: 'Tell me which thread to mark as no-reply. Example: mark no-reply thread <ThreadRef>.',
    };
  }

  const stateMap = await loadTriageThreadStateMap();
  stateMap[threadId] = {
    threadId,
    status: 'no_reply_needed',
    updatedAt: new Date().toISOString(),
    updatedBy: context.userId,
  };
  await saveTriageThreadStateMap(stateMap);

  await logTriageOutcome({
    userId: context.userId,
    action: 'marked_no_reply',
    threadId,
    interactionId: context.interactionId,
  });

  return {
    status: 'success',
    intent: 'email',
    response: `Marked thread ${threadId} as no-reply-needed.`,
    metadata: { threadId },
  };
}

async function handleMarkDoneAction(input: SkillExecutionInput, context: SkillExecutionContext): Promise<SkillResult> {
  const threadId = extractThreadId(input);
  if (!threadId) {
    return {
      status: 'needs_clarification',
      intent: 'email',
      response: 'Tell me which thread to mark as done. Example: mark done thread <ThreadRef>.',
    };
  }

  const stateMap = await loadTriageThreadStateMap();
  stateMap[threadId] = {
    threadId,
    status: 'done',
    updatedAt: new Date().toISOString(),
    updatedBy: context.userId,
  };
  await saveTriageThreadStateMap(stateMap);

  await logTriageOutcome({
    userId: context.userId,
    action: 'marked_done',
    threadId,
    interactionId: context.interactionId,
  });

  return {
    status: 'success',
    intent: 'email',
    response: `Marked thread ${threadId} as done.`,
    metadata: { threadId },
  };
}

export const emailSkill: SkillHandler = {
  name: 'email',
  async execute(input, context): Promise<SkillResult> {
    const action = detectAction(input);

    try {
      if (action === 'status') {
        return await handleStatusAction();
      }

      if (action === 'connect') {
        return await handleConnectAction();
      }

      if (action === 'auth_code') {
        return await handleAuthCodeAction(input);
      }

      if (action === 'inbox') {
        return await handleInboxAction();
      }

      if (action === 'draft') {
        return await handleDraftAction(input, context);
      }

      if (action === 'snooze') {
        return await handleSnoozeAction(input, context);
      }

      if (action === 'remind_tomorrow') {
        return await handleRemindTomorrowAction(input, context);
      }

      if (action === 'mark_no_reply') {
        return await handleMarkNoReplyAction(input, context);
      }

      if (action === 'mark_done') {
        return await handleMarkDoneAction(input, context);
      }

      return await handleSendAction(input);
    } catch (error) {
      return {
        status: 'error',
        intent: 'email',
        response: buildUnavailableResponse(error),
      };
    }
  },
};
