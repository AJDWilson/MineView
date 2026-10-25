import fs from 'node:fs';
import path from 'node:path';
import { isLoopbackHost } from './util/net.ts';
import { appRoot } from './util/runtime.ts';

export interface RuntimeFile {
  host: string;
  port: number;
}

export function loadDotEnv(cwd = appRoot()): void {
  const file = path.join(cwd, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index < 0) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export function resolveDataDir(): string {
  return path.resolve(process.env.DATA_DIR || path.join(appRoot(), 'data'));
}

export function readRuntimeFile(dataDir: string): RuntimeFile {
  const file = path.join(dataDir, 'runtime.json');
  if (!fs.existsSync(file)) return { host: '127.0.0.1', port: 3847 };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<RuntimeFile>;
    return {
      host: typeof parsed.host === 'string' && parsed.host.trim() ? parsed.host.trim() : '127.0.0.1',
      port: Number.isInteger(parsed.port) ? Number(parsed.port) : 3847,
    };
  } catch {
    return { host: '127.0.0.1', port: 3847 };
  }
}

export function writeRuntimeFile(dataDir: string, runtime: RuntimeFile): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const tmp = path.join(dataDir, 'runtime.json.tmp');
  fs.writeFileSync(tmp, JSON.stringify(runtime, null, 2));
  fs.renameSync(tmp, path.join(dataDir, 'runtime.json'));
}

export function resolveBind(dataDir: string, allowRemote: boolean, override?: { host?: string; port?: number }): RuntimeFile {
  const file = readRuntimeFile(dataDir);
  const host = override?.host || process.env.HOST || file.host || '127.0.0.1';
  const portValue = override?.port ?? (process.env.PORT ? Number(process.env.PORT) : file.port);
  const port = Number.isInteger(portValue) && portValue >= 0 && portValue <= 65535 ? portValue : 3847;
  if (!isLoopbackHost(host) && !allowRemote) return { host: '127.0.0.1', port };
  return { host, port };
}
