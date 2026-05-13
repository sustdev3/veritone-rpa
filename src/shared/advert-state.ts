import path from "path";
import fs from "fs/promises";
import { DateTime } from "luxon";
import { RejectionCategory } from "../resume/resume-page-object";

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

const tempDir = path.resolve(process.cwd(), "temp");

export function advertStatePath(advertId: string): string {
  return path.join(tempDir, `advert-state-${advertId}.json`);
}

export async function readAdvertState(advertId: string): Promise<AdvertStateFile | null> {
  const raw = await fs.readFile(advertStatePath(advertId), "utf-8").catch(() => null);
  if (raw === null) {
    console.log(`[AdvertState] advert-state-${advertId}.json not found — fresh state`);
    return null;
  }
  try {
    const state = JSON.parse(raw) as AdvertStateFile;
    const toReview = state.candidates.filter(c => c.review_status === null && !c.flagged_status).length;
    const flagged = state.candidates.filter(c => c.flagged_status).length;
    const passed = state.candidates.filter(c => c.review_status === "pass" && !c.flagged_status).length;
    console.log(
      `[AdvertState] Read advert-state-${advertId}.json — ${state.candidates.length} candidates ` +
      `(${toReview} to review, ${flagged} flagged, ${passed} passed)`,
    );
    return state;
  } catch {
    return null;
  }
}

export async function writeAdvertState(state: AdvertStateFile): Promise<void> {
  await fs.mkdir(tempDir, { recursive: true });
  state.updatedAt = DateTime.now().toISO() ?? state.updatedAt;
  await fs.writeFile(advertStatePath(state.advertId), JSON.stringify(state, null, 2), "utf-8");
  console.log(`[AdvertState] Wrote advert-state-${state.advertId}.json — ${state.candidates.length} candidates`);
}
