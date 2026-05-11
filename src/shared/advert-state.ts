import path from "path";
import fs from "fs/promises";
import { DateTime } from "luxon";
import { RejectionCategory } from "../resume/resume-page-object";

export interface AdvertCandidate {
  id: string;
  name: string;
  flagged_status: boolean;
  flag_colour: string | null;
  review_status: "pass" | "fail" | "questionnaire_fail" | null;
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
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as AdvertStateFile;
  } catch {
    return null;
  }
}

export async function writeAdvertState(state: AdvertStateFile): Promise<void> {
  await fs.mkdir(tempDir, { recursive: true });
  state.updatedAt = DateTime.now().toISO() ?? state.updatedAt;
  await fs.writeFile(advertStatePath(state.advertId), JSON.stringify(state, null, 2), "utf-8");
}
