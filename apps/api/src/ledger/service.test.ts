import type { LedgerEventRow } from '@lance/ledger';
import { beforeEach, describe, expect, it } from 'vitest';
import { fakeDeps, type FakeDeps } from '../test-fakes.js';
import { listLedger } from './service.js';

const CORRELATION_ID = '01K5S9V6QW3SWCCPVB0N0E306Z';

const event = (id: string, ts: string): LedgerEventRow => ({
  principalId: '01K5S9V6QW3SWCCPVB0N0E300H',
  id,
  ts: new Date(ts),
  actor: 'user:dom',
  kind: 'decided',
  sourceSystem: 'lance',
  sourceRecordId: null,
  sourceRecordHash: null,
  correlationId: CORRELATION_ID,
  parentEventId: null,
  policyDecisionId: null,
  payload: {},
  payloadHash: 'h1',
  idempotencyKey: null,
  createdAt: new Date(ts),
});

let harness: FakeDeps;

beforeEach(() => {
  harness = fakeDeps();
  harness.ledger.rows = [
    event('01K5S9V6QW3SWCCPVB0N0E306C', '2026-09-21T12:00:00.000Z'),
    event('01K5S9V6QW3SWCCPVB0N0E306B', '2026-09-21T11:00:00.000Z'),
    event('01K5S9V6QW3SWCCPVB0N0E306A', '2026-09-21T10:00:00.000Z'),
  ];
});

describe('listLedger', () => {
  it('asks for one event beyond the page and counts with every filter but the limit', async () => {
    await listLedger(harness.deps, { kind: 'decided', to: '2026-09-21T12:00:00.000Z', limit: 2 });

    expect(harness.ledger.queries).toEqual([
      { kind: 'decided', to: '2026-09-21T12:00:00.000Z', limit: 3 },
    ]);
    expect(harness.ledger.counts).toEqual([{ kind: 'decided', to: '2026-09-21T12:00:00.000Z' }]);
  });

  it('returns the id of the oldest event shown as the next cursor when another page exists', async () => {
    const page = await listLedger(harness.deps, { limit: 2 });

    expect(page.items.map((row) => row.id)).toEqual([
      '01K5S9V6QW3SWCCPVB0N0E306C',
      '01K5S9V6QW3SWCCPVB0N0E306B',
    ]);
    expect(page.nextCursor).toBe('01K5S9V6QW3SWCCPVB0N0E306B');
    expect(page.total).toBe(3);
  });

  it('continues after the cursor event and counts the filters alone', async () => {
    const page = await listLedger(harness.deps, {
      kind: 'decided',
      cursor: '01K5S9V6QW3SWCCPVB0N0E306B',
      limit: 2,
    });

    expect(harness.ledger.queries).toEqual([
      { kind: 'decided', limit: 3, after: '01K5S9V6QW3SWCCPVB0N0E306B' },
    ]);
    expect(harness.ledger.counts).toEqual([{ kind: 'decided' }]);
    expect(page.items.map((row) => row.id)).toEqual(['01K5S9V6QW3SWCCPVB0N0E306A']);
    expect(page.nextCursor).toBeNull();
    expect(page.total).toBe(3);
  });

  it('serves the first page when the cursor names no event', async () => {
    const page = await listLedger(harness.deps, { cursor: '01K5S9V6QW3SWCCPVB0N0E306Z' });

    expect(harness.ledger.queries).toEqual([{ limit: 51 }]);
    expect(page.items).toHaveLength(3);
  });

  it('reports no next page when every matching event fits', async () => {
    const page = await listLedger(harness.deps, {});

    expect(page.nextCursor).toBeNull();
    expect(page.total).toBe(3);
  });
});
