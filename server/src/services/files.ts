import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { FileEntry } from '../../../shared/types.ts';
import { HttpError, isNodeError } from '../util/errors.ts';
import { isCriticalRelativePath, resolveWithinRoot } from '../util/paths.ts';

const TEXT_EXTENSIONS = new Set([
  '.properties', '.yml', '.yaml', '.json', '.txt', '.conf', '.toml', '.cfg', '.ini',
  '.sk', '.mcfunction', '.xml', '.csv', '.md', '.log', '.html', '.css', '.types',
]);

export function diskUsage(target: string): { free: number; total: number } | null {
  try {
    const stats = fs.statfsSync(target);
    return { free: Number(stats.bavail) * Number(stats.bsize), total: Number(stats.blocks) * Number(stats.bsize) };
  } catch {
    return null;
  }
}

export async function directorySize(root: string, deadline = Date.now() + 8000): Promise<number | null> {
  let total = 0;
  const stack = [root];
  while (stack.length) {
    if (Date.now() > deadline) return null;
    const dir = stack.pop()!;
    let entries: fs.Dirent[] = [];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) {
        try {
          total += (await fs.promises.stat(full)).size;
        } catch {
          // Skip files that disappear mid-scan.
        }
      }
    }
  }
  return total;
}

export async function listDirectory(root: string, userPath = ''): Promise<{ path: string; entries: FileEntry[] }> {
  const abs = resolveWithinRoot(root, userPath || '.');
  const stat = await fs.promises.stat(abs);
  if (!stat.isDirectory()) throw new HttpError(400, 'That path is not a folder', 'NOT_DIRECTORY');
  const relative = path.relative(root, abs);
  const entries = await fs.promises.readdir(abs, { withFileTypes: true });
  const rows: FileEntry[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(abs, entry.name);
    const rel = path.relative(root, full);
    try {
      const info = await fs.promises.stat(full);
      rows.push({
        name: entry.name,
        path: rel,
        type: info.isDirectory() ? 'directory' : 'file',
        size: info.isDirectory() ? null : info.size,
        modifiedAt: info.mtimeMs,
        critical: isCriticalRelativePath(rel),
      });
    } catch {
      // Skip unreadable entries.
    }
  }
  rows.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1));
  return { path: relative, entries: rows };
}

export async function readTextFile(root: string, userPath: string): Promise<{ path: string; content: string; hash: string; size: number; modifiedAt: number; critical: boolean }> {
  const abs = resolveWithinRoot(root, userPath);
  assertText(abs);
  const stat = await fs.promises.stat(abs);
  if (!stat.isFile()) throw new HttpError(400, 'That path is not a file', 'NOT_FILE');
  if (stat.size > 1_000_000) throw new HttpError(400, 'This file is too large to edit here', 'TOO_LARGE');
  const buffer = await fs.promises.readFile(abs);
  if (buffer.includes(0)) throw new HttpError(400, 'Binary files cannot be edited', 'BINARY');
  const content = buffer.toString('utf8');
  return {
    path: path.relative(root, abs),
    content,
    hash: sha256(content),
    size: stat.size,
    modifiedAt: stat.mtimeMs,
    critical: isCriticalRelativePath(path.relative(root, abs)),
  };
}

export async function writeTextFile(root: string, userPath: string, content: string, expectedHash: string, historyDir: string): Promise<{ hash: string }> {
  if (typeof content !== 'string' || content.includes('\0')) throw new HttpError(400, 'File content is invalid', 'BAD_CONTENT');
  if (Buffer.byteLength(content) > 1_000_000) throw new HttpError(400, 'File content is too large', 'TOO_LARGE');
  const abs = resolveWithinRoot(root, userPath);
  assertText(abs);
  if (fs.existsSync(abs)) {
    const current = await fs.promises.readFile(abs, 'utf8');
    if (sha256(current) !== expectedHash) {
      throw new HttpError(409, 'The file changed after it was opened. Reload it before saving.', 'CONFLICT');
    }
    await backupCopy(abs, historyDir, path.relative(root, abs));
  }
  await atomicWrite(abs, content);
  return { hash: sha256(content) };
}

export async function removePath(root: string, userPath: string, confirmCritical: boolean): Promise<void> {
  const abs = resolveWithinRoot(root, userPath);
  if (path.resolve(abs) === path.resolve(root)) throw new HttpError(400, 'The server directory itself cannot be deleted', 'PROTECTED');
  const relative = path.relative(root, abs);
  if (isCriticalRelativePath(relative) && !confirmCritical) {
    throw new HttpError(400, 'This is a critical server file. Confirm the deletion again.', 'CONFIRM_CRITICAL');
  }
  await fs.promises.rm(abs, { recursive: true, force: false });
}

export async function makeDirectory(root: string, userPath: string): Promise<void> {
  const abs = resolveWithinRoot(root, userPath);
  await fs.promises.mkdir(abs, { recursive: false });
}

