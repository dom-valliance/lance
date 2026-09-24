import {
  createAccessTokenProvider,
  createAppInsightsClient,
  createGraphConnector,
  createGraphReads,
  createJamieConnector,
  createJamieReads,
  createNotionConnector,
  createSlackClient,
  createSlackSurface,
  graphRefreshTokenSecretName,
  InMemoryTokenStore,
  listUsers,
  PrincipalTokenStore,
  resolveNotionUserId,
  slackReads,
  type AppInsightsClient,
  type GraphReads,
  type GraphTokenStore,
  type JamieReads,
  type NotionConnector,
  type NotionUserSummary,
  type RotationLock,
  type SecretReader,
  type SecretStore,
  type SlackSurface,
} from '@lance/connectors';
import {
  credentialRotationLockKey,
  principals,
  withAdvisoryLock,
  type Db,
  type Principal,
} from '@lance/db';
import { LedgerWriter } from '@lance/ledger';
import {
  deliveryChannelFor,
  newUlid,
  nowIso,
  principalSecretName,
  readSecret,
  type Config,
} from '@lance/shared';
import { and, eq, isNull } from 'drizzle-orm';
import { raiseAlert } from '../alerts/raise.js';
import { legacyGraphToken, legacyJamieKey, readOrCopy } from '../credentials/legacy.js';
import type { ExecutionWriters } from '../executor/dispatch.js';
import { graphExecutionWriters, notionExecutionWriters } from '../executor/writers.js';
import type { SlackHistoryReads } from '../watchers/agent-logs/index.js';

/**
 * The external systems one principal's jobs reach (docs/plans/multi-user.md
 * M2). Every part is optional: a process without Jamie's key runs everything
 * else, exactly as before.
 */
export interface GraphBundle {
  reads: GraphReads;
  writers: NonNullable<ExecutionWriters['graph']>;
}

export interface NotionBundle {
  connector: NotionConnector;
  writers: NonNullable<ExecutionWriters['notion']>;
  /**
   * `principals.notion_user_id` after resolution: whose rows in the shared
   * All Tasks database are the principal's, and who a new task is assigned
   * to. Null while no Notion user matches the principal's email.
   */
  principalUserId: string | null;
}

/**
 * A connector the principal has not connected: the secret it needs is
 * absent from the principal vault. Their watchers for it record a skipped
 * run naming `missing`, and none polls with anyone else's credentials.
 */
export interface NotConnected {
  connector: 'graph' | 'jamie';
  /** The secret that is absent, by name. Never a value. */
  missing: string;
  /** True once the secret exists, so the worker can rebuild the principal's connectors. */
  recheck: () => Promise<boolean>;
}

/** What the agent-logs watcher reads: the principal's own channel and, when configured, telemetry. */
export interface AgentLogsSource {
  slack: SlackHistoryReads;
  channelId: string;
  ownBotUserId: string;
  ownBotId: string | null;
  appInsights: AppInsightsClient | null;
}

export interface ConnectorBundle {
  graph: GraphBundle | null;
  notion: NotionBundle | null;
  jamie: JamieReads | null;
  /**
   * The principal's own Slack channel (ADR 0023): cards, alerts, briefs,
   * digests and job output post here. Null when there is no bot token or
   * the principal has no channel yet.
   */
  slack: SlackSurface | null;
  agentLogs: AgentLogsSource | null;
  /** The per-principal connectors that are missing their secret. */
  notConnected: NotConnected[];
}

/**
 * Looks up a principal's connectors, with `db` scoped to them so a breaker
 * or token alert lands in their own alerts. Null means the principal has
 * none, and their watchers skip rather than poll with someone else's
 * credentials.
 */
export type ConnectorLookup = (principal: Principal, db: Db) => Promise<ConnectorBundle | null>;

export const WORKER_VERSION = '0.1.0';
const ACTOR = `agent:worker@${WORKER_VERSION}`;

const envValue = (env: NodeJS.ProcessEnv, name: string): string | undefined => {
  const value = env[name];
  return value === undefined || value === '' ? undefined : value;
};
const env = (name: string): string | undefined => envValue(process.env, name);

