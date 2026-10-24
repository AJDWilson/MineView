import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { LogLine, ManagedState, Profile, ServerStatus } from '../../../shared/types.ts';
import type { AppDb } from '../db.ts';
import { HttpError } from '../util/errors.ts';
import { assertJvmArgs, assertMemory, splitArgs } from '../util/args.ts';
import { sanitizeConsoleCommand } from '../util/command.ts';
import { classifyLine, interpretLine, stripAnsi } from '../util/logparse.ts';
import { assertInside, assertJavaExecutable } from '../util/paths.ts';
import { followFile } from './logfollow.ts';
import { commandLineForPid, listJavaProcesses, pidAlive, sampleProcess, taskkill } from './procinfo.ts';

export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

interface Runtime {
  profileId: string;
  status: ServerStatus;
  managed: ManagedState;
  child: ChildProcess | null;
  pid: number | null;
  startedAt: number | null;
  exitCode: number | null;
  lastError: string | null;
  lines: LogLine[];
  seq: number;
  intentionalStop: boolean;
  restarting: boolean;
  crashRestarts: number;
  onlineSince: number | null;
  playersKnown: boolean;
  online: Map<string, { since: number; uuid?: string }>;
  queue: Promise<void>;
  stdoutPending: string;
  stderrPending: string;
  listeners: Set<(line: LogLine) => void>;
  statusListeners: Set<() => void>;
  follower: { stop: () => void } | null;
  onlineTimer: NodeJS.Timeout | null;
  commandTimes: number[];
  saveWaiters: Array<(saved: boolean) => void>;
  exitWaiters: Array<() => void>;
  cpuSample: { at: number; cpuSeconds: number } | null;
  cpuPercent: number | null;
  memoryBytes: number | null;
  externalCheckedAt: number;
  launchMarker: string | null;
}

export interface ProcessDeps {
  db: AppDb;
  dataDir: string;
  spawn?: SpawnFn;
  commandLine?: (pid: number) => Promise<string | null>;
  listJava?: () => Promise<{ pid: number; commandLine: string }[]>;
  sample?: (pid: number) => Promise<{ cpuSeconds: number; rss: number } | null>;
  forceKill?: (pid: number) => Promise<void>;
  now?: () => number;
  onLifecycle?: (profileId: string, event: 'start' | 'stop' | 'crash', message: string) => void;
}

export class ProcessManager {
  private readonly runtimes = new Map<string, Runtime>();
  private readonly spawnFn: SpawnFn;
  private readonly commandLine: (pid: number) => Promise<string | null>;
  private readonly listJava: () => Promise<{ pid: number; commandLine: string }[]>;
  private readonly sample: (pid: number) => Promise<{ cpuSeconds: number; rss: number } | null>;
  private readonly forceKill: (pid: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly deps: ProcessDeps) {
    this.spawnFn = deps.spawn ?? nodeSpawn;
    this.commandLine = deps.commandLine ?? commandLineForPid;
    this.listJava = deps.listJava ?? listJavaProcesses;
    this.sample = deps.sample ?? sampleProcess;
    this.forceKill = deps.forceKill ?? taskkill;
    this.now = deps.now ?? Date.now;
  }

  runtime(profileId: string): Runtime {
    let runtime = this.runtimes.get(profileId);
    if (!runtime) {
      runtime = {
        profileId,
        status: 'offline',
        managed: 'none',
        child: null,
        pid: null,
        startedAt: null,
        exitCode: null,
        lastError: null,
        lines: [],
        seq: 0,
        intentionalStop: false,
        restarting: false,
        crashRestarts: 0,
        onlineSince: null,
        playersKnown: false,
        online: new Map(),
        queue: Promise.resolve(),
        stdoutPending: '',
        stderrPending: '',
        listeners: new Set(),
        statusListeners: new Set(),
        follower: null,
        onlineTimer: null,
        commandTimes: [],
        saveWaiters: [],
        exitWaiters: [],
        cpuSample: null,
        cpuPercent: null,
        memoryBytes: null,
        externalCheckedAt: 0,
        launchMarker: null,
      };
      this.runtimes.set(profileId, runtime);
    }
    return runtime;
  }

  subscribe(profileId: string, listener: (line: LogLine) => void): () => void {
    const runtime = this.runtime(profileId);
    runtime.listeners.add(listener);
    return () => runtime.listeners.delete(listener);
  }

