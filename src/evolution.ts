import fs from 'node:fs/promises';
import path from 'node:path';
import {
  simpleGit,
  type DiffResultBinaryFile,
  type DiffResultNameStatusFile,
  type DiffResultTextFile,
  type SimpleGit,
} from 'simple-git';
import { config } from './config.js';
import { complete } from './llm.js';

export type EvolutionCommitType = 'correction' | 'nightly' | 'adapt';

export interface EvolutionCommitResult {
  hash: string;
  message: string;
  committed: boolean;
}

export interface EvolutionDiffFile {
  path: string;
  changes: number;
  insertions: number;
  deletions: number;
  binary: boolean;
}

export interface EvolutionDiffResult {
  fromRef: string;
  toRef: string;
  files: EvolutionDiffFile[];
  patch: string;
}

export interface EvolutionLogEntry {
  hash: string;
  date: string;
  message: string;
  authorName: string;
  authorEmail: string;
}

interface MergeBranchOptions {
  commitMessage?: string;
  commitType?: EvolutionCommitType;
}

export interface EvolutionSummaryOptions {
  paths?: string[];
  maxCommits?: number;
}

export interface EvolutionWeeklyLogInput {
  weekKey: string;
  decision: 'approved' | 'rejected';
  weekTag: string;
  totalInteractions: number;
  positiveSignals: number;
  negativeSignals: number;
  summary: string;
  skillChanges: string[];
  personalityTweaks: string[];
}

let gitClient: SimpleGit | undefined;

function git(): SimpleGit {
  if (gitClient) {
    return gitClient;
  }

  gitClient = simpleGit({
      baseDir: config.vault.rootPath,
    });
  return gitClient;
}

async function assertVaultRepo(): Promise<void> {
  const repo = await git().checkIsRepo();
  if (!repo) {
    throw new Error(
      `Vault path is not a git repository: ${config.vault.rootPath}. Run scripts/init-vault.sh first.`,
    );
  }
}

function normalizeRefName(raw: string, kind: 'tag' | 'branch' | 'ref'): string {
  const normalized = raw.trim();
  if (!normalized) {
    throw new Error(`Git ${kind} must not be empty.`);
  }

  if (/\s/.test(normalized)) {
    throw new Error(`Git ${kind} cannot contain whitespace: ${raw}`);
  }

  return normalized;
}

function normalizePathInput(inputPath: string): string {
  const normalized = path.posix.normalize(inputPath.trim().replace(/\\/g, '/')).replace(/^\/+/, '');
  if (!normalized || normalized === '.' || normalized === './') {
    return '.';
  }
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`Path traversal is not allowed in git path filters: ${inputPath}`);
  }
  return normalized;
}

function normalizePathFilters(paths?: string[]): string[] {
  if (!paths) {
    return [];
  }

  return paths.map((item) => normalizePathInput(item)).filter((item) => item.length > 0);
}

function prefixedCommitMessage(message: string, type: EvolutionCommitType): string {
  const normalized = message.trim().replace(/\s+/g, ' ');
  if (!normalized) {
    throw new Error('Commit message must not be empty.');
  }

  if (normalized.toLowerCase().startsWith(`${type}:`)) {
    return normalized;
  }

  return `${type}: ${normalized}`;
}

function cleanHash(rawHash: string): string {
  return rawHash.trim();
}

type AnyDiffFile = DiffResultTextFile | DiffResultBinaryFile | DiffResultNameStatusFile;

function mapDiffFile(file: AnyDiffFile): EvolutionDiffFile {
  const pathValue =
    'from' in file && typeof file.from === 'string' && file.from.length > 0
      ? `${file.from} -> ${file.file}`
      : file.file;
  const isBinary = file.binary;
  const changes = 'changes' in file ? file.changes : Math.abs(file.before - file.after);
  const insertions = 'insertions' in file ? file.insertions : 0;
  const deletions = 'deletions' in file ? file.deletions : 0;

  return {
    path: pathValue,
    changes,
    insertions,
    deletions,
    binary: isBinary,
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

async function readFileIfExists(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (isNotFoundError(error)) {
      return '';
    }

    throw error;
  }
}

function normalizeSnapshotName(rawName: string): string {
  const slug = rawName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_/]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-/]+/, '')
    .replace(/[-/]+$/, '');

  if (!slug) {
    throw new Error(`Invalid snapshot name: "${rawName}"`);
  }

  return slug.slice(0, 80);
}

