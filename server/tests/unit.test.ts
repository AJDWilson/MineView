import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertSchedule, computeNextRun } from '../src/util/schedule.ts';
import { assertPlayerName, durationToMs, sanitizeConsoleCommand, sanitizeReason } from '../src/util/command.ts';
import { detectSoftware, versionFromFilename } from '../src/util/detect.ts';
import { javaRequirement, javaWarnings, parseJavaMajor } from '../src/util/javaCompat.ts';
import { classifyLine, interpretLine } from '../src/util/logparse.ts';
import { assertDownloadUrl, assertDiscordWebhook, isAllowedOrigin } from '../src/util/net.ts';
import { assertSafeServerDirectory, isDriveRoot, resolveWithinRoot, safeZipDestination, sanitizeFilename } from '../src/util/paths.ts';
import { getProperty, parseProperties, setProperty, stringifyProperties } from '../src/util/properties.ts';
import { splitArgs } from '../src/util/args.ts';
import { shouldSkipBackup } from '../src/services/backups.ts';
import { classifyRelease } from '../src/services/compatibility.ts';
import { serverBuildFromText } from '../src/util/detect.ts';
import { mapModrinthHit, modrinthSearchUrl, spigetSearchUrl } from '../src/services/repositories.ts';
import { HttpError } from '../src/util/errors.ts';

test('path confinement rejects traversal and drive roots', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-path-'));
  fs.writeFileSync(path.join(root, 'server.properties'), 'server-port=25565\n');
  assert.equal(path.basename(resolveWithinRoot(root, 'server.properties')), 'server.properties');
  assert.throws(() => resolveWithinRoot(root, '../outside.txt'), (error: unknown) => error instanceof HttpError && error.code === 'PATH_ESCAPE');
  assert.throws(() => resolveWithinRoot(root, 'C:\\Windows\\win.ini'), (error: unknown) => error instanceof HttpError);
  assert.equal(isDriveRoot('C:\\'), true);
  assert.throws(() => assertSafeServerDirectory('C:\\'), (error: unknown) => error instanceof HttpError);
  assert.throws(() => sanitizeFilename('../evil.jar'), (error: unknown) => error instanceof HttpError);
  assert.equal(sanitizeFilename('LuckPerms.jar'), 'LuckPerms.jar');
  assert.throws(() => safeZipDestination(root, '../evil.txt'), (error: unknown) => error instanceof HttpError && error.code === 'ZIP_SLIP');
  assert.equal(path.basename(safeZipDestination(root, 'world/level.dat')), 'level.dat');
  fs.rmSync(root, { recursive: true, force: true });
});

