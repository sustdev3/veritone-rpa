import { chromium, Browser, BrowserContext, Page } from 'playwright';

const VERITONE_LOGIN_URL = 'https://www.adcourier.com/login.cgi?redirect=%3F';
const POST_LOGIN_URL_PATTERN = /adcourier\.com\/?$/i;

export interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
}

let activePage: Page | null = null;

export function setActivePage(page: Page): void {
  activePage = page;
}

export function getActivePage(): Page | null {
  return activePage;
}

async function waitForManualLogin(page: Page): Promise<void> {
  console.log('[Browser] No credentials found in .env — waiting for manual login.');
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
}

async function performAutoLogin(page: Page): Promise<void> {
  console.log('[Browser] Credentials found — logging in automatically...');

  await page.fill('input[name="username"]', process.env.VERITONE_USERNAME!);
  await page.fill('input[name="password"]', process.env.VERITONE_PASSWORD!);
  await page.click('button#submit_button');

  const redirected = await page
    .waitForURL(url => POST_LOGIN_URL_PATTERN.test(url.href), { timeout: 15000 })
    .then(() => true)
    .catch(() => false);

  if (!redirected) {
    throw new Error(
      '[Browser] Automatic login failed — check VERITONE_USERNAME and VERITONE_PASSWORD in .env',
    );
  }
}

export async function launchAndWaitForLogin(): Promise<BrowserSession> {
  console.log('[Browser] Launching Chromium browser...');

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  });

  const page = await context.newPage();

  await page.goto(VERITONE_LOGIN_URL, { waitUntil: 'domcontentloaded' });

  const username = process.env.VERITONE_USERNAME;
  const password = process.env.VERITONE_PASSWORD;

  if (username && password) {
    await performAutoLogin(page);
  } else {
    await waitForManualLogin(page);
  }

  console.log('[Browser] Login confirmed. Session is active.');

  setActivePage(page);

  return { browser, context, page };
}