function summarizeFiles(files: EvolutionDiffFile[]): string {
  if (files.length === 0) {
    return '(no file changes)';
  }

  return files
    .slice(0, 60)
    .map((file) => {
      const fileType = file.binary ? 'binary' : 'text';
      return `- ${file.path} (${fileType}, +${file.insertions}/-${file.deletions}, changes=${file.changes})`;
    })
    .join('\n');
}

function fallbackDiffSummary(diffResult: EvolutionDiffResult, commitMessages: string): string {
  const topFiles = diffResult.files.slice(0, 12).map((file) => file.path);
  const commitCount = commitMessages
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0).length;

  const sections: string[] = [];
  sections.push(`Compared ${diffResult.fromRef} -> ${diffResult.toRef}.`);
  sections.push(`Changed files: ${diffResult.files.length}. Commits in range: ${commitCount}.`);

  if (topFiles.length > 0) {
    sections.push(`Primary files: ${topFiles.join(', ')}.`);
  }

  const hasSkillChanges = diffResult.files.some((file) => file.path.includes('skills/'));
  const hasPersonalityChanges = diffResult.files.some((file) => file.path.includes('config/personality.md'));
  const hasAutonomicChanges = diffResult.files.some((file) => file.path.includes('feedback/autonomic.md'));
  const hasApprovalHistory = diffResult.files.some((file) => file.path.includes('feedback/weekly/'));

  const themes: string[] = [];
  if (hasSkillChanges) {
    themes.push('skills');
  }
  if (hasPersonalityChanges) {
    themes.push('personality');
  }
  if (hasAutonomicChanges) {
    themes.push('autonomic adjustments');
  }
  if (hasApprovalHistory) {
    themes.push('approval history');
  }

  if (themes.length > 0) {
    sections.push(`Notable areas: ${themes.join(', ')}.`);
  }

  return sections.join(' ');
}

async function collectCommitMessages(fromRef: string, toRef: string, maxCommits: number): Promise<string> {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(maxCommits)));
  const raw = await git().raw(['log', '--oneline', `-n`, String(safeLimit), `${fromRef}..${toRef}`]);
  return raw.trim();
}

export async function getDefaultBranch(): Promise<string> {
  await assertVaultRepo();
  const branches = await git().branchLocal();

  if (branches.all.includes('main')) {
    return 'main';
  }

  if (branches.all.includes('master')) {
    return 'master';
  }

  if (branches.current) {
    return branches.current;
  }

  throw new Error('Unable to detect a default branch for the vault repository.');
}

export async function getCurrentBranch(): Promise<string> {
  await assertVaultRepo();
  const branches = await git().branchLocal();
  if (!branches.current) {
    throw new Error('Unable to detect current branch in vault repository.');
  }

  return branches.current;
}

export async function checkoutBranch(name: string): Promise<void> {
  await assertVaultRepo();
  const branchName = normalizeRefName(name, 'branch');
  await git().checkout(branchName);
}

export async function commit(
  message: string,
  type: EvolutionCommitType,
): Promise<EvolutionCommitResult> {
  await assertVaultRepo();
  const commitMessage = prefixedCommitMessage(message, type);

  await git().add(['.']);
  const status = await git().status();
  if (status.isClean()) {
    return {
      hash: cleanHash(await git().revparse(['HEAD'])),
      message: commitMessage,
      committed: false,
    };
  }

  const result = await git().commit(commitMessage);

  return {
    hash: cleanHash(result.commit),
    message: commitMessage,
    committed: true,
  };
}

export async function tag(name: string): Promise<void> {
  await assertVaultRepo();
  const tagName = normalizeRefName(name, 'tag');
  const tags = await git().tags();

  if (tags.all.includes(tagName)) {
    return;
  }

  await git().addTag(tagName);
}

