import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { InstalledPlugin, PluginPreview, PluginSource, Profile } from '../../../shared/types.ts';
import type { AppDb, PluginOrigin } from '../db.ts';
import { HttpError } from '../util/errors.ts';
import { fetchAllowlisted } from '../util/net.ts';
import { resolveWithinRoot, sanitizeFilename } from '../util/paths.ts';
import { readZipTextFiles } from '../util/zip.ts';
import { atomicWrite } from './files.ts';
import { readPluginMeta } from './discovery.ts';
import { chooseRelease, classifyRelease } from './compatibility.ts';
import { resolveDownload } from './repositories.ts';

const MAX_JAR = 100 * 1024 * 1024;

export async function listInstalled(db: AppDb, profile: Profile): Promise<InstalledPlugin[]> {
  const dir = containerDir(profile);
  if (!fs.existsSync(dir)) return [];
  const names = (await fs.promises.readdir(dir)).filter((name) => name.toLowerCase().endsWith('.jar') || name.toLowerCase().endsWith('.jar.disabled'));
  const log = await recentLog(profile);
  const plugins: InstalledPlugin[] = [];
  for (const file of names) {
    const abs = path.join(dir, file);
    const stat = await fs.promises.stat(abs);
    const meta = await readPluginMeta(abs);
    const origin = db.getOrigin(profile.id, file.replace(/\.disabled$/, ''));
    const enabled = file.endsWith('.disabled') ? 'disabled' : log && meta.name && log.includes(`Enabling ${meta.name}`) ? 'enabled' : 'unknown';
    const configFolder = meta.name ? findConfigFolder(dir, meta.name) : null;
    plugins.push({
      file,
      path: path.relative(profile.directory, abs),
      name: meta.name ?? file,
      version: meta.version ?? origin?.version ?? null,
      size: stat.size,
      modifiedAt: stat.mtimeMs,
      enabled,
      identified: meta.identified,
      source: (origin?.source as PluginSource | null) ?? null,
      projectId: origin?.projectId ?? null,
      update: null,
      configFolder: configFolder ? path.relative(profile.directory, configFolder) : null,
      configFiles: configFolder ? listTextConfigs(configFolder).map((full) => path.relative(profile.directory, full)) : [],
    });
  }
  return plugins.sort((a, b) => a.name.localeCompare(b.name));
}

export async function previewPlugin(profile: Profile, source: PluginSource, projectId: string, versionId: string): Promise<PluginPreview> {
  const resolved = await resolveDownload(source, projectId, versionId);
  const judged = classifyRelease({ software: profile.software, mcVersion: profile.mcVersion }, resolved);
  const warnings = [
    'Plugins execute code inside the Minecraft server. Mineview does not run the JAR, but the server will when it loads plugins.',
    judged.reason,
  ];
  if (judged.status === 'unknown' || judged.status === 'incompatible') {
    warnings.push('This release will not be installed. Compatibility has to be verified for this server before download.');
  }
  const dependencies = resolved.dependencies.filter((item) => item.required).slice(0, 8).map((item) => ({
    projectId: item.projectId,
    title: item.projectId,
    required: true,
  }));
  if (dependencies.length) warnings.push('This version declares required dependencies. Confirm before they are installed too.');
  return { filename: resolved.filename, size: resolved.size, warnings, dependencies, hasMetadataHint: true, compatibility: judged.status, compatibilityReason: judged.reason };
}

