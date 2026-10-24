import { randomUUID } from 'node:crypto';
import type { Profile, ServerSoftware } from '../../shared/types.ts';
import { inspectServer } from './services/discovery.ts';
import { assertJvmArgs, assertMemory, splitArgs } from './util/args.ts';
import { HttpError } from './util/errors.ts';
import { assertJavaExecutable, assertSafeServerDirectory, resolveWithinRoot } from './util/paths.ts';

const SOFTWARE: ServerSoftware[] = ['paper', 'purpur', 'spigot', 'bukkit', 'folia', 'fabric', 'forge', 'neoforge', 'vanilla', 'hybrid', 'unknown'];

export async function profileFromInput(input: Record<string, unknown>, current?: Profile): Promise<Profile> {
  const directory = assertSafeServerDirectory(String(input.directory ?? current?.directory ?? ''));
  const inspected = await inspectServer(directory);
  if (!inspected.valid) throw new HttpError(400, inspected.errors.join(' '), 'INVALID_SERVER');
  const name = String(input.name ?? current?.name ?? '').trim();
  if (!name || name.length > 80) throw new HttpError(400, 'Enter a profile name up to 80 characters', 'BAD_NAME');
  const launchMode = input.launchMode === 'argfile' || input.launchMode === 'jar' ? input.launchMode : inspected.suggested.launchMode;
  const jarFile = input.jarFile == null && launchMode === 'argfile' ? null : String(input.jarFile ?? inspected.suggested.jar ?? '');
  const argFile = typeof input.argFile === 'string' ? input.argFile : inspected.suggested.argFile;
  if (launchMode === 'jar') {
    if (!jarFile || !inspected.jars.some((jar) => jar.relativePath === jarFile)) {
      throw new HttpError(400, 'Choose a server JAR from this directory', 'NO_JAR');
    }
    resolveWithinRoot(directory, jarFile);
  } else if (!argFile || !inspected.argFiles.includes(argFile)) {
    throw new HttpError(400, 'Choose a Forge or NeoForge argument file from this directory', 'NO_JAR');
  }
  const javaInput = input.javaPath == null ? current?.javaPath ?? null : String(input.javaPath);
  const javaPath = javaInput ? assertJavaExecutable(javaInput) : null;
  const minMemory = assertMemory(String(input.minMemory ?? current?.minMemory ?? '1G'));
  const maxMemory = assertMemory(String(input.maxMemory ?? current?.maxMemory ?? '2G'));
  if (memoryMb(minMemory) > memoryMb(maxMemory)) throw new HttpError(400, 'Minimum memory cannot be higher than maximum memory', 'BAD_MEMORY');
  const jvmArgs = String(input.jvmArgs ?? current?.jvmArgs ?? '');
  const serverArgs = String(input.serverArgs ?? current?.serverArgs ?? '');
  assertJvmArgs(jvmArgs);
  splitArgs(serverArgs);
  const requested = String(input.software ?? '');
  const software = SOFTWARE.includes(requested as ServerSoftware) ? requested as ServerSoftware : inspected.suggested.software;
  const container = input.pluginContainer === 'plugins' || input.pluginContainer === 'mods' || input.pluginContainer === 'none'
    ? input.pluginContainer
    : inspected.pluginContainer;
  const now = Date.now();
  return {
    id: current?.id ?? randomUUID(),
    name,
    directory,
    jarFile: jarFile || null,
    javaPath,
    minMemory,
    maxMemory,
    jvmArgs,
    serverArgs,
    software,
    mcVersion: typeof input.mcVersion === 'string' && input.mcVersion.trim() ? input.mcVersion.trim() : inspected.suggested.version,
    launchMode,
    argFile: argFile ?? null,
    pluginContainer: container,
    autoRestart: Boolean(input.autoRestart ?? current?.autoRestart ?? false),
    autoRestartMax: clamp(input.autoRestartMax ?? current?.autoRestartMax, 0, 10, 3),
    autoRestartCooldown: clamp(input.autoRestartCooldown ?? current?.autoRestartCooldown, 5, 3600, 30),
    restartDelay: clamp(input.restartDelay ?? current?.restartDelay, 0, 300, 5),
    createdAt: current?.createdAt ?? now,
    updatedAt: now,
  };
}

function memoryMb(value: string): number {
  const amount = Number(value.slice(0, -1));
  return value.endsWith('G') ? amount * 1024 : amount;
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}
