import { beforeEach, describe, expect, it } from 'vitest';
import { fakeDeps, fakeProposal, type FakeDeps } from '../test-fakes.js';
import { listProposals } from './service.js';

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

  it('starts the page after the cursor it was given', async () => {
    harness.proposals.rows = [fakeProposal({ id: FIRST_ID }), fakeProposal({ id: SECOND_ID })];

    const page = await listProposals(harness.deps, { cursor: SECOND_ID });

    expect(page.items.map((proposal) => proposal.id)).toEqual([FIRST_ID]);
  });
});
