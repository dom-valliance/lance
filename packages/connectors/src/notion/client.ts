import {
  ConnectorError,
  defineConnector,
  fetchJson,
  type Connector,
  type ConnectorEvents,
} from '../core/index.js';
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

/** What the public `send` accepts: a GET, with query parameters at most. */
export interface NotionReadRequest {
  method?: 'GET';
  query?: Record<string, string>;
}

/**
 * What the rest of the repository may do with Notion: read, and inspect the
 * framework wrapper. `send` refuses anything but a GET, so the object cannot
 * be turned into a general-purpose writer (spec 8, non-negotiable 2).
 * `notionSendAccess` below hands the unrestricted request function to the
 * modules that need it, and no barrel re-exports it.
 */
export interface NotionConnector {
  /** The framework connector: rate limit, retry, breaker and span per call. */
  readonly connector: Connector;
  /**
   * One authorised GET. Callers wrap it in `connector.read`; it does no
   * wrapping itself, so paging takes one token per page rather than one per
   * run.
   */
  send(operation: string, path: string, request?: NotionReadRequest): Promise<unknown>;
}

/** One authorised request of any method. Package-internal. */
export type NotionSend = (
  operation: string,
  path: string,
  request?: NotionRequest,
) => Promise<unknown>;

const sendAccess = new WeakMap<NotionConnector, NotionSend>();

/**
 * The unrestricted request function, for `notion/writes.ts` and for the one
 * read Notion requires a POST for (`/data_sources/{id}/query`). Deliberately
 * absent from `notion/index.js` and from the package root.
 */
export function notionSendAccess(notion: NotionConnector): NotionSend {
  const send = sendAccess.get(notion);
  if (send === undefined) {
    throw new ConnectorError(
      'notion: this object was not built by createNotionConnector, so it carries no write capability. Pass the connector createNotionConnector returned.',
      { connector: 'notion', operation: 'notionSendAccess', retryable: false },
    );
  }
  return send;
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

  const sendAny: NotionSend = async (
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

  const send = async (
    operation: string,
    path: string,
    request: NotionReadRequest = {},
  ): Promise<unknown> => {
    const method = (request as NotionRequest).method;
    if (method !== undefined && method !== 'GET') {
      throw new ConnectorError(
        `notion ${operation}: send is read-only and refuses ${method}. Every Notion write lives in packages/connectors/src/notion/writes.ts and reaches callers through @lance/connectors/writes, which only apps/worker/src/executor may import.`,
        { connector: 'notion', operation, retryable: false },
      );
    }
    return sendAny(operation, path, { ...request, method: 'GET' });
  };

  const notion: NotionConnector = { connector, send };
  sendAccess.set(notion, sendAny);
  return notion;
}

/**
 * The Notion app URL for a page id. Notion's comment endpoint returns no URL,
 * so a comment write reports the page it landed on instead.
 */
export function notionPageUrl(pageId: string): string {
  return `https://www.notion.so/${pageId.replace(/-/g, '')}`;
}
