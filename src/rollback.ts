import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from './config.js';
import {
  createPreRollbackTag,
  createSnapshotTag,
  diff,
  refExists,
  rollback,
  summarizeDiffInPlainEnglish,
} from './evolution.js';
import type { RouterResult } from './types.js';

interface PendingRollbackOperation {
  id: string;
  userId: string;
  reference: string;
  paths: string[];
  requestedAt: string;
}

export interface RollbackPreview {
  pendingId: string;
  reference: string;
  paths: string[];
  summary: string;
  changedFiles: number;
}

export interface RollbackActionResult {
  status: 'prepared' | 'applied' | 'cancelled' | 'snapshot' | 'ignored';
  message: string;
  pendingId?: string;
}

type RollbackIntent =
  | {
      type: 'snapshot';
      snapshotName: string;
    }
  | {
      type: 'rollback';
      reference: string;
      paths: string[];
    };

function pendingStatePath(vaultRootPath = config.vault.rootPath): string {
  const safeVaultName = vaultRootPath
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
  return path.join(os.tmpdir(), `tone-rollback-pending-${safeVaultName || 'vault'}.json`);
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function normalizePath(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/^\/+/, '');
}

function sanitizeSnapshotName(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_/]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-/]+/, '')
    .replace(/[-/]+$/, '');

  if (!normalized) {
    throw new Error(`Snapshot name is empty or invalid: "${raw}"`);
  }

  return normalized;
}

function parseSnapshotName(text: string): string | null {
  const patterns = [
    /save(?: this)? state as\s+["']?([^"']+)["']?/i,
    /snapshot(?: this)?(?: state)? as\s+["']?([^"']+)["']?/i,
    /bookmark(?: this)?(?: state)? as\s+["']?([^"']+)["']?/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return sanitizeSnapshotName(match[1]);
    }
  }

  return null;
}

function parseWeekReference(text: string): string | null {
  const match = text.match(/week\s+(\d{1,2})/i);
  if (!match?.[1]) {
    return null;
  }
  return `week-${match[1].padStart(2, '0')}`;
}

function parseMdPath(text: string): string | null {
  const match = text.match(/\b([a-z0-9/_-]+\.md)\b/i);
  if (!match?.[1]) {
    return null;
  }
  return normalizePath(match[1]);
}

function parsePathHints(text: string): string[] {
  const lowered = text.toLowerCase();
  const paths = new Set<string>();

  const explicitPath = parseMdPath(text);
  if (explicitPath) {
    paths.add(explicitPath);
  }

  if (/\bbriefing\b/.test(lowered)) {
    paths.add('skills/briefing.md');
  }

  if (/\bpersonality\b/.test(lowered)) {
    paths.add('config/personality.md');
  }

  if (/\breward signal\b/.test(lowered)) {
    paths.add('config/reward-signals.md');
  }

  if (/\bboundar(?:y|ies)\b/.test(lowered)) {
    paths.add('config/boundaries.md');
  }

  if (/\bskill\b/.test(lowered) && !explicitPath) {
    paths.add('skills');
  }

  return [...paths];
}

function parseReferenceFromText(text: string): string | null {
  const weekReference = parseWeekReference(text);
  if (weekReference) {
    return weekReference;
  }

  const rollbackTargetPatterns = [
    /\b(?:rollback|revert|undo|go back to)\s+([a-z0-9._/-]+)/i,
    /\b(?:to|from)\s+([a-z0-9._/-]+)\b/i,
  ];

  for (const pattern of rollbackTargetPatterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      const candidate = normalizePath(match[1]);
      if (candidate && candidate !== 'to' && candidate !== 'from') {
        return candidate;
      }
    }
  }

  if (/\bundo last\b/i.test(text) || /\brevert last\b/i.test(text)) {
    return 'HEAD~1';
  }

  return null;
}

function parseEntityString(
  entities: RouterResult['extractedEntities'],
  key: string,
): string | null {
  const value = entities[key];
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = normalizeText(value);
  return normalized || null;
}

