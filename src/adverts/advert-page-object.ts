import { DateTime } from 'luxon';
import { parseAdvertDate } from '../shared/utils';

export const DEFAULT_LOOKBACK_DAYS = 10;

export interface AdvertSummary {
  advertId: string;
  jobTitle: string;
  datePosted: DateTime;
  totalResponses: number;
  consultant: string;
  refNumber: string;
  location: string;
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

export function parseAdvertRow(r: RawAdvertRow): AdvertSummary | null {
  if (!r.advertId) {
    console.warn(`[AdvertReader] Skipping row — could not extract advert ID from href.`);
    return null;
  }

  const datePosted = parseAdvertDate(r.dateText);

  if (!datePosted.isValid) {
    console.warn(`[AdvertReader] Could not parse date for advert ${r.advertId} — skipping.`);
    return null;
  }

  return { ...r, datePosted };
}

export function filterAndSort(adverts: AdvertSummary[]): AdvertSummary[] {
  const lookbackDays = parseInt(
    process.env.LOOKBACK_DAYS ?? String(DEFAULT_LOOKBACK_DAYS),
    10,
  );
  const cutoff = DateTime.now().minus({ days: lookbackDays }).startOf("day");

  const filtered = adverts.filter((a) => a.datePosted >= cutoff);

  console.log(
    `[AdvertReader] ${filtered.length} of ${adverts.length} adverts within the ${lookbackDays}-day lookback window.`,
  );

  filtered.sort((a, b) => a.datePosted.toMillis() - b.datePosted.toMillis());

  // TESTING ONLY - remove when done
  const testIds = ['519021', '519020', '519019', '519018', '519016'];
  console.log(
    `[AdvertReader] TESTING MODE — running adverts: ${testIds.join(', ')}`,
  );
  return filtered.filter((a) => testIds.includes(a.advertId));
  // TESTING ONLY - remove when done
}
