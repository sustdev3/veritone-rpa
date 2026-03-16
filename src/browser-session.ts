import { chromium, Browser, BrowserContext, Page } from 'playwright';

const VERITONE_LOGIN_URL = 'https://www.adcourier.com/login.cgi?redirect=%3F';
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const POST_LOGIN_URL_PATTERN = /adcourier\.com\/?$/i;

export interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
}

export async function launchAndWaitForLogin(): Promise<BrowserSession> {
  console.log('[Browser] Launching Chromium browser...');

  const browser = await chromium.launch({
    headless: false,
    args: [
      '--start-maximized',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  const context = await browser.newContext({
    viewport: null,
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  });

  const page = await context.newPage();

  await page.goto(VERITONE_LOGIN_URL, { waitUntil: 'domcontentloaded' });

  const runMode = process.env.RUN_MODE ?? 'testing';

  if (runMode === 'production') {
    console.log('[Browser] ─────────────────────────────────────────');
    console.log('[Browser]  ACTION REQUIRED: Please log in to ');
    console.log('[Browser]  Veritone Hire.');
    console.log('[Browser]  The automation will start as soon ');
    console.log('[Browser]  as you log in.');
    console.log('[Browser] ─────────────────────────────────────────');

    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (POST_LOGIN_URL_PATTERN.test(page.url())) {
          clearInterval(interval);
          resolve();
        }
      }, 3000);
    });
  } else {
    console.log('[Browser] ─────────────────────────────────────────────────');
    console.log('[Browser]  ACTION REQUIRED: Please log in to Veritone Hire.');
    console.log(`[Browser]  You have ${LOGIN_TIMEOUT_MS / 60000} minutes to complete login.`);
    console.log('[Browser] ─────────────────────────────────────────────────');

    await page.waitForURL(POST_LOGIN_URL_PATTERN, {
      timeout: LOGIN_TIMEOUT_MS,
    }).catch(() => {
      throw new Error(
        `[Browser] Login timed out after ${LOGIN_TIMEOUT_MS / 60000} minutes. ` +
        'Please restart and log in within the allowed window.'
      );
    });
  }

  console.log('[Browser] Login confirmed. Session is active.');

  return { browser, context, page };
}
