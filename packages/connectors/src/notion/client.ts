import { defineConnector, fetchJson, type Connector, type ConnectorEvents } from '../core/index.js';
import type { ConnectorPolicy } from '../core/connector.js';
import type { Clock } from '../core/rateLimit.js';
import type { JsonRequest } from '../core/http.js';

/**
 * The Notion REST API version every request pins. Confirmed on
 * https://developers.notion.com/reference/versioning ("The most recent
 * Notion-Version is 2026-03-11"). Data sources arrived in 2025-09-03
 * (`/v1/data_sources/{id}/query`, page parent `{ data_source_id }`) and
 * 2026-03-11 keeps them, renames `archived` to `in_trash` and changes the
 * Append Block Children position argument, which Lance does not use.
 *
 * One constant: nothing else in the connector names a version.
 */
export const NOTION_API_VERSION = '2026-03-11';

export const NOTION_API_BASE_URL = 'https://api.notion.com/v1';

/**
 * Notion publishes 180 requests per minute, an average of three per second,
 * for connections outside Business and Enterprise plans, and asks callers to
 * honour Retry-After on a 429. Confirmed on
 * https://developers.notion.com/reference/request-limits.
 */
export const notionPolicy: ConnectorPolicy = {
  rateLimit: { capacity: 3, refillPerSecond: 3, maxWaitMs: 20_000 },
  retry: { attempts: 4, baseDelayMs: 400, maxDelayMs: 8_000 },
  breaker: { failureThreshold: 3, halfOpenAfterMs: 60_000 },
};

export interface NotionConnectorOptions {
  /**
   * The integration token. The worker reads it with
   * `readSecret('NOTION_TOKEN')` and passes it in; the connector never touches
   * the environment and never puts the token in an error or a span.
   */
  token: string;
  events?: ConnectorEvents;
  clock?: Clock;
  fetchImpl?: typeof fetch;
}

export interface NotionRequest {
  method?: 'GET' | 'POST' | 'PATCH';
  body?: unknown;
  query?: Record<string, string>;
}

export interface NotionConnector {
  /** The framework connector: rate limit, retry, breaker and span per call. */
  readonly connector: Connector;
  /**
   * One authorised request. Callers wrap it in `connector.read` or
   * `connector.write`; it does no wrapping itself, so paging takes one token
   * per page rather than one per run.
   */
  send(operation: string, path: string, request?: NotionRequest): Promise<unknown>;
}

function buildUrl(path: string, query: Record<string, string> | undefined): string {
  const url = new URL(`${NOTION_API_BASE_URL}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

/**
 * Builds the Notion connector. Reads and writes in `reads.ts` and `writes.ts`
 * take the result as their first argument.
 */
export function createNotionConnector(options: NotionConnectorOptions): NotionConnector {
  const connectorOptions = {
    name: 'notion' as const,
    policy: notionPolicy,
    ...(options.events === undefined ? {} : { events: options.events }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  };
  const connector = defineConnector(connectorOptions);

  const send = async (
    operation: string,
    path: string,
    request: NotionRequest = {},
  ): Promise<unknown> => {
    const init: JsonRequest = {
      method: request.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${options.token}`,
        'Notion-Version': NOTION_API_VERSION,
      },
    };
    if (request.body !== undefined) init.body = request.body;
    const response = await fetchJson<unknown>(
      'notion',
      operation,
      buildUrl(path, request.query),
      init,
      options.fetchImpl,
    );
    return response.body;
  };

  return { connector, send };
}

/**
 * The Notion app URL for a page id. Notion's comment endpoint returns no URL,
 * so a comment write reports the page it landed on instead.
 */
export function notionPageUrl(pageId: string): string {
  return `https://www.notion.so/${pageId.replace(/-/g, '')}`;
}
