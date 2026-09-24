import { SlackApiError } from '@lance/connectors';
import { openAppTestDb, openFixtureDb, startPostgresContainer } from '@lance/db/testing';
import { runMigrations, scopedDb, SEED_PRINCIPAL_ID, type Db } from '@lance/db';
import { LedgerReader } from '@lance/ledger';
import { newUlid } from '@lance/shared';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Caller, PrincipalRef, SlackLinkIssue } from '../deps.js';
import { createPrincipalDirectory } from '../principals/directory.js';
import { testConfig, TEST_SIGNING_SECRET } from '../test-fakes.js';
import { channelBaseName, createSlackLinks, type ChannelProvisionerLike } from './links.js';
import { createReplayGuard } from './replay.js';

/**
 * `/lance login` over a real database, as a lance_app member, so the
 * policies of migration 0014 hold the service to the same limits as in
 * production. Slack itself is a recording fake.
 */

const DOM_SLACK = 'U0BN7JN7BAN';
const TAREK_SLACK = 'U0TAREK';
const TEAM = 'T0VALLIANCE';
const WEB = 'https://web.example.test';

let container: StartedPostgreSqlContainer;
let root: Db;
let fixture: Db;

class FakeProvisioner implements ChannelProvisionerLike {
  readonly created: string[] = [];
  readonly invited: { channel: string; user: string }[] = [];
  taken = new Set<string>();
  failWith: Error | null = null;

  userProfile(user: string) {
    return Promise.resolve({ id: user, firstName: 'Tarek', displayName: 'Tarek Example' });
  }

  createPrivateChannel(input: { name: string }) {
    if (this.failWith !== null) return Promise.reject(this.failWith);
    if (this.taken.has(input.name)) {
      return Promise.reject(new SlackApiError('name_taken', 'conversations.create', 200, false));
    }
    this.created.push(input.name);
    return Promise.resolve({ id: `G0${String(this.created.length)}`, name: input.name });
  }

  invite(input: { channel: string; user: string }) {
    this.invited.push(input);
    return Promise.resolve();
  }
}

let provisioner: FakeProvisioner;
let nowMs: number;
/** A fresh second principal per case: ledger rows can never be deleted, so none are reused. */
let TAREK_ID: string;
let TAREK_UPN: string;

const links = (webUrl: string | null = WEB) =>
  createSlackLinks({
    root,
    config: testConfig(),
    signingSecret: TEST_SIGNING_SECRET,
    webUrl,
    provisioner,
    now: () => new Date(nowMs).toISOString(),
  });

const principal = async (upn: string): Promise<PrincipalRef> => {
  const found = await createPrincipalDirectory(root).byUpn(upn);
  if (found === null) throw new Error(`No principal ${upn}`);
  return found;
};

const callerFor = async (
  upn: string,
  roles: Caller['identity']['roles'] = ['Lance.User'],
): Promise<Caller> => ({
  identity: { oid: `${upn}-oid`, upn, roles },
  principal: await principal(upn),
});

const tokenOf = (issued: SlackLinkIssue): string => {
  if (issued.status !== 'issued') throw new Error('Expected a link.');
  const token = new URL(issued.url).searchParams.get('state');
  if (token === null) throw new Error('The link carries no token.');
  return token;
};

const issueFor = async (slackUserId: string, recordFor: PrincipalRef): Promise<string> =>
  tokenOf(
    await links().issue({ slackUserId, slackTeamId: TEAM, recordFor, actor: 'system:slack-login' }),
  );

const payloads = async (principalId: string): Promise<Record<string, unknown>[]> => {
  const events = await new LedgerReader(scopedDb(root, { principalId })).query({});
  return events
    .map((event) => (event.payload ?? {}) as Record<string, unknown>)
    .filter((payload) => typeof payload['change'] === 'string')
    .reverse();
};

beforeAll(async () => {
  container = await startPostgresContainer();
  const connectionString = container.getConnectionUri();
  await runMigrations({ connectionString });
  root = await openAppTestDb(connectionString);
  fixture = openFixtureDb(connectionString);
});

afterAll(async () => {
  await root?.$client.end();
  await fixture?.$client.end();
  await container?.stop();
});

