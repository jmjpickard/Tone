import os from 'node:os';
import path from 'node:path';

export function resolveToneHomePath(): string {
  const fromEnv = process.env.TONE_HOME?.trim();
  if (fromEnv && fromEnv.length > 0) {
    return path.resolve(fromEnv);
  }

  return path.join(os.homedir(), '.tone');
}

export function resolveToneEnvPath(): string {
  const fromEnv = process.env.TONE_ENV_PATH?.trim();
  if (fromEnv && fromEnv.length > 0) {
    return path.resolve(fromEnv);
  }

  return path.join(resolveToneHomePath(), '.env');
}
