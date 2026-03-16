import { Page } from "playwright";
import { DateTime } from "luxon";
import path from "path";
import fs from "fs/promises";
import { randomDelay } from "../shared/utils";
import {
  appendToExcel,
  markAdvertSkipped,
  finaliseAdvertRow,
  writeAdvertError,
} from "../shared/excel-service";
import { filterCandidates } from "../candidates/candidate-filter";
import { collectPassingCandidates } from "../candidates/candidate-collector";
import { flagFailingCandidates } from "../candidates/candidate-flagger";
import { reviewResumes } from "../resume/resume-reviewer";
import {
  sendRunSummaryEmail,
  sendErrorReportEmail,
  AdvertRunResult,
} from "../shared/email-service";
import { navigateToArchivedAdvertsPage10 } from "./page-navigation";
import {
  AdvertSummary,
  AdvertDetail,
  RawAdvertRow,
  isFatalError,
  classifyError,
  parseAdvertRow,
  filterAndSort,
} from "./advert-page-object";

async function readAdvertList(page: Page): Promise<AdvertSummary[]> {
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

      const refRaw = tds2[1]?.textContent?.trim() ?? "";
      const refNumber = refRaw.replace(/Ref\s*No\.?:?\s*/i, "").trim();

      return {
        advertId: advertIdMatch?.[1] ?? "",
        jobTitle: titleLink?.textContent?.trim() ?? "",
        dateText: tds1[1]?.textContent?.trim() ?? "",
        totalResponses: parseInt(responsesText.match(/\d+/)?.[0] ?? "0", 10),
        consultant: tds1[3]?.textContent?.trim() ?? "",
        refNumber,
        location: tds2[2]?.textContent?.trim() ?? "",
      };
    });
  });

  const adverts: AdvertSummary[] = [];

  for (const r of raw) {
    const parsed = parseAdvertRow(r as RawAdvertRow);
    if (parsed) adverts.push(parsed);
  }

  console.log(`[AdvertReader] Total adverts read: ${adverts.length}`);
  // TESTING ONLY - remove when done
  for (const a of adverts) {
    console.log(`[AdvertReader] Found: ID=${a.advertId} — "${a.jobTitle}"`);
  }
  // TESTING ONLY - remove when done
  return adverts;
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
  if ((process.env.RUN_MODE ?? 'testing') !== 'production') return true;
  const now = DateTime.now().setZone('Australia/Sydney');
  const h = now.hour;
  return h >= 19 || h < 7;
}

