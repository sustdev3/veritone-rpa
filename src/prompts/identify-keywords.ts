import { KeywordMappingEntry } from '../shared/llm-service';

export function buildKeywordPrompt(
  jobTitle: string,
  jobDescription: string,
  keywordMapping: KeywordMappingEntry[],
): string {
  const mappingLines = keywordMapping
    .map((m) => `- ${m.title}: ${m.keywords}`)
    .join('\n');

  return `You are selecting search keywords to filter job applications for the role below.

Job title: ${jobTitle}

Job description:
${jobDescription}

Role-type keyword mapping:
${mappingLines}

Your task:
1. Read the job title and description to determine what type of role this is (e.g. pick/packer, forklift driver, civil labourer, meat labourer, assembler, bulk picker, labourer/production, etc.).
2. Match that role type to the closest entry in the mapping table above and use those keywords exactly.
3. If the role type does not closely match any entry, use your judgement to select the most relevant keywords from the mapping table.
4. Always return a single combined search string (e.g. "pack* OR pick*").

Return ONLY a JSON object in this exact format. No explanation, no markdown, no code fences:
{"keywords": "pack* OR pick*"}`;
}
