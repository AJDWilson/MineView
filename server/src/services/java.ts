import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { JavaCandidate, JavaCheck } from '../../../shared/types.ts';
import { HttpError } from '../util/errors.ts';
import { javaWarnings, parseJavaMajor } from '../util/javaCompat.ts';
import { assertJavaExecutable } from '../util/paths.ts';

export function readJavaVersion(javaPath: string): Promise<string> {
  const executable = assertJavaExecutable(javaPath);
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['-version'], { windowsHide: true, shell: false });
    let output = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new HttpError(400, 'Java did not respond to java -version', 'JAVA_TIMEOUT'));
    }, 8000);
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      output += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      output += chunk;
    });
    child.on('error', () => {
      clearTimeout(timer);
      reject(new HttpError(400, 'Java could not be started', 'JAVA_FAILED'));
    });
    child.on('exit', () => {
      clearTimeout(timer);
      if (!output.trim()) reject(new HttpError(400, 'Java did not report a version', 'JAVA_FAILED'));
      else resolve(output.trim());
    });
  });
}

export async function checkJava(javaPath: string, mcVersion: string | null): Promise<JavaCheck> {
  const executable = assertJavaExecutable(javaPath);
  const versionText = await readJavaVersion(executable);
  const major = parseJavaMajor(versionText);
  const warnings = javaWarnings(mcVersion, major);
  const tooOld = warnings.some((warning) => warning.includes('too old'));
  const unknown = warnings.some((warning) => warning.includes('no Java compatibility table') || warning.includes('was not detected'));
  return {
    path: executable,
    version: versionText.split(/\r?\n/)[0] ?? versionText,
    major,
    compatible: tooOld ? false : unknown ? null : true,
    warnings,
  };
}

export async function findJavaInstallations(): Promise<JavaCandidate[]> {
  const found = new Map<string, JavaCandidate>();
  const seeds: string[] = [];
  if (process.env.JAVA_HOME) seeds.push(path.join(process.env.JAVA_HOME, 'bin', 'java.exe'));
  for (const root of [
    'C:\\Program Files\\Java',
    'C:\\Program Files\\Eclipse Adoptium',
    'C:\\Program Files\\Microsoft',
    'C:\\Program Files\\Amazon Corretto',
    'C:\\Program Files\\Zulu',
    'C:\\Program Files\\BellSoft',
  ]) {
    collectJava(root, seeds, 0);
  }
  try {
    const where = await runWhere();
    seeds.push(...where);
  } catch {
    // where.exe is only a hint.
  }
  for (const candidate of seeds) {
    try {
      const real = assertJavaExecutable(candidate);
      if (found.has(real.toLowerCase())) continue;
      const versionText = await readJavaVersion(real);
      found.set(real.toLowerCase(), {
        path: real,
        version: versionText.split(/\r?\n/)[0] ?? null,
        warning: null,
      });
      if (found.size >= 8) break;
    } catch {
      // Skip uninstallable or non-java paths.
    }
  }
  return [...found.values()];
}

function collectJava(dir: string, into: string[], depth: number): void {
  if (depth > 3 || !fs.existsSync(dir)) return;
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectJava(full, into, depth + 1);
    else if (entry.name.toLowerCase() === 'java.exe') into.push(full);
  }
}

function runWhere(): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'where.exe'), ['java'], {
      windowsHide: true,
      shell: false,
    });
    let output = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      output += chunk;
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0) reject(new Error('java was not found on PATH'));
      else resolve(output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
    });
  });
}
