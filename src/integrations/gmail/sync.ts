import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../../config.js';
import type {
  EmailDraftArtifact,
  EmailTriageThreadState,
  EmailTriageThreadStateMap,
  EmailTriageSnapshot,
  GmailInboxMessage,
  GmailThread,
  PendingEmailSendState,
} from './types.js';

const EMAIL_ROOT = 'email';
const THREADS_DIR = `${EMAIL_ROOT}/threads`;
const DRAFTS_DIR = `${EMAIL_ROOT}/drafts`;
const TRIAGE_DIR = `${EMAIL_ROOT}/triage`;
const PENDING_SEND_STATE_PATH = `${DRAFTS_DIR}/pending-send-state.json`;
const TRIAGE_SNAPSHOT_PATH = `${TRIAGE_DIR}/latest.json`;
const TRIAGE_STATE_PATH = `${TRIAGE_DIR}/state.json`;
const VALID_DRAFT_STATUSES = new Set([
  'drafted',
  'pending_send_confirmation',
  'sent',
  'canceled',
  'failed',
]);
const VALID_PENDING_STATUSES = new Set(['pending', 'confirmed', 'canceled', 'failed']);
const VALID_TRIAGE_STATUSES = new Set(['active', 'done', 'no_reply_needed']);

function sanitizeFileSegment(value: string): string {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .slice(0, 120);
}

function resolveVaultPath(relativePath: string): string {
  const normalized = relativePath.trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized) {
    throw new Error('Vault path cannot be empty.');
  }

  const resolved = path.resolve(config.vault.rootPath, normalized);
  const vaultRootWithSep = `${config.vault.rootPath}${path.sep}`;

  if (resolved !== config.vault.rootPath && !resolved.startsWith(vaultRootWithSep)) {
    throw new Error(`Path traversal is not allowed: ${relativePath}`);
  }

  return resolved;
}

async function writeJson(relativePath: string, payload: unknown): Promise<void> {
  const absolutePath = resolveVaultPath(relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, JSON.stringify(payload, null, 2), 'utf8');
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'ENOENT'
  );
}

async function readJsonIfExists<T>(relativePath: string): Promise<T | null> {
  const absolutePath = resolveVaultPath(relativePath);
  try {
    const raw = await fs.readFile(absolutePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }
    throw error;
  }
}

function threadSnapshotPath(threadId: string): string {
  const safeThreadId = sanitizeFileSegment(threadId) || 'thread';
  return `${THREADS_DIR}/${safeThreadId}.md`;
}

function draftArtifactJsonPath(draftRef: string): string {
  const safeDraftRef = sanitizeFileSegment(draftRef) || 'draft';
  return `${DRAFTS_DIR}/${safeDraftRef}.json`;
}

function draftArtifactMarkdownPath(draftRef: string): string {
  const safeDraftRef = sanitizeFileSegment(draftRef) || 'draft';
  return `${DRAFTS_DIR}/${safeDraftRef}.md`;
}

function summarizeText(value: string, maxLength = 220): string {
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 3)}...`;
}

export async function persistThreadSummary(message: GmailInboxMessage): Promise<string> {
  const target = threadSnapshotPath(message.threadId);
  const absolutePath = resolveVaultPath(target);

  const markdown = [
    `# Gmail Thread ${message.threadId}`,
    '',
    `- Last synced: ${new Date().toISOString()}`,
    `- Subject: ${message.subject}`,
    `- From: ${message.from}`,
    `- Received: ${message.internalDate}`,
    `- Unread: ${message.unread ? 'yes' : 'no'}`,
    '',
    '## Snippet',
    message.snippet || '(no snippet)',
  ].join('\n');

  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, markdown, 'utf8');
  return target;
}

export async function persistThreadSnapshot(thread: GmailThread): Promise<string> {
  const target = threadSnapshotPath(thread.id);
  const absolutePath = resolveVaultPath(target);

  const messageBlocks = thread.messages.map((message, index) => {
    const toLine = message.to.length > 0 ? message.to.join(', ') : '(none)';
    const ccLine = message.cc.length > 0 ? message.cc.join(', ') : '(none)';

    return [
      `### Message ${index + 1}`,
      `- Message ID: ${message.id}`,
      `- Date: ${message.internalDate}`,
      `- From: ${message.from}`,
      `- To: ${toLine}`,
      `- Cc: ${ccLine}`,
      `- Subject: ${message.subject}`,
      '',
      message.bodyText ? summarizeText(message.bodyText, 1600) : message.snippet || '(no content)',
    ].join('\n');
  });

  const markdown = [
    `# Gmail Thread ${thread.id}`,
    '',
    `- Last synced: ${new Date().toISOString()}`,
    `- Messages: ${thread.messages.length}`,
    '',
    ...messageBlocks,
  ].join('\n\n');

  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, markdown, 'utf8');
  return target;
}

