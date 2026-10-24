import { HttpError } from './errors.ts';

export interface PropertyLine {
  type: 'blank' | 'comment' | 'pair';
  key?: string;
  value?: string;
  raw: string;
}

export function parseProperties(text: string): PropertyLine[] {
  return text.replace(/^\uFEFF/, '').split(/\r?\n/).map((raw) => {
    const trimmed = raw.trim();
    if (!trimmed) return { type: 'blank' as const, raw };
    if (trimmed.startsWith('#') || trimmed.startsWith('!')) return { type: 'comment' as const, raw };
    const eq = raw.indexOf('=');
    if (eq < 0) return { type: 'comment' as const, raw };
    return { type: 'pair' as const, key: raw.slice(0, eq).trim(), value: raw.slice(eq + 1).trim(), raw };
  });
}

export function getProperty(lines: PropertyLine[], key: string): string | undefined {
  return lines.find((line) => line.type === 'pair' && line.key === key)?.value;
}

export function setProperty(lines: PropertyLine[], key: string, value: string): PropertyLine[] {
  if (/[\r\n\0]/.test(key) || /[\r\n\0]/.test(value)) {
    throw new HttpError(400, 'Property values cannot contain new lines', 'BAD_PROPERTY');
  }
  let seen = false;
  const next = lines.map((line) => {
    if (line.type !== 'pair' || line.key !== key) return line;
    seen = true;
    if (line.value === value) return line;
    return { type: 'pair' as const, key, value, raw: `${key}=${value}` };
  });
  if (!seen) next.push({ type: 'pair', key, value, raw: `${key}=${value}` });
  return next;
}

export function stringifyProperties(lines: PropertyLine[]): string {
  const text = lines.map((line) => line.raw).join('\n');
  return text.endsWith('\n') || text.length === 0 ? text : `${text}\n`;
}
