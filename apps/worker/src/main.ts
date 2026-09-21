import {
  createAnthropicClient,
  dbRunRecorder,
  dbSpendReader,
  sdkModelRunner,
  type AgentDeps,
} from '@lance/agents';
import {
  createAccessTokenProvider,
  createGraphConnector,
  createGraphReads,
  createNotionConnector,
  createSlackSurface,
  InMemoryTokenStore,
  KeyVaultTokenStore,
  type GraphReads,
  type NotionConnector,
  type SlackSurface,
} from '@lance/connectors';
import { createDb, proposals, type Db } from '@lance/db';
import { expireProposals, LedgerWriter, SystemControl, toProposal } from '@lance/ledger';
import { getConfig, nowIso, readSecret, type Config } from '@lance/shared';
import { initTelemetry } from '@lance/telemetry';
import { eq } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import { raiseAlert } from './alerts/raise.js';
import { critique } from './critic/index.js';
import { createProposalHandler } from './executor/createProposal.js';
import { createConnectorWrite, type ExecutionWriters } from './executor/dispatch.js';
import { graphExecutionWriters, notionExecutionWriters } from './executor/writers.js';
import { registerExecutor } from './executor/index.js';
import { reflectProposal } from './executor/reflect.js';
import { postDryRunDigest } from './digest/dryRunDigest.js';
import { ensureSeedRules, loadActiveRules } from './policy/rules.js';
import { createBoss, startBoss } from './scheduler/boss.js';
import { PauseGate } from './scheduler/gate.js';
import { QUEUES } from './scheduler/queues.js';
import { runTriage } from './triage/run.js';
import { pgBossTriageEnqueuer, registerWatcher, type TriageJob } from './watchers/runner.js';
import {
  createGraphCalendarWatcher,
  createGraphMailWatcher,
  createHaikuLabeller,
} from './watchers/graph/index.js';
import { hashRecord } from '@lance/shared';

const WORKER_VERSION = '0.1.0';
const EXPIRY_QUEUE = 'expire-proposals';

const env = (name: string): string | undefined => {
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
};

interface GraphBundle {
  reads: GraphReads;
  writers: NonNullable<ExecutionWriters['graph']>;
}

/** Graph is optional at boot: without the Entra values the worker runs everything else. */
function buildGraph(db: Db): GraphBundle | null {
  const tenantId = env('ENTRA_TENANT_ID');
  const clientId = env('ENTRA_CLIENT_ID');
  if (tenantId === undefined || clientId === undefined || env('ENTRA_CLIENT_SECRET') === undefined)
    return null;
  const store =
    env('KEY_VAULT_URL') !== undefined
      ? KeyVaultTokenStore.fromEnv()
      : InMemoryTokenStore.fromEnv();
  const accessToken = createAccessTokenProvider({
    store,
    tenantId,
    clientId,
    clientSecret: readSecret('ENTRA_CLIENT_SECRET'),
    onRefreshFailed: async (error) => {
      await raiseAlert(db, {
        kind: 'token_refresh_failed',
        severity: 'P0',
        dedupeKey: 'token:graph',
        title: 'Graph refresh token was refused',
        body: `${error.message} Re-run the delegated consent in docs/runbooks/entra-setup.md section 7.`,
        actor: `agent:worker@${WORKER_VERSION}`,
      });
    },
  });
  const graph = createGraphConnector({
    accessToken,
    events: {
      onOpen: async (connector, error) => {
        await raiseAlert(db, {
          kind: 'breaker_open',
          severity: 'P1',
          dedupeKey: `breaker:${connector}`,
          title: `${connector} circuit breaker opened`,
          body: error instanceof Error ? error.message : String(error),
          actor: `agent:worker@${WORKER_VERSION}`,
        });
      },
    },
  });
  const reads = createGraphReads(graph);
  return { reads, writers: graphExecutionWriters(graph, reads) };
}

