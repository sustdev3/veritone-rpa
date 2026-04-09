import { Page } from "playwright";
import { DateTime } from "luxon";
import path from "path";
import fs from "fs/promises";
import { randomDelay, heavyLoadDelay, takeScreenshot } from "../shared/utils";
// import { appendToExcel } from "../shared/excel-service";
import { filterCandidates } from "../candidates/candidate-filter";
import { collectPassingCandidates } from "../candidates/candidate-collector";
import { flagFailingCandidates } from "../candidates/candidate-flagger";
import { reviewResumes } from "../resume/resume-reviewer";
import {
  sendRunSummaryEmail,
  sendErrorReportEmail,
  AdvertRunResult,
  AdvertListEntry,
} from "../shared/email-service";
import {
  AdvertSummary,
  AdvertDetail,
  RawAdvertRow,
  DEFAULT_LOOKBACK_DAYS,
  isFatalError,
  classifyError,
  parseAdvertRow,
  filterAndSort,
} from "./advert-page-object";

async function readAdvertList(page: Page): Promise<AdvertSummary[]> {
  const lookbackDays = parseInt(
    process.env.LOOKBACK_DAYS ?? String(DEFAULT_LOOKBACK_DAYS),
    10,
  );
  const cutoff = DateTime.now().minus({ days: lookbackDays }).startOf("day");

  const allAdverts: AdvertSummary[] = [];
  const urlPageMatch = page.url().match(/[?&]page=(\d+)/);
  let pageNumber = urlPageMatch ? parseInt(urlPageMatch[1], 10) : 1;

  while (true) {
    console.log(`[AdvertReader] Reading adverts page ${pageNumber}...`);

    const raw = await page.evaluate(() => {
      const rows1 = document.querySelectorAll("tr.va-top.advert.last");

      return Array.from(rows1).map((row1) => {
        const row2 = row1.nextElementSibling as HTMLElement | null;
        const tds1 = row1.querySelectorAll("td");
        const tds2 =
          row2?.querySelectorAll("td") ??
          ([] as unknown as NodeListOf<HTMLElement>);

        const responseSpan = row1.querySelector('span[title*="Total"]');
        const responsesText = responseSpan?.textContent?.trim() ?? "0";

        const titleLink = row1.querySelector(
          "a.jobtitle.no_dragdrop",
        ) as HTMLAnchorElement | null;
        const href = titleLink?.getAttribute("href") ?? "";
        const advertIdMatch = href.match(/advert_id=(\d+)/);

        const refRaw = tds2[0]?.textContent?.trim() ?? "";
        const refNumber = refRaw.replace(/Ref\s*No\.?:?\s*/i, "").trim();

        return {
          advertId: advertIdMatch?.[1] ?? "",
          jobTitle: titleLink?.textContent?.trim() ?? "",
          dateText: tds1[1]?.textContent?.trim() ?? "",
          totalResponses: parseInt(responsesText.match(/\d+/)?.[0] ?? "0", 10),
          consultant: tds1[3]?.textContent?.trim() ?? "",
          refNumber,
          location: tds2[1]?.textContent?.trim() ?? "",
        };
      });
    });

    const pageAdverts: AdvertSummary[] = [];
    for (const r of raw) {
      const parsed = parseAdvertRow(r as RawAdvertRow, pageNumber);
      if (parsed) pageAdverts.push(parsed);
    }

    allAdverts.push(...pageAdverts);

    const hasOldAdvert = pageAdverts.some((a) => a.datePosted < cutoff);
    if (hasOldAdvert) break;

    const nextPageNumber = pageNumber + 1;
    const nextLink = page
      .locator(".paginator a")
      .filter({ hasText: new RegExp(`^${nextPageNumber}$`) });

    if ((await nextLink.count()) === 0) break;

    await randomDelay();
    await nextLink.first().click();
    await page.waitForLoadState("domcontentloaded");
    pageNumber++;
  }

  console.log(`[AdvertReader] Total adverts read: ${allAdverts.length}`);
  return allAdverts;
}