const breakerAlert =
  (db: Db) =>
  async (connector: string, error: unknown): Promise<void> => {
    await raiseAlert(db, {
      kind: 'breaker_open',
      severity: 'P1',
      dedupeKey: `breaker:${connector}`,
      title: `${connector} circuit breaker opened`,
      body: error instanceof Error ? error.message : String(error),
      actor: ACTOR,
    });
  };

/** Where the worker finds credentials, and what it reads them with. */
export interface PrincipalConnectorOptions {
  config: Config;
  /** Unscoped handle, for the rotation advisory locks. */
  root: Db;
  /**
   * The principal vault (`PRINCIPAL_KEY_VAULT_URL`). Null in a local run
   * without Azure, where the principal whose UPN is `config.dom.email`
   * uses `GRAPH_REFRESH_TOKEN` and `JAMIE_API_KEY` from the environment
   * and nobody else is connected.
   */
  principalVault: SecretStore | null;
  /** The static vault (`KEY_VAULT_URL`), for the one-time copy of Dom's legacy Graph token. */
  staticVault: SecretReader | null;
  env?: NodeJS.ProcessEnv;
  /** The Notion workspace users; defaults to `listUsers` over the organisation integration. */
  listNotionUsers?: (connector: NotionConnector) => Promise<readonly NotionUserSummary[]>;
}

type Built<T> =
  | { status: 'connected'; value: T }
  | { status: 'not_connected'; notConnected: NotConnected }
  | null;

const notConnected = (
  connector: NotConnected['connector'],
  missing: string,
  vault: SecretReader,
): Built<never> => ({
  status: 'not_connected',
  notConnected: {
    connector,
    missing,
    recheck: async () => (await vault.get(missing)) !== null,
  },
});

/**
 * The principal's Graph connector over their own refresh token. Rotation
 * takes a Postgres advisory lock on (principal, graph) for the read, the
 * refresh and the write, so two worker replicas never redeem one token.
 * Null when the process has no Entra app credentials at all.
 */
async function buildGraph(
  options: PrincipalConnectorOptions,
  principal: Principal,
  db: Db,
  isOwner: boolean,
): Promise<Built<GraphBundle>> {
  const env = options.env ?? process.env;
  const tenantId = envValue(env, 'ENTRA_TENANT_ID');
  const clientId = envValue(env, 'ENTRA_CLIENT_ID');
  if (
    tenantId === undefined ||
    clientId === undefined ||
    envValue(env, 'ENTRA_CLIENT_SECRET') === undefined
  )
    return null;

  let store: GraphTokenStore;
  let rotationLock: RotationLock | undefined;
  const vault = options.principalVault;
  if (vault === null) {
    if (!isOwner) return null;
    store = InMemoryTokenStore.fromEnv(env);
  } else {
    const name = graphRefreshTokenSecretName(principal.id);
    const own = new PrincipalTokenStore(vault, principal.id);
    const legacy = isOwner ? legacyGraphToken(options.staticVault) : null;
    store = {
      // The copy runs inside the rotation lock, like every other read, so
      // it can never land over a token another replica has just rotated.
      getRefreshToken: () => readOrCopy({ vault, db, actor: ACTOR }, name, legacy),
      setRefreshToken: (token) => own.setRefreshToken(token),
    };
    const lock = graphRotationLock(options.root, principal.id);
    rotationLock = lock;
    if ((await lock(() => store.getRefreshToken())) === null) {
      return notConnected('graph', name, vault);
    }
  }

  const accessToken = createAccessTokenProvider({
    store,
    tenantId,
    clientId,
    clientSecret: readSecret('ENTRA_CLIENT_SECRET', env),
    ...(rotationLock === undefined ? {} : { rotationLock }),
    notConnectedMessage: `graph token: ${principal.upn} has no Microsoft Graph refresh token stored. They connect Microsoft 365 from Settings (/auth/graph/connect); see docs/runbooks/entra-setup.md section 7.`,
    onRefreshFailed: async (error) => {
      await raiseAlert(db, {
        kind: 'token_refresh_failed',
        severity: 'P0',
        dedupeKey: 'token:graph',
        title: 'Graph refresh token was refused',
        body: `${error.message} Re-run the delegated consent in docs/runbooks/entra-setup.md section 7.`,
        actor: ACTOR,
      });
    },
  });
  const graph = createGraphConnector({ accessToken, events: { onOpen: breakerAlert(db) } });
  const reads = createGraphReads(graph);
  return { status: 'connected', value: { reads, writers: graphExecutionWriters(graph, reads) } };
}

