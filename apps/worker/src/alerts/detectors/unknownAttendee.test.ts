import { observations, SEED_PRINCIPAL_ID, runMigrations, type Db } from '@lance/db';
import { openSeededTestDb, startPostgresContainer } from '@lance/db/testing';
import { LedgerWriter } from '@lance/ledger';
import { OntologyRepository } from '@lance/ontology';
import { hashRecord, idempotencyKey, stableUlid } from '@lance/shared';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { unknownAttendeeDetector } from './unknownAttendee.js';
import type { DetectorContext } from './types.js';

let container: StartedPostgreSqlContainer;
let db: Db;
let ontology: OntologyRepository;

const NOW = '2026-09-22T08:00:00.000Z';
const OBSERVED_AT = '2026-09-22T07:30:00.000Z';
const correlationId = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

const config = {
  timeZone: 'Europe/London',
  cost: { dailyCeilingGbp: 15, usdToGbp: 0.8 },
  dom: { name: 'Dom Selvon', email: 'dom@valliance.ai' },
  proposals: { expiryHours: 24 },
  briefs: { minFreeBlockHours: 2 },
};

const context = (): DetectorContext => ({ db, config, ontology, now: () => NOW });

const attendee = (name: string | null, address: string) => ({
  name,
  address,
  type: 'required',
  responseStatus: 'none',
});

function event(
  id: string,
  attendees: ReturnType<typeof attendee>[],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    subject: `Meeting ${id}`,
    start: { dateTime: '2026-09-22T10:00:00.0000000', timeZone: 'UTC' },
    end: { dateTime: '2026-09-22T11:00:00.0000000', timeZone: 'UTC' },
    isAllDay: false,
    isCancelled: false,
    removed: false,
    attendees: [attendee('Dom Selvon', 'dom@valliance.ai'), ...attendees],
    ...overrides,
  };
}

async function observe(record: Record<string, unknown>): Promise<string> {
  const id = record['id'] as string;
  const hash = hashRecord(record);
  await new LedgerWriter(db).append({
    ts: OBSERVED_AT,
    actor: 'agent:watcher-graph-calendar@0.1.0',
    kind: 'observed',
    sourceSystem: 'graph',
    sourceRecordId: id,
    sourceRecordHash: hash,
    idempotencyKey: idempotencyKey('graph', id, hash),
    correlationId: stableUlid(`graph:${id}`),
    payload: { ...record, watcher: 'graph-calendar', labels: ['Calendar'] },
  });
  return hash;
}

beforeAll(async () => {
  container = await startPostgresContainer();
  const connectionString = container.getConnectionUri();
  await runMigrations({ connectionString });
  db = await openSeededTestDb(connectionString);
  ontology = new OntologyRepository(db, { principalId: SEED_PRINCIPAL_ID });
  const sourceRef = { system: 'graph' as const, id: 'seed', observedAt: OBSERVED_AT };
  await ontology.upsertPerson(
    { displayName: 'Ann Example', emails: ['ann@client.test'], sourceRef },
    { correlationId },
  );
  await ontology.upsertOrganisation(
    { name: 'Known Partner', domains: ['partner.test'], type: 'partner', sourceRef },
    { correlationId },
  );
}, 120000);

afterAll(async () => {
  await db.$client.end();
  await container.stop();
});

beforeEach(async () => {
  await db.delete(observations);
});

describe('unknownAttendeeDetector', () => {
  it('runs every fifteen minutes', () => {
    expect(unknownAttendeeDetector.schedule).toBe('*/15 * * * *');
  });

  it('raises a P2 keyed on the event, naming the stranger and carrying the observation', async () => {
    const hash = await observe(event('unknown-1', [attendee('Sam Stranger', 'sam@stranger.test')]));

    const alerts = await unknownAttendeeDetector.run(context());
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      kind: 'external_meeting_unknown_attendee',
      severity: 'P2',
      dedupeKey: 'event:unknown-1',
    });
    expect(alerts[0]?.body).toContain('sam@stranger.test');
    expect(alerts[0]?.body).toContain('Suggested action');
    expect(alerts[0]?.provenance).toEqual([
      { system: 'graph', recordId: 'unknown-1', hash, observedAt: OBSERVED_AT },
    ]);
  });

  it('stays quiet for an attendee the ontology knows as a person', async () => {
    await observe(event('known-person', [attendee('Ann Example', 'ann@client.test')]));
    expect(await unknownAttendeeDetector.run(context())).toEqual([]);
  });

  it('stays quiet for a new face at an organisation the ontology knows', async () => {
    await observe(event('known-org', [attendee('New Face', 'new.face@partner.test')]));
    expect(await unknownAttendeeDetector.run(context())).toEqual([]);
  });

  it('stays quiet for internal colleagues and public provider addresses', async () => {
    await observe(
      event('internal-only', [
        attendee('Ronan Colleague', 'ronan@valliance.ai'),
        attendee('Personal Account', 'someone@gmail.com'),
      ]),
    );
    expect(await unknownAttendeeDetector.run(context())).toEqual([]);
  });

  it('ignores a cancelled meeting and one beyond tomorrow', async () => {
    await observe(
      event('cancelled', [attendee('Sam Stranger', 'sam@stranger.test')], { isCancelled: true }),
    );
    await observe(
      event('later-this-week', [attendee('Sam Stranger', 'sam@stranger.test')], {
        start: { dateTime: '2026-09-25T10:00:00.0000000', timeZone: 'UTC' },
        end: { dateTime: '2026-09-25T11:00:00.0000000', timeZone: 'UTC' },
      }),
    );
    expect(await unknownAttendeeDetector.run(context())).toEqual([]);
  });

  it('raises one alert per event however many strangers are on it', async () => {
    await observe(
      event('two-strangers', [
        attendee('Sam Stranger', 'sam@stranger.test'),
        attendee(null, 'pat@elsewhere.test'),
      ]),
    );
    const alerts = await unknownAttendeeDetector.run(context());
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.body).toContain('sam@stranger.test');
    expect(alerts[0]?.body).toContain('pat@elsewhere.test');
  });

  it('covers a meeting tomorrow', async () => {
    await observe(
      event('tomorrow', [attendee('Sam Stranger', 'sam@stranger.test')], {
        start: { dateTime: '2026-09-23T10:00:00.0000000', timeZone: 'UTC' },
        end: { dateTime: '2026-09-23T11:00:00.0000000', timeZone: 'UTC' },
      }),
    );
    expect((await unknownAttendeeDetector.run(context()))[0]?.dedupeKey).toBe('event:tomorrow');
  });
});
