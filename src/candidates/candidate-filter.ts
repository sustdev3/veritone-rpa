import { Page } from 'playwright';
import path from 'path';
import fs from 'fs/promises';
import { randomDelay } from '../shared/utils';
import { FilterResult, selectKeywordsViaLLM } from './candidate-page-object';

async function enterLocationSelect2(page: Page, suburb: string): Promise<void> {
  await page.locator('.select2-container.unediable-input a.select2-choice').click();
  await page.waitForTimeout(1000);

  await page.locator('#s2id_autogen2_search').pressSequentially(suburb, { delay: 80 });

  await page
    .locator('#select2-drop .select2-result-selectable')
    .first()
    .waitFor({ state: 'visible', timeout: 10_000 });

  await page.locator('#select2-drop .select2-result-selectable:first-child').click();

  const maskGone = await page
    .locator('#select2-drop-mask')
    .waitFor({ state: 'hidden', timeout: 5_000 })
    .then(() => true)
    .catch(() => false);

  if (!maskGone) {
    console.warn('[CandidateFilter] Drop-mask did not close naturally — forcing hidden via DOM.');
    await page.evaluate(() => {
      const mask = document.getElementById('select2-drop-mask');
      if (mask) mask.style.display = 'none';
    });
  }

}

export async function filterCandidates(
  page: Page,
  advertId: string,
  location: string,
  jobTitle: string,
  jobDescription: string,
  llmSelections: Record<string, string>,
  commonKeywords: string[],
): Promise<FilterResult> {
  console.log(`[CandidateFilter] ─── Filtering candidates for advert ${advertId} ───`);

  let savedKeywords: string[] = [];

  const resumeStateFile = path.resolve(process.cwd(), 'temp', `resume-review-${advertId}.json`);
  const resumeStateRaw = await fs.readFile(resumeStateFile, 'utf-8').catch(() => null);
  if (resumeStateRaw !== null) {
    try {
      const data = JSON.parse(resumeStateRaw) as { selectedKeywords?: string[] };
      if (Array.isArray(data.selectedKeywords) && data.selectedKeywords.length > 0) {
        savedKeywords = data.selectedKeywords;
      }
    } catch {}
  }

  if (savedKeywords.length === 0) {
    const passingFile = path.resolve(process.cwd(), 'temp', `passing-${advertId}.json`);
    const passingRaw = await fs.readFile(passingFile, 'utf-8').catch(() => null);
    if (passingRaw !== null) {
      try {
        const data = JSON.parse(passingRaw) as { selectedKeywords?: string[] };
        if (Array.isArray(data.selectedKeywords) && data.selectedKeywords.length > 0) {
          savedKeywords = data.selectedKeywords;
        }
      } catch {}
    }
  }

  await randomDelay();
  await page.locator('a[href*="adcresponses"]').first().click();
  await page.waitForLoadState('domcontentloaded');

  let selectedKeywords: string[];
  if (savedKeywords.length > 0) {
    selectedKeywords = savedKeywords;
    if (resumeStateRaw !== null) {
      console.log(`[CandidateFilter] Reusing keywords from previous run: ${selectedKeywords.join(', ')}`);
    } else {
      console.log(`[CandidateFilter] Reusing keywords from passing file (previous partial run): ${selectedKeywords.join(', ')}`);
    }
  } else {
    selectedKeywords = await selectKeywordsViaLLM(
      jobTitle,
      jobDescription,
      commonKeywords,
      llmSelections,
    );
  }

  await randomDelay();
  const keywordsText = selectedKeywords.join(' OR ');
  await page.locator('textarea.keywords').clear();
  await page.locator('textarea.keywords').fill(keywordsText);

  await randomDelay();
  await page.locator('input[placeholder="30"]').clear();
  await page.locator('input[placeholder="30"]').fill('20');

  await randomDelay();
  await enterLocationSelect2(page, location);

  await randomDelay();
  await page.locator('section#main-criteria button.btn.btn-success').click();
  await page.waitForLoadState('networkidle');

  await page.locator('h4#search-activity').waitFor({ state: 'visible', timeout: 15_000 });

  await page.waitForFunction(
    () => {
      const text = document.querySelector('h4#search-activity')?.textContent ?? '';
      return text.trim() !== '' && !text.includes('Loading') && !text.includes('...');
    },
    { timeout: 15_000, polling: 500 },
  );

  await randomDelay();

  let activityText: string | null = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    activityText = await page
      .locator('h4#search-activity')
      .textContent()
      .catch(() => null);
    if (activityText && activityText.trim() !== '') break;
    if (attempt < 3) {
      console.warn(`[CandidateFilter] Activity text empty on attempt ${attempt} — retrying...`);
      await page.waitForTimeout(3000);
    }
  }

  if (!activityText || activityText.trim() === '') {
    throw new Error(
      '[CandidateFilter] Filter search returned empty activity text after 3 attempts — page may not have loaded correctly',
    );
  }

  const countMatch = activityText?.match(/(\d+)/);
  const filteredCount = countMatch ? parseInt(countMatch[1], 10) : 0;

  console.log(`[CandidateFilter] Filtered result: "${activityText?.trim()}" → count: ${filteredCount}`);

  return { selectedKeywords, filteredCount };
}