/**
 * The advisory lock every worker replica takes for one principal's Graph
 * token rotation, keyed on (principal, connector).
 */
export function graphRotationLock(root: Db, principalId: string): RotationLock {
  return (work) => withAdvisoryLock(root, credentialRotationLockKey('graph', principalId), work);
}

/** Stores a resolved Notion user id on the principal's own row, once, and records it. */
async function savePrincipalNotionUserId(
  db: Db,
  principalId: string,
  notionUserId: string,
): Promise<void> {
  const updated = await db
    .update(principals)
    .set({ notionUserId, updatedAt: new Date() })
    .where(and(eq(principals.id, principalId), isNull(principals.notionUserId)))
    .returning({ id: principals.id });
  if (updated.length === 0) return;
  await new LedgerWriter(db).append({
    ts: nowIso(),
    actor: ACTOR,
    kind: 'state_changed',
    sourceSystem: 'notion',
    correlationId: newUlid(),
    payload: { change: 'notion_user_resolved', notionUserId },
  });
}

/**
 * Notion is one organisation integration (ADR 0022): the same token for
 * everyone, with the principal told apart by their Notion user id, which
 * is resolved from the users list by email when it is not recorded yet.
 * A failed resolution leaves the id unset and the connector running; the
 * briefs then list no Notion task and triage proposes none.
 */
async function buildNotion(
  options: PrincipalConnectorOptions,
  principal: Principal,
  db: Db,
): Promise<NotionBundle | null> {
  const env = options.env ?? process.env;
  if (envValue(env, 'NOTION_TOKEN') === undefined) return null;
  const connector = createNotionConnector({
    token: readSecret('NOTION_TOKEN', env),
    events: { onOpen: breakerAlert(db) },
  });
  const list = options.listNotionUsers ?? ((notion: NotionConnector) => listUsers(notion));
  let principalUserId: string | null = null;
  try {
    const resolution = await resolveNotionUserId({
      email: principal.upn,
      current: principal.notionUserId,
      listUsers: () => list(connector),
      save: (notionUserId) => savePrincipalNotionUserId(db, principal.id, notionUserId),
    });
    if (resolution.status === 'known' || resolution.status === 'resolved') {
      principalUserId = resolution.notionUserId;
    } else {
      console.warn(
        { principalId: principal.id, upn: principal.upn, resolution: resolution.status },
        "no single Notion user has this principal's email; their Notion tasks stay unassigned until an admin sets principals.notion_user_id",
      );
    }
  } catch (error) {
    console.warn(
      { err: error, principalId: principal.id },
      "the Notion users list could not be read; the principal's Notion user id stays unresolved until the next start",
    );
  }
  return {
    connector,
    writers: notionExecutionWriters(connector, options.config),
    principalUserId,
  };
}

/**
 * The principal's Jamie key, `jamie-api-key--<principalId>`, stored by the
 * api after a test call (ADR 0022, 0005). Jamie is read-only, so the key is
 * read once when the connectors are built.
 */
async function buildJamie(
  options: PrincipalConnectorOptions,
  principal: Principal,
  db: Db,
  isOwner: boolean,
): Promise<Built<JamieReads>> {
  const env = options.env ?? process.env;
  const vault = options.principalVault;
  let apiKey: string | null;
  if (vault === null) {
    if (!isOwner || envValue(env, 'JAMIE_API_KEY') === undefined) return null;
    apiKey = readSecret('JAMIE_API_KEY', env);
  } else {
    const name = principalSecretName('jamie-api-key', principal.id);
    apiKey = await readOrCopy(
      { vault, db, actor: ACTOR },
      name,
      isOwner ? legacyJamieKey(env) : null,
    );
    if (apiKey === null) return notConnected('jamie', name, vault);
  }
  return {
    status: 'connected',
    value: createJamieReads(createJamieConnector({ apiKey, events: { onOpen: breakerAlert(db) } })),
  };
}

