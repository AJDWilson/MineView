import fs from 'node:fs';
import path from 'node:path';
import type { Profile, WorldInfo } from '../../../shared/types.ts';
import type { AppDb } from '../db.ts';
import { HttpError } from '../util/errors.ts';
import { resolveWithinRoot } from '../util/paths.ts';
import { createZip } from '../util/zip.ts';
import { directorySize } from './files.ts';
import { readServerProperty } from './configFiles.ts';
import type { ProcessManager } from './processManager.ts';

export async function listWorlds(profile: Profile): Promise<WorldInfo[]> {
  const levelName = readServerProperty(profile, 'level-name');
  const entries = await fs.promises.readdir(profile.directory, { withFileTypes: true });
  const worlds: WorldInfo[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const level = path.join(profile.directory, entry.name, 'level.dat');
    if (!fs.existsSync(level)) continue;
    const stat = await fs.promises.stat(path.join(profile.directory, entry.name));
    const size = await directorySize(path.join(profile.directory, entry.name));
    worlds.push({
      name: entry.name,
      relativePath: entry.name,
      size,
      modifiedAt: stat.mtimeMs,
      configured: entry.name === levelName,
      hasLevelDat: true,
    });
  }
  return worlds.sort((a, b) => Number(b.configured) - Number(a.configured) || a.name.localeCompare(b.name));
}

export async function exportWorld(profile: Profile, name: string, destinationZip: string): Promise<void> {
  const world = resolveWorld(profile, name);
  await createZip(destinationZip, [{ abs: world, name }]);
}

export async function deleteWorld(db: AppDb, proc: ProcessManager, profile: Profile, name: string, confirmName: string, backupDir: string): Promise<void> {
  assertStopped(proc, profile);
  if (confirmName !== name) throw new HttpError(400, 'Type the world folder name to confirm deletion', 'CONFIRM');
  const world = resolveWorld(profile, name);
  const zip = path.join(backupDir, profile.id, `deleted-${name}-${Date.now()}.zip`);
  await createZip(zip, [{ abs: world, name }]);
  await fs.promises.rm(world, { recursive: true, force: false });
  db.addEvent(profile.id, 'world-delete', `${name} was archived to the backup folder and removed`);
}

export function resolveWorld(profile: Profile, name: string): string {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) throw new HttpError(400, 'Invalid world name', 'BAD_NAME');
  const abs = resolveWithinRoot(profile.directory, name);
  if (!fs.existsSync(path.join(abs, 'level.dat'))) throw new HttpError(404, 'World folder was not found', 'NO_WORLD');
  return abs;
}

function assertStopped(proc: ProcessManager, profile: Profile): void {
  const snap = proc.snapshot(profile.id);
  if (snap.status !== 'offline' && snap.status !== 'crashed') {
    throw new HttpError(409, 'Stop the server before changing world files', 'SERVER_RUNNING');
  }
}
