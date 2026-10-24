import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AccessSnapshot, BanRow, PlayerRow, Profile } from '../../../shared/types.ts';
import type { AppDb } from '../db.ts';
import { HttpError } from '../util/errors.ts';
import { assertPlayerName, durationToMs, sanitizeMessage, sanitizeReason } from '../util/command.ts';
import { atomicWrite, backupCopy } from './files.ts';
import type { ProcessManager } from './processManager.ts';

interface NamedId { name: string; uuid: string }
interface OpEntry extends NamedId { level: number; bypassesPlayerLimit?: boolean }
interface BanEntry extends NamedId { created?: string; source?: string; expires?: string; reason?: string }

export async function listPlayers(db: AppDb, proc: ProcessManager, profile: Profile): Promise<PlayerRow[]> {
  const access = await readAccess(profile, db);
  const known = new Map(db.listKnownPlayers(profile.id).map((player) => [player.name.toLowerCase(), player]));
  const snap = proc.snapshot(profile.id);
  const names = new Set<string>([
    ...access.whitelist.map((player) => player.name),
    ...access.ops.map((player) => player.name),
    ...access.bans.map((player) => player.name),
    ...known.keys(),
    ...snap.playerNames,
  ]);
  for (const cached of readJson<NamedId[]>(path.join(profile.directory, 'usercache.json'), [])) names.add(cached.name);
  const online = new Set(snap.playerNames.map((name) => name.toLowerCase()));
  const rows: PlayerRow[] = [];
  for (const name of names) {
    if (!name) continue;
    const key = name.toLowerCase();
    const record = known.get(key);
    const session = snap.playerSessions.get(name) ?? [...snap.playerSessions.entries()].find(([entry]) => entry.toLowerCase() === key)?.[1];
    const op = access.ops.find((entry) => entry.name.toLowerCase() === key);
    const ban = access.bans.find((entry) => entry.name.toLowerCase() === key);
    rows.push({
      name: op?.name || ban?.name || record?.name || name,
      uuid: session?.uuid || record?.uuid || op?.uuid || ban?.uuid || null,
      online: snap.status === 'online' ? (snap.playersKnown ? online.has(key) : null) : false,
      sessionStartedAt: session?.since ?? null,
      firstSeen: record?.firstSeen ?? null,
      lastSeen: record?.lastSeen ?? null,
      op: Boolean(op),
      opLevel: op?.level ?? null,
      whitelisted: access.whitelist.some((entry) => entry.name.toLowerCase() === key),
      banned: Boolean(ban),
    });
  }
  return rows.sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
}

export async function readAccess(profile: Profile, db: AppDb): Promise<AccessSnapshot> {
  const whitelist = readJson<NamedId[]>(path.join(profile.directory, 'whitelist.json'), []);
  const ops = readJson<OpEntry[]>(path.join(profile.directory, 'ops.json'), []);
  const bans = readJson<BanEntry[]>(path.join(profile.directory, 'banned-players.json'), []);
  const temp = db.listTempBans(profile.id);
  const onlineMode = readFlag(profile, 'online-mode');
  const whitelistEnabled = readFlag(profile, 'white-list');
  return {
    whitelistEnabled,
    onlineMode,
    whitelist: whitelist.map((entry) => ({ name: entry.name, uuid: entry.uuid })),
    ops: ops.map((entry) => ({ name: entry.name, uuid: entry.uuid, level: entry.level ?? 4 })),
    bans: bans.map((entry) => {
      const extra = temp.find((ban) => ban.name.toLowerCase() === entry.name.toLowerCase());
      return {
        name: entry.name,
        uuid: entry.uuid,
        reason: entry.reason ?? extra?.reason ?? null,
        source: entry.source ?? null,
        created: entry.created ?? null,
        expires: extra ? new Date(extra.expiresAt).toISOString() : entry.expires ?? null,
        temporary: Boolean(extra),
        expiresAt: extra?.expiresAt ?? null,
      } satisfies BanRow;
    }),
    permissionPlugins: detectPermissionPlugins(profile),
  };
}

export async function kick(proc: ProcessManager, profile: Profile, name: string, reason: string): Promise<void> {
  proc.sendCommand(profile, `kick ${assertPlayerName(name)} ${sanitizeReason(reason)}`);
}

export async function ban(db: AppDb, proc: ProcessManager, profile: Profile, name: string, reason: string, historyDir: string): Promise<void> {
  const player = assertPlayerName(name);
  const clean = sanitizeReason(reason);
  if (canCommand(proc, profile)) proc.sendCommand(profile, `ban ${player} ${clean}`);
  else {
    assertStopped(proc, profile);
    await upsertBanFile(profile, player, clean, historyDir);
  }
  db.addEvent(profile.id, 'ban', `${player}: ${clean}`);
}

