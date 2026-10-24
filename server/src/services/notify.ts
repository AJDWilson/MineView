import { assertDiscordWebhook } from '../util/net.ts';
import { log } from '../logger.ts';

export async function notifyDiscord(webhook: string, content: string): Promise<void> {
  if (!webhook) return;
  let url: string;
  try {
    url = assertDiscordWebhook(webhook);
  } catch {
    return;
  }
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'mineview/1.0' },
      body: JSON.stringify({ content: content.slice(0, 1800) }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) log('warn', `Discord webhook returned ${response.status}`);
  } catch {
    log('warn', 'Discord webhook notification failed');
  }
}
