import { HttpError } from './errors.ts';

const PLAYER_NAME = /^[A-Za-z0-9_]{1,16}$/;

export function assertPlayerName(name: unknown): string {
  if (typeof name !== 'string' || !PLAYER_NAME.test(name)) {
    throw new HttpError(400, 'Player name must be 1–16 letters, numbers, or underscores', 'BAD_PLAYER');
  }
  return name;
}

export function sanitizeReason(reason: unknown): string {
  if (typeof reason !== 'string') throw new HttpError(400, 'A reason is required', 'BAD_REASON');
  const cleaned = reason.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) throw new HttpError(400, 'A reason is required', 'BAD_REASON');
  if (cleaned.length > 200) throw new HttpError(400, 'Reason must be 200 characters or fewer', 'BAD_REASON');
  return cleaned;
}

export function sanitizeMessage(message: unknown): string {
  if (typeof message !== 'string') throw new HttpError(400, 'A message is required', 'BAD_MESSAGE');
  const cleaned = message.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) throw new HttpError(400, 'A message is required', 'BAD_MESSAGE');
  if (cleaned.length > 256) throw new HttpError(400, 'Message must be 256 characters or fewer', 'BAD_MESSAGE');
  return cleaned;
}

export function sanitizeConsoleCommand(command: unknown): string {
  if (typeof command !== 'string') throw new HttpError(400, 'Command is required', 'BAD_COMMAND');
  const trimmed = command.trim();
  if (!trimmed) throw new HttpError(400, 'Command is empty', 'BAD_COMMAND');
  if (trimmed.length > 2000) throw new HttpError(400, 'Command is too long', 'BAD_COMMAND');
  if (/[\r\n\0]/.test(trimmed)) throw new HttpError(400, 'Command cannot contain new lines', 'BAD_COMMAND');
  return trimmed.startsWith('/') ? trimmed.slice(1) : trimmed;
}

export function durationToMs(value: unknown, unit: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new HttpError(400, 'Duration must be a positive whole number', 'BAD_DURATION');
  }
  if (unit !== 'minutes' && unit !== 'hours' && unit !== 'days') {
    throw new HttpError(400, 'Duration unit must be minutes, hours, or days', 'BAD_DURATION');
  }
  const unitMs = unit === 'minutes' ? 60_000 : unit === 'hours' ? 3_600_000 : 86_400_000;
  const ms = value * unitMs;
  if (ms > 366 * 86_400_000) throw new HttpError(400, 'Duration cannot exceed 366 days', 'BAD_DURATION');
  return ms;
}