export async function tempBan(db: AppDb, proc: ProcessManager, profile: Profile, name: string, reason: string, value: number, unit: string, historyDir: string): Promise<number> {
  const expiresAt = Date.now() + durationToMs(value, unit);
  await ban(db, proc, profile, name, reason, historyDir);
  const player = assertPlayerName(name);
  db.upsertTempBan(profile.id, { name: player, uuid: null, reason: sanitizeReason(reason), expiresAt, createdAt: Date.now() });
  return expiresAt;
}

export async function pardon(db: AppDb, proc: ProcessManager, profile: Profile, name: string, historyDir: string): Promise<void> {
  const player = assertPlayerName(name);
  if (canCommand(proc, profile)) proc.sendCommand(profile, `pardon ${player}`);
  else {
    assertStopped(proc, profile);
    await removeBanFile(profile, player, historyDir);
  }
  db.deleteTempBan(profile.id, player);
  db.addEvent(profile.id, 'pardon', player);
}

export async function teleport(proc: ProcessManager, profile: Profile, name: string, target: string): Promise<void> {
  proc.sendCommand(profile, `tp ${assertPlayerName(name)} ${assertPlayerName(target)}`);
}

export async function message(proc: ProcessManager, profile: Profile, name: string, text: string): Promise<void> {
  proc.sendCommand(profile, `msg ${assertPlayerName(name)} ${sanitizeMessage(text)}`);
}

export async function whitelistAdd(proc: ProcessManager, profile: Profile, name: string, historyDir: string): Promise<void> {
  const player = assertPlayerName(name);
  if (canCommand(proc, profile)) {
    proc.sendCommand(profile, `whitelist add ${player}`);
    return;
  }
  assertStopped(proc, profile);
  const uuid = await resolveUuid(profile, player);
  const file = path.join(profile.directory, 'whitelist.json');
  const entries = readJson<NamedId[]>(file, []);
  if (!entries.some((entry) => entry.name.toLowerCase() === player.toLowerCase())) {
    if (fs.existsSync(file)) await backupCopy(file, historyDir, 'whitelist.json');
    entries.push({ name: player, uuid });
    await atomicWrite(file, JSON.stringify(entries, null, 2));
  }
}

export async function whitelistRemove(proc: ProcessManager, profile: Profile, name: string, historyDir: string): Promise<void> {
  const player = assertPlayerName(name);
  if (canCommand(proc, profile)) {
    proc.sendCommand(profile, `whitelist remove ${player}`);
    return;
  }
  assertStopped(proc, profile);
  const file = path.join(profile.directory, 'whitelist.json');
  if (fs.existsSync(file)) await backupCopy(file, historyDir, 'whitelist.json');
  const entries = readJson<NamedId[]>(file, []).filter((entry) => entry.name.toLowerCase() !== player.toLowerCase());
  await atomicWrite(file, JSON.stringify(entries, null, 2));
}

export async function op(proc: ProcessManager, profile: Profile, name: string, historyDir: string): Promise<void> {
  const player = assertPlayerName(name);
  if (canCommand(proc, profile)) {
    proc.sendCommand(profile, `op ${player}`);
    return;
  }
  assertStopped(proc, profile);
  const uuid = await resolveUuid(profile, player);
  const file = path.join(profile.directory, 'ops.json');
  const entries = readJson<OpEntry[]>(file, []);
  if (!entries.some((entry) => entry.name.toLowerCase() === player.toLowerCase())) {
    if (fs.existsSync(file)) await backupCopy(file, historyDir, 'ops.json');
    entries.push({ uuid, name: player, level: 4, bypassesPlayerLimit: false });
    await atomicWrite(file, JSON.stringify(entries, null, 2));
  }
}

export async function deop(proc: ProcessManager, profile: Profile, name: string, historyDir: string): Promise<void> {
  const player = assertPlayerName(name);
  if (canCommand(proc, profile)) {
    proc.sendCommand(profile, `deop ${player}`);
    return;
  }
  assertStopped(proc, profile);
  const file = path.join(profile.directory, 'ops.json');
  if (fs.existsSync(file)) await backupCopy(file, historyDir, 'ops.json');
  const entries = readJson<OpEntry[]>(file, []).filter((entry) => entry.name.toLowerCase() !== player.toLowerCase());
  await atomicWrite(file, JSON.stringify(entries, null, 2));
}

