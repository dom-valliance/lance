import { beforeEach, describe, expect, it } from 'vitest';
import {
  fakeCommitment,
  fakeDeps,
  TEST_COMMITMENT_ID,
  TEST_PERSON_ID,
  type FakeDeps,
} from '../test-fakes.js';
import {
  addCommitmentNote,
  changeCommitmentStatus,
  chaseCommitment,
  commitmentSummary,
  editCommitment,
  getCommitment,
  getCommitmentDetail,
  listCommitments,
  resolveCommitment,
} from './service.js';

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

  it('counts every commitment the filters match, ignoring the cursor and the page size', async () => {
    harness.commitments.rows = [
      fakeCommitment(),
      fakeCommitment({ id: SECOND_ID }),
      fakeCommitment({ id: '01K5S9V6QW3SWCCPVB0N0E302C', direction: 'outbound' }),
    ];

    const page = await listCommitments(harness.deps, {
      direction: 'inbound',
      limit: 1,
      cursor: '01K5S9V6QW3SWCCPVB0N0E302Z',
    });

    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(2);
    expect(harness.commitments.counts).toEqual([{ direction: 'inbound' }]);
  });

  it('ages a commitment in whole days from when it was recorded', async () => {
    const page = await listCommitments(harness.deps, {});

    expect(page.items[0]?.ageDays).toBe(7);
    expect(page.items[0]?.overdueDays).toBe(2);
  });
});

