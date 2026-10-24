export type ServerStatus =
  | 'offline'
  | 'starting'
  | 'online'
  | 'stopping'
  | 'restarting'
  | 'crashed';

export type ManagedState = 'none' | 'attached' | 'detached' | 'external';

export type ServerSoftware =
  | 'paper'
  | 'purpur'
  | 'spigot'
  | 'bukkit'
  | 'folia'
  | 'fabric'
  | 'forge'
  | 'neoforge'
  | 'vanilla'
  | 'hybrid'
  | 'unknown';

export type LaunchMode = 'jar' | 'argfile';

export interface Profile {
  id: string;
  name: string;
  directory: string;
  jarFile: string | null;
  javaPath: string | null;
  minMemory: string;
  maxMemory: string;
  jvmArgs: string;
  serverArgs: string;
  software: ServerSoftware;
  mcVersion: string | null;
  launchMode: LaunchMode;
  argFile: string | null;
  pluginContainer: 'plugins' | 'mods' | 'none';
  autoRestart: boolean;
  autoRestartMax: number;
  autoRestartCooldown: number;
  restartDelay: number;
  createdAt: number;
  updatedAt: number;
}

export interface LogLine {
  id: number;
  ts: number;
  stream: 'stdout' | 'stderr' | 'system';
  level: 'info' | 'warn' | 'error' | 'stack' | 'system';
  text: string;
}

export interface PlayerEvent {
  name: string;
  uuid: string | null;
  event: 'join' | 'leave';
  at: number;
}

export interface StatusSnapshot {
  profileId: string | null;
  status: ServerStatus;
  managed: ManagedState;
  pid: number | null;
  startedAt: number | null;
  uptimeMs: number | null;
  exitCode: number | null;
  lastError: string | null;
  software: ServerSoftware | null;
  mcVersion: string | null;
  playersOnline: number | null;
  maxPlayers: number | null;
  playerNames: string[];
  port: number | null;
  address: string | null;
  motd: string | null;
  world: string | null;
  worldSize: number | null;
  worldSizeState: 'loading' | 'ready' | 'unavailable';
  pluginCount: number | null;
  pluginNote: string | null;
  diskFree: number | null;
  diskTotal: number | null;
  lastBackup: { id: string; at: number; status: string; size: number | null; kind: string } | null;
  cpuPercent: number | null;
  memoryBytes: number | null;
  systemMemory: { total: number; free: number };
  javaVersion: string | null;
  health: 'offline' | 'ok' | 'warning' | 'critical';
  warnings: string[];
  operation: string | null;
  recentLogs: LogLine[];
  recentPlayers: PlayerEvent[];
  eulaAccepted: boolean | null;
  canStart: boolean;
  canStop: boolean;
  canRestart: boolean;
  canKill: boolean;
  canCommand: boolean;
  commandBlockReason: string | null;
}

export interface InspectJar {
  name: string;
  relativePath: string;
  size: number;
  software: ServerSoftware;
  version: string | null;
}

export interface InspectPlugin {
  file: string;
  name: string;
  version: string | null;
  size: number;
  modifiedAt: number;
}

export interface InspectWorld {
  name: string;
  relativePath: string;
  size: number | null;
  modifiedAt: number;
}

export interface JavaCandidate {
  path: string;
  version: string | null;
  warning: string | null;
}

export interface InspectResult {
  directory: string;
  valid: boolean;
  errors: string[];
  warnings: string[];
  jars: InspectJar[];
  argFiles: string[];
  plugins: InspectPlugin[];
  pluginContainer: 'plugins' | 'mods' | 'none';
  configs: string[];
  worlds: InspectWorld[];
  logs: string[];
  serverProperties: {
    port: number | null;
    maxPlayers: number | null;
    motd: string | null;
    levelName: string | null;
    onlineMode: boolean | null;
  } | null;
  eulaAccepted: boolean | null;
  runningPid: number | null;
  javaCandidates: JavaCandidate[];
  suggested: {
    jar: string | null;
    software: ServerSoftware;
    version: string | null;
    launchMode: LaunchMode;
    argFile: string | null;
    pluginContainer: 'plugins' | 'mods' | 'none';
  };
}

export interface JavaCheck {
  path: string;
  version: string | null;
  major: number | null;
  compatible: boolean | null;
  warnings: string[];
}

export type PluginSource = 'modrinth' | 'hangar' | 'spiget' | 'manual';

export type CompatibilityStatus = 'compatible' | 'possible' | 'incompatible' | 'unknown';

export interface PluginDependency {
  projectId: string;
  title: string | null;
  required: boolean;
}

export interface PluginSearchHit {
  source: PluginSource;
  projectId: string;
  slug: string;
  title: string;
  description: string;
  author: string;
  downloads: number | null;
  updatedAt: string | null;
  categories: string[];
  gameVersions: string[];
  iconUrl: string | null;
  projectUrl: string;
  rating: number | null;
  loaders: string[];
  compatibility: CompatibilityStatus;
  compatibilityReason: string;
  latestVersion: string | null;
  latestVersionId: string | null;
  dependencies: PluginDependency[];
  installable: boolean;
  blockedReason: string | null;
}

