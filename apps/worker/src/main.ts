import {
  createAnthropicClient,
  createCommitmentExtractor,
  dbRunRecorder,
  dbSpendReader,
  sdkModelRunner,
  type AgentDeps,
} from '@lance/agents';
import {
  createAccessTokenProvider,
  createGraphConnector,
  createGraphReads,
  createAppInsightsClient,
  createJamieConnector,
  createJamieReads,
  createSlackClient,
  slackReads,
  createNotionConnector,
  createSlackSurface,
  InMemoryTokenStore,
  KeyVaultTokenStore,
  type GraphReads,
  type JamieReads,
  type NotionConnector,
  type SlackSurface,
} from '@lance/connectors';
import {
  createDb,
  observations,
  proposals,
  resolveSinglePrincipal,
  scopedDb,
  type Db,
} from '@lance/db';
import { OntologyRepository } from '@lance/ontology';
import {
  expireProposals,
  LedgerReader,
  LedgerWriter,
  SystemControl,
  toProposal,
} from '@lance/ledger';
import { getConfig, nowIso, readSecret, type Config, type ProvenanceRef } from '@lance/shared';
import { initTelemetry } from '@lance/telemetry';
import { and, eq } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import { raiseAlert } from './alerts/raise.js';
import { critique } from './critic/index.js';
import { createDraftReviewer } from './critic/review.js';
import { createProposalHandler } from './executor/createProposal.js';
import { createConnectorWrite, type ExecutionWriters } from './executor/dispatch.js';
import { graphExecutionWriters, notionExecutionWriters } from './executor/writers.js';
import { registerExecutor } from './executor/index.js';
import { reflectProposal } from './executor/reflect.js';
import { postDryRunDigest } from './digest/dryRunDigest.js';
import { ensureSeedRules, loadActiveRules } from './policy/rules.js';
import { runChase } from './chase/run.js';
import { createBoss, startBoss, work } from './scheduler/boss.js';
import { PauseGate } from './scheduler/gate.js';
import { QUEUES, type ChaseJob } from './scheduler/queues.js';
import { runTriage } from './triage/run.js';
import { deliverAlerts } from './alerts/engine/deliver.js';
import { registerDetector } from './alerts/engine/run.js';
import { allDetectors } from './alerts/detectors/index.js';
import type { Detector } from './alerts/detectors/types.js';
import { registerBriefs } from './briefs/run.js';
import { registerWeeklyReview } from './briefs/weekly.js';
import { createAgentLogsDetector, createAgentLogsWatcher } from './watchers/agent-logs/index.js';
import { createJamieWatcher } from './watchers/jamie/index.js';
import {
  createNotionWatcher,
  notionWatcherReads,
  openNotionTaskIds,
} from './watchers/notion/index.js';
import { pgBossTriageEnqueuer, registerWatcher, type TriageJob } from './watchers/runner.js';
import {
  createGraphCalendarWatcher,
  createGraphMailWatcher,
  createHaikuLabeller,
} from './watchers/graph/index.js';
import { hashRecord } from '@lance/shared';

const WORKER_VERSION = '0.1.0';
const EXPIRY_QUEUE = 'expire-proposals';
const ALERT_DELIVERY_QUEUE = 'alerts-deliver';
/** Spec 11: the inbox agent's watermark is stale after this many hours without a new line. */
const STALE_WATERMARK_HOURS = 24;

/** How long a triage job waits before it is looked at again while paused. */
const TRIAGE_RETRY_WHILE_PAUSED_S = 60;

/** The recorded payload of each observation a provenance list points at, for the critic and the executor. */
async function loadSourceRecords(
  db: Db,
  provenance: readonly ProvenanceRef[],
): Promise<Record<string, unknown>[]> {
  const records: Record<string, unknown>[] = [];
  for (const ref of provenance) {
    const rows = await db
      .select({ payload: observations.payload })
      .from(observations)
      .where(
        and(
          eq(observations.sourceSystem, ref.system),
          eq(observations.sourceRecordId, ref.recordId),
        ),
      )
      .limit(1);
    const payload = rows[0]?.payload;
    if (typeof payload === 'object' && payload !== null) {
      records.push(payload as Record<string, unknown>);
    }
  }
  return records;
}

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

