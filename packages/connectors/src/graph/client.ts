import type { z } from 'zod';
import {
  ConnectorError,
  defineConnector,
  fetchJson,
  type Clock,
  type Connector,
  type ConnectorEvents,
  type ConnectorPolicy,
  type JsonRequest,
} from '../core/index.js';
import type { AccessTokenProvider } from './accessToken.js';

/**
 * The Graph connector: `defineConnector` (rate limit, retry, circuit
 * breaker, OTel span) plus a bearer header and a Zod parse on every
 * response. Read and write functions live in `reads.ts` and `writes.ts`
 * and go through the two methods here, so there is one place where a
 * Graph request is built and one place where its response is validated.
 */

export const GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0';

/**
 * Graph throttles per mailbox on a rolling window and answers 429 with a
 * Retry-After the retry policy honours. Twenty calls of burst at ten per
 * second sits well inside that while letting a delta page loop run at
 * speed; three consecutive failures trip the breaker, which spec 7.1
 * requires for a watcher partition.
 */
export const GRAPH_POLICY: ConnectorPolicy = {
  rateLimit: { capacity: 20, refillPerSecond: 10, maxWaitMs: 15_000 },
  retry: { attempts: 4, baseDelayMs: 500, maxDelayMs: 8_000 },
  breaker: { failureThreshold: 3, halfOpenAfterMs: 60_000 },
};

export interface GraphRequest {
  method?: 'GET' | 'POST' | 'PATCH';
  body?: unknown;
  headers?: Record<string, string>;
}

export interface GraphConnectorOptions {
  accessToken: AccessTokenProvider;
  events?: ConnectorEvents;
  clock?: Clock;
  fetchImpl?: typeof fetch;
}

export interface GraphConnector {
  /** The framework wrapper, for breaker state on the Agents page. */
  readonly connector: Connector;
  read<T>(operation: string, url: string, schema: z.ZodType<T>, request?: GraphRequest): Promise<T>;
  write<T>(
    operation: string,
    url: string,
    schema: z.ZodType<T>,
    request?: GraphRequest,
  ): Promise<T>;
}

/**
 * The path alone, for the span's request hash. A delta link carries its
 * token in the query string, and a message URL carries an id; neither
 * belongs in a hashed attribute that is meant to identify the shape of a
 * call, not its contents.
 */
function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

export function createGraphConnector(options: GraphConnectorOptions): GraphConnector {
  const connector = defineConnector({
    name: 'graph',
    policy: GRAPH_POLICY,
    ...(options.events === undefined ? {} : { events: options.events }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
  const fetchImpl = options.fetchImpl;

  const send = async <T>(
    kind: 'read' | 'write',
    operation: string,
    url: string,
    schema: z.ZodType<T>,
    request: GraphRequest,
  ): Promise<T> => {
    const run = async (): Promise<T> => {
      const bearer = await options.accessToken();
      const jsonRequest: JsonRequest = {
        method: request.method ?? 'GET',
        headers: { authorization: `Bearer ${bearer}`, ...request.headers },
        ...(request.body === undefined ? {} : { body: request.body }),
      };
      const response = await fetchJson<unknown>(
        'graph',
        operation,
        url,
        jsonRequest,
        fetchImpl ?? fetch,
      );
      const parsed = schema.safeParse(response.body);
      if (!parsed.success) {
        throw new ConnectorError(
          `graph ${operation}: the response did not match the expected shape at ${parsed.error.issues.map((issue) => issue.path.join('.') || '(root)').join(', ')}. Microsoft Graph may have changed the resource; update the schema in packages/connectors/src/graph/types.ts.`,
          { connector: 'graph', operation, status: response.status, retryable: false },
        );
      }
      return parsed.data;
    };

    const context = { request: { method: request.method ?? 'GET', path: pathOf(url) } };
    return kind === 'read'
      ? connector.read(operation, context, run)
      : connector.write(operation, context, run);
  };

  return {
    connector,
    read: (operation, url, schema, request = {}) => send('read', operation, url, schema, request),
    write: (operation, url, schema, request = {}) => send('write', operation, url, schema, request),
  };
}
