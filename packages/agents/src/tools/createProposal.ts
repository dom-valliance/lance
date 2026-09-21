import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import {
  ActionClassSchema,
  CounterpartyClassSchema,
  ProvenanceRefSchema,
  SystemSchema,
} from '@lance/shared';
import { z } from 'zod';

/** What a model may ask for. Everything else about a proposal is derived by deterministic code. */
export const ProposalDraftSchema = z.object({
  actionClass: ActionClassSchema,
  counterpartyClass: CounterpartyClassSchema,
  targetSystem: SystemSchema,
  targetRecordId: z.string().nullable(),
  /** The exact write the executor would perform, as the connector expects it. */
  payload: z.record(z.string(), z.unknown()),
  /** Human-readable rendering shown in Slack and the UI. */
  preview: z.string().min(1).max(4000),
  rationale: z.string().min(1).max(2000),
  provenance: z.array(ProvenanceRefSchema).min(1),
  confidence: z.number().min(0).max(1),
});
export type ProposalDraft = z.infer<typeof ProposalDraftSchema>;

export interface CreateProposalOutcome {
  proposalId: string;
  decision: 'forbid' | 'propose' | 'auto';
  status: string;
  note?: string;
}

export type CreateProposalHandler = (draft: ProposalDraft) => Promise<CreateProposalOutcome>;

/**
 * The single write tool available to a model (CLAUDE.md non-negotiable 2).
 * The handler is deterministic code: it runs policy, writes the proposal and
 * routes it. The model only ever sees the outcome as text.
 */
export function createProposalTool(handler: CreateProposalHandler) {
  return betaZodTool({
    name: 'create_proposal',
    description:
      'Propose one action for Dom to approve. Include every source you relied on as provenance. Never propose sending email or deleting anything; those are refused. Prefer no proposal over a weak one.',
    inputSchema: ProposalDraftSchema,
    run: async (draft) => {
      const outcome = await handler(draft);
      const note = outcome.note === undefined ? '' : ` ${outcome.note}`;
      return `Proposal ${outcome.proposalId} recorded with policy decision ${outcome.decision} and status ${outcome.status}.${note}`;
    },
  });
}
