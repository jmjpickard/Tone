#!/usr/bin/env node

async function run(): Promise<void> {
  const [, , command] = process.argv;

  if (!command || command === 'start') {
    await import('./index.js');
    return;
  }

  if (command === 'help' || command === '--help' || command === '-h') {
    console.log('Tone CLI\n\nUsage:\n  tone start   Start the Tone bot\n  tone help    Show this help message');
    return;
  }

  console.error(`Unknown command: ${command}`);
  console.error('Run "tone help" to see available commands.');
  process.exitCode = 1;
}

void run();
