import { alerts, principals, runMigrations, scopedDb, SEED_PRINCIPAL_ID, type Db } from '@lance/db';
import { openAppTestDb, openFixtureDb, startPostgresContainer } from '@lance/db/testing';
import { LedgerReader } from '@lance/ledger';
import { LANCE_ROLE_IDS } from '@lance/shared';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { listRoleHolders, RoleCheckError, runRoleCheck } from './roleCheck.js';

/**
 * The nightly role check against Graph fixtures (msw) and a real database
 * logged in as a lance_app member, so the pause goes through the same
 * principals policies it meets in production.
 */

const TENANT = '11111111-2222-3333-4444-555555555555';
const CLIENT = '66666666-7777-8888-9999-000000000000';
const credentials = { tenantId: TENANT, clientId: CLIENT, clientSecret: 'a-client-secret' };

const TOKEN_URL = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`;
/** A pattern, because msw would read the parentheses of `(appId='...')` as a path group. */
const ASSIGNMENTS_URL = new RegExp(
  `^https://graph\\.microsoft\\.com/v1\\.0/servicePrincipals\\(appId='${CLIENT}'\\)/appRoleAssignedTo`,
);
const membersUrl = (group: string) =>
  `https://graph.microsoft.com/v1.0/groups/${group}/transitiveMembers`;

const USERS_GROUP = 'group-lance-users';
const ADMINS_GROUP = 'group-lance-admins';
const DOM_OID = 'oid-dom';
const ANN_OID = 'oid-ann';
const ANN_ID = '01K5S9V6QW3SWCCPVB0N0E3R01';
const UNBOUND_ID = '01K5S9V6QW3SWCCPVB0N0E3R02';
const NOW = '2026-09-24T02:00:00.000Z';

const graph = setupServer();

let container: StartedPostgreSqlContainer;
let root: Db;
let fixture: Db;

const user = (id: string) => ({ '@odata.type': '#microsoft.graph.user', id });

/** Graph as the tenant would answer: groups assigned the roles, and their members. */
const answerWith = (members: { users: unknown[]; admins: unknown[] }): void => {
  graph.use(
    http.post(TOKEN_URL, () => HttpResponse.json({ access_token: 'app-token' })),
    http.get(ASSIGNMENTS_URL, ({ request }) => {
      if (request.headers.get('authorization') !== 'Bearer app-token') {
        return new HttpResponse(null, { status: 401 });
      }
      return HttpResponse.json({
        value: [
          {
            principalId: USERS_GROUP,
            principalType: 'Group',
            appRoleId: LANCE_ROLE_IDS['Lance.User'],
          },
          {
            principalId: ADMINS_GROUP,
            principalType: 'Group',
            appRoleId: LANCE_ROLE_IDS['Lance.Admin'],
          },
          // The default access role another account holds; not a Lance role.
          {
            principalId: 'oid-other',
            principalType: 'User',
            appRoleId: '00000000-0000-0000-0000-000000000000',
          },
        ],
      });
    }),
    http.get(membersUrl(USERS_GROUP), ({ request }) => {
      // The second page proves the check follows @odata.nextLink.
      if (new URL(request.url).searchParams.get('page') === '2') {
        return HttpResponse.json({ value: members.users.slice(1) });
      }
      return HttpResponse.json({
        value: members.users.slice(0, 1),
        '@odata.nextLink': `${membersUrl(USERS_GROUP)}?page=2`,
      });
    }),
    http.get(membersUrl(ADMINS_GROUP), () => HttpResponse.json({ value: members.admins })),
  );
};

const statusOf = async (id: string): Promise<string | undefined> => {
  const rows = await fixture
    .select({ status: principals.status })
    .from(principals)
    .where(eq(principals.id, id));
  return rows[0]?.status;
};

/** Microsoft hosts must be answered by a fixture; the Docker socket testcontainers uses is not. */
const MICROSOFT_HOSTS = ['graph.microsoft.com', 'login.microsoftonline.com'];

beforeAll(async () => {
  container = await startPostgresContainer();
  graph.listen({
    onUnhandledRequest: (request, print) => {
      if (MICROSOFT_HOSTS.includes(new URL(request.url).hostname)) print.error();
    },
  });
  const url = container.getConnectionUri();
  await runMigrations({ connectionString: url });
  root = await openAppTestDb(url);
  fixture = openFixtureDb(url);
}, 120000);

afterEach(() => {
  graph.resetHandlers();
});

afterAll(async () => {
  graph.close();
  await root?.$client.end();
  await fixture?.$client.end();
  await container?.stop();
});

beforeEach(async () => {
  await fixture.$client.query('DELETE FROM alerts');
  await fixture.$client.query(
    "UPDATE principals SET entra_oid = $1, status = 'active' WHERE id = $2",
    [DOM_OID, SEED_PRINCIPAL_ID],
  );
  await fixture.$client.query(
    `INSERT INTO principals (id, entra_oid, upn, status)
     VALUES ($1, $2, 'ann@valliance.ai', 'active'), ($3, NULL, 'unbound@valliance.ai', 'active')
     ON CONFLICT (id) DO UPDATE SET entra_oid = EXCLUDED.entra_oid, status = 'active'`,
    [ANN_ID, ANN_OID, UNBOUND_ID],
  );
});

