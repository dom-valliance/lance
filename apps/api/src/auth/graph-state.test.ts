import { openAppTestDb, openFixtureDb, startPostgresContainer } from '@lance/db/testing';
import { runMigrations, scopedDb, SEED_PRINCIPAL_ID, type Db } from '@lance/db';
import { generateState } from '@lance/connectors/graph';
import { newUlid } from '@lance/shared';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createConsentStateStore, principalOfState, stateFor } from './graph-state.js';

/**
 * The consent state over a real database, as a lance_app member, so the
 * policies of migration 0021 hold the store to the same limits as in
 * production. Two stores over one database stand for the api's two
 * replicas.
 */

let container: StartedPostgreSqlContainer;
let root: Db;
let secondReplica: Db;
let fixture: Db;
let OTHER_ID: string;

beforeAll(async () => {
  container = await startPostgresContainer();
  const connectionString = container.getConnectionUri();
  await runMigrations({ connectionString });
  root = await openAppTestDb(connectionString);
  secondReplica = await openAppTestDb(connectionString);
  fixture = openFixtureDb(connectionString);
  OTHER_ID = newUlid();
  await fixture.$client.query(
    "INSERT INTO principals (id, entra_oid, upn, status) VALUES ($1, $2, $3, 'onboarding')",
    [OTHER_ID, `oid-${OTHER_ID}`, `tarek.${OTHER_ID.toLowerCase()}@valliance.ai`],
  );
});

afterAll(async () => {
  await root?.$client.end();
  await secondReplica?.$client.end();
  await fixture?.$client.end();
  await container?.stop();
});

const issued = async (principalId = SEED_PRINCIPAL_ID): Promise<string> => {
  const state = stateFor(principalId, generateState());
  await createConsentStateStore(root).issue(principalId, state, `verifier-${state}`);
  return state;
};

describe('the consent state store', () => {
  it('lets the other replica bind and claim a state this one issued', async () => {
    const state = await issued();
    const other = createConsentStateStore(secondReplica);

    const bound = await other.bind(state);
    const claimed = await other.claim(state);

    expect(bound?.codeVerifier).toBe(`verifier-${state}`);
    expect(claimed?.codeVerifier).toBe(`verifier-${state}`);
    expect(claimed?.principal.id).toBe(SEED_PRINCIPAL_ID);
    expect(claimed?.principal.upn).toBe('dom@valliance.ai');
  });

  it('claims a state once, so a replayed callback finds nothing', async () => {
    const store = createConsentStateStore(root);
    const state = await issued();
    await store.bind(state);

    expect(await store.claim(state)).not.toBeNull();
    expect(await store.claim(state)).toBeNull();
  });

  it('binds a state once', async () => {
    const store = createConsentStateStore(root);
    const state = await issued();

    expect(await store.bind(state)).not.toBeNull();
    expect(await store.bind(state)).toBeNull();
  });

  it('refuses to claim a state no browser has bound', async () => {
    const state = await issued();

    expect(await createConsentStateStore(root).claim(state)).toBeNull();
  });

  it('forgets an attempt older than ten minutes', async () => {
    const store = createConsentStateStore(root);
    const state = await issued();
    await store.bind(state);
    await fixture.$client.query(
      "UPDATE graph_consent_states SET issued_at = now() - interval '11 minutes', expires_at = now() - interval '1 minute' WHERE principal_id = $1 AND used_at IS NULL",
      [SEED_PRINCIPAL_ID],
    );

    expect(await store.claim(state)).toBeNull();
  });

  it('refuses a state whose principal half was changed to another principal', async () => {
    const store = createConsentStateStore(root);
    const state = await issued();
    const forged = stateFor(OTHER_ID, state.split('.')[1] ?? '');

    expect(await store.bind(forged)).toBeNull();
    expect(await store.bind(state)).not.toBeNull();
  });

  it('keeps each principal from reading another principal consent rows', async () => {
    await issued(OTHER_ID);

    const seen = await scopedDb(root, { principalId: SEED_PRINCIPAL_ID }).execute(
      'SELECT principal_id FROM graph_consent_states',
    );

    expect(seen.rows.every((row) => row['principal_id'] === SEED_PRINCIPAL_ID)).toBe(true);
  });

  it('stores the state only as its hash', async () => {
    const state = await issued();

    const rows = await fixture.$client.query('SELECT state_hash FROM graph_consent_states');

    expect(rows.rows.map((row: Record<string, unknown>) => row['state_hash'])).not.toContain(state);
  });

  it('will not issue a state that names a different principal from its scope', async () => {
    const state = stateFor(OTHER_ID, generateState());

    await expect(
      createConsentStateStore(root).issue(SEED_PRINCIPAL_ID, state, 'a-verifier'),
    ).rejects.toThrow('must begin with the id of the principal');
  });
});

describe('principalOfState', () => {
  it('reads the principal from a state Lance issues', () => {
    expect(principalOfState(stateFor(SEED_PRINCIPAL_ID, generateState()))).toBe(SEED_PRINCIPAL_ID);
  });

  it('refuses a value that is not a principal id and a random half', () => {
    expect(principalOfState('a-state')).toBeNull();
    expect(principalOfState(`not-a-ulid.${generateState()}`)).toBeNull();
    expect(principalOfState(`${SEED_PRINCIPAL_ID}.short`)).toBeNull();
  });
});
