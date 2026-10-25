import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
import pngToIco from 'png-to-ico';
import { rcedit } from 'rcedit';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildDir = path.join(root, 'build');
const appDir = path.join(root, 'release', 'Mineview');
const serverExe = path.join(appDir, 'MineviewServer.exe');
const windowExe = path.join(appDir, 'Mineview.exe');
const blobPath = path.join(buildDir, 'sea-prep.blob');
const bundlePath = path.join(buildDir, 'server.cjs');
const iconPath = path.join(buildDir, 'mineview.ico');
const webViewVersion = '1.0.2792.45';

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: false });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.status ?? 'missing'})`);
  }
}

function setWindowsSubsystem(file) {
  const bytes = fs.readFileSync(file);
  const pe = bytes.readUInt32LE(0x3c);
  if (bytes.readUInt32LE(pe) !== 0x4550) throw new Error('Mineview.exe is not a Windows executable');
  const subsystem = pe + 24 + 68;
  bytes.writeUInt16LE(2, subsystem);
  fs.writeFileSync(file, bytes);
}

fs.rmSync(buildDir, { recursive: true, force: true });
fs.mkdirSync(buildDir, { recursive: true });
fs.mkdirSync(appDir, { recursive: true });
for (const name of [
  'client',
  'Mineview.exe',
  'MineviewServer.exe',
  'Microsoft.Web.WebView2.Core.dll',
  'Microsoft.Web.WebView2.WinForms.dll',
  'WebView2Loader.dll',
]) {
  fs.rmSync(path.join(appDir, name), { recursive: true, force: true });
}

async function webViewPackage() {
  const dir = path.join(buildDir, 'webview2');
  const packed = path.join(dir, 'pkg');
  fs.mkdirSync(dir, { recursive: true });
  const nupkg = path.join(dir, 'webview2.zip');
  const url = `https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/${webViewVersion}/microsoft.web.webview2.${webViewVersion}.nupkg`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`WebView2 download failed (${response.status})`);
  fs.writeFileSync(nupkg, Buffer.from(await response.arrayBuffer()));
  run('powershell.exe', [
    '-NoProfile',
    '-Command',
    `Expand-Archive -Force -LiteralPath '${nupkg}' -DestinationPath '${packed}'`,
  ]);
  return packed;
}

run(process.execPath, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--config', 'client/vite.config.ts']);

await esbuild.build({
  absWorkingDir: root,
  entryPoints: ['server/src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile: bundlePath,
  external: ['node:sqlite'],
  logLevel: 'info',
});

fs.writeFileSync(iconPath, await pngToIco(path.join(root, 'image-logo.png')));
fs.writeFileSync(path.join(buildDir, 'sea-config.json'), JSON.stringify({
  main: bundlePath,
  output: blobPath,
  disableExperimentalSEAWarning: true,
  useCodeCache: false,
}, null, 2));

run(process.execPath, ['--experimental-sea-config', path.join(buildDir, 'sea-config.json')]);
fs.copyFileSync(process.execPath, serverExe);
await rcedit(serverExe, {
  icon: iconPath,
  'file-version': '1.0.0.0',
  'product-version': '1.0.0.0',
  'version-string': {
    FileDescription: 'Mineview Server',
    ProductName: 'Mineview',
    OriginalFilename: 'MineviewServer.exe',
  },
});
run(process.execPath, [
  path.join(root, 'node_modules', 'postject', 'dist', 'cli.js'),
  serverExe,
  'NODE_SEA_BLOB',
  blobPath,
  '--sentinel-fuse',
  'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  '--overwrite',
]);
setWindowsSubsystem(serverExe);

const webview = await webViewPackage();
const coreDll = path.join(webview, 'lib', 'net462', 'Microsoft.Web.WebView2.Core.dll');
const formsDll = path.join(webview, 'lib', 'net462', 'Microsoft.Web.WebView2.WinForms.dll');
const loaderDll = path.join(webview, 'runtimes', 'win-x64', 'native', 'WebView2Loader.dll');
const csc = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
run(csc, [
  '/nologo',
  '/target:winexe',
  '/optimize+',
  '/utf8output',
  `/win32icon:${iconPath}`,
  `/win32manifest:${path.join(root, 'desktop', 'app.manifest')}`,
  `/out:${windowExe}`,
  '/reference:System.dll',
  '/reference:System.Drawing.dll',
  '/reference:System.Windows.Forms.dll',
  `/reference:${coreDll}`,
  `/reference:${formsDll}`,
  path.join(root, 'desktop', 'Program.cs'),
]);
await rcedit(windowExe, {
  icon: iconPath,
  'file-version': '1.0.0.0',
  'product-version': '1.0.0.0',
  'version-string': {
    FileDescription: 'Mineview',
    ProductName: 'Mineview',
    OriginalFilename: 'Mineview.exe',
  },
});
for (const dll of [coreDll, formsDll, loaderDll]) {
  fs.copyFileSync(dll, path.join(appDir, path.basename(dll)));
}
fs.cpSync(path.join(root, 'client', 'dist'), path.join(appDir, 'client', 'dist'), { recursive: true });
console.log(`Mineview.exe is in ${appDir}`);
