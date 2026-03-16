import { DateTime } from 'luxon';
import { BrowserSession } from '../browser-session';

export function randomDelay(minMs: number = 2000, maxMs: number = 3000): Promise<void> {
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function cleanupSession(session: BrowserSession): Promise<void> {
  try {
    await randomDelay();
    console.log('[Cleanup] Clicking logout button (li#logout a)...');
    await session.page.locator('li#logout a').click();
    await session.page.waitForURL(/login\.cgi/, { timeout: 10_000 });
    console.log('[Cleanup] Logged out successfully. Login page confirmed.');
  } catch (err) {
    console.warn('[Cleanup] Logout did not complete cleanly:', (err as Error).message);
  }

  console.log('[Cleanup] Closing browser...');
  await session.browser.close();
  console.log('[Cleanup] Browser closed.');
}

export function parseAdvertDate(raw: string): DateTime {
  const norm = raw.replace(/[\u00A0\s]+/g, ' ').trim();

  let dt = DateTime.fromFormat(norm, 'd MMM yy HH:mm');
  if (!dt.isValid) {
    dt = DateTime.fromFormat(norm, 'd MMM yyyy HH:mm');
  }

  if (!dt.isValid) {
    console.warn(`[Utils] Could not parse date: "${raw}"`);
  }

  return dt;
}
