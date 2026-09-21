import { beforeEach, describe, expect, it } from 'vitest';
import {
  fakeCommitment,
  fakeDeps,
  TEST_COMMITMENT_ID,
  TEST_PERSON_ID,
  type FakeDeps,
} from '../test-fakes.js';
import { chaseCommitment, getCommitment, listCommitments, resolveCommitment } from './service.js';

const SECOND_ID = '01K5S9V6QW3SWCCPVB0N0E302B';
const NOW = '2026-09-21T09:00:00.000Z';

let harness: FakeDeps;

beforeEach(() => {
  harness = fakeDeps({ now: () => NOW });
});

describe('listCommitments', () => {
  it('passes only the filters it was given and asks for one row beyond the page', async () => {
    await listCommitments(harness.deps, { direction: 'inbound', limit: 10 });

    expect(harness.commitments.queries).toEqual([{ limit: 11, direction: 'inbound' }]);
  });

  it('names the owner and the counterparty from the ontology', async () => {
    const page = await listCommitments(harness.deps, {});

    expect(page.items[0]?.counterparty).toEqual({
      id: TEST_PERSON_ID,
      name: 'Ann Example',
      email: 'ann@client.test',
    });
    expect(page.nextCursor).toBeNull();
  });

  it('returns the last id of the page as the cursor when another page exists', async () => {
    harness.commitments.rows = [
      fakeCommitment(),
      fakeCommitment({ id: SECOND_ID, description: 'Confirm the start date' }),
    ];

    const page = await listCommitments(harness.deps, { limit: 1 });

    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBe(SECOND_ID);
  });

  it('ages a commitment in whole days from when it was recorded', async () => {
    const page = await listCommitments(harness.deps, {});

    expect(page.items[0]?.ageDays).toBe(7);
    expect(page.items[0]?.overdueDays).toBe(2);
  });
});

describe('getCommitment', () => {
  it('returns null for an id no commitment has', async () => {
    expect(await getCommitment(harness.deps, SECOND_ID)).toBeNull();
  });
});

describe('resolveCommitment', () => {
  it('marks a commitment done and records who changed it', async () => {
    const view = await resolveCommitment(harness.deps, { id: TEST_COMMITMENT_ID, to: 'done' });

    expect(view.status).toBe('done');
    expect(harness.writer.appended).toHaveLength(1);
    expect(harness.writer.appended[0]).toMatchObject({
      actor: 'user:dom',
      kind: 'resolved',
      sourceSystem: 'lance',
      sourceRecordId: TEST_COMMITMENT_ID,
      payload: {
        kind: 'commitment_status',
        commitmentId: TEST_COMMITMENT_ID,
        from: 'open',
        to: 'done',
      },
    });
  });

  it('carries the reason of a drop into the ledger', async () => {
    const view = await resolveCommitment(harness.deps, {
      id: TEST_COMMITMENT_ID,
      to: 'dropped',
      reason: 'The client cancelled the order.',
    });

    expect(view.status).toBe('dropped');
    expect(harness.writer.appended[0]?.payload).toMatchObject({
      to: 'dropped',
      reason: 'The client cancelled the order.',
    });
  });

  it('writes nothing the second time the same resolution arrives', async () => {
    await resolveCommitment(harness.deps, { id: TEST_COMMITMENT_ID, to: 'done' });
    const again = await resolveCommitment(harness.deps, { id: TEST_COMMITMENT_ID, to: 'done' });

    expect(again.status).toBe('done');
    expect(harness.writer.appended).toHaveLength(1);
  });

  it('refuses to drop a commitment that is already done', async () => {
    await resolveCommitment(harness.deps, { id: TEST_COMMITMENT_ID, to: 'done' });

    await expect(
      resolveCommitment(harness.deps, {
        id: TEST_COMMITMENT_ID,
        to: 'dropped',
        reason: 'Too late.',
      }),
    ).rejects.toThrow(/already done/);
  });

  it('refuses an id no commitment has', async () => {
    await expect(resolveCommitment(harness.deps, { id: SECOND_ID, to: 'done' })).rejects.toThrow(
      /does not exist/,
    );
  });
});

describe('chaseCommitment', () => {
  it('enqueues the commitment and returns the job id', async () => {
    expect(await chaseCommitment(harness.deps, TEST_COMMITMENT_ID)).toEqual({
      enqueued: true,
      jobId: 'job-1',
    });
    expect(harness.chased).toEqual([TEST_COMMITMENT_ID]);
  });

  it('enqueues nothing for an id no commitment has', async () => {
    await expect(chaseCommitment(harness.deps, SECOND_ID)).rejects.toThrow(/does not exist/);
    expect(harness.chased).toEqual([]);
  });
});
