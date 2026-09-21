import type { ActionsBlock, ContextBlock, SectionBlock } from '@slack/types';
import { describe, expect, it } from 'vitest';
import { ACTION } from './actions.js';
import { renderExecutedCard } from './executedCard.js';
import { assertWithinSlackLimits, validProposal } from './fixtures.js';
import type { RenderOptions } from './format.js';

const OPTIONS: RenderOptions = { displayName: 'Lance', timeZone: 'Europe/London' };

const contextTexts = (block: ContextBlock): string[] =>
  block.elements.flatMap((element) => ('text' in element ? [element.text] : []));

describe('renderExecutedCard', () => {
  it('stays within Slack Block Kit structural limits', () => {
    const { blocks } = renderExecutedCard(validProposal({ status: 'executed' }), OPTIONS);
    expect(() => assertWithinSlackLimits(blocks)).not.toThrow();
  });

  it('gives a fallback text that mentions the action class and the preview', () => {
    const proposal = validProposal({ status: 'executed' });
    const { text } = renderExecutedCard(proposal, OPTIONS);
    expect(text).toContain(proposal.actionClass);
    expect(text).toContain(proposal.preview);
  });

  it('shows the preview as what was done', () => {
    const proposal = validProposal({ status: 'executed' });
    const { blocks } = renderExecutedCard(proposal, OPTIONS);
    const preview = blocks.find((block): block is SectionBlock => block.type === 'section');
    expect(preview?.text?.text).toBe(proposal.preview);
  });

  it('renders exactly one actions block with a single Undo / flag button carrying the proposal id', () => {
    const proposal = validProposal({ status: 'executed' });
    const { blocks } = renderExecutedCard(proposal, OPTIONS);
    const actionsBlocksFound = blocks.filter(
      (block): block is ActionsBlock => block.type === 'actions',
    );
    expect(actionsBlocksFound).toHaveLength(1);
    expect(actionsBlocksFound[0]?.elements).toHaveLength(1);

    const [button] = actionsBlocksFound[0]?.elements ?? [];
    expect((button as { action_id?: string }).action_id).toBe(ACTION.executedUndo);
    expect((button as { value?: string }).value).toBe(proposal.id);
  });

  it('renders the target link when provenance has a url', () => {
    const proposal = validProposal({
      status: 'executed',
      provenance: [
        {
          system: 'graph',
          recordId: 'rec-1',
          hash: 'sha256:aaa',
          observedAt: '2026-09-21T08:00:00.000Z',
          url: 'https://outlook.office.com/mail/id/rec-1',
        },
      ],
    });
    const { blocks } = renderExecutedCard(proposal, OPTIONS);
    const provenance = blocks.find(
      (block): block is ContextBlock =>
        block.type === 'context' &&
        contextTexts(block).some((text) => text.includes('outlook.office.com')),
    );
    expect(provenance).toBeDefined();
    expect(contextTexts(provenance as ContextBlock)).toContain(
      '<https://outlook.office.com/mail/id/rec-1|graph:rec-1>',
    );
  });

  it('renders provenance without a url as plain text', () => {
    const proposal = validProposal({
      status: 'executed',
      provenance: [
        {
          system: 'notion',
          recordId: 'rec-2',
          hash: 'sha256:bbb',
          observedAt: '2026-09-21T08:00:00.000Z',
        },
      ],
    });
    const { blocks } = renderExecutedCard(proposal, OPTIONS);
    const provenance = blocks.find(
      (block): block is ContextBlock =>
        block.type === 'context' && contextTexts(block).includes('notion:rec-2'),
    );
    expect(provenance).toBeDefined();
  });
});
