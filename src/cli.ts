#!/usr/bin/env node

async function run(): Promise<void> {
  const [, , rawCommand] = process.argv;
  const command = rawCommand ?? 'start';

  try {
    if (command === 'start') {
      await import('./index.js');
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
          '  tone start      Start the Tone bot',
          '  tone onboard    Configure Tone and initialize the vault',
          '  tone uninstall  Remove Tone from this machine',
          '  tone help       Show this help message',
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
