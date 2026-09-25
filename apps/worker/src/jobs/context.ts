import {
  createCommitmentExtractor,
  dbRunRecorder,
  dbSpendReader,
  type AgentDeps,
  type BudgetCheck,
  type CommitmentExtractor,
  type FairShareLimiter,
  type ModelRunner,
  type ReadToolDeps,
} from '@lance/agents';
import type { SlackSurface } from '@lance/connectors';
import { observations, proposals, scopedDb, type Db, type Principal } from '@lance/db';
import { OntologyRepository } from '@lance/ontology';
import { LedgerReader, LedgerWriter, SystemControl, toProposal } from '@lance/ledger';
import {
  hashRecord,
  nowIso,
  principalDisplayName,
  principalIdentity,
  type Config,
  type ProvenanceRef,
} from '@lance/shared';
import { and, eq } from 'drizzle-orm';
import { localDate, localDayStart } from '../alerts/detectors/support.js';
import type { DetectorContext } from '../alerts/detectors/types.js';
import type { BriefDeps } from '../briefs/run.js';
import type { WeeklyDeps } from '../briefs/weekly.js';
import type { ChaseDeps } from '../chase/run.js';
import { critique } from '../critic/index.js';
import { createDraftReviewer } from '../critic/review.js';
import { createProposalHandler } from '../executor/createProposal.js';
import { createConnectorWrite } from '../executor/dispatch.js';
import type { ExecutorDeps } from '../executor/index.js';
import type { ReflectDeps } from '../executor/reflect.js';
import { loadActiveRules } from '../policy/rules.js';
import { PauseGate } from '../scheduler/gate.js';
import { QUEUES } from '../scheduler/queues.js';
import { createMailRouter, type BulkMailDeps } from '../triage/bulk.js';
import type { TriageDeps } from '../triage/run.js';
import { createAgentLogsWatcher } from '../watchers/agent-logs/index.js';
import {
  createGraphCalendarWatcher,
  createGraphMailWatcher,
  createHaikuLabeller,
} from '../watchers/graph/index.js';
import { createJamieWatcher } from '../watchers/jamie/index.js';
import {
  createNotionWatcher,
  notionWatcherReads,
  openNotionTaskIds,
} from '../watchers/notion/index.js';
import { watcherQueue, type TriageJob, type WatcherRunnerDeps } from '../watchers/runner.js';
import type { Watcher } from '../watchers/types.js';
import type { ConnectorBundle, ConnectorLookup, GraphBundle } from './connectors.js';
import { principalJobOptions, threadJobOptions } from './scoped.js';

/**
 * Everything one principal's jobs run with (ADR 0025): a handle scoped to
 * them and every collaborator built over it. The worker builds one context
 * per principal the first time one of their jobs runs and keeps it, so a
 * job never reaches for another principal's scope or for a closure built
 * once in `main()`.
 */

/** Built once per process and shared by every principal's context. */
export interface SharedDeps {
  config: Config;
  /** Unscoped: it reads `principals` and creates scoped handles, nothing else. */
  root: Db;
  /** The one Anthropic client for the organisation, or null without an API key. */
  modelRunner: ModelRunner | null;
  limiter: FairShareLimiter;
  /** Today's spend across every active principal against the organisation ceiling. */
  checkOrganisationBudget: () => Promise<BudgetCheck>;
  connectorsFor: ConnectorLookup;
  /** Sends one job to pg-boss; the queue and payload are the caller's. */
  send: (
    queue: string,
    data: object,
    options?: {
      startAfter?: number;
      singletonKey?: string;
      singletonSeconds?: number;
      group?: { id: string };
    },
  ) => Promise<void>;
  /** Where the Alerts page lives, for the overflow post. */
  webUrl: string | null;
  /**
   * Builds the principal's watchers from their connectors. Tests replace it
   * to run fake watchers; the default is `watchersFromConnectors`.
   */
  buildWatchers?: (context: WatcherBuildContext) => Watcher[];
}

export interface WatcherBuildContext {
  principal: Principal;
  db: Db;
  config: Config;
  connectors: ConnectorBundle | null;
  agent: AgentDeps | null;
}

