import type { Commitment, CommitmentNote } from '@lance/db';
import { ProvenanceRefSchema, type ProvenanceRef } from '@lance/shared';
import type { SourceObservation } from './store.js';

/**
 * The shape the Commitments page renders (spec 12, Commitments row). Dates
 * leave the api as ISO strings, as the proposals router already does, and
 * the ageing arithmetic happens here rather than in the browser so Slack and
 * the UI count the same days.
 */

export interface PersonView {
  id: string;
  name: string;
  email: string | null;
}

export interface CommitmentView {
  id: string;
  direction: Commitment['direction'];
  status: Commitment['status'];
  description: string;
  evidenceQuote: string;
  dueAt: string | null;
  dueConfidence: number | null;
  /** Whole days since the commitment was recorded. */
  ageDays: number;
  /** Whole days past the due date, while the commitment is still open or chased. */
  overdueDays: number | null;
  chaseCount: number;
  nextChaseAt: string | null;
  owner: PersonView;
  counterparty: PersonView;
  sourceRefs: ProvenanceRef[];
  createdAt: string;
  updatedAt: string;
}

/** A person node the graph does not hold, or holds without a display name. */
export const UNKNOWN_PERSON_NAME = 'Unknown person';

/** The statuses whose ageing is still running; a done or dropped row is not overdue. */
const LIVE_STATUSES: readonly Commitment['status'][] = ['open', 'chased'];

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days from `from` to `to`, floored, never negative. */
export function wholeDaysBetween(from: Date, to: Date): number {
  const days = Math.floor((to.getTime() - from.getTime()) / DAY_MS);
  return days < 0 ? 0 : days;
}

function firstEmail(properties: Record<string, unknown>): string | null {
  const emails = properties['emails'];
  if (!Array.isArray(emails)) return null;
  const first = emails.find((value): value is string => typeof value === 'string' && value !== '');
  return first ?? null;
}

/**
 * Names a person from their ontology node. A node the graph has lost still
 * renders, with its id, so a commitment never disappears from the page
 * because entity resolution has not caught up.
 */
export function toPersonView(
  id: string,
  node: { properties: Record<string, unknown> } | null,
): PersonView {
  if (node === null) return { id, name: UNKNOWN_PERSON_NAME, email: null };
  const displayName = node.properties['display_name'];
  return {
    id,
    name: typeof displayName === 'string' && displayName !== '' ? displayName : UNKNOWN_PERSON_NAME,
    email: firstEmail(node.properties),
  };
}

/**
 * The stored `source_refs` as provenance. A ref that does not parse is
 * dropped rather than thrown: the page still renders the ones that do, and
 * non-negotiable 5 is satisfied by what it shows.
 */
export function sourceRefsOf(value: unknown): ProvenanceRef[] {
  if (!Array.isArray(value)) return [];
  const refs: ProvenanceRef[] = [];
  for (const entry of value) {
    const parsed = ProvenanceRefSchema.safeParse(entry);
    if (parsed.success) refs.push(parsed.data);
  }
  return refs;
}

export interface CommitmentPeople {
  owner: PersonView;
  counterparty: PersonView;
}