/**
 * The principal's surface, pinned to their channel as the principal row
 * records it (ADR 0023), and to Dom's `dom-claude-agent` for Dom until his
 * link does. A principal with no channel gets no surface, so nothing of
 * theirs is ever posted where someone else reads it.
 */
export function principalSlackSurface(config: Config, principal: Principal): SlackSurface | null {
  if (env('SLACK_BOT_TOKEN') === undefined) return null;
  const channelId = deliveryChannelFor(principal, config);
  if (channelId === null) return null;
  return createSlackSurface({ token: readSecret('SLACK_BOT_TOKEN'), channelId });
}

/**
 * The agent-logs watcher skips Lance's own posts; the bot's identity comes
 * from the token itself rather than from configuration that could drift.
 * When Slack will not say who we are, the watcher stays off and the
 * principal hears why, rather than the whole worker failing.
 */
async function buildAgentLogs(
  config: Config,
  principal: Principal,
  db: Db,
): Promise<AgentLogsSource | null> {
  if (env('SLACK_BOT_TOKEN') === undefined) return null;
  // Each principal's channel history is read the same way (ADR 0023).
  const channelId = deliveryChannelFor(principal, config);
  if (channelId === null) return null;
  const reads = slackReads(createSlackClient({ token: readSecret('SLACK_BOT_TOKEN') }));
  const self = await reads.authTest().catch(async (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    await raiseAlert(db, {
      kind: 'watcher_failed',
      severity: 'P1',
      dedupeKey: 'watcher:agent-logs:identity',
      title: 'Agent-logs watcher did not start',
      body: `Slack auth.test failed: ${message} Check the bot token in Key Vault and restart the worker.`,
      actor: ACTOR,
    });
    return null;
  });
  if (self === null) return null;
  const workspaceId = env('LOG_ANALYTICS_WORKSPACE_ID');
  return {
    slack: reads,
    channelId,
    ownBotUserId: self.userId,
    ownBotId: self.botId,
    appInsights: workspaceId === undefined ? null : createAppInsightsClient({ workspaceId }),
  };
}

/** Which connector each per-principal watcher needs, for the skipped-run record. */
export function connectorOfWatcher(
  slug: string,
): NotConnected['connector'] | 'notion' | 'slack' | null {
  if (slug.startsWith('watcher-graph-')) return 'graph';
  if (slug === 'watcher-jamie') return 'jamie';
  if (slug === 'watcher-notion') return 'notion';
  if (slug === 'watcher-agent-logs') return 'slack';
  return null;
}

/**
 * Each principal's connectors from their own credentials (ADR 0022,
 * docs/plans/multi-user.md M2). Graph and Jamie read the principal's own
 * secrets in the principal vault and are reported as not connected when
 * a secret is absent. Notion is the organisation integration, filtered to
 * the principal. On first use for the principal whose UPN is
 * `config.dom.email`, Dom's pre-ADR 0022 Graph token and Jamie key are
 * copied into his own secrets (credentials/legacy.ts).
 *
 * The Slack surface and the agent-logs source post to and read the
 * principal's own channel (`deliveryChannelFor`, ADR 0023).
 */
export function principalConnectors(options: PrincipalConnectorOptions): ConnectorLookup {
  const { config } = options;
  return async (principal, db) => {
    const isOwner = principal.upn.toLowerCase() === config.dom.email.toLowerCase();
    const graph = await buildGraph(options, principal, db, isOwner);
    const jamie = await buildJamie(options, principal, db, isOwner);
    const missing: NotConnected[] = [];
    for (const built of [graph, jamie]) {
      if (built?.status === 'not_connected') missing.push(built.notConnected);
    }
    return {
      graph: graph?.status === 'connected' ? graph.value : null,
      notion: await buildNotion(options, principal, db),
      jamie: jamie?.status === 'connected' ? jamie.value : null,
      slack: principalSlackSurface(config, principal),
      agentLogs: await buildAgentLogs(config, principal, db),
      notConnected: missing,
    };
  };
}
