import { describe, expect, it, vi } from 'vitest';
import { createProposalTool, ProposalDraftSchema } from './createProposal.js';

const draft = {
  actionClass: 'apply_category' as const,
  counterpartyClass: 'client' as const,
  targetSystem: 'graph' as const,
  targetRecordId: 'AAMk1',
  payload: { categories: ['Newsletters'] },
  preview: 'Apply category Newsletters',
  rationale: 'Sender is a newsletter.',
  provenance: [
    {
      system: 'graph' as const,
      recordId: 'AAMk1',
      hash: 'h',
      observedAt: '2026-09-21T10:00:00.000Z',
    },
  ],
  confidence: 0.9,
};

describe('create_proposal tool', () => {
  it('is the only write and hands the draft to deterministic code', async () => {
    const handler = vi.fn().mockResolvedValue({
      proposalId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      decision: 'auto',
      status: 'approved',
    });
    const tool = createProposalTool(handler);
    expect(tool.name).toBe('create_proposal');
    const result = await tool.run(draft);
    expect(handler).toHaveBeenCalledWith(draft);
    expect(result).toContain('policy decision auto');
  });

  it('rejects a draft without provenance', () => {
    expect(ProposalDraftSchema.safeParse({ ...draft, provenance: [] }).success).toBe(false);
  });

  it('cannot express a send or a delete as anything but their action class, which policy forbids', () => {
    expect(ProposalDraftSchema.safeParse({ ...draft, actionClass: 'send_email' }).success).toBe(
      true,
    );
    expect(ProposalDraftSchema.safeParse({ ...draft, actionClass: 'post_to_mars' }).success).toBe(
      false,
    );
  });
});
