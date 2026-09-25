import { BANNED_CLOSERS, BANNED_PHRASES, CORRELATIVE_PAIRS } from '@lance/shared';

/** Stable across runs for one principal so the prompt cache hits (spec 13). */
export function followUpSystemPrompt(displayName: string, principalName: string): string {
  const name = principalName;
  return [
    `You draft follow-up email for ${name}, at Valliance, an AI consultancy, after a meeting. ${displayName} sends nothing: the draft goes to ${name} for approval.`,
    '',
    `Write in ${name}'s voice: British English, direct, specific, warm without sentiment. Most sentences under fifteen words. Open on the specific thing agreed, not on thanks for the time. Close on the next step or the fact, never on a sentiment or a soft ask.`,
    'No em dashes, no emojis, no bullet lists longer than four items, no correlative conjunctions (' +
      CORRELATIVE_PAIRS.map(([a, b]) => `${a} / ${b}`).join(', ') +
      '), none of these phrases: ' +
      BANNED_PHRASES.join(', ') +
      '. Never close with: ' +
      BANNED_CLOSERS.join(', ') +
      '.',
    `State only what the meeting material supports. Name what ${name} owes with its date when there is one, and what the other side agreed to. Do not invent dates, prices or people. Address the external attendees by first name when there are three or fewer.`,
    'Reply with only the JSON object: subject and bodyText.',
  ].join('\n');
}

export interface FollowUpMaterial {
  title: string;
  date: string;
  externalNames: readonly string[];
  summary: string | null;
  decisions: readonly string[];
  domOwes: readonly string[];
  theyOwe: readonly string[];
  openQuestions: readonly string[];
}

export function followUpUserPrompt(material: FollowUpMaterial): string {
  const list = (items: readonly string[]): string =>
    items.length === 0 ? 'none' : items.map((item) => `- ${item}`).join('\n');
  return [
    `Meeting: ${material.title} on ${material.date}`,
    `External attendees: ${material.externalNames.length === 0 ? 'none' : material.externalNames.join(', ')}`,
    `Summary: ${material.summary ?? 'none'}`,
    'Decisions:',
    list(material.decisions),
    'The principal owes:',
    list(material.domOwes),
    'They owe the principal:',
    list(material.theyOwe),
    'Open questions:',
    list(material.openQuestions),
  ].join('\n');
}
