import type { Commitment } from '@lance/db';
import { ProvenanceRefSchema, type ProvenanceRef } from '@lance/shared';

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
