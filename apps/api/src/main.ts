import { createSlackSurface, type SlackSurface } from '@lance/connectors';
import { KeyVaultTokenStore } from '@lance/connectors/graph';
import { createDb, type Db } from '@lance/db';
import {
  decideProposal,
  getProposal,
  listProposals,
  LedgerReader,
  LedgerWriter,
  SystemControl,
} from '@lance/ledger';
import { OntologyRepository } from '@lance/ontology';
import { getConfig, readSecret, type Config } from '@lance/shared';
import { initTelemetry } from '@lance/telemetry';
import { pathToFileURL } from 'node:url';
import { createAlertStore } from './alerts/store.js';
import { createEntraVerifier } from './auth/entra.js';
import { createBriefStore } from './briefs/store.js';
import { createCommitmentStore } from './commitments/store.js';
import { createTaskStore } from './tasks/store.js';
import type { ApiDeps, GraphConsentDeps, SlackDeps, TokenVerifier } from './deps.js';
import { createFeed } from './events.js';
import { createExecuteQueue, type ExecuteQueue } from './executeQueue.js';
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

export interface RuntimeOptions {
  config: Config;
  db: Db;
  auth: TokenVerifier;
  slack: SlackDeps;
  ingestSecret: string;
  /** Omitted by a process that does not run the Graph consent flow. */
  graph?: GraphConsentDeps;
  /** Null, the default, when no bot token is configured: cards are skipped. */
  slackSurface?: SlackSurface | null;
  /** Defaults to pg-boss over the same pool; passed in so `main` can stop it. */
  executeQueue?: ExecuteQueue;
}

/**
 * Assembles the real `SystemControl`, `LedgerReader`, `LedgerWriter`,
 * proposal reads, decision service and status source over `db`.
 */
export const createApiDeps = (options: RuntimeOptions): ApiDeps => {
  const control = new SystemControl(options.db);
  const feed = createFeed();
  const executeQueue = options.executeQueue ?? createExecuteQueue(options.db);
  const slackSurface = options.slackSurface ?? null;

  const decideDeps: DecideDeps = {
    decide: (input) => decideProposal(options.db, input),
    getProposal: (id) => getProposal(options.db, id),
    enqueueExecute: (proposalId) => executeQueue.enqueueExecute(proposalId),
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
    control,
    ledger: new LedgerReader(options.db),
    writer: new LedgerWriter(options.db),
    proposals: {
      list: (filter) => listProposals(options.db, filter),
      get: (id) => getProposal(options.db, id),
    },
    decide: (request) => applyDecision(decideDeps, request),
    enqueueExecute: (proposalId) => executeQueue.enqueueExecute(proposalId),
    commitments: createCommitmentStore(options.db),
    tasks: createTaskStore(options.db),
    briefs: createBriefStore(options.db),
    alerts: createAlertStore(options.db),
    ontology: new OntologyRepository(options.db),
    enqueueChase: (commitmentId) => executeQueue.enqueueChase(commitmentId),
    status: createDbStatusSource(options.db, control, {
      usdToGbp: options.config.cost.usdToGbp,
      timeZone: options.config.timeZone,
    }),
    auth: options.auth,
    slack: options.slack,
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
  const db = createDb();
  const executeQueue = createExecuteQueue(db);

  const tenantId = requiredEnv('ENTRA_TENANT_ID');
  const clientId = requiredEnv('ENTRA_CLIENT_ID');

  const deps = createApiDeps({
    config,
    db,
    executeQueue,
    slackSurface: slackSurfaceFromEnv(config.slack.channelId),
    auth: createEntraVerifier({
      tenantId,
      clientId,
      allowedUpn: requiredEnv('ALLOWED_UPN'),
    }),
    graph: {
      tenantId,
      clientId,
      clientSecret: readSecret('ENTRA_CLIENT_SECRET'),
      publicApiUrl: requiredEnv('PUBLIC_API_URL'),
      tokenStore: KeyVaultTokenStore.fromEnv(),
    },
    slack: {
      signingSecret: readSecret('SLACK_SIGNING_SECRET'),
      allowedUserId: process.env['SLACK_ALLOWED_USER_ID'] ?? null,
    },
    ingestSecret: readSecret('AGENT_LOG_INGEST_SECRET'),
  });

  const server = buildServer(deps);

  const shutdown = (signal: string): void => {
    server.log.info({ signal }, 'Shutting down the api');
    void server
      .close()
      .then(() => executeQueue.stop())
      .then(() => db.$client.end())
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
