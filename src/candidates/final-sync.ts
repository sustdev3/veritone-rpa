import { Page } from "playwright";
import {
  readAdvertState,
  writeAdvertState,
  AdvertCandidate,
} from "../shared/advert-state";
import { FLAG_COLOUR_MAP } from "./candidate-page-object";

async function waitForStableCards(page: Page): Promise<void> {
  let previousCount = 0;
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(600);
    const currentCount = await page.locator("div.result.searchable").count();
    if (currentCount > 0 && currentCount === previousCount) return;
    previousCount = currentCount;
  }
}

async function readPageCandidates(
  page: Page,
): Promise<Array<{ id: string; name: string; flagged_status: boolean; flag_colour: string | null }>> {
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

      let nonGreyCount = 0;
      let activeColour: string | null = null;
      for (const icon of flagIcons) {
        const color = (icon as HTMLElement).style.color?.trim().toLowerCase() ?? "";
        if (color && color !== "grey" && color !== "gray" && color !== "rgb(128, 128, 128)") {
          nonGreyCount++;
          if (activeColour === null) activeColour = (colourMap as Record<string, string>)[color] ?? color;
        }
      }
      flagged_status = nonGreyCount === 1;
      flag_colour = nonGreyCount === 1 ? activeColour : null;

      return { id, name, flagged_status, flag_colour };
    });
  }, FLAG_COLOUR_MAP);
}

export async function syncFinalGreyCount(
  page: Page,
  advertId: string,
): Promise<{ greyCount: number; lightBlueCount: number }> {
  await page.goto(
    `https://www.adcourier.com/view-vacancy.cgi?advert_id=${advertId}`,
  );
  await page.waitForLoadState("domcontentloaded");
  await page.locator('a[href*="adcresponses"]').first().click();
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(2000);

  const activityText = await page
    .locator("h4#search-activity")
    .textContent()
    .catch(() => "0 Responses");
  const totalFiltered = parseInt(
    activityText?.match(/(\d+)/)?.[1] ?? "0",
    10,
  );

  if (totalFiltered === 0) {
    console.log(`[FinalSync] Advert ${advertId} — 0 filtered candidates, skipping`);
    return { greyCount: 0, lightBlueCount: 0 };
  }

  const existingState = await readAdvertState(advertId);
  const existingCandidates = existingState?.candidates ?? [];
  const existingMap = new Map(existingCandidates.map((c) => [c.id, c]));

  const allScraped: Array<{
    id: string;
    name: string;
    flagged_status: boolean;
    flag_colour: string | null;
  }> = [];
  let pageNumber = 1;

  while (true) {
    const pageCandidates = await readPageCandidates(page);
    allScraped.push(...pageCandidates);

    const nextPageLi = page
      .locator(`div.pager ul li.page-num[title="${pageNumber + 1}"]`)
      .first();
    const nextExists = (await nextPageLi.count()) > 0;
    if (!nextExists) break;

    await page
      .waitForFunction(
        () =>
          (document.querySelector("#gritter-notice-wrapper")
            ?.childElementCount ?? 0) === 0,
        undefined,
        { timeout: 30000 },
      )
      .catch(() => {});

    await nextPageLi.click();
    await page
      .locator(`div.pager ul li.page-num.selected[title="${pageNumber + 1}"]`)
      .first()
      .waitFor({ state: "visible", timeout: 60_000 });
    await waitForStableCards(page);
    pageNumber++;
  }

  // Deduplicate by ID — same candidate can appear on multiple pages under certain filter states
  const uniqueScraped = Array.from(
    new Map(allScraped.map((c) => [c.id, c])).values()
  );

  const scrapedIds = new Set(uniqueScraped.map((c) => c.id));

  const mergedCandidates: AdvertCandidate[] = [
    ...uniqueScraped.map((scraped) => {
      const existing = existingMap.get(scraped.id);
      return {
        id: scraped.id,
        name: scraped.name,
        flagged_status: scraped.flagged_status,
        flag_colour: scraped.flag_colour,
        review_status: existing?.review_status ?? null,
        ai_reason: existing?.ai_reason ?? null,
        rejection_category: existing?.rejection_category ?? null,
        ...(existing?.defaulted !== undefined
          ? { defaulted: existing.defaulted }
          : {}),
      };
    }),
    ...existingCandidates.filter((c) => !scrapedIds.has(c.id)),
  ];

  const greyCount = mergedCandidates.filter((c) => !c.flagged_status).length;
  const lightBlueCount = mergedCandidates.filter((c) => c.flag_colour === 'lightblue').length;

  if (existingState) {
    existingState.candidates = mergedCandidates;
    existingState.totalFiltered = totalFiltered;
    await writeAdvertState(existingState);
  }

  console.log(
    `[FinalSync] Advert ${advertId} — ${pageNumber} page(s), ` +
      `${uniqueScraped.length} candidates in filtered view, ${greyCount} grey (suitable), ${lightBlueCount} light blue (form completed)`,
  );

  return { greyCount, lightBlueCount };
}
