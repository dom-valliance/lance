import type { CommitmentSource } from './schema.js';

const MAX_TEXT_CHARS = 60_000;

/** Stable across runs so the prompt cache hits (spec 13). */
export function commitmentSystemPrompt(displayName: string): string {
  return [
    `You extract commitments for ${displayName}, a personal operating agent for Dom Selvon, a director at Valliance, an AI consultancy. You read one meeting transcript or one email Dom sent and list the commitments in it. You never act on them.`,
    '',
    'A commitment is a promise by one named person to do a specific thing, made in this text. Two directions:',
    '- outbound: Dom (or Valliance through Dom) promises something to someone else.',
    '- inbound: someone else promises something to Dom or to Valliance.',
    '',
    'Rules.',
    '1. Extract only what the text commits to. Ideas, questions, hopes, suggestions, hedged maybes, and watching or waiting for something are not commitments. A promise one third party makes to another third party is not a commitment even when Dom made the introduction or is copied: inbound means the promise is made to Dom or to Valliance.',
    '2. One commitment per promise. A sentence that promises two separate deliverables yields two items; a promise and its follow-up notification (do X and let you know) is one item.',
    '3. description is one plain sentence naming the thing to be done, without the date and without "I will".',
    '4. counterpartyName is the other party, always one named person from the participants list, never a group, board, team or organisation; counterpartyEmail when the participants list gives it, else null. For an outbound commitment made to a group in a meeting, the counterparty is the person who asked for it or who is chairing.',
    '5. dueAt is an ISO date (YYYY-MM-DD) or date-time when the text gives a date or a phrase that resolves to one from the source date (by Friday, end of the month, tomorrow). dueConfidence is 1.0 for an explicit date, 0.7 for a resolved phrase, 0.3 for a vague window such as next week, 0 with dueAt null when nothing is said.',
    '6. evidenceQuote is a verbatim span from the text containing the promise. Never paraphrase, never add speaker names that are not in the span, keep it under 500 characters.',
    '7. recordId is the id of the source given in the prompt.',
    '8. Reply with only the JSON object.',
  ].join('\n');
}

export function commitmentUserPrompt(source: CommitmentSource): string {
  const participants = source.participants
    .map((person) => (person.email === null ? person.name : `${person.name} <${person.email}>`))
    .join('; ');
  const text =
    source.text.length > MAX_TEXT_CHARS
      ? `${source.text.slice(0, MAX_TEXT_CHARS)} [truncated]`
      : source.text;
  return [
    `Source id: ${source.id}`,
    `Kind: ${source.kind === 'transcript' ? 'meeting transcript' : 'email sent by Dom'}`,
    `Dom: ${source.dom.name} <${source.dom.email}>`,
    `Participants: ${participants === '' ? 'none listed' : participants}`,
    `Source date: ${source.occurredAt ?? 'unknown'}`,
    '',
    'Text:',
    text,
  ].join('\n');
}
