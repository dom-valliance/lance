import { renderProposalCard, type SlackSurface } from '@lance/connectors';
import type { DecisionInput, DecisionResult, ProposalAction } from '@lance/ledger';
import type { Config, Proposal } from '@lance/shared';
import type { FeedEvent } from '../events.js';

/**
 * One path for every proposal decision, whichever surface it arrives from
 * (spec 9.1, spec 12). It calls the ledger's decision service, which owns
 * the state machine and writes the `decided` event; nothing here touches
 * `proposals.status` directly. Then it queues execution when the service
 * says the proposal should run, redraws the Slack card so the channel and
 * the UI agree, and fans the change out to the live feed.
 */

export interface DecisionRequest {
  proposalId: string;
  action: ProposalAction;
  /** Derived from the verified caller, never from the request body. */
  actor: string;
  note?: string;
  reasonCode?: string;
  editedPayload?: Record<string, unknown>;
  snoozeHours?: number;
}

export interface DecideDeps {
  /** `decideProposal` bound to the database. */
  decide(input: DecisionInput): Promise<DecisionResult>;
  getProposal(id: string): Promise<Proposal | null>;
  enqueueExecute(proposalId: string): Promise<void>;
  /** Null when no bot token is configured, so a local run skips the card. */
  slack: Pick<SlackSurface, 'update'> | null;
  notify(event: FeedEvent): void;
  config: Pick<Config, 'agentDisplayName' | 'timeZone'>;
  /**
   * Called when the card could not be redrawn. The decision has already
   * landed by then, so the failure is reported rather than thrown: losing
   * the reply would leave the caller retrying a decision it already made.
   */
  onSlackFailure?: (error: unknown, proposalId: string) => void;
}

/** Copies only the keys that were supplied; `exactOptionalPropertyTypes` rejects an explicit undefined. */
const toDecisionInput = (request: DecisionRequest): DecisionInput => {
  const input: DecisionInput = {
    proposalId: request.proposalId,
    action: request.action,
    actor: request.actor,
  };
  if (request.note !== undefined) input.note = request.note;
  if (request.reasonCode !== undefined) input.reasonCode = request.reasonCode;
  if (request.editedPayload !== undefined) input.editedPayload = request.editedPayload;
  if (request.snoozeHours !== undefined) input.snoozeHours = request.snoozeHours;
  return input;
};

export async function applyDecision(
  deps: DecideDeps,
  request: DecisionRequest,
): Promise<DecisionResult> {
  const result = await deps.decide(toDecisionInput(request));

  if (result.execute) {
    await deps.enqueueExecute(result.proposalId);
  }

  await updateCard(deps, result.proposalId);
  deps.notify({ type: 'proposal', id: result.proposalId });

  return result;
}

/** Redraws the card in place, for a proposal that was posted to Slack. */
async function updateCard(deps: DecideDeps, proposalId: string): Promise<void> {
  if (deps.slack === null) return;

  const proposal = await deps.getProposal(proposalId);
  if (proposal === null || proposal.slackChannel === null || proposal.slackTs === null) return;

  const card = renderProposalCard(proposal, {
    displayName: deps.config.agentDisplayName,
    timeZone: deps.config.timeZone,
  });

  try {
    await deps.slack.update(
      { ts: proposal.slackTs, text: card.text, blocks: card.blocks },
      { correlationId: proposal.correlationId, proposalId: proposal.id },
    );
  } catch (error) {
    deps.onSlackFailure?.(error, proposalId);
  }
}
