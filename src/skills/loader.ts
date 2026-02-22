import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import type { SkillDefinition } from '../types.js';

interface SkillCache {
  signature: string;
  skills: SkillDefinition[];
}

let cache: SkillCache | undefined;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractSection(markdown: string, title: string): string {
  const headingPattern = new RegExp(
    `^##\\s+${escapeRegExp(title)}\\s*\\r?\\n([\\s\\S]*?)(?=^##\\s+|$)`,
    'im',
  );
  const match = markdown.match(headingPattern);
  if (!match || !match[1]) {
    return '';
  }

  return match[1].trim();
}

function parseListSection(markdownSection: string): string[] {
  return markdownSection
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).trim())
    .filter((line) => line.length > 0);
}

function parseSkillDefinition(filePath: string, markdown: string): SkillDefinition {
  const fileName = path.basename(filePath, '.md');
  const skillNameMatch = markdown.match(/^#\s*Skill:\s*(.+)$/im);
  const name = skillNameMatch?.[1]?.trim() || fileName;

  const triggerSection = extractSection(markdown, 'Trigger Patterns');
  const inputSection = extractSection(markdown, 'Input Format');
  const outputSection = extractSection(markdown, 'Output Format');
  const constraintsSection = extractSection(markdown, 'Constraints');

  return {
    name,
    triggers: parseListSection(triggerSection),
    inputSchema: inputSection,
    outputSchema: outputSection,
    constraints: parseListSection(constraintsSection),
    immutable: /\bIMMUTABLE\b/i.test(markdown),
  };
}

async function listSkillFiles(): Promise<string[]> {
  try {
    const entries = await fs.readdir(config.vault.skillsDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
      .map((entry) => path.join(config.vault.skillsDir, entry.name))
      .sort((a, b) => a.localeCompare(b));
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: string }).code === 'ENOENT'
    ) {
      return [];
    }

    throw error;
  }
}

async function buildSignature(files: string[]): Promise<string> {
  const stats = await Promise.all(files.map((filePath) => fs.stat(filePath)));
  return files
    .map((filePath, index) => {
      const stat = stats[index];
      return `${filePath}:${stat?.mtimeMs ?? 0}:${stat?.size ?? 0}`;
    })
    .join('|');
}

export async function loadSkills(options?: { forceRefresh?: boolean }): Promise<SkillDefinition[]> {
  const forceRefresh = options?.forceRefresh ?? false;
  const files = await listSkillFiles();
  const signature = await buildSignature(files);

  if (!forceRefresh && cache && cache.signature === signature) {
    return cache.skills;
  }

  const parsedSkills: SkillDefinition[] = [];

  for (const filePath of files) {
    const raw = await fs.readFile(filePath, 'utf8');
    parsedSkills.push(parseSkillDefinition(filePath, raw));
  }

  cache = {
    signature,
    skills: parsedSkills,
  };

  return parsedSkills;
}

export function clearSkillCache(): void {
  cache = undefined;
}