function formatDraftArtifactMarkdown(artifact: EmailDraftArtifact): string {
  return [
    `# Email Draft ${artifact.draftRef}`,
    '',
    `- Status: ${artifact.status}`,
    `- Updated: ${artifact.updatedAt}`,
    `- Thread: ${artifact.threadId}`,
    `- Gmail Draft ID: ${artifact.gmailDraftId}`,
    `- Gmail Message ID: ${artifact.gmailMessageId}`,
    `- To: ${artifact.to}`,
    `- Subject: ${artifact.subject}`,
    ...(artifact.confirmationId ? [`- Confirmation ID: ${artifact.confirmationId}`] : []),
    ...(artifact.sendMessageId ? [`- Sent Message ID: ${artifact.sendMessageId}`] : []),
    ...(artifact.note ? [`- Note: ${artifact.note}`] : []),
    '',
    '## Body',
    artifact.bodyText,
  ].join('\n');
}

export async function persistDraftArtifact(artifact: EmailDraftArtifact): Promise<void> {
  const jsonPath = draftArtifactJsonPath(artifact.draftRef);
  const markdownPath = draftArtifactMarkdownPath(artifact.draftRef);

  await writeJson(jsonPath, artifact);

  const absoluteMarkdownPath = resolveVaultPath(markdownPath);
  await fs.mkdir(path.dirname(absoluteMarkdownPath), { recursive: true });
  await fs.writeFile(absoluteMarkdownPath, formatDraftArtifactMarkdown(artifact), 'utf8');
}

export async function readDraftArtifact(draftRef: string): Promise<EmailDraftArtifact | null> {
  const jsonPath = draftArtifactJsonPath(draftRef);
  const parsed = await readJsonIfExists<Partial<EmailDraftArtifact>>(jsonPath);
  if (!parsed) {
    return null;
  }

  if (
    typeof parsed.draftRef !== 'string' ||
    typeof parsed.interactionId !== 'string' ||
    typeof parsed.createdAt !== 'string' ||
    typeof parsed.updatedAt !== 'string' ||
    typeof parsed.threadId !== 'string' ||
    typeof parsed.gmailDraftId !== 'string' ||
    typeof parsed.gmailMessageId !== 'string' ||
    typeof parsed.to !== 'string' ||
    typeof parsed.subject !== 'string' ||
    typeof parsed.bodyText !== 'string' ||
    typeof parsed.status !== 'string' ||
    !VALID_DRAFT_STATUSES.has(parsed.status)
  ) {
    return null;
  }

  return {
    draftRef: parsed.draftRef,
    interactionId: parsed.interactionId,
    createdAt: parsed.createdAt,
    updatedAt: parsed.updatedAt,
    threadId: parsed.threadId,
    gmailDraftId: parsed.gmailDraftId,
    gmailMessageId: parsed.gmailMessageId,
    to: parsed.to,
    subject: parsed.subject,
    bodyText: parsed.bodyText,
    status: parsed.status as EmailDraftArtifact['status'],
    ...(typeof parsed.sendMessageId === 'string' ? { sendMessageId: parsed.sendMessageId } : {}),
    ...(typeof parsed.confirmationId === 'string' ? { confirmationId: parsed.confirmationId } : {}),
    ...(typeof parsed.note === 'string' ? { note: parsed.note } : {}),
  };
}

export async function loadPendingSendState(): Promise<PendingEmailSendState> {
  const parsed = await readJsonIfExists<Record<string, unknown>>(PENDING_SEND_STATE_PATH);
  if (!parsed || typeof parsed !== 'object') {
    return {};
  }

  const normalizedEntries = Object.entries(parsed).filter((entry) => {
    const value = entry[1] as Partial<PendingEmailSendState[string]>;
    return (
      typeof value === 'object' &&
      value !== null &&
      typeof value.confirmationId === 'string' &&
      typeof value.draftRef === 'string' &&
      typeof value.createdAt === 'string' &&
      typeof value.status === 'string' &&
      VALID_PENDING_STATUSES.has(value.status)
    );
  });

  return Object.fromEntries(normalizedEntries) as PendingEmailSendState;
}

