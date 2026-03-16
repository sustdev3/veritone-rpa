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

// TESTING ONLY - remove this function when done
export async function navigateToArchivedAdvertsPage10(page: Page): Promise<void> {
  console.log('[Navigation] Clicking "Archived adverts" tab link...');
  await page.locator('a[href*="archive=1"]').first().click();
  await page.waitForLoadState('domcontentloaded');

  for (const pageNum of [5, 6, 7, 8, 9, 10]) {
    console.log(`[Navigation] Clicking page ${pageNum} of Archived Adverts...`);
    await randomDelay();
    await page.locator(`.paginator a:has-text("${pageNum}")`).first().click();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForFunction(
      (num) => !Array.from(document.querySelectorAll('.paginator a')).some(
        (el) => el.textContent?.trim() === String(num),
      ),
      pageNum,
      { timeout: 10000 },
    ).catch(() => {});
  }

  const currentUrl = page.url();
  if (!currentUrl.includes('page=10')) {
    throw new Error(
      `[Navigation] Expected URL to contain "page=10" but got: ${currentUrl}`,
    );
  }

  console.log('[Navigation] Navigated to Archived Adverts page 10');
}
// TESTING ONLY - remove this function when done

// TESTING ONLY - remove this function when done
export async function navigateToArchivedAdverts(page: Page): Promise<void> {
  console.log('[Navigation] Clicking "Archived adverts" tab link...');
  await page.locator('a[href*="archive=1"]').click();
  await page.waitForLoadState('domcontentloaded');

  const currentUrl = page.url();
  if (!currentUrl.includes('archive=1')) {
    throw new Error(
      `[Navigation] Expected URL to contain "archive=1" but got: ${currentUrl}`
    );
  }

  console.log('[Navigation] Navigated to Archived Adverts page');
}
// TESTING ONLY - remove this function when done
