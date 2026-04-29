import 'dotenv/config';
import * as cron from 'node-cron';
import { DateTime } from 'luxon';
import { logger, initFileLogging } from './activity-logger';
import { launchAndWaitForLogin, getActivePage } from './browser-session';
import { navigateToManageAdverts } from './adverts/page-navigation';
import { readAndProcessAdverts } from './adverts/advert-reader';
import { cleanupSession, takeScreenshot } from './shared/utils';
import { loadAllVariables } from './shared/llm-service';
import { sendErrorReportEmail } from './shared/email-service';

console.log = (...args: unknown[]) => logger.info(args.join(' '));
console.warn = (...args: unknown[]) => logger.warn(args.join(' '));
console.error = (...args: unknown[]) => logger.error(args.join(' '));

process.on('uncaughtException', async (err: Error) => {
  console.error('[Main] Uncaught exception:', err.message, err.stack);
  const page = getActivePage();
  let screenshotPath: string | null = null;
  if (page) {
    screenshotPath = await takeScreenshot(page, 'fatal-crash');
  }
  await sendErrorReportEmail(
    `Uncaught exception: ${err.message}\n${err.stack ?? ''}`,
    undefined,
    screenshotPath ?? undefined,
  ).catch(() => {});
  process.exit(1);
});

process.on('unhandledRejection', async (reason: unknown) => {
  const msg = String(reason);
  console.error('[Main] Unhandled rejection:', msg);
  const page = getActivePage();
  let screenshotPath: string | null = null;
  if (page) {
    screenshotPath = await takeScreenshot(page, 'fatal-crash');
  }
  await sendErrorReportEmail(
    `Unhandled rejection: ${msg}`,
    undefined,
    screenshotPath ?? undefined,
  ).catch(() => {});
  process.exit(1);
});

let activeSession: Awaited<ReturnType<typeof launchAndWaitForLogin>> | null = null;

async function runBot() {
  initFileLogging();
  console.log('[Main] Veritone RPA starting...');
  console.log(`[Main] Mode: ${process.env.RUN_MODE ?? 'testing'}`);

  activeSession = await launchAndWaitForLogin();

  console.log('[Main] Loading LLM selections and keyword mapping...');
  const { llmSelections, keywordMapping } = await loadAllVariables();

  await navigateToManageAdverts(activeSession.page);
  await readAndProcessAdverts(activeSession.page, llmSelections, keywordMapping);

  await cleanupSession(activeSession);
  activeSession = null;
  console.log('[Main] Done.');
}

const runMode = process.env.RUN_MODE ?? 'testing';

if (runMode === 'production') {
  console.log('[Main] Production mode — scheduler active. Waiting for 9:00 PM Sydney time.');
  cron.schedule('0 21 * * 0-5', async () => {
    console.log('[Main] Scheduled run starting...');
    const now = DateTime.now().setZone('Australia/Sydney');
    const h = now.hour;
    if (h < 21) {
      console.log('[Main] Outside allowed run window (9:00 PM – 12:00 AM). Skipping.');
      return;
    }
    const hardResetTimeout = setTimeout(async () => {
      console.log('[Main] Maximum run time reached — forcing process exit.');
      if (activeSession) {
        await cleanupSession(activeSession).catch(() => {});
      }
      process.exit(0);
    }, 3 * 60 * 60 * 1000);
    await runBot().catch(async (err: Error) => {
      console.error('[Main] Fatal error:', err.message);
      const page = getActivePage();
      let screenshotPath: string | null = null;
      if (page) screenshotPath = await takeScreenshot(page, 'fatal-crash');
      await sendErrorReportEmail(
        `Fatal error: ${err.message}\n${err.stack ?? ''}`,
        undefined,
        screenshotPath ?? undefined,
      ).catch(() => {});
    });
    clearTimeout(hardResetTimeout);
    process.exit(0);
  }, {
    timezone: 'Australia/Sydney',
  });
} else {
  runBot().catch(async (err: Error) => {
    console.error('[Main] Fatal error:', err.message);
    const page = getActivePage();
    let screenshotPath: string | null = null;
    if (page) screenshotPath = await takeScreenshot(page, 'fatal-crash');
    await sendErrorReportEmail(
      `Fatal error: ${err.message}\n${err.stack ?? ''}`,
      undefined,
      screenshotPath ?? undefined,
    ).catch(() => {});
    process.exit(1);
  });
}
