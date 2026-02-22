import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { promisify } from 'node:util';
import { resolveToneEnvPath, resolveToneHomePath } from './paths.js';

const execFileAsync = promisify(execFile);

interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function normalizeOutput(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }

  return value.trim();
}

async function runCommand(file: string, args: string[]): Promise<CommandResult> {
  try {
    const result = await execFileAsync(file, args, { encoding: 'utf8' });
    return {
      ok: true,
      stdout: normalizeOutput(result.stdout),
      stderr: normalizeOutput(result.stderr),
    };
  } catch (error) {
    const maybe = error as {
      stdout?: unknown;
      stderr?: unknown;
    };

    return {
      ok: false,
      stdout: normalizeOutput(maybe.stdout),
      stderr: normalizeOutput(maybe.stderr),
    };
  }
}

function isPathInside(parentPath: string, childPath: string): boolean {
  const parent = path.resolve(parentPath);
  const child = path.resolve(childPath);
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function assertSafeRemovalPath(targetPath: string): void {
  const resolved = path.resolve(targetPath);
  const rootPath = path.parse(resolved).root;
  if (resolved === rootPath) {
    throw new Error(`Refusing to remove unsafe path: ${resolved}`);
  }

  if (resolved === path.resolve(os.homedir())) {
    throw new Error(`Refusing to remove unsafe path: ${resolved}`);
  }
}

async function removeIfExists(targetPath: string): Promise<boolean> {
  try {
    await fs.rm(targetPath, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

async function stopSystemdServices(warnings: string[]): Promise<void> {
  const hasSystemctl = await runCommand('systemctl', ['--version']);
  if (!hasSystemctl.ok) {
    return;
  }

  const commands: Array<{ args: string[]; warning: string }> = [
    {
      args: ['--user', 'stop', 'tone.service'],
      warning: 'Failed to stop user systemd service tone.service.',
    },
    {
      args: ['--user', 'disable', 'tone.service'],
      warning: 'Failed to disable user systemd service tone.service.',
    },
    {
      args: ['--user', 'daemon-reload'],
      warning: 'Failed to reload user systemd daemon.',
    },
    {
      args: ['stop', 'tone.service'],
      warning:
        'Could not stop system tone.service (this may require root privileges if a system service was installed).',
    },
    {
      args: ['disable', 'tone.service'],
      warning:
        'Could not disable system tone.service (this may require root privileges if a system service was installed).',
    },
  ];

  for (const command of commands) {
    const result = await runCommand('systemctl', command.args);
    if (!result.ok && result.stderr.toLowerCase().includes('permission denied')) {
      warnings.push(command.warning);
    }
  }
}

async function removeSystemdUnitFiles(warnings: string[]): Promise<void> {
  const serviceFileCandidates = [
    path.join(os.homedir(), '.config', 'systemd', 'user', 'tone.service'),
    path.join(os.homedir(), '.local', 'share', 'systemd', 'user', 'tone.service'),
    '/etc/systemd/system/tone.service',
    '/lib/systemd/system/tone.service',
  ];

  for (const unitPath of serviceFileCandidates) {
    try {
      await fs.rm(unitPath, { force: true });
    } catch (error) {
      const maybe = error as { code?: string };
      if (maybe.code === 'EACCES' || maybe.code === 'EPERM') {
        warnings.push(
          `Could not remove ${unitPath} due to permissions. Remove it manually with elevated privileges if present.`,
        );
      }
    }
  }
}

async function resolveNpmPrefix(): Promise<string | null> {
  const result = await runCommand('npm', ['prefix', '--global']);
  if (!result.ok || result.stdout.length === 0) {
    return null;
  }

  return result.stdout;
}

async function uninstallGlobalPackage(warnings: string[]): Promise<void> {
  const result = await runCommand('npm', ['uninstall', '--global', 'tone']);
  if (!result.ok) {
    warnings.push(
      'Failed to uninstall global npm package `tone`. You may need to run `npm uninstall --global tone` manually.',
    );
  }
}

async function removeGlobalBin(warnings: string[]): Promise<void> {
  const prefix = await resolveNpmPrefix();
  if (!prefix) {
    warnings.push('Could not determine npm global prefix. Check for leftover `tone` binary manually.');
    return;
  }

  const binCandidates = [
    path.join(prefix, 'bin', 'tone'),
    path.join(prefix, 'bin', 'tone.cmd'),
    path.join(prefix, 'bin', 'tone.ps1'),
  ];

  for (const binPath of binCandidates) {
    try {
      await fs.rm(binPath, { force: true });
    } catch {
      warnings.push(`Could not remove ${binPath}. Remove it manually if it still exists.`);
    }
  }
}

export async function uninstall(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('tone uninstall requires an interactive terminal.');
  }

  const toneHomePath = resolveToneHomePath();
  const toneEnvPath = resolveToneEnvPath();
  assertSafeRemovalPath(toneHomePath);

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    console.log('Tone uninstall');
    console.log('');
    console.log('This will permanently delete Tone data from this machine:');
    console.log(`- Tone home directory: ${toneHomePath}`);
    if (!isPathInside(toneHomePath, toneEnvPath)) {
      console.log(`- Tone env file: ${toneEnvPath}`);
    }
    console.log('- Global npm package: tone');
    console.log('- Global tone executable');
    console.log('- Best-effort stop/disable of tone.service (user + system scopes)');
    console.log('');

    const sure = (await rl.question('Continue? (yes/no): ')).trim().toLowerCase();
    if (sure !== 'yes') {
      console.log('Uninstall cancelled.');
      return;
    }

    const phrase = (await rl.question('Type DELETE TONE to confirm permanent deletion: ')).trim();
    if (phrase !== 'DELETE TONE') {
      console.log('Uninstall cancelled.');
      return;
    }
  } finally {
    rl.close();
  }

  const warnings: string[] = [];

  await stopSystemdServices(warnings);
  await removeSystemdUnitFiles(warnings);

  const removedToneHome = await removeIfExists(toneHomePath);
  if (!removedToneHome) {
    warnings.push(`Failed to remove Tone home directory at ${toneHomePath}.`);
  }

  if (!isPathInside(toneHomePath, toneEnvPath)) {
    const removedEnv = await removeIfExists(toneEnvPath);
    if (!removedEnv) {
      warnings.push(`Failed to remove Tone env file at ${toneEnvPath}.`);
    }
  }

  await uninstallGlobalPackage(warnings);
  await removeGlobalBin(warnings);

  console.log('');
  if (warnings.length === 0) {
    console.log('Tone has been removed from this machine.');
    return;
  }

  console.log('Tone uninstall completed with warnings:');
  for (const warning of warnings) {
    console.log(`- ${warning}`);
  }
}
