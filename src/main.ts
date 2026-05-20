import 'dotenv/config';
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

runBot()
  .then(() => process.exit(0))
  .catch(async (err: Error) => {
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