export async function installFromRepository(db: AppDb, profile: Profile, source: PluginSource, projectId: string, versionId: string, includeDependencies: boolean, backupDir: string): Promise<{ files: string[]; skipped: string[]; restartRequired: boolean }> {
  const preview = await previewPlugin(profile, source, projectId, versionId);
  if (preview.compatibility !== 'compatible' && preview.compatibility !== 'possible') {
    throw new HttpError(409, preview.compatibilityReason, 'INCOMPATIBLE');
  }
  if (preview.dependencies.length && !includeDependencies) {
    throw new HttpError(409, 'This plugin has required dependencies. Confirm to install them as well.', 'DEPENDENCIES');
  }
  const installed: string[] = [];
  const skipped: string[] = [];
  const resolved = await resolveDownload(source, projectId, versionId);
  installed.push(await downloadInto(db, profile, resolved.url, resolved.filename, {
    filename: sanitizeFilename(resolved.filename),
    source,
    projectId,
    versionId,
    version: versionId,
    sha1: resolved.sha1,
    size: resolved.size,
    mtime: Date.now(),
  }, backupDir));
  if (includeDependencies) {
    for (const dep of preview.dependencies) {
      try {
        const detailUrl = source === 'modrinth'
          ? `https://api.modrinth.com/v2/project/${encodeURIComponent(dep.projectId)}/version`
          : '';
        if (!detailUrl) {
          skipped.push(dep.projectId);
          continue;
        }
        const response = await fetchAllowlisted(detailUrl, { timeoutMs: 20_000 });
        if (!response.ok) {
          skipped.push(dep.projectId);
          continue;
        }
        const versions = await response.json() as { id: string; game_versions?: string[]; loaders?: string[]; files?: { url: string; filename: string; primary?: boolean; hashes?: { sha1?: string } }[] }[];
        const ranked = versions.map((version) => ({
          id: version.id,
          loaders: version.loaders ?? [],
          gameVersions: version.game_versions ?? [],
          files: version.files,
        }));
        const chosen = chooseRelease(ranked, { software: profile.software, mcVersion: profile.mcVersion });
        const file = chosen?.release.files?.find((item) => item.primary) ?? chosen?.release.files?.[0];
        if (!chosen || (chosen.status !== 'compatible' && chosen.status !== 'possible') || !file?.filename.endsWith('.jar')) {
          skipped.push(dep.projectId);
          continue;
        }
        installed.push(await downloadInto(db, profile, file.url, file.filename, {
          filename: sanitizeFilename(file.filename), source, projectId: dep.projectId, versionId: chosen.release.id, version: chosen.release.id, sha1: file.hashes?.sha1 ?? null, size: null, mtime: Date.now(),
        }, backupDir));
      } catch {
        skipped.push(dep.projectId);
      }
    }
  }
  db.addEvent(profile.id, 'plugin-install', installed.join(', '));
  return { files: installed, skipped, restartRequired: true };
}

export async function installUpload(db: AppDb, profile: Profile, tempFile: string, originalName: string, meta: { name?: string; version?: string; sourceUrl?: string; minecraftVersion?: string; software?: string; notes?: string }, replace: boolean, acknowledge: boolean, backupDir: string): Promise<string> {
  const filename = sanitizeFilename(originalName);
  const header = Buffer.alloc(4);
  const handle = await fs.promises.open(tempFile, 'r');
  await handle.read(header, 0, 4, 0);
  await handle.close();
  if (header[0] !== 0x50 || header[1] !== 0x4b) throw new HttpError(400, 'The upload is not a JAR archive', 'NOT_JAR');
  const stat = await fs.promises.stat(tempFile);
  if (stat.size > MAX_JAR) throw new HttpError(400, 'JAR files must be 100 MB or smaller', 'TOO_LARGE');
  const pluginMeta = await readPluginMeta(tempFile);
  if (!pluginMeta.identified && !acknowledge) {
    throw new HttpError(400, 'No plugin metadata was found. Confirm that you trust this file before installing it.', 'UNVERIFIED');
  }
  const dest = destination(profile, filename);
  if (fs.existsSync(dest)) {
    if (!replace) throw new HttpError(409, 'That plugin file already exists', 'EXISTS');
    await archiveExisting(dest, backupDir, profile.id, filename);
  }
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  await fs.promises.copyFile(tempFile, dest);
  await fs.promises.rm(tempFile, { force: true });
  const sha1 = await hashFile(dest);
  db.saveOrigin(profile.id, {
    filename,
    source: 'manual',
    projectId: null,
    versionId: null,
    version: meta.version || pluginMeta.version,
    sha1,
    size: stat.size,
    mtime: Date.now(),
  });
  const note = [meta.name, meta.version, meta.minecraftVersion, meta.software, meta.sourceUrl, meta.notes].filter((part) => part && String(part).trim()).join(' · ').slice(0, 400);
  db.addEvent(profile.id, 'plugin-upload', note ? `${filename} · ${note}` : filename);
  return filename;
}

