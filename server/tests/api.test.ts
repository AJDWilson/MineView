import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startServer } from '../src/app.ts';

const password = 'test-password-123';

async function fixture() {
  process.env.MINEVIEW_INITIAL_PASSWORD = password;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-api-'));
  const serverDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mv-server-')));
  fs.writeFileSync(path.join(serverDir, 'server.properties'), 'server-port=25565\nmotd=Hello\nmax-players=10\ndifficulty=easy\nlevel-name=world\n');
  fs.writeFileSync(path.join(serverDir, 'eula.txt'), 'eula=false\n');
  fs.writeFileSync(path.join(serverDir, 'paper.jar'), 'not-a-real-jar');
  fs.mkdirSync(path.join(serverDir, 'plugins'));
  fs.mkdirSync(path.join(serverDir, 'world'));
  fs.writeFileSync(path.join(serverDir, 'world', 'level.dat'), 'level');
  const running = await startServer({ dataDir, host: '127.0.0.1', port: 0, scheduler: false, metrics: false });
  let cookie = '';
  let csrf = '';
  const api = async (urlPath: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (cookie) headers.set('cookie', cookie);
    if (init.method && init.method !== 'GET') headers.set('x-csrf-token', csrf);
    if (init.body && !(init.body instanceof FormData) && !headers.has('content-type')) headers.set('content-type', 'application/json');
    const response = await fetch(`${running.url}${urlPath}`, { ...init, headers });
    const text = await response.text();
    return { status: response.status, data: text ? JSON.parse(text) as Record<string, unknown> : {} };
  };
  const login = await fetch(`${running.url}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  cookie = (login.headers.getSetCookie?.() ?? []).map((entry) => entry.split(';')[0]).join('; ');
  csrf = ((await login.json()) as { csrf: string }).csrf;
  return { running, api, serverDir, dataDir };
}

test('api auth, profile setup, file confinement, config, and backup', async () => {
  const { running, api, serverDir, dataDir } = await fixture();
  try {
    assert.equal((await fetch(`${running.url}/api/server/status`)).status, 401);
    const bad = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ password: 'nope' }) });
    assert.equal((await fetch(`${running.url}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'wrong-password' }) })).status, 401);
    void bad;
    const created = await api('/api/profiles', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Local',
        directory: serverDir,
        jarFile: 'paper.jar',
        javaPath: null,
        minMemory: '1G',
        maxMemory: '2G',
        jvmArgs: '',
        serverArgs: '',
        launchMode: 'jar',
      }),
    });
    assert.equal(created.status, 201);
    const escaped = await api('/api/files/read?path=' + encodeURIComponent('../outside.txt'));
    assert.equal(escaped.status, 400);
    const properties = await api('/api/config/properties');
    assert.equal(properties.status, 200);
    const saved = await api('/api/config/properties', {
      method: 'PUT',
      body: JSON.stringify({ hash: (properties.data as { hash: string }).hash, values: { motd: 'Updated', 'server-port': '25566' } }),
    });
    assert.equal(saved.status, 200);
    assert.match(fs.readFileSync(path.join(serverDir, 'server.properties'), 'utf8'), /motd=Updated/);
    assert.match(fs.readFileSync(path.join(serverDir, 'server.properties'), 'utf8'), /server-port=25566/);
    const conflict = await api('/api/config/properties', {
      method: 'PUT',
      body: JSON.stringify({ hash: (properties.data as { hash: string }).hash, values: { motd: 'Again' } }),
    });
    assert.equal(conflict.status, 409);
    const worlds = await api('/api/worlds');
    assert.equal((worlds.data.worlds as { name: string }[])[0]?.name, 'world');
    const backup = await api('/api/backups', { method: 'POST', body: JSON.stringify({ kind: 'config', label: 'test' }) });
    assert.equal(backup.status, 201);
    assert.equal((backup.data as { status: string }).status, 'complete');
    const removed = await api('/api/files', { method: 'DELETE', body: JSON.stringify({ path: 'server.properties', confirm: true }) });
    assert.equal(removed.status, 400);
    const diagnostics = await api('/api/diagnostics');
    assert.ok(Array.isArray(diagnostics.data.checks));
    assert.equal(fs.readFileSync(path.join(serverDir, 'eula.txt'), 'utf8').includes('eula=false'), true);
  } finally {
    await running.close();
    fs.rmSync(serverDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
