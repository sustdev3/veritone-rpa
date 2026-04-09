import { Page } from "playwright";
import { DateTime } from "luxon";
import path from "path";
import fs from "fs/promises";
import { PassingCandidate } from "../candidates/candidate-page-object";
import { callLLM } from "../shared/llm-service";
import { randomDelay } from "../shared/utils";
import { buildReviewPrompt } from "../prompts/review-resume";
import {
  ReviewResult,
  ReviewSummary,
  validateLlmResponse,
  tallyRejectionCounts,
} from "./resume-page-object";

export async function reviewResumes(
  page: Page,
  advertId: string,
  passingCandidates: PassingCandidate[],
  totalFiltered: number,
  llmModel: string,
  selectedKeywords: string[],
): Promise<ReviewSummary> {
  const strictMode = totalFiltered > 60;

  if (strictMode) {
    console.log(
      `[ResumeReviewer] Ruleset: strict (filtered count: ${totalFiltered})`,
    );
  } else {
    console.log(
      `[ResumeReviewer] Ruleset: standard (filtered count: ${totalFiltered})`,
    );
  }

  const rejectionCriteriaPath = path.resolve(
    process.cwd(),
    "config",
    "rejection-filters.md",
  );
  const rejectionCriteria = await fs.readFile(rejectionCriteriaPath, "utf-8");

  const tempDir = path.resolve(process.cwd(), "temp");
  const outputPath = path.join(tempDir, `resume-review-${advertId}.json`);

  let previousResults: ReviewResult[] = [];
  const previouslyPassedIds = new Set<string>();
  let defaultedToPassCount = 0;
  let existingLastProcessedId: string | null = null;

  const previousRaw = await fs.readFile(outputPath, "utf-8").catch(() => null);
  if (previousRaw !== null) {
    try {
      const previousFile = JSON.parse(previousRaw) as {
        results: ReviewResult[];
        lastProcessedId?: string | null;
      };
      previousResults = previousFile.results ?? [];
      existingLastProcessedId = previousFile.lastProcessedId ?? null;
      for (const r of previousResults) {
        if (r.ai_decision === "pass") {
          previouslyPassedIds.add(r.id);
          if (r.defaulted) defaultedToPassCount++;
        }
      }
      console.log(
        `[ResumeReviewer] Found previous run state for advert ${advertId} — ` +
          `skipping ${previouslyPassedIds.size} previously passed candidates`,
      );
    } catch {
      previousResults = [];
    }
  }

  await page.goto(
    `https://www.adcourier.com/view-vacancy.cgi?advert_id=${advertId}`,
  );
  await page.waitForLoadState("domcontentloaded");
  await page.locator('a[href*="adcresponses"]').first().click();
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(2000);

  const toReviewMap = new Map(
    passingCandidates.filter((c) => !c.flagged_status).map((c) => [c.id, c]),
  );
  const skippedCount = passingCandidates.length - toReviewMap.size;
  console.log(
    `[ResumeReviewer] ${toReviewMap.size} candidates to review ` +
      `(${skippedCount} already flagged — skipped)`,
  );

  // Capture newLastProcessedId from first visible card before the loop
  let newLastProcessedId: string | null = null;
  const firstVisibleIds: string[] = await page.evaluate(() =>
    Array.from(document.querySelectorAll("div.result.searchable")).map(
      (el) => el.getAttribute("external-candidate-id") ?? "",
    ),
  );
  if (firstVisibleIds.length > 0) newLastProcessedId = firstVisibleIds[0];

  const results: ReviewResult[] = [];
  let flaggedCount = 0;
  let skippedPreviouslyPassed = 0;
  let newCandidatesReviewed = 0;
  let pageNumber = 1;
  let bookmarkFound = false;
  let consecutivePagesWithZeroNew = 0;
  const FALLBACK_THRESHOLD = 3;
  const llmSelections = { "resume review": llmModel };

  while (true) {
    let visibleIds: string[] = await page.evaluate(() =>
      Array.from(document.querySelectorAll("div.result.searchable")).map(
        (el) => el.getAttribute("external-candidate-id") ?? "",
      ),
    );

    if (existingLastProcessedId !== null && !bookmarkFound) {
      const bookmarkIndex = visibleIds.findIndex(
        (id) => id === existingLastProcessedId,
      );
      if (bookmarkIndex !== -1) {
        bookmarkFound = true;
        visibleIds = visibleIds.slice(0, bookmarkIndex);
        console.log(
          `[ResumeReviewer] Bookmark reached at candidate ${existingLastProcessedId} — stopping pagination`,
        );
      } else {
        consecutivePagesWithZeroNew++;
        if (consecutivePagesWithZeroNew >= FALLBACK_THRESHOLD) {
          console.log(
            `[ResumeReviewer] Bookmark not found after ${FALLBACK_THRESHOLD} empty pages — stopping pagination`,
          );
          break;
        }
      }
    }

    const pageToReview = visibleIds.filter((id) => toReviewMap.has(id));

    for (const id of pageToReview) {
      if (previouslyPassedIds.has(id)) {
        skippedPreviouslyPassed++;
        continue;
      }

      const candidate = toReviewMap.get(id)!;

      const eyeButton = page.locator(
        `div.result.searchable[external-candidate-id="${id}"] ` +
          `button.button-candidate-action-profile`,
      );
      await eyeButton.click();
      await page.locator("div.profile-box").waitFor({ state: "visible" });
      await page.waitForTimeout(1500);

      let cvText = "";

      const hasPdf = await page
        .locator("div.profile-box iframe.pdfjs_viewer")
        .waitFor({ state: "attached", timeout: 3000 })
        .then(() => true)
        .catch(() => false);

      if (hasPdf) {
        const frame = page.frameLocator("div.profile-box iframe.pdfjs_viewer");
        await frame
          .locator("div.textLayer")
          .first()
          .waitFor({ state: "visible" });
        await page.waitForTimeout(2000);
        const divTexts = await frame
          .locator("div.textLayer div")
          .allTextContents();
        cvText = divTexts.join(" ");
      } else {
        cvText =
          (await page
            .locator(
              'div.profile-box h4.adcresponses-header:has-text("CV") + div',
            )
            .textContent()
            .catch(() => "")) ?? "";
      }

      cvText = cvText.trim();

      if (cvText.length < 50) {
        console.log(
          `[ResumeReviewer] WARNING: CV text too short or empty for ${candidate.name} — skipping`,
        );
        try {
          await page.locator("a.profile-close").click();
        } catch {}
        await page
          .waitForFunction(
            () =>
              (document.querySelector("#gritter-notice-wrapper")
                ?.childElementCount ?? 0) === 0,
            { timeout: 10000 },
          )
          .catch(() => {});
        continue;
      }

      const prompt = buildReviewPrompt(
        cvText,
        rejectionCriteria,
        strictMode,
        candidate.name,
      );
      const rawResponse = await callLLM("resume review", prompt, llmSelections);
      const parsed = validateLlmResponse(rawResponse, candidate.name);
      if (parsed.defaulted) defaultedToPassCount++;

      results.push({
        id,
        name: candidate.name,
        ai_decision: parsed.decision,
        ai_reason: parsed.reason,
        rejection_category: parsed.rejection_category,
        defaulted: parsed.defaulted || undefined,
      });
      newCandidatesReviewed++;

      if (parsed.decision !== "pass") {
        const flagIcon = page.locator(
          "div.adcresponses-profile-flagging i.candidate-flag-rank-21",
        );
        await flagIcon.click();
        await page.waitForTimeout(800);
        flaggedCount++;
      }

      try {
        await page.locator("a.profile-close").click();
      } catch {}
      await page
        .waitForFunction(
          () =>
            (document.querySelector("#gritter-notice-wrapper")
              ?.childElementCount ?? 0) === 0,
          { timeout: 10000 },
        )
        .catch(() => {});
      await page.waitForTimeout(1000);
      await randomDelay();
    }

    if (bookmarkFound) break;

    const nextPageLi = page
      .locator("div.pager ul li.page-num.selected + li.page-num")
      .first();
    const nextExists = (await nextPageLi.count()) > 0;
    if (!nextExists) break;

    await page
      .waitForFunction(
        () =>
          (document.querySelector("#gritter-notice-wrapper")
            ?.childElementCount ?? 0) === 0,
        { timeout: 30000 },
      )
      .catch(() => {});

    await nextPageLi.click();
    await page.waitForSelector(
      `div.pager ul li.page-num.selected[title="${pageNumber + 1}"]`,
      { timeout: 60000 },
    );
    await page.waitForTimeout(1000);
    pageNumber++;
  }

  const passCount = results.filter((r) => r.ai_decision === "pass").length;
  const failCount = results.filter((r) => r.ai_decision === "fail").length;

  // Carry forward rejection counts from previous fails + add new fails
  const prevFails = previousResults.filter((r) => r.ai_decision === "fail");
  const newFails = results.filter((r) => r.ai_decision === "fail");
  const prevCounts = tallyRejectionCounts(prevFails);
  const newCounts = tallyRejectionCounts(newFails);
  const generalFilterRejects = prevCounts.generalFilterRejects + newCounts.generalFilterRejects;
  const labouringFilterRejects = prevCounts.labouringFilterRejects + newCounts.labouringFilterRejects;
  const heavyLabouringRejects = prevCounts.heavyLabouringRejects + newCounts.heavyLabouringRejects;
  const employmentDateRejects = prevCounts.employmentDateRejects + newCounts.employmentDateRejects;
  const civilLabourerRejects = prevCounts.civilLabourerRejects + newCounts.civilLabourerRejects;
  const productionWorkerRejects = prevCounts.productionWorkerRejects + newCounts.productionWorkerRejects;

  const previousIds = new Set(previousResults.map((r) => r.id));
  const newResults = results.filter((r) => !previousIds.has(r.id));
  const mergedResults = [...previousResults, ...newResults];

  const output = {
    advertId,
    reviewedAt: DateTime.now().toISO(),
    totalReviewed: mergedResults.length,
    ruleset: strictMode ? "strict" : "standard",
    selectedKeywords: selectedKeywords[0] ?? "",
    lastProcessedId: newLastProcessedId,
    results: mergedResults,
  };

  await fs.mkdir(tempDir, { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(output, null, 2), "utf-8");

  console.log(
    `[ResumeReviewer] Done — ${passCount} passed, ${failCount} failed ` +
      `(${flaggedCount} flagged purple), ${skippedCount} skipped (already flagged)`,
  );

  return {
    passCount,
    failCount,
    flaggedCount,
    skippedCount,
    skippedPreviouslyPassed,
    defaultedToPassCount,
    newCandidatesReviewed,
    generalFilterRejects,
    labouringFilterRejects,
    heavyLabouringRejects,
    employmentDateRejects,
    civilLabourerRejects,
    productionWorkerRejects,
  };
}