export async function uninstallPlugin(db: AppDb, profile: Profile, file: string, keepConfig: boolean, backupDir: string): Promise<void> {
  const abs = pluginFile(profile, file);
  const meta = await readPluginMeta(abs).catch(() => ({ name: null, version: null, identified: false }));
  await archiveExisting(abs, backupDir, profile.id, path.basename(abs));
  await fs.promises.rm(abs, { force: false });
  if (!keepConfig) {
    const folder = meta.name ? findConfigFolder(containerDir(profile), meta.name) : null;
    if (folder) {
      const archived = path.join(backupDir, 'plugin-configs', profile.id, `${path.basename(folder)}-${Date.now()}`);
      await fs.promises.mkdir(path.dirname(archived), { recursive: true });
      await fs.promises.rename(folder, archived);
    }
  }
  db.deleteOrigin(profile.id, path.basename(abs).replace(/\.disabled$/, ''));
  db.addEvent(profile.id, 'plugin-remove', file);
}

export async function togglePlugin(profile: Profile, file: string, enable: boolean): Promise<string> {
  const abs = pluginFile(profile, file);
  const dir = path.dirname(abs);
  const base = path.basename(abs);
  const next = enable ? base.replace(/\.disabled$/, '') : (base.endsWith('.disabled') ? base : `${base}.disabled`);
  const dest = path.join(dir, next);
  if (dest !== abs) await fs.promises.rename(abs, dest);
  return next;
}

export async function pluginErrors(profile: Profile, name: string): Promise<string[]> {
  if (!name || name.length > 80) throw new HttpError(400, 'Plugin name is invalid', 'BAD_NAME');
  const log = await recentLog(profile);
  if (!log) return [];
  return log.split(/\r?\n/).filter((line) => line.toLowerCase().includes(name.toLowerCase()) && /error|exception|warn/i.test(line)).slice(-40);
}

export async function checkUpdates(db: AppDb, profile: Profile): Promise<{ file: string; version: string | null }[]> {
  const installed = await listInstalled(db, profile);
  const hashes: { file: string; sha1: string }[] = [];
  for (const plugin of installed) {
    if (plugin.file.endsWith('.disabled')) continue;
    const abs = path.join(profile.directory, plugin.path);
    const sha1 = await hashFile(abs);
    hashes.push({ file: plugin.file, sha1 });
  }
  if (!hashes.length) return [];
  const response = await fetchAllowlisted('https://api.modrinth.com/v2/version_files/update', {
    method: 'POST',
    timeoutMs: 20_000,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      algorithm: 'sha1',
      hashes: hashes.map((item) => item.sha1),
      loaders: profile.software === 'unknown' ? undefined : [profile.software],
      game_versions: profile.mcVersion ? [profile.mcVersion] : undefined,
    }),
  });
  if (!response.ok) throw new HttpError(502, 'Modrinth update check failed', 'UPSTREAM');
  const body = await response.json() as Record<string, { version_number?: string; files?: { hashes?: { sha1?: string } }[] }>;
  const updates: { file: string; version: string | null }[] = [];
  for (const item of hashes) {
    const match = body[item.sha1];
    if (!match) continue;
    const same = match.files?.some((file) => file.hashes?.sha1 === item.sha1);
    if (!same) updates.push({ file: item.file, version: match.version_number ?? null });
  }
  return updates;
}

