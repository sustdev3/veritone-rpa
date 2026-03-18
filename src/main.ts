import 'dotenv/config';
import * as cron from 'node-cron';
import { DateTime } from 'luxon';
import { launchAndWaitForLogin } from './browser-session';
import { navigateToManageAdverts } from './adverts/page-navigation';
import { readAndProcessAdverts } from './adverts/advert-reader';
import { cleanupSession } from './shared/utils';
import { loadAllVariables } from './shared/llm-service';

let activeSession: Awaited<ReturnType<typeof launchAndWaitForLogin>> | null = null;

async function runBot() {
  console.log('[Main] Veritone RPA starting...');
  console.log(`[Main] Mode: ${process.env.RUN_MODE ?? 'testing'}`);

  activeSession = await launchAndWaitForLogin();

  console.log('[Main] Loading LLM selections and common keywords...');
  const { llmSelections, commonKeywords } = await loadAllVariables();

  await navigateToManageAdverts(activeSession.page);
  await readAndProcessAdverts(activeSession.page, llmSelections, commonKeywords);

  await cleanupSession(activeSession);
  activeSession = null;
  console.log('[Main] Done.');
}

const runMode = process.env.RUN_MODE ?? 'testing';

if (runMode === 'production') {
  console.log('[Main] Production mode — scheduler active. Waiting for 7:00 PM Sydney time.');
  cron.schedule('0 19 * * *', async () => {
    console.log('[Main] Scheduled run starting...');
    const now = DateTime.now().setZone('Australia/Sydney');
    const h = now.hour;
    if (h >= 7 && h < 19) {
      console.log('[Main] Outside allowed run window (7:00 PM – 7:00 AM). Skipping.');
      return;
    }
    const hardResetTimeout = setTimeout(async () => {
      console.log('[Main] Maximum run time reached — forcing process exit.');
      if (activeSession) {
        await cleanupSession(activeSession).catch(() => {});
      }
      process.exit(0);
    }, 12 * 60 * 60 * 1000);
    await runBot().catch((err: Error) => {
      console.error('[Main] Fatal error:', err.message);
    });
    clearTimeout(hardResetTimeout);
    process.exit(0);
  }, {
    timezone: 'Australia/Sydney',
  });
} else {
  runBot().catch((err: Error) => {
    console.error('[Main] Fatal error:', err.message);
    process.exit(1);
  });
}