export async function createBranch(name: string): Promise<void> {
  await assertVaultRepo();
  const branchName = normalizeRefName(name, 'branch');
  const branches = await git().branchLocal();

  if (branches.all.includes(branchName)) {
    await git().checkout(branchName);
    return;
  }

  await git().checkoutLocalBranch(branchName);
}

export async function mergeBranch(
  name: string,
  options?: MergeBranchOptions,
): Promise<EvolutionCommitResult> {
  await assertVaultRepo();
  const branchName = normalizeRefName(name, 'branch');
  const targetBranch = await getDefaultBranch();

  await git().checkout(targetBranch);

  try {
    await git().merge(['--no-ff', '--no-commit', branchName]);
  } catch (error) {
    try {
      await git().merge(['--abort']);
    } catch {
      // Ignore merge abort errors and raise the original merge failure.
    }
    throw error;
  }

  return commit(
    options?.commitMessage ?? `merge ${branchName} into ${targetBranch}`,
    options?.commitType ?? 'adapt',
  );
}

export async function deleteBranch(name: string, force = false): Promise<void> {
  await assertVaultRepo();
  const branchName = normalizeRefName(name, 'branch');
  const currentBranch = await getCurrentBranch();

  if (currentBranch === branchName) {
    await git().checkout(await getDefaultBranch());
  }

  await git().deleteLocalBranch(branchName, force);
}

export async function diff(
  fromRef: string,
  toRef: string,
  paths?: string[],
): Promise<EvolutionDiffResult> {
  await assertVaultRepo();
  const normalizedFrom = normalizeRefName(fromRef, 'ref');
  const normalizedTo = normalizeRefName(toRef, 'ref');
  const pathFilters = normalizePathFilters(paths);
  const refRange = `${normalizedFrom}..${normalizedTo}`;
  const summaryArgs = pathFilters.length > 0 ? [refRange, '--', ...pathFilters] : [refRange];

  const diffSummary = await git().diffSummary(summaryArgs);
  const patch = await git().diff(summaryArgs);

  return {
    fromRef: normalizedFrom,
    toRef: normalizedTo,
    files: diffSummary.files.map((file) => mapDiffFile(file)),
    patch,
  };
}

export async function log(limit = 25): Promise<EvolutionLogEntry[]> {
  await assertVaultRepo();
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 25;
  const result = await git().log({ maxCount: safeLimit });

  return result.all.map((entry) => ({
    hash: entry.hash,
    date: entry.date,
    message: entry.message,
    authorName: entry.author_name,
    authorEmail: entry.author_email,
  }));
}

export async function rollback(ref: string, paths?: string[]): Promise<EvolutionCommitResult> {
  await assertVaultRepo();
  const normalizedRef = normalizeRefName(ref, 'ref');
  const pathFilters = normalizePathFilters(paths);

  if (pathFilters.length > 0) {
    await git().raw(['checkout', normalizedRef, '--', ...pathFilters]);
  } else {
    await git().raw(['checkout', normalizedRef, '--', '.']);
  }

  const targetDescription =
    pathFilters.length > 0 ? `restore ${pathFilters.join(', ')} from ${normalizedRef}` : `restore ${normalizedRef}`;

  return commit(targetDescription, 'adapt');
}

export async function getCurrentTag(): Promise<string | null> {
  await assertVaultRepo();

  try {
    const rawTag = await git().raw(['describe', '--tags', '--exact-match']);
    const normalizedTag = rawTag.trim();
    return normalizedTag.length > 0 ? normalizedTag : null;
  } catch {
    return null;
  }
}

export async function refExists(ref: string): Promise<boolean> {
  await assertVaultRepo();
  const normalizedRef = normalizeRefName(ref, 'ref');

  try {
    await git().revparse(['--verify', normalizedRef]);
    return true;
  } catch {
    return false;
  }
}

