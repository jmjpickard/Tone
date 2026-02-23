import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveToneHomePath } from './paths.js';

const GITHUB_OWNER = 'jmjpickard';
const GITHUB_REPO = 'Tone';
const GITHUB_API_LATEST = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;

interface GithubRelease {
  tag_name: string;
  name: string;
  html_url: string;
}

interface PackageJson {
  version: string;
}

/** Normalises a version string or git tag to a bare semver (e.g. "v0.2.0" → "0.2.0"). */
function normaliseVersion(raw: string): string {
  return raw.replace(/^v/, '').trim();
}

/**
 * Compares two semver strings a and b.
 * Returns a positive number if a > b, negative if a < b, 0 if equal.
 */
function compareSemver(a: string, b: string): number {
  const parse = (v: string): number[] => v.split('.').map((p) => Number.parseInt(p, 10));
  const aParts = parse(a);
  const bParts = parse(b);
  const length = Math.max(aParts.length, bParts.length);

  for (let i = 0; i < length; i++) {
    const diff = (aParts[i] ?? 0) - (bParts[i] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }

  return 0;
}

/**
 * Reads the version field from the package.json located in the Tone app directory.
 * Returns null if the file cannot be read or parsed.
 */
async function readLocalVersion(appPath: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(appPath, 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as PackageJson;
    return normaliseVersion(parsed.version ?? '');
  } catch {
    return null;
  }
}

/**
 * Fetches the latest GitHub release for the Tone repository.
 * Returns null if the request fails or the response cannot be parsed.
 */
async function fetchLatestRelease(): Promise<GithubRelease | null> {
  try {
    const response = await fetch(GITHUB_API_LATEST, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'tone-cli',
      },
    });

    if (!response.ok) {
      return null;
    }

    return (await response.json()) as GithubRelease;
  } catch {
    return null;
  }
}

/**
 * Runs a shell command, streaming its stdout/stderr directly to the parent
 * process so the user sees live progress.
 * Resolves with the exit code once the process finishes.
 */
function runStreamed(command: string, args: string[], cwd: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      stdio: 'inherit',
      shell: false,
    });

    child.on('close', (code) => {
      resolve(code ?? 1);
    });
  });
}

/**
 * Runs the full update sequence inside the Tone app directory:
 *   1. git fetch --tags
 *   2. git checkout <tag>
 *   3. npm install
 *   4. npm run build
 *   5. npm install --global .
 *
 * Streams all output to the terminal so the user sees live progress.
 * Throws if any step fails.
 */
async function applyUpdate(appPath: string, tag: string): Promise<void> {
  const steps: Array<{ label: string; command: string; args: string[] }> = [
    { label: 'Fetching tags', command: 'git', args: ['fetch', '--tags'] },
    { label: `Checking out ${tag}`, command: 'git', args: ['checkout', tag] },
    { label: 'Installing dependencies', command: 'npm', args: ['install'] },
    { label: 'Building', command: 'npm', args: ['run', 'build'] },
    { label: 'Reinstalling CLI globally', command: 'npm', args: ['install', '--global', '.'] },
  ];

  for (const step of steps) {
    console.log(`\n[update] ${step.label}…`);
    const exitCode = await runStreamed(step.command, step.args, appPath);
    if (exitCode !== 0) {
      throw new Error(`Step "${step.label}" failed with exit code ${exitCode}.`);
    }
  }
}

/**
 * Checks for a newer GitHub release and, if one is found, pulls the latest
 * tag, rebuilds the project, and reinstalls the CLI globally.
 *
 * Prints informative progress messages throughout so the user knows what
 * is happening at each stage.
 */
export async function update(): Promise<void> {
  const appPath = path.join(resolveToneHomePath(), 'app');

  console.log('[update] Checking for updates…');

  const [localVersion, release] = await Promise.all([
    readLocalVersion(appPath),
    fetchLatestRelease(),
  ]);

  if (!release) {
    throw new Error(
      'Could not fetch the latest release from GitHub. Check your internet connection and try again.',
    );
  }

  const latestVersion = normaliseVersion(release.tag_name);

  if (!localVersion) {
    console.log('[update] Could not determine the current installed version.');
    console.log(`[update] Latest release: ${release.tag_name} — ${release.html_url}`);
    console.log('[update] Run tone onboard or reinstall via install.sh to set up properly.');
    return;
  }

  console.log(`[update] Current version : ${localVersion}`);
  console.log(`[update] Latest release  : ${latestVersion} (${release.tag_name})`);

  if (compareSemver(latestVersion, localVersion) <= 0) {
    console.log('[update] Tone is already up to date.');
    return;
  }

  console.log(`\n[update] Updating ${localVersion} → ${latestVersion}…`);

  await applyUpdate(appPath, release.tag_name);

  console.log(`\n[update] Tone updated to ${latestVersion}.`);
}