function resolveRollbackIntent(text: string, entities: RouterResult['extractedEntities']): RollbackIntent {
  const entityAction = parseEntityString(entities, 'action');
  const entitySnapshot = parseEntityString(entities, 'snapshotName');
  const entityReference = parseEntityString(entities, 'reference');
  const entityPath = parseEntityString(entities, 'path');

  const snapshotName = entitySnapshot || parseSnapshotName(text);
  if (entityAction === 'snapshot' || snapshotName) {
    if (!snapshotName) {
      throw new Error('Snapshot name missing. Example: "save this state as good-at-briefings".');
    }

    return {
      type: 'snapshot',
      snapshotName: snapshotName,
    };
  }

  const inferredReference = entityReference || parseReferenceFromText(text);
  if (!inferredReference) {
    throw new Error('Rollback reference missing. Example: "go back to week 06".');
  }

  const paths = new Set<string>();
  if (entityPath) {
    paths.add(normalizePath(entityPath));
  }

  for (const hintedPath of parsePathHints(text)) {
    paths.add(hintedPath);
  }

  if (paths.size === 0) {
    paths.add('skills');
    paths.add('config');
  }

  return {
    type: 'rollback',
    reference: inferredReference,
    paths: [...paths],
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

async function readPendingOperations(): Promise<PendingRollbackOperation[]> {
  const filePath = pendingStatePath();
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter(
      (item): item is PendingRollbackOperation =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as PendingRollbackOperation).id === 'string' &&
        typeof (item as PendingRollbackOperation).userId === 'string' &&
        typeof (item as PendingRollbackOperation).reference === 'string' &&
        Array.isArray((item as PendingRollbackOperation).paths) &&
        typeof (item as PendingRollbackOperation).requestedAt === 'string',
    );
  } catch (error) {
    if (isNotFoundError(error)) {
      return [];
    }

    throw error;
  }
}

async function writePendingOperations(operations: PendingRollbackOperation[]): Promise<void> {
  const filePath = pendingStatePath();
  await fs.writeFile(filePath, JSON.stringify(operations, null, 2), 'utf8');
}

async function savePendingOperation(operation: PendingRollbackOperation): Promise<void> {
  const operations = await readPendingOperations();
  const filtered = operations.filter((item) => item.userId !== operation.userId);
  filtered.push(operation);
  await writePendingOperations(filtered);
}

async function removePendingOperation(id: string): Promise<void> {
  const operations = await readPendingOperations();
  const filtered = operations.filter((item) => item.id !== id);
  await writePendingOperations(filtered);
}

async function findPendingOperation(id: string): Promise<PendingRollbackOperation | null> {
  const operations = await readPendingOperations();
  return operations.find((item) => item.id === id) ?? null;
}

export async function handleRollbackRequest(
  input: {
    userId: string;
    text: string;
    entities: RouterResult['extractedEntities'];
  },
): Promise<RollbackActionResult> {
  const intent = resolveRollbackIntent(input.text, input.entities);

  if (intent.type === 'snapshot') {
    const tagName = await createSnapshotTag(intent.snapshotName);
    return {
      status: 'snapshot',
      message: `Saved current state as ${tagName}.`,
    };
  }

  const reference = intent.reference;
  const exists = await refExists(reference);
  if (!exists) {
    return {
      status: 'ignored',
      message: `Reference "${reference}" was not found in the vault git history.`,
    };
  }

  const diffResult = await diff(reference, 'HEAD', intent.paths);
  if (diffResult.files.length === 0) {
    return {
      status: 'ignored',
      message: `No changes found between ${reference} and current state for ${intent.paths.join(', ')}.`,
    };
  }

  const summary = await summarizeDiffInPlainEnglish(reference, 'HEAD', {
    paths: intent.paths,
    maxCommits: 25,
  });
  const pendingId = randomUUID();
  await savePendingOperation({
    id: pendingId,
    userId: input.userId,
    reference,
    paths: intent.paths,
    requestedAt: new Date().toISOString(),
  });

  return {
    status: 'prepared',
    pendingId,
    message: [
      `Rollback preview (${reference} -> HEAD)`,
      `Scope: ${intent.paths.join(', ')}`,
      `Changed files: ${diffResult.files.length}`,
      '',
      summary,
      '',
      'Confirm rollback?',
    ].join('\n'),
  };
}

export async function confirmRollback(
  pendingId: string,
  userId: string,
): Promise<RollbackActionResult> {
  const pending = await findPendingOperation(pendingId);
  if (!pending) {
    return {
      status: 'ignored',
      message: 'Rollback request not found or already resolved.',
    };
  }

  if (pending.userId !== userId) {
    return {
      status: 'ignored',
      message: 'This rollback request belongs to another user.',
    };
  }

  const preRollbackTag = await createPreRollbackTag();
  const rollbackResult = await rollback(pending.reference, pending.paths);
  await removePendingOperation(pending.id);

  return {
    status: 'applied',
    message: `Rollback applied from ${pending.reference} for ${pending.paths.join(', ')}. Safety tag: ${preRollbackTag}. Commit: ${rollbackResult.hash}.`,
  };
}

export async function cancelRollback(
  pendingId: string,
  userId: string,
): Promise<RollbackActionResult> {
  const pending = await findPendingOperation(pendingId);
  if (!pending) {
    return {
      status: 'ignored',
      message: 'Rollback request not found or already resolved.',
    };
  }

  if (pending.userId !== userId) {
    return {
      status: 'ignored',
      message: 'This rollback request belongs to another user.',
    };
  }

  await removePendingOperation(pending.id);
  return {
    status: 'cancelled',
    message: 'Rollback cancelled.',
  };
}