export async function summarizeDiffInPlainEnglish(
  fromRef: string,
  toRef: string,
  options?: EvolutionSummaryOptions,
): Promise<string> {
  await assertVaultRepo();
  const diffResult = await diff(fromRef, toRef, options?.paths);
  const commitMessages = await collectCommitMessages(fromRef, toRef, options?.maxCommits ?? 30);

  const prompt = [
    'Summarize this git diff in plain English for a user of an adaptive assistant.',
    'Keep it concise and concrete.',
    'Explicitly cover: skill changes, personality shifts, autonomic adjustments, and approval history.',
    'If one area has no changes, say that explicitly.',
    '',
    `From: ${diffResult.fromRef}`,
    `To: ${diffResult.toRef}`,
    `Changed files: ${diffResult.files.length}`,
    '',
    'Changed files and stats:',
    summarizeFiles(diffResult.files),
    '',
    'Commit messages in range:',
    commitMessages || '(none)',
    '',
    'Unified diff (truncated if long):',
    diffResult.patch.length > 12000 ? `${diffResult.patch.slice(0, 12000)}\n...[truncated]` : diffResult.patch,
  ].join('\n');

  const completion = await complete(prompt, 'tier2');
  if (completion.ok && completion.data.text.trim().length > 0) {
    return completion.data.text.trim();
  }

  return fallbackDiffSummary(diffResult, commitMessages);
}

export async function createSnapshotTag(rawName: string): Promise<string> {
  const normalized = normalizeSnapshotName(rawName);
  const tagName = normalized.startsWith('snapshot/') ? normalized : `snapshot/${normalized}`;
  await tag(tagName);
  return tagName;
}

export async function createPreRollbackTag(): Promise<string> {
  const now = new Date();
  const stamp = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(
    now.getUTCDate(),
  ).padStart(2, '0')}${String(now.getUTCHours()).padStart(2, '0')}${String(
    now.getUTCMinutes(),
  ).padStart(2, '0')}${String(now.getUTCSeconds()).padStart(2, '0')}`;
  const name = `pre-rollback-${stamp}`;
  await tag(name);
  return name;
}

export async function appendEvolutionLogEntry(input: EvolutionWeeklyLogInput): Promise<void> {
  const evolutionLogPath = path.join(config.vault.feedbackDir, 'evolution.md');
  const existing = await readFileIfExists(evolutionLogPath);
  const hasHeader = existing.trim().length > 0;

  const stateAtStart = [
    `- Snapshot tag: ${input.weekTag}`,
    `- Decision status: pending before ${input.decision}`,
    `- Weekly interaction volume baseline: ${input.totalInteractions}`,
  ];

  const changesThisWeek = [
    `- Decision: ${input.decision}`,
    ...input.skillChanges.map((item) => `- Skill: ${item}`),
    ...input.personalityTweaks.map((item) => `- Personality: ${item}`),
  ];

  if (input.skillChanges.length === 0 && input.personalityTweaks.length === 0) {
    changesThisWeek.push('- No approved/rejected behavior mutations recorded.');
  }

  const stateAtEnd = [
    input.decision === 'approved'
      ? '- Weekly proposal merged into default branch.'
      : '- Weekly proposal rejected; branch removed and rationale logged.',
    `- Explicit feedback totals: +${input.positiveSignals} / -${input.negativeSignals}`,
  ];

  const rewardTrend =
    input.positiveSignals === input.negativeSignals
      ? 'Reward trend was neutral this week.'
      : input.positiveSignals > input.negativeSignals
        ? `Reward trend improved by ${input.positiveSignals - input.negativeSignals} net positive signals.`
        : `Reward trend declined by ${input.negativeSignals - input.positiveSignals} net negative signals.`;

  const section = [
    '',
    `## Week ${input.weekKey}`,
    '',
    '### State at start of week',
    ...stateAtStart,
    '',
    '### Changes this week',
    ...changesThisWeek,
    '',
    '### Weekly summary',
    input.summary,
    '',
    '### State at end of week',
    ...stateAtEnd,
    '',
    '### Reward trend',
    rewardTrend,
  ].join('\n');

  const header = '# Evolution Log\n\n## Weekly Summaries\n';
  const nextContent = hasHeader ? `${existing.trimEnd()}\n${section}\n` : `${header}${section}\n`;

  await fs.mkdir(path.dirname(evolutionLogPath), { recursive: true });
  await fs.writeFile(evolutionLogPath, nextContent, 'utf8');
}
