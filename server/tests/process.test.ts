import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import type { ChildProcess } from 'node:child_process';
import type { Profile } from '../../shared/types.ts';
import { AppDb } from '../src/db.ts';
import { ProcessManager, type SpawnFn } from '../src/services/processManager.ts';
import { HttpError } from '../src/util/errors.ts';

function fakeProcess(): ChildProcess & { stdout: PassThrough; stderr: PassThrough; stdin: PassThrough } {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  const child = new EventEmitter() as ChildProcess & { stdout: PassThrough; stderr: PassThrough; stdin: PassThrough };
  child.stdout = stdout;
  child.stderr = stderr;
  child.stdin = stdin;
  Reflect.set(child, 'pid', 424242);
  child.kill = (() => true) as ChildProcess['kill'];
  return child;
}

function profile(directory: string, javaPath: string): Profile {
  return {
    id: 'profile-1',
    name: 'Test',
    directory,
    jarFile: 'paper.jar',
    javaPath,
    minMemory: '1G',
    maxMemory: '2G',
    jvmArgs: '',
    serverArgs: '',
    software: 'paper',
    mcVersion: '1.21.1',
    launchMode: 'jar',
    argFile: null,
    pluginContainer: 'plugins',
    autoRestart: false,
    autoRestartMax: 3,
    autoRestartCooldown: 30,
    restartDelay: 0,
    createdAt: 1,
    updatedAt: 1,
  };
}

test('process lifecycle uses the Minecraft console, not a shell', async () => {
  const javaPath = process.env.MINEVIEW_TEST_JAVA || 'C:\\Program Files\\Common Files\\Oracle\\Java\\javapath\\java.exe';
  if (!fs.existsSync(javaPath)) return;
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mv-proc-')));
  fs.writeFileSync(path.join(directory, 'paper.jar'), 'jar');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-data-'));
  const db = new AppDb(dataDir);
  let child = fakeProcess();
  const spawn: SpawnFn = (_command, args, options) => {
    assert.equal(options.shell, false);
    assert.ok(args.includes('-jar'));
    assert.ok(!args.some((arg) => arg.includes('&') || arg.includes('cmd.exe')));
    return child;
  };
  const manager = new ProcessManager({
    db,
    dataDir,
    spawn,
    listJava: async () => [],
    commandLine: async () => null,
    sample: async () => null,
    forceKill: async () => {
      child.emit('exit', 137, null);
    },
  });
  const server = profile(directory, javaPath);
  await manager.start(server);
  assert.equal(manager.snapshot(server.id).status, 'starting');
  child.stdout.write('Done (1.2s)! For help, type "help"\n');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.snapshot(server.id).status, 'online');
  await assert.rejects(() => manager.start(server), (error: unknown) => error instanceof HttpError && error.code === 'ALREADY_RUNNING');
  manager.sendCommand(server, 'say hello');
  await new Promise((resolve) => setImmediate(resolve));
  const written = child.stdin.read()?.toString() ?? '';
  assert.match(written, /say hello/);
  child.stdin.on('data', (chunk) => {
    if (String(chunk).includes('stop')) child.emit('exit', 0, null);
  });
  await manager.stop(server);
  assert.equal(manager.snapshot(server.id).status, 'offline');

  child = fakeProcess();
  await manager.start(server);
  child.emit('exit', 1, null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.snapshot(server.id).status, 'crashed');
  assert.equal(manager.snapshot(server.id).exitCode, 1);
  db.close();
  fs.rmSync(directory, { recursive: true, force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
});
