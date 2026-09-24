import type { Db, Principal } from '@lance/db';
import { describe, expect, it } from 'vitest';
import { PrincipalContexts } from './scoped.js';

/**
 * The context cache over a principals read that returns whatever row the
 * test holds. Only the query shape `resolve` uses is faked.
 */
const rootReturning = (current: { row: Principal }): Db =>
  ({
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve([current.row]) }),
      }),
    }),
  }) as unknown as Db;

const principal = (overrides: Partial<Principal>): Principal => ({
  id: '01K5S9V6QW3SWCCPVB0N0E3T01',
  entraOid: 'oid',
  upn: 'tarek@valliance.ai',
  slackUserId: null,
  slackChannelId: null,
  notionUserId: null,
  foundryEmployeeId: null,
  timeZone: 'Europe/London',
  status: 'active',
  lanceRoles: [],
  rolesRecordedAt: null,
  activatedAt: null,
  createdAt: new Date('2026-09-20T09:00:00.000Z'),
  updatedAt: new Date('2026-09-20T09:00:00.000Z'),
  ...overrides,
});

describe('PrincipalContexts', () => {
  it("rebuilds a principal's context once their Slack channel changes, so delivery follows it", async () => {
    const current = { row: principal({}) };
    const builtFor: (string | null)[] = [];
    const contexts = new PrincipalContexts(rootReturning(current), (row) => {
      builtFor.push(row.slackChannelId);
      return Promise.resolve(row.slackChannelId);
    });

    await contexts.resolve(current.row.id);
    await contexts.resolve(current.row.id);
    current.row = principal({ slackChannelId: 'G0TAREK' });
    const after = await contexts.resolve(current.row.id);
    await contexts.resolve(current.row.id);

    expect(builtFor).toEqual([null, 'G0TAREK']);
    expect(after).toEqual({ status: 'active', context: 'G0TAREK' });
  });
});
