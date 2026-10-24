import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { InspectPlugin, InspectResult, InspectWorld, ServerSoftware } from '../../../shared/types.ts';
import { HttpError } from '../util/errors.ts';
import { detectSoftware, pluginContainerFor } from '../util/detect.ts';
import { getProperty, parseProperties } from '../util/properties.ts';
import { assertSafeServerDirectory, isBlockedSystemPath, isDriveRoot } from '../util/paths.ts';
import { readZipTextFiles } from '../util/zip.ts';

const SKIP = new Set([
  'node_modules', '.git', 'windows', '$recycle.bin', 'appdata', 'application data',
  'program files', 'program files (x86)', 'cache', 'libraries', 'versions', 'logs',
]);

export async function scanForServers(roots: string[]): Promise<{ directory: string; marker: string }[]> {
  const hits: { directory: string; marker: string }[] = [];
  const seen = new Set<string>();
  let visited = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 4 || visited > 3000 || hits.length >= 40) return;
    let real: string;
    try {
      real = fs.realpathSync(dir);
    } catch {
      return;
    }
    if (seen.has(real.toLowerCase()) || isDriveRoot(real) || isBlockedSystemPath(real)) return;
    seen.add(real.toLowerCase());
    visited += 1;
    let entries: fs.Dirent[] = [];
    try {
      entries = await fs.promises.readdir(real, { withFileTypes: true });
    } catch {
      return;
    }
    const marker = serverMarker(entries);
    if (marker) {
      hits.push({ directory: real, marker });
      return;
    }
    if (depth === 4) return;
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (SKIP.has(entry.name.toLowerCase())) continue;
      await walk(path.join(real, entry.name), depth + 1);
    }
  };
  for (const root of roots) {
    if (!root || !fs.existsSync(root)) continue;
    try {
      const real = fs.realpathSync(root);
      if (isDriveRoot(real) || isBlockedSystemPath(real)) {
        throw new HttpError(400, 'Scan roots cannot be a drive root or a system directory', 'BAD_SCAN');
      }
      await walk(real, 0);
    } catch (error) {
      if (error instanceof HttpError) throw error;
    }
  }
  return hits;
}

export function defaultScanRoots(): string[] {
  const home = os.homedir();
  return [
    path.join(home, 'Desktop'),
    path.join(home, 'Documents'),
    path.join(home, 'Downloads'),
    path.join(home, 'Minecraft'),
    path.join(home, 'servers'),
    'C:\\Minecraft',
    'C:\\Games',
    process.cwd(),
  ].filter((root, index, all) => fs.existsSync(root) && all.indexOf(root) === index);
}