beforeEach(async () => {
  provisioner = new FakeProvisioner();
  nowMs = Date.now();
  await fixture.$client.query('DELETE FROM slack_links');
  await fixture.$client.query('DELETE FROM slack_link_tokens');
  await fixture.$client.query(
    "UPDATE principals SET slack_user_id = NULL, slack_channel_id = NULL, lance_roles = '{}'",
  );
  TAREK_ID = newUlid();
  TAREK_UPN = `tarek.${TAREK_ID.toLowerCase()}@valliance.ai`;
  await fixture.$client.query(
    "INSERT INTO principals (id, entra_oid, upn, status) VALUES ($1, $2, $3, 'onboarding')",
    [TAREK_ID, `oid-${TAREK_ID}`, TAREK_UPN],
  );
});

describe('a /lance login link', () => {
  it('links the Slack user to the principal who signed in, once', async () => {
    const dom = await principal('dom@valliance.ai');
    const token = await issueFor(DOM_SLACK, dom);
    const caller = await callerFor('dom@valliance.ai', ['Lance.User', 'Lance.Admin']);

    const first = await links().confirm(token, caller);
    const again = await links().confirm(token, caller);

    expect(first).toMatchObject({ status: 'linked', slackUserId: DOM_SLACK, slackTeamId: TEAM });
    expect(again).toEqual({ status: 'used' });
    expect(await createPrincipalDirectory(root).bySlackUserId(DOM_SLACK, TEAM)).toMatchObject({
      id: SEED_PRINCIPAL_ID,
      lanceRoles: ['Lance.Admin', 'Lance.User'],
    });
  });

  it('expires five minutes after it was issued', async () => {
    const tarek = await principal(TAREK_UPN);
    const token = await issueFor(TAREK_SLACK, tarek);

    nowMs += 5 * 60 * 1000 + 1000;
    const outcome = await links().confirm(token, await callerFor(TAREK_UPN));

    expect(outcome).toEqual({ status: 'expired' });
    expect(await createPrincipalDirectory(root).bySlackUserId(TAREK_SLACK)).toBeNull();
  });

  it('is refused when tampered with, and the genuine link still works after', async () => {
    const tarek = await principal(TAREK_UPN);
    const token = await issueFor(TAREK_SLACK, tarek);
    const last = token.at(-1) === 'A' ? 'B' : 'A';
    const tampered = `${token.slice(0, -1)}${last}`;
    const caller = await callerFor(TAREK_UPN);

    expect(await links().preview(tampered, caller.principal)).toEqual({ status: 'invalid' });
    expect(await links().confirm(tampered, caller)).toEqual({ status: 'invalid' });
    expect(await links().confirm(token, caller)).toMatchObject({ status: 'linked' });
  });

  it('refuses a token for a Slack user already linked to someone else', async () => {
    const dom = await principal('dom@valliance.ai');
    await links().confirm(await issueFor(DOM_SLACK, dom), await callerFor('dom@valliance.ai'));

    const token = await issueFor(DOM_SLACK, dom);
    const caller = await callerFor(TAREK_UPN);

    expect(await links().preview(token, caller.principal)).toEqual({ status: 'taken' });
    expect(await links().confirm(token, caller)).toEqual({ status: 'taken' });
  });

  it('records the request and the binding in the ledger', async () => {
    const tarek = await principal(TAREK_UPN);
    const token = await issueFor(TAREK_SLACK, tarek);
    await links().confirm(token, await callerFor(TAREK_UPN));

    const changes = (await payloads(TAREK_ID)).map((payload) => payload['change']);
    expect(changes).toEqual([
      'slack_link_issued',
      'slack_linked',
      'slack_channel_created',
      'slack_channel_invited',
    ]);
  });

  it('says so when the api has no web address to link to', async () => {
    const dom = await principal('dom@valliance.ai');
    expect(
      await links(null).issue({
        slackUserId: DOM_SLACK,
        slackTeamId: TEAM,
        recordFor: dom,
        actor: 'system:slack-login',
      }),
    ).toEqual({ status: 'unconfigured' });
  });
});