export interface MarketplaceTarget {
  software: ServerSoftware;
  mcVersion: string | null;
  detectedSoftware: ServerSoftware;
  detectedVersion: string | null;
  build: string | null;
  pluginContainer: 'plugins' | 'mods' | 'none';
}

export interface PluginVersionChoice {
  id: string;
  name: string;
  versionNumber: string;
  date: string | null;
  gameVersions: string[];
  loaders: string[];
  downloads: number | null;
  filename: string | null;
  size: number | null;
  sha1: string | null;
  changelog: string | null;
  dependencies: PluginDependency[];
  compatibility: CompatibilityStatus;
  compatibilityReason: string;
}

export interface PluginProjectDetail {
  source: PluginSource;
  projectId: string;
  title: string;
  description: string;
  body: string;
  author: string;
  downloads: number | null;
  categories: string[];
  sourceUrl: string | null;
  issuesUrl: string | null;
  projectUrl: string;
  versions: PluginVersionChoice[];
}

export interface PluginPreview {
  filename: string;
  size: number | null;
  warnings: string[];
  dependencies: PluginDependency[];
  hasMetadataHint: boolean;
  compatibility: CompatibilityStatus;
  compatibilityReason: string;
}

export interface InstalledPlugin {
  file: string;
  path: string;
  name: string;
  version: string | null;
  size: number;
  modifiedAt: number;
  enabled: 'enabled' | 'disabled' | 'unknown';
  identified: boolean;
  source: PluginSource | null;
  projectId: string | null;
  update: { version: string; filename: string } | null;
  configFolder: string | null;
  configFiles: string[];
}

export interface PlayerRow {
  name: string;
  uuid: string | null;
  online: boolean | null;
  sessionStartedAt: number | null;
  firstSeen: number | null;
  lastSeen: number | null;
  op: boolean;
  opLevel: number | null;
  whitelisted: boolean;
  banned: boolean;
}

export interface BanRow {
  name: string;
  uuid: string | null;
  reason: string | null;
  source: string | null;
  created: string | null;
  expires: string | null;
  temporary: boolean;
  expiresAt: number | null;
}

export interface AccessSnapshot {
  whitelistEnabled: boolean | null;
  onlineMode: boolean | null;
  whitelist: { name: string; uuid: string }[];
  ops: { name: string; uuid: string; level: number }[];
  bans: BanRow[];
  permissionPlugins: string[];
}

export interface ConfigFileInfo {
  path: string;
  name: string;
  size: number;
  modifiedAt: number;
  editable: boolean;
  kind: 'properties' | 'text' | 'json';
}

export interface PropertyField {
  key: string;
  label: string;
  type: 'text' | 'number' | 'boolean' | 'select';
  value: string;
  options?: string[];
  restartRequired: boolean;
  help: string;
}

export interface WorldInfo {
  name: string;
  relativePath: string;
  size: number | null;
  modifiedAt: number;
  configured: boolean;
  hasLevelDat: boolean;
}

export interface BackupInfo {
  id: string;
  profileId: string;
  kind: string;
  label: string | null;
  size: number | null;
  status: string;
  consistent: boolean;
  createdAt: number;
  error: string | null;
  contents: string[];
}

export interface TaskInfo {
  id: string;
  profileId: string;
  name: string;
  type: 'restart' | 'backup' | 'shutdown' | 'startup' | 'command';
  enabled: boolean;
  schedule: ScheduleSpec;
  payload: { command?: string; countdownSeconds?: number; kind?: string };
  lastRun: number | null;
  lastStatus: string | null;
  lastMessage: string | null;
  nextRun: number | null;
}

export interface ScheduleSpec {
  mode: 'interval' | 'daily' | 'weekly';
  intervalMinutes?: number;
  time?: string;
  days?: number[];
}

export interface MetricPoint {
  at: number;
  cpu: number | null;
  memoryBytes: number | null;
  players: number | null;
}

export interface DiagnosticCheck {
  id: string;
  name: string;
  status: 'pass' | 'warn' | 'fail';
  message: string;
  hint: string | null;
}

export interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size: number | null;
  modifiedAt: number | null;
  critical: boolean;
}

export interface SettingsPublic {
  theme: 'dark' | 'light';
  accent: 'grass' | 'emerald' | 'copper' | 'amethyst';
  consoleBuffer: number;
  backupDir: string;
  backupRetention: number;
  excludeLogs: boolean;
  discordWebhook: string;
  webhookConfigured: boolean;
  allowRemote: boolean;
  host: string;
  port: number;
  logRetentionDays: number;
  cpuWarnPercent: number;
  ramWarnPercent: number;
  diskWarnPercent: number;
  modrinthEnabled: boolean;
  hangarEnabled: boolean;
  spigetEnabled: boolean;
  activeProfileId: string | null;
  bindHost: string;
  bindPort: number;
}

export interface MeResponse {
  authenticated: boolean;
  setupComplete: boolean;
  initialPasswordFile: boolean;
  activeProfileId: string | null;
  profiles: Profile[];
  theme: 'dark' | 'light';
  accent: 'grass' | 'emerald' | 'copper' | 'amethyst';
}
