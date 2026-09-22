import type { BriefRecord } from './store.js';

/**
 * The shape the Today page renders (spec 12, Today row). Dates leave the
 * api as ISO strings, as the rest of the router does.
 *
 * `content` is the stored JSON as it was written. The worker owns those
 * shapes (`MorningBrief`, `AfternoonBoard`, and `{ eventId, section,
 * slackTs }` for a meeting prep) and the page reads the one it asked for;
 * the api does not reshape a brief it did not generate, so a brief written
 * before a shape changed still renders whatever of it the page understands.
 */

export interface BriefView {
  id: string;
  kind: string;
  correlationId: string;
  generatedAt: string;
  markdown: string;
  content: unknown;
  /** The parent Slack message, so the page can link to the thread. */
  slackTs: string | null;
}

/**
 * The `slackTs` the worker folds into every stored content object. Absent,
 * empty or the wrong type reads as null: a brief that was never posted to
 * Slack still renders.
 */
export function slackTsOf(content: unknown): string | null {
  if (typeof content !== 'object' || content === null || Array.isArray(content)) return null;
  const value = (content as Record<string, unknown>)['slackTs'];
  return typeof value === 'string' && value !== '' ? value : null;
}

export function toBriefView(record: BriefRecord): BriefView {
  return {
    id: record.id,
    kind: record.kind,
    correlationId: record.correlationId,
    generatedAt: record.generatedAt,
    markdown: record.markdown,
    content: record.content,
    slackTs: slackTsOf(record.content),
  };
}
