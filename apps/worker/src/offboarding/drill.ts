import { pathToFileURL } from 'node:url';
import {
  createPrincipalSecretPurger,
  InMemorySecrets,
  type ChannelArchiveOutcome,
  type SlackChannelArchiver,
} from '@lance/connectors';
import { createDb, grantRetentionMember, principalState, scopedDb, seed, type Db } from '@lance/db';
import { LedgerWriter } from '@lance/ledger';
import { loadConfig, newUlid } from '@lance/shared';
import { offboardPrincipal } from './offboard.js';

/**
 * The local rehearsal of docs/runbooks/offboard-principal.md: a synthetic
 * principal with fixture data, offboarded by the same `offboardPrincipal`
 * the worker runs, as a login role that holds what the worker identity
 * holds (lance_app, and lance_retention for SET ROLE only). The vault is in
 * memory and the Slack archiver records what it was asked, so nothing
 * reaches Azure or Slack. It refuses any database that is not on this
 * machine.
 *
 *   DATABASE_URL=postgres://postgres:postgres@localhost:5432/lance \
 *     pnpm --filter @lance/worker exec tsx src/offboarding/drill.ts
 */

export const DRILL_PRINCIPAL_ID = '01K5S9V6QW3SWCCPVB0N0E3D01';
export const DRILL_UPN = 'synthetic.offboarding@valliance.ai';
const DRILL_CHANNEL = 'G0DRILLSYNTH';
const DRILL_ROLE = 'lance_drill_worker';
const DRILL_PASSWORD = 'lance_drill_worker';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/** Answers as Slack would: archived the first time, already archived on a rerun. */
class RecordingArchiver implements SlackChannelArchiver {
  readonly asked: string[] = [];
  constructor(private readonly answer: ChannelArchiveOutcome) {}
  archive(channelId: string): Promise<ChannelArchiveOutcome> {
    this.asked.push(channelId);
    return Promise.resolve(this.answer);
  }
}

/** Plants the synthetic principal and their data once; true when this run planted them. */
async function plantFixtures(admin: Db): Promise<boolean> {
  await seed(admin);
  await admin.$client.query(
    `DO $$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${DRILL_ROLE}') THEN
         CREATE ROLE ${DRILL_ROLE} LOGIN PASSWORD '${DRILL_PASSWORD}';
       END IF;
     END $$`,
  );
  await admin.$client.query(`GRANT lance_app TO ${DRILL_ROLE}`);
  await grantRetentionMember(admin, DRILL_ROLE);

  const existing = await admin.$client.query('SELECT 1 FROM principals WHERE id = $1', [
    DRILL_PRINCIPAL_ID,
  ]);
  if (existing.rowCount !== 0) return false;
  await admin.$client.query(
    `INSERT INTO principals (id, entra_oid, upn, status, slack_channel_id)
     VALUES ($1, 'oid-synthetic-drill', $2, 'active', $3)`,
    [DRILL_PRINCIPAL_ID, DRILL_UPN, DRILL_CHANNEL],
  );
  await admin.$client.query(
    "INSERT INTO slack_links (slack_user_id, slack_team_id, principal_id) VALUES ('U0DRILL', 'T0VALLIANCE', $1)",
    [DRILL_PRINCIPAL_ID],
  );
  const own = scopedDb(admin, { principalId: DRILL_PRINCIPAL_ID });
  await own.insert(principalState).values({ mode: 'live' });
  const writer = new LedgerWriter(own);
  const ts = new Date().toISOString();
  const mail = await writer.append({
    ts,
    actor: 'agent:watcher-graph-mail@0.1.0',
    kind: 'observed',
    sourceSystem: 'graph',
    sourceRecordId: 'AAMk-drill',
    sourceRecordHash: 'sha256:drill-mail',
    idempotencyKey: 'graph:AAMk-drill:sha256:drill-mail',
    correlationId: newUlid(),
    payload: { watcher: 'graph-mail', subject: 'Synthetic', bodyText: 'Synthetic body' },
  });
  await writer.append({
    ts,
    actor: 'agent:watcher-jamie@0.1.0',
    kind: 'observed',
    sourceSystem: 'jamie',
    sourceRecordId: 'jamie-drill',
    sourceRecordHash: 'sha256:drill-jamie',
    idempotencyKey: 'jamie:jamie-drill:sha256:drill-jamie',
    correlationId: newUlid(),
    payload: { watcher: 'jamie', transcript: 'Synthetic transcript' },
  });
  await writer.append({
    ts,
    actor: 'agent:triage@1.0.0',
    kind: 'resolved',
    sourceSystem: 'lance',
    correlationId: newUlid(),
    payload: {
      kind: 'triage',
      commitments: [{ evidenceQuote: 'Synthetic quote' }],
      observationEventIds: [mail.id],
    },
  });
  await writer.append({
    ts,
    actor: 'user:dom',
    kind: 'state_changed',
    sourceSystem: 'lance',
    correlationId: newUlid(),
    payload: { change: 'jamie_connected' },
  });
  return true;
}

/** A pool that logs in as the drill role and acts as lance_app, as the worker's does. */
function asWorker(connectionString: string): Db {
  const url = new URL(connectionString);
  url.username = DRILL_ROLE;
  url.password = DRILL_PASSWORD;
  const previous = process.env['PG_ROLE'];
  process.env['PG_ROLE'] = 'lance_app';
  try {
    return createDb({ connectionString: url.toString(), password: DRILL_PASSWORD });
  } finally {
    if (previous === undefined) delete process.env['PG_ROLE'];
    else process.env['PG_ROLE'] = previous;
  }
}

export async function runDrill(connectionString: string): Promise<void> {
  const host = new URL(connectionString).hostname;
  if (!LOCAL_HOSTS.has(host)) {
    throw new Error(
      `The offboarding drill runs against a local database only, and DATABASE_URL points at ${host}. Offboard a real principal from the admin page (docs/runbooks/offboard-principal.md).`,
    );
  }
  const admin = createDb({ connectionString });
  const worker = asWorker(connectionString);
  try {
    const planted = await plantFixtures(admin);
    // On a rerun the vault and Slack answer as the real ones would: the
    // secrets are already gone and the channel already archived.
    const vault = new InMemorySecrets(
      planted
        ? {
            [`graph-refresh-token--${DRILL_PRINCIPAL_ID}`]: 'synthetic-refresh-token',
            [`jamie-api-key--${DRILL_PRINCIPAL_ID}`]: 'synthetic-jamie-key',
          }
        : {},
    );
    const archiver = new RecordingArchiver(planted ? 'archived' : 'already_archived');
    const config = loadConfig({ NODE_ENV: 'development', DATABASE_URL: connectionString });
    const result = await offboardPrincipal(
      { root: worker, config, secrets: createPrincipalSecretPurger(vault), channels: archiver },
      { principalId: DRILL_PRINCIPAL_ID, actor: 'user:dom', reason: 'offboarding drill' },
    );
    console.info(
      JSON.stringify(
        {
          principalId: result.principalId,
          correlationId: result.correlationId,
          steps: result.steps.map((step) => ({ step: step.step, outcome: step.outcome })),
          vaultDeletes: vault.deletes,
          slackArchived: archiver.asked,
        },
        null,
        2,
      ),
    );
  } finally {
    await worker.$client.end();
    await admin.$client.end();
  }
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  const url = process.env['DATABASE_URL'];
  if (url === undefined || url === '') {
    throw new Error(
      'Set DATABASE_URL to the local database, for example postgres://postgres:postgres@localhost:5432/lance.',
    );
  }
  await runDrill(url);
}