export interface PrincipalContext {
  principal: Principal;
  db: Db;
  control: SystemControl;
  gate: PauseGate;
  ledger: LedgerWriter;
  ontology: OntologyRepository;
  connectors: ConnectorBundle | null;
  /** The principal's own Slack surface; null for a principal with no connectors. */
  slack: SlackSurface | null;
  /** Null without a model: agent-backed jobs are skipped or run on facts alone. */
  agent: AgentDeps | null;
  createProposal: ReturnType<typeof createProposalHandler>;
  executor: ExecutorDeps;
  reflect: ReflectDeps;
  briefs: BriefDeps;
  weekly: WeeklyDeps;
  detectors: DetectorContext;
  /** By queue name, for the watchers this principal has connectors for. */
  watchers: ReadonlyMap<string, Watcher>;
  runner: WatcherRunnerDeps;
  triage: TriageDeps | null;
  /** Files bulk mail without a model (ADR 0034); runs whether or not a model is configured. */
  bulkMail: BulkMailDeps;
  chase: ChaseDeps | null;
}

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

/** Local midnight today in `timeZone`, where a principal's daily spend starts. */
const startOfLocalDay = (timeZone: string): Date =>
  new Date(localDayStart(localDate(nowIso(), timeZone), timeZone));

function buildAgent(
  shared: SharedDeps,
  principal: Principal,
  db: Db,
  control: SystemControl,
): AgentDeps | null {
  if (shared.modelRunner === null) return null;
  return {
    runner: shared.modelRunner,
    recorder: dbRunRecorder(db),
    ledger: new LedgerWriter(db),
    config: shared.config,
    readSpendUsd: dbSpendReader(db, () => startOfLocalDay(shared.config.timeZone)),
    // Spec 13: the ceiling Settings last saved, read on every run so a change applies at once.
    readCeilingGbp: async () => (await control.read()).costCeilingGbp,
    checkOrganisationBudget: shared.checkOrganisationBudget,
    limit: (work) => shared.limiter.run(principal.id, work),
  };
}

/** A mail watcher with no labeller, used only to normalise a re-fetched message for the executor's hash check. */
function verifierFor(graph: GraphBundle | null): Watcher {
  return createGraphMailWatcher({
    reads:
      graph === null
        ? { deltaMessages: () => Promise.reject(new Error('verifier does not poll')) }
        : graph.reads,
    label: () => Promise.resolve([]),
  });
}

/** The watchers a principal's connectors allow, each built over their own handle. */
/**
 * How a principal's approved proposals reach the execute queue: in the
 * principal's group, so the executor never runs two of their proposals at
 * once (ADR 0025).
 */
export function executeSender(
  send: SharedDeps['send'],
  principalId: string,
): (proposalId: string) => Promise<void> {
  return (proposalId) =>
    send(QUEUES.execute, { principalId, proposalId }, principalJobOptions(principalId));
}

export function watchersFromConnectors(context: WatcherBuildContext): Watcher[] {
  const { connectors, agent, config, db, principal } = context;
  if (connectors === null) return [];
  const watchers: Watcher[] = [];
  if (connectors.graph !== null) {
    const label =
      agent === null
        ? () => Promise.resolve(['Unlabelled'])
        : createHaikuLabeller({
            agent,
            model: config.models.label,
            displayName: config.agentDisplayName,
          });
    watchers.push(createGraphMailWatcher({ reads: connectors.graph.reads, label }));
    watchers.push(createGraphCalendarWatcher({ reads: connectors.graph.reads }));
  }
  if (connectors.jamie !== null) {
    watchers.push(createJamieWatcher({ reads: connectors.jamie, domEmail: principal.upn }));
  }
  if (connectors.agentLogs !== null) {
    const source = connectors.agentLogs;
    watchers.push(
      createAgentLogsWatcher({
        slack: source.slack,
        channelId: source.channelId,
        ownBotUserId: source.ownBotUserId,
        ...(source.ownBotId === null ? {} : { ownBotId: source.ownBotId }),
        appInsights: source.appInsights,
      }),
    );
  }
  if (connectors.notion !== null) {
    watchers.push(
      createNotionWatcher({
        reads: notionWatcherReads(connectors.notion.connector),
        tasksDataSourceId: config.notion.tasksDataSourceId,
        meetingsDataSourceId: config.notion.meetingsDataSourceId,
        knownOpenTaskIds: () => openNotionTaskIds(db),
      }),
    );
  }
  return watchers;
}

