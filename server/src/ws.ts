import type { Server } from 'node:http';
import { WebSocketServer } from 'ws';
import type { AppDb } from './db.ts';
import { readCookies } from './util/cookies.ts';
import { isAllowedOrigin } from './util/net.ts';
import { sanitizeConsoleCommand } from './util/command.ts';
import type { ProcessManager } from './services/processManager.ts';
import { log } from './logger.ts';

export function attachWebsocket(server: Server, db: AppDb, proc: ProcessManager, getPort: () => number): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('error', (error) => {
    log('error', 'WebSocket server error', error);
  });
  wss.on('connection', (socket, request) => {
    const settings = db.getSettings();
    if (!isAllowedOrigin(request.headers.origin, { port: getPort(), allowRemote: settings.allowRemote })) {
      socket.close(4003, 'origin');
      return;
    }
    const token = readCookies(request.headers.cookie).mv_session;
    if (!db.getSession(token)) {
      socket.close(4001, 'auth');
      return;
    }
    const profileId = settings.activeProfileId;
    if (!profileId) {
      socket.send(JSON.stringify({ type: 'error', error: 'No server profile is selected' }));
      socket.close();
      return;
    }
    const profile = db.getProfile(profileId);
    if (!profile) {
      socket.close();
      return;
    }
    const snap = proc.snapshot(profile.id);
    socket.send(JSON.stringify({ type: 'hello', status: snap.status, managed: snap.managed, lines: proc.lines(profile.id).slice(-500) }));
    const unsubscribe = proc.subscribe(profile.id, (line) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type: 'line', line }));
    });
    const unsubscribeStatus = proc.onStatus(profile.id, () => {
      const next = proc.snapshot(profile.id);
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type: 'status', status: next.status, managed: next.managed }));
    });
    socket.on('message', (data) => {
      try {
        const parsed = JSON.parse(String(data)) as { type?: string; command?: string };
        if (parsed.type === 'ping') {
          socket.send(JSON.stringify({ type: 'pong' }));
          return;
        }
        if (parsed.type !== 'command') return;
        const command = sanitizeConsoleCommand(parsed.command);
        proc.sendCommand(profile, command);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Command rejected';
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type: 'error', error: message }));
      }
    });
    socket.on('close', () => {
      unsubscribe();
      unsubscribeStatus();
    });
    socket.on('error', (error) => log('warn', 'WebSocket error', error));
  });
  return wss;
}
