import { renderExecutedCard, renderProposalCard, type SlackSurface } from '@lance/connectors';
import { proposals, type Db } from '@lance/db';
import { toProposal } from '@lance/ledger';
import { eq } from 'drizzle-orm';
import type { ExecuteOutcome } from './index.js';

export interface ReflectDeps {
  db: Db;
  surface: Pick<SlackSurface, 'post' | 'update'> | null;
  render: { displayName: string; timeZone: string };
}

/**
 * Keeps Slack in step with the executor (spec 9.1): the proposal card shows
 * its new status after an execution, a hold or a failure, and an auto
 * execution gets an executed card with the single Undo / flag button.
 */
export async function reflectProposal(
  deps: ReflectDeps,
  proposalId: string,
  outcome: ExecuteOutcome,
): Promise<void> {
  if (deps.surface === null || outcome.status === 'skipped') return;
  const rows = await deps.db.select().from(proposals).where(eq(proposals.id, proposalId)).limit(1);
  const row = rows[0];
  if (row === undefined) return;
  const proposal = toProposal(row);
  const context = { correlationId: proposal.correlationId, proposalId };

  if (row.slackTs !== null) {
    const card = renderProposalCard(proposal, deps.render);
    await deps.surface.update({ ts: row.slackTs, text: card.text, blocks: card.blocks }, context);
  }

  if (outcome.status === 'executed' && proposal.policyDecision === 'auto') {
    const card = renderExecutedCard(proposal, deps.render);
    await deps.surface.post({ text: card.text, blocks: card.blocks }, context);
  }
}
