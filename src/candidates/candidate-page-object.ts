import { callLLM } from '../shared/llm-service';
import { buildKeywordPrompt } from '../prompts/identify-keywords';

export interface PassingCandidate {
  id: string;
  name: string;
  flagged_status: boolean;
  flag_colour: string | null;
}

export interface FilterResult {
  selectedKeywords: string[];
  filteredCount: number;
}

export interface CollectResult {
  passingCandidates: PassingCandidate[];
  totalFiltered: number;
}

export interface CardData {
  id: string;
  name: string;
  nonGreyCount: number;
  activeColour: string | null;
}

export interface NonPassingNoFlag {
  id: string;
  name: string;
}

export interface NonPassingAlreadyFlagged {
  id: string;
  name: string;
  flag_colour: string;
}

export interface FlagResult {
  skippedPassing: number;
  flaggedCount: number;
  alreadyFlagged: number;
}

export const FLAG_COLOUR_MAP: Record<string, string> = {
  'rgb(255, 0, 0)':     'red',
  'rgb(255, 165, 0)':   'amber',
  'rgb(0, 128, 0)':     'green',
  'rgb(128, 128, 128)': 'unranked',
  'rgb(15, 15, 119)':   'good',
  'rgb(171, 38, 207)':  'purple',
};

export function classifyCards(
  cards: CardData[],
  passingIds: Set<string>,
): { noFlag: NonPassingNoFlag[]; alreadyFlagged: NonPassingAlreadyFlagged[]; skipped: number } {
  const noFlag: NonPassingNoFlag[] = [];
  const alreadyFlagged: NonPassingAlreadyFlagged[] = [];
  let skipped = 0;

  for (const card of cards) {
    if (passingIds.has(card.id)) {
      skipped++;
      continue;
    }

    if (card.nonGreyCount > 1) {
      noFlag.push({ id: card.id, name: card.name });
    } else if (card.nonGreyCount === 1) {
      alreadyFlagged.push({
        id: card.id,
        name: card.name,
        flag_colour: card.activeColour ?? 'unknown',
      });
    } else {
      console.warn(
        `[CandidateFlagger] Unexpected: candidate ${card.id} (${card.name}) has 0 non-grey flags — skipping.`,
      );
    }
  }

  return { noFlag, alreadyFlagged, skipped };
}

export function buildCollectSummary(
  passingCandidates: PassingCandidate[],
): { unflaggedCount: number; flaggedCount: number; colourSummary: string } {
  const unflaggedCount = passingCandidates.filter((c) => !c.flagged_status).length;
  const flaggedCount = passingCandidates.filter((c) => c.flagged_status).length;
  const colourCounts: Record<string, number> = {};
  for (const c of passingCandidates) {
    if (c.flag_colour) {
      colourCounts[c.flag_colour] = (colourCounts[c.flag_colour] ?? 0) + 1;
    }
  }
  const colourSummary = Object.entries(colourCounts)
    .map(([colour, count]) => `${colour}: ${count}`)
    .join(', ');
  return { unflaggedCount, flaggedCount, colourSummary };
}

export async function selectKeywordsViaLLM(
  jobTitle: string,
  jobDescription: string,
  commonKeywords: string[],
  llmSelections: Record<string, string>,
): Promise<string[]> {
  const prompt = buildKeywordPrompt(jobTitle, jobDescription, commonKeywords);

  const raw = await callLLM('identify keywords', prompt, llmSelections);

  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

  let keywords: string[] = [];
  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) {
      keywords = parsed
        .filter((k): k is string => typeof k === 'string' && k.trim().length > 0)
        .slice(0, 4);
    } else {
      console.warn('[CandidateFilter] LLM returned JSON but not an array — using empty keyword list.');
    }
  } catch {
    console.warn(`[CandidateFilter] Could not parse LLM keyword response as JSON: "${cleaned}" — using empty keyword list.`);
  }

  console.log(`[CandidateFilter] Selected keywords: [${keywords.map((k) => `"${k}"`).join(', ')}]`);
  return keywords;
}
