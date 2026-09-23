import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { fakeAlert, fakeDeps, TEST_ALERT_ID, type FakeDeps } from '../test-fakes.js';
import { ackAlert, getAlert, listAlerts, muteAlert, resolveAlert } from './service.js';

const SECOND_ID = '01K5S9V6QW3SWCCPVB0N0E304B';
const NOW = '2026-09-21T09:00:00.000Z';

let harness: FakeDeps;

beforeEach(() => {
  harness = fakeDeps({ now: () => NOW });
});

describe('listAlerts', () => {
  it('passes only the filters it was given and asks for one row beyond the page', async () => {
    await listAlerts(harness.deps, { status: 'open', severity: 'P1', limit: 10 });

    expect(harness.alerts.queries).toEqual([{ limit: 11, status: 'open', severity: 'P1' }]);
  });

  it('returns the last id of the page as the cursor when another page exists', async () => {
    harness.alerts.rows = [fakeAlert(), fakeAlert({ id: SECOND_ID, dedupeKey: 'thread:AAMk4' })];

    const page = await listAlerts(harness.deps, { limit: 1 });

    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBe(SECOND_ID);
  });

  it('reports no next cursor when the page is the last one', async () => {
    expect((await listAlerts(harness.deps, {})).nextCursor).toBeNull();
  });

  it('counts every alert the filters match, ignoring the cursor and the page size', async () => {
    harness.alerts.rows = [
      fakeAlert(),
      fakeAlert({ id: SECOND_ID, dedupeKey: 'thread:AAMk4' }),
      fakeAlert({ id: '01K5S9V6QW3SWCCPVB0N0E304C', severity: 'P0', dedupeKey: 'thread:AAMk5' }),
    ];

    const page = await listAlerts(harness.deps, {
      severity: 'P1',
      limit: 1,
      cursor: '01K5S9V6QW3SWCCPVB0N0E304Z',
    });

    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(2);
    expect(harness.alerts.counts).toEqual([{ severity: 'P1' }]);
  });
});

describe('getAlert', () => {
  it('returns null for an id no alert has', async () => {
    expect(await getAlert(harness.deps, SECOND_ID)).toBeNull();
  });

  it('returns the alert as the page renders it', async () => {
    expect((await getAlert(harness.deps, TEST_ALERT_ID))?.title).toBe(
      'No reply to Ann Example in three working days',
    );
  });
});

