import fs from 'node:fs';
import path from 'node:path';
import { HttpError } from './errors.ts';

const RESERVED = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

export function assertInside(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (relative === '') return;
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new HttpError(400, 'Path escapes the allowed directory', 'PATH_ESCAPE');
  }
}

export function resolveWithinRoot(root: string, userPath = ''): string {
  if (typeof userPath !== 'string' || userPath.includes('\0')) {
    throw new HttpError(400, 'Invalid path', 'PATH_INVALID');
  }
  let rootReal: string;
  try {
    rootReal = fs.realpathSync(root);
  } catch {
    throw new HttpError(400, 'Allowed directory is not available', 'ROOT_MISSING');
  }
  if (!fs.statSync(rootReal).isDirectory()) {
    throw new HttpError(400, 'Allowed root is not a directory', 'ROOT_MISSING');
  }

  const candidate = path.resolve(rootReal, userPath);
  assertInside(rootReal, candidate);

  if (fs.existsSync(candidate)) {
    let real: string;
    try {
      real = fs.realpathSync(candidate);
    } catch {
      throw new HttpError(400, 'Path cannot be resolved', 'PATH_INVALID');
    }
    assertInside(rootReal, real);
    return real;
  }

  let parent = path.dirname(candidate);
  const missing = [path.basename(candidate)];
  const seen = new Set<string>();
  while (!fs.existsSync(parent)) {
    if (seen.has(parent)) throw new HttpError(400, 'Path escapes the allowed directory', 'PATH_ESCAPE');
    seen.add(parent);
    missing.push(path.basename(parent));
    const next = path.dirname(parent);
    if (next === parent) throw new HttpError(400, 'Path escapes the allowed directory', 'PATH_ESCAPE');
    parent = next;
  }
  const parentReal = fs.realpathSync(parent);
  assertInside(rootReal, parentReal);
  const full = path.resolve(parentReal, ...missing.reverse());
  assertInside(rootReal, full);
  return full;
}

export function isDriveRoot(target: string): boolean {
  const resolved = path.resolve(target);
  return resolved === path.parse(resolved).root;
}

export function isBlockedSystemPath(target: string): boolean {
  const resolved = path.resolve(target);
  const blocked = [process.env.WINDIR, process.env.SystemRoot, process.env.ProgramFiles, process.env['ProgramFiles(x86)']]
    .filter((value): value is string => Boolean(value))
    .map((value) => path.resolve(value));
  return blocked.some((root) => {
    const relative = path.relative(root, resolved);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  });
}

export function assertSafeServerDirectory(dir: string): string {
  if (!dir || typeof dir !== 'string') throw new HttpError(400, 'Server directory is required', 'BAD_DIRECTORY');
  let real: string;
  try {
    real = fs.realpathSync(dir);
  } catch {
    throw new HttpError(400, 'Server directory does not exist', 'BAD_DIRECTORY');
  }
  if (!fs.statSync(real).isDirectory()) throw new HttpError(400, 'Server path is not a directory', 'BAD_DIRECTORY');
  if (isDriveRoot(real)) throw new HttpError(400, 'A drive root cannot be used as a server directory', 'BAD_DIRECTORY');
  if (isBlockedSystemPath(real)) throw new HttpError(400, 'That directory is a protected system location', 'BAD_DIRECTORY');
  return real;
}

export function assertJavaExecutable(javaPath: string): string {
  if (!javaPath || typeof javaPath !== 'string' || javaPath.includes('\0')) {
    throw new HttpError(400, 'Java executable path is required', 'BAD_JAVA');
  }
  let real: string;
  try {
    real = fs.realpathSync(javaPath);
  } catch {
    throw new HttpError(400, 'Java executable was not found', 'BAD_JAVA');
  }
  if (!fs.statSync(real).isFile()) throw new HttpError(400, 'Java path is not a file', 'BAD_JAVA');
  const base = path.basename(real).toLowerCase();
  if (base !== 'java.exe' && base !== 'java') {
    throw new HttpError(400, 'Java path must point at java.exe', 'BAD_JAVA');
  }
  return real;
}

export function sanitizeFilename(name: string, extension = '.jar'): string {
  if (typeof name !== 'string' || name.includes('\0')) throw new HttpError(400, 'Invalid file name', 'BAD_NAME');
  const normalized = name.replace(/\\/g, '/');
  if (normalized.includes('/') || normalized !== path.win32.basename(normalized)) {
    throw new HttpError(400, 'File name cannot include a folder', 'BAD_NAME');
  }
  const trimmed = normalized.trim();
  if (trimmed !== name.trim() || trimmed.endsWith('.') || trimmed.endsWith(' ')) {
    throw new HttpError(400, 'Invalid file name', 'BAD_NAME');
  }
  if (/[<>:"|?*]/.test(trimmed) || /[^\x20-\x7E]/.test(trimmed)) {
    throw new HttpError(400, 'File name contains unsupported characters', 'BAD_NAME');
  }
  if (!trimmed.toLowerCase().endsWith(extension)) {
    throw new HttpError(400, `File must use the ${extension} extension`, 'BAD_NAME');
  }
  if (trimmed.length > 120) throw new HttpError(400, 'File name is too long', 'BAD_NAME');
  const stem = trimmed.slice(0, -extension.length);
  if (!stem || stem.startsWith('.') || RESERVED.has(stem.toUpperCase())) {
    throw new HttpError(400, 'Invalid file name', 'BAD_NAME');
  }
  return trimmed;
}

export function isCriticalRelativePath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
  const base = path.posix.basename(normalized);
  const critical = new Set([
    'server.properties',
    'eula.txt',
    'whitelist.json',
    'ops.json',
    'banned-players.json',
    'banned-ips.json',
    'bukkit.yml',
    'spigot.yml',
    'commands.yml',
    'level.dat',
    'session.lock',
  ]);
  return critical.has(base) || normalized.endsWith('/level.dat') || normalized.endsWith('/session.lock');
}

export async function moveFile(source: string, dest: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  try {
    await fs.promises.rename(source, dest);
  } catch (error) {
    if (!isCrossDevice(error)) throw error;
    await fs.promises.copyFile(source, dest);
    await fs.promises.unlink(source);
  }
}

function isCrossDevice(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'EXDEV';
}

export function safeZipDestination(root: string, entryName: string): string {
  if (typeof entryName !== 'string' || !entryName || entryName.includes('\0')) {
    throw new HttpError(400, 'Archive entry is invalid', 'ZIP_SLIP');
  }
  const normalized = entryName.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized) || normalized.includes(':')) {
    throw new HttpError(400, 'Archive contains an absolute path', 'ZIP_SLIP');
  }
  const parts = normalized.split('/').filter((part) => part !== '' && part !== '.');
  if (!parts.length) throw new HttpError(400, 'Archive entry is invalid', 'ZIP_SLIP');
  if (parts.some((part) => part === '..' || RESERVED.has(part.toUpperCase()) || /[<>:"|?*]/.test(part))) {
    throw new HttpError(400, 'Archive entry escapes the destination', 'ZIP_SLIP');
  }
  const dest = path.resolve(root, ...parts);
  assertInside(path.resolve(root), dest);
  return dest;
}
