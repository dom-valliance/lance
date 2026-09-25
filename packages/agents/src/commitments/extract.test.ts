import { describe, expect, it } from 'vitest';
import { MemoryRunRecorder, ScriptedRunner, textMessage } from '../testing.js';
import { createCommitmentExtractor } from './extract.js';

const agentConfig = {
  prices: {
    'claude-sonnet-5': {
      inputPerMTok: 2,
      outputPerMTok: 10,
      cacheReadPerMTok: 0.2,
      cacheWritePerMTok: 2.5,
    },
  },
  cost: { dailyCeilingGbp: 15, usdToGbp: 0.78 },
};

const source = {
  id: 'mail-1',
  kind: 'sent_mail' as const,
  principal: { name: 'Dom Selvon', email: 'dom@valliance.ai' },
  participants: [{ name: 'Ann Example', email: 'ann@client.test' }],
  occurredAt: '2026-09-21T09:00:00.000Z',
  text: 'Thanks Ann. I will send the revised statement of work by Friday. Could you confirm the start date?',
};

function extractorWith(output: unknown) {
  const runner = new ScriptedRunner([[textMessage(JSON.stringify(output))]]);
  const extract = createCommitmentExtractor({
    agent: {
      runner,
      recorder: new MemoryRunRecorder(),
      ledger: { append: () => Promise.resolve({ id: '01ARZ3NDEKTSV4RRFFQ69G5FAV' }) },
      config: agentConfig,
      readSpendUsd: () => Promise.resolve(0),
    },
    model: { id: 'claude-sonnet-5', effort: 'medium' },
    displayName: 'Lance',
  });
  return { extract, runner };
}

describe('createCommitmentExtractor', () => {
  it('returns the commitments whose quotes are verbatim in the text, stamped with the source id', async () => {
    const { extract, runner } = extractorWith({
      commitments: [
        {
          direction: 'outbound',
          description: 'Send the revised statement of work',
          counterpartyName: 'Ann Example',
          counterpartyEmail: 'ann@client.test',
          dueAt: '2026-09-25',
          dueConfidence: 0.7,
          evidenceQuote: 'I will send the revised statement of work by Friday.',
          recordId: 'whatever-the-model-said',
        },
        {
          direction: 'inbound',
          description: 'Confirm the start date',
          counterpartyName: 'Ann Example',
          counterpartyEmail: 'ann@client.test',
          dueAt: null,
          dueConfidence: 0,
          evidenceQuote: 'Ann promised to confirm the start date tomorrow.',
          recordId: 'mail-1',
        },
      ],
    });

    const commitments = await extract(source, '01ARZ3NDEKTSV4RRFFQ69G5FAV');

    expect(commitments).toHaveLength(1);
    expect(commitments[0]).toMatchObject({ direction: 'outbound', recordId: 'mail-1' });
    expect(runner.calls[0]?.tools).toEqual([]);
    expect(JSON.stringify(runner.calls[0]?.messages)).toContain('Source id: mail-1');
  });

  it('rejects a source that is not a transcript or a sent email before calling the model', async () => {
    const { extract, runner } = extractorWith({ commitments: [] });
    await expect(
      extract({ ...source, kind: 'inbound_mail' as never }, '01ARZ3NDEKTSV4RRFFQ69G5FAV'),
    ).rejects.toThrow();
    expect(runner.calls).toHaveLength(0);
  });
});