/** Jamie is optional at boot: without JAMIE_API_KEY the worker runs everything else (ADR 0005). */
function buildJamie(db: Db): JamieReads | null {
  if (env('JAMIE_API_KEY') === undefined) return null;
  const jamie = createJamieConnector({
    apiKey: readSecret('JAMIE_API_KEY'),
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
  return createJamieReads(jamie);
}

function buildSlack(config: Config): SlackSurface | null {
  if (env('SLACK_BOT_TOKEN') === undefined) return null;
  return createSlackSurface({
    token: readSecret('SLACK_BOT_TOKEN'),
    channelId: config.slack.channelId,
  });
}

function buildAgentDeps(config: Config, db: Db, control: SystemControl): AgentDeps | null {
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
    // Spec 13: the ceiling Settings last saved, read on every run so a change applies at once.
    readCeilingGbp: async () => (await control.read()).costCeilingGbp,
  };
}

async function registerExpiry(boss: PgBoss, db: Db): Promise<void> {
  await boss.createQueue(EXPIRY_QUEUE);
  await boss.schedule(EXPIRY_QUEUE, '*/15 * * * *', {}, { key: EXPIRY_QUEUE });
  await work(boss, EXPIRY_QUEUE, async () => {
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
  await work(boss, DIGEST_QUEUE, async () => {
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
  // One principal in Phase 4 (ADR 0015). Every job runs through a handle
  // scoped to it; organisation rules are seeded through an admin scope.
  const root = createDb();
  const principal = await resolveSinglePrincipal(root, config.dom.email);
  const db = scopedDb(root, { principalId: principal.id });
  const adminDb = scopedDb(root, { principalId: principal.id, admin: true });
  const control = new SystemControl(db);
  const gate = new PauseGate(control);
  const boss = createBoss(db);
  boss.on('error', (error: Error) => {
    console.error({ err: error }, 'pg-boss error');
  });

  const seeded = await ensureSeedRules(adminDb, config.slack.channelId);
  const graph = buildGraph(db);
  const notion = buildNotion(config, db);
  const slack = buildSlack(config);
  const agent = buildAgentDeps(config, db, control);
  const jamie = buildJamie(db);
  const ontology = new OntologyRepository(db);
  const extractCommitments =
    agent === null
      ? null
      : createCommitmentExtractor({
          agent,
          model: config.models.triage,
          displayName: config.agentDisplayName,
        });

  // A second mail watcher instance with no labeller: used only to normalise a
  // re-fetched message for the executor's hash check, never to poll.
  const verifier = createGraphMailWatcher({
    reads:
      graph === null
        ? { deltaMessages: () => Promise.reject(new Error('verifier does not poll')) }
        : graph.reads,
    label: () => Promise.resolve([]),
  });

  const reviewDraft =
    agent === null
      ? null
      : createDraftReviewer({
          agent,
          model: config.models.critic,
          displayName: config.agentDisplayName,
        });
  const createProposal = createProposalHandler({
    db,
    config,
    control,
    loadRules: () => loadActiveRules(db),
    critique: async (draft, context, ruleId) => {
      const rules = await loadActiveRules(db);
      return critique(draft, {
        permittedNotionProperties: config.notion.permittedTaskProperties,
        authorisedBy: rules.find((rule) => rule.id === ruleId) ?? null,
        sourceRecords: await loadSourceRecords(db, draft.provenance),
        ...(reviewDraft === null
          ? {}
          : { reviewDraft: (reviewed) => reviewDraft(reviewed, context.correlationId) }),
      });
    },
    slack,
    enqueueExecute: async (proposalId) => {
      await boss.send(QUEUES.execute, { proposalId });
    },
  });

  const write = createConnectorWrite({
    db,
    featureFlags: config.featureFlags,
    writers: {
      ...(graph === null ? {} : { graph: graph.writers }),
      ...(notion === null ? {} : { notion: notion.writers }),
    },
    loadRules: () => loadActiveRules(db),
    verifyTarget: async (proposal) => {
      // Spec 7.5 step 2: re-fetch the target and compare the same content hash
      // the watcher recorded. Only Graph messages are checked in v1; a
      // proposal on anything else has no target to verify.
      if (graph === null || proposal.targetSystem !== 'graph' || proposal.targetRecordId === null)
        return 'unknown';
      const ref = proposal.provenance.find(
        (entry) => entry.system === 'graph' && entry.recordId === proposal.targetRecordId,
      );
      if (ref === undefined) return 'unknown';
      // The watcher hashed the record with the folder kind it was polled
      // from, so the re-fetched message is normalised under the same kind,
      // read back from the recorded observation rather than guessed from
      // Graph's folder id.
      const recorded = await loadSourceRecords(db, [ref]);
      const folder = recorded[0]?.['folder'];
      const partition = folder === 'inbox' || folder === 'sentitems' ? folder : null;
      if (partition === null) return 'changed';
      try {
        const message = await graph.reads.getMessage(proposal.targetRecordId);
        const observation = await verifier.normalise(
          { id: message.id, observedAt: nowIso(), raw: message },
          partition,
        );
        return hashRecord(observation.record) === ref.hash ? 'unchanged' : 'changed';
      } catch (error) {
        // A target that cannot be fetched or read is not one to write to:
        // the executor holds the proposal and the card says why.
        console.warn(
          { err: error, proposalId: proposal.id },
          'target could not be re-fetched before execution',
        );
        return 'changed';
      }
    },
    loadLabels: async (proposal) => {
      const labels = new Set<string>();
      for (const record of await loadSourceRecords(db, proposal.provenance)) {
        const recorded = record['labels'];
        if (Array.isArray(recorded)) {
          for (const label of recorded) if (typeof label === 'string') labels.add(label);
        }
      }
      return [...labels];
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

  // Alerts (spec 9.4, 11): delivery every minute, detectors on their own crons.
  await boss.createQueue(ALERT_DELIVERY_QUEUE);
  await boss.schedule(ALERT_DELIVERY_QUEUE, '* * * * *', {}, { key: ALERT_DELIVERY_QUEUE });
  await work(boss, ALERT_DELIVERY_QUEUE, async () => {
    // Paused is not silent: P0 still goes out, everything else waits (spec 9.4).
    const paused = !(await gate.check()).runnable;
    await deliverAlerts({
      db,
      config,
      slack,
      webUrl: env('PUBLIC_WEB_URL') ?? null,
      paused,
      control,
    });
  });
  const detectorContext = { db, config, ontology, control, now: nowIso };
  const detectors: Detector[] = [
    createAgentLogsDetector({ db, maxWatermarkAgeHours: STALE_WATERMARK_HOURS }),
    ...allDetectors(),
  ];
  for (const detector of detectors) await registerDetector(boss, detector, detectorContext);

  // Briefs (spec 10): the Planner needs a model; without one the brief is the facts alone.
  const briefDeps = {
    db,
    config,
    ontology,
    agent,
    reads: {
      searchLedger: async (query: { correlationId?: string | undefined; limit: number }) =>
        (
          await new LedgerReader(db).query({
            ...(query.correlationId === undefined ? {} : { correlationId: query.correlationId }),
            limit: query.limit,
          })
        ).map((event) => ({
          id: event.id,
          ts: event.ts.toISOString(),
          kind: event.kind,
          actor: event.actor,
          sourceSystem: event.sourceSystem,
          sourceRecordId: event.sourceRecordId,
          correlationId: event.correlationId,
          summary:
            ((event.payload as Record<string, unknown> | null)?.['summary'] as
              string | undefined) ?? null,
        })),
      getSourceRecord: async (system: string, recordId: string) => {
        const rows = await db
          .select({ payload: observations.payload })
          .from(observations)
          .where(
            and(eq(observations.sourceSystem, system), eq(observations.sourceRecordId, recordId)),
          )
          .limit(1);
        const record = rows[0]?.payload as Record<string, unknown> | undefined;
        if (record === undefined) return null;
        // The planner reads metadata, never a mail body or a transcript (spec 4.3).
        const { body, bodyPreview, bodyText, transcript, ...metadata } = record;
        void body;
        void bodyPreview;
        void bodyText;
        void transcript;
        return metadata;
      },
      lookupEntity: async (query: string) =>
        (await ontology.search(query, 10)).map((node) => {
          const display =
            node.properties['display_name'] ?? node.properties['name'] ?? node.properties['title'];
          return {
            id: node.id,
            label: node.label,
            display: typeof display === 'string' ? display : node.id,
            confidence:
              typeof node.properties['confidence'] === 'number' ? node.properties['confidence'] : 1,
          };
        }),
    },
    slack,
    createProposal,
  };
  await registerBriefs(boss, briefDeps);
  // `/lance brief` from the api lands on the same morning queue.
  await registerWeeklyReview(boss, { db, config, agent, slack });

  if (agent !== null) {
    await work<TriageJob>(boss, QUEUES.triage, async (jobs) => {
      for (const job of jobs) {
        if (!(await gate.check()).runnable) {
          // Paused: the job is put back for later rather than dropped, so a
          // pause during a busy tick loses no triage (non-negotiable 6).
          await boss.send(QUEUES.triage, job.data, { startAfter: TRIAGE_RETRY_WHILE_PAUSED_S });
          continue;
        }
        await runTriage(
          {
            db,
            config,
            agent,
            createProposal,
            ontology,
            extractCommitments,
            dom: { ...config.dom, notionUserId: config.notion.domUserId },
            debrief: { slack },
          },
          job.data,
        );
      }
    });
  }
  if (agent !== null) {
    await work<ChaseJob>(boss, QUEUES.chase, async (jobs) => {
      for (const job of jobs) {
        if (!(await gate.check()).runnable) {
          // Paused: the chase goes back on the queue rather than being
          // dropped, exactly as a triage job does.
          await boss.send(QUEUES.chase, job.data, { startAfter: TRIAGE_RETRY_WHILE_PAUSED_S });
          continue;
        }
        const result = await runChase(
          { db, config, agent, ontology, createProposal },
          { commitmentId: job.data.commitmentId },
        );
        if (result.status === 'refused') {
          console.warn(
            { commitmentId: job.data.commitmentId, reason: result.reason },
            'chase refused',
          );
        }
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
  const phaseTwoRunnerDeps = { db, gate, control, enqueueTriage: pgBossTriageEnqueuer(boss) };
  if (jamie !== null) {
    await registerWatcher(
      boss,
      phaseTwoRunnerDeps,
      createJamieWatcher({ reads: jamie, domEmail: config.dom.email }),
      config.timeZone,
    );
  }
  if (slack !== null) {
    const workspaceId = env('LOG_ANALYTICS_WORKSPACE_ID');
    const reads = slackReads(createSlackClient({ token: readSecret('SLACK_BOT_TOKEN') }));
    // The watcher skips Lance's own posts; the bot's identity comes from the
    // token itself rather than from configuration that could drift. When
    // Slack will not say who we are, the watcher stays off and Dom hears why,
    // rather than the whole worker failing to boot.
    const self = await reads.authTest().catch(async (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      await raiseAlert(db, {
        kind: 'watcher_failed',
        severity: 'P1',
        dedupeKey: 'watcher:agent-logs:identity',
        title: 'Agent-logs watcher did not start',
        body: `Slack auth.test failed: ${message} Check the bot token in Key Vault and restart the worker.`,
        actor: `agent:worker@${WORKER_VERSION}`,
      });
      return null;
    });
    if (self !== null) {
      await registerWatcher(
        boss,
        phaseTwoRunnerDeps,
        createAgentLogsWatcher({
          slack: reads,
          channelId: config.slack.channelId,
          ownBotUserId: self.userId,
          ...(self.botId === null ? {} : { ownBotId: self.botId }),
          appInsights: workspaceId === undefined ? null : createAppInsightsClient({ workspaceId }),
        }),
        config.timeZone,
      );
    }
  }
  if (notion !== null) {
    await registerWatcher(
      boss,
      phaseTwoRunnerDeps,
      createNotionWatcher({
        reads: notionWatcherReads(notion.connector),
        tasksDataSourceId: config.notion.tasksDataSourceId,
        meetingsDataSourceId: config.notion.meetingsDataSourceId,
        knownOpenTaskIds: () => openNotionTaskIds(db),
      }),
      config.timeZone,
    );
  }

  console.info(
    {
      mode: config.mode,
      seededRules: seeded.inserted,
      graph: graph !== null,
      notion: notion !== null,
      jamie: jamie !== null,
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
