/**
 * One-time migration script: converts existing passing-{id}.json and
 * resume-review-{id}.json files into the unified advert-state-{id}.json format.
 *
 * Run once on GCP before the first production run with the new code:
 *   npx ts-node scripts/migrate-temp-files.ts
 */

import path from "path";
import fs from "fs/promises";
import { DateTime } from "luxon";
import { AdvertCandidate, AdvertStateFile } from "../src/shared/advert-state";
import { RejectionCategory, validRejectionCategories } from "../src/resume/resume-page-object";

const tempDir = path.resolve(process.cwd(), "temp");

interface OldPassingFile {
  advertId: string;
  selectedKeywords?: string;
  lastProcessedId?: string | null;
  totalFiltered?: number;
  passingCandidates: Array<{
    id: string;
    name: string;
    flagged_status: boolean;
    flag_colour: string | null;
  }>;
}

interface OldReviewFile {
  advertId: string;
  selectedKeywords?: string;
  lastProcessedId?: string | null;
  ruleset?: "strict" | "standard";
  results: Array<{
    id: string;
    name: string;
    ai_decision: string;
    ai_reason: string;
    rejection_category: RejectionCategory | null;
    defaulted?: boolean;
  }>;
}

async function readJson<T>(filePath: string): Promise<T | null> {
  const raw = await fs.readFile(filePath, "utf-8").catch(() => null);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function migrate(): Promise<void> {
  const files = await fs.readdir(tempDir).catch(() => [] as string[]);

  const advertIds = new Set<string>();
  for (const file of files) {
    const m = file.match(/^(?:passing|resume-review)-(\d+)\.json$/);
    if (m) advertIds.add(m[1]);
  }

  if (advertIds.size === 0) {
    console.log("No legacy temp files found — nothing to migrate.");
    return;
  }

  console.log(`Found ${advertIds.size} advert(s) to migrate.\n`);

  for (const advertId of advertIds) {
    const passingPath = path.join(tempDir, `passing-${advertId}.json`);
    const reviewPath = path.join(tempDir, `resume-review-${advertId}.json`);
    const statePath = path.join(tempDir, `advert-state-${advertId}.json`);

    const passing = await readJson<OldPassingFile>(passingPath);
    const review = await readJson<OldReviewFile>(reviewPath);

    if (!passing && !review) {
      console.log(`  [${advertId}] Skipped — could not parse either file.`);
      continue;
    }

    // Build review result lookup
    const reviewMap = new Map(
      (review?.results ?? []).map((r) => [r.id, r]),
    );

    const candidates: AdvertCandidate[] = [];

    // Candidates from the passing file (freshest flag status)
    for (const pc of passing?.passingCandidates ?? []) {
      const r = reviewMap.get(pc.id);
      let review_status: AdvertCandidate["review_status"] = null;
      if (r) {
        if (r.ai_decision === "pass") review_status = "pass";
        else if (r.ai_decision === "fail") review_status = "fail";
      }
      candidates.push({
        id: pc.id,
        name: pc.name,
        flagged_status: pc.flagged_status,
        flag_colour: pc.flag_colour,
        review_status,
        ai_reason: r?.ai_reason ?? null,
        rejection_category: (r?.rejection_category &&
          validRejectionCategories.includes(r.rejection_category as RejectionCategory))
          ? (r.rejection_category as RejectionCategory)
          : null,
        ...(r?.defaulted ? { defaulted: true } : {}),
      });
    }

    // Review results whose id wasn't in the passing file (edge case)
    const passingIds = new Set(candidates.map((c) => c.id));
    for (const r of review?.results ?? []) {
      if (passingIds.has(r.id)) continue;
      const failed = r.ai_decision === "fail";
      candidates.push({
        id: r.id,
        name: r.name,
        flagged_status: failed,
        flag_colour: failed ? "purple" : null,
        review_status: r.ai_decision === "pass" ? "pass" : "fail",
        ai_reason: r.ai_reason ?? null,
        rejection_category: (r.rejection_category &&
          validRejectionCategories.includes(r.rejection_category as RejectionCategory))
          ? (r.rejection_category as RejectionCategory)
          : null,
        ...(r.defaulted ? { defaulted: true } : {}),
      });
    }

    const selectedKeywords =
      review?.selectedKeywords ?? passing?.selectedKeywords ?? "";

    const state: AdvertStateFile = {
      advertId,
      updatedAt: DateTime.now().toISO()!,
      selectedKeywords,
      ruleset: review?.ruleset ?? null,
      collectionLastProcessedId: passing?.lastProcessedId ?? null,
      reviewLastProcessedId: review?.lastProcessedId ?? null,
      totalFiltered: passing?.totalFiltered ?? 0,
      candidates,
    };

    await fs.writeFile(statePath, JSON.stringify(state, null, 2), "utf-8");

    const reviewed = candidates.filter((c) => c.review_status !== null).length;
    const pending = candidates.filter((c) => c.review_status === null).length;
    console.log(
      `  [${advertId}] Migrated ${candidates.length} candidate(s) — ` +
        `${reviewed} reviewed, ${pending} pending review.`,
    );
  }

  console.log("\nMigration complete. Old files left in place — they will be");
  console.log("deleted automatically on the first run of the new code.");
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
