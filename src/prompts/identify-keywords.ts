export function buildKeywordPrompt(
  jobTitle: string,
  jobDescription: string,
  commonKeywords: string[],
): string {
  return `You are helping to filter job applications for the following role.

Job title: ${jobTitle}

Job description:
${jobDescription}

Common keywords list (preferred):
${commonKeywords.map((k) => `- ${k}`).join('\n')}

Your task:
1. First check if any keyword from the common list above is relevant to this job role.
2. If yes — select 1 relevant keyword from the list plus up to 3 spelling variations of that same word (e.g. "forklift", "fork-lift", "fork lift"). Only use variations that are in the common list.
3. If no keyword from the common list is appropriate for this role — suggest 1 keyword of your own that best describes the core skill or experience required, plus up to 3 spelling variations of that word. Maximum 4 keywords total either way.

Return ONLY a JSON array of strings. No explanation, no markdown, no code fences.
Example: ["forklift", "fork-lift", "fork lift"]`;
}
