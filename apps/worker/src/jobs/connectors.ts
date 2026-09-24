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
  InMemoryTokenStore,
  KeyVaultTokenStore,
  slackReads,
  type AppInsightsClient,
  type GraphReads,
  type JamieReads,
  type NotionConnector,
  type SlackSurface,
} from '@lance/connectors';
import type { Db, Principal } from '@lance/db';
import { readSecret, type Config } from '@lance/shared';
import { raiseAlert } from '../alerts/raise.js';
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
}

/** What the agent-logs watcher reads: Lance's own channel and, when configured, telemetry. */
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
  /** Lance's own Slack channel for this principal: cards, briefs and alerts post here. */
  slack: SlackSurface | null;
  agentLogs: AgentLogsSource | null;
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

const env = (name: string): string | undefined => {
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
};

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
        actor: ACTOR,
      });
    },
  });
  const graph = createGraphConnector({ accessToken, events: { onOpen: breakerAlert(db) } });
  const reads = createGraphReads(graph);
  return { reads, writers: graphExecutionWriters(graph, reads) };
}

function buildNotion(config: Config, db: Db): NotionBundle | null {
  if (env('NOTION_TOKEN') === undefined) return null;
  const connector = createNotionConnector({
    token: readSecret('NOTION_TOKEN'),
    events: { onOpen: breakerAlert(db) },
  });
  return { connector, writers: notionExecutionWriters(connector, config) };
}

/** Jamie is optional at boot: without JAMIE_API_KEY the worker runs everything else (ADR 0005). */
function buildJamie(db: Db): JamieReads | null {
  if (env('JAMIE_API_KEY') === undefined) return null;
  return createJamieReads(
    createJamieConnector({
      apiKey: readSecret('JAMIE_API_KEY'),
      events: { onOpen: breakerAlert(db) },
    }),
  );
}

function buildSlack(config: Config): SlackSurface | null {
  if (env('SLACK_BOT_TOKEN') === undefined) return null;
  return createSlackSurface({
    token: readSecret('SLACK_BOT_TOKEN'),
    channelId: config.slack.channelId,
  });
}

/**
 * The agent-logs watcher skips Lance's own posts; the bot's identity comes
 * from the token itself rather than from configuration that could drift.
 * When Slack will not say who we are, the watcher stays off and the
 * principal hears why, rather than the whole worker failing.
 */
async function buildAgentLogs(config: Config, db: Db): Promise<AgentLogsSource | null> {
  if (env('SLACK_BOT_TOKEN') === undefined) return null;
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
    channelId: config.slack.channelId,
    ownBotUserId: self.userId,
    ownBotId: self.botId,
    appInsights: workspaceId === undefined ? null : createAppInsightsClient({ workspaceId }),
  };
}

/**
 * Connectors by principal while there is one set of credentials, Dom's.
 * The principal whose UPN matches `config.dom.email` gets them; anyone else
 * gets null, so no other principal's job ever reads Dom's mailbox or posts
 * in his channel. Package 5.2 replaces this lookup with credentials per
 * principal (ADR 0022).
 */
export function singleOwnerConnectors(config: Config): ConnectorLookup {
  return async (principal, db) => {
    if (principal.upn.toLowerCase() !== config.dom.email.toLowerCase()) return null;
    return {
      graph: buildGraph(db),
      notion: buildNotion(config, db),
      jamie: buildJamie(db),
      slack: buildSlack(config),
      agentLogs: await buildAgentLogs(config, db),
    };
  };
}
