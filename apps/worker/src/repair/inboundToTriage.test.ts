import { commitments, runMigrations, type Db, type NewCommitment } from '@lance/db';
import { openSeededTestDb, startPostgresContainer } from '@lance/db/testing';
import { LedgerReader, LedgerWriter } from '@lance/ledger';
import { newUlid } from '@lance/shared';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MOVE_REASON,
  REPAIR_ACTOR,
  findOpenInbound,
  moveInboundToTriage,
  restoreInboundFromTriage,
} from './inboundToTriage.js';

let container: StartedPostgreSqlContainer;
let db: Db;

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

async function commitment(overrides: Partial<NewCommitment>): Promise<string> {
  const id = newUlid();
  await db.insert(commitments).values({
    id,
    direction: 'inbound',
    ownerPersonId: 'person-ann',
    counterpartyPersonId: 'person-ann',
    description: 'Send the volumes',
    evidenceQuote: 'I will send the volumes',
    sourceRefs: [{ system: 'jamie', recordId: 'mt-1', hash: 'h', observedAt: 'now' }],
    status: 'open',
    ...overrides,
  });
  return id;
}

const statusOf = async (id: string): Promise<string | undefined> =>
  (await db.select().from(commitments).where(eq(commitments.id, id)))[0]?.status;

describe('the move of open inbound commitments to triage', () => {
  it('moves only open inbound rows and records each move', async () => {
    const open = await commitment({ description: 'Send the volumes' });
    const chased = await commitment({ description: 'Send the schema', status: 'chased' });
    const outbound = await commitment({ description: 'Write the plan', direction: 'outbound' });
    const done = await commitment({ description: 'Share the deck', status: 'done' });

    const rows = await findOpenInbound(db);
    expect(rows.map((row) => row.commitmentId)).toEqual([open]);

    const result = await moveInboundToTriage(db, rows);

    expect(result).toEqual({ moved: [open], left: [] });
    expect(await statusOf(open)).toBe('unconfirmed');
    expect(await statusOf(chased)).toBe('chased');
    expect(await statusOf(outbound)).toBe('open');
    expect(await statusOf(done)).toBe('done');
    const events = await new LedgerReader(db).query({ actor: REPAIR_ACTOR });
    expect(events.map((event) => event.payload)).toContainEqual({
      kind: 'commitment_status',
      commitmentId: open,
      from: 'open',
      to: 'unconfirmed',
      reason: MOVE_REASON,
    });
  });

  it('leaves a row that stopped being open between the list and the move', async () => {
    const id = await commitment({ description: 'Send the rota' });
    const rows = await findOpenInbound(db);
    await db.update(commitments).set({ status: 'done' }).where(eq(commitments.id, id));

    const result = await moveInboundToTriage(db, rows);

    expect(result.left).toEqual([id]);
    expect(await statusOf(id)).toBe('done');
  });

  it('reopens what it moved, except a row the principal has answered since', async () => {
    const waiting = await commitment({ description: 'Send the forecast' });
    const answered = await commitment({ description: 'Send the contract' });
    await moveInboundToTriage(db, await findOpenInbound(db));
    // Dom drops one from the To confirm tab, as the page would.
    await db.update(commitments).set({ status: 'dropped' }).where(eq(commitments.id, answered));
    await new LedgerWriter(db).append({
      ts: new Date().toISOString(),
      actor: 'user:dom',
      kind: 'resolved',
      sourceSystem: 'lance',
      sourceRecordId: answered,
      correlationId: newUlid(),
      payload: {
        kind: 'commitment_status',
        commitmentId: answered,
        from: 'unconfirmed',
        to: 'dropped',
        reason: 'Not owed to me',
      },
    });

    const restored = await restoreInboundFromTriage(db);

    expect(restored).toContain(waiting);
    expect(restored).not.toContain(answered);
    expect(await statusOf(waiting)).toBe('open');
    expect(await statusOf(answered)).toBe('dropped');
  });
});
