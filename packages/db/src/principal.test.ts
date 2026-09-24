import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from './client.js';
import { runMigrations } from './migrate.js';
import { waitForSinglePrincipal } from './principal.js';
import { SEED_PRINCIPAL_ID, seed } from './seed.js';
import { startPostgresContainer } from './testing.js';

/**
 * Start-up against a database the migration job has not reached yet
 * (ADR 0032): the app waits for its principal rather than exiting.
 */

let container: StartedPostgreSqlContainer;
let db: Db;

beforeAll(async () => {
  container = await startPostgresContainer();
  db = createDb({ connectionString: container.getConnectionUri(), password: 'postgres' });
});

afterAll(async () => {
  await db?.$client.end();
  await container?.stop();
});

describe('waitForSinglePrincipal', () => {
  it('waits while the principals table is missing and resolves once the migration job has run', async () => {
    const waits: string[] = [];
    let clock = 0;
    const principal = await waitForSinglePrincipal(db, 'dom@valliance.ai', {
      waitSeconds: 600,
      log: (message) => waits.push(message),
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
        await runMigrations({ connectionString: container.getConnectionUri() });
        await seed(db);
      },
    });
    expect(principal.id).toBe(SEED_PRINCIPAL_ID);
    expect(waits).toHaveLength(1);
    expect(waits[0]).toContain('Waiting for the migration job');
  });

  it('throws at once on a failure the migration job will not fix', async () => {
    let slept = false;
    await expect(
      waitForSinglePrincipal(db, 'someone.else@valliance.ai', {
        waitSeconds: 600,
        sleep: () => {
          slept = true;
          return Promise.resolve();
        },
      }),
    ).rejects.toThrow(/configured for someone.else@valliance.ai/);
    expect(slept).toBe(false);
  });

  it('gives up with the last error once the wait runs out', async () => {
    const empty = await startPostgresContainer();
    const emptyDb = createDb({ connectionString: empty.getConnectionUri(), password: 'postgres' });
    let clock = 0;
    try {
      await expect(
        waitForSinglePrincipal(emptyDb, 'dom@valliance.ai', {
          waitSeconds: 30,
          now: () => clock,
          sleep: (ms) => {
            clock += ms;
            return Promise.resolve();
          },
        }),
      ).rejects.toThrow(/principals/);
      expect(clock).toBeLessThanOrEqual(30_000);
    } finally {
      await emptyDb.$client.end();
      await empty.stop();
    }
  });
});
