import fs from 'node:fs';
import path from 'node:path';
import type { DiagnosticCheck, Profile } from '../../../shared/types.ts';
import { diskUsage } from './files.ts';
import { readJavaVersion } from './java.ts';
import { parseJavaMajor } from '../util/javaCompat.ts';

export async function runDiagnostics(profile: Profile | null, backupDir: string, dataDir: string): Promise<DiagnosticCheck[]> {
  const checks: DiagnosticCheck[] = [];
  checks.push(await checkWritable('data', 'Application data folder', dataDir, true));
  checks.push(await checkWritable('backups', 'Backup folder', backupDir, true));
  const disk = diskUsage(backupDir);
  checks.push({
    id: 'disk',
    name: 'Free disk space',
    status: disk && disk.free < 512 * 1024 * 1024 ? 'warn' : disk ? 'pass' : 'warn',
    message: disk ? `${Math.round(disk.free / (1024 * 1024))} MB free` : 'Disk space could not be read',
    hint: disk && disk.free < 512 * 1024 * 1024 ? 'Free space before taking a backup.' : null,
  });
  if (!profile) {
    checks.push({ id: 'profile', name: 'Server profile', status: 'warn', message: 'No server profile is selected', hint: 'Finish the setup wizard.' });
    return checks;
  }
  checks.push(fs.existsSync(profile.directory)
    ? { id: 'directory', name: 'Server directory', status: 'pass', message: profile.directory, hint: null }
    : { id: 'directory', name: 'Server directory', status: 'fail', message: 'The server directory is missing', hint: 'Update the profile path in Settings.' });
  const writable = await checkWritable('server-write', 'Server directory permissions', profile.directory, false);
  checks.push(writable);
  if (profile.javaPath) {
    try {
      const version = await readJavaVersion(profile.javaPath);
      const major = parseJavaMajor(version);
      checks.push({ id: 'java', name: 'Java', status: 'pass', message: version.split(/\r?\n/)[0] ?? `Java ${major}`, hint: null });
    } catch (error) {
      checks.push({ id: 'java', name: 'Java', status: 'fail', message: error instanceof Error ? error.message : 'Java failed', hint: 'Set a path to java.exe in Settings.' });
    }
  } else {
    checks.push({ id: 'java', name: 'Java', status: 'fail', message: 'No Java executable is configured', hint: 'Set java.exe in Settings.' });
  }
  const launch = profile.launchMode === 'argfile' && profile.argFile
    ? path.join(profile.directory, profile.argFile)
    : profile.jarFile ? path.join(profile.directory, profile.jarFile) : '';
  checks.push(launch && fs.existsSync(launch)
    ? { id: 'jar', name: 'Server launch file', status: 'pass', message: path.basename(launch), hint: null }
    : { id: 'jar', name: 'Server launch file', status: 'fail', message: 'The JAR or argument file is missing', hint: 'Re-detect the server or choose the file in Settings.' });
  const properties = path.join(profile.directory, 'server.properties');
  checks.push(fs.existsSync(properties)
    ? { id: 'properties', name: 'server.properties', status: 'pass', message: 'Found', hint: null }
    : { id: 'properties', name: 'server.properties', status: 'warn', message: 'Not found yet', hint: 'It is created the first time the server starts.' });
  if (profile.pluginContainer !== 'none') {
    const plugins = path.join(profile.directory, profile.pluginContainer);
    checks.push(fs.existsSync(plugins)
      ? { id: 'plugins', name: 'Plugin directory', status: 'pass', message: profile.pluginContainer, hint: null }
      : { id: 'plugins', name: 'Plugin directory', status: 'warn', message: `${profile.pluginContainer} does not exist yet`, hint: 'It will be created when you install a plugin.' });
  }
  const eula = path.join(profile.directory, 'eula.txt');
  if (!fs.existsSync(eula)) {
    checks.push({ id: 'eula', name: 'EULA', status: 'warn', message: 'eula.txt was not found', hint: 'The server creates this file and will not start until you accept it.' });
  } else {
    const accepted = /^\s*eula\s*=\s*true\s*$/im.test(fs.readFileSync(eula, 'utf8'));
    checks.push(accepted
      ? { id: 'eula', name: 'EULA', status: 'pass', message: 'Accepted', hint: null }
      : { id: 'eula', name: 'EULA', status: 'warn', message: 'Not accepted', hint: 'Edit eula.txt yourself and set eula=true.' });
  }
  checks.push({ id: 'websocket', name: 'WebSocket endpoint', status: 'pass', message: 'The console connects to /ws on this same origin', hint: 'If the console stays disconnected, confirm the API process is running.' });
  return checks;
}

async function checkWritable(id: string, name: string, dir: string, create: boolean): Promise<DiagnosticCheck> {
  try {
    if (create) await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.access(dir, fs.constants.R_OK | fs.constants.W_OK);
    return { id, name, status: 'pass', message: 'Readable and writable', hint: null };
  } catch {
    return { id, name, status: 'fail', message: 'Not readable or not writable', hint: 'Check folder permissions for the Windows user running Mineview.' };
  }
}
