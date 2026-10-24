export function readCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

export function serializeCookie(
  name: string,
  value: string,
  opts: { httpOnly?: boolean; maxAge?: number } = {},
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'SameSite=Strict'];
  if (opts.httpOnly) parts.push('HttpOnly');
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${opts.maxAge}`);
  return parts.join('; ');
}
