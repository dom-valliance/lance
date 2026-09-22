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
  type JsonRequest,
} from '../core/index.js';
import { JAMIE_API_BASE_URL } from './types.js';

/**
 * The Jamie connector (ADR 0005): `defineConnector` for the rate limit,
 * retry, circuit breaker and OTel span, plus the `x-api-key` header, the
 * tRPC input encoding and one Zod parse per reply. Reads live in `reads.ts`
 * and are the whole surface. There is no writes module: `send` takes no
 * method but GET, and `meetings.delete` and `tasks.update` are never
 * wrapped (non-negotiable 3, ADR 0005).
 */

/** Personal keys (`jk_`) read their owner's meetings through these routes. */
export const JAMIE_PERSONAL_ROUTE_PREFIX = '/v1/me';

/** The one route that is neither tRPC nor authenticated. */
export const JAMIE_HEALTH_PATH = '/health';

/** The path of one personal tRPC procedure, such as `meetings.list`. */
export function jamieProcedurePath(procedure: string): string {
  return `${JAMIE_PERSONAL_ROUTE_PREFIX}/${procedure}`;
}

/** Said by every error that a key cannot reach the personal routes. */
export const JAMIE_KEY_ADVICE =
  'Create a personal read key in Jamie under Settings, Developers, API Keys, and store it in Key Vault as JAMIE_API_KEY.';

/**
 * Jamie allows 100 requests a minute per personal key and answers a 429
 * with `X-RateLimit-Reset`. Ten of burst refilling at one a second is 60 a
 * minute, comfortably under that ceiling, so the fifteen minute watcher
 * tick and a meeting backfill can overlap without either being throttled,
 * and a burst of ten covers one page of meetings plus the transcript reads
 * it triggers. Transcript replies are tens of kilobytes, so a sustained
 * rate of one a second is never the bottleneck.
 */
export const jamiePolicy: ConnectorPolicy = {
  rateLimit: { capacity: 10, refillPerSecond: 1, maxWaitMs: 20_000 },
  retry: { attempts: 4, baseDelayMs: 500, maxDelayMs: 8_000 },
  breaker: { failureThreshold: 3, halfOpenAfterMs: 60_000 },
};

export interface JamieConnectorOptions {
  /**
   * The personal API key, prefixed `jk_`. The worker reads it with
   * `readSecret('JAMIE_API_KEY')` and passes it in; the connector never
   * touches the environment and never puts the key in an error or a span.
   */
  apiKey: string;
  events?: ConnectorEvents;
  clock?: Clock;
  fetchImpl?: typeof fetch;
}

export interface JamieReadRequest {
  /** GET is the only method Jamie's read surface has; `send` refuses the rest. */
  method?: 'GET';
  /**
   * The tRPC input, sent as `?input={"json":{...}}`. Left undefined the
   * query parameter is omitted entirely, which is what a procedure without
   * an input, `tags.list`, expects.
   */
  input?: Record<string, unknown>;
  /**
   * `trpc`, the default, sends the key and unwraps
   * `{ result: { data: { json } } }`. `plain` is for `/health`, the one
   * route that is neither tRPC nor authenticated: it answers a bare body
   * and takes no key, so a health check tells an outage apart from a key
   * the API refuses.
   */
  route?: 'trpc' | 'plain';
}

/**
 * What the rest of the repository may do with Jamie: read, and inspect the
 * framework wrapper. There is no write half to hand out, unlike Graph and
 * Notion, so no access map and no `writes.ts` (ADR 0005).
 */
export interface JamieConnector {
  /** The framework connector: rate limit, retry, breaker and span per call. */
  readonly connector: Connector;
  /**
   * One authorised GET, unwrapped and validated. Callers wrap it in
   * `connector.read`; it does no wrapping itself, so paging takes one token
   * per page rather than one per run.
   */
  send<T>(
    operation: string,
    path: string,
    schema: z.ZodType<T>,
    request?: JamieReadRequest,
  ): Promise<T>;
}

/** Every reply from a tRPC procedure. The payload sits under `result.data.json`. */
const trpcEnvelopeSchema = z.looseObject({
  result: z.looseObject({ data: z.looseObject({ json: z.unknown() }) }),
});

/** What an untyped caller might pass. `send` refuses everything but a GET. */
interface UncheckedRequest {
  method?: string;
}

