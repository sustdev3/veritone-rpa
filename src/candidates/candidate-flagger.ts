import { Page } from 'playwright';
import { PassingCandidate, FLAG_COLOUR_MAP, CardData, FlagResult, classifyCards } from './candidate-page-object';
import { randomDelay, heavyLoadDelay } from '../shared/utils';

async function classifyPageCandidates(
  page: Page,
  passingIds: Set<string>,
): Promise<ReturnType<typeof classifyCards>> {
  const cards: CardData[] = await page.evaluate((colourMap) => {
    const elements = document.querySelectorAll('div.result.searchable');
    return Array.from(elements).map((card) => {
      const id = card.getAttribute('external-candidate-id') ?? '';
      const nameEl = card.querySelector('h4.mt-4 span.font-md');
      const name = nameEl?.textContent?.trim() ?? '';

      const flagIcons = Array.from(
        card.querySelectorAll('div.ranking-flags i.icon-flag-circled'),
      );

      let nonGreyCount = 0;
      let activeColour: string | null = null;

      for (const icon of flagIcons) {
        const color = (icon as HTMLElement).style.color?.trim().toLowerCase() ?? '';
        if (color && color !== 'grey' && color !== 'gray') {
          nonGreyCount++;
          if (activeColour === null) {
            activeColour = colourMap[color] ?? color;
          }
        }
      }

      return { id, name, nonGreyCount, activeColour };
    });
  }, FLAG_COLOUR_MAP);

  return classifyCards(cards, passingIds);
}

export async function flagFailingCandidates(
  page: Page,
  advertId: string,
  passingCandidates: PassingCandidate[],
  totalResponses: number,
): Promise<FlagResult> {
  await page.goto(
    `https://www.adcourier.com/view-vacancy.cgi?advert_id=${advertId}`,
  );
  await page.waitForLoadState('domcontentloaded');
  await page.locator('a[href*="adcresponses"]').first().click();
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000);
  console.log(
    `[CandidateFlagger] Navigated to unfiltered responses for advert ${advertId}`,
  );

  const passingIds = new Set(passingCandidates.map((c) => c.id));

  let totalSkipped = 0;
  let flaggedCount = 0;
  let alreadyFlaggedCount = 0;
  let pageNumber = 1;

  while (true) {
    const { noFlag, alreadyFlagged, skipped } = await classifyPageCandidates(page, passingIds);
    totalSkipped += skipped;
    alreadyFlaggedCount += alreadyFlagged.length;

    for (const candidate of noFlag) {
      const flagIcon = page.locator(
        `div.result.searchable[external-candidate-id="${candidate.id}"] i.candidate-flag-rank-21`,
      );
      await page.waitForTimeout(600);
      await flagIcon.click();
      await page.waitForTimeout(800);
      await randomDelay();
      flaggedCount++;
    }

    await (totalResponses >= 800 ? heavyLoadDelay() : randomDelay());

    const nextPageLi = page.locator('div.pager ul li.page-num.selected + li.page-num').first();
    const nextExists = (await nextPageLi.count()) > 0;
    if (!nextExists) break;

    await page.waitForFunction(
      () => (document.querySelector('#gritter-notice-wrapper')?.childElementCount ?? 0) === 0,
      { timeout: 10000 },
    ).catch(() => {});

    await nextPageLi.click();
    await page.waitForSelector(
      `div.pager ul li.page-num.selected[title="${pageNumber + 1}"]`,
      { timeout: 20000 },
    );
    await page.waitForTimeout(1000);
    pageNumber++;
  }

  console.log(
    `[CandidateFlagger] Done — ${flaggedCount} flagged purple, ` +
    `${totalSkipped} passed filter (skipped), ${alreadyFlaggedCount} already flagged (skipped)`,
  );

  return {
    skippedPassing: totalSkipped,
    flaggedCount,
    alreadyFlagged: alreadyFlaggedCount,
  };
}
