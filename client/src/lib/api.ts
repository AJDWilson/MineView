export class ApiError extends Error {
  constructor(message: string, public status: number, public code?: string) {
    super(message);
  }
}

function csrf(): string {
  const match = document.cookie.match(/(?:^|; )mv_csrf=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (init.method && init.method !== 'GET' && init.method !== 'HEAD') headers.set('x-csrf-token', csrf());
  const response = await fetch(path, { ...init, headers, credentials: 'same-origin' });
  const text = await response.text();
  const data = text ? JSON.parse(text) as { error?: string; code?: string } : {};
  if (response.status === 401 && path !== '/api/me' && path !== '/api/auth/login') window.location.assign('/login');
  if (!response.ok) throw new ApiError(data.error || `Request failed (${response.status})`, response.status, data.code);
  return data as T;
}

export async function upload<T>(path: string, form: FormData): Promise<T> {
  const response = await fetch(path, { method: 'POST', body: form, headers: { 'x-csrf-token': csrf() }, credentials: 'same-origin' });
  const data = await response.json() as { error?: string; code?: string };
  if (!response.ok) throw new ApiError(data.error || 'Upload failed', response.status, data.code);
  return data as T;
}