async function extractAdvertDetail(
  page: Page,
  advert: AdvertSummary,
): Promise<AdvertDetail> {
  const jobTitleRaw = await page
    .locator("div#original_title")
    .first()
    .textContent()
    .catch(() => null);
  const jobTitle = jobTitleRaw?.trim() ?? advert.jobTitle;

  const locationRaw = await page
    .locator("th:has-text('Location:') + td")
    .first()
    .textContent()
    .catch(() => null);
  const location = locationRaw?.trim() ?? advert.location;

  const jobDescription = await page
    .frameLocator("iframe#description_org")
    .locator("body")
    .textContent()
    .catch(() => "");

  const totalApplicants = await page.evaluate(() => {
    const cells = document.querySelectorAll(
      'table.board_status td[style*="text-align: center"]',
    );
    return Array.from(cells).reduce((sum, td) => {
      const n = parseInt(td.textContent?.trim() ?? "0", 10);
      return sum + (isNaN(n) ? 0 : n);
    }, 0);
  });

  return {
    jobTitle,
    location,
    jobDescription: jobDescription?.trim() ?? "",
    totalApplicants,
  };
}

function isWithinRunWindow(): boolean {
  if ((process.env.RUN_MODE ?? "testing") !== "production") return true;
  const now = DateTime.now().setZone("Australia/Sydney");
  const h = now.hour;
  return h >= 19 || h < 7;
}

