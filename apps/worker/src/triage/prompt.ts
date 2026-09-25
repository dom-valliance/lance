import type { LedgerEventRow } from '@lance/ledger';
import { BANNED_CLOSERS, BANNED_PHRASES, CORRELATIVE_PAIRS, MAIL_LABELS } from '@lance/shared';
import { GRAPH_CALENDAR_WATCHER_NAME } from '../watchers/graph/calendar.js';

const MAX_RECORD_CHARS = 12_000;

/**
 * Stable across runs for one principal so the prompt cache hits (spec
 * 13). Anything that changes per run belongs in the user prompt. It names
 * the principal the triage acts for, never Dom for anyone else.
 */
export function triageSystemPrompt(displayName: string, principalName: string): string {
  const name = principalName;
  return [
    `You are ${displayName}'s triage agent. ${displayName} is a personal operating agent for ${name}, at Valliance, an AI consultancy. You read a batch of new observations that share one correlation id (a mail thread, a meeting, a task change, a log line) and decide what matters.`,
    '',
    'Your output is a JSON object with: importance (0 to 1), urgency (0 to 1), a one-sentence summary, entities, commitments, taskCandidates, proposalsSubmitted, alertCandidates.',
    '',
    'Rules.',
    '1. Cite provenance. Every commitment, task candidate and alert candidate carries the recordId of the observation it came from and a verbatim quote from that record. Never paraphrase inside evidenceQuote. evidenceQuote is human-readable text from the record: a sentence from a body, a subject line, or for a calendar event the subject with the organiser and the time. It is never a field name, JSON or a key-value fragment such as "responseStatus":"notResponded".',
    '2. Actions are proposals. To act on something (apply a category, move a message, draft a reply, hold time in the calendar) call the create_proposal tool once per action, with the observation record ids as provenance. Never propose sending email or deleting anything; those are refused. Prefer no proposal over a weak one. Count what you submitted in proposalsSubmitted.',
    `3. Tasks are candidates, not proposals. Put any action item for ${name} or a colleague in taskCandidates; deterministic code turns them into Notion task proposals. Use assigneeName only when the source names someone other than ${name}.`,
    `4. Commitments run both ways: outbound is something ${name} owes, inbound is something owed to ${name}.`,
    `5. Mail labels are one of: ${MAIL_LABELS.join(', ')}.`,
    '6. Risk language in mail from a client (complaint, escalation, contract, legal) is an alertCandidate of kind risk_language_in_client_mail with severity P0.',
    `7. Drafts you propose are in ${name}'s voice: British English, direct, specific, no em dashes, no emojis, no correlative conjunctions (` +
      CORRELATIVE_PAIRS.map(([a, b]) => `${a} / ${b}`).join(', ') +
      '), none of these phrases: ' +
      BANNED_PHRASES.join(', ') +
      '. Never close with: ' +
      BANNED_CLOSERS.join(', ') +
      '. Most sentences under fifteen words. Open on the specific thing. Close on the ask or the fact.',
    '8. A meeting transcript (an observation from the jamie watcher with a transcript) also yields decisions and openQuestions, each one sentence with its verbatim quote and recordId; leave both empty for anything that is not a transcript. Commitments from a transcript are extracted separately, so list only the ones you are sure of.',
    '9. Reply with only the JSON object once you have finished any tool calls.',
  ].join('\n');
}

function clip(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > MAX_RECORD_CHARS ? `${text.slice(0, MAX_RECORD_CHARS)} [truncated]` : text;
}

/** `name address`, or `unknown` when neither is readable text. */
function personLine(person: unknown): string {
  if (typeof person !== 'object' || person === null) return 'unknown';
  const { name, address } = person as Record<string, unknown>;
  const label = [name, address]
    .filter((part): part is string => typeof part === 'string' && part !== '')
    .join(' ');
  return label === '' ? 'unknown' : label;
}

/** `dateTime timeZone`, or `unknown` when there is no usable dateTime. */
function momentLine(moment: unknown): string {
  if (typeof moment !== 'object' || moment === null) return 'unknown';
  const { dateTime, timeZone } = moment as Record<string, unknown>;
  if (typeof dateTime !== 'string' || dateTime === '') return 'unknown';
  return typeof timeZone === 'string' && timeZone !== '' ? `${dateTime} ${timeZone}` : dateTime;
}

/** `name address (status)` for one attendee. */
function attendeeStatusLine(attendee: unknown): string {
  if (typeof attendee !== 'object' || attendee === null) return 'unknown (unknown)';
  const { responseStatus } = attendee as Record<string, unknown>;
  const status =
    typeof responseStatus === 'string' && responseStatus !== '' ? responseStatus : 'unknown';
  return `${personLine(attendee)} (${status})`;
}

/**
 * A calendar record as labelled lines rather than a JSON dump, so the
 * model has human-readable text to quote as evidence. Dumped as JSON, a
 * calendar record's own field names and enum values (`"responseStatus":
 * "notResponded"`) read as plausible evidence and the model quoted one
 * verbatim; a calendar event has no body text to quote instead, so it
 * needs a rendering of its own rather than `clip`'s generic JSON dump.
 */
function renderCalendarRecord(record: Record<string, unknown>): string {
  const attendees = Array.isArray(record['attendees']) ? record['attendees'] : [];
  const subject =
    typeof record['subject'] === 'string' && record['subject'] !== ''
      ? record['subject']
      : '(no subject)';
  return [
    `subject: ${subject}`,
    `organiser: ${personLine(record['organizer'])}`,
    `start: ${momentLine(record['start'])}`,
    `end: ${momentLine(record['end'])}`,
    `attendees: ${attendees.length === 0 ? 'none' : attendees.map((attendee) => personLine(attendee)).join(', ')}`,
    `response status: ${attendees.length === 0 ? 'none' : attendees.map((attendee) => attendeeStatusLine(attendee)).join('; ')}`,
  ].join('\n');
}

/** One block per observed event: provenance first, then the record. */
export function triageUserPrompt(events: LedgerEventRow[]): string {
  const blocks = events.map((event, index) => {
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    const { watcher, summary, labels, url, ...record } = payload;
    const head = [
      `Observation ${index + 1}`,
      `system: ${event.sourceSystem ?? 'unknown'}`,
      `recordId: ${event.sourceRecordId ?? 'unknown'}`,
      `hash: ${event.sourceRecordHash ?? ''}`,
      `observedAt: ${event.ts.toISOString()}`,
      ...(typeof watcher === 'string' ? [`watcher: ${watcher}`] : []),
      ...(typeof url === 'string' ? [`url: ${url}`] : []),
      ...(Array.isArray(labels) ? [`labels: ${labels.join(', ')}`] : []),
      ...(typeof summary === 'string' ? [`summary: ${summary}`] : []),
    ];
    const rendered =
      watcher === GRAPH_CALENDAR_WATCHER_NAME ? renderCalendarRecord(record) : clip(record);
    return `${head.join('\n')}\nrecord:\n${rendered}`;
  });
  return `${blocks.join('\n\n')}\n\nTriage these observations. Correlation id: ${events[0]?.correlationId ?? 'unknown'}.`;
}
