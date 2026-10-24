import type { LogLine } from '../../../shared/types.ts';

export type InterpretedLine =
  | { type: 'join'; name: string }
  | { type: 'leave'; name: string }
  | { type: 'uuid'; name: string; uuid: string }
  | { type: 'list'; names: string[]; online: number; max: number }
  | { type: 'started' }
  | { type: 'eula' }
  | { type: 'failed'; message: string }
  | { type: 'saved' }
  | { type: 'tps'; text: string };

const NAME = '[A-Za-z0-9_]{1,16}';

export function stripAnsi(text: string): string {
  return text.replace(/\u001B\[[0-9;]*m/g, '').replace(/\r/g, '');
}

export function classifyLine(text: string, stream: LogLine['stream']): LogLine['level'] {
  if (stream === 'system') return 'system';
  const trimmed = text.trim();
  if (/^\s*at [\w.$/\\<(]+/.test(text) || trimmed.startsWith('Caused by:') || trimmed.startsWith('... ')) {
    return 'stack';
  }
  if (/\b(ERROR|SEVERE|FATAL)\b/.test(text) || /Exception|Failed to start/.test(text)) return 'error';
  if (/\bWARN(ING)?\b/.test(text)) return 'warn';
  if (stream === 'stderr' && !/\bINFO\b/.test(text)) return 'warn';
  return 'info';
}

export function interpretLine(text: string): InterpretedLine | null {
  const join = new RegExp(`\\]: (${NAME}) joined the game\\s*$`).exec(text);
  if (join) return { type: 'join', name: join[1]! };
  const leave = new RegExp(`\\]: (${NAME}) left the game\\s*$`).exec(text);
  if (leave) return { type: 'leave', name: leave[1]! };
  const uuid = new RegExp(`UUID of player (${NAME}) is ([0-9a-fA-F-]{36})`).exec(text);
  if (uuid) return { type: 'uuid', name: uuid[1]!, uuid: uuid[2]! };
  const list = /There are (\d+) of a max of (\d+) players online(?:[:.]?\s*(.*))?/.exec(text);
  if (list) {
    const names = (list[3] ?? '')
      .split(',')
      .map((name) => name.trim())
      .filter((name) => new RegExp(`^${NAME}$`).test(name));
    return { type: 'list', names, online: Number(list[1]), max: Number(list[2]) };
  }
  if (/Done \([0-9.]+s\)!/.test(text) || /For help, type "help"/.test(text)) return { type: 'started' };
  if (/You need to agree to the EULA/i.test(text)) return { type: 'eula' };
  if (/Failed to start the minecraft server/i.test(text)) return { type: 'failed', message: text.trim() };
  if (/Saved the game/i.test(text)) return { type: 'saved' };
  if (/\bTPS\b|\bMSPT\b|tick times/i.test(text) && /\d/.test(text)) return { type: 'tps', text: text.trim() };
  return null;
}
