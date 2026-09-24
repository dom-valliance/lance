import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { credentialRotationLockKey, withAdvisoryLock } from './advisoryLock.js';
import type { Db } from './client.js';
import { runMigrations } from './migrate.js';
import { openAppTestDb, startPostgresContainer } from './testing.js';

let container: StartedPostgreSqlContainer;
let db: Db;

beforeAll(async () => {
  container = await startPostgresContainer();
  await runMigrations({ connectionString: container.getConnectionUri(), password: 'postgres' });
  db = await openAppTestDb(container.getConnectionUri());
}, 120_000);

afterAll(async () => {
  await db.$client.end();
  await container.stop();
});

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('withAdvisoryLock', () => {
  it('runs two holders of the same key one after the other, as lance_app', async () => {
    const events: string[] = [];
    const holder = (name: string) => async (): Promise<string> => {
      events.push(`${name} in`);
      await pause(150);
      events.push(`${name} out`);
      return name;
    };
    const key = credentialRotationLockKey('graph', '01K5S9V6QW3SWCCPVB0N0E300H');

    const results = await Promise.all([
      withAdvisoryLock(db, key, holder('a')),
      withAdvisoryLock(db, key, holder('b')),
    ]);

    expect(results).toEqual(['a', 'b']);
    expect(events).toHaveLength(4);
    expect(events[1]).toBe(`${events[0]!.split(' ')[0]!} out`);
    expect(events[3]).toBe(`${events[2]!.split(' ')[0]!} out`);
  });

  it('lets holders of different keys overlap', async () => {
    const events: string[] = [];
    const holder = (name: string) => async (): Promise<void> => {
      events.push(`${name} in`);
      await pause(150);
      events.push(`${name} out`);
    };

    await Promise.all([
      withAdvisoryLock(db, credentialRotationLockKey('graph', 'A'), holder('a')),
      withAdvisoryLock(db, credentialRotationLockKey('graph', 'B'), holder('b')),
    ]);

    expect(events.slice(0, 2).sort()).toEqual(['a in', 'b in']);
  });

  it('releases the lock when the work throws', async () => {
    const key = credentialRotationLockKey('jamie', '01K5S9V6QW3SWCCPVB0N0E300H');
    await expect(
      withAdvisoryLock(db, key, () => Promise.reject(new Error('refresh refused'))),
    ).rejects.toThrow('refresh refused');

    await expect(withAdvisoryLock(db, key, () => Promise.resolve('next'))).resolves.toBe('next');
  });
});
