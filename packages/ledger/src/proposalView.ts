import { proposals } from '@lance/db';
import type {
  ActionClass,
  CounterpartyClass,
  Proposal,
  ProposalStatus,
  System,
} from '@lance/shared';
import { and, desc, eq, lt, type SQL } from 'drizzle-orm';
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

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** Proposals newest first, filtered by cell and status, one page at a time. */
export async function listProposals(
  db: DbExecutor,
  filter: ProposalFilter = {},
): Promise<Proposal[]> {
  const clauses: SQL[] = [];
  if (filter.status !== undefined) clauses.push(eq(proposals.status, filter.status));
  if (filter.actionClass !== undefined) clauses.push(eq(proposals.actionClass, filter.actionClass));
  if (filter.counterpartyClass !== undefined)
    clauses.push(eq(proposals.counterpartyClass, filter.counterpartyClass));
  if (filter.targetSystem !== undefined)
    clauses.push(eq(proposals.targetSystem, filter.targetSystem));
  if (filter.cursor !== undefined) clauses.push(lt(proposals.id, filter.cursor));

  const rows = await db
    .select()
    .from(proposals)
    .where(clauses.length > 0 ? and(...clauses) : undefined)
    .orderBy(desc(proposals.id))
    .limit(Math.min(filter.limit ?? DEFAULT_LIMIT, MAX_LIMIT));

  return rows.map(toProposal);
}

/** One proposal, or null when no row carries that id. */
export async function getProposal(db: DbExecutor, id: string): Promise<Proposal | null> {
  const rows = await db.select().from(proposals).where(eq(proposals.id, id)).limit(1);
  const row = rows[0];
  return row === undefined ? null : toProposal(row);
}
