import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { resolveToneHomePath } from './paths.js';

const STARTUP_TIMEOUT_MS = 7000;
const STOP_TIMEOUT_MS = 5000;
const FORCE_STOP_TIMEOUT_MS = 2000;
const POLL_INTERVAL_MS = 200;
const DEFAULT_LOG_LINES = 40;
const MAX_LOG_LINES = 500;
const STARTUP_MARKER = '[tone] bot is running';

interface ServicePaths {
  homeDir: string;
  runDir: string;
  logsDir: string;
  pidFile: string;
  logFile: string;
  previousLogFile: string;
}

interface LogsOptions {
  lines?: number;
}

interface StartupState {
  ready: boolean;
  alive: boolean;
}

function resolveServicePaths(): ServicePaths {
  const homeDir = resolveToneHomePath();
  const runDir = path.join(homeDir, 'run');
  const logsDir = path.join(homeDir, 'logs');

  return {
    homeDir,
    runDir,
    logsDir,
    pidFile: path.join(runDir, 'tone.pid'),
    logFile: path.join(logsDir, 'tone.log'),
    previousLogFile: path.join(logsDir, 'tone.log.1'),
  };
}

function isErrnoCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isErrnoCode(error, 'ESRCH')) {
      return false;
    }

    return true;
  }
}

async function ensureRuntimeDirs(paths: ServicePaths): Promise<void> {
  await fs.mkdir(paths.homeDir, { recursive: true });
  await fs.mkdir(paths.runDir, { recursive: true });
  await fs.mkdir(paths.logsDir, { recursive: true });
}

async function readPid(pidFile: string): Promise<number | undefined> {
  try {
    const raw = (await fs.readFile(pidFile, 'utf8')).trim();
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return undefined;
    }
    return parsed;
  } catch (error) {
    if (isErrnoCode(error, 'ENOENT')) {
      return undefined;
    }

    throw error;
  }
}

async function writePid(pidFile: string, pid: number): Promise<void> {
  await fs.writeFile(pidFile, `${pid}\n`, 'utf8');
}

async function removePidFile(pidFile: string): Promise<void> {
  await fs.rm(pidFile, { force: true });
}

async function rotateLogs(paths: ServicePaths): Promise<void> {
  await fs.rm(paths.previousLogFile, { force: true });

  try {
    await fs.rename(paths.logFile, paths.previousLogFile);
  } catch (error) {
    if (!isErrnoCode(error, 'ENOENT')) {
      throw error;
    }
  }
}

async function readLastLines(filePath: string, requestedLines: number): Promise<string> {
  const lineCount = Math.max(1, Math.min(requestedLines, MAX_LOG_LINES));

  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const lines = raw.split(/\r?\n/);
    if (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop();
    }
    return lines.slice(-lineCount).join('\n');
  } catch (error) {
    if (isErrnoCode(error, 'ENOENT')) {
      return '';
    }

    throw error;
  }
}

function resolveEntryPath(): string {
  const currentModulePath = fileURLToPath(import.meta.url);
  return path.join(path.dirname(currentModulePath), 'index.js');
}

async function waitForStartup(pid: number, logFile: string): Promise<StartupState> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return {
        ready: false,
        alive: false,
      };
    }

    const tail = await readLastLines(logFile, 120);
    if (tail.includes(STARTUP_MARKER)) {
      return {
        ready: true,
        alive: true,
      };
    }

    await sleep(POLL_INTERVAL_MS);
  }

  return {
    ready: false,
    alive: isProcessAlive(pid),
  };
}

async function waitForStop(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return true;
    }
    await sleep(POLL_INTERVAL_MS);
  }

  return !isProcessAlive(pid);
}

