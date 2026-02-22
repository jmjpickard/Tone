import fs from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { config } from './config.js';

export interface VaultNote {
  frontmatter: Record<string, unknown>;
  content: string;
}

export interface ListedNote {
  path: string;
  modifiedAt: string;
  sizeBytes: number;
}

export interface SearchResult {
  path: string;
  line: number;
  snippet: string;
}

export interface WikiLinkResolution {
  path: string | null;
  ambiguousMatches: string[];
}

function sanitizeRelativePath(inputPath: string): string {
  const normalized = inputPath.trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (normalized.length === 0) {
    throw new Error('Path must not be empty.');
  }
  return normalized;
}

function resolveInsideVault(relativePath: string): string {
  const safeRelativePath = sanitizeRelativePath(relativePath);
  const resolvedPath = path.resolve(config.vault.rootPath, safeRelativePath);
  const vaultRootWithSep = `${config.vault.rootPath}${path.sep}`;

  if (resolvedPath !== config.vault.rootPath && !resolvedPath.startsWith(vaultRootWithSep)) {
    throw new Error(`Path traversal is not allowed: ${relativePath}`);
  }

  return resolvedPath;
}

function formatNote(frontmatter: Record<string, unknown> | undefined, content: string): string {
  if (!frontmatter || Object.keys(frontmatter).length === 0) {
    return content;
  }

  const yamlBlock = stringifyYaml(frontmatter).trimEnd();
  const normalizedContent = content.startsWith('\n') ? content.slice(1) : content;

  return `---\n${yamlBlock}\n---\n${normalizedContent}`;
}

function parseNote(rawContent: string): VaultNote {
  const match = rawContent.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return {
      frontmatter: {},
      content: rawContent,
    };
  }

  const parsed = parseYaml(match[1] ?? '');
  const frontmatter = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};

  return {
    frontmatter,
    content: match[2] ?? '',
  };
}

async function collectMarkdownFiles(rootDir: string): Promise<string[]> {
  const discovered: string[] = [];

  async function walk(currentDir: string): Promise<void> {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const absolutePath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        discovered.push(absolutePath);
      }
    }
  }

  await walk(rootDir);
  return discovered;
}

function normalizeWikiName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\.md$/i, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .trim();
}

function normalizeWikiLinkInput(input: string): string {
  const normalizedRaw = input
    .trim()
    .replace(/^\[\[/, '')
    .replace(/\]\]$/, '');
  const firstSegment = normalizedRaw.split('|')[0];

  if (firstSegment === undefined) {
    throw new Error('Wiki link must not be empty.');
  }

  const stripped = firstSegment.trim();

  if (stripped.length === 0) {
    throw new Error('Wiki link must not be empty.');
  }

  return stripped;
}

export async function readNote(notePath: string): Promise<VaultNote> {
  const absolutePath = resolveInsideVault(notePath);
  const raw = await fs.readFile(absolutePath, 'utf8');
  return parseNote(raw);
}

export async function writeNote(
  notePath: string,
  content: string,
  frontmatter: Record<string, unknown> = {},
): Promise<void> {
  const absolutePath = resolveInsideVault(notePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, formatNote(frontmatter, content), 'utf8');
}

export async function appendNote(notePath: string, content: string): Promise<void> {
  const absolutePath = resolveInsideVault(notePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });

  let existing = '';
  try {
    existing = await fs.readFile(absolutePath, 'utf8');
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
      throw error;
    }
  }

  const prefix = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
  await fs.appendFile(absolutePath, `${prefix}${content}`, 'utf8');
}

export async function listNotes(directory: string): Promise<ListedNote[]> {
  const absoluteDir = resolveInsideVault(directory);
  const entries = await fs.readdir(absoluteDir, { withFileTypes: true });

  const listed = await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map(async (entry) => {
        const absolutePath = path.join(absoluteDir, entry.name);
        const stats = await fs.stat(absolutePath);
        return {
          path: path.relative(config.vault.rootPath, absolutePath),
          modifiedAt: stats.mtime.toISOString(),
          sizeBytes: stats.size,
        };
      }),
  );

  return listed.sort((a, b) => a.path.localeCompare(b.path));
}

export async function searchNotes(query: string): Promise<SearchResult[]> {
  const trimmedQuery = query.trim();
  if (trimmedQuery.length === 0) {
    return [];
  }

  const markdownFiles = await collectMarkdownFiles(config.vault.rootPath);
  const loweredQuery = trimmedQuery.toLowerCase();
  const matches: SearchResult[] = [];

  for (const absolutePath of markdownFiles) {
    const raw = await fs.readFile(absolutePath, 'utf8');
    const lines = raw.split(/\r?\n/);

    lines.forEach((line, index) => {
      if (line.toLowerCase().includes(loweredQuery)) {
        matches.push({
          path: path.relative(config.vault.rootPath, absolutePath),
          line: index + 1,
          snippet: line.trim(),
        });
      }
    });
  }

  return matches;
}

export async function resolveWikiLink(wikiLink: string): Promise<WikiLinkResolution> {
  const normalizedInput = normalizeWikiLinkInput(wikiLink);

  if (normalizedInput.includes('/')) {
    const candidatePath = normalizedInput.endsWith('.md') ? normalizedInput : `${normalizedInput}.md`;
    const absoluteCandidate = resolveInsideVault(candidatePath);
    try {
      const stats = await fs.stat(absoluteCandidate);
      if (stats.isFile()) {
        return {
          path: path.relative(config.vault.rootPath, absoluteCandidate),
          ambiguousMatches: [],
        };
      }
    } catch {
      // Fall through to full-name resolution.
    }
  }

  const target = normalizeWikiName(normalizedInput);
  const markdownFiles = await collectMarkdownFiles(config.vault.rootPath);

  const matched = markdownFiles.filter((absolutePath) => {
    const baseName = path.basename(absolutePath, '.md');
    return normalizeWikiName(baseName) === target;
  });

  const matchedPaths = matched
    .map((absolutePath) => path.relative(config.vault.rootPath, absolutePath))
    .sort((a, b) => a.localeCompare(b));

  if (matchedPaths.length === 0) {
    return {
      path: null,
      ambiguousMatches: [],
    };
  }

  if (matchedPaths.length === 1) {
    const onlyMatch = matchedPaths[0];
    if (!onlyMatch) {
      return {
        path: null,
        ambiguousMatches: [],
      };
    }

    return {
      path: onlyMatch,
      ambiguousMatches: [],
    };
  }

  return {
    path: null,
    ambiguousMatches: matchedPaths,
  };
}
