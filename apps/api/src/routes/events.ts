import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { ServerDeps } from '../deps.js';
import { authenticate, requireActive } from '../auth/require-entra.js';

/**
 * `GET /events`: the live update stream the web app subscribes to
 * (spec 12). Server-Sent Events rather than a socket, because the traffic
 * is one way and a proxy can buffer it without breaking anything.
 *
 * The Entra bearer travels in the Authorization header and nowhere else.
 * A browser's `EventSource` cannot set headers, so the web app's own
 * `/api/events` route handler subscribes here on the browser's behalf
 * and pipes the stream through; the token never enters a URL.
 */

/** Long enough to be cheap, short enough to beat a 60-second proxy idle timeout. */
export const HEARTBEAT_MS = 25_000;

export const eventsRoutes =
  (server: ServerDeps): FastifyPluginAsync =>
  // eslint-disable-next-line @typescript-eslint/require-await
  async (fastify: FastifyInstance): Promise<void> => {
    fastify.get('/events', async (request, reply) => {
      // Verified before the response is hijacked, so a rejection still
      // goes through the error handler as an ordinary 401.
      // The stream is the caller's principal's own feed, so nobody hears
      // about another principal's proposals or alerts.
      const caller = requireActive(await authenticate(server, request));
      const deps = server.depsFor(caller.principal);

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