export async function inspectServer(directory: string): Promise<InspectResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  let real = directory;
  try {
    real = assertSafeServerDirectory(directory);
  } catch (error) {
    return emptyInspect(directory, [error instanceof Error ? error.message : 'Directory is not usable']);
  }
  const entries = await fs.promises.readdir(real, { withFileTypes: true }).catch(() => [] as fs.Dirent[]);
  const jars = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.jar')) continue;
    const full = path.join(real, entry.name);
    const stat = await fs.promises.stat(full);
    let manifest: string | null = null;
    let versionJson: string | null = null;
    try {
      const files = await readZipTextFiles(full, ['META-INF/MANIFEST.MF', 'version.json']);
      manifest = files.get('META-INF/MANIFEST.MF') ?? null;
      versionJson = files.get('version.json') ?? null;
    } catch {
      warnings.push(`${entry.name} could not be read as a JAR. Detection used the file name only.`);
    }
    const detected = detectSoftware({ fileName: entry.name, manifest, versionJson });
    jars.push({ name: entry.name, relativePath: entry.name, size: stat.size, software: detected.software, version: detected.version });
  }
  const argFiles = await findArgFiles(real);
  const propertiesPath = path.join(real, 'server.properties');
  let serverProperties: InspectResult['serverProperties'] = null;
  if (fs.existsSync(propertiesPath)) {
    try {
      const lines = parseProperties(await fs.promises.readFile(propertiesPath, 'utf8'));
      const port = Number(getProperty(lines, 'server-port'));
      const maxPlayers = Number(getProperty(lines, 'max-players'));
      const online = getProperty(lines, 'online-mode');
      serverProperties = {
        port: Number.isInteger(port) ? port : null,
        maxPlayers: Number.isInteger(maxPlayers) ? maxPlayers : null,
        motd: getProperty(lines, 'motd') ?? null,
        levelName: getProperty(lines, 'level-name') ?? null,
        onlineMode: online === undefined ? null : online === 'true',
      };
    } catch {
      errors.push('server.properties could not be parsed');
    }
  }
  const eulaPath = path.join(real, 'eula.txt');
  let eulaAccepted: boolean | null = null;
  if (fs.existsSync(eulaPath)) {
    const eula = await fs.promises.readFile(eulaPath, 'utf8');
    eulaAccepted = /^\s*eula\s*=\s*true\s*$/im.test(eula);
    if (!eulaAccepted) warnings.push('The Minecraft EULA is not accepted. The server will refuse to start until you set eula=true yourself.');
  }
  const suggestedJar = chooseJar(jars);
  const software = suggestedJar?.software ?? (argFiles.length ? softwareFromArg(argFiles[0]!) : 'unknown');
  let pluginContainer = pluginContainerFor(software);
  if (pluginContainer === 'none' && entries.some((entry) => entry.isDirectory() && entry.name === 'plugins')) pluginContainer = 'plugins';
  if (entries.some((entry) => entry.isDirectory() && entry.name === 'mods') && (software === 'fabric' || software === 'forge' || software === 'neoforge' || software === 'hybrid')) {
    pluginContainer = 'mods';
  }
  const plugins = await readInstalled(real, pluginContainer);
  const worlds = await readWorlds(real, entries, serverProperties?.levelName ?? null);
  const configs = entries.filter((entry) => entry.isFile() && isConfigName(entry.name)).map((entry) => entry.name);
  const configDir = path.join(real, 'config');
  if (fs.existsSync(configDir)) {
    for (const name of await fs.promises.readdir(configDir).catch(() => [])) {
      if (name.endsWith('.yml') || name.endsWith('.yaml') || name.endsWith('.toml') || name.endsWith('.json')) configs.push(`config/${name}`);
    }
  }
  const logsDir = path.join(real, 'logs');
  const logs = fs.existsSync(logsDir)
    ? (await fs.promises.readdir(logsDir).catch(() => [])).filter((name) => name.endsWith('.log') || name.endsWith('.gz')).slice(0, 30)
    : [];
  if (!fs.existsSync(propertiesPath) && jars.length === 0 && argFiles.length === 0) {
    errors.push('No server.properties, server JAR, or Forge/NeoForge argument file was found.');
  }
  if (jars.length === 0 && argFiles.length === 0) errors.push('No launchable server JAR or argument file was found in this directory.');
  return {
    directory: real,
    valid: errors.length === 0,
    errors,
    warnings,
    jars,
    argFiles,
    plugins,
    pluginContainer,
    configs,
    worlds,
    logs,
    serverProperties,
    eulaAccepted,
    runningPid: null,
    javaCandidates: [],
    suggested: {
      jar: suggestedJar?.relativePath ?? null,
      software,
      version: suggestedJar?.version ?? null,
      launchMode: argFiles.length && (software === 'forge' || software === 'neoforge' || software === 'hybrid') ? 'argfile' : 'jar',
      argFile: argFiles[0] ?? null,
      pluginContainer,
    },
  };
}

export function browseForDirectory(): Promise<string | null> {
  if (process.platform !== 'win32') {
    return Promise.reject(new HttpError(400, 'The folder picker is only available on Windows. Enter the path manually.', 'NO_PICKER'));
  }
  const script = `
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'Select the Minecraft server folder'
$dialog.ShowNewFolderButton = $false
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dialog.SelectedPath }
`;
  const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise((resolve, reject) => {
    const child = spawn(exe, ['-NoProfile', '-STA', '-Command', script], { windowsHide: false, shell: false });
    let output = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new HttpError(400, 'The folder picker timed out', 'PICKER_TIMEOUT'));
    }, 180_000);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      output += chunk;
    });
    child.on('error', () => {
      clearTimeout(timer);
      reject(new HttpError(500, 'The folder picker could not be opened', 'PICKER_FAILED'));
    });
    child.on('exit', () => {
      clearTimeout(timer);
      const selected = output.trim().split(/\r?\n/).filter(Boolean).pop() ?? '';
      resolve(selected || null);
    });
  });
}

function serverMarker(entries: fs.Dirent[]): string | null {
  if (entries.some((entry) => entry.isFile() && entry.name.toLowerCase() === 'server.properties')) return 'server.properties';
  const jar = entries.find((entry) => entry.isFile() && isServerJarName(entry.name));
  return jar?.name ?? null;
}

function isServerJarName(name: string): boolean {
  if (!name.toLowerCase().endsWith('.jar')) return false;
  if (name.toLowerCase() === 'server.jar') return true;
  return detectSoftware({ fileName: name }).software !== 'unknown';
}

