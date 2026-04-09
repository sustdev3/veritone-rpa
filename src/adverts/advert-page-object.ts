import { DateTime } from "luxon";
import { parseAdvertDate } from "../shared/utils";

export const DEFAULT_LOOKBACK_DAYS = 30;

export interface AdvertSummary {
  advertId: string;
  jobTitle: string;
  datePosted: DateTime;
  totalResponses: number;
  consultant: string;
  refNumber: string;
  location: string;
  listPage: number;
}

export interface AdvertDetail {
  jobTitle: string;
  location: string;
  jobDescription: string;
  totalApplicants: number;
}

export interface RawAdvertRow {
  advertId: string;
  jobTitle: string;
  dateText: string;
  totalResponses: number;
  consultant: string;
  refNumber: string;
  location: string;
}

export function isFatalError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("credit balance is too low") ||
    lower.includes("insufficient_quota") ||
    lower.includes("billing") ||
    lower.includes("overloaded_error")
  );
}

export function classifyError(message: string): string {
  if (/timeout/i.test(message)) return "timeout";
  if (/strict mode|locator|selector/i.test(message)) return "selector";
  if (/navigation|ERR_|net::/i.test(message)) return "navigation";
  return "other";
}

export function parseAdvertRow(
  r: RawAdvertRow,
  listPage: number,
): AdvertSummary | null {
  if (!r.advertId) {
    console.warn(
      `[AdvertReader] Skipping row — could not extract advert ID from href.`,
    );
    return null;
  }

  const datePosted = parseAdvertDate(r.dateText);

  if (!datePosted.isValid) {
    console.warn(
      `[AdvertReader] Could not parse date for advert ${r.advertId} — skipping.`,
    );
    return null;
  }

  return { ...r, datePosted, listPage };
}

export function filterAndSort(adverts: AdvertSummary[]): AdvertSummary[] {
  const lookbackDays = parseInt(
    process.env.LOOKBACK_DAYS ?? String(DEFAULT_LOOKBACK_DAYS),
    10,
  );
  const cutoff = DateTime.now().minus({ days: lookbackDays }).startOf("day");

  const withinWindow = adverts.filter((a) => a.datePosted >= cutoff);

  console.log(
    `[AdvertReader] ${withinWindow.length} of ${adverts.length} adverts within the lookback window (last ${lookbackDays} days).`,
  );

  for (const a of withinWindow) {
    console.log(
      `[AdvertReader] Found: ID=${a.advertId} — "${a.jobTitle}" | ${a.totalResponses} applications | posted ${a.datePosted.toFormat("dd MMM yyyy HH:mm")}`,
    );
  }

  // Comment out for testing to preserve original order (which is usually newest first). Can re-enable if we want to ensure strict sorting by date.
  // withinWindow.sort((a, b) => b.datePosted.toMillis() - a.datePosted.toMillis());

  // Testing purpose: sort oldest first to ensure we process in chronological order and avoid issues with ads expiring between discovery and processing.
  withinWindow.sort(
    (a, b) => a.datePosted.toMillis() - b.datePosted.toMillis(),
  );

  for (const a of withinWindow) {
    console.log(
      `[AdvertReader] Will process: ID=${a.advertId} — "${a.jobTitle}"`,
    );
  }

  // Comment out for now to avoid issues with ads expiring between discovery and processing. Can re-enable if we want to ensure strict sorting by date.
  // return withinWindow;

  return withinWindow.slice(0, 1); // For testing, process only the oldest advert to avoid issues with ads expiring between discovery and processing.
}
