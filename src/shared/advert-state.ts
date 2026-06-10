import { DateTime } from "luxon";
import { RejectionCategory } from "../resume/resume-page-object";
import { supabase } from "./supabase-client";

export interface AdvertCandidate {
  id: string;
  name: string;
  flagged_status: boolean;
  flag_colour: string | null;
  review_status: "pass" | "fail" | "questionnaire_fail" | "prior_red_flagged" | null;
  ai_reason: string | null;
  rejection_category: RejectionCategory | null;
  defaulted?: boolean;
}

export interface AdvertStateFile {
  advertId: string;
  updatedAt: string;
  selectedKeywords: string;
  ruleset: "strict" | "standard" | null;
  collectionLastProcessedId: string | null;
  reviewLastProcessedId: string | null;
  totalFiltered: number;
  candidates: AdvertCandidate[];
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch {
    await new Promise((r) => setTimeout(r, 1000));
    return fn();
  }
}

export async function readAdvertState(advertId: string): Promise<AdvertStateFile | null> {
  const [{ data: stateRow, error: stateErr }, { data: candidateRows, error: candidateErr }] =
    await Promise.all([
      supabase.from("advert_states").select("*").eq("advert_id", advertId).maybeSingle(),
      supabase.from("advert_candidates").select("*").eq("advert_id", advertId),
    ]);

  if (stateErr) throw new Error(`[AdvertState] readAdvertState failed: ${stateErr.message}`);
  if (candidateErr) throw new Error(`[AdvertState] readAdvertState candidates failed: ${candidateErr.message}`);

  if (!stateRow) {
    console.log(`[AdvertState] No Supabase row for advert ${advertId} — fresh state`);
    return null;
  }

  const candidates: AdvertCandidate[] = (candidateRows ?? []).map((r) => ({
    id: r.candidate_id,
    name: r.name,
    flagged_status: r.flagged_status,
    flag_colour: r.flag_colour,
    review_status: r.review_status,
    ai_reason: r.ai_reason,
    rejection_category: r.rejection_category,
    ...(r.defaulted != null ? { defaulted: r.defaulted } : {}),
  }));

  const toReview = candidates.filter((c) => c.review_status === null && !c.flagged_status).length;
  const flagged = candidates.filter((c) => c.flagged_status).length;
  const passed = candidates.filter((c) => c.review_status === "pass" && !c.flagged_status).length;
  console.log(
    `[AdvertState] Read advert ${advertId} from Supabase — ${candidates.length} candidates ` +
    `(${toReview} to review, ${flagged} flagged, ${passed} passed)`,
  );

  return {
    advertId: stateRow.advert_id,
    updatedAt: stateRow.updated_at,
    selectedKeywords: stateRow.selected_keywords,
    ruleset: stateRow.ruleset,
    collectionLastProcessedId: stateRow.collection_last_processed_id,
    reviewLastProcessedId: stateRow.review_last_processed_id,
    totalFiltered: stateRow.total_filtered,
    candidates,
  };
}

export async function writeAdvertState(state: AdvertStateFile): Promise<void> {
  const now = DateTime.now().toISO() ?? new Date().toISOString();
  state.updatedAt = now;

  const { error: stateErr } = await withRetry(async () => await
    supabase.from("advert_states").upsert({
      advert_id: state.advertId,
      updated_at: now,
      selected_keywords: state.selectedKeywords,
      ruleset: state.ruleset,
      collection_last_processed_id: state.collectionLastProcessedId,
      review_last_processed_id: state.reviewLastProcessedId,
      total_filtered: state.totalFiltered,
    }, { onConflict: "advert_id" })
  );
  if (stateErr) throw new Error(`[AdvertState] writeAdvertState advert_states failed: ${stateErr.message}`);

  if (state.candidates.length > 0) {
    // Deduplicate by candidate_id — duplicate IDs in a single upsert batch cause
    // "ON CONFLICT DO UPDATE command cannot affect row a second time" in Postgres.
    // Last occurrence wins (most recently merged data).
    const dedupedCandidates = Array.from(
      new Map(state.candidates.map((c) => [c.id, c])).values()
    );
    if (dedupedCandidates.length !== state.candidates.length) {
      console.warn(
        `[AdvertState] Deduped ${state.candidates.length - dedupedCandidates.length} duplicate candidate(s) for advert ${state.advertId} before upsert`
      );
    }
    const rows = dedupedCandidates.map((c) => ({
      advert_id: state.advertId,
      candidate_id: c.id,
      name: c.name,
      flagged_status: c.flagged_status,
      flag_colour: c.flag_colour,
      review_status: c.review_status,
      ai_reason: c.ai_reason,
      rejection_category: c.rejection_category,
      defaulted: c.defaulted ?? null,
      updated_at: now,
    }));

    const { error: candidateErr } = await withRetry(async () => await
      supabase.from("advert_candidates").upsert(rows, { onConflict: "advert_id,candidate_id" })
    );
    if (candidateErr) throw new Error(`[AdvertState] writeAdvertState advert_candidates failed: ${candidateErr.message}`);
  }

  console.log(`[AdvertState] Wrote advert ${state.advertId} to Supabase — ${state.candidates.length} candidates`);
}

export async function writeAdvertCandidate(advertId: string, candidate: AdvertCandidate): Promise<void> {
  const now = DateTime.now().toISO() ?? new Date().toISOString();

  const { error } = await withRetry(async () => await
    supabase.from("advert_candidates").upsert({
      advert_id: advertId,
      candidate_id: candidate.id,
      name: candidate.name,
      flagged_status: candidate.flagged_status,
      flag_colour: candidate.flag_colour,
      review_status: candidate.review_status,
      ai_reason: candidate.ai_reason,
      rejection_category: candidate.rejection_category,
      defaulted: candidate.defaulted ?? null,
      updated_at: now,
    }, { onConflict: "advert_id,candidate_id" })
  );
  if (error) throw new Error(`[AdvertState] writeAdvertCandidate failed for ${candidate.id}: ${error.message}`);
}
