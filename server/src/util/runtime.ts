import path from 'node:path';

export function isPackaged(): boolean {
  const getter = (process as NodeJS.Process & { getBuiltinModule?: (id: string) => { isSea?: () => boolean } | undefined }).getBuiltinModule;
  if (!getter) return false;
  try {
    return getter('node:sea')?.isSea?.() === true;
  } catch {
    return false;
  }
}

export function appRoot(): string {
  if (process.env.MINEVIEW_ROOT) return path.resolve(process.env.MINEVIEW_ROOT);
  if (isPackaged()) return path.dirname(process.execPath);
  return process.cwd();
}
