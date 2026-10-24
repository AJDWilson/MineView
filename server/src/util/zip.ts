import fs from 'node:fs';
import path from 'node:path';
import archiver from 'archiver';
import yauzl from 'yauzl';
import type { Entry, ZipFile } from 'yauzl';
import { HttpError } from './errors.ts';
import { assertInside, resolveWithinRoot } from './paths.ts';

const MAX_ENTRY_BYTES = 1_000_000;
const MAX_EXTRACT_FILES = 250_000;
const MAX_EXTRACT_BYTES = 30 * 1024 * 1024 * 1024;

function openZip(file: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: false }, (error, zip) => {
      if (error || !zip) reject(error ?? new Error('Unable to open archive'));
      else resolve(zip);
    });
  });
}

export async function readZipTextFiles(file: string, wanted: string[]): Promise<Map<string, string>> {
  const zip = await openZip(file);
  const want = new Set(wanted);
  const found = new Map<string, string>();
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      zip.close();
      if (error) reject(error);
      else resolve();
    };
    zip.on('error', (error) => finish(error));
    zip.on('end', () => finish());
    zip.on('entry', (entry: Entry) => {
      if (!want.has(entry.fileName) || entry.uncompressedSize > MAX_ENTRY_BYTES) {
        zip.readEntry();
        return;
      }
      zip.openReadStream(entry, (error, stream) => {
        if (error || !stream) {
          finish(error ?? new Error('Unable to read archive entry'));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        stream.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_ENTRY_BYTES) {
            stream.destroy();
            finish(new Error('Archive entry is too large'));
            return;
          }
          chunks.push(chunk);
        });
        stream.on('end', () => {
          found.set(entry.fileName, Buffer.concat(chunks).toString('utf8'));
          if (found.size === want.size) finish();
          else zip.readEntry();
        });
        stream.on('error', (streamError) => finish(streamError));
      });
    });
    zip.readEntry();
  });
  return found;
}

export async function listZipRoots(file: string): Promise<string[]> {
  const zip = await openZip(file);
  const roots = new Set<string>();
  await new Promise<void>((resolve, reject) => {
    zip.on('error', reject);
    zip.on('end', () => resolve());
    zip.on('entry', (entry: Entry) => {
      const [root] = entry.fileName.replace(/\\/g, '/').split('/');
      if (root) roots.add(root);
      zip.readEntry();
    });
    zip.readEntry();
  });
  zip.close();
  return [...roots].sort();
}

export async function extractZip(file: string, destination: string, includeRoots?: string[]): Promise<void> {
  const root = fs.realpathSync(destination);
  const zip = await openZip(file);
  const allowed = includeRoots ? new Set(includeRoots) : null;
  let files = 0;
  let bytes = 0;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      zip.close();
      reject(error);
    };
    zip.on('error', fail);
    zip.on('end', () => {
      if (settled) return;
      settled = true;
      zip.close();
      resolve();
    });
    zip.readEntry();
    zip.on('entry', (entry: Entry) => {
      try {
        const name = entry.fileName.replace(/\\/g, '/');
        const entryRoot = name.split('/').filter(Boolean)[0];
        if (allowed && entryRoot && !allowed.has(entryRoot)) {
          zip.readEntry();
          return;
        }
        if (name.endsWith('/')) {
          fs.mkdirSync(resolveWithinRoot(root, name.slice(0, -1)), { recursive: true });
          zip.readEntry();
          return;
        }
        files += 1;
        bytes += entry.uncompressedSize;
        if (files > MAX_EXTRACT_FILES || bytes > MAX_EXTRACT_BYTES) {
          fail(new HttpError(400, 'Archive is too large to restore safely', 'ZIP_LIMIT'));
          return;
        }
        const dest = resolveWithinRoot(root, name);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        const parentReal = fs.realpathSync(path.dirname(dest));
        assertInside(root, parentReal);
        const finalDest = path.join(parentReal, path.basename(dest));
        assertInside(root, finalDest);
        zip.openReadStream(entry, (error, stream) => {
          if (error || !stream) {
            fail(error ?? new Error('Unable to read archive entry'));
            return;
          }
          const out = fs.createWriteStream(finalDest);
          stream.pipe(out);
          out.on('finish', () => zip.readEntry());
          out.on('error', fail);
          stream.on('error', fail);
        });
      } catch (error) {
        fail(error instanceof Error ? error : new Error('Archive entry was rejected'));
      }
    });
  });
}

async function addTree(
  archive: archiver.Archiver,
  abs: string,
  zipName: string,
  skip?: (relative: string) => boolean,
): Promise<void> {
  const stat = await fs.promises.lstat(abs);
  if (stat.isSymbolicLink()) return;
  if (stat.isFile()) {
    if (!skip?.(zipName)) archive.file(abs, { name: zipName });
    return;
  }
  if (!stat.isDirectory()) return;
  const children = await fs.promises.readdir(abs);
  for (const child of children) {
    const childZip = `${zipName}/${child}`.replace(/\\/g, '/');
    if (skip?.(childZip)) continue;
    await addTree(archive, path.join(abs, child), childZip, skip);
  }
}

export async function createZip(
  outputFile: string,
  items: { abs: string; name: string }[],
  skip?: (relative: string) => boolean,
): Promise<void> {
  await fs.promises.mkdir(path.dirname(outputFile), { recursive: true });
  const temp = `${outputFile}.partial`;
  await new Promise<void>((resolve, reject) => {
    const output = fs.createWriteStream(temp);
    const archive = archiver('zip', { zlib: { level: 6 } });
    const fail = (error: Error) => {
      archive.abort();
      output.destroy();
      reject(error);
    };
    output.on('close', () => resolve());
    output.on('error', fail);
    archive.on('error', fail);
    archive.pipe(output);
    void (async () => {
      try {
        for (const item of items) {
          const stat = await fs.promises.lstat(item.abs);
          if (stat.isSymbolicLink()) continue;
          if (stat.isDirectory()) await addTree(archive, item.abs, item.name.replace(/\\/g, '/'), skip);
          else if (!skip?.(item.name)) archive.file(item.abs, { name: item.name.replace(/\\/g, '/') });
        }
        await archive.finalize();
      } catch (error) {
        fail(error instanceof Error ? error : new Error('Backup failed'));
      }
    })();
  });
  await fs.promises.rename(temp, outputFile);
}
