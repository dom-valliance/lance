import type { FastifyPluginAsync } from 'fastify';
import type { ServerDeps } from '../deps.js';

/**
 * Container Apps probes. `live` answers without touching Postgres so a
 * database blip restarts nothing; `ready` reads `system_state`, which is
 * the one row every other route depends on.
 */
export const healthRoutes =
  (server: ServerDeps): FastifyPluginAsync =>
  // eslint-disable-next-line @typescript-eslint/require-await
  async (fastify): Promise<void> => {
    fastify.get('/health/live', () => ({ ok: true }));

    fastify.get('/health/ready', async (request, reply) => {
      try {
        const state = await server.readiness();
        // The global row, not any one principal's state: an unauthenticated
        // probe has no principal, so the names say what the values are.
        return { ok: true, pausedGlobally: state.paused, modeCeiling: state.mode };
      } catch (error) {
        request.log.error({ err: error }, 'Readiness probe could not read system_state');
        return reply.code(503).send({
          ok: false,
          error:
            'Lance cannot read system_state. Check the database connection and that the seed has run.',
        });
      }
    });
  };
