import type { Express, Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import type { ScheduleSpec, SettingsPublic } from '../../shared/types.ts';
import type { AppDb, AppSettings } from './db.ts';
import { newId } from './db.ts';
import { asyncRoute, clientIp, csrfHeader, errorHandler, rateLimit, safeEqual, sessionToken } from './http.ts';
import { serializeCookie } from './util/cookies.ts';
import { HttpError } from './util/errors.ts';
import { assertDiscordWebhook, isLoopbackHost } from './util/net.ts';
import { assertSchedule, computeNextRun } from './util/schedule.ts';
import { writeRuntimeFile } from './env.ts';
import { profileFromInput } from './profiles.ts';
import { browseForDirectory, defaultScanRoots, inspectServer, scanForServers } from './services/discovery.ts';
import { checkJava, findJavaInstallations } from './services/java.ts';
import type { ProcessManager } from './services/processManager.ts';
import { buildStatus } from './services/status.ts';
import { createBackup, pruneBackups, registerLooseArchives, restoreBackup } from './services/backups.ts';
import { deleteWorld, exportWorld, listWorlds } from './services/worlds.ts';
import { applyPropertyForm, listConfigFiles, readPropertiesForm, readServerProperty, revertConfig, saveConfig } from './services/configFiles.ts';
import { listDirectory, readTextFile, removePath, renamePath, revealPath, saveUpload, searchFiles, writeTextFile, makeDirectory, resolveDownload } from './services/files.ts';
import { ban, deop, kick, listPlayers, message, op, pardon, readAccess, teleport, tempBan, whitelistAdd, whitelistRemove } from './services/players.ts';
import { isRepositorySource, isSoftware, marketplaceTarget, searchCatalogue } from './services/marketplace.ts';
import { checkUpdates, installFromRepository, installUpload, listInstalled, pluginErrors, previewPlugin, togglePlugin, uninstallPlugin } from './services/plugins.ts';
import { projectDetail } from './services/repositories.ts';
import { createTask, type TaskScheduler } from './services/scheduler.ts';
import { runDiagnostics } from './services/diagnostics.ts';
import type { Profile } from '../../shared/types.ts';

const MAX_AGE = 14 * 24 * 60 * 60;

export interface AppServices {
  db: AppDb;
  dataDir: string;
  proc: ProcessManager;
  scheduler: TaskScheduler;
}

export function mountApi(app: Express, services: AppServices): void {
  const { db, proc } = services;
  const upload = multer({ dest: path.join(services.dataDir, 'tmp'), limits: { fileSize: 512 * 1024 * 1024 } });
  const jarUpload = multer({ dest: path.join(services.dataDir, 'tmp'), limits: { fileSize: 100 * 1024 * 1024 } });
  fs.mkdirSync(path.join(services.dataDir, 'tmp'), { recursive: true });

  const backupDir = () => db.getSettings().backupDir || path.join(services.dataDir, 'backups');
  const historyDir = (profileId: string) => path.join(services.dataDir, 'config-history', profileId);
  const active = (): Profile => {
    const id = db.getSettings().activeProfileId;
    const profile = id ? db.getProfile(id) : null;
    if (!profile) throw new HttpError(400, 'Select a server profile first', 'NO_PROFILE');
    return profile;
  };

  app.use('/api', (req, res, next) => {
    if (req.path === '/health') return next();
    const token = sessionToken(req);
    let session = db.getSession(token);
    if (!session || !token) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.status(401).json({ error: 'Refresh Mineview and try again', code: 'AUTH' });
        return;
      }
      const created = db.createSession();
      setSession(res, created.token, created.csrf);
      session = db.getSession(created.token);
    }
    if (!['GET', 'HEAD'].includes(req.method)) {
      const header = csrfHeader(req);
      if (!session || !header || !safeEqual(header, session.csrf)) {
        res.status(403).json({ error: 'Security token mismatch. Refresh the page and try again.', code: 'CSRF' });
        return;
      }
    }
    if (token && session && session.expiresAt - Date.now() < 7 * 24 * 60 * 60 * 1000) db.touchSession(token, Date.now() + MAX_AGE * 1000);
    next();
  });

  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  app.get('/api/me', asyncRoute(async (_req, res) => {
    const settings = db.getSettings();
    res.json({
      authenticated: true,
      setupComplete: db.listProfiles().length > 0,
      activeProfileId: settings.activeProfileId,
      profiles: db.listProfiles(),
      theme: settings.theme,
      accent: settings.accent,
    });
  }));

  app.post('/api/discovery/scan', asyncRoute(async (req, res) => {
    rateLimit('scan', 6, 60_000);
    const roots = Array.isArray(req.body?.roots) && req.body.roots.length ? req.body.roots.map(String) : defaultScanRoots();
    res.json({ roots, results: await scanForServers(roots) });
  }));
  app.post('/api/discovery/inspect', asyncRoute(async (req, res) => {
    res.json(await inspectServer(String(req.body?.directory ?? '')));
  }));
  app.post('/api/discovery/browse', asyncRoute(async (_req, res) => {
    res.json({ path: await browseForDirectory() });
  }));
  app.get('/api/java', asyncRoute(async (_req, res) => {
    res.json({ candidates: await findJavaInstallations() });
  }));
  app.post('/api/java/check', asyncRoute(async (req, res) => {
    res.json(await checkJava(String(req.body?.executable ?? ''), req.body?.minecraftVersion ? String(req.body.minecraftVersion) : null));
  }));

  app.get('/api/profiles', asyncRoute(async (_req, res) => res.json({ profiles: db.listProfiles(), activeProfileId: db.getSettings().activeProfileId })));
  app.post('/api/profiles', asyncRoute(async (req, res) => {
    const profile = await profileFromInput(req.body ?? {});
    db.insertProfile(profile);
    const settings = db.getSettings();
    if (!settings.activeProfileId) {
      settings.activeProfileId = profile.id;
      db.saveSettings(settings);
    }
    db.addEvent(profile.id, 'profile', 'Server profile created');
    res.status(201).json({ profile });
  }));
  app.patch('/api/profiles/:id', asyncRoute(async (req, res) => {
    const current = db.getProfile(req.params.id);
    if (!current) throw new HttpError(404, 'Profile not found', 'NOT_FOUND');
    const profile = await profileFromInput({ ...current, ...req.body, directory: req.body?.directory ?? current.directory }, current);
    db.updateProfile(profile);
    res.json({ profile });
  }));
  app.delete('/api/profiles/:id', asyncRoute(async (req, res) => {
    if (req.body?.confirm !== true) throw new HttpError(400, 'Confirm profile deletion', 'CONFIRM');
    db.deleteProfile(req.params.id);
    const settings = db.getSettings();
    if (settings.activeProfileId === req.params.id) {
      settings.activeProfileId = db.listProfiles()[0]?.id ?? null;
      db.saveSettings(settings);
    }
    res.json({ ok: true });
  }));
  app.post('/api/profiles/:id/activate', asyncRoute(async (req, res) => {
    if (!db.getProfile(req.params.id)) throw new HttpError(404, 'Profile not found', 'NOT_FOUND');
    const settings = db.getSettings();
    settings.activeProfileId = req.params.id;
    db.saveSettings(settings);
    res.json({ activeProfileId: req.params.id });
  }));

  app.get('/api/server/status', asyncRoute(async (_req, res) => {
    const id = db.getSettings().activeProfileId;
    res.json(await buildStatus(db, proc, id ? db.getProfile(id) : null));
  }));
  app.post('/api/server/start', asyncRoute(async (req, res) => {
    rateLimit(`start:${clientIp(req)}`, 10, 60_000);
    const profile = active();
    await proc.start(profile);
    res.json(await buildStatus(db, proc, profile));
  }));
  app.post('/api/server/stop', asyncRoute(async (_req, res) => {
    const profile = active();
    await proc.stop(profile);
    res.json(await buildStatus(db, proc, profile));
  }));
  app.post('/api/server/restart', asyncRoute(async (_req, res) => {
    const profile = active();
    await proc.restart(profile);
    res.json(await buildStatus(db, proc, profile));
  }));
  app.post('/api/server/kill', asyncRoute(async (req, res) => {
    if (req.body?.confirm !== 'KILL') throw new HttpError(400, 'Type KILL to confirm force stop', 'CONFIRM');
    const profile = active();
    await proc.kill(profile);
    res.json(await buildStatus(db, proc, profile));
  }));
  app.post('/api/server/command', asyncRoute(async (req, res) => {
    const profile = active();
    proc.sendCommand(profile, String(req.body?.command ?? ''));
    res.json({ ok: true });
  }));
  app.get('/api/console/recent', asyncRoute(async (_req, res) => {
    const profile = active();
    res.json({ lines: proc.lines(profile.id) });
  }));

  app.get('/api/plugins/target', asyncRoute(async (_req, res) => {
    res.json(await marketplaceTarget(active()));
  }));
  app.get('/api/plugins/search', asyncRoute(async (req, res) => {
    const profile = active();
    const settings = db.getSettings();
    const requested = String(req.query.source ?? 'modrinth');
    const source = isRepositorySource(requested) ? requested : 'modrinth';
    if (source === 'modrinth' && !settings.modrinthEnabled) throw new HttpError(400, 'Modrinth is disabled in Settings', 'DISABLED');
    if (source === 'hangar' && !settings.hangarEnabled) throw new HttpError(400, 'Hangar is disabled in Settings', 'DISABLED');
    if (source === 'spiget' && !settings.spigetEnabled) throw new HttpError(400, 'Spigot is disabled in Settings', 'DISABLED');
    const detected = await marketplaceTarget(profile);
    const loader = req.query.loader ? String(req.query.loader) : '';
    const software = isSoftware(loader) ? loader : profile.software !== 'unknown' ? profile.software : detected.detectedSoftware;
    const mcVersion = req.query.version ? String(req.query.version) : profile.mcVersion ?? detected.detectedVersion;
    const projectType = profile.pluginContainer === 'mods' ? 'mod' : 'plugin';
    res.json(await searchCatalogue(profile, {
      source,
      q: String(req.query.q ?? '').slice(0, 80),
      version: mcVersion ?? undefined,
      loader: software === 'unknown' ? undefined : software,
      category: req.query.category ? String(req.query.category).slice(0, 40) : undefined,
      sort: req.query.sort === 'downloads' || req.query.sort === 'updated' ? req.query.sort : 'relevance',
      offset: Math.max(0, Math.min(500, Number(req.query.offset) || 0)),
      limit: 12,
      projectType,
      strict: req.query.strict === '1',
    }, { software, mcVersion }));
  }));
  app.get('/api/plugins/project', asyncRoute(async (req, res) => {
    const requested = String(req.query.source ?? 'modrinth');
    const source = isRepositorySource(requested) ? requested : 'modrinth';
    const profile = active();
    const detected = await marketplaceTarget(profile);
    const software = profile.software !== 'unknown' ? profile.software : detected.detectedSoftware;
    res.json(await projectDetail(source, String(req.query.id ?? ''), req.query.loader ? String(req.query.loader) : undefined, {
      software,
      mcVersion: profile.mcVersion ?? detected.detectedVersion,
    }));
  }));
  app.post('/api/plugins/preview', asyncRoute(async (req, res) => {
    res.json(await previewPlugin(active(), req.body.source, String(req.body.projectId), String(req.body.versionId)));
  }));
  app.post('/api/plugins/install', asyncRoute(async (req, res) => {
    if (req.body?.confirm !== true) throw new HttpError(400, 'Confirm the plugin installation', 'CONFIRM');
    const profile = active();
    res.json(await installFromRepository(db, profile, req.body.source, String(req.body.projectId), String(req.body.versionId), Boolean(req.body.includeDependencies), backupDir()));
  }));
  app.get('/api/plugins/installed', asyncRoute(async (_req, res) => res.json({ plugins: await listInstalled(db, active()) })));
  app.post('/api/plugins/upload', jarUpload.single('file'), asyncRoute(async (req, res) => {
    if (!req.file) throw new HttpError(400, 'Choose a JAR file', 'NO_FILE');
    try {
      const file = await installUpload(db, active(), req.file.path, req.file.originalname, {
        name: req.body?.name,
        version: req.body?.version,
        sourceUrl: req.body?.sourceUrl,
        minecraftVersion: req.body?.minecraftVersion,
        software: req.body?.software,
        notes: req.body?.notes,
      }, req.body?.replace === 'true' || req.body?.replace === true, req.body?.acknowledge === 'true' || req.body?.acknowledge === true, backupDir());
      res.json({ file, restartRequired: true });
    } finally {
      await fs.promises.rm(req.file.path, { force: true }).catch(() => undefined);
    }
  }));
  app.post('/api/plugins/uninstall', asyncRoute(async (req, res) => {
    if (req.body?.confirm !== true) throw new HttpError(400, 'Confirm plugin removal', 'CONFIRM');
    await uninstallPlugin(db, active(), String(req.body.file), req.body.keepConfig !== false, backupDir());
    res.json({ ok: true, restartRequired: true });
  }));
  app.post('/api/plugins/toggle', asyncRoute(async (req, res) => {
    const file = await togglePlugin(active(), String(req.body.file), Boolean(req.body.enable));
    res.json({ file, restartRequired: true });
  }));
  app.post('/api/plugins/open', asyncRoute(async (req, res) => {
    const profile = active();
    revealPath(profile.directory, String(req.body.path ?? profile.pluginContainer));
    res.json({ ok: true });
  }));
  app.get('/api/plugins/errors', asyncRoute(async (req, res) => res.json({ lines: await pluginErrors(active(), String(req.query.name ?? '')) })));
  app.post('/api/plugins/updates', asyncRoute(async (_req, res) => res.json({ updates: await checkUpdates(db, active()) })));

  app.get('/api/players', asyncRoute(async (_req, res) => res.json({ players: await listPlayers(db, proc, active()) })));
  app.post('/api/players/kick', asyncRoute(async (req, res) => {
    if (req.body?.confirm !== true) throw new HttpError(400, 'Confirm the kick', 'CONFIRM');
    await kick(proc, active(), String(req.body.name), String(req.body.reason));
    res.json({ ok: true });
  }));
  app.post('/api/players/ban', asyncRoute(async (req, res) => {
    if (req.body?.confirm !== true) throw new HttpError(400, 'Confirm the ban', 'CONFIRM');
    const profile = active();
    await ban(db, proc, profile, String(req.body.name), String(req.body.reason), historyDir(profile.id));
    res.json({ ok: true });
  }));
  app.post('/api/players/tempban', asyncRoute(async (req, res) => {
    if (req.body?.confirm !== true) throw new HttpError(400, 'Confirm the temporary ban', 'CONFIRM');
    const profile = active();
    const expiresAt = await tempBan(db, proc, profile, String(req.body.name), String(req.body.reason), Number(req.body.value), String(req.body.unit), historyDir(profile.id));
    res.json({ expiresAt });
  }));
  app.post('/api/players/pardon', asyncRoute(async (req, res) => {
    if (req.body?.confirm !== true) throw new HttpError(400, 'Confirm the pardon', 'CONFIRM');
    const profile = active();
    await pardon(db, proc, profile, String(req.body.name), historyDir(profile.id));
    res.json({ ok: true });
  }));
  app.post('/api/players/tp', asyncRoute(async (req, res) => {
    await teleport(proc, active(), String(req.body.name), String(req.body.target));
    res.json({ ok: true });
  }));
  app.post('/api/players/msg', asyncRoute(async (req, res) => {
    await message(proc, active(), String(req.body.name), String(req.body.message));
    res.json({ ok: true });
  }));
  app.get('/api/access', asyncRoute(async (_req, res) => res.json(await readAccess(active(), db))));
  app.post('/api/access/whitelist', asyncRoute(async (req, res) => {
    const profile = active();
    await whitelistAdd(proc, profile, String(req.body.name), historyDir(profile.id));
    res.json(await readAccess(profile, db));
  }));
  app.delete('/api/access/whitelist', asyncRoute(async (req, res) => {
    const profile = active();
    await whitelistRemove(proc, profile, String(req.body.name), historyDir(profile.id));
    res.json(await readAccess(profile, db));
  }));
  app.post('/api/access/op', asyncRoute(async (req, res) => {
    if (req.body?.confirm !== true) throw new HttpError(400, 'Confirm operator access', 'CONFIRM');
    const profile = active();
    await op(proc, profile, String(req.body.name), historyDir(profile.id));
    res.json(await readAccess(profile, db));
  }));
  app.delete('/api/access/op', asyncRoute(async (req, res) => {
    if (req.body?.confirm !== true) throw new HttpError(400, 'Confirm removing operator access', 'CONFIRM');
    const profile = active();
    await deop(proc, profile, String(req.body.name), historyDir(profile.id));
    res.json(await readAccess(profile, db));
  }));

  app.get('/api/config', asyncRoute(async (_req, res) => res.json({ files: await listConfigFiles(active()) })));
  app.get('/api/config/properties', asyncRoute(async (_req, res) => res.json(await readPropertiesForm(active()))));
  app.put('/api/config/properties', asyncRoute(async (req, res) => {
    const profile = active();
    const current = await readTextFile(profile.directory, 'server.properties');
    if (current.hash !== req.body?.hash) throw new HttpError(409, 'server.properties changed. Reload it before saving.', 'CONFLICT');
    const content = applyPropertyForm(current.content, req.body?.values ?? {});
    res.json(await saveConfig(profile, 'server.properties', content, current.hash, historyDir(profile.id)));
  }));
  app.get('/api/config/file', asyncRoute(async (req, res) => res.json(await readTextFile(active().directory, String(req.query.path ?? '')))));
  app.put('/api/config/file', asyncRoute(async (req, res) => {
    const profile = active();
    res.json(await saveConfig(profile, String(req.body.path), String(req.body.content ?? ''), String(req.body.hash ?? ''), historyDir(profile.id)));
  }));
  app.post('/api/config/revert', asyncRoute(async (req, res) => {
    const profile = active();
    res.json(await revertConfig(profile, String(req.body.path), historyDir(profile.id)));
  }));

  app.get('/api/worlds', asyncRoute(async (_req, res) => {
    const profile = active();
    res.json({ worlds: await listWorlds(profile), levelName: readServerProperty(profile, 'level-name') });
  }));
  app.get('/api/worlds/export', asyncRoute(async (req, res) => {
    const profile = active();
    const name = String(req.query.name ?? '');
    const tmp = path.join(services.dataDir, 'tmp', `${name}-${Date.now()}.zip`);
    await exportWorld(profile, name, tmp);
    res.download(tmp, `${name}.zip`, () => fs.rmSync(tmp, { force: true }));
  }));
  app.post('/api/worlds/backup', asyncRoute(async (req, res) => {
    const profile = active();
    const name = String(req.body.name ?? '');
    const id = newId();
    const file = path.join(backupDir(), profile.id, `world-${name}-${id}.zip`);
    await exportWorld(profile, name, file);
    const stat = await fs.promises.stat(file);
    db.insertBackup({ id, profileId: profile.id, kind: 'world', label: name, size: stat.size, status: 'running', consistent: false, createdAt: Date.now(), error: null, contents: [name] });
    db.setBackupFile(id, file, stat.size, [name], proc.snapshot(profile.id).status !== 'online');
    res.status(201).json(db.getBackup(id));
  }));
  app.post('/api/worlds/delete', asyncRoute(async (req, res) => {
    const profile = active();
    await deleteWorld(db, proc, profile, String(req.body.name), String(req.body.confirmName), backupDir());
    res.json({ ok: true });
  }));

  app.get('/api/backups', asyncRoute(async (_req, res) => res.json({ backups: db.listBackups(active().id), directory: backupDir() })));
  app.post('/api/backups', asyncRoute(async (req, res) => {
    const profile = active();
    const kind = ['worlds', 'plugins', 'config'].includes(req.body?.kind) ? req.body.kind : 'full';
    const backup = await createBackup(db, proc, profile, backupDir(), kind, req.body?.label ? String(req.body.label) : null, db.getSettings().excludeLogs);
    pruneBackups(db, profile.id, db.getSettings().backupRetention);
    res.status(201).json(backup);
  }));
  app.post('/api/backups/:id/restore', asyncRoute(async (req, res) => {
    if (req.body?.confirm !== true) throw new HttpError(400, 'Confirm the restore', 'CONFIRM');
    const profile = active();
    const backup = db.getBackup(req.params.id);
    const file = db.getBackupPath(req.params.id);
    if (!backup || !file || backup.profileId !== profile.id) throw new HttpError(404, 'Backup not found', 'NOT_FOUND');
    await restoreBackup(db, proc, profile, backup, file, Array.isArray(req.body.components) ? req.body.components.map(String) : [], backupDir(), db.getSettings().excludeLogs);
    res.json({ ok: true });
  }));
  app.delete('/api/backups/:id', asyncRoute(async (req, res) => {
    if (req.body?.confirm !== true) throw new HttpError(400, 'Confirm backup deletion', 'CONFIRM');
    const profile = active();
    const backup = db.getBackup(req.params.id);
    if (!backup || backup.profileId !== profile.id) throw new HttpError(404, 'Backup not found', 'NOT_FOUND');
    const file = db.getBackupPath(req.params.id);
    if (file) await fs.promises.rm(file, { force: true });
    db.deleteBackupRow(req.params.id);
    res.json({ ok: true });
  }));
  app.get('/api/backups/:id/download', asyncRoute(async (req, res) => {
    const profile = active();
    const backup = db.getBackup(req.params.id);
    const file = db.getBackupPath(req.params.id);
    if (!backup || !file || backup.profileId !== profile.id) throw new HttpError(404, 'Backup not found', 'NOT_FOUND');
    res.download(file, path.basename(file));
  }));
  app.post('/api/backups/import', upload.single('file'), asyncRoute(async (req, res) => {
    if (!req.file) throw new HttpError(400, 'Choose a zip archive', 'NO_FILE');
    const profile = active();
    const header = Buffer.alloc(2);
    const handle = await fs.promises.open(req.file.path, 'r');
    await handle.read(header, 0, 2, 0);
    await handle.close();
    if (header[0] !== 0x50 || header[1] !== 0x4b) throw new HttpError(400, 'The upload is not a zip archive', 'NOT_ZIP');
    const id = newId();
    const dest = path.join(backupDir(), profile.id, `import-${id}.zip`);
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    await fs.promises.rename(req.file.path, dest).catch(async () => {
      await fs.promises.copyFile(req.file!.path, dest);
      await fs.promises.rm(req.file!.path, { force: true });
    });
    const stat = await fs.promises.stat(dest);
    db.insertBackup({ id, profileId: profile.id, kind: 'imported', label: req.file.originalname, size: stat.size, status: 'running', consistent: false, createdAt: Date.now(), error: null, contents: [] });
    db.setBackupFile(id, dest, stat.size, [], false);
    res.status(201).json(db.getBackup(id));
  }));
  app.post('/api/backups/scan', asyncRoute(async (_req, res) => res.json({ added: await registerLooseArchives(db, active(), backupDir()) })));

  app.get('/api/files', asyncRoute(async (req, res) => res.json(await listDirectory(active().directory, String(req.query.path ?? '')))));
  app.get('/api/files/read', asyncRoute(async (req, res) => res.json(await readTextFile(active().directory, String(req.query.path ?? '')))));
  app.put('/api/files/write', asyncRoute(async (req, res) => {
    const profile = active();
    res.json(await writeTextFile(profile.directory, String(req.body.path), String(req.body.content ?? ''), String(req.body.hash ?? ''), historyDir(profile.id)));
  }));
  app.post('/api/files/mkdir', asyncRoute(async (req, res) => {
    await makeDirectory(active().directory, String(req.body.path));
    res.json({ ok: true });
  }));
  app.post('/api/files/rename', asyncRoute(async (req, res) => {
    await renamePath(active().directory, String(req.body.from), String(req.body.to));
    res.json({ ok: true });
  }));
  app.delete('/api/files', asyncRoute(async (req, res) => {
    if (req.body?.confirm !== true) throw new HttpError(400, 'Confirm deletion', 'CONFIRM');
    await removePath(active().directory, String(req.body.path), Boolean(req.body.confirmCritical));
    res.json({ ok: true });
  }));
  app.post('/api/files/upload', upload.single('file'), asyncRoute(async (req, res) => {
    if (!req.file) throw new HttpError(400, 'Choose a file', 'NO_FILE');
    try {
      const saved = await saveUpload(active().directory, String(req.body.directory ?? ''), req.file.originalname, req.file.path, req.body.replace === 'true' || req.body.replace === true);
      res.json({ path: saved });
    } catch (error) {
      await fs.promises.rm(req.file.path, { force: true }).catch(() => undefined);
      throw error;
    }
  }));
  app.get('/api/files/download', asyncRoute(async (req, res) => {
    const file = resolveDownload(active().directory, String(req.query.path ?? ''));
    res.download(file, path.basename(file));
  }));
  app.get('/api/files/search', asyncRoute(async (req, res) => res.json({ results: await searchFiles(active().directory, String(req.query.q ?? '')) })));
  app.post('/api/files/reveal', asyncRoute(async (req, res) => {
    revealPath(active().directory, String(req.body.path ?? ''));
    res.json({ ok: true });
  }));

  app.get('/api/tasks', asyncRoute(async (_req, res) => res.json({ tasks: db.listTasks(active().id) })));
  app.post('/api/tasks', asyncRoute(async (req, res) => {
    const profile = active();
    const task = createTask(db, {
      profileId: profile.id,
      name: String(req.body.name ?? '').slice(0, 80) || 'Task',
      type: req.body.type,
      enabled: req.body.enabled !== false,
      schedule: assertSchedule(req.body.schedule as ScheduleSpec),
      payload: {
        command: req.body.payload?.command ? String(req.body.payload.command) : undefined,
        countdownSeconds: Number(req.body.payload?.countdownSeconds ?? 0),
        kind: req.body.payload?.kind ? String(req.body.payload.kind) : 'full',
      },
    });
    res.status(201).json(task);
  }));
  app.patch('/api/tasks/:id', asyncRoute(async (req, res) => {
    const current = db.getTask(req.params.id);
    if (!current || current.profileId !== active().id) throw new HttpError(404, 'Task not found', 'NOT_FOUND');
    const schedule = req.body.schedule ? assertSchedule(req.body.schedule) : current.schedule;
    const enabled = req.body.enabled === undefined ? current.enabled : Boolean(req.body.enabled);
    const task = {
      ...current,
      name: req.body.name ? String(req.body.name).slice(0, 80) : current.name,
      enabled,
      schedule,
      payload: req.body.payload ? { ...current.payload, ...req.body.payload } : current.payload,
      nextRun: enabled ? computeNextRun(schedule) : null,
    };
    db.saveTask(task);
    res.json(task);
  }));
  app.delete('/api/tasks/:id', asyncRoute(async (req, res) => {
    const current = db.getTask(req.params.id);
    if (!current || current.profileId !== active().id) throw new HttpError(404, 'Task not found', 'NOT_FOUND');
    db.deleteTask(req.params.id);
    res.json({ ok: true });
  }));

  app.get('/api/monitoring', asyncRoute(async (req, res) => {
    const profile = active();
    const hours = req.query.range === '24h' ? 24 : req.query.range === '1h' ? 1 : 6;
    res.json({
      points: db.metricsSince(profile.id, Date.now() - hours * 60 * 60 * 1000),
      events: db.listEvents(profile.id, 40).filter((event) => ['crash', 'start', 'stop', 'backup', 'restore'].includes(event.type)),
    });
  }));
  app.get('/api/diagnostics', asyncRoute(async (_req, res) => {
    const id = db.getSettings().activeProfileId;
    res.json({ checks: await runDiagnostics(id ? db.getProfile(id) : null, backupDir(), services.dataDir) });
  }));
  app.get('/api/settings', asyncRoute(async (_req, res) => res.json(publicSettings(db, services.dataDir))));
  app.put('/api/settings', asyncRoute(async (req, res) => {
    const current = db.getSettings();
    const next = sanitizeSettings(current, req.body ?? {}, services.dataDir);
    if (!isLoopbackHost(String(req.body.host ?? '127.0.0.1')) && next.allowRemote && req.body.confirmRemote !== true) {
      throw new HttpError(400, 'Confirm that you want the panel reachable beyond this PC', 'CONFIRM');
    }
    db.saveSettings(next);
    writeRuntimeFile(services.dataDir, {
      host: String(req.body.host ?? '127.0.0.1'),
      port: clampPort(req.body.port),
    });
    res.json({ settings: publicSettings(db, services.dataDir), restartRequired: true });
  }));
  app.use(errorHandler);
}

