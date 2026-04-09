import { Page } from "playwright";
import { DateTime } from "luxon";
import path from "path";
import fs from "fs/promises";
import { randomDelay, heavyLoadDelay } from "../shared/utils";
import {
  PassingCandidate,
  CollectResult,
  FLAG_COLOUR_MAP,
  buildCollectSummary,
} from "./candidate-page-object";

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
    return { passingCandidates: [], newCandidates: [], totalFiltered: 0, newCandidatesCount: 0, previousLastProcessedId: null, existingUnflaggedCount: 0 };
  }

  const tempDir = path.resolve(process.cwd(), "temp");
  const outputPath = path.join(tempDir, `passing-${advertId}.json`);

  let existingLastProcessedId: string | null = null;
  let existingCandidates: PassingCandidate[] = [];

  const existingRaw = await fs.readFile(outputPath, "utf-8").catch(() => null);
  if (existingRaw !== null) {
    try {
      const existingFile = JSON.parse(existingRaw) as {
        lastProcessedId?: string | null;
        passingCandidates: PassingCandidate[];
      };
      existingLastProcessedId = existingFile.lastProcessedId ?? null;
      existingCandidates = existingFile.passingCandidates ?? [];
    } catch {
      existingCandidates = [];
    }
  }

  const existingIds = new Set(existingCandidates.map((c) => c.id));
  const allScrapedCandidates: PassingCandidate[] = [];
  let pageNumber = 1;
  let isFirstPage = true;

  // Pre-fetch page 1 to capture newLastProcessedId before entering the loop
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

  // All scraped candidates have fresh flag status from the DOM
  const newCandidates = allScrapedCandidates.filter((c) => !existingIds.has(c.id));
  const freshExistingCandidates = allScrapedCandidates.filter((c) => existingIds.has(c.id));
  const existingUnflaggedCount = freshExistingCandidates.filter((c) => !c.flagged_status).length;

  // mergedCandidates = all scraped candidates (fresh flag status for everyone)
  const mergedCandidates = allScrapedCandidates;

  const { unflaggedCount, flaggedCount, colourSummary } =
    buildCollectSummary(mergedCandidates);
  console.log(
    `[CandidateCollector] ${unflaggedCount} unflagged, ${flaggedCount} already flagged` +
      (colourSummary ? ` (colours: ${colourSummary})` : ""),
  );

  await fs.mkdir(tempDir, { recursive: true });

  const output = {
    advertId,
    collectedAt: DateTime.now().toISO(),
    totalFiltered,
    selectedKeywords: selectedKeywords[0] ?? "",
    lastProcessedId: newLastProcessedId,
    passingCandidates: mergedCandidates,
  };

  await fs.writeFile(outputPath, JSON.stringify(output, null, 2), "utf-8");

  return { passingCandidates: mergedCandidates, newCandidates, totalFiltered, newCandidatesCount: newCandidates.length, previousLastProcessedId: existingLastProcessedId, existingUnflaggedCount };
}