test('server.properties edits keep unrelated lines', () => {
  const original = '# comment\nserver-port=25565\nmotd=Hello\n';
  const lines = setProperty(parseProperties(original), 'motd', 'Mineview');
  const text = stringifyProperties(lines);
  assert.match(text, /# comment/);
  assert.equal(getProperty(lines, 'server-port'), '25565');
  assert.equal(getProperty(lines, 'motd'), 'Mineview');
  assert.match(text, /server-port=25565/);
});

test('commands and durations are validated', () => {
  assert.equal(sanitizeConsoleCommand('/say hi'), 'say hi');
  assert.throws(() => sanitizeConsoleCommand('say hi\nstop'));
  assert.equal(assertPlayerName('Steve'), 'Steve');
  assert.throws(() => assertPlayerName('bad name'));
  assert.equal(sanitizeReason(' griefing '), 'griefing');
  assert.equal(durationToMs(2, 'hours'), 7_200_000);
  assert.throws(() => durationToMs(0, 'days'));
  assert.deepEqual(splitArgs('-XX:+UseG1GC "-Dfoo=bar baz"'), ['-XX:+UseG1GC', '-Dfoo=bar baz']);
});

test('server software and java compatibility detection', () => {
  assert.equal(detectSoftware({ fileName: 'paper-1.21.1-123.jar', manifest: 'Implementation-Title: Paper\n' }).software, 'paper');
  assert.equal(detectSoftware({ fileName: 'purpur.jar' }).software, 'purpur');
  assert.equal(detectSoftware({ fileName: 'server.jar', manifest: 'Main-Class: net.minecraft.server.Main\n', versionJson: '{"id":"1.21.1"}' }).version, '1.21.1');
  assert.equal(versionFromFilename('forge-1.20.1-installer.jar'), '1.20.1');
  assert.equal(parseJavaMajor('java version "21.0.2" 2024-01-16'), 21);
  assert.equal(javaRequirement('1.21.1').min, 21);
  assert.equal(javaRequirement('1.16.5').min, 8);
  assert.ok(javaWarnings('1.21.1', 17).some((warning) => warning.includes('too old')));
  assert.equal(javaWarnings('1.21.1', 21).length, 0);
});

test('schedules, log lines, downloads, and backup filters', () => {
  const from = new Date(2026, 9, 24, 12, 0, 0).getTime();
  const next = computeNextRun(assertSchedule({ mode: 'daily', time: '04:00' }), from);
  assert.ok(next > from);
  assert.equal(interpretLine('[12:00:00] [Server thread/INFO]: Steve joined the game')?.type, 'join');
  assert.equal(interpretLine('[12:00:00] [Server thread/INFO]: <Steve> I joined the game'), null);
  assert.equal(classifyLine('java.lang.RuntimeException: failed', 'stdout'), 'error');
  assert.equal(assertDownloadUrl('https://cdn.modrinth.com/data/a/file.jar').hostname, 'cdn.modrinth.com');
  assert.throws(() => assertDownloadUrl('http://cdn.modrinth.com/file.jar'));
  assert.throws(() => assertDownloadUrl('https://evil.example/file.jar'));
  assert.throws(() => assertDiscordWebhook('https://127.0.0.1/api/webhooks/a/b'));
  assert.equal(isAllowedOrigin('http://127.0.0.1:5173', { port: 3847, allowRemote: false }), true);
  assert.equal(isAllowedOrigin('http://evil.example', { port: 3847, allowRemote: true }), false);
  assert.equal(shouldSkipBackup('logs/latest.log', true), true);
  assert.equal(shouldSkipBackup('world/session.lock', false), true);
  assert.equal(shouldSkipBackup('plugins/Example.jar', true), false);
  const hit = mapModrinthHit({ project_id: 'abc', slug: 'example', title: 'Example', description: 'A plugin', author: 'Ada', downloads: 10, categories: ['paper'], versions: ['1.21.1'], project_type: 'plugin' });
  assert.equal(hit.source, 'modrinth');
  assert.match(decodeURIComponent(modrinthSearchUrl({ source: 'modrinth', q: 'luck', sort: 'downloads', offset: 0, limit: 12, projectType: 'plugin', loader: 'paper' })), /project_type:plugin/);
  assert.match(spigetSearchUrl({ source: 'spiget', q: 'luck perms', sort: 'downloads', offset: 12, limit: 12, projectType: 'plugin' }), /search\/resources\/luck%20perms/);
  assert.equal(classifyRelease({ software: 'paper', mcVersion: '1.21.1' }, { loaders: ['paper'], gameVersions: ['1.21.1'] }).status, 'compatible');
  assert.equal(classifyRelease({ software: 'spigot', mcVersion: '1.21.1' }, { loaders: ['paper'], gameVersions: ['1.21.1'] }).status, 'incompatible');
  assert.equal(classifyRelease({ software: 'paper', mcVersion: '1.21.1' }, { loaders: ['spigot'], gameVersions: ['1.21.1'] }).status, 'possible');
  assert.equal(classifyRelease({ software: 'paper', mcVersion: '1.21.1' }, { loaders: ['paper'], gameVersions: [] }).status, 'unknown');
  assert.equal(classifyRelease({ software: 'paper', mcVersion: '1.21.4' }, { loaders: ['paper'], gameVersions: ['1.21'] }).status, 'possible');
  assert.equal(classifyRelease({ software: 'spigot', mcVersion: '1.21' }, { loaders: ['spigot'], gameVersions: ['1.21', '26.1'] }).status, 'compatible');
  const build = serverBuildFromText('This server is running Paper version git-Paper-196 (MC: 1.21.1)');
  assert.equal(build.software, 'paper');
  assert.equal(build.mcVersion, '1.21.1');
  assert.equal(build.build, 'git-Paper-196');
});
