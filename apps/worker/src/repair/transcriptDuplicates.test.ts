import { commitments, runMigrations, type Db } from '@lance/db';
import { openSeededTestDb, startPostgresContainer } from '@lance/db/testing';
import { LedgerReader, LedgerWriter } from '@lance/ledger';
import { hashRecord, idempotencyKey, newUlid, stableUlid } from '@lance/shared';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  REPAIR_ACTOR,
  dropTranscriptDuplicates,
  findTranscriptDuplicates,
  restoreTranscriptDuplicates,
} from './transcriptDuplicates.js';

let container: StartedPostgreSqlContainer;
let db: Db;
const correlationId = stableUlid('jamie:mt-dup');

beforeAll(async () => {
  container = await startPostgresContainer();
  const connectionString = container.getConnectionUri();
  await runMigrations({ connectionString });
  db = await openSeededTestDb(connectionString);
}, 120000);

afterAll(async () => {
  await db.$client.end();
  await container.stop();
});

async function observe(fields: Record<string, unknown>): Promise<string> {
  const record = {
    kind: 'meeting',
    id: 'mt-dup',
    transcript: 'Dom: I will read through the SOW.',
    transcriptReady: true,
    ...fields,
  };
  const hash = hashRecord(record);
  const result = await new LedgerWriter(db).append({
    ts: '2026-09-24T12:59:00.000Z',
    actor: 'agent:watcher-jamie@0.1.0',
    kind: 'observed',
    sourceSystem: 'jamie',
    sourceRecordId: 'mt-dup',
    sourceRecordHash: hash,
    idempotencyKey: idempotencyKey('jamie', 'mt-dup', hash),
    correlationId,
    payload: { ...record, watcher: 'jamie' },
  });
  return result.id;
}

async function triaged(observationEventIds: string[], recordedCommitmentIds: string[]) {
  await new LedgerWriter(db).append({
    ts: '2026-09-24T13:00:00.000Z',
    actor: 'agent:triage@0.1.0',
    kind: 'resolved',
    sourceSystem: 'lance',
    correlationId,
    payload: { kind: 'triage', observationEventIds, recordedCommitmentIds },
  });
}

async function commitment(description: string, status: 'open' | 'chased' = 'open') {
  const id = newUlid();
  await db.insert(commitments).values({
    id,
    direction: 'outbound',
    ownerPersonId: 'person-dom',
    counterpartyPersonId: 'person-brian',
    description,
    evidenceQuote: 'I will read through the SOW',
    sourceRefs: [{ system: 'jamie', recordId: 'mt-dup', hash: 'h', observedAt: 'now' }],
    status,
  });
  return id;
}

describe('transcript duplicate repair', () => {
  it('drops only the open commitments a run recorded from a transcript an earlier run had read, and restores them', async () => {
    const original = await commitment('Read through the SOW');
    await triaged([await observe({})], [original]);
    const reworded = await commitment('Read through the SOW that Brian sent back');
    const chased = await commitment('Read the SOW', 'chased');
    await triaged([await observe({ summaryShort: 'Arrived later' })], [reworded, chased]);
    const fromNewText = await commitment('Send the resourcing plan');
    await triaged(
      [await observe({ transcript: 'Dom: I will read through the SOW. Brian: plan to follow.' })],
      [fromNewText],
    );

    const duplicates = await findTranscriptDuplicates(db);
    expect(duplicates.map((duplicate) => duplicate.commitmentId).sort()).toEqual(
      [reworded, chased].sort(),
    );

    const result = await dropTranscriptDuplicates(db, duplicates);
    expect(result.dropped).toEqual([reworded]);
    expect(result.left).toEqual([{ commitmentId: chased, status: 'chased' }]);
    const statuses = async () =>
      Object.fromEntries(
        (
          await db
            .select({ id: commitments.id, status: commitments.status })
            .from(commitments)
            .where(inArray(commitments.id, [original, reworded, chased, fromNewText]))
        ).map((row) => [row.id, row.status]),
      );
    expect(await statuses()).toEqual({
      [original]: 'open',
      [reworded]: 'dropped',
      [chased]: 'chased',
      [fromNewText]: 'open',
    });
    const events = await new LedgerReader(db).query({ limit: 50 });
    expect(
      events.filter((event) => event.actor === REPAIR_ACTOR).map((event) => event.sourceRecordId),
    ).toEqual([reworded]);

    expect(await restoreTranscriptDuplicates(db)).toEqual([reworded]);
    expect((await statuses())[reworded]).toBe('open');
    expect(await restoreTranscriptDuplicates(db)).toEqual([]);
  });

  it('leaves a commitment Dom dropped himself after a restore', async () => {
    const original = await commitment('Talk to Volha about resourcing');
    await triaged([await observe({ transcript: 'Dom: I will talk to Volha.' })], [original]);
    const reworded = await commitment('Speak with Volha to plan resourcing');
    await triaged(
      [await observe({ transcript: 'Dom: I will talk to Volha.', summaryShort: 'Later' })],
      [reworded],
    );
    await dropTranscriptDuplicates(db, await findTranscriptDuplicates(db));
    expect(await restoreTranscriptDuplicates(db)).toContain(reworded);

    await db
      .update(commitments)
      .set({ status: 'dropped' })
      .where(inArray(commitments.id, [reworded]));
    await new LedgerWriter(db).append({
      ts: '2026-09-25T09:00:00.000Z',
      actor: 'user:dom',
      kind: 'resolved',
      sourceSystem: 'lance',
      sourceRecordId: reworded,
      correlationId: newUlid(),
      payload: { kind: 'commitment_status', commitmentId: reworded, from: 'open', to: 'dropped' },
    });
    expect(await restoreTranscriptDuplicates(db)).not.toContain(reworded);
  });
});
