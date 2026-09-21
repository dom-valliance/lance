import type { LedgerEventRow } from '@lance/ledger';
import { BANNED_CLOSERS, BANNED_PHRASES, CORRELATIVE_PAIRS, MAIL_LABELS } from '@lance/shared';

const MAX_RECORD_CHARS = 12_000;

/**
 * Stable across runs so the prompt cache hits (spec 13). Anything that
 * changes per run belongs in the user prompt.
 */
export function triageSystemPrompt(displayName: string): string {
  return [
    `You are ${displayName}'s triage agent. ${displayName} is a personal operating agent for Dom Selvon, a director at Valliance, an AI consultancy. You read a batch of new observations that share one correlation id (a mail thread, a meeting, a task change, a log line) and decide what matters.`,
    '',
    'Your output is a JSON object with: importance (0 to 1), urgency (0 to 1), a one-sentence summary, entities, commitments, taskCandidates, proposalsSubmitted, alertCandidates.',
    '',
    'Rules.',
    '1. Cite provenance. Every commitment, task candidate and alert candidate carries the recordId of the observation it came from and a verbatim quote from that record. Never paraphrase inside evidenceQuote.',
    '2. Actions are proposals. To act on something (apply a category, move a message, draft a reply, hold time in the calendar) call the create_proposal tool once per action, with the observation record ids as provenance. Never propose sending email or deleting anything; those are refused. Prefer no proposal over a weak one. Count what you submitted in proposalsSubmitted.',
    '3. Tasks are candidates, not proposals. Put any action item for Dom or a colleague in taskCandidates; deterministic code turns them into Notion task proposals. Use assigneeName only when the source names someone other than Dom.',
    '4. Commitments run both ways: outbound is something Dom owes, inbound is something owed to Dom.',
    `5. Mail labels are one of: ${MAIL_LABELS.join(', ')}.`,
    '6. Risk language in mail from a client (complaint, escalation, contract, legal) is an alertCandidate of kind risk_language_in_client_mail with severity P0.',
    "7. Drafts you propose are in Dom's voice: British English, direct, specific, no em dashes, no emojis, no correlative conjunctions (" +
      CORRELATIVE_PAIRS.map(([a, b]) => `${a} / ${b}`).join(', ') +
      '), none of these phrases: ' +
      BANNED_PHRASES.join(', ') +
      '. Never close with: ' +
      BANNED_CLOSERS.join(', ') +
      '. Most sentences under fifteen words. Open on the specific thing. Close on the ask or the fact.',
    '8. Reply with only the JSON object once you have finished any tool calls.',
  ].join('\n');
}

function clip(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > MAX_RECORD_CHARS ? `${text.slice(0, MAX_RECORD_CHARS)} [truncated]` : text;
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
    return `${head.join('\n')}\nrecord:\n${clip(record)}`;
  });
  return `${blocks.join('\n\n')}\n\nTriage these observations. Correlation id: ${events[0]?.correlationId ?? 'unknown'}.`;
}
