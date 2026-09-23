import { proposals } from '@lance/db';
import type {
  ActionClass,
  CounterpartyClass,
  Proposal,
  ProposalStatus,
  System,
} from '@lance/shared';
import { and, count, desc, eq, lt, min, type SQL } from 'drizzle-orm';
import type { DbExecutor } from './writer.js';

/**
 * The read side of `proposals`: one mapper from the database row to the
 * shared `Proposal` the Slack renderers and the web app both take, and the
 * two queries the api serves. The mapper lived in the worker's executor
 * until the api needed it as well; it is here so neither app imports the
 * other.
 */

export type ProposalRow = typeof proposals.$inferSelect;

/** Maps a proposals row to the shared Proposal shape the renderers take. */
export function toProposal(row: ProposalRow): Proposal {
  return {
    id: row.id,
    correlationId: row.correlationId,
    actionClass: row.actionClass,
    counterpartyClass: row.counterpartyClass,
    targetSystem: row.targetSystem,
    targetRecordId: row.targetRecordId,
    reversibility: row.reversibility,
    payload: row.payload as Record<string, unknown>,
    preview: row.preview,
    rationale: row.rationale,
    provenance: row.provenance as Proposal['provenance'],
    policyDecision: row.policyDecision,
    policyRuleId: row.policyRuleId,
    status: row.status,
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt === null ? null : row.decidedAt.toISOString(),
    decisionNote: row.decisionNote,
    editedPayload: row.editedPayload as Record<string, unknown> | null,
    slackChannel: row.slackChannel,
    slackTs: row.slackTs,
    expiresAt: row.expiresAt.toISOString(),
    executionEventId: row.executionEventId,
  };
}

export interface ProposalFilter {
  status?: ProposalStatus;
  actionClass?: ActionClass;
  counterpartyClass?: CounterpartyClass;
  targetSystem?: System;
  limit?: number;
  /**
   * The id of the last proposal on the previous page. Ids are ULIDs, so
   * they sort in creation order and the cursor needs no second column.
   */
  cursor?: string;
}

/** The filters a count honours: the list's, without the page it would cut. */
export type ProposalCountFilter = Omit<ProposalFilter, 'limit' | 'cursor'>;

/** The Proposals header: how much is waiting, and the soonest any of it expires. */
export interface PendingProposalSummary {
  pending: number;
  /** ISO instant of the earliest `expires_at` among pending proposals, or null when none wait. */
  oldestExpiresAt: string | null;
}

/** The WHERE clauses `listProposals` and `countProposals` share, so the two cannot drift apart. */
function clausesFor(filter: ProposalCountFilter): SQL[] {
  const clauses: SQL[] = [];
  if (filter.status !== undefined) clauses.push(eq(proposals.status, filter.status));
  if (filter.actionClass !== undefined) clauses.push(eq(proposals.actionClass, filter.actionClass));
  if (filter.counterpartyClass !== undefined)
    clauses.push(eq(proposals.counterpartyClass, filter.counterpartyClass));
  if (filter.targetSystem !== undefined)
    clauses.push(eq(proposals.targetSystem, filter.targetSystem));
  return clauses;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** Proposals newest first, filtered by cell and status, one page at a time. */
export async function listProposals(
  db: DbExecutor,
  filter: ProposalFilter = {},
): Promise<Proposal[]> {
  const clauses = clausesFor(filter);
  if (filter.cursor !== undefined) clauses.push(lt(proposals.id, filter.cursor));

  const rows = await db
    .select()
    .from(proposals)
    .where(clauses.length > 0 ? and(...clauses) : undefined)
    .orderBy(desc(proposals.id))
    .limit(Math.min(filter.limit ?? DEFAULT_LIMIT, MAX_LIMIT));

  return rows.map(toProposal);
}

/** Every proposal `listProposals` would return across all its pages. */
export async function countProposals(
  db: DbExecutor,
  filter: ProposalCountFilter = {},
): Promise<number> {
  const clauses = clausesFor(filter);
  const rows = await db
    .select({ total: count() })
    .from(proposals)
    .where(clauses.length > 0 ? and(...clauses) : undefined);
  return rows[0]?.total ?? 0;
}

/** The pending count and the earliest expiry among them, in one aggregate read. */
export async function pendingProposalSummary(db: DbExecutor): Promise<PendingProposalSummary> {
  const rows = await db
    .select({ pending: count(), oldest: min(proposals.expiresAt) })
    .from(proposals)
    .where(eq(proposals.status, 'pending'));
  const row = rows[0];
  const oldest = row?.oldest ?? null;
  return {
    pending: row?.pending ?? 0,
    oldestExpiresAt: oldest === null ? null : new Date(oldest).toISOString(),
  };
}

/** One proposal, or null when no row carries that id. */
export async function getProposal(db: DbExecutor, id: string): Promise<Proposal | null> {
  const rows = await db.select().from(proposals).where(eq(proposals.id, id)).limit(1);
  const row = rows[0];
  return row === undefined ? null : toProposal(row);
}