export async function startService(): Promise<void> {
  const paths = resolveServicePaths();
  await ensureRuntimeDirs(paths);

  const existingPid = await readPid(paths.pidFile);
  if (existingPid !== undefined) {
    if (isProcessAlive(existingPid)) {
      console.log(`Tone is already running in the background (PID ${existingPid}).`);
      console.log('Run `tone status` for details.');
      return;
    }

    await removePidFile(paths.pidFile);
  }

  await rotateLogs(paths);

  const logFd = openSync(paths.logFile, 'a');
  let child: ChildProcess;
  try {
    child = spawn(process.execPath, [resolveEntryPath()], {
      cwd: paths.homeDir,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: process.env,
    });
  } finally {
    closeSync(logFd);
  }

  if (child.pid === undefined) {
    throw new Error('Failed to start Tone in the background.');
  }

  child.unref();
  await writePid(paths.pidFile, child.pid);

  const startup = await waitForStartup(child.pid, paths.logFile);
  if (!startup.alive) {
    await removePidFile(paths.pidFile);
    throw new Error('Tone exited during startup. Run `tone logs` to inspect failure output.');
  }

  if (startup.ready) {
    console.log(`Tone started in the background (PID ${child.pid}).`);
    console.log(`Log file: ${paths.logFile}`);
    console.log('Run `tone status` or `tone logs`.');
    return;
  }

  console.log(`Tone started in the background (PID ${child.pid}), but readiness was not confirmed yet.`);
  console.log('Run `tone status` and `tone logs` to verify.');
}

export async function stopService(): Promise<void> {
  const paths = resolveServicePaths();
  const pid = await readPid(paths.pidFile);

  if (pid === undefined) {
    console.log('Tone is not running.');
    return;
  }

  if (!isProcessAlive(pid)) {
    await removePidFile(paths.pidFile);
    console.log('Tone is not running (removed stale PID file).');
    return;
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch (error) {
    if (isErrnoCode(error, 'ESRCH')) {
      await removePidFile(paths.pidFile);
      console.log('Tone is not running (removed stale PID file).');
      return;
    }
    throw error;
  }
  const stoppedGracefully = await waitForStop(pid, STOP_TIMEOUT_MS);

  if (!stoppedGracefully) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch (error) {
      if (!isErrnoCode(error, 'ESRCH')) {
        throw error;
      }
    }
    const stoppedForcefully = await waitForStop(pid, FORCE_STOP_TIMEOUT_MS);
    if (!stoppedForcefully) {
      throw new Error(`Unable to stop Tone process ${pid}.`);
    }
  }

  await removePidFile(paths.pidFile);
  console.log(`Tone stopped (PID ${pid}).`);
}

export async function showStatus(): Promise<void> {
  const paths = resolveServicePaths();
  const pid = await readPid(paths.pidFile);

  if (pid === undefined) {
    console.log('Tone status: stopped');
    console.log(`Log file: ${paths.logFile}`);
    return;
  }

  if (!isProcessAlive(pid)) {
    await removePidFile(paths.pidFile);
    console.log('Tone status: stopped (removed stale PID file)');
    console.log(`Log file: ${paths.logFile}`);
    return;
  }

  let startedAt = '';
  try {
    const stats = await fs.stat(paths.pidFile);
    startedAt = stats.mtime.toISOString();
  } catch {
    // Ignore stat failures and print status without timestamp.
  }

  console.log('Tone status: running');
  console.log(`PID: ${pid}`);
  if (startedAt) {
    console.log(`Started: ${startedAt}`);
  }
  console.log(`Log file: ${paths.logFile}`);
}

export async function showLogs(options: LogsOptions = {}): Promise<void> {
  const paths = resolveServicePaths();
  const requestedLines = options.lines ?? DEFAULT_LOG_LINES;

  if (!Number.isInteger(requestedLines) || requestedLines <= 0) {
    throw new Error('`tone logs` expects a positive integer for --lines.');
  }

  const output = await readLastLines(paths.logFile, requestedLines);
  if (!output) {
    console.log(`No logs found at ${paths.logFile}`);
    return;
  }

  console.log(output);
}
