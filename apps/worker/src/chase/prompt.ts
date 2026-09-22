import { BANNED_CLOSERS, BANNED_PHRASES, CORRELATIVE_PAIRS } from '@lance/shared';

/**
 * The chase email in Dom's voice. Stable across runs so the prompt cache
 * hits (spec 13), and it carries the same banned lists as the debrief
 * follow-up so both drafts sound like the same person.
 */
export function chaseSystemPrompt(displayName: string): string {
  return [
    `You draft a chase email for Dom Selvon, a director at Valliance, an AI consultancy, about something somebody owes him. ${displayName} sends nothing: the draft goes to Dom for approval.`,
    '',
    "Write in Dom's voice: British English, direct, specific, warm without sentiment. Most sentences under fifteen words. Four sentences at most. Open on the thing outstanding, not on an apology for chasing. Close on what Dom needs and by when, never on a sentiment or a soft ask.",
    'No em dashes, no emojis, no bullet lists, no correlative conjunctions (' +
      CORRELATIVE_PAIRS.map(([a, b]) => `${a} / ${b}`).join(', ') +
      '), none of these phrases: ' +
      BANNED_PHRASES.join(', ') +
      '. Never close with: ' +
      BANNED_CLOSERS.join(', ') +
      '.',
    'Chase only the commitment you are given. State what was promised, when it was promised for, and how long it has been outstanding. Quote nothing back at length and do not accuse. Do not invent dates, prices, people or consequences. Address the recipient by first name.',
    'Reply with only the JSON object: subject and bodyText.',
  ].join('\n');
}

export interface ChaseMaterial {
  counterpartyName: string;
  description: string;
  evidenceQuote: string;
  /** Date only, YYYY-MM-DD, or null when nothing was promised for a date. */
  dueDate: string | null;
  /** Whole days past the due date, when there is one and it has passed. */
  overdueDays: number | null;
  /** Whole days since Lance recorded the commitment. */
  ageDays: number;
  /** How many times this commitment has been chased already. */
  chaseCount: number;
}

export function chaseUserPrompt(material: ChaseMaterial): string {
  return [
    `Recipient: ${material.counterpartyName}`,
    `They owe Dom: ${material.description}`,
    `Their words: "${material.evidenceQuote}"`,
    `Promised for: ${material.dueDate ?? 'no date was given'}`,
    `Days past the date: ${material.overdueDays === null ? 'not applicable' : String(material.overdueDays)}`,
    `Days since it was recorded: ${String(material.ageDays)}`,
    material.chaseCount === 0
      ? 'This is the first chase.'
      : `This has been chased ${String(material.chaseCount)} time(s) already; keep it shorter and firmer.`,
  ].join('\n');
}
