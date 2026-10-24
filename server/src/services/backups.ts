import fs from 'node:fs';
import path from 'node:path';
import type { BackupInfo, Profile } from '../../../shared/types.ts';
import type { AppDb } from '../db.ts';
import { newId } from '../db.ts';
import { HttpError } from '../util/errors.ts';
import { createZip, extractZip, listZipRoots } from '../util/zip.ts';
import { diskUsage } from './files.ts';
import { tryLock, unlock } from './locks.ts';
import type { ProcessManager } from './processManager.ts';

export function shouldSkipBackup(relative: string, excludeLogs: boolean): boolean {
  const normalized = relative.replace(/\\/g, '/');
  if (normalized.includes('/.paper-remapped/') || normalized.endsWith('/.paper-remapped')) return true;
  if (normalized.endsWith('session.lock')) return true;
  if (normalized.endsWith('.partial') || normalized.endsWith('.tmp')) return true;
  if (excludeLogs && (normalized === 'logs' || normalized.startsWith('logs/'))) return true;
  return false;
}

export async function createBackup(
  db: AppDb,
  proc: ProcessManager,
  profile: Profile,
  backupDir: string,
  kind: 'full' | 'worlds' | 'plugins' | 'config',
  label: string | null,
  excludeLogs: boolean,
  holdLock = false,
): Promise<BackupInfo> {
  if (!holdLock) tryLock(profile.id, 'backup');
  const id = newId();
  const createdAt = Date.now();
  const info: BackupInfo = {
    id, profileId: profile.id, kind, label, size: null, status: 'running', consistent: false, createdAt, error: null, contents: [],
  };
  db.insertBackup(info);
  const target = path.join(backupDir, profile.id, `${stamp(createdAt)}-${kind}-${id}.zip`);
  try {
    assertOutsideServer(backupDir, profile.directory);
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    const usage = diskUsage(backupDir);
    if (usage && usage.free < 512 * 1024 * 1024) throw new HttpError(507, 'Less than 512 MB is free at the backup location', 'DISK_SPACE');
    let consistent = false;
    const snap = proc.snapshot(profile.id);
    if (snap.status === 'online' && snap.managed === 'attached') {
      consistent = await proc.requestSave(profile);
    }
    const items = await collectItems(profile, kind, excludeLogs);
    if (!items.length) throw new HttpError(400, 'Nothing matching that backup selection was found', 'EMPTY_BACKUP');
    await createZip(target, items, (relative) => shouldSkipBackup(relative, excludeLogs));
    const size = (await fs.promises.stat(target)).size;
    const contents = await listZipRoots(target);
    db.setBackupFile(id, target, size, contents, consistent);
    db.addEvent(profile.id, 'backup', `${kind} backup ${consistent ? 'after save-all' : 'without a confirmed save'}`);
    return { ...info, size, status: 'complete', consistent, contents };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Backup failed';
    db.failBackup(id, message);
    await fs.promises.rm(target, { force: true }).catch(() => undefined);
    await fs.promises.rm(`${target}.partial`, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    if (!holdLock) unlock(profile.id);
  }
}

export async function restoreBackup(db: AppDb, proc: ProcessManager, profile: Profile, backup: BackupInfo, filePath: string, components: string[], backupDir: string, excludeLogs: boolean): Promise<void> {
  const snap = proc.snapshot(profile.id);
  if (snap.status !== 'offline' && snap.status !== 'crashed') {
    throw new HttpError(409, 'Stop the server before restoring a backup', 'SERVER_RUNNING');
  }
  tryLock(profile.id, 'restore');
  try {
    const safety = await createBackup(db, proc, profile, backupDir, 'full', 'Automatic backup before restore', excludeLogs, true);
    if (safety.status !== 'complete') throw new HttpError(500, 'The safety backup did not complete, so nothing was restored', 'SAFETY_BACKUP');
    await extractZip(filePath, profile.directory, components.length ? components : undefined);
    db.addEvent(profile.id, 'restore', `Restored backup ${backup.id}`);
  } finally {
    unlock(profile.id);
  }
}

export function pruneBackups(db: AppDb, profileId: string, retention: number): void {
  const completed = db.listBackups(profileId).filter((backup) => backup.status === 'complete');
  for (const extra of completed.slice(Math.max(1, retention))) {
    const file = db.getBackupPath(extra.id);
    if (file) fs.rmSync(file, { force: true });
    db.deleteBackupRow(extra.id);
  }
}

export async function registerLooseArchives(db: AppDb, profile: Profile, backupDir: string): Promise<number> {
  const dir = path.join(backupDir, profile.id);
  if (!fs.existsSync(dir)) return 0;
  const known = new Set(db.listBackups(profile.id).map((backup) => db.getBackupPath(backup.id)));
  let added = 0;
  for (const name of await fs.promises.readdir(dir)) {
    if (!name.toLowerCase().endsWith('.zip')) continue;
    const full = path.join(dir, name);
    if (known.has(full)) continue;
    const stat = await fs.promises.stat(full);
    const id = newId();
    db.insertBackup({
      id, profileId: profile.id, kind: 'imported', label: name, size: stat.size, status: 'running', consistent: false, createdAt: stat.mtimeMs, error: null, contents: [],
    });
    const contents = await listZipRoots(full).catch(() => []);
    db.setBackupFile(id, full, stat.size, contents, false);
    added += 1;
  }
  return added;
}

async function collectItems(profile: Profile, kind: BackupInfo['kind'], excludeLogs: boolean): Promise<{ abs: string; name: string }[]> {
  const root = profile.directory;
  const entries = await fs.promises.readdir(root, { withFileTypes: true });
  const items: { abs: string; name: string }[] = [];
  const configNames = new Set(['server.properties', 'eula.txt', 'bukkit.yml', 'spigot.yml', 'commands.yml', 'purpur.yml', 'help.yml', 'permissions.yml', 'whitelist.json', 'ops.json', 'banned-players.json', 'banned-ips.json', 'config']);
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const name = entry.name;
    const abs = path.join(root, name);
    const isWorld = entry.isDirectory() && fs.existsSync(path.join(abs, 'level.dat'));
    const isPlugins = entry.isDirectory() && (name === 'plugins' || name === 'mods');
    const isConfig = configNames.has(name) || name.endsWith('.yml') || name.endsWith('.yaml') || name.endsWith('.toml') || name.endsWith('.properties');
    if (kind === 'worlds' && !isWorld) continue;
    if (kind === 'plugins' && !isPlugins) continue;
    if (kind === 'config' && !isConfig) continue;
    if (kind === 'full' && ['libraries', 'versions', 'cache'].includes(name)) continue;
    if (kind === 'full' && excludeLogs && name === 'logs') continue;
    if (shouldSkipBackup(name, excludeLogs)) continue;
    items.push({ abs, name });
  }
  return items;
}

function assertOutsideServer(backupDir: string, serverDir: string): void {
  const relative = path.relative(path.resolve(serverDir), path.resolve(backupDir));
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    throw new HttpError(400, 'The backup folder must be outside the live server directory', 'BAD_BACKUP_DIR');
  }
}

function stamp(time: number): string {
  return new Date(time).toISOString().replace(/[:.]/g, '-');
}