export async function savePendingSendState(state: PendingEmailSendState): Promise<void> {
  await writeJson(PENDING_SEND_STATE_PATH, state);
}

export async function persistTriageSnapshot(snapshot: EmailTriageSnapshot): Promise<void> {
  await writeJson(TRIAGE_SNAPSHOT_PATH, snapshot);
}

export async function loadLatestRawTriageSnapshot(): Promise<EmailTriageSnapshot | null> {
  return readJsonIfExists<EmailTriageSnapshot>(TRIAGE_SNAPSHOT_PATH);
}

function toTimestamp(value: string | undefined): number {
  if (!value) {
    return 0;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function shouldHideItem(
  threadState: EmailTriageThreadState | undefined,
  nowMs: number,
): boolean {
  if (!threadState) {
    return false;
  }

  if (threadState.status === 'done' || threadState.status === 'no_reply_needed') {
    return true;
  }

  const snoozedUntilMs = toTimestamp(threadState.snoozedUntil);
  if (snoozedUntilMs > nowMs) {
    return true;
  }

  return false;
}

export function applyTriageThreadState(
  snapshot: EmailTriageSnapshot,
  triageStateMap: EmailTriageThreadStateMap,
  now = new Date(),
): EmailTriageSnapshot {
  if (snapshot.status !== 'available') {
    return snapshot;
  }

  const nowMs = now.getTime();

  const needsReply = snapshot.needsReply.filter(
    (item) => !shouldHideItem(triageStateMap[item.threadId], nowMs),
  );
  const waitingOnThem = snapshot.waitingOnThem.filter(
    (item) => !shouldHideItem(triageStateMap[item.threadId], nowMs),
  );
  const staleThreads = snapshot.staleThreads.filter(
    (item) => !shouldHideItem(triageStateMap[item.threadId], nowMs),
  );

  return {
    ...snapshot,
    needsReply,
    waitingOnThem,
    staleThreads,
  };
}

export async function loadTriageThreadStateMap(): Promise<EmailTriageThreadStateMap> {
  const parsed = await readJsonIfExists<Record<string, unknown>>(TRIAGE_STATE_PATH);
  if (!parsed || typeof parsed !== 'object') {
    return {};
  }

  const entries = Object.entries(parsed).filter((entry): entry is [string, EmailTriageThreadState] => {
    const value = entry[1] as Partial<EmailTriageThreadState>;
    return (
      typeof value === 'object' &&
      value !== null &&
      typeof value.threadId === 'string' &&
      typeof value.status === 'string' &&
      VALID_TRIAGE_STATUSES.has(value.status) &&
      typeof value.updatedAt === 'string'
    );
  });

  return Object.fromEntries(entries);
}

export async function saveTriageThreadStateMap(state: EmailTriageThreadStateMap): Promise<void> {
  await writeJson(TRIAGE_STATE_PATH, state);
}

export async function loadLatestTriageSnapshot(): Promise<EmailTriageSnapshot | null> {
  const snapshot = await loadLatestRawTriageSnapshot();
  if (!snapshot) {
    return null;
  }

  const triageStateMap = await loadTriageThreadStateMap();
  return applyTriageThreadState(snapshot, triageStateMap);
}

export async function findLatestDraftForThread(threadId: string): Promise<EmailDraftArtifact | null> {
  const normalizedThreadId = threadId.trim();
  if (!normalizedThreadId) {
    return null;
  }

  const draftsDirectory = resolveVaultPath(DRAFTS_DIR);
  let entries: Array<{ name: string; isFile: boolean }>;
  try {
    const directoryEntries = await fs.readdir(draftsDirectory, { withFileTypes: true });
    entries = directoryEntries.map((entry) => ({
      name: entry.name,
      isFile: entry.isFile(),
    }));
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }
    throw error;
  }

  const candidateRefs = entries
    .filter((entry) => entry.isFile && entry.name.endsWith('.json') && entry.name !== 'pending-send-state.json')
    .map((entry) => entry.name.replace(/\.json$/i, ''))
    .filter((draftRef) => draftRef.length > 0);

  const matchedArtifacts: EmailDraftArtifact[] = [];
  for (const draftRef of candidateRefs) {
    const artifact = await readDraftArtifact(draftRef);
    if (artifact && artifact.threadId === normalizedThreadId) {
      matchedArtifacts.push(artifact);
    }
  }

  if (matchedArtifacts.length === 0) {
    return null;
  }

  matchedArtifacts.sort((left, right) => toTimestamp(right.updatedAt) - toTimestamp(left.updatedAt));
  return matchedArtifacts[0] ?? null;
}
