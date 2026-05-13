export interface ScreeningAnswers {
  licence: string;
  transport: string;
  fulltimeHours: string;
  immediateStart: string;
  lastJobEnd: string;
  livingInAus: string;
}

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
    livingInAus: extract('Living in AUS'),
  };
}

export function shouldPurpleFlag(answers: ScreeningAnswers): boolean {
  const transportFails =
    answers.transport.trim() !== '' &&
    !answers.transport.toLowerCase().includes('car/motorbike');

  return (
    answers.licence.toLowerCase() === 'no' ||
    transportFails ||
    answers.fulltimeHours.toLowerCase() === 'no' ||
    answers.livingInAus.toLowerCase() === 'no'
  );
}
