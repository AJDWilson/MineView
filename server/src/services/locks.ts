import { HttpError } from '../util/errors.ts';

const locks = new Map<string, string>();

export function currentOperation(profileId: string): string | null {
  return locks.get(profileId) ?? null;
}

export function tryLock(profileId: string, name: string): void {
  const current = locks.get(profileId);
  if (current) throw new HttpError(409, `A ${current} operation is already running for this server`, 'BUSY');
  locks.set(profileId, name);
}

export function unlock(profileId: string): void {
  locks.delete(profileId);
}
