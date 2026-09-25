import { describe, expect, it } from 'vitest';
import { executeSender } from './context.js';
import { sendAgainLater } from './handlers.js';

const PRINCIPAL = '01K5S9V6QW3SWCCPVB0N0E3T01';

describe('per-principal sends', () => {
  it('queues an approved proposal in its principal group', async () => {
    const sent: unknown[][] = [];
    const send = (...args: unknown[]): Promise<void> => {
      sent.push(args);
      return Promise.resolve();
    };

    await executeSender(send, PRINCIPAL)('01K5S9V6QW3SWCCPVB0N0E3P01');

    expect(sent).toEqual([
      [
        'execute',
        { principalId: PRINCIPAL, proposalId: '01K5S9V6QW3SWCCPVB0N0E3P01' },
        { group: { id: PRINCIPAL } },
      ],
    ]);
  });

  it.each(['chase', 'triage', 'bulk-mail'])(
    'puts a %s job back for later in its principal group while they are paused',
    async (queue) => {
      const sent: unknown[][] = [];
      const boss = {
        send: (...args: unknown[]) => {
          sent.push(args);
          return Promise.resolve(null);
        },
      };

      await sendAgainLater(boss, queue, { principalId: PRINCIPAL, commitmentId: 'c1' });

      expect(sent).toEqual([
        [
          queue,
          { principalId: PRINCIPAL, commitmentId: 'c1' },
          { startAfter: 60, group: { id: PRINCIPAL } },
        ],
      ]);
    },
  );
});