export async function readAndProcessAdverts(
  page: Page,
  llmSelections: Record<string, string>,
  keywordMapping: import("../shared/llm-service").KeywordMappingEntry[],
): Promise<void> {
  console.log(
    "[AdvertReader] ─── Starting advert reader ───────────────────────────",
  );

  const allAdverts = await readAdvertList(page);
  await page.locator("a#prim_manage").click();
  await page.waitForLoadState("domcontentloaded");
  const adverts = filterAndSort(allAdverts);

  if (adverts.length === 0) {
    console.log(
      "[AdvertReader] No adverts within lookback window — nothing to process.",
    );
    return;
  }

  const allAdvertsMap = new Map(allAdverts.map((a) => [a.advertId, a]));
  const lookbackDays = parseInt(
    process.env.LOOKBACK_DAYS ?? String(DEFAULT_LOOKBACK_DAYS),
    10,
  );
  const cutoff = DateTime.now().minus({ days: lookbackDays }).startOf("day");
  const tempDir = path.resolve(process.cwd(), "temp");
  const tempFiles = await fs.readdir(tempDir).catch(() => [] as string[]);

  for (const file of tempFiles) {
    const resumeMatch = file.match(/^resume-review-(\d+)\.json$/);
    const passingMatch = file.match(/^passing-(\d+)\.json$/);
    const match = resumeMatch ?? passingMatch;
    if (!match) continue;

    const advertId = match[1];
    const advertEntry = allAdvertsMap.get(advertId);

    if (advertEntry) {
      if (advertEntry.datePosted < cutoff) {
        await fs.unlink(path.join(tempDir, file));
        console.log(
          `[AdvertReader] Deleted stale state file: ${file} — outside lookback window`,
        );
      }
    } else {
      await fs.unlink(path.join(tempDir, file));
      console.log(
        `[AdvertReader] Deleted stale state file: ${file} — no longer visible in advert list`,
      );
    }
  }

  console.log(
    `[AdvertReader] Will process ${adverts.length} advert(s) (newest first).`,
  );

  const errorTracker = new Map<string, number>();
  const errorLog: Array<{ advertTitle: string; message: string }> = [];
  const runResults: AdvertRunResult[] = [];
  let shouldStop = false;

  for (const advert of adverts) {
    const startTime = DateTime.now();

    if (!isWithinRunWindow()) {
      console.log("[AdvertReader] Run window ended — stopping immediately.");
      shouldStop = true;
      break;
    }

    console.log(
      `\n[AdvertReader] ─── ${advert.jobTitle} (ID: ${advert.advertId}) ───`,
    );

    try {
      await randomDelay();
      if (advert.listPage > 1) {
        const pageLink = page
          .locator(".paginator a")
          .filter({ hasText: new RegExp(`^${advert.listPage}$`) });
        await pageLink.first().click();
        await page.waitForLoadState("domcontentloaded");
      }
      await page
        .locator(`a.jobtitle.no_dragdrop[href*="advert_id=${advert.advertId}"]`)
        .click();
      await page.waitForLoadState("domcontentloaded");

      const detail = await extractAdvertDetail(page, advert);

      const filterResult = await filterCandidates(
        page,
        advert.advertId,
        detail.location,
        detail.jobTitle,
        detail.jobDescription,
        llmSelections,
        keywordMapping,
      );

      if (!isWithinRunWindow()) {
        console.log("[AdvertReader] Run window ended — stopping immediately.");
        shouldStop = true;
        break;
      }

      const collectResult = await collectPassingCandidates(
        page,
        advert.advertId,
        filterResult.selectedKeywords,
      );

      if (!isWithinRunWindow()) {
        console.log("[AdvertReader] Run window ended — stopping immediately.");
        shouldStop = true;
        break;
      }

      if (collectResult.totalFiltered === 0) {
        console.log(
          `[AdvertReader] No candidates passed the filter for advert ${advert.advertId} — skipping`,
        );
        // await appendToExcel({
        //   datePosted: advert.datePosted.toFormat('dd/MM/yyyy'),
        //   refNumber: advert.refNumber,
        //   jobTitle: detail.jobTitle,
        //   location: detail.location,
        //   keywordsUsed: filterResult.selectedKeywords.join(', '),
        //   totalApplications: detail.totalApplicants,
        //   filteredCount: filterResult.filteredCount,
        //   passingCandidatesCount: 0,
        // });
        runResults.push({
          advertTitle: detail.jobTitle,
          status: "skipped",
          refNumber: advert.refNumber,
          datePostedIso: advert.datePosted.toISO() ?? undefined,
          location: detail.location,
          selectedKeywords: filterResult.selectedKeywords,
          totalApplications: detail.totalApplicants,
          filteredCount: filterResult.filteredCount,
          skippedReason: "No candidates after keyword and location filter",
        });
      } else {
        const flagResult = await flagFailingCandidates(
          page,
          advert.advertId,
          collectResult.passingCandidates,
          advert.totalResponses,
          collectResult.previousLastProcessedId,
        );

        if (!isWithinRunWindow()) {
          console.log(
            "[AdvertReader] Run window ended — stopping immediately.",
          );
          shouldStop = true;
          break;
        }

        console.log(
          `[AdvertReader] Flagging done — ` +
            `flagged purple: ${flagResult.flaggedCount}, ` +
            `skipped (passing): ${flagResult.skippedPassing}, ` +
            `already flagged: ${flagResult.alreadyFlagged}, ` +
            `new candidates: ${collectResult.newCandidatesCount}`,
        );

        // await appendToExcel({
        //   datePosted: advert.datePosted.toFormat('dd/MM/yyyy'),
        //   refNumber: advert.refNumber,
        //   jobTitle: detail.jobTitle,
        //   location: detail.location,
        //   keywordsUsed: filterResult.selectedKeywords.join(', '),
        //   totalApplications: detail.totalApplicants,
        //   filteredCount: filterResult.filteredCount,
        //   passingCandidatesCount: collectResult.passingCandidates.filter((c) => !c.flagged_status).length,
        // });

        const llmModel =
          llmSelections["resume review"] ?? "claude-haiku-4-5-20251001";
        const reviewResult = await reviewResumes(
          page,
          advert.advertId,
          collectResult.newCandidates,
          collectResult.totalFiltered,
          llmModel,
          filterResult.selectedKeywords,
          new Set(collectResult.passingCandidates.map((c) => c.id)),
        );

        if (!isWithinRunWindow()) {
          console.log(
            "[AdvertReader] Run window ended — stopping immediately.",
          );
          shouldStop = true;
          break;
        }

        console.log(
          `[AdvertReader] Resume review done — ` +
            `passed: ${reviewResult.passCount}, failed: ${reviewResult.failCount}, ` +
            `flagged purple: ${reviewResult.flaggedCount}, skipped: ${reviewResult.skippedCount}, ` +
            `skipped (prev passed): ${reviewResult.skippedPreviouslyPassed}, ` +
            `new candidates reviewed: ${reviewResult.newCandidatesReviewed}`,
        );

        const endTime = DateTime.now().setZone("Australia/Sydney");
        const elapsedMins = endTime.diff(startTime, "minutes").minutes;
        const elapsedStr = `${elapsedMins.toFixed(1)} mins`;

        runResults.push({
          advertTitle: detail.jobTitle,
          status: "success",
          refNumber: advert.refNumber,
          datePostedIso: advert.datePosted.toISO() ?? undefined,
          elapsedStr,
          location: detail.location,
          selectedKeywords: filterResult.selectedKeywords,
          totalApplications: detail.totalApplicants,
          filteredCount: filterResult.filteredCount,
          unflaggedForReview:
            collectResult.newCandidates.filter((c) => !c.flagged_status).length,
          generalFilterRejects: reviewResult.generalFilterRejects,
          labouringFilterRejects: reviewResult.labouringFilterRejects,
          heavyLabouringRejects: reviewResult.heavyLabouringRejects,
          employmentDateRejects: reviewResult.employmentDateRejects,
          civilLabourerRejects: reviewResult.civilLabourerRejects,
          productionWorkerRejects: reviewResult.productionWorkerRejects,
          passCount: reviewResult.passCount,
          skippedPreviouslyPassed: reviewResult.skippedPreviouslyPassed,
          defaultedToPassCount: reviewResult.defaultedToPassCount,
        });
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);

      const screenshotPath = await takeScreenshot(
        page,
        `error-advert-${advert.advertId}`,
      );

      if (isFatalError(errMsg)) {
        console.log(
          `[AdvertReader] FATAL ERROR — stopping immediately: ${errMsg}`,
        );
        runResults.push({
          advertTitle: advert.jobTitle,
          status: "error",
          datePostedIso: advert.datePosted.toISO() ?? undefined,
          errorMessage: errMsg,
        });
        await sendErrorReportEmail(errMsg, advert.jobTitle, screenshotPath ?? undefined);
        shouldStop = true;
        break;
      }

      const errorType = classifyError(errMsg);
      const count = (errorTracker.get(errorType) ?? 0) + 1;
      errorTracker.set(errorType, count);
      errorLog.push({ advertTitle: advert.jobTitle, message: errMsg });
      runResults.push({
        advertTitle: advert.jobTitle,
        status: "error",
        datePostedIso: advert.datePosted.toISO() ?? undefined,
        errorMessage: errMsg,
      });

      console.log(
        `[AdvertReader] ERROR processing advert ${advert.advertId}: ${errMsg} | Screenshot: ${screenshotPath ?? "none"}`,
      );
      console.log(`[AdvertReader] ERROR type "${errorType}" count: ${count}`);

      if (count >= 2) {
        console.log(
          `[AdvertReader] STOPPING — repeated "${errorType}" error detected`,
        );
        const errorBody = errorLog
          .map((e) => `${e.advertTitle}: ${e.message}`)
          .join("\n");
        await sendErrorReportEmail(
          `Repeated "${errorType}" error. Errors encountered:\n${errorBody}`,
          advert.jobTitle,
          screenshotPath ?? undefined,
        );
        shouldStop = true;
      }
    }

    await (advert.totalResponses >= 800 ? heavyLoadDelay() : randomDelay());
    console.log("[AdvertReader] Navigating back to Manage Adverts...");
    await page.locator('a[href*="manage-vacancies"]').first().click();
    await page.waitForLoadState("domcontentloaded");

    if (shouldStop) break;
  }

  console.log(
    "\n[AdvertReader] ─── All adverts processed ────────────────────────────",
  );

  const emailLookbackDays = parseInt(
    process.env.LOOKBACK_DAYS ?? String(DEFAULT_LOOKBACK_DAYS),
    10,
  );
  const emailCutoff = DateTime.now()
    .minus({ days: emailLookbackDays })
    .startOf("day");
  const advertList: AdvertListEntry[] = allAdverts
    .filter((a) => a.datePosted >= emailCutoff)
    .map((a) => ({
      advertId: a.advertId,
      jobTitle: a.jobTitle,
      datePostedIso: a.datePosted.toISO() ?? "",
      refNumber: a.refNumber,
      location: a.location,
      totalResponses: a.totalResponses,
    }));

  await sendRunSummaryEmail(runResults, advertList);
}