describe('ackAlert', () => {
  it('moves an open alert to acked and names who acknowledged it', async () => {
    const view = await ackAlert(harness.deps, { id: TEST_ALERT_ID, actor: 'user:dom' });

    expect(view.status).toBe('acked');
    expect(view.ackedBy).toBe('user:dom');
    expect(view.ackedAt).toBe(NOW);
  });

  it('appends an alert_acked event carrying the kind and the dedupe key', async () => {
    await ackAlert(harness.deps, { id: TEST_ALERT_ID, actor: 'user:dom' });

    expect(harness.writer.appended).toHaveLength(1);
    expect(harness.writer.appended[0]).toMatchObject({
      ts: NOW,
      actor: 'user:dom',
      kind: 'alert_acked',
      sourceSystem: 'lance',
      sourceRecordId: TEST_ALERT_ID,
      payload: {
        alertId: TEST_ALERT_ID,
        kind: 'client_mail_unanswered',
        dedupeKey: 'thread:AAMk3',
      },
    });
  });

  it('writes nothing a second time when the alert is already acked', async () => {
    harness.alerts.rows = [fakeAlert({ status: 'acked', ackedBy: 'user:dom' })];

    const view = await ackAlert(harness.deps, { id: TEST_ALERT_ID });

    expect(view.status).toBe('acked');
    expect(harness.writer.appended).toHaveLength(0);
  });

  it('refuses to acknowledge an alert that has been resolved', async () => {
    harness.alerts.rows = [fakeAlert({ status: 'resolved' })];

    await expect(ackAlert(harness.deps, { id: TEST_ALERT_ID })).rejects.toThrow(
      /is resolved, so it cannot be acknowledged/,
    );
  });

  it('says where to find a real id when the alert does not exist', async () => {
    await expect(ackAlert(harness.deps, { id: SECOND_ID })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('muteAlert', () => {
  it('suppresses the alert until the hours it was given have passed', async () => {
    const view = await muteAlert(harness.deps, { id: TEST_ALERT_ID, hours: 24 });

    expect(view.status).toBe('suppressed');
    expect(view.mutedUntil).toBe('2026-09-22T09:00:00.000Z');
  });

  it('records the mute as a ledger event of its own', async () => {
    await muteAlert(harness.deps, { id: TEST_ALERT_ID, hours: 24, actor: 'user:dom' });

    expect(harness.writer.appended[0]).toMatchObject({
      kind: 'resolved',
      actor: 'user:dom',
      sourceRecordId: TEST_ALERT_ID,
      payload: {
        kind: 'alert_status',
        alertId: TEST_ALERT_ID,
        from: 'open',
        to: 'suppressed',
        mutedUntil: '2026-09-22T09:00:00.000Z',
      },
    });
  });

  it('extends the window of an alert that is already muted', async () => {
    harness.alerts.rows = [
      fakeAlert({ status: 'suppressed', mutedUntil: new Date('2026-09-21T10:00:00.000Z') }),
    ];

    const view = await muteAlert(harness.deps, { id: TEST_ALERT_ID, hours: 48 });

    expect(view.mutedUntil).toBe('2026-09-23T09:00:00.000Z');
  });

  it('refuses to mute an alert that has been resolved', async () => {
    harness.alerts.rows = [fakeAlert({ status: 'resolved' })];

    await expect(muteAlert(harness.deps, { id: TEST_ALERT_ID, hours: 24 })).rejects.toThrow(
      /it cannot be muted/,
    );
  });
});

describe('resolveAlert', () => {
  it('resolves an open alert', async () => {
    expect((await resolveAlert(harness.deps, { id: TEST_ALERT_ID })).status).toBe('resolved');
  });

  it('resolves an acked alert and records where it came from', async () => {
    harness.alerts.rows = [fakeAlert({ status: 'acked', ackedBy: 'user:dom' })];

    await resolveAlert(harness.deps, { id: TEST_ALERT_ID, actor: 'user:dom' });

    expect(harness.writer.appended[0]).toMatchObject({
      kind: 'resolved',
      payload: { kind: 'alert_status', alertId: TEST_ALERT_ID, from: 'acked', to: 'resolved' },
    });
  });

  it('writes nothing a second time when the alert is already resolved', async () => {
    harness.alerts.rows = [fakeAlert({ status: 'resolved' })];

    await resolveAlert(harness.deps, { id: TEST_ALERT_ID });

    expect(harness.writer.appended).toHaveLength(0);
  });

  it('refuses to resolve a muted alert and says to unmute it first', async () => {
    harness.alerts.rows = [fakeAlert({ status: 'suppressed' })];

    await expect(resolveAlert(harness.deps, { id: TEST_ALERT_ID })).rejects.toThrow(/Unmute it/);
  });
});

describe('the Slack card', () => {
  it('is redrawn in place when the alert was posted to the channel', async () => {
    harness.alerts.rows = [fakeAlert({ slackTs: '1758351600.000100' })];

    await ackAlert(harness.deps, { id: TEST_ALERT_ID });

    expect(harness.slack.updates).toEqual([
      { ts: '1758351600.000100', text: 'P1 No reply to Ann Example in three working days' },
    ]);
  });

  it('is left alone for an alert that was never posted', async () => {
    await ackAlert(harness.deps, { id: TEST_ALERT_ID });

    expect(harness.slack.updates).toHaveLength(0);
  });

  it('reports a Slack failure rather than failing the change that already landed', async () => {
    harness.alerts.rows = [fakeAlert({ slackTs: '1758351600.000100' })];
    harness.deps.slackSurface = {
      ...harness.slack.surface,
      update: () => Promise.reject(new Error('channel_not_found')),
    };

    const view = await ackAlert(harness.deps, { id: TEST_ALERT_ID });

    expect(view.status).toBe('acked');
    expect(harness.slackFailures).toEqual([TEST_ALERT_ID]);
  });

  it('tells the live feed which alert changed', async () => {
    await muteAlert(harness.deps, { id: TEST_ALERT_ID, hours: 24 });

    expect(harness.events).toEqual([{ type: 'alert', id: TEST_ALERT_ID }]);
  });
});

describe('a conflicting change', () => {
  it('asks the caller to reload when the alert moved under the transition', async () => {
    harness.alerts.setStatus = () => Promise.resolve(null);

    await expect(ackAlert(harness.deps, { id: TEST_ALERT_ID })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(harness.writer.appended).toHaveLength(0);
  });

  it('refuses with a TRPCError the Slack handler can read back', async () => {
    harness.alerts.rows = [fakeAlert({ status: 'resolved' })];

    await expect(ackAlert(harness.deps, { id: TEST_ALERT_ID })).rejects.toBeInstanceOf(TRPCError);
  });
});