export async function readAndProcessAdverts(
  page: Page,
  llmSelections: Record<string, string>,
  commonKeywords: string[],
): Promise<void> {
  console.log(
    "[AdvertReader] ─── Starting advert reader ───────────────────────────",
  );

  // TESTING ONLY - remove when done
  await navigateToArchivedAdvertsPage10(page);
  // TESTING ONLY - remove when done

  const allAdverts = await readAdvertList(page);
  const adverts = filterAndSort(allAdverts);

  if (adverts.length === 0) {
    console.log(
      "[AdvertReader] No adverts within lookback window — nothing to process.",
    );
    return;
  }


  const currentAdvertIds = new Set(adverts.map((a) => a.advertId));
  const tempDir = path.resolve(process.cwd(), "temp");
  const tempFiles = await fs.readdir(tempDir).catch(() => [] as string[]);
  for (const file of tempFiles) {
    const resumeMatch = file.match(/^resume-review-(\d+)\.json$/);
    const passingMatch = file.match(/^passing-(\d+)\.json$/);
    const match = resumeMatch ?? passingMatch;
    if (match && !currentAdvertIds.has(match[1])) {
      await fs.unlink(path.join(tempDir, file));
      console.log(
        `[AdvertReader] Deleted stale state file for advert ${match[1]} — not in current run`,
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
      console.log('[AdvertReader] Run window ended — stopping immediately.');
      shouldStop = true;
      break;
    }

    console.log(
      `\n[AdvertReader] ─── ${advert.jobTitle} (ID: ${advert.advertId}) ───`,
    );

    try {
      await randomDelay();
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
        commonKeywords,
      );

      if (!isWithinRunWindow()) {
        console.log('[AdvertReader] Run window ended — stopping immediately.');
        try { await writeAdvertError('Run stopped — time window ended'); } catch {}
        shouldStop = true;
        break;
      }

      const collectResult = await collectPassingCandidates(
        page,
        advert.advertId,
        filterResult.selectedKeywords,
      );

      if (!isWithinRunWindow()) {
        console.log('[AdvertReader] Run window ended — stopping immediately.');
        try { await writeAdvertError('Run stopped — time window ended'); } catch {}
        shouldStop = true;
        break;
      }

      if (collectResult.totalFiltered === 0) {
        console.log(
          `[AdvertReader] No candidates passed the filter for advert ${advert.advertId} — skipping`,
        );
        await appendToExcel({
          startTime,
          jobTitle: detail.jobTitle,
          location: detail.location,
          jobDescription: detail.jobDescription,
          totalApplications: detail.totalApplicants,
          selectedKeywords: filterResult.selectedKeywords,
          filteredCount: filterResult.filteredCount,
        });
        await markAdvertSkipped();
        runResults.push({
          advertTitle: detail.jobTitle,
          status: 'skipped',
          location: detail.location,
          selectedKeywords: filterResult.selectedKeywords,
          totalApplications: detail.totalApplicants,
          filteredCount: filterResult.filteredCount,
          skippedReason: 'No candidates after keyword and location filter',
        });
      } else {
        const flagResult = await flagFailingCandidates(
          page,
          advert.advertId,
          collectResult.passingCandidates,
        );

        if (!isWithinRunWindow()) {
          console.log('[AdvertReader] Run window ended — stopping immediately.');
          try { await writeAdvertError('Run stopped — time window ended'); } catch {}
          shouldStop = true;
          break;
        }

        console.log(
          `[AdvertReader] Flagging done — ` +
            `flagged purple: ${flagResult.flaggedCount}, ` +
            `skipped (passing): ${flagResult.skippedPassing}, ` +
            `already flagged: ${flagResult.alreadyFlagged}`,
        );

        await appendToExcel({
          startTime,
          jobTitle: detail.jobTitle,
          location: detail.location,
          jobDescription: detail.jobDescription,
          totalApplications: detail.totalApplicants,
          selectedKeywords: filterResult.selectedKeywords,
          filteredCount: filterResult.filteredCount,
        });

        const llmModel =
          llmSelections["resume review"] ?? "claude-haiku-4-5-20251001";
        const reviewResult = await reviewResumes(
          page,
          advert.advertId,
          collectResult.passingCandidates,
          collectResult.totalFiltered,
          llmModel,
          filterResult.selectedKeywords,
        );

        if (!isWithinRunWindow()) {
          console.log('[AdvertReader] Run window ended — stopping immediately.');
          try { await writeAdvertError('Run stopped — time window ended'); } catch {}
          shouldStop = true;
          break;
        }

        console.log(
          `[AdvertReader] Resume review done — ` +
            `passed: ${reviewResult.passCount}, failed: ${reviewResult.failCount}, ` +
            `flagged purple: ${reviewResult.flaggedCount}, skipped: ${reviewResult.skippedCount}, ` +
            `skipped (prev passed): ${reviewResult.skippedPreviouslyPassed}`,
        );

        const endTime = DateTime.now().setZone("Australia/Sydney");
        const elapsedMins = endTime.diff(startTime, "minutes").minutes;
        const elapsedStr = `${elapsedMins.toFixed(1)} mins`;

        await finaliseAdvertRow({
          endTime,
          elapsedStr,
          passCount: reviewResult.passCount,
          generalFilterRejects: reviewResult.generalFilterRejects,
          labouringFilterRejects: reviewResult.labouringFilterRejects,
          heavyLabouringRejects: reviewResult.heavyLabouringRejects,
          employmentDateRejects: reviewResult.employmentDateRejects,
        });

        let passingCandidateNames: string[] = [];
        try {
          const resumeStateRaw = await fs.readFile(
            path.join(tempDir, `resume-review-${advert.advertId}.json`),
            'utf-8',
          );
          const resumeState = JSON.parse(resumeStateRaw) as {
            results: Array<{ name: string; ai_decision: string }>;
          };
          passingCandidateNames = resumeState.results
            .filter((r) => r.ai_decision === 'pass')
            .map((r) => r.name);
        } catch {}

        runResults.push({
          advertTitle: detail.jobTitle,
          status: 'success',
          elapsedStr,
          location: detail.location,
          selectedKeywords: filterResult.selectedKeywords,
          totalApplications: detail.totalApplicants,
          filteredCount: filterResult.filteredCount,
          unflaggedForReview: collectResult.passingCandidates.length,
          generalFilterRejects: reviewResult.generalFilterRejects,
          labouringFilterRejects: reviewResult.labouringFilterRejects,
          heavyLabouringRejects: reviewResult.heavyLabouringRejects,
          employmentDateRejects: reviewResult.employmentDateRejects,
          passCount: reviewResult.passCount,
          skippedPreviouslyPassed: reviewResult.skippedPreviouslyPassed,
          passingCandidateNames,
        });
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);

      if (isFatalError(errMsg)) {
        console.log(
          `[AdvertReader] FATAL ERROR — stopping immediately: ${errMsg}`,
        );
        runResults.push({
          advertTitle: advert.jobTitle,
          status: 'error',
          errorMessage: errMsg,
        });
        try {
          await writeAdvertError(`${advert.jobTitle}: ${errMsg}`);
        } catch {}
        await sendErrorReportEmail(errMsg, advert.jobTitle);
        shouldStop = true;
        break;
      }

      const errorType = classifyError(errMsg);
      const count = (errorTracker.get(errorType) ?? 0) + 1;
      errorTracker.set(errorType, count);
      errorLog.push({ advertTitle: advert.jobTitle, message: errMsg });
      runResults.push({
        advertTitle: advert.jobTitle,
        status: 'error',
        errorMessage: errMsg,
      });

      console.log(
        `[AdvertReader] ERROR processing advert ${advert.advertId}: ${errMsg}`,
      );
      console.log(`[AdvertReader] ERROR type "${errorType}" count: ${count}`);

      try {
        await writeAdvertError(`${advert.jobTitle}: ${errMsg}`);
      } catch {}

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
        );
        shouldStop = true;
      }
    }

    await randomDelay();
    console.log("[AdvertReader] Navigating back to Manage Adverts...");
    await page.locator('a[href*="manage-vacancies"]').first().click();
    await page.waitForLoadState("domcontentloaded");

    if (shouldStop) break;

    // TESTING ONLY - remove when done
    if (advert !== adverts[adverts.length - 1]) {
      await navigateToArchivedAdvertsPage10(page);
    }
    // TESTING ONLY - remove when done
  }


  console.log(
    "\n[AdvertReader] ─── All adverts processed ────────────────────────────",
  );

  await sendRunSummaryEmail(runResults);
}
