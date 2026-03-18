import { Page } from 'playwright';
import { randomDelay } from '../shared/utils';

export async function navigateToManageAdverts(page: Page): Promise<void> {
  await randomDelay();

  console.log('[Navigation] Navigating to Manage Adverts...');
  await page.locator('a#prim_manage').click();
  await page.waitForLoadState('domcontentloaded');

  const currentUrl = page.url();
  const urlOk = currentUrl.includes('manage-vacancies.cgi');

  const navLinkVisible = await page
    .locator('a#prim_manage')
    .isVisible({ timeout: 10_000 })
    .catch(() => false);

  const navItemActive = await page
    .locator('li.active a#prim_manage')
    .isVisible({ timeout: 5_000 })
    .catch(() => false);

  if (urlOk && navLinkVisible && navItemActive) {
    console.log('[Navigation] Manage Adverts page confirmed.');
  } else {
    throw new Error(
      '[Navigation] Could not confirm Manage Adverts page. ' +
      `URL ok: ${urlOk}, nav link visible: ${navLinkVisible}, nav item active: ${navItemActive}. ` +
      'The page layout may have changed — manual inspection required.'
    );
  }
}
