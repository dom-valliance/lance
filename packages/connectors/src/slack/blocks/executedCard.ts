import type { KnownBlock } from '@slack/types';
import type { Proposal } from '@lance/shared';
import { ACTION } from './actions.js';
import {
  chipLine,
  formatDateTime,
  provenanceContext,
  truncate,
  type RenderedMessage,
  type RenderOptions,
} from './format.js';

/**
 * Renders an executed card, posted for `auto` executions (spec 9.1). Shows
 * what was done, when, the target link (when provenance carries one) and a
 * single `Undo / flag` button; pressing it demotes the rule (spec 6.4) and,
 * for compensatable actions, queues the compensation as a new proposal.
 */
export function renderExecutedCard(proposal: Proposal, options: RenderOptions): RenderedMessage {
  const preview = truncate(proposal.preview);
  const executedAt = proposal.decidedAt ?? proposal.expiresAt;

  const blocks: KnownBlock[] = [
    {
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: chipLine(proposal.actionClass, proposal.counterpartyClass) },
      ],
    },
    { type: 'section', text: { type: 'mrkdwn', text: preview } },
    ...provenanceContext(proposal.provenance),
    {
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: `Executed ${formatDateTime(executedAt, options.timeZone)}` },
      ],
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          action_id: ACTION.executedUndo,
          text: { type: 'plain_text', text: 'Undo / flag' },
          value: proposal.id,
        },
      ],
    },
  ];

  return {
    text: `${proposal.actionClass}: ${preview}`,
    blocks,
  };
}