describe('the private channel on first link (ADR 0023)', () => {
  it('reuses dom-claude-agent for Dom and creates nothing', async () => {
    const dom = await principal('dom@valliance.ai');
    const outcome = await links().confirm(
      await issueFor(DOM_SLACK, dom),
      await callerFor('dom@valliance.ai'),
    );

    expect(outcome).toMatchObject({
      status: 'linked',
      channel: { status: 'ready', channelId: 'C0BU7P278N5', created: false },
    });
    expect(provisioner.created).toEqual([]);
    expect((await principal('dom@valliance.ai')).slackChannelId).toBe('C0BU7P278N5');
  });

  it('creates lance-<first-name> for anyone else, invites them and stores it', async () => {
    const tarek = await principal(TAREK_UPN);
    const outcome = await links().confirm(
      await issueFor(TAREK_SLACK, tarek),
      await callerFor(TAREK_UPN),
    );

    expect(outcome).toMatchObject({
      channel: { status: 'ready', channelId: 'G01', name: 'lance-tarek', created: true },
    });
    expect(provisioner.invited).toEqual([{ channel: 'G01', user: TAREK_SLACK }]);
    expect((await principal(TAREK_UPN)).slackChannelId).toBe('G01');
  });

  it('adds a suffix when the name is taken', async () => {
    provisioner.taken = new Set(['lance-tarek', 'lance-tarek-2']);
    const tarek = await principal(TAREK_UPN);
    const outcome = await links().confirm(
      await issueFor(TAREK_SLACK, tarek),
      await callerFor(TAREK_UPN),
    );

    expect(outcome).toMatchObject({ channel: { name: 'lance-tarek-3' } });
  });

  it('keeps the link when Slack refuses the channel, and says how to retry', async () => {
    provisioner.failWith = new SlackApiError('missing_scope', 'conversations.create', 200, false);
    const tarek = await principal(TAREK_UPN);
    const outcome = await links().confirm(
      await issueFor(TAREK_SLACK, tarek),
      await callerFor(TAREK_UPN),
    );

    expect(outcome).toMatchObject({ status: 'linked', channel: { status: 'failed' } });
    expect(outcome.status === 'linked' && outcome.channel.status === 'failed').toBe(true);
    expect(JSON.stringify(outcome)).toContain('run /lance login again');
    expect((await payloads(TAREK_ID)).at(-1)).toMatchObject({ change: 'slack_channel_failed' });
  });

  it('keeps the channel on a later link and does not create another', async () => {
    const tarek = await principal(TAREK_UPN);
    await links().confirm(await issueFor(TAREK_SLACK, tarek), await callerFor(TAREK_UPN));
    const outcome = await links().confirm(
      await issueFor(TAREK_SLACK, tarek),
      await callerFor(TAREK_UPN),
    );

    expect(outcome).toMatchObject({ channel: { channelId: 'G01', created: false } });
    expect(provisioner.created).toEqual(['lance-tarek']);
  });
});

describe('channelBaseName', () => {
  it('uses the Slack first name in the form Slack accepts', () => {
    expect(channelBaseName('Zoë Anne', 'zoe@valliance.ai')).toBe('lance-zoe-anne');
  });

  it("falls back to the UPN's first name", () => {
    expect(channelBaseName(null, 'tarek.example@valliance.ai')).toBe('lance-tarek');
  });
});

describe('the Slack replay store', () => {
  it('accepts a signature once and refuses it again inside the window', async () => {
    const guard = createReplayGuard(root);
    const timestamp = Math.floor(Date.now() / 1000);

    expect(await guard.claim('v0=first', timestamp)).toBe(true);
    expect(await guard.claim('v0=first', timestamp)).toBe(false);
    expect(await guard.claim('v0=second', timestamp)).toBe(true);
  });

  it('prunes entries whose window has passed', async () => {
    await fixture.$client.query(
      "INSERT INTO slack_request_nonces (signature, expires_at) VALUES ('v0=old', now() - interval '1 minute')",
    );
    await createReplayGuard(root).claim('v0=fresh', Math.floor(Date.now() / 1000));
    const left = await fixture.$client.query(
      "SELECT signature FROM slack_request_nonces WHERE signature = 'v0=old'",
    );
    expect(left.rows).toEqual([]);
  });
});