const RATE_LIMIT_RESET_HEADER = 'x-ratelimit-reset';
const MIN_RETRY_AFTER_SECONDS = 1;
const MAX_RETRY_AFTER_SECONDS = 60;

/**
 * Jamie sends `X-RateLimit-Reset`, a Unix second, and not always a
 * Retry-After. `fetchJson` honours Retry-After alone, so a 429 that carries
 * only the reset time gets one synthesised from it, clamped to between one
 * and sixty seconds: a clock skewed backwards would otherwise ask the
 * retry loop to sleep for hours, and a reset already past would have it
 * hammer the limit again. The 429 body is discarded with the rest of the
 * error bodies, since `fetchJson` never reads one.
 */
function withRateLimitReset(fetchImpl: typeof fetch, clock: Clock): typeof fetch {
  return async (input, init) => {
    const response = await fetchImpl(input, init);
    if (response.status !== 429 || response.headers.has('retry-after')) return response;
    const reset = response.headers.get(RATE_LIMIT_RESET_HEADER);
    if (reset === null) return response;
    const resetSeconds = Number(reset);
    if (!Number.isFinite(resetSeconds)) return response;
    const wait = Math.ceil((resetSeconds * 1000 - clock.now()) / 1000);
    const headers = new Headers(response.headers);
    headers.set(
      'retry-after',
      String(Math.min(MAX_RETRY_AFTER_SECONDS, Math.max(MIN_RETRY_AFTER_SECONDS, wait))),
    );
    return new Response(null, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
}

function buildUrl(path: string, input: Record<string, unknown> | undefined): string {
  const url = new URL(`${JAMIE_API_BASE_URL}${path}`);
  if (input !== undefined) url.searchParams.set('input', JSON.stringify({ json: input }));
  return url.toString();
}

function issuePaths(issues: readonly { readonly path: readonly PropertyKey[] }[]): string {
  return issues.map((issue) => issue.path.map(String).join('.') || '(root)').join(', ');
}

function shapeError(operation: string, status: number, at: string, what: string): ConnectorError {
  return new ConnectorError(
    `jamie ${operation}: ${what} at ${at}. Jamie may have changed the procedure; update the schemas in packages/connectors/src/jamie/types.ts.`,
    { connector: 'jamie', operation, status, retryable: false },
  );
}

/**
 * Builds the Jamie connector. The reads in `reads.ts` take the result as
 * their first argument.
 */
export function createJamieConnector(options: JamieConnectorOptions): JamieConnector {
  const clock = options.clock ?? systemClock;
  const connector = defineConnector({
    name: 'jamie',
    policy: jamiePolicy,
    ...(options.events === undefined ? {} : { events: options.events }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
  const fetchImpl = withRateLimitReset(options.fetchImpl ?? fetch, clock);

  const send = async <T>(
    operation: string,
    path: string,
    schema: z.ZodType<T>,
    request: JamieReadRequest = {},
  ): Promise<T> => {
    const method = (request as UncheckedRequest).method;
    if (method !== undefined && method !== 'GET') {
      throw new ConnectorError(
        `jamie ${operation}: send is read-only and refuses ${method}. Jamie has no write connector and no writes entry point: ADR 0005 keeps the integration read-only, so meetings.delete and tasks.update are never wrapped.`,
        { connector: 'jamie', operation, retryable: false },
      );
    }
    const plain = request.route === 'plain';
    const init: JsonRequest = {
      method: 'GET',
      ...(plain ? {} : { headers: { 'x-api-key': options.apiKey } }),
    };
    const response = await fetchJson<unknown>(
      'jamie',
      operation,
      buildUrl(path, request.input),
      init,
      fetchImpl,
    );

    let payload: unknown = response.body;
    if (!plain) {
      const envelope = trpcEnvelopeSchema.safeParse(response.body);
      if (!envelope.success) {
        throw shapeError(
          operation,
          response.status,
          issuePaths(envelope.error.issues),
          'the reply was not a tRPC envelope',
        );
      }
      payload = envelope.data.result.data.json;
    }

    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      throw shapeError(
        operation,
        response.status,
        issuePaths(parsed.error.issues),
        'the reply did not match the expected shape',
      );
    }
    return parsed.data;
  };

  return { connector, send };
}
