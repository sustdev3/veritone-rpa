export function buildReviewPrompt(
  cvText: string,
  rejectionCriteria: string,
  strictMode: boolean,
  candidateName: string,
): string {
  const strictModeSection = strictMode
    ? `\n- Additionally reject candidates who only list year-only employment dates (e.g. "2024") without month ranges — this is suspicious and treated as a rejection criterion.`
    : '';

  return `You are reviewing a candidate resume for a blue-collar warehouse/labour job in Australia.

STRICT RULES — you must follow these exactly:
- You must ONLY reject a candidate based on the exact criteria listed below. Do not invent or infer additional rejection reasons.
- If a criterion cannot be clearly and confidently confirmed from the CV content alone, default to PASS — do not assume the worst.
- Cover letter language, tone, or career aspirations are NOT rejection criteria. Ignore them entirely.
- If the candidate lists a current job (e.g. "01/2022 - Current"), that satisfies the 6-month employment requirement. Do not question it.
- Do not comment on CV format, writing style, or make assumptions about whether a submission is genuine.
- When in doubt, PASS.

AGE INFERENCE RULE — read carefully:
Only reject for age if:
- The CV explicitly states a date of birth or age, OR
- The email contains a standalone 4-digit number between 1940 and 1974 that plausibly represents a birth year (e.g. john1965@ is plausible)

NEGATIVE EXAMPLE — do not do this:
  Email: danielcunningham0512@gmail.com
  WRONG reasoning: "0512 suggests birth year 1952, candidate is ~72 years old"
  WHY IT IS WRONG: "0512" is not a birth year. It could be a birthday (May 12), a jersey number, or anything else. A 4-digit number in an email that does not clearly follow the pattern of a standalone 4-digit year must NOT be interpreted as a birth year.
  CORRECT behaviour: cannot determine age from this email — default to PASS.

Review the CV for candidate ${candidateName} against ALL of the following rejection criteria:

${rejectionCriteria}${strictModeSection}

Respond ONLY in raw JSON with no preamble, no markdown, no backticks:
{
  "decision": "pass" or "fail",
  "reason": "brief explanation",
  "rejection_category": "general" | "labouring" | "heavy_labouring" | "employment_date" | null
}

Rules for rejection_category:
- If decision is "fail", rejection_category MUST be one of the four values — never null on a fail.
- If decision is "pass", rejection_category MUST be null.
- If multiple filters apply, pick the PRIMARY reason using this priority:
  1. "employment_date" — no job in last 6 months or no similar role in 3 years
  2. "labouring" — age over 50 or female without recent labouring experience
  3. "heavy_labouring" — weight, nationality, or female restriction for heavy roles
  4. "general" — anything else

CV:
${cvText}`;
}
