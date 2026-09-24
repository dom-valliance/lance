import { createSlackSurface, type SlackSurface } from '@lance/connectors';
import { KeyVaultTokenStore } from '@lance/connectors/graph';
import { createDb, scopedDb, systemState, SYSTEM_STATE_ID, type Db } from '@lance/db';
import {
  countProposals,
  decideProposal,
  getProposal,
  listProposals,
  pendingProposalSummary,
  LedgerReader,
  LedgerWriter,
  SystemControl,
} from '@lance/ledger';
import { OntologyRepository } from '@lance/ontology';
import { getConfig, readSecret, type Config } from '@lance/shared';
import { initTelemetry } from '@lance/telemetry';
import { pathToFileURL } from 'node:url';
import { eq } from 'drizzle-orm';
import { actorFromUpn } from './actor.js';
import { createAdminStore } from './admin/store.js';
import { createAgentsStore } from './agents/store.js';
import { createAlertStore } from './alerts/store.js';
import { createEntraVerifier } from './auth/entra.js';
import { createBriefStore } from './briefs/store.js';
import { createCommitmentStore } from './commitments/store.js';
import { createTaskStore } from './tasks/store.js';
import type {
  ApiDeps,
  GraphConsentDeps,
  PrincipalKey,
  ServerDeps,
  SlackDeps,
  TokenVerifier,
} from './deps.js';
import { createFeed } from './events.js';
import { createJobsService } from './jobs/service.js';
import { createExecuteQueue, type ExecuteQueue } from './executeQueue.js';
import { createPrincipalDirectory } from './principals/directory.js';
import { applyDecision, type DecideDeps } from './proposals/decide.js';
import { buildServer } from './server.js';
import { createDbStatusSource } from './status.js';

/**
 * Process entry point. Everything the server needs is built here and passed
 * in, so `buildServer` itself reaches for nothing global.
 */

const DEFAULT_PORT = 3001;
/** Container Apps routes to the container's own interface, not to loopback. */
const HOST = '0.0.0.0';

export interface PrincipalRuntimeOptions {
  config: Config;
  /** Scoped to `principal`; every store reads and writes through it. */
  db: Db;
  /** The principal `db` is scoped to; the ontology reads through the same scope. */
  principal: PrincipalKey;
  /** Null, the default, when no bot token is configured: cards are skipped. */
  slackSurface?: SlackSurface | null;
  /** Defaults to pg-boss over the same pool; passed in so `main` can stop it. */
  executeQueue?: ExecuteQueue;
}

/**
 * Assembles one principal's `SystemControl`, `LedgerReader`,
 * `LedgerWriter`, proposal reads, decision service and status source over
 * `db`, which is scoped to that principal.
 */
export const createApiDeps = (options: PrincipalRuntimeOptions): ApiDeps => {
  const control = new SystemControl(options.db);
  const feed = createFeed();
  const executeQueue = options.executeQueue ?? createExecuteQueue(options.db);
  const slackSurface = options.slackSurface ?? null;

  const decideDeps: DecideDeps = {
    decide: (input) => decideProposal(options.db, input),
    getProposal: (id) => getProposal(options.db, id),
    enqueueExecute: (proposalId) => executeQueue.enqueueExecute(options.principal.id, proposalId),
    slack: slackSurface,
    notify: (event) => {
      feed.notify(event);
    },
    config: options.config,
    onSlackFailure: (error, proposalId) => {
      console.warn({ err: error, proposalId }, 'Could not redraw the Slack card after a decision');
    },
  };

  return {
    config: options.config,
    principalId: options.principal.id,
    actor: actorFromUpn(options.principal.upn),
    upn: options.principal.upn,
    control,
    ledger: new LedgerReader(options.db),
    writer: new LedgerWriter(options.db),
    proposals: {
      list: (filter) => listProposals(options.db, filter),
      count: (filter) => countProposals(options.db, filter),
      summary: () => pendingProposalSummary(options.db),
      get: (id) => getProposal(options.db, id),
    },
    decide: (request) => applyDecision(decideDeps, request),
    enqueueExecute: (proposalId) => executeQueue.enqueueExecute(options.principal.id, proposalId),
    commitments: createCommitmentStore(options.db),
    tasks: createTaskStore(options.db),
    briefs: createBriefStore(options.db),
    alerts: createAlertStore(options.db),
    agents: createAgentsStore(options.db),
    ontology: new OntologyRepository(
      options.db,
      { principalId: options.principal.id },
      { principalName: options.config.dom.name },
    ),
    enqueueChase: (commitmentId) => executeQueue.enqueueChase(options.principal.id, commitmentId),
    enqueueBrief: () => executeQueue.enqueueBrief(options.principal.id),
    jobs: createJobsService({
      db: options.db,
      principalId: options.principal.id,
      queue: executeQueue,
    }),
    status: createDbStatusSource(options.db, control, {
      usdToGbp: options.config.cost.usdToGbp,
      timeZone: options.config.timeZone,
    }),
    slackSurface,
    onAlertSlackFailure: (error, alertId) => {
      console.warn(
        { err: error, alertId },
        'Could not redraw the Slack card after an alert change',
      );
    },
    notify: (event) => {
      feed.notify(event);
    },
    subscribe: (listener) => feed.subscribe(listener),
  };
};

