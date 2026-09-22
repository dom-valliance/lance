import { beforeEach, describe, expect, it } from 'vitest';
import { fakeDeps, fakeNotionTaskObservation, type FakeDeps } from '../test-fakes.js';
import { listTasks } from './service.js';

const SECOND_ID = '01K5S9V6QW3SWCCPVB0N0E303B';

let harness: FakeDeps;

beforeEach(() => {
  harness = fakeDeps();
});

describe('listTasks', () => {
  it('passes only the filters it was given and asks for one row beyond the page', async () => {
    await listTasks(harness.deps, { source: 'notion', status: 'open', limit: 25 });

    expect(harness.tasks.queries).toEqual([{ limit: 26, source: 'notion', status: 'open' }]);
  });

  it('renders each observation as a task with its source badge', async () => {
    const page = await listTasks(harness.deps, {});

    expect(page.items[0]).toMatchObject({
      source: 'notion',
      title: 'Draft the pilot scope',
      assignedToDom: true,
      done: false,
    });
    expect(page.nextCursor).toBeNull();
  });

  it('returns the last id of the page as the cursor when another page exists', async () => {
    harness.tasks.rows = [
      fakeNotionTaskObservation(),
      fakeNotionTaskObservation({
        id: SECOND_ID,
        sourceRecordId: 'page-2',
        payload: { kind: 'task', id: 'page-2', title: 'Book the review', status: 'Not Started' },
      }),
    ];

    const page = await listTasks(harness.deps, { limit: 1 });

    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBe(SECOND_ID);
  });
});