function briefReads(db: Db, ontology: OntologyRepository): ReadToolDeps {
  return {
    searchLedger: async (query) =>
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
          ((event.payload as Record<string, unknown> | null)?.['summary'] as string | undefined) ??
          null,
      })),
    getSourceRecord: async (system, recordId) => {
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
    lookupEntity: async (query) =>
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
  };
}

/** Builds one principal's context. The legacy graph backfill runs once at boot, before any context (`backfillLegacyGraph`). */
export async function buildPrincipalContext(
  shared: SharedDeps,
  principal: Principal,
): Promise<PrincipalContext> {
  const { config } = shared;
  const db = scopedDb(shared.root, { principalId: principal.id });
  const control = new SystemControl(db);
  const gate = new PauseGate(control);
  const ontology = new OntologyRepository(
    db,
    { principalId: principal.id },
    { principalName: principalDisplayName(principal.upn, config) },
  );

  const connectors = await shared.connectorsFor(principal, db);
  const slack = connectors?.slack ?? null;
  const graph = connectors?.graph ?? null;
  const notion = connectors?.notion ?? null;
  // Whose rows in the shared All Tasks database are the principal's (ADR 0022).
  const principalNotionUserId = notion?.principalUserId ?? principal.notionUserId ?? null;
  // The person Lance acts for in this context, everywhere a job names them.
  const identity = principalIdentity(principal, config, principalNotionUserId);
  const agent = buildAgent(shared, principal, db, control);
  const verifier = verifierFor(graph);

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
    enqueueExecute: executeSender(shared.send, principal.id),
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
          { err: error, proposalId: proposal.id, principalId: principal.id },
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

  const extractCommitments: CommitmentExtractor | null =
    agent === null
      ? null
      : createCommitmentExtractor({
          agent,
          model: config.models.triage,
          displayName: config.agentDisplayName,
        });

  const watchers = (shared.buildWatchers ?? watchersFromConnectors)({
    principal,
    db,
    config,
    connectors,
    agent,
  });

  return {
    principal,
    db,
    control,
    gate,
    ledger: new LedgerWriter(db),
    ontology,
    connectors,
    slack,
    agent,
    createProposal,
    executor: { db, gate, write },
    reflect: {
      db,
      surface: slack,
      render: { displayName: config.agentDisplayName, timeZone: config.timeZone },
    },
    briefs: {
      db,
      config,
      ontology,
      agent,
      reads: briefReads(db, ontology),
      slack,
      createProposal,
      principal: identity,
      principalNotionUserId,
    },
    weekly: { db, config, agent, slack },
    detectors: { db, config, principal: identity, ontology, control, now: nowIso },
    watchers: new Map(watchers.map((watcher) => [watcherQueue(watcher), watcher])),
    runner: {
      db,
      gate,
      control,
      principalId: principal.id,
      // A burst on one thread is sent once (the singleton window), and
      // bulk mail goes to the filer rather than to the model (ADR 0034).
      enqueueTriage: createMailRouter({
        db,
        config,
        ontology,
        sendTriage: (job: TriageJob) =>
          shared.send(
            QUEUES.triage,
            { ...job, principalId: principal.id },
            threadJobOptions(principal.id, job.correlationId),
          ),
        sendBulk: (job: TriageJob) =>
          shared.send(
            QUEUES.bulkMail,
            { ...job, principalId: principal.id },
            threadJobOptions(principal.id, job.correlationId),
          ),
      }),
    },
    triage:
      agent === null
        ? null
        : {
            db,
            config,
            agent,
            createProposal,
            ontology,
            extractCommitments,
            principal: identity,
            debrief: { slack },
          },
    bulkMail: { db, config, createProposal },
    chase:
      agent === null ? null : { db, config, principal: identity, agent, ontology, createProposal },
  };
}
