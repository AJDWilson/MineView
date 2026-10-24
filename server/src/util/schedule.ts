import type { ScheduleSpec } from '../../../shared/types.ts';
import { HttpError } from './errors.ts';

export function assertSchedule(input: ScheduleSpec): ScheduleSpec {
  if (!input || (input.mode !== 'interval' && input.mode !== 'daily' && input.mode !== 'weekly')) {
    throw new HttpError(400, 'Schedule mode is invalid', 'BAD_SCHEDULE');
  }
  if (input.mode === 'interval') {
    const mins = input.intervalMinutes;
    if (typeof mins !== 'number' || !Number.isInteger(mins) || mins < 1 || mins > 60 * 24 * 30) {
      throw new HttpError(400, 'Interval must be between 1 minute and 30 days', 'BAD_SCHEDULE');
    }
    return { mode: 'interval', intervalMinutes: mins };
  }
  const time = input.time ?? '';
  if (!/^(\d{2}):(\d{2})$/.test(time)) throw new HttpError(400, 'Time must be HH:MM', 'BAD_SCHEDULE');
  const [hh, mm] = time.split(':').map(Number);
  if (hh! > 23 || mm! > 59) throw new HttpError(400, 'Time must be HH:MM', 'BAD_SCHEDULE');
  if (input.mode === 'daily') return { mode: 'daily', time };
  const days = [...new Set(input.days ?? [])].sort();
  if (!days.length || days.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
    throw new HttpError(400, 'Pick at least one weekday', 'BAD_SCHEDULE');
  }
  return { mode: 'weekly', time, days };
}

export function computeNextRun(schedule: ScheduleSpec, from = Date.now()): number {
  const spec = assertSchedule(schedule);
  if (spec.mode === 'interval') return from + spec.intervalMinutes! * 60_000;
  const [hh, mm] = spec.time!.split(':').map(Number);
  if (spec.mode === 'daily') {
    const next = new Date(from);
    next.setSeconds(0, 0);
    next.setHours(hh!, mm!, 0, 0);
    if (next.getTime() <= from) next.setDate(next.getDate() + 1);
    return next.getTime();
  }
  for (let add = 0; add <= 7; add++) {
    const next = new Date(from);
    next.setSeconds(0, 0);
    next.setHours(hh!, mm!, 0, 0);
    next.setDate(next.getDate() + add);
    if (spec.days!.includes(next.getDay()) && next.getTime() > from) return next.getTime();
  }
  throw new HttpError(400, 'Could not compute the next run', 'BAD_SCHEDULE');
}
