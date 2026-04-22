export interface ReviewResult {
  id: string;
  name: string;
  ai_decision: string;
  ai_reason: string;
  rejection_category: RejectionCategory | null;
  defaulted?: boolean;
}

export interface ReviewSummary {
  passCount: number;
  failCount: number;
  flaggedCount: number;
  questionnaireFlaggedCount: number;
  skippedCount: number;
  skippedPreviouslyPassed: number;
  defaultedToPassCount: number;
  newCandidatesReviewed: number;
  generalFilterRejects: number;
  labouringFilterRejects: number;
  heavyLabouringRejects: number;
  employmentDateRejects: number;
  civilLabourerRejects: number;
  productionWorkerRejects: number;
}

export const validRejectionCategories = [
  'general',
  'labouring',
  'heavy_labouring',
  'employment_date',
  'civil_labourer',
  'production_worker',
] as const;

export type RejectionCategory = typeof validRejectionCategories[number];

export function validateLlmResponse(
  rawResponse: string,
  candidateName: string,
): { decision: string; reason: string; rejection_category: RejectionCategory | null; defaulted: boolean } {
  const cleaned = rawResponse.replace(/```(?:json)?|```/g, '').trim();

  let parsed: { decision: string; reason: string; rejection_category: RejectionCategory | null };
  let defaulted = false;
  try {
    parsed = JSON.parse(cleaned) as typeof parsed;
  } catch {
    console.log(
      `[ResumeReviewer] WARNING: Could not parse LLM response for ${candidateName} — defaulting to pass`,
    );
    parsed = { decision: 'pass', reason: 'JSON parse error — defaulted to pass', rejection_category: null };
    defaulted = true;
  }

  if (parsed.decision === 'fail') {
    if (
      parsed.rejection_category == null ||
      !validRejectionCategories.includes(parsed.rejection_category as RejectionCategory)
    ) {
      console.warn(
        `[ResumeReviewer] WARNING: missing rejection_category for failed candidate ${candidateName} — defaulting to "general"`,
      );
      parsed.rejection_category = 'general';
    }
  } else {
    parsed.rejection_category = null;
  }

  return { ...parsed, defaulted };
}

export function tallyRejectionCounts(results: ReviewResult[]): {
  generalFilterRejects: number;
  labouringFilterRejects: number;
  heavyLabouringRejects: number;
  employmentDateRejects: number;
  civilLabourerRejects: number;
  productionWorkerRejects: number;
} {
  let generalFilterRejects = 0;
  let labouringFilterRejects = 0;
  let heavyLabouringRejects = 0;
  let employmentDateRejects = 0;
  let civilLabourerRejects = 0;
  let productionWorkerRejects = 0;

  for (const r of results) {
    if (r.ai_decision === 'fail') {
      if (r.rejection_category === 'general') generalFilterRejects++;
      else if (r.rejection_category === 'labouring') labouringFilterRejects++;
      else if (r.rejection_category === 'heavy_labouring') heavyLabouringRejects++;
      else if (r.rejection_category === 'employment_date') employmentDateRejects++;
      else if (r.rejection_category === 'civil_labourer') civilLabourerRejects++;
      else if (r.rejection_category === 'production_worker') productionWorkerRejects++;
    }
  }

  return { generalFilterRejects, labouringFilterRejects, heavyLabouringRejects, employmentDateRejects, civilLabourerRejects, productionWorkerRejects };
}
