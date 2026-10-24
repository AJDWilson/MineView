import { spawn } from 'node:child_process';
import path from 'node:path';

function powershellPath(): string {
  return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

export function runPowershell(script: string, timeoutMs = 12_000): Promise<string> {
  if (process.platform !== 'win32') return Promise.reject(new Error('Process inspection is implemented for Windows'));
  return new Promise((resolve, reject) => {
    const child = spawn(powershellPath(), ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Process inspection timed out'));
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0 && !stdout.trim()) reject(new Error(stderr.trim() || `PowerShell exited ${code}`));
      else resolve(stdout);
    });
  });
}

export async function commandLineForPid(pid: number): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const text = (await runPowershell(`(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`)).trim();
    return text || null;
  } catch {
    return null;
  }
}

export async function listJavaProcesses(): Promise<{ pid: number; commandLine: string }[]> {
  try {
    const text = await runPowershell(
      "Get-CimInstance Win32_Process -Filter \"Name = 'java.exe'\" | ForEach-Object { $_.ProcessId.ToString() + \"`t\" + $_.CommandLine }",
      20_000,
    );
    return text
      .split(/\r?\n/)
      .map((line) => {
        const tab = line.indexOf('\t');
        if (tab < 0) return null;
        const pid = Number(line.slice(0, tab));
        const commandLine = line.slice(tab + 1).trim();
        if (!Number.isInteger(pid) || !commandLine) return null;
        return { pid, commandLine };
      })
      .filter((row): row is { pid: number; commandLine: string } => Boolean(row));
  } catch {
    return [];
  }
}

export async function sampleProcess(pid: number): Promise<{ cpuSeconds: number; rss: number } | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const text = (await runPowershell(
      `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { '{0},{1}' -f $p.CPU, $p.WorkingSet64 }`,
    )).trim();
    const [cpu, rss] = text.split(',');
    const cpuSeconds = Number(cpu);
    const memory = Number(rss);
    if (!Number.isFinite(memory)) return null;
    return { cpuSeconds: Number.isFinite(cpuSeconds) ? cpuSeconds : 0, rss: memory };
  } catch {
    return null;
  }
}

export function taskkill(pid: number): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) return Promise.reject(new Error('Invalid process id'));
  const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
  return new Promise((resolve, reject) => {
    const child = spawn(exe, ['/PID', String(pid), '/T', '/F'], { windowsHide: true, shell: false });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`taskkill exited ${code}`))));
  });
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
