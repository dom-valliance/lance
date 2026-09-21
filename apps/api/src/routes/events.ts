import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ApiDeps } from '../deps.js';
import { UnauthorisedError } from '../errors.js';
import { bearerToken } from '../auth/require-entra.js';

/**
 * `GET /events`: the live update stream the web app subscribes to
 * (spec 12). Server-Sent Events rather than a socket, because the traffic
 * is one way and a proxy can buffer it without breaking anything.
 *
 * `EventSource` cannot set request headers, so the Entra bearer is accepted
 * as the `access_token` query parameter as well. It is the same token and
 * the same verifier; only the carrier differs. Query strings reach access
 * logs, so the api's own logger never records one (see `LOGGER_REDACT_PATHS`)
 * and the token is short lived.
 */

/** Long enough to be cheap, short enough to beat a 60-second proxy idle timeout. */
export const HEARTBEAT_MS = 25_000;

const QuerySchema = z.object({ access_token: z.string().min(1).optional() });

const eventsBearer = (request: FastifyRequest): string => {
  const query = QuerySchema.safeParse(request.query);
  if (query.success && query.data.access_token !== undefined) {
    return query.data.access_token;
  }
  if (request.headers.authorization !== undefined) {
    return bearerToken(request);
  }
  throw new UnauthorisedError(
    'No Entra token. Send it as "Authorization: Bearer <token>" or, from EventSource, as the access_token query parameter.',
  );
};

export const eventsRoutes =
  (deps: ApiDeps): FastifyPluginAsync =>
  // eslint-disable-next-line @typescript-eslint/require-await
  async (fastify: FastifyInstance): Promise<void> => {
    fastify.get('/events', async (request, reply) => {
      // Verified before the response is hijacked, so a rejection still
      // goes through the error handler as an ordinary 401.
      await deps.auth.verify(eventsBearer(request));

      reply.hijack();
      const stream = reply.raw;
      stream.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        // Tells nginx and Container Apps' ingress not to buffer the stream.
        'x-accel-buffering': 'no',
      });
      stream.write(': connected\n\n');

      // No `event:` field: the browser's EventSource routes a named event
      // away from `onmessage`, and the web app's hook listens there. The
      // kind is in the payload instead.
      const unsubscribe = deps.subscribe((event) => {
        stream.write(`data: ${JSON.stringify(event)}\n\n`);
      });
      const heartbeat = setInterval(() => stream.write(': heartbeat\n\n'), HEARTBEAT_MS);
      heartbeat.unref();

      const close = (): void => {
        clearInterval(heartbeat);
        unsubscribe();
        stream.end();
      };
      request.raw.on('close', close);
      request.raw.on('error', close);
    });
  };