  onStatus(profileId: string, listener: () => void): () => void {
    const runtime = this.runtime(profileId);
    runtime.statusListeners.add(listener);
    return () => runtime.statusListeners.delete(listener);
  }

  lines(profileId: string): LogLine[] {
    return this.runtime(profileId).lines;
  }

  snapshot(profileId: string): Pick<Runtime, 'status' | 'managed' | 'pid' | 'startedAt' | 'exitCode' | 'lastError' | 'playersKnown' | 'cpuPercent' | 'memoryBytes'> & {
    playerNames: string[];
    playerSessions: Map<string, { since: number; uuid?: string }>;
  } {
    const runtime = this.runtime(profileId);
    return {
      status: runtime.status,
      managed: runtime.managed,
      pid: runtime.pid,
      startedAt: runtime.startedAt,
      exitCode: runtime.exitCode,
      lastError: runtime.lastError,
      playersKnown: runtime.playersKnown,
      cpuPercent: runtime.cpuPercent,
      memoryBytes: runtime.memoryBytes,
      playerNames: [...runtime.online.keys()],
      playerSessions: runtime.online,
    };
  }

  async refreshExternal(profile: Profile): Promise<void> {
    const runtime = this.runtime(profile.id);
    if (runtime.child && runtime.pid && pidAlive(runtime.pid)) {
      runtime.managed = 'attached';
      return;
    }
    if (this.now() - runtime.externalCheckedAt < 8000) return;
    runtime.externalCheckedAt = this.now();
    const marker = markerFor(profile);
    const record = readPidFile(this.deps.dataDir, profile.id);
    if (record && pidAlive(record.pid)) {
      const command = await this.commandLine(record.pid);
      if (command && includesMarker(command, record.marker)) {
        this.adoptDetached(runtime, profile, record.pid, record.startedAt, record.marker);
        return;
      }
    }
    const processes = await this.listJava();
    const match = processes.find((proc) => marker && includesMarker(proc.commandLine, marker) && proc.pid !== runtime.pid);
    if (match && marker) {
      runtime.pid = match.pid;
      runtime.managed = 'external';
      runtime.status = 'online';
      runtime.launchMarker = marker;
      runtime.lastError = 'This server is running outside Mineview. Process controls stay disabled. The log can still be tailed.';
      this.followLog(runtime, profile);
      this.emitStatus(runtime);
      return;
    }
    if (!runtime.child && runtime.managed !== 'attached') {
      if (runtime.status === 'online' || runtime.status === 'starting' || runtime.status === 'stopping') {
        runtime.status = 'offline';
        runtime.managed = 'none';
        runtime.pid = null;
        this.stopFollow(runtime);
        this.emitStatus(runtime);
      }
    }
  }

  async sampleMetrics(profile: Profile): Promise<void> {
    const runtime = this.runtime(profile.id);
    if (!runtime.pid || runtime.status === 'offline' || runtime.status === 'crashed') return;
    const sample = await this.sample(runtime.pid);
    if (!sample) {
      runtime.cpuPercent = null;
      runtime.memoryBytes = null;
      return;
    }
    const now = this.now();
    if (runtime.cpuSample) {
      const cpuDelta = sample.cpuSeconds - runtime.cpuSample.cpuSeconds;
      const wall = (now - runtime.cpuSample.at) / 1000;
      if (wall > 0 && cpuDelta >= 0) {
        runtime.cpuPercent = Math.max(0, (cpuDelta / wall) * 100);
      }
    }
    runtime.cpuSample = { at: now, cpuSeconds: sample.cpuSeconds };
    runtime.memoryBytes = sample.rss;
  }

  start(profile: Profile): Promise<void> {
    return this.enqueue(this.runtime(profile.id), () => this.startNow(profile));
  }

  stop(profile: Profile): Promise<void> {
    return this.enqueue(this.runtime(profile.id), () => this.stopNow(profile));
  }

  restart(profile: Profile): Promise<void> {
    return this.enqueue(this.runtime(profile.id), async () => {
      const runtime = this.runtime(profile.id);
      if (runtime.managed !== 'attached' || (runtime.status !== 'online' && runtime.status !== 'starting')) {
        throw new HttpError(409, 'Restart is available when Mineview is attached to a running server', 'NOT_ATTACHED');
      }
      runtime.restarting = true;
      runtime.status = 'restarting';
      this.emitStatus(runtime);
      try {
        await this.stopNow(profile);
        await delay(Math.max(0, profile.restartDelay) * 1000);
        if (!runtime.restarting) return;
        runtime.restarting = false;
        await this.startNow(profile);
      } finally {
        runtime.restarting = false;
      }
    });
  }

