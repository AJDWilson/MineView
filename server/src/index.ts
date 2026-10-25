import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from './app.ts';
import { log } from './logger.ts';
import { appRoot, isPackaged } from './util/runtime.ts';

function tellUser(message: string): void {
  const file = path.join(appRoot(), 'data', 'app.log');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${new Date().toISOString()} ERROR ${message}\n`);
  } catch {
    // The dialog below is the fallback when the data folder cannot be written.
  }
  if (process.platform !== 'win32' || process.env.MINEVIEW_NO_BROWSER === '1') return;
  spawn('powershell.exe', [
    '-NoProfile',
    '-WindowStyle',
    'Hidden',
    '-Command',
    `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show(${JSON.stringify(message)}, 'Mineview')`,
  ], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

function addressInUse(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === 'EADDRINUSE';
}

startServer().catch((error: unknown) => {
  if (isPackaged() && addressInUse(error)) {
    log('info', 'Mineview is already running');
    process.exit(0);
  }
  const message = error instanceof Error ? error.message : 'Mineview failed to start';
  log('error', 'Mineview failed to start', error);
  if (isPackaged()) tellUser(`Mineview could not start. ${message}`);
  process.exit(1);
});
