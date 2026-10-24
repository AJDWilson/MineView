import { HttpError } from './errors.ts';

const DOWNLOAD_HOSTS = new Set([
  'cdn.modrinth.com',
  'api.modrinth.com',
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'hangarcdn.papermc.io',
  'hangar.papermc.io',
  'api.spiget.org',
  'cdn.spiget.org',
]);

const DISCORD_HOSTS = new Set(['discord.com', 'discordapp.com', 'canary.discord.com', 'ptb.discord.com']);

export function assertDownloadUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(400, 'Invalid download URL', 'BAD_URL');
  }
  if (url.protocol !== 'https:') throw new HttpError(400, 'Downloads must use HTTPS', 'BAD_URL');
  if (url.username || url.password) throw new HttpError(400, 'Download URL cannot include credentials', 'BAD_URL');
  if (!DOWNLOAD_HOSTS.has(url.hostname)) throw new HttpError(400, 'Download host is not allowed', 'BAD_URL');
  return url;
}

export function assertDiscordWebhook(raw: string): string {
  if (!raw.trim()) return '';
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new HttpError(400, 'Webhook must be a valid URL', 'BAD_WEBHOOK');
  }
  if (url.protocol !== 'https:' || !DISCORD_HOSTS.has(url.hostname) || !url.pathname.startsWith('/api/webhooks/')) {
    throw new HttpError(400, 'Webhook must be a Discord HTTPS webhook URL', 'BAD_WEBHOOK');
  }
  return url.toString();
}

export function isLoopbackHost(host: string): boolean {
  const value = host.trim().toLowerCase();
  return value === '127.0.0.1' || value === 'localhost' || value === '::1';
}

export function isAllowedOrigin(origin: string | undefined, opts: { port: number; allowRemote: boolean }): boolean {
  if (!origin) return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  const host = url.hostname.toLowerCase();
  const loopback = host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
  if (loopback && (port === opts.port || port === 5173)) return true;
  return opts.allowRemote && port === opts.port;
}

export async function fetchAllowlisted(
  rawUrl: string,
  init: RequestInit & { timeoutMs?: number } = {},
  redirectsLeft = 3,
): Promise<Response> {
  const url = assertDownloadUrl(rawUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), init.timeoutMs ?? 60_000);
  try {
    const response = await fetch(url, {
      ...init,
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        'User-Agent': 'mineview/1.0 (local Minecraft server panel)',
        Accept: 'application/json, application/java-archive, application/octet-stream, */*',
        ...(init.headers ?? {}),
      },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location || redirectsLeft <= 0) throw new HttpError(502, 'Download redirect was rejected', 'BAD_REDIRECT');
      return fetchAllowlisted(new URL(location, url).toString(), init, redirectsLeft - 1);
    }
    return response;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, 'Download failed before a file was received', 'DOWNLOAD_FAILED');
  } finally {
    clearTimeout(timeout);
  }
}
