import { beforeEach, describe, expect, it } from 'vitest';
import { fakeDeps, fakeProposal, type FakeDeps } from '../test-fakes.js';
import { listProposals, proposalSummary } from './service.js';

const FIRST_ID = '01K5S9V6QW3SWCCPVB0N0E301A';
const SECOND_ID = '01K5S9V6QW3SWCCPVB0N0E301C';

let harness: FakeDeps;

beforeEach(() => {
  harness = fakeDeps();
  harness.proposals.rows = [fakeProposal({ id: FIRST_ID })];
});

describe('listProposals', () => {
  it('passes only the filters it was given and asks for one row beyond the page', async () => {
    await listProposals(harness.deps, { status: 'pending', targetSystem: 'graph', limit: 10 });

    expect(harness.proposals.filters).toEqual([
      { status: 'pending', targetSystem: 'graph', limit: 11 },
    ]);
  });

  it('returns the last id of the page as the cursor when another page exists', async () => {
    harness.proposals.rows = [fakeProposal({ id: FIRST_ID }), fakeProposal({ id: SECOND_ID })];

    const page = await listProposals(harness.deps, { limit: 1 });

    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBe(SECOND_ID);
  });

  it('reports no next cursor when the page is the last one', async () => {
    expect((await listProposals(harness.deps, {})).nextCursor).toBeNull();
  });

  it('counts every proposal the filters match, ignoring the cursor and the page size', async () => {
    harness.proposals.rows = [
      fakeProposal({ id: FIRST_ID }),
      fakeProposal({ id: SECOND_ID }),
      fakeProposal({ id: '01K5S9V6QW3SWCCPVB0N0E301D', status: 'rejected' }),
    ];

    const page = await listProposals(harness.deps, {
      status: 'pending',
      limit: 1,
      cursor: '01K5S9V6QW3SWCCPVB0N0E301Z',
    });

    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(2);
    expect(harness.proposals.counts).toEqual([{ status: 'pending' }]);
  });

  it('starts the page after the cursor it was given', async () => {
    harness.proposals.rows = [fakeProposal({ id: FIRST_ID }), fakeProposal({ id: SECOND_ID })];

    const page = await listProposals(harness.deps, { cursor: SECOND_ID });

    expect(page.items.map((proposal) => proposal.id)).toEqual([FIRST_ID]);
  });
});

describe('proposalSummary', () => {
  it('counts the pending proposals and names the earliest expiry among them', async () => {
    harness.proposals.rows = [
      fakeProposal({ id: FIRST_ID, expiresAt: '2026-09-22T18:00:00.000Z' }),
      fakeProposal({ id: SECOND_ID, expiresAt: '2026-09-22T09:00:00.000Z' }),
      fakeProposal({
        id: '01K5S9V6QW3SWCCPVB0N0E301D',
        status: 'approved',
        expiresAt: '2026-09-21T09:00:00.000Z',
      }),
    ];

    expect(await proposalSummary(harness.deps)).toEqual({
      pending: 2,
      oldestExpiresAt: '2026-09-22T09:00:00.000Z',
    });
  });

  it('reports no expiry when nothing is pending', async () => {
    harness.proposals.rows = [];

    expect(await proposalSummary(harness.deps)).toEqual({ pending: 0, oldestExpiresAt: null });
  });
});
