export interface ReviewResult {
  id: string;
  name: string;
  ai_decision: string;
  ai_reason: string;
  rejection_category: RejectionCategory | null;
}

export interface ReviewSummary {
  passCount: number;
  failCount: number;
  flaggedCount: number;
  skippedCount: number;
  skippedPreviouslyPassed: number;
  generalFilterRejects: number;
  labouringFilterRejects: number;
  heavyLabouringRejects: number;
  employmentDateRejects: number;
}

export const validRejectionCategories = [
  'general',
  'labouring',
  'heavy_labouring',
  'employment_date',
] as const;

export type RejectionCategory = typeof validRejectionCategories[number];

export function validateLlmResponse(
  rawResponse: string,
  candidateName: string,
): { decision: string; reason: string; rejection_category: RejectionCategory | null } {
  const cleaned = rawResponse.replace(/```(?:json)?|```/g, '').trim();

  let parsed: { decision: string; reason: string; rejection_category: RejectionCategory | null };
  try {
    parsed = JSON.parse(cleaned) as typeof parsed;
  } catch {
    console.log(
      `[ResumeReviewer] WARNING: Could not parse LLM response for ${candidateName} — defaulting to pass`,
    );
    parsed = { decision: 'pass', reason: 'JSON parse error — defaulted to pass', rejection_category: null };
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

  return parsed;
}

export function tallyRejectionCounts(results: ReviewResult[]): {
  generalFilterRejects: number;
  labouringFilterRejects: number;
  heavyLabouringRejects: number;
  employmentDateRejects: number;
} {
  let generalFilterRejects = 0;
  let labouringFilterRejects = 0;
  let heavyLabouringRejects = 0;
  let employmentDateRejects = 0;

  for (const r of results) {
    if (r.ai_decision === 'fail') {
      if (r.rejection_category === 'general') generalFilterRejects++;
      else if (r.rejection_category === 'labouring') labouringFilterRejects++;
      else if (r.rejection_category === 'heavy_labouring') heavyLabouringRejects++;
      else if (r.rejection_category === 'employment_date') employmentDateRejects++;
    }
  }

  return { generalFilterRejects, labouringFilterRejects, heavyLabouringRejects, employmentDateRejects };
}