function chooseJar(jars: InspectResult['jars']): InspectResult['jars'][number] | null {
  const rank: ServerSoftware[] = ['paper', 'purpur', 'folia', 'spigot', 'bukkit', 'hybrid', 'fabric', 'neoforge', 'forge', 'vanilla'];
  return [...jars].sort((a, b) => {
    const ar = rank.indexOf(a.software);
    const br = rank.indexOf(b.software);
    return (ar === -1 ? 99 : ar) - (br === -1 ? 99 : br);
  })[0] ?? null;
}

function softwareFromArg(file: string): ServerSoftware {
  const lower = file.toLowerCase();
  if (lower.includes('neoforge')) return 'neoforge';
  if (lower.includes('forge')) return 'forge';
  return 'hybrid';
}

async function findArgFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 6 || found.length >= 10) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'plugins' || entry.name === 'mods' || entry.name === 'logs') continue;
        await walk(full, depth + 1);
      } else if (entry.name.toLowerCase() === 'win_args.txt') {
        found.push(path.relative(root, full));
      }
    }
  };
  await walk(root, 0);
  return found;
}

async function readInstalled(root: string, container: 'plugins' | 'mods' | 'none'): Promise<InspectPlugin[]> {
  if (container === 'none') return [];
  const dir = path.join(root, container);
  if (!fs.existsSync(dir)) return [];
  const files = (await fs.promises.readdir(dir)).filter((name) => name.toLowerCase().endsWith('.jar') || name.toLowerCase().endsWith('.jar.disabled'));
  const plugins: InspectPlugin[] = [];
  for (const file of files.slice(0, 200)) {
    const full = path.join(dir, file);
    const stat = await fs.promises.stat(full);
    const meta = await readPluginMeta(full);
    plugins.push({ file, name: meta.name ?? file, version: meta.version, size: stat.size, modifiedAt: stat.mtimeMs });
  }
  return plugins;
}

export async function readPluginMeta(file: string): Promise<{ name: string | null; version: string | null; identified: boolean }> {
  try {
    const files = await readZipTextFiles(file, ['plugin.yml', 'paper-plugin.yml', 'fabric.mod.json', 'quilt.mod.json']);
    const yamlText = files.get('plugin.yml') ?? files.get('paper-plugin.yml');
    if (yamlText) {
      const parsed = parseYaml(yamlText) as { name?: string; version?: string };
      return { name: parsed?.name ? String(parsed.name) : null, version: parsed?.version ? String(parsed.version) : null, identified: Boolean(parsed?.name) };
    }
    const jsonText = files.get('fabric.mod.json') ?? files.get('quilt.mod.json');
    if (jsonText) {
      const parsed = JSON.parse(jsonText) as { name?: string; id?: string; version?: string };
      return { name: parsed.name || parsed.id || null, version: parsed.version ?? null, identified: Boolean(parsed.name || parsed.id) };
    }
  } catch {
    return { name: null, version: null, identified: false };
  }
  return { name: null, version: null, identified: false };
}

async function readWorlds(root: string, entries: fs.Dirent[], levelName: string | null): Promise<InspectWorld[]> {
  const worlds: InspectWorld[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const level = path.join(root, entry.name, 'level.dat');
    if (!fs.existsSync(level)) continue;
    const stat = await fs.promises.stat(path.join(root, entry.name));
    worlds.push({ name: entry.name, relativePath: entry.name, size: null, modifiedAt: stat.mtimeMs });
  }
  if (levelName && !worlds.some((world) => world.name === levelName)) {
    // The configured world has not been created yet.
  }
  return worlds;
}

function isConfigName(name: string): boolean {
  const lower = name.toLowerCase();
  return ['server.properties', 'eula.txt', 'bukkit.yml', 'spigot.yml', 'commands.yml', 'purpur.yml', 'help.yml', 'permissions.yml', 'whitelist.json', 'ops.json', 'banned-players.json', 'banned-ips.json'].includes(lower)
    || lower.endsWith('.yml')
    || lower.endsWith('.yaml')
    || lower.endsWith('.toml');
}

function emptyInspect(directory: string, errors: string[]): InspectResult {
  return {
    directory,
    valid: false,
    errors,
    warnings: [],
    jars: [],
    argFiles: [],
    plugins: [],
    pluginContainer: 'none',
    configs: [],
    worlds: [],
    logs: [],
    serverProperties: null,
    eulaAccepted: null,
    runningPid: null,
    javaCandidates: [],
    suggested: { jar: null, software: 'unknown', version: null, launchMode: 'jar', argFile: null, pluginContainer: 'none' },
  };
}