export async function expireTempBans(db: AppDb, proc: ProcessManager, historyFor: (profile: Profile) => string): Promise<void> {
  for (const due of db.dueTempBans()) {
    const profile = db.getProfile(due.profileId);
    if (!profile) {
      db.deleteTempBan(due.profileId, due.name);
      continue;
    }
    try {
      await pardon(db, proc, profile, due.name, historyFor(profile));
    } catch (error) {
      db.addEvent(profile.id, 'task', `Temporary ban for ${due.name} could not be lifted yet: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }
}

async function upsertBanFile(profile: Profile, name: string, reason: string, historyDir: string): Promise<void> {
  const file = path.join(profile.directory, 'banned-players.json');
  const entries = readJson<BanEntry[]>(file, []);
  if (fs.existsSync(file)) await backupCopy(file, historyDir, 'banned-players.json');
  const uuid = await resolveUuid(profile, name);
  const next = entries.filter((entry) => entry.name.toLowerCase() !== name.toLowerCase());
  next.push({ uuid, name, created: new Date().toISOString(), source: 'Mineview', expires: 'forever', reason });
  await atomicWrite(file, JSON.stringify(next, null, 2));
}

async function removeBanFile(profile: Profile, name: string, historyDir: string): Promise<void> {
  const file = path.join(profile.directory, 'banned-players.json');
  if (!fs.existsSync(file)) return;
  await backupCopy(file, historyDir, 'banned-players.json');
  const entries = readJson<BanEntry[]>(file, []).filter((entry) => entry.name.toLowerCase() !== name.toLowerCase());
  await atomicWrite(file, JSON.stringify(entries, null, 2));
}

async function resolveUuid(profile: Profile, name: string): Promise<string> {
  const cache = readJson<{ name: string; uuid: string }[]>(path.join(profile.directory, 'usercache.json'), []);
  const cached = cache.find((entry) => entry.name.toLowerCase() === name.toLowerCase());
  if (cached?.uuid) return cached.uuid;
  const online = readFlag(profile, 'online-mode');
  if (online !== false) {
    try {
      const response = await fetch(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(name)}`, {
        headers: { 'User-Agent': 'mineview/1.0 (local Minecraft server panel)' },
        signal: AbortSignal.timeout(8000),
      });
      if (response.status === 200) {
        const body = await response.json() as { id?: string };
        if (body.id && /^[0-9a-fA-F]{32}$/.test(body.id)) return formatUuid(body.id);
      }
    } catch {
      if (online === true) throw new HttpError(502, 'The player UUID could not be resolved from Mojang. Start the server and use the live command, or try again.', 'UUID_LOOKUP');
    }
  }
  return offlineUuid(name);
}

function offlineUuid(name: string): string {
  const md5 = createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest();
  md5[6] = (md5[6]! & 0x0f) | 0x30;
  md5[8] = (md5[8]! & 0x3f) | 0x80;
  const hex = md5.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function formatUuid(raw: string): string {
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
}

function canCommand(proc: ProcessManager, profile: Profile): boolean {
  const snap = proc.snapshot(profile.id);
  return snap.managed === 'attached' && (snap.status === 'online' || snap.status === 'starting');
}

function assertStopped(proc: ProcessManager, profile: Profile): void {
  const snap = proc.snapshot(profile.id);
  if (snap.status !== 'offline' && snap.status !== 'crashed') {
    throw new HttpError(409, 'Stop the server before changing this from files. Live changes need a console Mineview is attached to.', 'SERVER_RUNNING');
  }
}

function readFlag(profile: Profile, key: string): boolean | null {
  const file = path.join(profile.directory, 'server.properties');
  if (!fs.existsSync(file)) return null;
  const match = new RegExp(`^${key}\\s*=\\s*(true|false)\\s*$`, 'im').exec(fs.readFileSync(file, 'utf8'));
  return match ? match[1] === 'true' : null;
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function detectPermissionPlugins(profile: Profile): string[] {
  const dir = path.join(profile.directory, profile.pluginContainer === 'none' ? 'plugins' : profile.pluginContainer);
  if (!fs.existsSync(dir)) return [];
  const names = fs.readdirSync(dir).map((name) => name.toLowerCase());
  const found: string[] = [];
  if (names.some((name) => name.includes('luckperms'))) found.push('LuckPerms');
  if (names.some((name) => name.includes('permissionsex'))) found.push('PermissionsEx');
  if (names.some((name) => name.includes('groupmanager'))) found.push('GroupManager');
  return found;
}