export async function renamePath(root: string, from: string, toName: string): Promise<void> {
  if (!toName || /[\\/<>:"|?*]/.test(toName) || toName.includes('\0') || toName === '.' || toName === '..') {
    throw new HttpError(400, 'Invalid file name', 'BAD_NAME');
  }
  const abs = resolveWithinRoot(root, from);
  const dest = resolveWithinRoot(root, path.join(path.dirname(from), toName));
  if (fs.existsSync(dest)) throw new HttpError(409, 'A file with that name already exists', 'EXISTS');
  await fs.promises.rename(abs, dest);
}

export async function searchFiles(root: string, query: string): Promise<FileEntry[]> {
  const needle = query.trim().toLowerCase();
  if (needle.length < 2) throw new HttpError(400, 'Enter at least 2 characters', 'BAD_QUERY');
  const results: FileEntry[] = [];
  let visited = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 8 || results.length >= 200 || visited > 20_000) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      visited += 1;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory() && ['libraries', 'versions', 'cache'].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const relative = path.relative(root, full);
      if (entry.name.toLowerCase().includes(needle)) {
        const stat = await fs.promises.stat(full).catch(() => null);
        results.push({
          name: entry.name,
          path: relative,
          type: entry.isDirectory() ? 'directory' : 'file',
          size: stat && !entry.isDirectory() ? stat.size : null,
          modifiedAt: stat?.mtimeMs ?? null,
          critical: isCriticalRelativePath(relative),
        });
      }
      if (entry.isDirectory()) await walk(full, depth + 1);
    }
  };
  await walk(root, 0);
  return results;
}

export function revealPath(root: string, userPath: string): void {
  if (process.platform !== 'win32') throw new HttpError(400, 'Opening folders is implemented for Windows', 'UNSUPPORTED');
  const abs = resolveWithinRoot(root, userPath || '.');
  const explorer = path.join(process.env.SystemRoot || 'C:\\Windows', 'explorer.exe');
  const stat = fs.statSync(abs);
  const args = stat.isDirectory() ? [abs] : [`/select,${abs}`];
  const child = spawn(explorer, args, { detached: true, stdio: 'ignore', windowsHide: false, shell: false });
  child.unref();
}

export function resolveDownload(root: string, userPath: string): string {
  const abs = resolveWithinRoot(root, userPath);
  if (!fs.statSync(abs).isFile()) throw new HttpError(400, 'That path is not a file', 'NOT_FILE');
  return abs;
}

export async function saveUpload(root: string, directory: string, originalName: string, tempFile: string, replace: boolean): Promise<string> {
  const safeName = sanitizeUploadName(originalName);
  const dest = resolveWithinRoot(root, path.join(directory || '.', safeName));
  if (fs.existsSync(dest)) {
    if (!replace) throw new HttpError(409, 'A file with that name already exists', 'EXISTS');
    const backup = `${dest}.replaced-${Date.now()}`;
    await fs.promises.rename(dest, backup);
  }
  try {
    await fs.promises.rename(tempFile, dest);
  } catch (error) {
    if (isNodeError(error) && error.code === 'EXDEV') {
      await fs.promises.copyFile(tempFile, dest);
      await fs.promises.unlink(tempFile);
    } else {
      throw error;
    }
  }
  return path.relative(root, dest);
}

export function sanitizeUploadName(name: string): string {
  const base = path.win32.basename(name.replace(/\\/g, '/')).trim();
  if (!base || base !== name.replace(/\\/g, '/').trim() || /[<>:"|?*]/.test(base) || base.includes('\0') || base.length > 180) {
    throw new HttpError(400, 'Invalid file name', 'BAD_NAME');
  }
  return base;
}

export async function atomicWrite(file: string, content: string | Buffer): Promise<void> {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(tmp, content);
  try {
    await fs.promises.rename(tmp, file);
  } catch (error) {
    if (!fs.existsSync(file)) throw error;
    const holding = `${file}.holding-${randomUUID()}`;
    await fs.promises.rename(file, holding);
    try {
      await fs.promises.rename(tmp, file);
      await fs.promises.rm(holding, { force: true });
    } catch (inner) {
      await fs.promises.rename(holding, file).catch(() => undefined);
      throw inner;
    }
  }
}

export async function backupCopy(file: string, historyDir: string, relative: string): Promise<string> {
  const safe = relative.replace(/[\\/:]/g, '__');
  const dir = path.join(historyDir, safe);
  await fs.promises.mkdir(dir, { recursive: true });
  const dest = path.join(dir, `${Date.now()}.bak`);
  await fs.promises.copyFile(file, dest);
  const old = (await fs.promises.readdir(dir)).sort();
  while (old.length > 20) {
    const name = old.shift();
    if (name) await fs.promises.rm(path.join(dir, name), { force: true });
  }
  return dest;
}

export async function latestBackup(historyDir: string, relative: string): Promise<string | null> {
  const dir = path.join(historyDir, relative.replace(/[\\/:]/g, '__'));
  if (!fs.existsSync(dir)) return null;
  const files = (await fs.promises.readdir(dir)).sort();
  const last = files.at(-1);
  return last ? path.join(dir, last) : null;
}

export function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function assertText(file: string): void {
  const ext = path.extname(file).toLowerCase();
  if (!TEXT_EXTENSIONS.has(ext)) throw new HttpError(400, 'This file type cannot be edited in the browser', 'NOT_TEXT');
}
