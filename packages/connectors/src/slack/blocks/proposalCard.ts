import type { ActionsBlock, KnownBlock } from '@slack/types';
import type { Proposal } from '@lance/shared';
import { ACTION } from './actions.js';
import {
  chipLine,
  formatDateTime,
  formatTime,
  policyCell,
  provenanceContext,
  truncate,
  type RenderedMessage,
  type RenderOptions,
} from './format.js';

function approveRejectActions(proposalId: string): ActionsBlock {
  return {
    type: 'actions',
    elements: [
      {
        type: 'button',
        action_id: ACTION.proposalApprove,
        text: { type: 'plain_text', text: 'Approve' },
        style: 'primary',
        value: proposalId,
      },
      {
        type: 'button',
        action_id: ACTION.proposalEdit,
        text: { type: 'plain_text', text: 'Edit' },
        value: proposalId,
      },
      {
        type: 'button',
        action_id: ACTION.proposalReject,
        text: { type: 'plain_text', text: 'Reject' },
        style: 'danger',
        value: proposalId,
      },
      {
        type: 'button',
        action_id: ACTION.proposalSnooze,
        text: { type: 'plain_text', text: 'Snooze 4h' },
        value: proposalId,
      },
    ],
  };
}

/**
 * The decided-card status line (spec 9.1: "the same renderer updates a
 * decided card"). Not called for `pending`, which renders the actions
 * block instead; the switch is exhaustive over `ProposalStatus` so adding a
 * new status is a compile error here until this function accounts for it.
 */
function statusLine(proposal: Proposal, timeZone: string): string {
  const decidedAt = proposal.decidedAt === null ? null : formatTime(proposal.decidedAt, timeZone);
  const decidedBy = proposal.decidedBy;

  switch (proposal.status) {
    case 'approved':
      return decidedBy !== null && decidedAt !== null
        ? `Approved by ${decidedBy} at ${decidedAt}`
        : 'Approved';
    case 'edited':
      return decidedBy !== null && decidedAt !== null
        ? `Edited by ${decidedBy} at ${decidedAt}`
        : 'Edited';
    case 'rejected':
      return 'Rejected';
    case 'expired':
      return 'Expired';
    case 'held':
      return `Held: ${proposal.decisionNote ?? 'paused'}`;
    case 'executing':
      return 'Executing';
    case 'executed':
      return 'Executed';
    case 'failed':
      return 'Failed';
    case 'pending':
      throw new Error(
        'statusLine is not called for a pending proposal; it renders the actions block instead',
      );
  }
}

/**
 * Renders a proposal card (spec 9.1). A `pending` proposal gets the
 * Approve/Edit/Reject/Snooze actions block; any other status gets a status
 * line instead, so the same renderer both posts the original card and
 * updates it once Dom (or the clock) decides it.
 */
export function renderProposalCard(proposal: Proposal, options: RenderOptions): RenderedMessage {
  const preview = truncate(proposal.preview);
  const rationale = truncate(proposal.rationale);

  const blocks: KnownBlock[] = [
    {
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: chipLine(proposal.actionClass, proposal.counterpartyClass) },
      ],
    },
    { type: 'section', text: { type: 'mrkdwn', text: preview } },
    { type: 'section', text: { type: 'mrkdwn', text: rationale } },
    ...provenanceContext(proposal.provenance),
    proposal.status === 'pending'
      ? approveRejectActions(proposal.id)
      : {
          type: 'context',
          elements: [{ type: 'mrkdwn', text: statusLine(proposal, options.timeZone) }],
        },
    {
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: proposal.id },
        {
          type: 'mrkdwn',
          text: `Expires ${formatDateTime(proposal.expiresAt, options.timeZone)}`,
        },
        {
          type: 'mrkdwn',
          text: policyCell(proposal.actionClass, proposal.counterpartyClass, proposal.targetSystem),
        },
      ],
    },
  ];

  return {
    text: `${proposal.actionClass}: ${preview}`,
    blocks,
  };
}
