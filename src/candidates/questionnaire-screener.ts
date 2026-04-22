export interface ScreeningAnswers {
  licence: string;
  transport: string;
  fulltimeHours: string;
  immediateStart: string;
  lastJobEnd: string;
}

const DISQUALIFYING_TRANSPORT = ['public transport', 'get a lift', 'other'];

export function parseScreeningNote(noteText: string): ScreeningAnswers | null {
  if (!noteText.includes('Screening Form Response')) return null;

  const extract = (label: string): string => {
    const match = noteText.match(new RegExp(`${label}:\\s*([^\\-\\n]+?)\\s*(?:---|\\n|$)`, 'i'));
    return match?.[1]?.trim() ?? '';
  };

  return {
    licence: extract('Licence'),
    transport: extract('Transport'),
    fulltimeHours: extract('Fulltime Hours'),
    immediateStart: extract('Immediate Start'),
    lastJobEnd: extract('Last Job End'),
  };
}

export function shouldPurpleFlag(answers: ScreeningAnswers): boolean {
  if (answers.licence.toLowerCase() === 'no') return true;
  if (DISQUALIFYING_TRANSPORT.some((t) => answers.transport.toLowerCase().includes(t))) return true;
  if (answers.fulltimeHours.toLowerCase() === 'no') return true;
  if (answers.immediateStart.toLowerCase() === 'longer') return true;
  if (answers.lastJobEnd.toLowerCase() === 'more than a month') return true;
  return false;
}