describe('listRoleHolders', () => {
  it('lists every user holding each role through the groups assigned to it', async () => {
    answerWith({
      users: [user(DOM_OID), user(ANN_OID), { '@odata.type': '#microsoft.graph.device', id: 'd1' }],
      admins: [user(DOM_OID)],
    });

    await expect(listRoleHolders(credentials)).resolves.toEqual({
      'Lance.User': [ANN_OID, DOM_OID],
      'Lance.Admin': [DOM_OID],
    });
  });

  it('names the missing permission when Graph refuses the read', async () => {
    graph.use(
      http.post(TOKEN_URL, () => HttpResponse.json({ access_token: 'app-token' })),
      http.get(ASSIGNMENTS_URL, () => new HttpResponse(null, { status: 403 })),
    );

    await expect(listRoleHolders(credentials)).rejects.toThrow(/Application.Read.All/);
  });
});

describe('runRoleCheck', () => {
  it('pauses an active principal who holds neither role, records it and alerts the admin', async () => {
    answerWith({ users: [user(DOM_OID)], admins: [user(DOM_OID)] });

    const result = await runRoleCheck({ root, credentials, now: () => NOW });

    expect(result.paused).toEqual([{ principalId: ANN_ID, upn: 'ann@valliance.ai' }]);
    expect(result.unbound).toEqual([UNBOUND_ID]);
    expect(result.alerted).toEqual([SEED_PRINCIPAL_ID]);
    expect(await statusOf(ANN_ID)).toBe('paused');
    expect(await statusOf(SEED_PRINCIPAL_ID)).toBe('active');
    expect(await statusOf(UNBOUND_ID)).toBe('active');

    const annEvents = await new LedgerReader(scopedDb(root, { principalId: ANN_ID })).query({
      kind: 'state_changed',
    });
    expect(annEvents.map((event) => event.payload)).toEqual([
      { change: 'principal_paused', principalId: ANN_ID, reason: 'holds neither Lance app role' },
    ]);
    expect(annEvents[0]?.actor).toBe('system:role-check');

    const domAlerts = await scopedDb(root, { principalId: SEED_PRINCIPAL_ID })
      .select()
      .from(alerts);
    expect(domAlerts.map((alert) => [alert.kind, alert.severity, alert.dedupeKey])).toEqual([
      ['principal_access_revoked', 'P1', `principal_access_revoked:${ANN_ID}`],
    ]);
  });

  it('records one observation of each checked principal and none again for the same answer', async () => {
    answerWith({ users: [user(DOM_OID), user(ANN_OID)], admins: [user(DOM_OID)] });
    const domLedger = new LedgerReader(scopedDb(root, { principalId: SEED_PRINCIPAL_ID }));
    const first = await runRoleCheck({ root, credentials, now: () => NOW });
    const afterFirst = await domLedger.query({ kind: 'observed' });
    const second = await runRoleCheck({ root, credentials, now: () => NOW });
    const observed = await domLedger.query({ kind: 'observed' });

    expect([first.paused, second.paused]).toEqual([[], []]);
    expect(afterFirst.length).toBeGreaterThan(0);
    expect(observed).toHaveLength(afterFirst.length);
    expect(observed.at(-1)?.payload).toMatchObject({
      kind: 'role_assignment',
      oid: DOM_OID,
      roles: ['Lance.User', 'Lance.Admin'],
    });
  });

  it('pauses nobody when Graph reports no role holders at all', async () => {
    answerWith({ users: [], admins: [] });

    await expect(runRoleCheck({ root, credentials, now: () => NOW })).rejects.toBeInstanceOf(
      RoleCheckError,
    );
    expect(await statusOf(ANN_ID)).toBe('active');
  });

  it('offboards a principal it paused who still holds no role once the grace period has passed', async () => {
    answerWith({ users: [user(DOM_OID)], admins: [user(DOM_OID)] });
    const requests: { principalId: string; actor: string; reason: string }[] = [];
    const offboarding = {
      afterDays: 7,
      run: (request: { principalId: string; actor: string; reason: string }) => {
        requests.push(request);
        return Promise.resolve();
      },
    };

    const first = await runRoleCheck({ root, credentials, now: () => NOW, offboarding });
    const sixDays = await runRoleCheck({
      root,
      credentials,
      now: () => '2026-09-30T02:00:00.000Z',
      offboarding,
    });
    const eightDays = await runRoleCheck({
      root,
      credentials,
      now: () => '2026-10-02T02:00:00.000Z',
      offboarding,
    });

    expect(first.paused.map((entry) => entry.principalId)).toEqual([ANN_ID]);
    expect([first.offboarded, sixDays.offboarded, eightDays.offboarded]).toEqual([
      [],
      [],
      [ANN_ID],
    ]);
    expect(requests).toEqual([
      {
        principalId: ANN_ID,
        actor: 'system:role-check',
        reason: 'held neither Lance app role for 8 days after the role check paused them',
      },
    ]);
  });

  it('never offboards a paused principal who holds a role again', async () => {
    answerWith({ users: [user(DOM_OID)], admins: [user(DOM_OID)] });
    await runRoleCheck({ root, credentials, now: () => NOW });
    answerWith({ users: [user(DOM_OID), user(ANN_OID)], admins: [user(DOM_OID)] });
    const requests: string[] = [];
    const later = await runRoleCheck({
      root,
      credentials,
      now: () => '2026-11-24T02:00:00.000Z',
      offboarding: {
        afterDays: 7,
        run: (request) => {
          requests.push(request.principalId);
          return Promise.resolve();
        },
      },
    });
    expect(later.offboarded).toEqual([]);
    expect(requests).toEqual([]);
    expect(await statusOf(ANN_ID)).toBe('paused');
  });
});
