import fs from 'node:fs';
import path from 'node:path';
import type { ConfigFileInfo, Profile, PropertyField } from '../../../shared/types.ts';
import { HttpError } from '../util/errors.ts';
import { getProperty, parseProperties, setProperty, stringifyProperties, type PropertyLine } from '../util/properties.ts';
import { latestBackup, readTextFile, writeTextFile } from './files.ts';

const KNOWN = [
  'server.properties', 'eula.txt', 'bukkit.yml', 'spigot.yml', 'commands.yml', 'purpur.yml',
  'help.yml', 'permissions.yml', 'whitelist.json', 'ops.json', 'banned-players.json', 'banned-ips.json',
];

const FIELDS: Omit<PropertyField, 'value'>[] = [
  { key: 'motd', label: 'MOTD', type: 'text', restartRequired: true, help: 'Text shown in the server list. A restart is required before clients see a file change.' },
  { key: 'server-port', label: 'Server port', type: 'number', restartRequired: true, help: 'Port the server listens on.' },
  { key: 'server-ip', label: 'Server IP', type: 'text', restartRequired: true, help: 'Blank binds all interfaces. A restart is required.' },
  { key: 'max-players', label: 'Maximum players', type: 'number', restartRequired: true, help: 'Player cap. A restart is required.' },
  { key: 'difficulty', label: 'Difficulty', type: 'select', options: ['peaceful', 'easy', 'normal', 'hard'], restartRequired: false, help: 'Default difficulty. The running server also accepts /difficulty.' },
  { key: 'gamemode', label: 'Game mode', type: 'select', options: ['survival', 'creative', 'adventure', 'spectator'], restartRequired: false, help: 'Default mode for new players. The running server also accepts /defaultgamemode.' },
  { key: 'online-mode', label: 'Online mode', type: 'boolean', restartRequired: true, help: 'When true, players must authenticate with Mojang. A restart is required.' },
  { key: 'pvp', label: 'PvP', type: 'boolean', restartRequired: true, help: 'Allow players to damage each other. A restart is required.' },
  { key: 'view-distance', label: 'View distance', type: 'number', restartRequired: true, help: 'Chunk view distance. Paper can also change this live with a command, but the file applies on restart.' },
  { key: 'simulation-distance', label: 'Simulation distance', type: 'number', restartRequired: true, help: 'Distance at which the world ticks. A restart is required.' },
  { key: 'white-list', label: 'Whitelist', type: 'boolean', restartRequired: false, help: 'Saved whitelist state. Use the Players page to change it live.' },
  { key: 'enable-command-block', label: 'Command blocks', type: 'boolean', restartRequired: true, help: 'A restart is required.' },
  { key: 'spawn-protection', label: 'Spawn protection', type: 'number', restartRequired: true, help: 'Radius around spawn that non-operators cannot modify. A restart is required.' },
  { key: 'level-name', label: 'World name', type: 'text', restartRequired: true, help: 'Folder name of the overworld. Changing this does not move the existing world. A restart is required.' },
  { key: 'resource-pack', label: 'Resource pack URL', type: 'text', restartRequired: true, help: 'Optional HTTP(S) URL. A restart is required.' },
  { key: 'resource-pack-sha1', label: 'Resource pack SHA1', type: 'text', restartRequired: true, help: 'Lowercase hex digest, or blank.' },
  { key: 'require-resource-pack', label: 'Require resource pack', type: 'boolean', restartRequired: true, help: 'A restart is required.' },
];

const BOOLEAN_KEYS = new Set(['online-mode', 'pvp', 'white-list', 'enable-command-block', 'require-resource-pack']);