async function downloadInto(db: AppDb, profile: Profile, url: string, filename: string, origin: PluginOrigin, backupDir: string): Promise<string> {
  const safe = sanitizeFilename(filename);
  const dest = destination(profile, safe);
  if (fs.existsSync(dest)) await archiveExisting(dest, backupDir, profile.id, safe);
  const response = await fetchAllowlisted(url, { timeoutMs: 120_000 });
  if (!response.ok || !response.body) throw new HttpError(502, `Download failed (${response.status})`, 'DOWNLOAD_FAILED');
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('json') || contentType.includes('html')) throw new HttpError(400, 'The repository did not return a JAR file', 'NOT_JAR');
  const length = Number(response.headers.get('content-length') || 0);
  if (length > MAX_JAR) throw new HttpError(400, 'Plugin download is larger than 100 MB', 'TOO_LARGE');
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.partial`;
  const hash = createHash('sha1');
  let size = 0;
  let checked = false;
  const output = fs.createWriteStream(tmp);
  try {
    for await (const chunk of Readable.fromWeb(response.body as import('node:stream/web').ReadableStream)) {
      const buffer = Buffer.from(chunk as Buffer);
      size += buffer.length;
      if (size > MAX_JAR) throw new HttpError(400, 'Plugin download is larger than 100 MB', 'TOO_LARGE');
      if (!checked) {
        if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) throw new HttpError(400, 'Download was not a JAR archive', 'NOT_JAR');
        checked = true;
      }
      hash.update(buffer);
      if (!output.write(buffer)) await new Promise<void>((resolve) => output.once('drain', () => resolve()));
    }
  } catch (error) {
    output.destroy();
    await fs.promises.rm(tmp, { force: true });
    throw error;
  }
  await new Promise<void>((resolve, reject) => {
    output.on('error', reject);
    output.end(() => resolve());
  });
  const digest = hash.digest('hex');
  if (origin.sha1 && digest.toLowerCase() !== origin.sha1.toLowerCase()) {
    await fs.promises.rm(tmp, { force: true });
    throw new HttpError(400, 'The download hash did not match the repository', 'BAD_HASH');
  }
  await atomicWrite(dest, await fs.promises.readFile(tmp));
  await fs.promises.rm(tmp, { force: true });
  db.saveOrigin(profile.id, { ...origin, filename: safe, sha1: digest, size, mtime: Date.now() });
  return safe;
}

function containerDir(profile: Profile): string {
  if (profile.pluginContainer === 'none') throw new HttpError(400, 'This server software has no plugin folder', 'NO_PLUGINS');
  return path.join(profile.directory, profile.pluginContainer);
}

function destination(profile: Profile, filename: string): string {
  return resolveWithinRoot(profile.directory, path.join(profile.pluginContainer, filename));
}

function pluginFile(profile: Profile, file: string): string {
  const base = path.basename(file);
  if (base !== file.replace(/\\/g, '/')) throw new HttpError(400, 'Invalid plugin file', 'BAD_NAME');
  return resolveWithinRoot(profile.directory, path.join(profile.pluginContainer, base));
}

async function archiveExisting(file: string, backupDir: string, profileId: string, filename: string): Promise<void> {
  const dest = path.join(backupDir, 'plugin-jars', profileId, `${Date.now()}-${path.basename(filename)}`);
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  await fs.promises.copyFile(file, dest);
}

function findConfigFolder(pluginDir: string, name: string): string | null {
  const direct = path.join(pluginDir, name);
  if (fs.existsSync(direct) && fs.statSync(direct).isDirectory()) return direct;
  const entries = fs.readdirSync(pluginDir, { withFileTypes: true });
  const match = entries.find((entry) => entry.isDirectory() && entry.name.toLowerCase() === name.toLowerCase());
  return match ? path.join(pluginDir, match.name) : null;
}

function listTextConfigs(folder: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 2) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (/\.(ya?ml|json|properties|conf|toml|txt)$/i.test(entry.name)) out.push(full);
    }
  };
  walk(folder, 0);
  return out.slice(0, 40);
}

async function recentLog(profile: Profile): Promise<string | null> {
  const file = path.join(profile.directory, 'logs', 'latest.log');
  if (!fs.existsSync(file)) return null;
  const stat = await fs.promises.stat(file);
  const handle = await fs.promises.open(file, 'r');
  const length = Math.min(stat.size, 300_000);
  const buffer = Buffer.alloc(length);
  await handle.read(buffer, 0, length, Math.max(0, stat.size - length));
  await handle.close();
  return buffer.toString('utf8');
}

async function hashFile(file: string): Promise<string> {
  const hash = createHash('sha1');
  await new Promise<void>((resolve, reject) => {
    fs.createReadStream(file).on('data', (chunk) => hash.update(chunk)).on('error', reject).on('end', () => resolve());
  });
  return hash.digest('hex');
}

export async function jarHasMetadata(file: string): Promise<boolean> {
  const files = await readZipTextFiles(file, ['plugin.yml', 'paper-plugin.yml', 'fabric.mod.json']);
  return files.size > 0;
}
