import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { AppDb } from './db.ts';
import { loadDotEnv, resolveBind, resolveDataDir } from './env.ts';
import { errorHandler } from './http.ts';
import { initLogger, log } from './logger.ts';
import { mountApi } from './routes.ts';
import { notifyDiscord } from './services/notify.ts';
import { ProcessManager } from './services/processManager.ts';
import { TaskScheduler } from './services/scheduler.ts';
import { attachWebsocket } from './ws.ts';

export interface RunningServer {
  url: string;
  port: number;
  dataDir: string;
  db: AppDb;
  proc: ProcessManager;
  close: () => Promise<void>;
}

export async function startServer(options: { dataDir?: string; host?: string; port?: number; scheduler?: boolean; metrics?: boolean } = {}): Promise<RunningServer> {
  if (!options.dataDir) loadDotEnv();
  const dataDir = options.dataDir ?? resolveDataDir();
  initLogger(dataDir);
  const db = new AppDb(dataDir);
  const created = db.ensurePassword(process.env.MINEVIEW_INITIAL_PASSWORD);
  if (created.created && created.password) {
    fs.writeFileSync(
      path.join(dataDir, 'initial-password.txt'),
      `Mineview initial password\n\n${created.password}\n\nSign in, then change this password in Settings. This file is deleted when the password changes.\n`,
      { encoding: 'utf8' },
    );
    log('info', 'Initial password written to initial-password.txt in the data folder');
  }
  const bind = resolveBind(dataDir, db.getSettings().allowRemote, { host: options.host, port: options.port });
  const proc = new ProcessManager({
    db,
    dataDir,
    onLifecycle: (profileId, event, message) => {
      const profile = db.getProfile(profileId);
      const webhook = db.getSettings().discordWebhook;
      if (profile && webhook) void notifyDiscord(webhook, `Mineview ${event} for ${profile.name}: ${message}`);
    },
  });
  const scheduler = new TaskScheduler(
    db,
    proc,
    () => db.getSettings().backupDir || path.join(dataDir, 'backups'),
    (profileId) => path.join(dataDir, 'config-history', profileId),
  );
  if (options.scheduler !== false) scheduler.start();

  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });
  app.use(express.json({ limit: '2mb' }));
  mountApi(app, { db, dataDir, proc, scheduler });
  const dist = path.resolve('client/dist');
  if (fs.existsSync(path.join(dist, 'index.html'))) {
    app.use(express.static(dist));
    app.use((req, res, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/api')) return next();
      res.sendFile(path.join(dist, 'index.html'), (error) => {
        if (error) next();
      });
    });
  }
  app.use(errorHandler);

  const server = http.createServer(app);
  server.requestTimeout = 30 * 60 * 1000;
  let boundPort = bind.port;
  attachWebsocket(server, db, proc, () => boundPort);
  let metrics: NodeJS.Timeout | null = null;
  if (options.metrics !== false) {
    metrics = setInterval(() => {
      for (const profile of db.listProfiles()) {
        void proc.sampleMetrics(profile).then(() => {
          const snap = proc.snapshot(profile.id);
          if (snap.status === 'online' || snap.status === 'starting') {
            db.addMetric(profile.id, {
              cpu: snap.cpuPercent,
              memoryBytes: snap.memoryBytes,
              players: snap.playersKnown ? snap.playerNames.length : null,
            });
            db.pruneMetrics(profile.id, Date.now() - db.getSettings().logRetentionDays * 86_400_000);
          }
        });
      }
    }, 15_000);
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(bind.port, bind.host, () => resolve());
  });
  const address = server.address();
  boundPort = typeof address === 'object' && address ? address.port : bind.port;
  const url = `http://${bind.host === '0.0.0.0' ? '127.0.0.1' : bind.host}:${boundPort}`;
  log('info', `Mineview listening on ${url}`);
  return {
    url,
    port: boundPort,
    dataDir,
    db,
    proc,
    close: async () => {
      scheduler.stop();
      if (metrics) clearInterval(metrics);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    },
  };
}