export function toCommitmentView(
  row: Commitment,
  people: CommitmentPeople,
  now: Date,
): CommitmentView {
  const due = row.dueAt;
  const overdue =
    due !== null && LIVE_STATUSES.includes(row.status) && due.getTime() < now.getTime()
      ? wholeDaysBetween(due, now)
      : null;

  return {
    id: row.id,
    direction: row.direction,
    status: row.status,
    description: row.description,
    evidenceQuote: row.evidenceQuote,
    dueAt: due === null ? null : due.toISOString(),
    dueConfidence: row.dueConfidence,
    ageDays: wholeDaysBetween(row.createdAt, now),
    overdueDays: overdue,
    chaseCount: row.chaseCount,
    nextChaseAt: row.nextChaseAt === null ? null : row.nextChaseAt.toISOString(),
    owner: people.owner,
    counterparty: people.counterparty,
    sourceRefs: sourceRefsOf(row.sourceRefs),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface CommitmentNoteView {
  id: string;
  body: string;
  /** The ledger actor who wrote it, `user:<name>`. */
  author: string;
  createdAt: string;
}

export function toNoteView(note: CommitmentNote): CommitmentNoteView {
  return {
    id: note.id,
    body: note.body,
    author: note.author,
    createdAt: note.createdAt.toISOString(),
  };
}

/** The source text either side of the evidence quote, and the quote as the source has it. */
export interface Excerpt {
  before: string;
  quote: string;
  after: string;
}

/**
 * One cited source record as the page shows it beside the commitment: what
 * it was, who was on it, and the passage the quote came from.
 *
 * `state` says how much of it Lance still holds: `found` with the text,
 * `expired` once retention has nulled the payload (mail bodies after 90
 * days, transcripts after 180), `missing` for a record never observed in
 * this scope.
 */
export interface SourceContextView {
  system: ProvenanceRef['system'];
  recordId: string;
  url: string | null;
  observedAt: string;
  state: 'found' | 'expired' | 'missing';
  kind: 'email' | 'meeting' | 'record';
  /** The subject, the meeting title or the observation's summary line. */
  title: string | null;
  /** When the source says it happened: sent or received, or the meeting start. */
  occurredAt: string | null;
  /** The sender, for an email. */
  from: string | null;
  /** Recipients of an email, or the meeting's participants. */
  people: string[];
  /** The passage around the quote; null when the quote is not in the text Lance holds. */
  excerpt: Excerpt | null;
  /** The source's own short text when there is no excerpt: a preview or summary. */
  fallback: string | null;
}

/** Characters of source text kept either side of the quote. */
export const EXCERPT_CONTEXT_CHARS = 320;

const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim();

/**
 * Finds `quote` in `text`, ignoring case and runs of whitespace, and
 * returns it with the text around it, trimmed to whole words and marked
 * with an ellipsis where it was cut. Null when the quote is not there.
 */
export function excerptAround(
  text: string,
  quote: string,
  context: number = EXCERPT_CONTEXT_CHARS,
): Excerpt | null {
  const source = collapse(text);
  const wanted = collapse(quote);
  if (wanted === '') return null;
  const at = source.toLowerCase().indexOf(wanted.toLowerCase());
  if (at === -1) return null;
  const end = at + wanted.length;

  let before = source.slice(Math.max(0, at - context), at);
  if (at > context) before = `…${before.replace(/^\S*\s/, '')}`;
  let after = source.slice(end, end + context);
  if (end + context < source.length) after = `${after.replace(/\s\S*$/, '')}…`;

  return { before, quote: source.slice(at, end), after };
}

type Payload = Record<string, unknown>;

const isRecord = (value: unknown): value is Payload =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const text = (payload: Payload, key: string): string | null => {
  const value = payload[key];
  return typeof value === 'string' && value.trim() !== '' ? value : null;
};

/** "Ann Example <ann@example.com>", or whichever half the record holds. */
function addressLabel(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const name = text(value, 'name');
  const address = text(value, 'address') ?? text(value, 'email');
  if (name !== null && address !== null && name !== address) return `${name} <${address}>`;
  return name ?? address;
}

function labels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(addressLabel).filter((label): label is string => label !== null);
}

type Shape = Pick<SourceContextView, 'kind' | 'title' | 'occurredAt' | 'from' | 'people'> & {
  body: string | null;
  fallback: string | null;
};

/** Reads a Graph mail record (the mail watcher's canonical shape). */
function emailShape(payload: Payload): Shape {
  return {
    kind: 'email',
    title: text(payload, 'subject'),
    occurredAt: text(payload, 'sentDateTime') ?? text(payload, 'receivedDateTime'),
    from: addressLabel(payload['from']),
    people: [...labels(payload['toRecipients']), ...labels(payload['ccRecipients'])],
    body: text(payload, 'bodyText'),
    fallback: text(payload, 'bodyPreview'),
  };
}

/** Reads a Jamie meeting record (the meetings watcher's canonical shape). */
function meetingShape(payload: Payload): Shape {
  const participants = labels(payload['participants']);
  return {
    kind: 'meeting',
    title: text(payload, 'title'),
    occurredAt: text(payload, 'startTime'),
    from: null,
    people: participants.length > 0 ? participants : labels(payload['attendees']),
    body: text(payload, 'transcript'),
    fallback: text(payload, 'summaryShort'),
  };
}

function shapeOf(system: string, payload: Payload, summary: string | null): Shape {
  if (system === 'graph' && 'subject' in payload) return emailShape(payload);
  if (system === 'jamie' && payload['kind'] === 'meeting') return meetingShape(payload);
  return {
    kind: 'record',
    title: summary,
    occurredAt: null,
    from: null,
    people: [],
    body: null,
    fallback: null,
  };
}

/** The context panel for one provenance ref, from its newest observation. */
export function toSourceContext(
  ref: ProvenanceRef,
  observation: SourceObservation | undefined,
  evidenceQuote: string,
): SourceContextView {
  const base = {
    system: ref.system,
    recordId: ref.recordId,
    url: ref.url ?? null,
    observedAt: ref.observedAt,
  };
  const empty = {
    title: null,
    occurredAt: null,
    from: null,
    people: [],
    excerpt: null,
    fallback: null,
  };
  if (observation === undefined) return { ...base, state: 'missing', kind: 'record', ...empty };
  if (!isRecord(observation.payload)) {
    return { ...base, state: 'expired', kind: 'record', ...empty, title: observation.summary };
  }

  const shape = shapeOf(ref.system, observation.payload, observation.summary);
  const excerpt = shape.body === null ? null : excerptAround(shape.body, evidenceQuote);
  return {
    ...base,
    state: 'found',
    kind: shape.kind,
    title: shape.title ?? observation.summary,
    occurredAt: shape.occurredAt,
    from: shape.from,
    people: shape.people,
    excerpt,
    fallback: excerpt === null ? shape.fallback : null,
  };
}