function setSession(res: Response, token: string, csrf: string): void {
  res.setHeader('Set-Cookie', [
    serializeCookie('mv_session', token, { httpOnly: true, maxAge: MAX_AGE }),
    serializeCookie('mv_csrf', csrf, { maxAge: MAX_AGE }),
  ]);
}

function publicSettings(db: AppDb, dataDir: string): SettingsPublic {
  const settings = db.getSettings();
  const runtime = readRuntime(dataDir);
  return {
    ...settings,
    backupDir: settings.backupDir || path.join(dataDir, 'backups'),
    webhookConfigured: Boolean(settings.discordWebhook),
    host: runtime.host,
    port: runtime.port,
    bindHost: process.env.HOST || runtime.host,
    bindPort: Number(process.env.PORT || runtime.port),
  };
}

function sanitizeSettings(current: AppSettings, body: Record<string, unknown>, dataDir: string): AppSettings {
  const backup = body.backupDir ? path.resolve(String(body.backupDir)) : current.backupDir;
  if (backup && path.parse(backup).root === backup) throw new HttpError(400, 'Backup folder cannot be a drive root', 'BAD_BACKUP_DIR');
  return {
    ...current,
    theme: body.theme === 'light' ? 'light' : body.theme === 'dark' ? 'dark' : current.theme,
    accent: ['grass', 'emerald', 'copper', 'amethyst'].includes(String(body.accent)) ? body.accent as AppSettings['accent'] : current.accent,
    consoleBuffer: clampNumber(body.consoleBuffer, 100, 5000, current.consoleBuffer),
    backupDir: backup,
    backupRetention: clampNumber(body.backupRetention, 1, 100, current.backupRetention),
    excludeLogs: body.excludeLogs === undefined ? current.excludeLogs : Boolean(body.excludeLogs),
    discordWebhook: body.discordWebhook === undefined ? current.discordWebhook : assertDiscordWebhook(String(body.discordWebhook ?? '')),
    allowRemote: body.allowRemote === undefined ? current.allowRemote : Boolean(body.allowRemote),
    logRetentionDays: clampNumber(body.logRetentionDays, 1, 90, current.logRetentionDays),
    cpuWarnPercent: clampNumber(body.cpuWarnPercent, 50, 100, current.cpuWarnPercent),
    ramWarnPercent: clampNumber(body.ramWarnPercent, 50, 100, current.ramWarnPercent),
    diskWarnPercent: clampNumber(body.diskWarnPercent, 50, 100, current.diskWarnPercent),
    modrinthEnabled: body.modrinthEnabled === undefined ? current.modrinthEnabled : Boolean(body.modrinthEnabled),
    hangarEnabled: body.hangarEnabled === undefined ? current.hangarEnabled : Boolean(body.hangarEnabled),
    spigetEnabled: body.spigetEnabled === undefined ? current.spigetEnabled : Boolean(body.spigetEnabled),
    activeProfileId: current.activeProfileId,
  };
  void dataDir;
}

function readRuntime(dataDir: string): { host: string; port: number } {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, 'runtime.json'), 'utf8')) as { host: string; port: number };
  } catch {
    return { host: '127.0.0.1', port: 3847 };
  }
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function clampPort(value: unknown): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 65535) return 3847;
  return number;
}
