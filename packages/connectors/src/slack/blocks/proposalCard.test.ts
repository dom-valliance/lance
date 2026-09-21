import type { ActionsBlock, ContextBlock, KnownBlock, SectionBlock } from '@slack/types';
import { describe, expect, it } from 'vitest';
import { renderProposalCard } from './proposalCard.js';
import { assertWithinSlackLimits, validProposal } from './fixtures.js';
import type { RenderOptions } from './format.js';

const OPTIONS: RenderOptions = { displayName: 'Lance', timeZone: 'Europe/London' };

const actionsBlocks = (blocks: KnownBlock[]): ActionsBlock[] =>
  blocks.filter((block): block is ActionsBlock => block.type === 'actions');

const contextTexts = (block: ContextBlock): string[] =>
  block.elements.flatMap((element) => ('text' in element ? [element.text] : []));

const contextBlocks = (blocks: KnownBlock[]): ContextBlock[] =>
  blocks.filter((block): block is ContextBlock => block.type === 'context');

describe('renderProposalCard', () => {
  it('stays within Slack Block Kit structural limits for a pending proposal', () => {
    const { blocks } = renderProposalCard(validProposal(), OPTIONS);
    expect(() => assertWithinSlackLimits(blocks)).not.toThrow();
  });

  it('gives a fallback text that mentions the action class and the preview', () => {
    const proposal = validProposal();
    const { text } = renderProposalCard(proposal, OPTIONS);
    expect(text).toContain(proposal.actionClass);
    expect(text).toContain(proposal.preview);
  });

  it('renders the action class and counterparty class as a chip line, using a middle dot', () => {
    const { blocks } = renderProposalCard(validProposal(), OPTIONS);
    const [chip] = contextBlocks(blocks);
    expect(chip).toBeDefined();
    expect(contextTexts(chip as ContextBlock)[0]).toBe('*apply_category*  ·  client');
  });

  it('gives a pending proposal exactly one actions block with four buttons carrying the proposal id', () => {
    const proposal = validProposal({ status: 'pending' });
    const { blocks } = renderProposalCard(proposal, OPTIONS);
    const blocksWithActions = actionsBlocks(blocks);
    expect(blocksWithActions).toHaveLength(1);

    const buttons = blocksWithActions[0]?.elements ?? [];
    expect(buttons).toHaveLength(4);
    for (const button of buttons) {
      expect(button.type).toBe('button');
      expect((button as { value?: string }).value).toBe(proposal.id);
    }
  });

  it('marks Approve primary and Reject danger', () => {
    const { blocks } = renderProposalCard(validProposal({ status: 'pending' }), OPTIONS);
    const [approve, edit, reject, snooze] = actionsBlocks(blocks)[0]?.elements ?? [];
    expect((approve as { style?: string }).style).toBe('primary');
    expect((edit as { style?: string }).style).toBeUndefined();
    expect((reject as { style?: string }).style).toBe('danger');
    expect((snooze as { style?: string }).style).toBeUndefined();
  });

  it('renders no actions block for a decided proposal', () => {
    const proposal = validProposal({
      status: 'approved',
      decidedBy: 'user:dom',
      decidedAt: '2026-09-21T09:14:00.000Z',
    });
    const { blocks } = renderProposalCard(proposal, OPTIONS);
    expect(actionsBlocks(blocks)).toHaveLength(0);
  });

  it('shows who approved a decided proposal and when, in the viewer time zone', () => {
    const proposal = validProposal({
      status: 'approved',
      decidedBy: 'user:dom',
      decidedAt: '2026-09-21T08:14:00.000Z',
    });
    const { blocks } = renderProposalCard(proposal, OPTIONS);
    const statusBlock = blocks.find(
      (block): block is ContextBlock =>
        block.type === 'context' && contextTexts(block).some((text) => text.includes('Approved')),
    );
    expect(statusBlock).toBeDefined();
    expect(contextTexts(statusBlock as ContextBlock)[0]).toBe('Approved by user:dom at 09:14');
  });

  it.each([
    ['rejected', 'Rejected'],
    ['expired', 'Expired'],
  ] as const)('renders a plain status line for %s', (status, expected) => {
    const proposal = validProposal({ status });
    const { blocks } = renderProposalCard(proposal, OPTIONS);
    const statusBlock = blocks.find(
      (block): block is ContextBlock =>
        block.type === 'context' && contextTexts(block).includes(expected),
    );
    expect(statusBlock).toBeDefined();
  });

  it('renders the held reason from the decision note', () => {
    const proposal = validProposal({ status: 'held', decisionNote: 'paused' });
    const { blocks } = renderProposalCard(proposal, OPTIONS);
    const statusBlock = blocks.find(
      (block): block is ContextBlock =>
        block.type === 'context' && contextTexts(block).includes('Held: paused'),
    );
    expect(statusBlock).toBeDefined();
  });

  it('renders provenance with a url as a link', () => {
    const proposal = validProposal({
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
    const { blocks } = renderProposalCard(proposal, OPTIONS);
    const provenance = contextBlocks(blocks).find((block) =>
      contextTexts(block).some((text) => text.includes('rec-1')),
    );
    expect(provenance).toBeDefined();
    expect(contextTexts(provenance as ContextBlock)).toContain(
      '<https://outlook.office.com/mail/id/rec-1|graph:rec-1>',
    );
  });

  it('renders provenance without a url as plain text', () => {
    const proposal = validProposal({
      provenance: [
        {
          system: 'notion',
          recordId: 'rec-2',
          hash: 'sha256:bbb',
          observedAt: '2026-09-21T08:00:00.000Z',
        },
      ],
    });
    const { blocks } = renderProposalCard(proposal, OPTIONS);
    const provenance = contextBlocks(blocks).find((block) =>
      contextTexts(block).includes('notion:rec-2'),
    );
    expect(provenance).toBeDefined();
    const texts = contextTexts(provenance as ContextBlock);
    expect(texts).toContain('notion:rec-2');
    expect(texts.some((text) => text.includes('<'))).toBe(false);
  });

  it('truncates a preview past 2900 characters and marks the truncation', () => {
    const proposal = validProposal({ preview: 'x'.repeat(3200) });
    const { blocks } = renderProposalCard(proposal, OPTIONS);
    expect(() => assertWithinSlackLimits(blocks)).not.toThrow();
    const previewSection = blocks.find((block): block is SectionBlock => block.type === 'section');
    if (previewSection?.text === undefined) {
      throw new Error('Expected a section block with text');
    }
    expect(previewSection.text.text.endsWith('(truncated)')).toBe(true);
    expect(previewSection.text.text.length).toBeLessThan(3000);
  });

  it('includes the proposal id, expiry and policy cell in the footer', () => {
    const proposal = validProposal({ expiresAt: '2026-09-21T14:00:00.000Z' });
    const { blocks } = renderProposalCard(proposal, OPTIONS);
    const footer = contextBlocks(blocks).at(-1);
    expect(footer).toBeDefined();
    const texts = contextTexts(footer as ContextBlock);
    expect(texts).toContain(proposal.id);
    expect(texts.some((text) => text.startsWith('Expires'))).toBe(true);
    expect(texts).toContain('apply_category / client / graph');
  });
});
