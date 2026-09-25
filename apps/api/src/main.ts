import {
  checkAccess,
  createJamieConnector,
  createSlackChannelProvisioner,
  createSlackSurface,
  principalVaultFromEnv,
  writeOnly,
  type SecretWriter,
  type SlackSurface,
} from '@lance/connectors';
import { principalTokenWriter } from '@lance/connectors/graph';
import { createDb, scopedDb, systemState, SYSTEM_STATE_ID, type Db } from '@lance/db';
import {
  countProposals,
  decideProposal,
  getProposal,
  listProposals,
  pendingProposalSummary,
  LedgerReader,
  LedgerWriter,
  raiseAlert,
  SystemControl,
} from '@lance/ledger';
import { OntologyRepository } from '@lance/ontology';
import {
  deliveryChannelFor,
  getConfig,
  principalDisplayName,
  principalSecretName,
  readSecret,
  type Config,
} from '@lance/shared';
import { initTelemetry } from '@lance/telemetry';
import { pathToFileURL } from 'node:url';
import { eq } from 'drizzle-orm';
import { actorFromUpn } from './actor.js';
import {
  createEvidenceExporter,
  evidenceSignerFromEnv,
  type EvidenceSigner,
} from './admin/evidence.js';
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
  JamieKeyDeps,
  PrincipalKey,
  ServerDeps,
  SlackDeps,
  TokenVerifier,
} from './deps.js';
import { createFeed, type Feed } from './events.js';
import { createJobsService } from './jobs/service.js';
import { createOnboardingService } from './onboarding/service.js';
import { createExecuteQueue, type ExecuteQueue } from './executeQueue.js';
import { createPrincipalDirectory } from './principals/directory.js';
import { applyDecision, type DecideDeps } from './proposals/decide.js';
import { buildServer } from './server.js';
import { createConsentStateStore } from './auth/graph-state.js';
import { currentNoticeSha256 } from './onboarding/notice.js';
import { createSlackLinks, type ChannelProvisionerLike } from './slack/links.js';
import { createReplayGuard, type ReplayGuardLike } from './slack/replay.js';
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
  /**
   * Pinned to the principal's own channel (ADR 0023). Null, the default,
   * when no bot token is configured or the principal has no channel yet:
   * card redraws and modals are then skipped and say so.
   */
  slackSurface?: SlackSurface | null;
  /** The principal's live feed; kept across rebuilds so connected clients stay subscribed. */
  feed?: Feed;
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
  const feed = options.feed ?? createFeed();
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
    raiseAlert: (input) => raiseAlert(options.db, input),
    agents: createAgentsStore(options.db),
    ontology: new OntologyRepository(
      options.db,
      { principalId: options.principal.id },
      { principalName: principalDisplayName(options.principal.upn, options.config) },
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
 * A principal whose Slack channel changed, which happens once, at their
 * first link, is built again so their surface posts to the new channel;
 * `build` is handed the feed of the earlier build, so connected clients
 * keep receiving.
 */
export const createDepsCache = (
  build: (principal: PrincipalKey, feed: Feed | undefined) => ApiDeps,
): ((principal: PrincipalKey) => ApiDeps) => {
  const cache = new Map<string, { channel: string | null; deps: ApiDeps; feed: Feed }>();
  return (principal) => {
    const cached = cache.get(principal.id);
    const channel = principal.slackChannelId;
    if (cached !== undefined && (channel === undefined || cached.channel === channel)) {
      return cached.deps;
    }
    const feed = cached?.feed ?? createFeed();
    const built = build(principal, feed);
    cache.set(principal.id, { channel: channel ?? null, deps: built, feed });
    return built;
  };
};

export interface ServerRuntimeOptions {
  config: Config;
  /** Unscoped. Each principal's stores get a handle scoped from it. */
  root: Db;
  auth: TokenVerifier;
  slack: Pick<SlackDeps, 'signingSecret' | 'fallbackUserId'>;
  ingestSecret: string;
  /** Omitted by a process that does not run the Graph consent flow. */
  graph?: GraphConsentDeps;
  /**
   * Builds the surface for one channel. Omitted, the default, when no bot
   * token is configured: cards are skipped and channels are not created.
   */
  slackSurfaceFor?: (channelId: string) => SlackSurface;
  /** Creates a principal's private channel on their first link (ADR 0023). */
  slackProvisioner?: ChannelProvisionerLike | null;
  /** `PUBLIC_WEB_URL`, where `/lance login` links point. Null leaves the command unconfigured. */
  webUrl?: string | null;
  /** Defaults to the Postgres nonce store over `root`. */
  replay?: ReplayGuardLike;
  /** Omitted by a process without the principal vault. */
  jamieKeys?: JamieKeyDeps;
  /**
   * One queue for every principal: pg-boss's tables carry no principal, so
   * every job payload names the principal it is for (ADR 0025).
   */
  executeQueue?: ExecuteQueue;
  /** Signs the evidence export (`EVIDENCE_SIGNING_KEY`); null or omitted leaves it unavailable. */
  evidenceSigner?: EvidenceSigner | null;
  /** The notice's hash; read from the file when omitted. */
  noticeSha256?: string;
}

/** Everything `buildServer` needs, over the real database. */
export const createServerDeps = (options: ServerRuntimeOptions): ServerDeps => {
  const executeQueue = options.executeQueue ?? createExecuteQueue(options.root);
  const directory = createPrincipalDirectory(options.root);
  const surfaceFor = (principal: PrincipalKey): SlackSurface | null => {
    const channel = deliveryChannelFor(
      { upn: principal.upn, slackChannelId: principal.slackChannelId ?? null },
      options.config,
    );
    return channel === null || options.slackSurfaceFor === undefined
      ? null
      : options.slackSurfaceFor(channel);
  };
  return {
    config: options.config,
    auth: options.auth,
    directory,
    depsFor: createDepsCache((principal, feed) =>
      createApiDeps({
        config: options.config,
        db: scopedDb(options.root, { principalId: principal.id }),
        principal,
        executeQueue,
        slackSurface: surfaceFor(principal),
        ...(feed === undefined ? {} : { feed }),
      }),
    ),
    admin: createAdminStore(options.root, directory, {
      usdToGbp: options.config.cost.usdToGbp,
      timeZone: options.config.timeZone,
      enqueueOffboard: (job) => executeQueue.enqueueOffboard(job),
    }),
    ...(options.evidenceSigner === undefined || options.evidenceSigner === null
      ? {}
      : {
          evidence: createEvidenceExporter({
            root: options.root,
            directory,
            signer: options.evidenceSigner,
          }),
        }),
    noticeSha256: options.noticeSha256 ?? currentNoticeSha256(),
    onboarding: createOnboardingService({
      root: options.root,
      afterActivation: (principalId) => executeQueue.enqueueReconcile(principalId),
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
    slack: {
      ...options.slack,
      links: createSlackLinks({
        root: options.root,
        config: options.config,
        signingSecret: options.slack.signingSecret,
        webUrl: options.webUrl ?? null,
        provisioner: options.slackProvisioner ?? null,
      }),
      replay: options.replay ?? createReplayGuard(options.root),
    },
    ingestSecret: options.ingestSecret,
    ...(options.graph === undefined ? {} : { graph: options.graph }),
    ...(options.jamieKeys === undefined ? {} : { jamieKeys: options.jamieKeys }),
  };
};

/**
 * Storing a principal's Jamie key (ADR 0022): a test call through the
 * read-only connector's own access check, then a write to the principal
 * vault the api can never read back.
 */
export const jamieKeyDeps = (vault: SecretWriter): JamieKeyDeps => ({
  check: async (apiKey) => {
    await checkAccess(createJamieConnector({ apiKey }));
  },
  store: (principalId, apiKey) =>
    vault.set(principalSecretName('jamie-api-key', principalId), apiKey),
});

/**
 * The bot token, or null when none is set. A local api then still answers
 * every route; only the card update, the modals and channel creation are
 * unavailable, and each says so.
 */
const slackTokenFromEnv = (): string | null => {
  const token = process.env['SLACK_BOT_TOKEN'];
  if (token === undefined || token === '') return null;
  return readSecret('SLACK_BOT_TOKEN');
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

  // The principal vault, write only (ADR 0022). Without it the consent and
  // Jamie routes answer 503 naming PRINCIPAL_KEY_VAULT_URL.
  const vault = principalVaultFromEnv();
  const principalSecrets = vault === null ? null : writeOnly(vault);
  if (principalSecrets === null) {
    console.warn(
      'PRINCIPAL_KEY_VAULT_URL is not set: Microsoft 365 consent and Jamie keys cannot be stored by this api.',
    );
  }

  // The evidence export's signing key (spec 4.4). Until it is set in the
  // static vault, the export refuses and names the secret.
  const evidenceSigner = evidenceSignerFromEnv();
  if (evidenceSigner === null) {
    console.warn(
      'EVIDENCE_SIGNING_KEY is not set: the admin evidence export is unavailable until evidence-signing-key holds an Ed25519 key.',
    );
  }

  const slackToken = slackTokenFromEnv();
  const deps = createServerDeps({
    config,
    root,
    executeQueue,
    evidenceSigner,
    ...(slackToken === null
      ? {}
      : {
          slackSurfaceFor: (channelId: string) =>
            createSlackSurface({ token: slackToken, channelId }),
          slackProvisioner: createSlackChannelProvisioner({ token: slackToken }),
        }),
    webUrl: nonEmpty(process.env['PUBLIC_WEB_URL']),
    auth: createEntraVerifier({ tenantId, clientId }),
    ...(principalSecrets === null
      ? {}
      : {
          graph: {
            tenantId,
            clientId,
            clientSecret: readSecret('ENTRA_CLIENT_SECRET'),
            publicApiUrl: requiredEnv('PUBLIC_API_URL'),
            tokenWriterFor: (principalId: string) =>
              principalTokenWriter(principalSecrets, principalId),
            states: createConsentStateStore(root),
          },
          jamieKeys: jamieKeyDeps(principalSecrets),
        }),
    slack: {
      signingSecret: readSecret('SLACK_SIGNING_SECRET'),
      // Dom's Slack id until he has linked through /lance login (ADR 0021).
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