  kill(profile: Profile): Promise<void> {
    return this.enqueue(this.runtime(profile.id), () => this.killNow(profile));
  }

  sendCommand(profile: Profile, command: string): void {
    const runtime = this.runtime(profile.id);
    if (runtime.managed !== 'attached' || !runtime.child?.stdin || (runtime.status !== 'online' && runtime.status !== 'starting' && runtime.status !== 'stopping')) {
      throw new HttpError(409, runtime.lastError || 'The Minecraft console is not attached. Start the server from Mineview to send commands.', 'NO_CONSOLE');
    }
    const cleaned = sanitizeConsoleCommand(command);
    const now = this.now();
    runtime.commandTimes = runtime.commandTimes.filter((stamp) => now - stamp < 10_000);
    if (runtime.commandTimes.length >= 30) throw new HttpError(429, 'Too many commands. Wait a few seconds.', 'RATE_LIMIT');
    runtime.commandTimes.push(now);
    runtime.child.stdin.write(`${cleaned}\n`);
    this.pushLine(runtime, 'system', `> ${cleaned}`);
  }

  requestSave(profile: Profile): Promise<boolean> {
    const runtime = this.runtime(profile.id);
    if (runtime.managed !== 'attached' || runtime.status !== 'online') return Promise.resolve(false);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        runtime.saveWaiters = runtime.saveWaiters.filter((waiter) => waiter !== finish);
        resolve(false);
      }, 20_000);
      const finish = (saved: boolean) => {
        clearTimeout(timer);
        resolve(saved);
      };
      runtime.saveWaiters.push(finish);
      try {
        this.sendCommand(profile, 'save-all flush');
      } catch {
        runtime.saveWaiters = runtime.saveWaiters.filter((waiter) => waiter !== finish);
        clearTimeout(timer);
        resolve(false);
      }
    });
  }

  private async startNow(profile: Profile): Promise<void> {
    const runtime = this.runtime(profile.id);
    const busy = ['starting', 'online', 'stopping', 'restarting'].includes(runtime.status);
    if (busy && (runtime.child || (runtime.pid != null && pidAlive(runtime.pid)))) {
      throw new HttpError(409, 'This server is already starting or running', 'ALREADY_RUNNING');
    }
    const marker = markerFor(profile);
    if (!marker) throw new HttpError(400, 'Choose a server JAR or Forge/NeoForge argument file before starting', 'NO_JAR');
    const external = (await this.listJava()).find((proc) => includesMarker(proc.commandLine, marker));
    if (external) {
      throw new HttpError(409, 'A Java process is already running this server. Mineview will not start a second copy.', 'EXTERNAL_RUNNING');
    }
    if (!profile.javaPath) throw new HttpError(400, 'Set the Java executable before starting the server', 'NO_JAVA');
    const java = assertJavaExecutable(profile.javaPath);
    const min = assertMemory(profile.minMemory);
    const max = assertMemory(profile.maxMemory);
    const jvm = assertJvmArgs(profile.jvmArgs);
    const serverArgs = splitArgs(profile.serverArgs);
    const args = [`-Xms${min}`, `-Xmx${max}`, ...jvm];
    if (profile.launchMode === 'argfile') {
      if (!profile.argFile) throw new HttpError(400, 'Forge/NeoForge argument file is missing', 'NO_JAR');
      const argFile = path.resolve(profile.directory, profile.argFile);
      assertInside(profile.directory, argFile);
      if (!fs.existsSync(argFile)) throw new HttpError(400, 'Argument file was not found', 'NO_JAR');
      args.push(`@${argFile}`);
    } else {
      if (!profile.jarFile) throw new HttpError(400, 'Server JAR is missing', 'NO_JAR');
      const jar = path.resolve(profile.directory, profile.jarFile);
      assertInside(profile.directory, jar);
      if (!fs.existsSync(jar)) throw new HttpError(400, 'Server JAR was not found', 'NO_JAR');
      args.push('-jar', jar);
    }
    args.push(...serverArgs);
    if (!args.includes('nogui')) args.push('nogui');
    this.stopFollow(runtime);
    runtime.intentionalStop = false;
    runtime.exitCode = null;
    runtime.lastError = null;
    runtime.playersKnown = false;
    runtime.online.clear();
    runtime.stdoutPending = '';
    runtime.stderrPending = '';
    runtime.status = 'starting';
    runtime.managed = 'attached';
    runtime.startedAt = this.now();
    runtime.onlineSince = null;
    runtime.launchMarker = marker;
    const child = this.spawnFn(java, args, {
      cwd: profile.directory,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform === 'win32',
    });
    runtime.child = child;
    runtime.pid = child.pid ?? null;
    if (runtime.pid) writePidFile(this.deps.dataDir, profile, runtime.pid, marker, runtime.startedAt);
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => this.pushChunk(runtime, profile, 'stdout', chunk));
    child.stderr?.on('data', (chunk: string) => this.pushChunk(runtime, profile, 'stderr', chunk));
    child.on('error', (error) => {
      runtime.lastError = 'The Java process could not be started.';
      runtime.status = 'crashed';
      this.pushLine(runtime, 'system', runtime.lastError);
      this.deps.db.addEvent(profile.id, 'crash', error.message);
      this.emitStatus(runtime);
    });
    child.on('exit', (code) => this.onExit(runtime, profile, code));
    this.pushLine(runtime, 'system', `Starting ${path.basename(profile.jarFile || profile.argFile || 'server')} with ${path.basename(java)}`);
    if (runtime.onlineTimer) clearTimeout(runtime.onlineTimer);
    runtime.onlineTimer = setTimeout(() => {
      if (runtime.status === 'starting') {
        runtime.status = 'online';
        runtime.onlineSince = this.now();
        this.pushLine(runtime, 'system', 'The process is still running. Startup completion was not detected, so Mineview is treating the server as online.');
        this.emitStatus(runtime);
      }
    }, 45_000);
    this.emitStatus(runtime);
  }

  private async stopNow(profile: Profile): Promise<void> {
    const runtime = this.runtime(profile.id);
    if (runtime.managed !== 'attached' || !runtime.child?.stdin) {
      throw new HttpError(409, 'Graceful stop needs a server Mineview started and is still attached to', 'NOT_ATTACHED');
    }
    if (runtime.status === 'offline' || runtime.status === 'crashed') {
      throw new HttpError(409, 'The server is not running', 'NOT_RUNNING');
    }
    runtime.intentionalStop = true;
    runtime.status = runtime.restarting ? 'restarting' : 'stopping';
    this.emitStatus(runtime);
    this.pushLine(runtime, 'system', 'Sending stop');
    const exited = new Promise<void>((resolve) => {
      const timer = setTimeout(() => resolve(), 120_000);
      runtime.exitWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    runtime.child.stdin.write('stop\n');
    await exited;
  }

  private async killNow(profile: Profile): Promise<void> {
    const runtime = this.runtime(profile.id);
    const pid = runtime.pid;
    if (!pid || runtime.status === 'offline') throw new HttpError(409, 'There is no Mineview-managed process to stop', 'NOT_RUNNING');
    if (runtime.managed === 'external') {
      throw new HttpError(409, 'Mineview will not terminate a server process it did not start', 'EXTERNAL_PROCESS');
    }
    const command = await this.commandLine(pid);
    const marker = runtime.launchMarker || markerFor(profile);
    if (command && marker && !includesMarker(command, marker)) {
      throw new HttpError(409, 'The recorded process no longer matches this server. It was not terminated.', 'PID_MISMATCH');
    }
    if (!command && runtime.managed !== 'attached') {
      throw new HttpError(409, 'The process command line could not be verified, so it was not terminated.', 'PID_UNVERIFIED');
    }
    runtime.intentionalStop = true;
    runtime.restarting = false;
    runtime.status = 'stopping';
    this.emitStatus(runtime);
    this.pushLine(runtime, 'system', 'Force-stopping the server process. World data may be corrupted.');
    await this.forceKill(pid);
    if (runtime.child && pidAlive(pid)) runtime.child.kill();
  }

  private onExit(runtime: Runtime, profile: Profile, code: number | null): void {
    if (runtime.onlineTimer) clearTimeout(runtime.onlineTimer);
    runtime.onlineTimer = null;
    runtime.child = null;
    runtime.exitCode = code;
    runtime.pid = null;
    runtime.cpuPercent = null;
    runtime.memoryBytes = null;
    clearPidFile(this.deps.dataDir, profile.id);
    const waiters = runtime.exitWaiters.splice(0);
    for (const waiter of waiters) waiter();
    for (const waiter of runtime.saveWaiters.splice(0)) waiter(false);
    if (runtime.restarting) {
      this.pushLine(runtime, 'system', `Server process exited with code ${code ?? 'unknown'}`);
      this.emitStatus(runtime);
      return;
    }
    runtime.online.clear();
    runtime.playersKnown = false;
    if (runtime.intentionalStop && (code === 0 || code === null)) {
      runtime.status = 'offline';
      runtime.managed = 'none';
      runtime.intentionalStop = false;
      this.pushLine(runtime, 'system', 'Server stopped');
      this.deps.db.addEvent(profile.id, 'stop', 'Server stopped');
      this.deps.onLifecycle?.(profile.id, 'stop', 'Server stopped');
    } else {
      runtime.status = 'crashed';
      runtime.managed = 'none';
      runtime.lastError = runtime.lastError || `Server exited with code ${code ?? 'unknown'}`;
      this.pushLine(runtime, 'system', runtime.lastError);
      this.deps.db.addEvent(profile.id, 'crash', runtime.lastError);
      this.deps.onLifecycle?.(profile.id, 'crash', runtime.lastError);
      if (profile.autoRestart && runtime.crashRestarts < profile.autoRestartMax) {
        runtime.crashRestarts += 1;
        const attempt = runtime.crashRestarts;
        this.pushLine(runtime, 'system', `Automatic restart ${attempt} of ${profile.autoRestartMax} in ${profile.autoRestartCooldown}s`);
        setTimeout(() => {
          if (runtime.status !== 'crashed') return;
          void this.start(profile).catch((error: unknown) => {
            runtime.lastError = error instanceof Error ? error.message : 'Automatic restart failed';
            this.pushLine(runtime, 'system', runtime.lastError);
          });
        }, Math.max(1, profile.autoRestartCooldown) * 1000);
      }
    }
    this.emitStatus(runtime);
  }

  private adoptDetached(runtime: Runtime, profile: Profile, pid: number, startedAt: number, marker: string): void {
    if (runtime.managed === 'attached' && runtime.child) return;
    runtime.pid = pid;
    runtime.startedAt = startedAt;
    runtime.managed = 'detached';
    runtime.status = 'online';
    runtime.launchMarker = marker;
    runtime.lastError = 'Mineview restarted and lost the console pipe. The log is being tailed. Graceful stop is unavailable; Kill verifies the recorded process and force-stops it.';
    this.followLog(runtime, profile);
    this.emitStatus(runtime);
  }

  private followLog(runtime: Runtime, profile: Profile): void {
    if (runtime.follower || runtime.managed === 'attached') return;
    const log = path.join(profile.directory, 'logs', 'latest.log');
    runtime.follower = followFile(log, (line) => this.consumeLine(runtime, profile, 'stdout', line));
  }

  private stopFollow(runtime: Runtime): void {
    runtime.follower?.stop();
    runtime.follower = null;
  }

  private pushChunk(runtime: Runtime, profile: Profile, stream: 'stdout' | 'stderr', chunk: string): void {
    const field = stream === 'stdout' ? 'stdoutPending' : 'stderrPending';
    runtime[field] += chunk;
    let index = runtime[field].indexOf('\n');
    while (index >= 0) {
      let line = runtime[field].slice(0, index);
      runtime[field] = runtime[field].slice(index + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      this.consumeLine(runtime, profile, stream, line);
      index = runtime[field].indexOf('\n');
    }
  }

  private consumeLine(runtime: Runtime, profile: Profile, stream: 'stdout' | 'stderr', raw: string): void {
    const text = stripAnsi(raw).slice(0, 4000);
    if (!text.trim()) return;
    this.pushLine(runtime, stream, text);
    const interpreted = interpretLine(text);
    if (!interpreted) return;
    if (interpreted.type === 'started' && runtime.status === 'starting') {
      runtime.status = 'online';
      runtime.onlineSince = this.now();
      if (runtime.onlineTimer) clearTimeout(runtime.onlineTimer);
      this.deps.db.addEvent(profile.id, 'start', 'Server finished starting');
      this.deps.onLifecycle?.(profile.id, 'start', 'Server finished starting');
      this.emitStatus(runtime);
      if (runtime.onlineSince && this.now() - runtime.onlineSince > 10 * 60_000) runtime.crashRestarts = 0;
    } else if (interpreted.type === 'started' && runtime.onlineSince && this.now() - runtime.onlineSince > 10 * 60_000) {
      runtime.crashRestarts = 0;
    } else if (interpreted.type === 'failed' || interpreted.type === 'eula') {
      runtime.lastError = interpreted.type === 'eula'
        ? 'The server refused to start because eula.txt is not accepted. Edit it in Configuration and set eula=true yourself.'
        : interpreted.message;
    } else if (interpreted.type === 'join') {
      runtime.playersKnown = true;
      runtime.online.set(interpreted.name, { since: this.now(), uuid: runtime.online.get(interpreted.name)?.uuid });
      this.deps.db.upsertPlayer(profile.id, interpreted.name, runtime.online.get(interpreted.name)?.uuid ?? null, this.now());
      this.deps.db.addPlayerEvent(profile.id, interpreted.name, null, 'join');
    } else if (interpreted.type === 'leave') {
      runtime.playersKnown = true;
      runtime.online.delete(interpreted.name);
      this.deps.db.upsertPlayer(profile.id, interpreted.name, null, this.now());
      this.deps.db.addPlayerEvent(profile.id, interpreted.name, null, 'leave');
    } else if (interpreted.type === 'uuid') {
      const current = runtime.online.get(interpreted.name);
      if (current) current.uuid = interpreted.uuid;
      this.deps.db.upsertPlayer(profile.id, interpreted.name, interpreted.uuid, this.now());
    } else if (interpreted.type === 'list') {
      runtime.playersKnown = true;
      const keep = new Set(interpreted.names);
      for (const name of [...runtime.online.keys()]) if (!keep.has(name)) runtime.online.delete(name);
      for (const name of interpreted.names) {
        if (!runtime.online.has(name)) runtime.online.set(name, { since: this.now() });
      }
    } else if (interpreted.type === 'saved') {
      for (const waiter of runtime.saveWaiters.splice(0)) waiter(true);
    }
  }

  private pushLine(runtime: Runtime, stream: LogLine['stream'], text: string): void {
    const limit = Math.min(5000, Math.max(100, this.deps.db.getSettings().consoleBuffer || 2000));
    const line: LogLine = {
      id: ++runtime.seq,
      ts: this.now(),
      stream,
      level: classifyLine(text, stream),
      text,
    };
    runtime.lines.push(line);
    if (runtime.lines.length > limit) runtime.lines.splice(0, runtime.lines.length - limit);
    for (const listener of runtime.listeners) listener(line);
  }

  private emitStatus(runtime: Runtime): void {
    for (const listener of runtime.statusListeners) listener();
  }

  private enqueue(runtime: Runtime, fn: () => Promise<void>): Promise<void> {
    const run = runtime.queue.then(fn, fn);
    runtime.queue = run.then(() => undefined, () => undefined);
    return run;
  }
}

function markerFor(profile: Profile): string | null {
  if (profile.launchMode === 'argfile' && profile.argFile) return path.resolve(profile.directory, profile.argFile);
  if (profile.jarFile) return path.resolve(profile.directory, profile.jarFile);
  return null;
}

function includesMarker(commandLine: string, marker: string): boolean {
  const haystack = commandLine.toLowerCase().replace(/\//g, '\\');
  return haystack.includes(marker.toLowerCase().replace(/\//g, '\\'));
}

function pidPath(dataDir: string, profileId: string): string {
  return path.join(dataDir, 'run', `${profileId}.json`);
}

function writePidFile(dataDir: string, profile: Profile, pid: number, marker: string, startedAt: number): void {
  const file = pidPath(dataDir, profile.id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ pid, marker, startedAt, directory: profile.directory }));
}

function readPidFile(dataDir: string, profileId: string): { pid: number; marker: string; startedAt: number } | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(pidPath(dataDir, profileId), 'utf8')) as { pid?: number; marker?: string; startedAt?: number };
    if (!parsed.pid || !parsed.marker || !parsed.startedAt) return null;
    return { pid: parsed.pid, marker: parsed.marker, startedAt: parsed.startedAt };
  } catch {
    return null;
  }
}

function clearPidFile(dataDir: string, profileId: string): void {
  fs.rmSync(pidPath(dataDir, profileId), { force: true });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function launchMarker(profile: Profile): string | null {
  return markerFor(profile);
}