/**
 * The per-principal dependency cache: `build` runs once per principal, and
 * every later request for the same principal gets the same object, so its
 * live feed is shared by that principal's connections and nobody else's.
 */
export const createDepsCache = (
  build: (principal: PrincipalKey) => ApiDeps,
): ((principal: PrincipalKey) => ApiDeps) => {
  const cache = new Map<string, ApiDeps>();
  return (principal) => {
    const cached = cache.get(principal.id);
    if (cached !== undefined) return cached;
    const built = build(principal);
    cache.set(principal.id, built);
    return built;
  };
};

export interface ServerRuntimeOptions {
  config: Config;
  /** Unscoped. Each principal's stores get a handle scoped from it. */
  root: Db;
  auth: TokenVerifier;
  slack: SlackDeps;
  ingestSecret: string;
  /** Omitted by a process that does not run the Graph consent flow. */
  graph?: GraphConsentDeps;
  /** Null, the default, when no bot token is configured: cards are skipped. */
  slackSurface?: SlackSurface | null;
  /**
   * One queue for every principal: pg-boss's tables carry no principal, so
   * every job payload names the principal it is for (ADR 0025).
   */
  executeQueue?: ExecuteQueue;
}

/** Everything `buildServer` needs, over the real database. */
export const createServerDeps = (options: ServerRuntimeOptions): ServerDeps => {
  const executeQueue = options.executeQueue ?? createExecuteQueue(options.root);
  const slackSurface = options.slackSurface ?? null;
  const directory = createPrincipalDirectory(options.root);
  return {
    config: options.config,
    auth: options.auth,
    directory,
    depsFor: createDepsCache((principal) =>
      createApiDeps({
        config: options.config,
        db: scopedDb(options.root, { principalId: principal.id }),
        principal,
        executeQueue,
        slackSurface,
      }),
    ),
    admin: createAdminStore(options.root, directory, {
      usdToGbp: options.config.cost.usdToGbp,
      timeZone: options.config.timeZone,
    }),
    readiness: async () => {
      const rows = await options.root
        .select({ paused: systemState.paused, mode: systemState.mode })
        .from(systemState)
        .where(eq(systemState.id, SYSTEM_STATE_ID));
      const row = rows[0];
      if (row === undefined) {
        throw new Error('system_state has no row. Run the migration job, which seeds it.');
      }
      return row;
    },
    slack: options.slack,
    ingestSecret: options.ingestSecret,
    ...(options.graph === undefined ? {} : { graph: options.graph }),
  };
};

/**
 * Lance's own Slack channel (ADR 0012), or null when no bot token is set.
 * A local api then still answers every route; only the card update and the
 * modals are unavailable, and both say so.
 */
const slackSurfaceFromEnv = (channelId: string): SlackSurface | null => {
  const token = process.env['SLACK_BOT_TOKEN'];
  if (token === undefined || token === '') return null;
  return createSlackSurface({ token: readSecret('SLACK_BOT_TOKEN'), channelId });
};

/**
 * Reads a required, non-secret environment variable. Secrets go through
 * `readSecret`; these three are identifiers, published in the Entra runbook
 * and safe in plain configuration.
 */
const requiredEnv = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(
      `Missing required environment variable "${name}". See docs/runbooks/entra-setup.md for where its value comes from.`,
    );
  }
  return value;
};

const nonEmpty = (value: string | undefined): string | null =>
  value === undefined || value === '' ? null : value;

const port = (): number => {
  const raw = process.env['PORT'];
  if (raw === undefined || raw === '') return DEFAULT_PORT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535.');
  }
  return parsed;
};

export const main = async (): Promise<void> => {
  const config = getConfig();
  const telemetry = initTelemetry({
    serviceName: 'lance-api',
    serviceVersion: '0.1.0',
    environment: config.nodeEnv,
  });
  const tenantId = requiredEnv('ENTRA_TENANT_ID');
  const clientId = requiredEnv('ENTRA_CLIENT_ID');

  // The principal is resolved per request from the token's oid (ADR 0020),
  // and each principal's stores read and write through a handle scoped to
  // them, so row-level security holds the line between principals.
  const root = createDb();
  const executeQueue = createExecuteQueue(root);

  const deps = createServerDeps({
    config,
    root,
    executeQueue,
    slackSurface: slackSurfaceFromEnv(config.slack.channelId),
    auth: createEntraVerifier({ tenantId, clientId }),
    graph: {
      tenantId,
      clientId,
      clientSecret: readSecret('ENTRA_CLIENT_SECRET'),
      publicApiUrl: requiredEnv('PUBLIC_API_URL'),
      tokenStore: KeyVaultTokenStore.fromEnv(),
    },
    slack: {
      signingSecret: readSecret('SLACK_SIGNING_SECRET'),
      // Covers a principal row recorded before its Slack id was known.
      fallbackUserId: nonEmpty(process.env['SLACK_ALLOWED_USER_ID']),
    },
    ingestSecret: readSecret('AGENT_LOG_INGEST_SECRET'),
  });

  const server = buildServer(deps);

  const shutdown = (signal: string): void => {
    server.log.info({ signal }, 'Shutting down the api');
    void server
      .close()
      .then(() => executeQueue.stop())
      .then(() => root.$client.end())
      .then(() => telemetry.shutdown())
      .then(() => process.exit(0));
  };
  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });

  await server.listen({ port: port(), host: HOST });
};

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  await main();
}
