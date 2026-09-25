import { z } from 'zod';
import {
  defineConnector,
  type CallContext,
  type Connector,
  type ConnectorEvents,
  type WriteOptions,
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

/**
 * What the rest of the repository may do with Slack: read, and inspect the
 * framework wrapper. `call` reads; there is no write kind on it (spec 8,
 * non-negotiable 2). `slackWriteAccess` below hands the write function to
 * `writes.ts`, and no barrel re-exports it.
 */
export interface SlackClient {
  connector: Connector;
  /** Calls a read-only Web API method and returns its parsed, ok-checked body. */
  call<T>(
    method: string,
    body: Record<string, unknown>,
    context?: CallContext,
    schema?: z.ZodType<T>,
  ): Promise<T>;
}

/** One Slack write. Package-internal; `writes.ts` is its only caller. */
export interface SlackWrite {
  <T>(
    method: string,
    body: Record<string, unknown>,
    context: CallContext | undefined,
    schema: z.ZodType<T> | undefined,
    options?: WriteOptions,
  ): Promise<T>;
}

const writeAccess = new WeakMap<SlackClient, SlackWrite>();

/**
 * The write half of a Slack client, for `slack/writes.ts` only. Deliberately
 * absent from `slack/index.js` and from the package root.
 */
/**
 * A read method's arguments, form-encoded. Slack accepts a JSON body only on
 * some methods: `users.info` ignores one and answers `user_not_found`, so
 * every read goes form-encoded, which every method accepts. Writes keep
 * JSON, which `chat.postMessage` needs for its blocks.
 */
function formBody(body: Record<string, unknown>): URLSearchParams {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined || value === null) continue;
    form.set(key, typeof value === 'string' ? value : JSON.stringify(value));
  }
  return form;
}

export function slackWriteAccess(client: SlackClient): SlackWrite {
  const write = writeAccess.get(client);
  if (write === undefined) {
    throw new ConnectorError(
      'slack: this object was not built by createSlackClient, so it carries no write capability. Pass the client createSlackClient returned.',
      { connector: 'slack', operation: 'slackWriteAccess', retryable: false },
    );
  }
  return write;
}

/**
 * A Web API reply with `ok: false`. `code` is Slack's own error string,
 * such as `name_taken`, for a caller that answers one refusal differently.
 */
export class SlackApiError extends ConnectorError {
  override readonly name = 'SlackApiError';

  constructor(
    readonly code: string,
    method: string,
    status: number,
    retryable: boolean,
  ) {
    super(`slack ${method}: ${code}.`, {
      connector: 'slack',
      operation: method,
      status,
      retryable,
    });
  }
}

export const isSlackApiError = (error: unknown, code?: string): error is SlackApiError =>
  error instanceof SlackApiError && (code === undefined || error.code === code);

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

  const send = async <T>(
    kind: 'read' | 'write',
    method: string,
    body: Record<string, unknown>,
    context: CallContext = {},
    schema: z.ZodType<T> | undefined,
    writeOptions: WriteOptions | undefined,
  ): Promise<T> => {
    const run = async (): Promise<T> => {
      const response = await fetchJson<unknown>(
        'slack',
        method,
        `${SLACK_API}/${method}`,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${options.token}` },
          body: kind === 'read' ? formBody(body) : body,
        },
        fetchImpl,
      );
      const envelope = SlackEnvelope.parse(response.body);
      if (!envelope.ok) {
        const code = envelope.error ?? 'unknown_error';
        throw new SlackApiError(code, method, response.status, RETRYABLE_SLACK_ERRORS.has(code));
      }
      return schema === undefined ? (envelope as T) : schema.parse(envelope);
    };
    const ctx: CallContext = { ...context, request: { method, keys: Object.keys(body).sort() } };
    return kind === 'read'
      ? connector.read(method, ctx, run)
      : connector.write(method, ctx, run, writeOptions ?? {});
  };

  const client: SlackClient = {
    connector,
    call: (method, body, context, schema) => send('read', method, body, context, schema, undefined),
  };
  const write: SlackWrite = (method, body, context, schema, options) =>
    send('write', method, body, context, schema, options);
  writeAccess.set(client, write);
  return client;
}
