import { DefaultAzureCredential, type TokenCredential } from '@azure/identity';
import { z } from 'zod';
import {
  ConnectorError,
  defineConnector,
  fetchJson,
  systemClock,
  type Clock,
  type Connector,
  type ConnectorEvents,
  type ConnectorPolicy,
} from '../core/index.js';

/**
 * The Application Insights query client (spec 7.1, `agent-logs` telemetry
 * stream): one read-only call against the Log Analytics query REST API, so
 * the watcher can see Lance's own failed spans and skipped steps.
 *
 * Read-only by construction. There is no writes module and no entry in
 * `@lance/connectors/writes`: the API has a write surface for custom logs
 * and it is never wrapped (non-negotiable 2 and 3). Nothing here logs a
 * query result: rows carry span attributes, and the ledger is the one
 * place they land.
 */

export const LOG_ANALYTICS_BASE_URL = 'https://api.loganalytics.io/v1';

/** The token audience for the query API. Managed identity in Azure, the Azure CLI login locally. */
export const LOG_ANALYTICS_SCOPE = 'https://api.loganalytics.io/.default';

/** Where one workspace answers queries. */
export function logAnalyticsQueryUrl(workspaceId: string): string {
  return `${LOG_ANALYTICS_BASE_URL}/workspaces/${encodeURIComponent(workspaceId)}/query`;
}

/**
 * Log Analytics allows 200 queries in 30 seconds per user and answers a 429
 * with Retry-After. The agent-logs watcher runs one query every five
 * minutes, so a burst of three refilling at one every two seconds leaves
 * the ceiling untouched while still letting a manual backfill through.
 */
export const appInsightsPolicy: ConnectorPolicy = {
  rateLimit: { capacity: 3, refillPerSecond: 0.5, maxWaitMs: 20_000 },
  retry: { attempts: 3, baseDelayMs: 500, maxDelayMs: 8_000 },
  breaker: { failureThreshold: 3, halfOpenAfterMs: 60_000 },
};

const columnSchema = z.looseObject({ name: z.string(), type: z.string().optional() });

const tableSchema = z.looseObject({
  name: z.string().optional(),
  columns: z.array(columnSchema),
  rows: z.array(z.array(z.unknown())),
});

/** The query API's reply: a list of tables, each with its columns and its rows. */
export const appInsightsQueryResponseSchema = z.looseObject({ tables: z.array(tableSchema) });
export type AppInsightsQueryResponse = z.infer<typeof appInsightsQueryResponseSchema>;

/** One row of the first table, its cells keyed by column name. */
export type AppInsightsRow = Record<string, unknown>;

/**
 * Turns the column and row arrays of the first table into objects. The
 * query API sends columns once and rows as bare arrays, which is compact on
 * the wire and unreadable everywhere else.
 */
export function rowsFromResponse(response: AppInsightsQueryResponse): AppInsightsRow[] {
  const table = response.tables[0];
  if (table === undefined) return [];
  const names = table.columns.map((column) => column.name);
  return table.rows.map((cells) => {
    const row: AppInsightsRow = {};
    names.forEach((name, index) => {
      row[name] = cells[index] ?? null;
    });
    return row;
  });
}

export interface AppInsightsClientOptions {
  /**
   * The Log Analytics workspace the Application Insights resource is backed
   * by, `LOG_ANALYTICS_WORKSPACE_ID`. It is an identifier, not a secret.
   */
  workspaceId: string;
  /** Defaults to `DefaultAzureCredential`: managed identity in Azure, the Azure CLI login locally. */
  credential?: TokenCredential;
  fetchImpl?: typeof fetch;
  clock?: Clock;
  events?: ConnectorEvents;
}

export interface AppInsightsQueryRequest {
  /** The KQL to run. It is hashed into the span, never logged. */
  query: string;
  /** ISO 8601 duration or interval, for example `PT10M` or `<start>/<end>`. */
  timespan?: string;
}

export interface AppInsightsClient {
  /** The framework connector: rate limit, retry, breaker and span per call. */
  readonly connector: Connector;
  readonly workspaceId: string;
  /** One query, wrapped and parsed into rows. Reads only. */
  query(operation: string, request: AppInsightsQueryRequest): Promise<AppInsightsRow[]>;
}

/** Builds the client. The caller owns the workspace id; nothing here reads the environment. */
export function createAppInsightsClient(options: AppInsightsClientOptions): AppInsightsClient {
  const clock = options.clock ?? systemClock;
  const connector = defineConnector({
    name: 'appinsights',
    policy: appInsightsPolicy,
    ...(options.events === undefined ? {} : { events: options.events }),
    ...(options.clock === undefined ? {} : { clock }),
  });
  const fetchImpl = options.fetchImpl ?? fetch;
  let credential = options.credential;

  const bearer = async (operation: string): Promise<string> => {
    credential ??= new DefaultAzureCredential();
    const token = await credential.getToken(LOG_ANALYTICS_SCOPE);
    if (token === null || token.token === '') {
      throw new ConnectorError(
        `appinsights ${operation}: no token for ${LOG_ANALYTICS_SCOPE}. Grant the worker's managed identity the Log Analytics Reader role on the workspace, or run az login locally.`,
        { connector: 'appinsights', operation, retryable: false },
      );
    }
    return token.token;
  };

  return {
    connector,
    workspaceId: options.workspaceId,
    query: (operation, request) =>
      connector.read(
        operation,
        { request: { workspaceId: options.workspaceId, query: request.query } },
        async () => {
          const token = await bearer(operation);
          const response = await fetchJson<unknown>(
            'appinsights',
            operation,
            logAnalyticsQueryUrl(options.workspaceId),
            {
              method: 'POST',
              headers: { authorization: `Bearer ${token}` },
              body: {
                query: request.query,
                ...(request.timespan === undefined ? {} : { timespan: request.timespan }),
              },
            },
            fetchImpl,
          );
          const parsed = appInsightsQueryResponseSchema.safeParse(response.body);
          if (!parsed.success) {
            // The issue paths name columns, never cell values: a result body
            // never reaches an error message or a log.
            throw new ConnectorError(
              `appinsights ${operation}: the reply was not a query result with tables, columns and rows. Check the KQL and the workspace id.`,
              {
                connector: 'appinsights',
                operation,
                status: response.status,
                retryable: false,
              },
            );
          }
          return rowsFromResponse(parsed.data);
        },
      ),
  };
}
