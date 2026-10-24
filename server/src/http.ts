import type { NextFunction, Request, Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { HttpError } from './util/errors.ts';
import { readCookies } from './util/cookies.ts';
import { log } from './logger.ts';

const buckets = new Map<string, number[]>();

export function asyncRoute(handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => {
    handler(req, res, next).catch(next);
  };
}

export function rateLimit(key: string, limit: number, windowMs: number): void {
  const now = Date.now();
  const recent = (buckets.get(key) ?? []).filter((stamp) => now - stamp < windowMs);
  if (recent.length >= limit) throw new HttpError(429, 'Too many requests. Wait a moment and try again.', 'RATE_LIMIT');
  recent.push(now);
  buckets.set(key, recent);
}

export function clientIp(req: Request): string {
  return req.socket.remoteAddress || 'local';
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function errorHandler(error: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (error instanceof HttpError) {
    res.status(error.status).json({ error: error.message, code: error.code });
    return;
  }
  const message = error instanceof Error ? error.message : 'Request failed';
  if (message.includes('File too large')) {
    res.status(400).json({ error: 'The upload is too large', code: 'TOO_LARGE' });
    return;
  }
  log('error', 'Unhandled request error', error);
  res.status(500).json({ error: 'Something went wrong on the server', code: 'INTERNAL' });
}

export function sessionToken(req: Request): string | undefined {
  return readCookies(req.headers.cookie).mv_session;
}

export function csrfHeader(req: Request): string | undefined {
  const value = req.headers['x-csrf-token'];
  return Array.isArray(value) ? value[0] : value;
}
