#!/usr/bin/env node

function parseLogsLineCount(rawArgs: string[]): number {
  let lineCount = 40;

  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];

    if (arg === '--lines' || arg === '-n') {
      const value = rawArgs[index + 1];
      if (!value) {
        throw new Error(`Missing value for ${arg}.`);
      }

      const parsed = Number.parseInt(value, 10);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`Invalid log line count: ${value}`);
      }

      lineCount = parsed;
      index += 1;
      continue;
    }

    throw new Error(`Unknown option for logs: ${arg}`);
  }

  return lineCount;
}

function shouldRunForeground(rawArgs: string[]): boolean {
  if (rawArgs.length === 0) {
    return false;
  }

  if (rawArgs.length === 1 && rawArgs[0] === '--foreground') {
    return true;
  }

  throw new Error(`Unknown option for start: ${rawArgs.join(' ')}`);
}

async function run(): Promise<void> {
  const [, , rawCommand, ...rawArgs] = process.argv;
  const command = rawCommand ?? 'start';

  try {
    if (command === 'start') {
      if (shouldRunForeground(rawArgs)) {
        const { launch } = await import('./index.js');
        await launch();
      } else {
        const { startService } = await import('./service.js');
        await startService();
      }
      return;
    }

    if (command === 'stop') {
      const { stopService } = await import('./service.js');
      await stopService();
      return;
    }

    if (command === 'status') {
      const { showStatus } = await import('./service.js');
      await showStatus();
      return;
    }

    if (command === 'logs') {
      const { showLogs } = await import('./service.js');
      await showLogs({
        lines: parseLogsLineCount(rawArgs),
      });
      return;
    }

    if (command === 'onboard') {
      const { onboard } = await import('./onboard.js');
      await onboard();
      return;
    }

    if (command === 'uninstall') {
      const { uninstall } = await import('./uninstall.js');
      await uninstall();
      return;
    }

    if (command === 'help' || command === '--help' || command === '-h') {
      console.log(
        [
          'Tone CLI',
          '',
          'Usage:',
          '  tone start [--foreground]  Start Tone (background by default)',
          '  tone stop                  Stop the background Tone process',
          '  tone status                Show Tone process status',
          '  tone logs [-n N]           Show recent Tone logs',
          '  tone onboard               Configure Tone and initialize the vault',
          '  tone uninstall             Remove Tone from this machine',
          '  tone help                  Show this help message',
        ].join('\n'),
      );
      return;
    }

    console.error(`Unknown command: ${command}`);
    console.error('Run "tone help" to see available commands.');
    process.exitCode = 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[tone] ${message}`);
    process.exitCode = 1;
  }
}

void run();
