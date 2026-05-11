import { Page } from "playwright";
import { DateTime } from "luxon";
import { randomDelay, heavyLoadDelay } from "../shared/utils";
import {
  PassingCandidate,
  CollectResult,
  FLAG_COLOUR_MAP,
  buildCollectSummary,
} from "./candidate-page-object";
import {
  readAdvertState,
  writeAdvertState,
  AdvertCandidate,
  AdvertStateFile,
} from "../shared/advert-state";

async function waitForStableCards(page: Page): Promise<void> {
  let previousCount = 0;
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(600);
    const currentCount = await page.locator("div.result.searchable").count();
    if (currentCount > 0 && currentCount === previousCount) return;
    previousCount = currentCount;
  }
}

async function collectPageCandidates(page: Page): Promise<PassingCandidate[]> {
  return page.evaluate((colourMap) => {
    const cards = document.querySelectorAll("div.result.searchable");
    return Array.from(cards).map((card) => {
      const id = card.getAttribute("external-candidate-id") ?? "";
      const nameEl = card.querySelector("h4.mt-4 span.font-md");
      const name = nameEl?.textContent?.trim() ?? "";

      const flagIcons = Array.from(
        card.querySelectorAll("div.ranking-flags i.icon-flag-circled"),
      );
      let flagged_status = false;
      let flag_colour: string | null = null;

      const hasGreyIcon = flagIcons.some((icon) => {
        const color =
          (icon as HTMLElement).style.color?.trim().toLowerCase() ?? "";
        return color === "grey" || color === "gray";
      });

      if (hasGreyIcon) {
        for (const icon of flagIcons) {
          const color =
            (icon as HTMLElement).style.color?.trim().toLowerCase() ?? "";
          if (color && color !== "grey" && color !== "gray") {
            flagged_status = true;
            flag_colour = colourMap[color] ?? color;
            break;
          }
        }
      }

      return { id, name, flagged_status, flag_colour };
    });
  }, FLAG_COLOUR_MAP);
}

export async function collectPassingCandidates(
  page: Page,
  advertId: string,
  selectedKeywords: string[],
): Promise<CollectResult> {
  const activityText = await page
    .locator("h4#search-activity")
    .textContent()
    .catch(() => "0 Responses");

  const countMatch = activityText?.match(/(\d+)/);
  const totalFiltered = countMatch ? parseInt(countMatch[1], 10) : 0;

  if (totalFiltered === 0) {
    return { passingCandidates: [], newCandidates: [], totalFiltered: 0, newCandidatesCount: 0, previousLastProcessedId: null };
  }

  const existingState = await readAdvertState(advertId);
  const existingCollectionLastProcessedId = existingState?.collectionLastProcessedId ?? null;
  const existingCandidates: AdvertCandidate[] = existingState?.candidates ?? [];
  const existingIds = new Set(existingCandidates.map((c) => c.id));

  const allScrapedCandidates: PassingCandidate[] = [];
  let pageNumber = 1;
  let isFirstPage = true;

  const firstPageCards = await collectPageCandidates(page);
  const newLastProcessedId: string | null = firstPageCards[0]?.id ?? null;

  while (true) {
    const pageCandidates = isFirstPage ? firstPageCards : await collectPageCandidates(page);
    isFirstPage = false;

    allScrapedCandidates.push(...pageCandidates);

    const nextPageLi = page
      .locator("div.pager ul li.page-num.selected + li.page-num")
      .first();
    const nextExists = (await nextPageLi.count()) > 0;
    if (!nextExists) break;

    await (totalFiltered >= 800 ? heavyLoadDelay() : randomDelay());
    await page
      .waitForFunction(
        () =>
          (document.querySelector("#gritter-notice-wrapper")
            ?.childElementCount ?? 0) === 0,
        { timeout: 30000 },
      )
      .catch(() => {});
    await nextPageLi.click();
    await page
      .locator(`div.pager ul li.page-num.selected[title="${pageNumber + 1}"]`)
      .first()
      .waitFor({ state: "visible", timeout: 25_000 });
    await waitForStableCards(page);
    pageNumber++;
  }

  const scrapedIds = new Set(allScrapedCandidates.map((c) => c.id));
  const newCandidates = allScrapedCandidates.filter((c) => !existingIds.has(c.id));

  // Merge: scraped candidates get fresh flag status; preserve existing review data
  const mergedCandidates: AdvertCandidate[] = [
    ...allScrapedCandidates.map((scraped) => {
      const existing = existingCandidates.find((e) => e.id === scraped.id);
      return {
        id: scraped.id,
        name: scraped.name,
        flagged_status: scraped.flagged_status,
        flag_colour: scraped.flag_colour,
        review_status: existing?.review_status ?? null,
        ai_reason: existing?.ai_reason ?? null,
        rejection_category: existing?.rejection_category ?? null,
        ...(existing?.defaulted !== undefined ? { defaulted: existing.defaulted } : {}),
      };
    }),
    // Keep existing candidates not seen on the filtered page this run
    ...existingCandidates.filter((c) => !scrapedIds.has(c.id)),
  ];

  const { unflaggedCount, flaggedCount, colourSummary } =
    buildCollectSummary(allScrapedCandidates);
  console.log(
    `[CandidateCollector] ${unflaggedCount} unflagged, ${flaggedCount} already flagged` +
      (colourSummary ? ` (colours: ${colourSummary})` : ""),
  );

  const newState: AdvertStateFile = {
    advertId,
    updatedAt: DateTime.now().toISO()!,
    selectedKeywords: selectedKeywords[0] ?? existingState?.selectedKeywords ?? "",
    ruleset: existingState?.ruleset ?? null,
    collectionLastProcessedId: newLastProcessedId,
    reviewLastProcessedId: existingState?.reviewLastProcessedId ?? null,
    totalFiltered,
    candidates: mergedCandidates,
  };

  await writeAdvertState(newState);

  // Build PassingCandidate[] (used by flagger — runtime only, not persisted)
  const passingCandidates: PassingCandidate[] = allScrapedCandidates;
  const newPassingCandidates: PassingCandidate[] = newCandidates;

  return {
    passingCandidates,
    newCandidates: newPassingCandidates,
    totalFiltered,
    newCandidatesCount: newCandidates.length,
    previousLastProcessedId: existingCollectionLastProcessedId,
  };
}
