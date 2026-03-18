import { DateTime } from 'luxon';
import { parseAdvertDate } from '../shared/utils';

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

export function parseAdvertRow(r: RawAdvertRow, listPage: number): AdvertSummary | null {
  if (!r.advertId) {
    console.warn(`[AdvertReader] Skipping row — could not extract advert ID from href.`);
    return null;
  }

  const datePosted = parseAdvertDate(r.dateText);

  if (!datePosted.isValid) {
    console.warn(`[AdvertReader] Could not parse date for advert ${r.advertId} — skipping.`);
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

  // TESTING ONLY - remove when done
  const minAgeCutoff = DateTime.now().minus({ days: 15 });
  const withinWindow = adverts.filter(
    (a) => a.datePosted >= cutoff && a.datePosted <= minAgeCutoff,
  );
  // TESTING ONLY - remove when done

  console.log(
    `[AdvertReader] ${withinWindow.length} of ${adverts.length} adverts within the lookback window (15–${lookbackDays} days old).`,
  );

  for (const a of withinWindow) {
    console.log(
      `[AdvertReader] Found: ID=${a.advertId} — "${a.jobTitle}" | ${a.totalResponses} applications | posted ${a.datePosted.toFormat('dd MMM yyyy HH:mm')}`,
    );
  }

  const filtered = withinWindow.filter((a) => a.totalResponses >= 100);
  const skipped = withinWindow.length - filtered.length;

  console.log(
    `[AdvertReader] Skipped ${skipped} advert(s) with fewer than 100 applications.`,
  );

  filtered.sort((a, b) => a.datePosted.toMillis() - b.datePosted.toMillis());

  for (const a of filtered) {
    console.log(
      `[AdvertReader] Will process: ID=${a.advertId} — "${a.jobTitle}"`,
    );
  }

  return filtered;
}
