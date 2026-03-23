import Anthropic from '@anthropic-ai/sdk';
import ExcelJS from 'exceljs';
import path from 'path';

const VARIABLES_PATH = path.resolve(process.cwd(), 'data', 'Variables-used-by-LLMs.xlsx');

const MODEL_MAP: Record<string, string> = {
  haiku:  'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-6',
  opus:   'claude-opus-4-6',
};

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

const client = new Anthropic();

export async function loadLLMSelections(): Promise<Record<string, string>> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(VARIABLES_PATH);

  const sheet = workbook.getWorksheet('LLM-selection');
  if (!sheet) {
    throw new Error('[LLMService] Sheet "LLM-selection" not found in Variables-used-by-LLMs.xlsx');
  }

  const selections: Record<string, string> = {};

  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;

    const task      = row.getCell(1).text?.trim().toLowerCase();
    const modelName = row.getCell(2).text?.trim().toLowerCase();
    if (!task) return;

    const modelId = MODEL_MAP[modelName] ?? DEFAULT_MODEL;

    if (!MODEL_MAP[modelName]) {
      console.warn(
        `[LLMService] Unrecognised model name "${modelName}" for task "${task}" — falling back to ${DEFAULT_MODEL}`,
      );
    }

    selections[task] = modelId;
  });

  return selections;
}

export interface KeywordMappingEntry {
  title: string;
  keywords: string;
}

export async function loadKeywordMapping(): Promise<KeywordMappingEntry[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(VARIABLES_PATH);

  const sheet = workbook.getWorksheet('Keyword-mapping');
  if (!sheet) {
    throw new Error('[LLMService] Sheet "Keyword-mapping" not found in Variables-used-by-LLMs.xlsx');
  }

  const mapping: KeywordMappingEntry[] = [];

  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const title = row.getCell(1).text?.trim();
    const keywords = row.getCell(2).text?.trim();
    if (title && keywords) mapping.push({ title, keywords });
  });

  return mapping;
}

export async function callLLM(
  task: string,
  prompt: string,
  llmSelections: Record<string, string>,
): Promise<string> {
  const model = llmSelections[task.toLowerCase()] ?? DEFAULT_MODEL;

  const MAX_RETRIES = 3;
  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await client.messages.create({
        model,
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }],
      });

      const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
      return textBlock?.text ?? '';
    } catch (error) {
      lastError = error;

      const isRateLimit = error instanceof Anthropic.RateLimitError;
      const isOverloaded =
        error instanceof Error &&
        'status' in error &&
        (error as { status: unknown }).status === 529;

      if ((isRateLimit || isOverloaded) && attempt < MAX_RETRIES) {
        const waitSecs = isOverloaded ? Math.pow(2, attempt) * 15 : Math.pow(2, attempt);
        const reason = isOverloaded ? 'Overloaded' : 'Rate limited';
        console.warn(
          `[LLMService] ${reason} on attempt ${attempt + 1}/${MAX_RETRIES}. ` +
          `Retrying in ${waitSecs}s...`,
        );
        await new Promise((resolve) => setTimeout(resolve, waitSecs * 1_000));
        continue;
      }
      throw error;
    }
  }

  throw lastError ?? new Error(`[LLMService] All ${MAX_RETRIES} retries exhausted for task "${task}".`);
}

export async function loadAllVariables(): Promise<{
  llmSelections: Record<string, string>;
  keywordMapping: KeywordMappingEntry[];
}> {
  const [llmSelections, keywordMapping] = await Promise.all([
    loadLLMSelections(),
    loadKeywordMapping(),
  ]);

  const taskList = Object.entries(llmSelections)
    .map(([task, model]) => `"${task}" → ${model}`)
    .join(', ');

  console.log(`[LLMService] Loaded ${Object.keys(llmSelections).length} LLM task selection(s): ${taskList}`);
  console.log(`[LLMService] Loaded ${keywordMapping.length} keyword mapping(s).`);

  return { llmSelections, keywordMapping };
}