describe('commitmentSummary', () => {
  it('counts the open and the overdue commitments of each direction at the api clock', async () => {
    harness.commitments.rows = [
      fakeCommitment({ dueAt: new Date('2026-09-18T17:00:00.000Z') }),
      fakeCommitment({ id: SECOND_ID, dueAt: new Date('2026-09-30T17:00:00.000Z') }),
      fakeCommitment({ id: '01K5S9V6QW3SWCCPVB0N0E302C', status: 'done' }),
      fakeCommitment({ id: '01K5S9V6QW3SWCCPVB0N0E302D', direction: 'outbound', dueAt: null }),
    ];

    expect(await commitmentSummary(harness.deps)).toEqual({
      inbound: { open: 2, overdue: 1 },
      outbound: { open: 1, overdue: 0 },
      unconfirmed: 0,
    });
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

  it('refuses an id no commitment has', async () => {
    await expect(resolveCommitment(harness.deps, { id: SECOND_ID, to: 'done' })).rejects.toThrow(
      /does not exist/,
    );
  });
});

describe('changeCommitmentStatus', () => {
  it('reopens a done commitment and records the move back', async () => {
    harness.commitments.rows = [fakeCommitment({ status: 'done' })];

    const view = await changeCommitmentStatus(harness.deps, {
      id: TEST_COMMITMENT_ID,
      to: 'open',
      reason: 'Ann sent the unsigned version.',
    });

    expect(view.status).toBe('open');
    expect(harness.writer.appended[0]?.payload).toEqual({
      kind: 'commitment_status',
      commitmentId: TEST_COMMITMENT_ID,
      from: 'done',
      to: 'open',
      reason: 'Ann sent the unsigned version.',
    });
  });

  it('drops a commitment that was done', async () => {
    harness.commitments.rows = [fakeCommitment({ status: 'done' })];

    const view = await changeCommitmentStatus(harness.deps, {
      id: TEST_COMMITMENT_ID,
      to: 'dropped',
      reason: 'Marked done by mistake; the order was cancelled.',
    });

    expect(view.status).toBe('dropped');
  });

  it('refuses to drop without a reason and writes nothing', async () => {
    await expect(
      changeCommitmentStatus(harness.deps, { id: TEST_COMMITMENT_ID, to: 'dropped', reason: ' ' }),
    ).rejects.toThrow(/Give a reason/);
    expect(harness.writer.appended).toEqual([]);
  });

  it('refuses chased for a commitment never chased', async () => {
    harness.commitments.rows = [fakeCommitment({ status: 'done', chaseCount: 0 })];

    await expect(
      changeCommitmentStatus(harness.deps, { id: TEST_COMMITMENT_ID, to: 'chased' }),
    ).rejects.toThrow(/never been chased/);
  });

  it('reopens as chased a commitment chased before', async () => {
    harness.commitments.rows = [fakeCommitment({ status: 'done', chaseCount: 2 })];

    const view = await changeCommitmentStatus(harness.deps, {
      id: TEST_COMMITMENT_ID,
      to: 'chased',
    });

    expect(view.status).toBe('chased');
    expect(harness.writer.appended[0]?.payload).not.toHaveProperty('reason');
  });
});

describe('triage of commitments possibly owed to Dom', () => {
  it('opens an unconfirmed commitment and records the move out of triage', async () => {
    harness.commitments.rows = [fakeCommitment({ status: 'unconfirmed' })];

    const view = await changeCommitmentStatus(harness.deps, { id: TEST_COMMITMENT_ID, to: 'open' });

    expect(view.status).toBe('open');
    expect(harness.writer.appended[0]?.payload).toMatchObject({ from: 'unconfirmed', to: 'open' });
  });

  it('sends an inbound commitment back to triage', async () => {
    const view = await changeCommitmentStatus(harness.deps, {
      id: TEST_COMMITMENT_ID,
      to: 'unconfirmed',
    });

    expect(view.status).toBe('unconfirmed');
  });

  it('refuses to send a commitment Dom owes to triage', async () => {
    harness.commitments.rows = [fakeCommitment({ direction: 'outbound' })];

    await expect(
      changeCommitmentStatus(harness.deps, { id: TEST_COMMITMENT_ID, to: 'unconfirmed' }),
    ).rejects.toThrow(/Only a commitment owed to you/);
  });

  it('leaves unconfirmed commitments out of a list that names no status', async () => {
    harness.commitments.rows = [
      fakeCommitment(),
      fakeCommitment({ id: SECOND_ID, status: 'unconfirmed' }),
    ];

    const everything = await listCommitments(harness.deps, { direction: 'inbound' });
    const triage = await listCommitments(harness.deps, { status: 'unconfirmed' });

    expect(everything.items.map((item) => item.id)).toEqual([TEST_COMMITMENT_ID]);
    expect(triage.items.map((item) => item.id)).toEqual([SECOND_ID]);
  });

  it('counts the unconfirmed commitments apart from the open ones', async () => {
    harness.commitments.rows = [
      fakeCommitment(),
      fakeCommitment({ id: SECOND_ID, status: 'unconfirmed' }),
    ];

    expect(await commitmentSummary(harness.deps)).toMatchObject({
      inbound: { open: 1 },
      unconfirmed: 1,
    });
  });
});

describe('editCommitment', () => {
  it('changes the description and records both versions', async () => {
    const view = await editCommitment(harness.deps, {
      id: TEST_COMMITMENT_ID,
      description: '  Send the countersigned order form ',
    });

    expect(view.description).toBe('Send the countersigned order form');
    expect(view.evidenceQuote).toBe('I will get the order form over to you by Friday');
    expect(harness.writer.appended[0]?.payload).toEqual({
      kind: 'commitment_edited',
      commitmentId: TEST_COMMITMENT_ID,
      changes: {
        description: {
          from: 'Send the signed order form',
          to: 'Send the countersigned order form',
        },
      },
    });
  });

  it('reads a due day as 17:00 London, with full confidence and a chase two days later', async () => {
    const view = await editCommitment(harness.deps, {
      id: TEST_COMMITMENT_ID,
      dueDay: '2026-09-30',
    });

    expect(view.dueAt).toBe('2026-09-30T16:00:00.000Z');
    expect(view.dueConfidence).toBe(1);
    expect(view.nextChaseAt).toBe('2026-10-02T16:00:00.000Z');
  });

  it('clears the due date and the first chase of a commitment never chased', async () => {
    const view = await editCommitment(harness.deps, { id: TEST_COMMITMENT_ID, dueDay: null });

    expect(view.dueAt).toBeNull();
    expect(view.dueConfidence).toBeNull();
    expect(view.nextChaseAt).toBeNull();
  });

  it('keeps the next chase of an outbound commitment, which is never chased', async () => {
    harness.commitments.rows = [fakeCommitment({ direction: 'outbound', nextChaseAt: null })];

    const view = await editCommitment(harness.deps, {
      id: TEST_COMMITMENT_ID,
      dueDay: '2026-09-30',
    });

    expect(view.nextChaseAt).toBeNull();
  });

  it('writes nothing for an edit that changes nothing', async () => {
    await editCommitment(harness.deps, {
      id: TEST_COMMITMENT_ID,
      description: 'Send the signed order form',
    });

    expect(harness.writer.appended).toEqual([]);
  });

  it('refuses a blank description', async () => {
    await expect(
      editCommitment(harness.deps, { id: TEST_COMMITMENT_ID, description: '   ' }),
    ).rejects.toThrow(/needs a description/);
  });

  it('refuses a day the calendar does not have', async () => {
    await expect(
      editCommitment(harness.deps, { id: TEST_COMMITMENT_ID, dueDay: '2026-02-30' }),
    ).rejects.toThrow(/not a calendar day/);
  });

  it('refuses an edit to a commitment that changed after it was read', async () => {
    const store = harness.commitments;
    const read = store.get.bind(store);
    store.get = async (id) => {
      const row = await read(id);
      return row === null ? null : { ...row, updatedAt: new Date('2026-09-01T00:00:00.000Z') };
    };

    await expect(
      editCommitment(harness.deps, { id: TEST_COMMITMENT_ID, description: 'Changed' }),
    ).rejects.toThrow(/changed while it was being edited/);
    expect(harness.writer.appended).toEqual([]);
  });
});

describe('addCommitmentNote', () => {
  it('stores the note under its author and records it in the ledger first', async () => {
    const note = await addCommitmentNote(harness.deps, {
      id: TEST_COMMITMENT_ID,
      body: ' Ann says Monday. ',
      actor: 'user:dom',
    });

    expect(note).toMatchObject({ body: 'Ann says Monday.', author: 'user:dom' });
    expect(harness.writer.appended[0]?.payload).toEqual({
      kind: 'commitment_note_added',
      commitmentId: TEST_COMMITMENT_ID,
      noteId: note.id,
      body: 'Ann says Monday.',
    });
  });

  it('refuses a blank note', async () => {
    await expect(
      addCommitmentNote(harness.deps, { id: TEST_COMMITMENT_ID, body: '  ' }),
    ).rejects.toThrow(/between 1 and 4000/);
    expect(harness.commitments.noteRows).toEqual([]);
  });

  it('refuses a note on an id no commitment has', async () => {
    await expect(addCommitmentNote(harness.deps, { id: SECOND_ID, body: 'Hello' })).rejects.toThrow(
      /does not exist/,
    );
    expect(harness.writer.appended).toEqual([]);
  });
});

describe('getCommitmentDetail', () => {
  it('returns null for an id no commitment has', async () => {
    expect(await getCommitmentDetail(harness.deps, SECOND_ID)).toBeNull();
  });

  it('returns the notes and the passage the quote came from', async () => {
    await addCommitmentNote(harness.deps, { id: TEST_COMMITMENT_ID, body: 'Asked again' });
    harness.commitments.observed = [
      {
        sourceSystem: 'graph',
        sourceRecordId: 'AAMk2',
        ts: new Date('2026-09-14T09:00:00.000Z'),
        summary: 'Ann Example: Order form',
        payload: {
          subject: 'Order form',
          from: { name: 'Ann Example', address: 'ann@client.test' },
          toRecipients: [{ name: 'Dom Selvon', address: 'dom@valliance.ai' }],
          sentDateTime: '2026-09-14T08:55:00.000Z',
          bodyText:
            'Hi Dom, thanks for the call. I will get the order form over to you by Friday. Ann',
        },
      },
    ];

    const detail = await getCommitmentDetail(harness.deps, TEST_COMMITMENT_ID);

    expect(detail?.notes.map((note) => note.body)).toEqual(['Asked again']);
    expect(detail?.sources).toHaveLength(1);
    expect(detail?.sources[0]).toMatchObject({
      state: 'found',
      kind: 'email',
      title: 'Order form',
      from: 'Ann Example <ann@client.test>',
      people: ['Dom Selvon <dom@valliance.ai>'],
      excerpt: {
        before: 'Hi Dom, thanks for the call. ',
        quote: 'I will get the order form over to you by Friday',
        after: '. Ann',
      },
    });
  });

  it('says a cited record was never observed rather than dropping it', async () => {
    const detail = await getCommitmentDetail(harness.deps, TEST_COMMITMENT_ID);

    expect(detail?.sources[0]).toMatchObject({ recordId: 'AAMk2', state: 'missing' });
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
