import { Page } from "playwright";
import path from "path";
import fs from "fs/promises";
import { callLLM } from "../shared/llm-service";
import { randomDelay } from "../shared/utils";
import { buildReviewPrompt } from "../prompts/review-resume";
import {
  ReviewSummary,
  validateLlmResponse,
  tallyRejectionCounts,
  ReviewResult,
} from "./resume-page-object";
import { parseScreeningNote, shouldPurpleFlag } from "../candidates/questionnaire-screener";
import { readAdvertState, writeAdvertState, writeAdvertCandidate } from "../shared/advert-state";

export async function reviewResumes(
  page: Page,
  advertId: string,
  llmModel: string,
): Promise<ReviewSummary> {
  const state = await readAdvertState(advertId);
  if (!state) {
    console.log(`[ResumeReviewer] No state file for advert ${advertId} — nothing to review`);
    return {
      passCount: 0, failCount: 0, flaggedCount: 0, questionnaireFlaggedCount: 0,
      priorRedFlagCount: 0,
      skippedCount: 0, skippedPreviouslyPassed: 0, defaultedToPassCount: 0,
      newCandidatesReviewed: 0, generalFilterRejects: 0, labouringFilterRejects: 0,
      heavyLabouringRejects: 0, employmentDateRejects: 0, civilLabourerRejects: 0,
      productionWorkerRejects: 0,
    };
  }

  const totalFiltered = state.totalFiltered;
  const strictMode = totalFiltered > 60;

  if (strictMode) {
    console.log(`[ResumeReviewer] Ruleset: strict (filtered count: ${totalFiltered})`);
  } else {
    console.log(`[ResumeReviewer] Ruleset: standard (filtered count: ${totalFiltered})`);
  }

  const rejectionCriteriaPath = path.resolve(process.cwd(), "config", "rejection-filters.md");
  const rejectionCriteria = await fs.readFile(rejectionCriteriaPath, "utf-8");

  // Build a Map for O(1) in-place updates — mutations propagate to state.candidates
  const candidateMap = new Map(state.candidates.map((c) => [c.id, c]));

  // Review queue: not yet reviewed and not already flagged
  const toReviewMap = new Map(
    state.candidates
      .filter((c) => c.review_status === null && (!c.flagged_status || c.flag_colour === 'lightblue'))
      .map((c) => [c.id, c]),
  );

  const skippedCount = state.candidates.filter(
    (c) => c.review_status === null && c.flagged_status && c.flag_colour !== 'lightblue',
  ).length;

  console.log(
    `[ResumeReviewer] ${toReviewMap.size} candidates to review ` +
      `(${skippedCount} already flagged — skipped)`,
  );

  await page.goto(`https://www.adcourier.com/view-vacancy.cgi?advert_id=${advertId}`);
  await page.waitForLoadState("domcontentloaded");
  await page.locator('a[href*="adcresponses"]').first().click();
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(2000);

  let newLastProcessedId: string | null = null;
  const firstVisibleIds: string[] = await page.evaluate(() =>
    Array.from(document.querySelectorAll("div.result.searchable")).map(
      (el) => el.getAttribute("external-candidate-id") ?? "",
    ),
  );
  if (firstVisibleIds.length > 0) newLastProcessedId = firstVisibleIds[0];

  let flaggedCount = 0;
  let questionnaireFlaggedCount = 0;
  let priorRedFlagCount = 0;
  let newCandidatesReviewed = 0;
  let defaultedToPassCount = 0;
  let pageNumber = 1;
  let bookmarkFound = false;
  let candidateIndex = 0;
  const totalToReview = toReviewMap.size;
  let consecutivePagesWithZeroNew = 0;
  const FALLBACK_THRESHOLD = 3;
  const llmSelections = { "resume review": llmModel };
  const existingLastProcessedId = state.reviewLastProcessedId;

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
      const candidate = toReviewMap.get(id)!;
      candidateIndex++;

      const eyeButton = page.locator(
        `div.result.searchable[external-candidate-id="${id}"] ` +
          `button.button-candidate-action-profile`,
      );
      await eyeButton.click();
      await page.locator("div.profile-box").waitFor({ state: "visible" });
      await page.waitForTimeout(1500);

      // Check Other Applications for prior red flags — if found, skip questionnaire + CV review
      const hasRedPriorApp = await page.evaluate(() => {
        const icons = document.querySelectorAll(
          "#application_history .application-rank-container i.icon-flag-circled",
        );
        const RED = new Set(["rgb(255, 0, 0)", "#ff0000"]);
        return Array.from(icons).some(
          (el) => RED.has((el as HTMLElement).style.color.toLowerCase().trim()),
        );
      });

      if (hasRedPriorApp) {
        console.log(
          `[ResumeReviewer] Candidate ${candidateIndex}/${totalToReview}: ${candidate.name} (${id}) — FAIL [prior red flag] — flagging purple`,
        );
        const flagIcon = page.locator(
          "div.adcresponses-profile-flagging i.candidate-flag-rank-21",
        );
        await flagIcon.click();
        await page.waitForTimeout(800);

        // candidateMap holds references into state.candidates — mutating stateCandidate
        // also mutates the object inside state, so writeAdvertState persists the change.
        const stateCandidate = candidateMap.get(id)!;
        stateCandidate.review_status = "prior_red_flagged";
        stateCandidate.ai_reason = "Prior red-flagged application found";
        stateCandidate.rejection_category = null;
        stateCandidate.flagged_status = true;
        stateCandidate.flag_colour = "purple";
        await writeAdvertCandidate(state.advertId, stateCandidate);

        priorRedFlagCount++;
        flaggedCount++;
        newCandidatesReviewed++;
        try { await page.locator("a.profile-close").click(); } catch {}
        await page
          .waitForFunction(
            () => (document.querySelector("#gritter-notice-wrapper")?.childElementCount ?? 0) === 0,
            { timeout: 10000 },
          )
          .catch(() => {});
        continue;
      }

      // Questionnaire check before CV review
      const noteTexts = await page
        .locator("div.profile-box ul.notes-list li.note")
        .allTextContents();
      const combinedNotes = noteTexts.join("\n");
      const screeningAnswers = parseScreeningNote(combinedNotes);

      if (screeningAnswers !== null && shouldPurpleFlag(screeningAnswers)) {
        const transportFails =
          screeningAnswers.transport.trim() !== "" &&
          !screeningAnswers.transport.toLowerCase().includes("car/motorbike");
        let failReason = "";
        if (screeningAnswers.licence.toLowerCase() === "no") failReason = "no licence";
        else if (transportFails) failReason = "transport not Car/Motorbike";
        else if (screeningAnswers.fulltimeHours.toLowerCase() === "no") failReason = "not available fulltime";
        else if (screeningAnswers.livingInAus.toLowerCase() === "no") failReason = "not living in Australia";
        console.log(
          `[ResumeReviewer] Candidate ${candidateIndex}/${totalToReview}: ${candidate.name} (${id}) — FAIL [questionnaire] (${failReason}) — flagging purple`,
        );
        const flagIcon = page.locator(
          "div.adcresponses-profile-flagging i.candidate-flag-rank-21",
        );
        await flagIcon.click();
        await page.waitForTimeout(800);

        const stateCandidate = candidateMap.get(id)!;
        stateCandidate.review_status = "questionnaire_fail";
        stateCandidate.ai_reason = "Failed screening note criteria";
        stateCandidate.rejection_category = null;
        stateCandidate.flagged_status = true;
        stateCandidate.flag_colour = "purple";
        await writeAdvertCandidate(state.advertId, stateCandidate);

        newCandidatesReviewed++;
        questionnaireFlaggedCount++;
        flaggedCount++;
        try { await page.locator("a.profile-close").click(); } catch {}
        await page
          .waitForFunction(
            () => (document.querySelector("#gritter-notice-wrapper")?.childElementCount ?? 0) === 0,
            { timeout: 10000 },
          )
          .catch(() => {});
        continue;
      }

      let cvText = "";

      const hasPdf = await page
        .locator("div.profile-box iframe.pdfjs_viewer")
        .waitFor({ state: "attached", timeout: 3000 })
        .then(() => true)
        .catch(() => false);

      if (hasPdf) {
        const frame = page.frameLocator("div.profile-box iframe.pdfjs_viewer");
        await frame.locator("div.textLayer").first().waitFor({ state: "visible" });
        await page.waitForTimeout(2000);
        const divTexts = await frame.locator("div.textLayer div").allTextContents();
        cvText = divTexts.join(" ");
      } else {
        cvText =
          (await page
            .locator('div.profile-box h4.adcresponses-header:has-text("CV") + div')
            .textContent()
            .catch(() => "")) ?? "";
      }

      cvText = cvText.trim();
      const cvSource = hasPdf ? "PDF" : "HTML";

      if (cvText.length < 50) {
        console.log(
          `[ResumeReviewer] Candidate ${candidateIndex}/${totalToReview}: ${candidate.name} (${id}) — SKIP (CV too short, ${cvSource}, ${cvText.length} chars)`,
        );
        try { await page.locator("a.profile-close").click(); } catch {}
        await page
          .waitForFunction(
            () => (document.querySelector("#gritter-notice-wrapper")?.childElementCount ?? 0) === 0,
            { timeout: 10000 },
          )
          .catch(() => {});
        continue;
      }

      const prompt = buildReviewPrompt(cvText, rejectionCriteria, strictMode, candidate.name);
      const rawResponse = await callLLM("resume review", prompt, llmSelections);
      const parsed = validateLlmResponse(rawResponse, candidate.name);
      if (parsed.defaulted) defaultedToPassCount++;

      if (parsed.decision !== "pass") {
        console.log(
          `[ResumeReviewer] Candidate ${candidateIndex}/${totalToReview}: ${candidate.name} (${id}) — FAIL [${parsed.rejection_category ?? "unknown"}] | CV: ${cvSource}, ${cvText.length} chars | "${parsed.reason}"`,
        );
      }

      const stateCandidate = candidateMap.get(id)!;
      stateCandidate.review_status = parsed.decision as "pass" | "fail";
      stateCandidate.ai_reason = parsed.reason;
      stateCandidate.rejection_category = parsed.rejection_category;
      if (parsed.defaulted) stateCandidate.defaulted = true;
      newCandidatesReviewed++;

      if (parsed.decision !== "pass") {
        const flagIcon = page.locator(
          "div.adcresponses-profile-flagging i.candidate-flag-rank-21",
        );
        await flagIcon.click();
        await page.waitForTimeout(800);
        stateCandidate.flagged_status = true;
        stateCandidate.flag_colour = "purple";
        flaggedCount++;
      }

      await writeAdvertCandidate(state.advertId, stateCandidate);

      try { await page.locator("a.profile-close").click(); } catch {}
      await page
        .waitForFunction(
          () => (document.querySelector("#gritter-notice-wrapper")?.childElementCount ?? 0) === 0,
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
        () => (document.querySelector("#gritter-notice-wrapper")?.childElementCount ?? 0) === 0,
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

  // Persist final bookmark and ruleset
  state.reviewLastProcessedId = newLastProcessedId;
  state.ruleset = strictMode ? "strict" : "standard";
  await writeAdvertState(state);

  // Cumulative counts from the full state (all runs, all candidates)
  const passCount = state.candidates.filter(
    (c) => c.review_status === "pass" && (!c.flagged_status || c.flag_colour === 'lightblue'),
  ).length;

  const failResults: ReviewResult[] = state.candidates
    .filter((c) => c.review_status === "fail")
    .map((c) => ({
      id: c.id,
      name: c.name,
      ai_decision: "fail",
      ai_reason: c.ai_reason ?? "",
      rejection_category: c.rejection_category,
    }));
  const {
    generalFilterRejects,
    labouringFilterRejects,
    heavyLabouringRejects,
    employmentDateRejects,
    civilLabourerRejects,
    productionWorkerRejects,
  } = tallyRejectionCounts(failResults);

  const failCount = state.candidates.filter(
    (c) => c.review_status === "fail" || c.review_status === "questionnaire_fail" || c.review_status === "prior_red_flagged",
  ).length;

  console.log(
    `[ResumeReviewer] Done — ${passCount} suitable (cumulative), ${failCount} rejected ` +
      `(${flaggedCount} flagged purple this run, ${questionnaireFlaggedCount} via questionnaire, ` +
      `${priorRedFlagCount} prior red flag), ` +
      `${skippedCount} skipped (already flagged)`,
  );

  return {
    passCount,
    failCount,
    flaggedCount,
    questionnaireFlaggedCount,
    priorRedFlagCount,
    skippedCount,
    skippedPreviouslyPassed: 0,
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
