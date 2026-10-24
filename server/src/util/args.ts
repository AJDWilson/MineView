import { HttpError } from './errors.ts';

export function splitArgs(input: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (const ch of input.trim()) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        out.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (quote) throw new HttpError(400, 'Unclosed quote in launch arguments', 'BAD_ARGS');
  if (current) out.push(current);
  if (out.some((arg) => /[\r\n\0]/.test(arg))) {
    throw new HttpError(400, 'Launch arguments cannot contain new lines', 'BAD_ARGS');
  }
  return out;
}

export function assertMemory(value: string): string {
  if (!/^\d{1,5}[MG]$/i.test(value)) {
    throw new HttpError(400, 'Memory must look like 1G or 512M', 'BAD_MEMORY');
  }
  return value.toUpperCase();
}

export function assertJvmArgs(input: string): string[] {
  const args = splitArgs(input);
  if (args.some((arg) => arg === '-jar' || arg === '-cp' || arg === '-classpath')) {
    throw new HttpError(400, 'Put the server JAR in the server profile, not in JVM arguments', 'BAD_ARGS');
  }
  return args;
}
