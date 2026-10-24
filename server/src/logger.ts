import fs from 'node:fs';
import path from 'node:path';

let logFile: string | null = null;

export function initLogger(dataDir: string): void {
  fs.mkdirSync(dataDir, { recursive: true });
  logFile = path.join(dataDir, 'app.log');
}

export function log(level: 'info' | 'warn' | 'error', message: string, error?: unknown): void {
  const line = `${new Date().toISOString()} ${level.toUpperCase()} ${redact(message)}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
  if (!logFile) return;
  const extra = error instanceof Error ? ` ${redact(error.message)}` : '';
  try {
    fs.appendFileSync(logFile, `${line}${extra}\n`);
  } catch {
    // Logging must not break server control.
  }
}

function redact(value: string): string {
  return value
    .replace(/scrypt\$[a-f0-9]+\$[a-f0-9]+/gi, '[redacted]')
    .replace(/https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/\S+/gi, '[discord-webhook]');
}