export async function listConfigFiles(profile: Profile): Promise<ConfigFileInfo[]> {
  const found = new Map<string, ConfigFileInfo>();
  const add = async (relative: string) => {
    const abs = path.join(profile.directory, relative);
    if (!fs.existsSync(abs)) return;
    const stat = await fs.promises.stat(abs);
    if (!stat.isFile()) return;
    const ext = path.extname(relative).toLowerCase();
    found.set(relative.replace(/\\/g, '/'), {
      path: relative.replace(/\\/g, '/'),
      name: path.basename(relative),
      size: stat.size,
      modifiedAt: stat.mtimeMs,
      editable: ['.properties', '.yml', '.yaml', '.json', '.txt', '.toml', '.conf'].includes(ext),
      kind: ext === '.properties' ? 'properties' : ext === '.json' ? 'json' : 'text',
    });
  };
  for (const name of KNOWN) await add(name);
  const configDir = path.join(profile.directory, 'config');
  if (fs.existsSync(configDir)) {
    const walk = async (dir: string, depth: number) => {
      if (depth > 2) return;
      for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full, depth + 1);
        else await add(path.relative(profile.directory, full));
      }
    };
    await walk(configDir, 0);
  }
  return [...found.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export async function readPropertiesForm(profile: Profile): Promise<{ fields: PropertyField[]; hash: string; raw: string }> {
  const file = await readTextFile(profile.directory, 'server.properties');
  const lines = parseProperties(file.content);
  return {
    hash: file.hash,
    raw: file.content,
    fields: FIELDS.map((field) => ({ ...field, value: getProperty(lines, field.key) ?? '' })),
  };
}

export function applyPropertyForm(raw: string, values: Record<string, string>): string {
  let lines = parseProperties(raw);
  for (const field of FIELDS) {
    if (!(field.key in values)) continue;
    const rawValue = values[field.key] ?? '';
    if (rawValue.trim() === '' && BOOLEAN_KEYS.has(field.key) && getProperty(lines, field.key) == null) continue;
    const value = validateField(field.key, rawValue);
    lines = setProperty(lines, field.key, value);
  }
  return stringifyProperties(lines);
}

export function validateField(key: string, value: string): string {
  const trimmed = value.trim();
  if (/[\r\n\0]/.test(value)) throw new HttpError(400, `${key} cannot contain a new line`, 'BAD_PROPERTY');
  if (key === 'server-port') return String(assertRange(trimmed, 1, 65535, 'Port'));
  if (key === 'max-players') return String(assertRange(trimmed, 1, 100000, 'Maximum players'));
  if (key === 'view-distance' || key === 'simulation-distance') return String(assertRange(trimmed, 2, 64, key));
  if (key === 'spawn-protection') return String(assertRange(trimmed, 0, 200000, 'Spawn protection'));
  if (key === 'difficulty' && !['peaceful', 'easy', 'normal', 'hard'].includes(trimmed)) throw new HttpError(400, 'Difficulty is invalid', 'BAD_PROPERTY');
  if (key === 'gamemode' && !['survival', 'creative', 'adventure', 'spectator'].includes(trimmed)) throw new HttpError(400, 'Game mode is invalid', 'BAD_PROPERTY');
  if (BOOLEAN_KEYS.has(key)) {
    if (trimmed !== 'true' && trimmed !== 'false') throw new HttpError(400, `${key} must be true or false`, 'BAD_PROPERTY');
  }
  if (key === 'motd' && trimmed.length > 256) throw new HttpError(400, 'MOTD is too long', 'BAD_PROPERTY');
  if (key === 'level-name' && !/^[A-Za-z0-9._-]{1,64}$/.test(trimmed)) throw new HttpError(400, 'World name contains unsupported characters', 'BAD_PROPERTY');
  if (key === 'resource-pack' && trimmed && !/^https?:\/\//i.test(trimmed)) throw new HttpError(400, 'Resource pack must be an HTTP(S) URL or blank', 'BAD_PROPERTY');
  if (key === 'resource-pack-sha1' && trimmed && !/^[a-fA-F0-9]{40}$/.test(trimmed)) throw new HttpError(400, 'Resource pack SHA1 must be 40 hex characters or blank', 'BAD_PROPERTY');
  if (key === 'server-ip' && trimmed && !/^[A-Za-z0-9.:-]{1,64}$/.test(trimmed)) throw new HttpError(400, 'Server IP contains unsupported characters', 'BAD_PROPERTY');
  return trimmed;
}

export async function saveConfig(profile: Profile, relative: string, content: string, hash: string, historyDir: string): Promise<{ hash: string }> {
  if (relative.replace(/\\/g, '/') === 'eula.txt' && /^\s*eula\s*=\s*true\s*$/im.test(content)) {
    // The user explicitly saved this content. Mineview never writes it on its own.
  }
  return writeTextFile(profile.directory, relative, content, hash, historyDir);
}

export async function revertConfig(profile: Profile, relative: string, historyDir: string): Promise<{ hash: string }> {
  const backup = await latestBackup(historyDir, relative);
  if (!backup) throw new HttpError(404, 'No previous version is stored for this file', 'NO_BACKUP');
  const content = await fs.promises.readFile(backup, 'utf8');
  const current = await readTextFile(profile.directory, relative);
  return writeTextFile(profile.directory, relative, content, current.hash, historyDir);
}

export function readServerProperty(profile: Profile, key: string): string | null {
  const file = path.join(profile.directory, 'server.properties');
  if (!fs.existsSync(file)) return null;
  const lines: PropertyLine[] = parseProperties(fs.readFileSync(file, 'utf8'));
  return getProperty(lines, key) ?? null;
}

function assertRange(value: string, min: number, max: number, label: string): number {
  if (!/^\d+$/.test(value)) throw new HttpError(400, `${label} must be a whole number`, 'BAD_PROPERTY');
  const number = Number(value);
  if (number < min || number > max) throw new HttpError(400, `${label} must be between ${min} and ${max}`, 'BAD_PROPERTY');
  return number;
}