function buildNotion(
  config: Config,
  db: Db,
): { connector: NotionConnector; writers: NonNullable<ExecutionWriters['notion']> } | null {
  if (env('NOTION_TOKEN') === undefined) return null;
  const connector = createNotionConnector({
    token: readSecret('NOTION_TOKEN'),
    events: {
      onOpen: async (name, error) => {
        await raiseAlert(db, {
          kind: 'breaker_open',
          severity: 'P1',
          dedupeKey: `breaker:${name}`,
          title: `${name} circuit breaker opened`,
          body: error instanceof Error ? error.message : String(error),
          actor: `agent:worker@${WORKER_VERSION}`,
        });
      },
    },
  });
  return { connector, writers: notionExecutionWriters(connector, config) };
}

function buildSlack(config: Config): SlackSurface | null {
  if (env('SLACK_BOT_TOKEN') === undefined) return null;
  return createSlackSurface({
    token: readSecret('SLACK_BOT_TOKEN'),
    channelId: config.slack.channelId,
  });
}

function buildAgentDeps(config: Config, db: Db): AgentDeps | null {
  if (env('ANTHROPIC_API_KEY') === undefined) return null;
  const client = createAnthropicClient(config);
  const startOfLondonDay = (): Date => {
    const now = new Date();
    const local = new Intl.DateTimeFormat('en-GB', {
      timeZone: config.timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(now)
      .reduce<Record<string, string>>((acc, part) => ({ ...acc, [part.type]: part.value }), {});
    return new Date(`${local['year']}-${local['month']}-${local['day']}T00:00:00Z`);
  };
  return {
    runner: sdkModelRunner(client),
    recorder: dbRunRecorder(db),
    ledger: new LedgerWriter(db),
    config,
    readSpendUsd: dbSpendReader(db, startOfLondonDay),
  };
}

async function registerExpiry(boss: PgBoss, db: Db): Promise<void> {
  await boss.createQueue(EXPIRY_QUEUE);
  await boss.schedule(EXPIRY_QUEUE, '*/15 * * * *', {}, { key: EXPIRY_QUEUE });
  await boss.work(EXPIRY_QUEUE, async () => {
    const expired = await expireProposals(db);
    if (expired.length > 0) console.info({ expired: expired.length }, 'proposals expired');
  });
}

const DIGEST_QUEUE = 'dry-run-digest';

/** One message at 17:00 on weekdays while in dry run (spec 6.3). */
async function registerDigest(
  boss: PgBoss,
  db: Db,
  slack: SlackSurface | null,
  config: Config,
): Promise<void> {
  await boss.createQueue(DIGEST_QUEUE);
  await boss.schedule(DIGEST_QUEUE, '0 17 * * 1-5', {}, { tz: config.timeZone, key: DIGEST_QUEUE });
  await boss.work(DIGEST_QUEUE, async () => {
    const state = await new SystemControl(db).read();
    if (state.mode !== 'dry_run') return;
    const since = new Date(Date.now() - 24 * 3600 * 1000);
    await postDryRunDigest(db, slack, { since, displayName: config.agentDisplayName });
  });
}

async function main(): Promise<void> {
  const config = getConfig();
  const telemetry = initTelemetry({
    serviceName: 'lance-worker',
    serviceVersion: WORKER_VERSION,
    environment: config.nodeEnv,
  });
  const db = createDb();
  const control = new SystemControl(db);
  const gate = new PauseGate(control);
  const boss = createBoss(db);
  boss.on('error', (error: Error) => {
    console.error({ err: error }, 'pg-boss error');
  });

  const seeded = await ensureSeedRules(db, config.slack.channelId);
  const graph = buildGraph(db);
  const notion = buildNotion(config, db);
  const slack = buildSlack(config);
  const agent = buildAgentDeps(config, db);

  // A second mail watcher instance with no labeller: used only to normalise a
  // re-fetched message for the executor's hash check, never to poll.
  const verifier = createGraphMailWatcher({
    reads:
      graph === null
        ? { deltaMessages: () => Promise.reject(new Error('verifier does not poll')) }
        : graph.reads,
    label: () => Promise.resolve([]),
  });

  const createProposal = createProposalHandler({
    db,
    config,
    control,
    loadRules: () => loadActiveRules(db),
    critique: (draft) =>
      critique(draft, { permittedNotionProperties: config.notion.permittedTaskProperties }),
    slack,
    enqueueExecute: async (proposalId) => {
      await boss.send(QUEUES.execute, { proposalId });
    },
  });

  const write = createConnectorWrite({
    db,
    writers: {
      ...(graph === null ? {} : { graph: graph.writers }),
      ...(notion === null ? {} : { notion: notion.writers }),
    },
    loadRules: () => loadActiveRules(db),
    verifyTarget: async (proposal) => {
      // Spec 7.5 step 2: re-fetch the target and compare the same content hash
      // the watcher recorded. Only Graph messages are checked in v1.
      if (graph === null || proposal.targetSystem !== 'graph' || proposal.targetRecordId === null)
        return 'unknown';
      const ref = proposal.provenance.find(
        (entry) => entry.system === 'graph' && entry.recordId === proposal.targetRecordId,
      );
      if (ref === undefined) return 'unknown';
      try {
        const message = await graph.reads.getMessage(proposal.targetRecordId);
        const partition =
          typeof message.parentFolderId === 'string' ? message.parentFolderId : 'inbox';
        const observation = await verifier.normalise(
          { id: message.id, observedAt: nowIso(), raw: message },
          partition,
        );
        return hashRecord(observation.record) === ref.hash ? 'unchanged' : 'changed';
      } catch {
        return 'unknown';
      }
    },
    loadProposal: async (id) => {
      const rows = await db.select().from(proposals).where(eq(proposals.id, id)).limit(1);
      return rows[0] === undefined ? null : toProposal(rows[0]);
    },
  });

  await startBoss(boss);
  const render = { displayName: config.agentDisplayName, timeZone: config.timeZone };
  await registerExecutor(boss, { db, gate, write }, (proposalId, outcome) =>
    reflectProposal({ db, surface: slack, render }, proposalId, outcome),
  );
  await registerDigest(boss, db, slack, config);
  await registerExpiry(boss, db);

  if (agent !== null) {
    await boss.work<TriageJob>(QUEUES.triage, async (jobs) => {
      for (const job of jobs) {
        if (!(await gate.check()).runnable) return;
        await runTriage({ db, config, agent, createProposal }, job.data);
      }
    });
  }
  if (graph !== null) {
    const runnerDeps = { db, gate, control, enqueueTriage: pgBossTriageEnqueuer(boss) };
    const label =
      agent === null
        ? () => Promise.resolve(['Unlabelled'])
        : createHaikuLabeller({
            agent,
            model: config.models.label,
            displayName: config.agentDisplayName,
          });
    await registerWatcher(
      boss,
      runnerDeps,
      createGraphMailWatcher({ reads: graph.reads, label }),
      config.timeZone,
    );
    await registerWatcher(
      boss,
      runnerDeps,
      createGraphCalendarWatcher({ reads: graph.reads }),
      config.timeZone,
    );
  }

  console.info(
    {
      mode: config.mode,
      seededRules: seeded.inserted,
      graph: graph !== null,
      notion: notion !== null,
      slack: slack !== null,
      agents: agent !== null,
      displayName: config.agentDisplayName,
      startedAt: nowIso(),
    },
    'worker started',
  );

  const shutdown = async (): Promise<void> => {
    await boss.stop({ graceful: true });
    await db.$client.end();
    await telemetry.shutdown();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

main().catch((error: unknown) => {
  console.error({ err: error }, 'worker failed to start');
  process.exit(1);
});
