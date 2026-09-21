import { z } from 'zod';
import {
  defineConnector,
  type CallContext,
  type Connector,
  type ConnectorEvents,
} from '../core/connector.js';
import { ConnectorError } from '../core/errors.js';
import { fetchJson } from '../core/http.js';
import type { Clock } from '../core/rateLimit.js';

export const SLACK_API = 'https://slack.com/api';

/** Every Slack Web API reply carries `ok`; failures carry `error`. */
const SlackEnvelope = z.object({ ok: z.boolean(), error: z.string().optional() }).passthrough();

export interface SlackClientOptions {
  /** Bot token; the caller reads it with readSecret('SLACK_BOT_TOKEN'). */
  token: string;
  events?: ConnectorEvents;
  clock?: Clock;
  fetchImpl?: typeof fetch;
}

export interface SlackClient {
  connector: Connector;
  /** Calls a Web API method and returns its parsed, ok-checked body. */
  call<T>(
    kind: 'read' | 'write',
    method: string,
    body: Record<string, unknown>,
    context?: CallContext,
    schema?: z.ZodType<T>,
  ): Promise<T>;
}

const RETRYABLE_SLACK_ERRORS = new Set([
  'ratelimited',
  'internal_error',
  'service_unavailable',
  'fatal_error',
]);

/**
 * Slack Web API over the connector framework (spec 8). chat.postMessage is
 * limited to about one message per second per channel, so the bucket is
 * small; retries honour Slack's Retry-After on 429.
 */
export function createSlackClient(options: SlackClientOptions): SlackClient {
  const connector = defineConnector({
    name: 'slack',
    policy: {
      rateLimit: { capacity: 5, refillPerSecond: 1, maxWaitMs: 20_000 },
      retry: { attempts: 4, baseDelayMs: 500, maxDelayMs: 8000 },
      breaker: { failureThreshold: 3, halfOpenAfterMs: 60_000 },
    },
    ...(options.events === undefined ? {} : { events: options.events }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
  const fetchImpl = options.fetchImpl ?? fetch;

  const call = async <T>(
    kind: 'read' | 'write',
    method: string,
    body: Record<string, unknown>,
    context: CallContext = {},
    schema?: z.ZodType<T>,
  ): Promise<T> => {
    const run = async (): Promise<T> => {
      const response = await fetchJson<unknown>(
        'slack',
        method,
        `${SLACK_API}/${method}`,
        { method: 'POST', headers: { authorization: `Bearer ${options.token}` }, body },
        fetchImpl,
      );
      const envelope = SlackEnvelope.parse(response.body);
      if (!envelope.ok) {
        const code = envelope.error ?? 'unknown_error';
        throw new ConnectorError(`slack ${method}: ${code}.`, {
          connector: 'slack',
          operation: method,
          status: response.status,
          retryable: RETRYABLE_SLACK_ERRORS.has(code),
        });
      }
      return schema === undefined ? (envelope as T) : schema.parse(envelope);
    };
    const ctx: CallContext = { ...context, request: { method, keys: Object.keys(body).sort() } };
    return kind === 'read' ? connector.read(method, ctx, run) : connector.write(method, ctx, run);
  };

  return { connector, call };
}
