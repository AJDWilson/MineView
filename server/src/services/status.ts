import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Profile, StatusSnapshot } from '../../../shared/types.ts';
import type { AppDb } from '../db.ts';
import { diskUsage, directorySize } from './files.ts';
import { readServerProperty } from './configFiles.ts';
import { currentOperation } from './locks.ts';
import type { ProcessManager } from './processManager.ts';

const worldSizes = new Map<string, { at: number; size: number | null; state: 'loading' | 'ready' | 'unavailable' }>();

export async function buildStatus(db: AppDb, proc: ProcessManager, profile: Profile | null): Promise<StatusSnapshot> {
  const memory = { total: os.totalmem(), free: os.freemem() };
  if (!profile) {
    return empty(memory);
  }
  await proc.refreshExternal(profile);
  const snap = proc.snapshot(profile.id);
  const port = numberOrNull(readServerProperty(profile, 'server-port'));
  const maxPlayers = numberOrNull(readServerProperty(profile, 'max-players'));
  const address = readServerProperty(profile, 'server-ip');
  const world = readServerProperty(profile, 'level-name');
  const eula = readEula(profile);
  const disk = diskUsage(profile.directory);
  const backups = db.listBackups(profile.id).filter((backup) => backup.status === 'complete');
  const last = backups[0] ?? null;
  const pluginNote = pluginNoteFor(profile);
  const pluginCount = countPlugins(profile);
  const worldStat = await worldSize(profile, world);
  const warnings: string[] = [];
  if (snap.lastError && snap.status !== 'online') warnings.push(snap.lastError);
  if (eula === 'false') warnings.push('eula.txt is not accepted. The server will not finish starting until you set eula=true.');
  if (snap.managed === 'external') warnings.push('This server was started outside Mineview. Start and stop controls stay disabled.');
  if (snap.managed === 'detached') warnings.push('The console pipe was lost when Mineview restarted. Logs are tailed from disk.');
  const settings = db.getSettings();
  let health: StatusSnapshot['health'] = snap.status === 'online' ? 'ok' : snap.status === 'crashed' ? 'critical' : 'offline';
  if (snap.status === 'online' && snap.cpuPercent != null && snap.cpuPercent >= settings.cpuWarnPercent) {
    health = 'warning';
    warnings.push(`CPU is above ${settings.cpuWarnPercent}%.`);
  }
  if (disk && disk.total > 0 && ((disk.total - disk.free) / disk.total) * 100 >= settings.diskWarnPercent) {
    health = health === 'critical' ? health : 'warning';
    warnings.push(`Disk use is above ${settings.diskWarnPercent}%.`);
  }
  const running = snap.status === 'online' || snap.status === 'starting' || snap.status === 'stopping' || snap.status === 'restarting';
  return {
    profileId: profile.id,
    status: snap.status,
    managed: snap.managed,
    pid: snap.pid,
    startedAt: snap.startedAt,
    uptimeMs: snap.startedAt && running ? Date.now() - snap.startedAt : null,
    exitCode: snap.exitCode,
    lastError: snap.lastError,
    software: profile.software,
    mcVersion: profile.mcVersion,
    playersOnline: snap.status === 'offline' || snap.status === 'crashed' ? 0 : snap.playersKnown ? snap.playerNames.length : null,
    maxPlayers,
    playerNames: snap.playerNames,
    port,
    address: address === null ? null : address || '0.0.0.0',
    motd: readServerProperty(profile, 'motd'),
    world,
    worldSize: worldStat.size,
    worldSizeState: worldStat.state,
    pluginCount,
    pluginNote,
    diskFree: disk?.free ?? null,
    diskTotal: disk?.total ?? null,
    lastBackup: last ? { id: last.id, at: last.createdAt, status: last.status, size: last.size, kind: last.kind } : null,
    cpuPercent: snap.cpuPercent,
    memoryBytes: snap.memoryBytes,
    systemMemory: memory,
    javaVersion: null,
    health,
    warnings,
    operation: currentOperation(profile.id),
    recentLogs: proc.lines(profile.id).slice(-20),
    recentPlayers: db.recentPlayerEvents(profile.id, 8),
    eulaAccepted: eula === null ? null : eula === 'true',
    canStart: snap.status === 'offline' || snap.status === 'crashed',
    canStop: snap.managed === 'attached' && (snap.status === 'online' || snap.status === 'starting'),
    canRestart: snap.managed === 'attached' && snap.status === 'online',
    canKill: (snap.managed === 'attached' || snap.managed === 'detached') && snap.status !== 'offline' && snap.status !== 'crashed',
    canCommand: snap.managed === 'attached' && (snap.status === 'online' || snap.status === 'starting'),
    commandBlockReason: snap.managed === 'attached' ? null : snap.lastError,
  };
}

function empty(memory: { total: number; free: number }): StatusSnapshot {
  return {
    profileId: null,
    status: 'offline',
    managed: 'none',
    pid: null,
    startedAt: null,
    uptimeMs: null,
    exitCode: null,
    lastError: null,
    software: null,
    mcVersion: null,
    playersOnline: null,
    maxPlayers: null,
    playerNames: [],
    port: null,
    address: null,
    motd: null,
    world: null,
    worldSize: null,
    worldSizeState: 'unavailable',
    pluginCount: null,
    pluginNote: null,
    diskFree: null,
    diskTotal: null,
    lastBackup: null,
    cpuPercent: null,
    memoryBytes: null,
    systemMemory: memory,
    javaVersion: null,
    health: 'offline',
    warnings: [],
    operation: null,
    recentLogs: [],
    recentPlayers: [],
    eulaAccepted: null,
    canStart: false,
    canStop: false,
    canRestart: false,
    canKill: false,
    canCommand: false,
    commandBlockReason: 'No server profile is selected',
  };
}

async function worldSize(profile: Profile, world: string | null): Promise<{ size: number | null; state: 'loading' | 'ready' | 'unavailable' }> {
  if (!world) return { size: null, state: 'unavailable' };
  const key = `${profile.id}:${world}`;
  const cached = worldSizes.get(key);
  if (cached && Date.now() - cached.at < 60_000 && cached.state === 'ready') return cached;
  const folder = path.join(profile.directory, world);
  if (!fs.existsSync(folder)) return { size: null, state: 'unavailable' };
  const size = await directorySize(folder);
  const value = { at: Date.now(), size, state: size == null ? 'unavailable' as const : 'ready' as const };
  worldSizes.set(key, value);
  return value;
}

function countPlugins(profile: Profile): number | null {
  if (profile.pluginContainer === 'none') return null;
  try {
    const dir = path.join(profile.directory, profile.pluginContainer);
    if (!fs.existsSync(dir)) return null;
    return fs.readdirSync(dir).filter((name) => name.endsWith('.jar') || name.endsWith('.jar.disabled')).length;
  } catch {
    return null;
  }
}

function readEula(profile: Profile): string | null {
  const file = path.join(profile.directory, 'eula.txt');
  if (!fs.existsSync(file)) return null;
  const match = /^\s*eula\s*=\s*(true|false)\s*$/im.exec(fs.readFileSync(file, 'utf8'));
  return match?.[1] ?? null;
}

function pluginNoteFor(profile: Profile): string | null {
  if (profile.software === 'vanilla') return 'Vanilla has no plugin loader.';
  if (profile.pluginContainer === 'none') return 'No plugin directory is configured for this server.';
  return null;
}

function numberOrNull(value: string | null): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  return Number(value);
}
