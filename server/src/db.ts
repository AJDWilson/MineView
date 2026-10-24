import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { BackupInfo, MetricPoint, PlayerEvent, Profile, ScheduleSpec, ServerSoftware, TaskInfo } from '../../shared/types.ts';
import { generatePassword, hashPassword } from './util/password.ts';

export interface AppSettings {
  theme: 'dark' | 'light';
  accent: 'grass' | 'emerald' | 'copper' | 'amethyst';
  consoleBuffer: number;
  backupDir: string | null;
  backupRetention: number;
  excludeLogs: boolean;
  discordWebhook: string;
  allowRemote: boolean;
  logRetentionDays: number;
  cpuWarnPercent: number;
  ramWarnPercent: number;
  diskWarnPercent: number;
  modrinthEnabled: boolean;
  hangarEnabled: boolean;
  spigetEnabled: boolean;
  activeProfileId: string | null;
}

export interface SessionRecord {
  csrf: string;
  createdAt: number;
  expiresAt: number;
}

const DEFAULT_SETTINGS: AppSettings = {
  theme: 'dark',
  accent: 'grass',
  consoleBuffer: 2000,
  backupDir: null,
  backupRetention: 10,
  excludeLogs: true,
  discordWebhook: '',
  allowRemote: false,
  logRetentionDays: 7,
  cpuWarnPercent: 90,
  ramWarnPercent: 90,
  diskWarnPercent: 90,
  modrinthEnabled: true,
  hangarEnabled: true,
  spigetEnabled: true,
  activeProfileId: null,
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  csrf TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  directory TEXT NOT NULL UNIQUE,
  jar_file TEXT,
  java_path TEXT,
  min_memory TEXT NOT NULL,
  max_memory TEXT NOT NULL,
  jvm_args TEXT NOT NULL,
  server_args TEXT NOT NULL,
  software TEXT NOT NULL,
  mc_version TEXT,
  launch_mode TEXT NOT NULL,
  arg_file TEXT,
  plugin_container TEXT NOT NULL,
  auto_restart INTEGER NOT NULL,
  auto_restart_max INTEGER NOT NULL,
  auto_restart_cooldown INTEGER NOT NULL,
  restart_delay INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id TEXT,
  at INTEGER NOT NULL,
  type TEXT NOT NULL,
  message TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS players (
  profile_id TEXT NOT NULL,
  name TEXT NOT NULL,
  uuid TEXT,
  first_seen INTEGER,
  last_seen INTEGER,
  PRIMARY KEY (profile_id, name)
);
CREATE TABLE IF NOT EXISTS player_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id TEXT NOT NULL,
  name TEXT NOT NULL,
  uuid TEXT,
  event TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  cpu REAL,
  memory_bytes INTEGER,
  players INTEGER
);
CREATE INDEX IF NOT EXISTS idx_metrics_profile_at ON metrics(profile_id, at);
CREATE TABLE IF NOT EXISTS backups (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  label TEXT,
  path TEXT NOT NULL,
  size INTEGER,
  status TEXT NOT NULL,
  consistent INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  error TEXT,
  contents TEXT
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  schedule TEXT NOT NULL,
  payload TEXT NOT NULL,
  last_run INTEGER,
  last_status TEXT,
  last_message TEXT,
  next_run INTEGER
);
CREATE TABLE IF NOT EXISTS temp_bans (
  profile_id TEXT NOT NULL,
  name TEXT NOT NULL,
  uuid TEXT,
  reason TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (profile_id, name)
);
CREATE TABLE IF NOT EXISTS plugin_origins (
  profile_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  source TEXT,
  project_id TEXT,
  version_id TEXT,
  version TEXT,
  sha1 TEXT,
  size INTEGER,
  mtime INTEGER,
  PRIMARY KEY (profile_id, filename)
);
`;

interface ProfileRow {
  id: string;
  name: string;
  directory: string;
  jar_file: string | null;
  java_path: string | null;
  min_memory: string;
  max_memory: string;
  jvm_args: string;
  server_args: string;
  software: ServerSoftware;
  mc_version: string | null;
  launch_mode: 'jar' | 'argfile';
  arg_file: string | null;
  plugin_container: 'plugins' | 'mods' | 'none';
  auto_restart: number;
  auto_restart_max: number;
  auto_restart_cooldown: number;
  restart_delay: number;
  created_at: number;
  updated_at: number;
}

export interface PluginOrigin {
  filename: string;
  source: string | null;
  projectId: string | null;
  versionId: string | null;
  version: string | null;
  sha1: string | null;
  size: number | null;
  mtime: number | null;
}

export interface TempBan {
  name: string;
  uuid: string | null;
  reason: string | null;
  expiresAt: number;
  createdAt: number;
}

function mapProfile(row: ProfileRow): Profile {
  return {
    id: row.id,
    name: row.name,
    directory: row.directory,
    jarFile: row.jar_file,
    javaPath: row.java_path,
    minMemory: row.min_memory,
    maxMemory: row.max_memory,
    jvmArgs: row.jvm_args,
    serverArgs: row.server_args,
    software: row.software,
    mcVersion: row.mc_version,
    launchMode: row.launch_mode,
    argFile: row.arg_file,
    pluginContainer: row.plugin_container,
    autoRestart: Boolean(row.auto_restart),
    autoRestartMax: row.auto_restart_max,
    autoRestartCooldown: row.auto_restart_cooldown,
    restartDelay: row.restart_delay,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class AppDb {
  private readonly db: DatabaseSync;

  constructor(public readonly dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, 'mineview.sqlite'));
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  private setting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  private putSetting(key: string, value: string): void {
    this.db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  getSettings(): AppSettings {
    const raw = this.setting('settings');
    if (!raw) return { ...DEFAULT_SETTINGS };
    try {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) as Partial<AppSettings> };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  saveSettings(settings: AppSettings): void {
    this.putSetting('settings', JSON.stringify(settings));
  }

  ensurePassword(initialPassword?: string): { created: boolean; password: string | null } {
    const existing = this.setting('password_hash');
    if (existing) return { created: false, password: null };
    if (initialPassword && initialPassword.length < 10) {
      throw new Error('MINEVIEW_INITIAL_PASSWORD must be at least 10 characters');
    }
    const provided = initialPassword && initialPassword.length >= 10 ? initialPassword : null;
    const actual = provided ?? generatePassword();
    this.putSetting('password_hash', hashPassword(actual));
    return { created: true, password: provided ? null : actual };
  }

  getPasswordHash(): string | null {
    return this.setting('password_hash');
  }

  setPasswordHash(hash: string): void {
    this.putSetting('password_hash', hash);
  }

  createSession(): { token: string; csrf: string } {
    const token = randomBytes(32).toString('base64url');
    const csrf = randomBytes(32).toString('base64url');
    const now = Date.now();
    this.db.prepare('INSERT INTO sessions(token_hash, csrf, created_at, expires_at) VALUES(?, ?, ?, ?)').run(
      hashToken(token),
      csrf,
      now,
      now + 14 * 24 * 60 * 60 * 1000,
    );
    return { token, csrf };
  }

  getSession(token: string | undefined): SessionRecord | null {
    if (!token) return null;
    const row = this.db.prepare('SELECT csrf, created_at, expires_at FROM sessions WHERE token_hash = ?').get(hashToken(token)) as
      | { csrf: string; created_at: number; expires_at: number }
      | undefined;
    if (!row) return null;
    if (row.expires_at < Date.now()) {
      this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
      return null;
    }
    return { csrf: row.csrf, createdAt: row.created_at, expiresAt: row.expires_at };
  }

  deleteSession(token: string | undefined): void {
    if (!token) return;
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
  }

  touchSession(token: string, expiresAt: number): void {
    this.db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').run(expiresAt, hashToken(token));
  }

  listProfiles(): Profile[] {
    const rows = this.db.prepare('SELECT * FROM profiles ORDER BY name COLLATE NOCASE').all() as unknown as ProfileRow[];
    return rows.map(mapProfile);
  }

  getProfile(id: string): Profile | null {
    const row = this.db.prepare('SELECT * FROM profiles WHERE id = ?').get(id) as ProfileRow | undefined;
    return row ? mapProfile(row) : null;
  }

  insertProfile(profile: Profile): void {
    this.db.prepare(`INSERT INTO profiles(
      id, name, directory, jar_file, java_path, min_memory, max_memory, jvm_args, server_args,
      software, mc_version, launch_mode, arg_file, plugin_container, auto_restart, auto_restart_max,
      auto_restart_cooldown, restart_delay, created_at, updated_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      profile.id, profile.name, profile.directory, profile.jarFile, profile.javaPath, profile.minMemory,
      profile.maxMemory, profile.jvmArgs, profile.serverArgs, profile.software, profile.mcVersion,
      profile.launchMode, profile.argFile, profile.pluginContainer, profile.autoRestart ? 1 : 0,
      profile.autoRestartMax, profile.autoRestartCooldown, profile.restartDelay, profile.createdAt, profile.updatedAt,
    );
  }

  updateProfile(profile: Profile): void {
    this.db.prepare(`UPDATE profiles SET
      name=?, directory=?, jar_file=?, java_path=?, min_memory=?, max_memory=?, jvm_args=?, server_args=?,
      software=?, mc_version=?, launch_mode=?, arg_file=?, plugin_container=?, auto_restart=?, auto_restart_max=?,
      auto_restart_cooldown=?, restart_delay=?, updated_at=? WHERE id=?`).run(
      profile.name, profile.directory, profile.jarFile, profile.javaPath, profile.minMemory, profile.maxMemory,
      profile.jvmArgs, profile.serverArgs, profile.software, profile.mcVersion, profile.launchMode, profile.argFile,
      profile.pluginContainer, profile.autoRestart ? 1 : 0, profile.autoRestartMax, profile.autoRestartCooldown,
      profile.restartDelay, profile.updatedAt, profile.id,
    );
  }

  deleteProfile(id: string): void {
    this.db.prepare('DELETE FROM profiles WHERE id = ?').run(id);
    for (const table of ['events', 'players', 'player_events', 'metrics', 'backups', 'tasks', 'temp_bans', 'plugin_origins']) {
      this.db.prepare(`DELETE FROM ${table} WHERE profile_id = ?`).run(id);
    }
  }

  addEvent(profileId: string | null, type: string, message: string, at = Date.now()): void {
    this.db.prepare('INSERT INTO events(profile_id, at, type, message) VALUES(?, ?, ?, ?)').run(profileId, at, type, message.slice(0, 1000));
  }

  listEvents(profileId: string, limit = 50): { at: number; type: string; message: string }[] {
    return this.db.prepare('SELECT at, type, message FROM events WHERE profile_id = ? ORDER BY id DESC LIMIT ?').all(profileId, limit) as {
      at: number;
      type: string;
      message: string;
    }[];
  }

  upsertPlayer(profileId: string, name: string, uuid: string | null, seenAt: number): void {
    const existing = this.db.prepare('SELECT first_seen FROM players WHERE profile_id = ? AND name = ?').get(profileId, name) as
      | { first_seen: number | null }
      | undefined;
    if (!existing) {
      this.db.prepare('INSERT INTO players(profile_id, name, uuid, first_seen, last_seen) VALUES(?, ?, ?, ?, ?)').run(profileId, name, uuid, seenAt, seenAt);
      return;
    }
    this.db.prepare('UPDATE players SET uuid = COALESCE(?, uuid), last_seen = ?, first_seen = COALESCE(first_seen, ?) WHERE profile_id = ? AND name = ?').run(
      uuid, seenAt, seenAt, profileId, name,
    );
  }

  listKnownPlayers(profileId: string): { name: string; uuid: string | null; firstSeen: number | null; lastSeen: number | null }[] {
    const rows = this.db.prepare('SELECT name, uuid, first_seen, last_seen FROM players WHERE profile_id = ? ORDER BY name COLLATE NOCASE').all(profileId) as {
      name: string;
      uuid: string | null;
      first_seen: number | null;
      last_seen: number | null;
    }[];
    return rows.map((row) => ({ name: row.name, uuid: row.uuid, firstSeen: row.first_seen, lastSeen: row.last_seen }));
  }

  addPlayerEvent(profileId: string, name: string, uuid: string | null, event: 'join' | 'leave', at = Date.now()): void {
    this.db.prepare('INSERT INTO player_events(profile_id, name, uuid, event, at) VALUES(?, ?, ?, ?, ?)').run(profileId, name, uuid, event, at);
  }

  recentPlayerEvents(profileId: string, limit = 12): PlayerEvent[] {
    const rows = this.db.prepare('SELECT name, uuid, event, at FROM player_events WHERE profile_id = ? ORDER BY id DESC LIMIT ?').all(profileId, limit) as {
      name: string;
      uuid: string | null;
      event: 'join' | 'leave';
      at: number;
    }[];
    return rows;
  }

  addMetric(profileId: string, point: { cpu: number | null; memoryBytes: number | null; players: number | null }, at = Date.now()): void {
    this.db.prepare('INSERT INTO metrics(profile_id, at, cpu, memory_bytes, players) VALUES(?, ?, ?, ?, ?)').run(
      profileId, at, point.cpu, point.memoryBytes, point.players,
    );
  }

  metricsSince(profileId: string, since: number): MetricPoint[] {
    const rows = this.db.prepare('SELECT at, cpu, memory_bytes, players FROM metrics WHERE profile_id = ? AND at >= ? ORDER BY at ASC').all(profileId, since) as {
      at: number;
      cpu: number | null;
      memory_bytes: number | null;
      players: number | null;
    }[];
    return rows.map((row) => ({ at: row.at, cpu: row.cpu, memoryBytes: row.memory_bytes, players: row.players }));
  }

  pruneMetrics(profileId: string, before: number): void {
    this.db.prepare('DELETE FROM metrics WHERE profile_id = ? AND at < ?').run(profileId, before);
  }

  insertBackup(backup: BackupInfo): void {
    this.db.prepare(`INSERT INTO backups(id, profile_id, kind, label, path, size, status, consistent, created_at, error, contents)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      backup.id, backup.profileId, backup.kind, backup.label, '', backup.size, backup.status, backup.consistent ? 1 : 0,
      backup.createdAt, backup.error, JSON.stringify(backup.contents),
    );
  }

  updateBackup(id: string, patch: Partial<Pick<BackupInfo, 'size' | 'status' | 'consistent' | 'error' | 'contents'>> & { path?: string }): void {
    const current = this.getBackup(id);
    if (!current) return;
    this.db.prepare('UPDATE backups SET size=?, status=?, consistent=?, error=?, contents=?, path=? WHERE id=?').run(
      patch.size ?? current.size,
      patch.status ?? current.status,
      (patch.consistent ?? current.consistent) ? 1 : 0,
      patch.error === undefined ? current.error : patch.error,
      JSON.stringify(patch.contents ?? current.contents),
      patch.path ?? this.backupPath(id),
      id,
    );
  }

  private backupPath(id: string): string {
    const row = this.db.prepare('SELECT path FROM backups WHERE id = ?').get(id) as { path: string } | undefined;
    return row?.path ?? '';
  }

  setBackupFile(id: string, filePath: string, size: number, contents: string[], consistent: boolean): void {
    this.db.prepare('UPDATE backups SET path=?, size=?, contents=?, consistent=?, status=? WHERE id=?').run(
      filePath, size, JSON.stringify(contents), consistent ? 1 : 0, 'complete', id,
    );
  }

  failBackup(id: string, error: string): void {
    this.db.prepare("UPDATE backups SET status='failed', error=? WHERE id=?").run(error.slice(0, 500), id);
  }

  listBackups(profileId: string): BackupInfo[] {
    const rows = this.db.prepare('SELECT * FROM backups WHERE profile_id = ? ORDER BY created_at DESC').all(profileId) as unknown as BackupRow[];
    return rows.map(mapBackup);
  }

  getBackup(id: string): BackupInfo | null {
    const row = this.db.prepare('SELECT * FROM backups WHERE id = ?').get(id) as BackupRow | undefined;
    return row ? mapBackup(row) : null;
  }

  getBackupPath(id: string): string | null {
    const row = this.db.prepare('SELECT path FROM backups WHERE id = ?').get(id) as { path: string } | undefined;
    return row?.path || null;
  }

  deleteBackupRow(id: string): void {
    this.db.prepare('DELETE FROM backups WHERE id = ?').run(id);
  }

  listTasks(profileId?: string): TaskInfo[] {
    const rows = (profileId
      ? this.db.prepare('SELECT * FROM tasks WHERE profile_id = ? ORDER BY name').all(profileId)
      : this.db.prepare('SELECT * FROM tasks ORDER BY name').all()) as unknown as TaskRow[];
    return rows.map(mapTask);
  }

  getTask(id: string): TaskInfo | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
    return row ? mapTask(row) : null;
  }

  saveTask(task: TaskInfo): void {
    this.db.prepare(`INSERT INTO tasks(id, profile_id, name, type, enabled, schedule, payload, last_run, last_status, last_message, next_run)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, type=excluded.type, enabled=excluded.enabled, schedule=excluded.schedule, payload=excluded.payload,
        last_run=excluded.last_run, last_status=excluded.last_status, last_message=excluded.last_message, next_run=excluded.next_run`).run(
      task.id, task.profileId, task.name, task.type, task.enabled ? 1 : 0, JSON.stringify(task.schedule),
      JSON.stringify(task.payload), task.lastRun, task.lastStatus, task.lastMessage, task.nextRun,
    );
  }

  deleteTask(id: string): void {
    this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
  }

  listTempBans(profileId: string): TempBan[] {
    const rows = this.db.prepare('SELECT name, uuid, reason, expires_at, created_at FROM temp_bans WHERE profile_id = ?').all(profileId) as {
      name: string;
      uuid: string | null;
      reason: string | null;
      expires_at: number;
      created_at: number;
    }[];
    return rows.map((row) => ({ name: row.name, uuid: row.uuid, reason: row.reason, expiresAt: row.expires_at, createdAt: row.created_at }));
  }

  upsertTempBan(profileId: string, ban: TempBan): void {
    this.db.prepare(`INSERT INTO temp_bans(profile_id, name, uuid, reason, expires_at, created_at) VALUES(?, ?, ?, ?, ?, ?)
      ON CONFLICT(profile_id, name) DO UPDATE SET uuid=excluded.uuid, reason=excluded.reason, expires_at=excluded.expires_at`).run(
      profileId, ban.name, ban.uuid, ban.reason, ban.expiresAt, ban.createdAt,
    );
  }

  deleteTempBan(profileId: string, name: string): void {
    this.db.prepare('DELETE FROM temp_bans WHERE profile_id = ? AND name = ?').run(profileId, name);
  }

  dueTempBans(now = Date.now()): { profileId: string; name: string }[] {
    const rows = this.db.prepare('SELECT profile_id, name FROM temp_bans WHERE expires_at <= ?').all(now) as { profile_id: string; name: string }[];
    return rows.map((row) => ({ profileId: row.profile_id, name: row.name }));
  }

  getOrigin(profileId: string, filename: string): PluginOrigin | null {
    const row = this.db.prepare('SELECT * FROM plugin_origins WHERE profile_id = ? AND filename = ?').get(profileId, filename) as OriginRow | undefined;
    return row ? mapOrigin(row) : null;
  }

  listOrigins(profileId: string): PluginOrigin[] {
    return (this.db.prepare('SELECT * FROM plugin_origins WHERE profile_id = ?').all(profileId) as unknown as OriginRow[]).map(mapOrigin);
  }

  saveOrigin(profileId: string, origin: PluginOrigin): void {
    this.db.prepare(`INSERT INTO plugin_origins(profile_id, filename, source, project_id, version_id, version, sha1, size, mtime)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(profile_id, filename) DO UPDATE SET
        source=excluded.source, project_id=excluded.project_id, version_id=excluded.version_id, version=excluded.version,
        sha1=excluded.sha1, size=excluded.size, mtime=excluded.mtime`).run(
      profileId, origin.filename, origin.source, origin.projectId, origin.versionId, origin.version, origin.sha1, origin.size, origin.mtime,
    );
  }

  deleteOrigin(profileId: string, filename: string): void {
    this.db.prepare('DELETE FROM plugin_origins WHERE profile_id = ? AND filename = ?').run(profileId, filename);
  }
}

interface BackupRow {
  id: string;
  profile_id: string;
  kind: string;
  label: string | null;
  path: string;
  size: number | null;
  status: string;
  consistent: number;
  created_at: number;
  error: string | null;
  contents: string | null;
}

interface TaskRow {
  id: string;
  profile_id: string;
  name: string;
  type: TaskInfo['type'];
  enabled: number;
  schedule: string;
  payload: string;
  last_run: number | null;
  last_status: string | null;
  last_message: string | null;
  next_run: number | null;
}

interface OriginRow {
  filename: string;
  source: string | null;
  project_id: string | null;
  version_id: string | null;
  version: string | null;
  sha1: string | null;
  size: number | null;
  mtime: number | null;
}

function mapBackup(row: BackupRow): BackupInfo {
  let contents: string[] = [];
  try {
    contents = row.contents ? JSON.parse(row.contents) as string[] : [];
  } catch {
    contents = [];
  }
  return {
    id: row.id,
    profileId: row.profile_id,
    kind: row.kind,
    label: row.label,
    size: row.size,
    status: row.status,
    consistent: Boolean(row.consistent),
    createdAt: row.created_at,
    error: row.error,
    contents,
  };
}

function mapTask(row: TaskRow): TaskInfo {
  return {
    id: row.id,
    profileId: row.profile_id,
    name: row.name,
    type: row.type,
    enabled: Boolean(row.enabled),
    schedule: JSON.parse(row.schedule) as ScheduleSpec,
    payload: JSON.parse(row.payload) as TaskInfo['payload'],
    lastRun: row.last_run,
    lastStatus: row.last_status,
    lastMessage: row.last_message,
    nextRun: row.next_run,
  };
}

function mapOrigin(row: OriginRow): PluginOrigin {
  return {
    filename: row.filename,
    source: row.source,
    projectId: row.project_id,
    versionId: row.version_id,
    version: row.version,
    sha1: row.sha1,
    size: row.size,
    mtime: row.mtime,
  };
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function newId(): string {
  return randomUUID();
}
