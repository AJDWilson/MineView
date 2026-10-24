import fs from 'node:fs';

export function followFile(file: string, onLine: (line: string) => void): { stop: () => void } {
  let position = 0;
  let partial = '';
  let stopped = false;
  let reading = false;
  let primed = false;

  async function read(initial: boolean): Promise<void> {
    if (reading || stopped) return;
    reading = true;
    try {
      const stat = await fs.promises.stat(file);
      if (!primed) {
        position = Math.max(0, stat.size - 200_000);
        primed = true;
      }
      if (stat.size < position) {
        position = 0;
        partial = '';
      }
      if (stat.size > position) {
        const handle = await fs.promises.open(file, 'r');
        const length = stat.size - position;
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, position);
        await handle.close();
        position = stat.size;
        partial += buffer.toString('utf8');
        if (initial) {
          const lines = partial.split(/\n/);
          partial = lines.pop() ?? '';
          for (const line of lines.slice(-200)) onLine(line.endsWith('\r') ? line.slice(0, -1) : line);
        } else {
          let index = partial.indexOf('\n');
          while (index >= 0) {
            let line = partial.slice(0, index);
            partial = partial.slice(index + 1);
            if (line.endsWith('\r')) line = line.slice(0, -1);
            onLine(line);
            index = partial.indexOf('\n');
          }
        }
      }
    } catch {
      // The log may not exist until the server creates it.
    } finally {
      reading = false;
    }
  }

  void read(true);
  const timer = setInterval(() => void read(false), 1000);
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
