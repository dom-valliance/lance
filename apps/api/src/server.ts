import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import type { Config } from '@lance/shared';
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyPluginAsync,
  type FastifyServerOptions,
} from 'fastify';
import { requireEntra } from './auth/require-entra.js';
import type { ApiDeps } from './deps.js';
import { adminRoutes } from './routes/admin.js';
import { healthRoutes } from './routes/health.js';
import { ingestRoutes } from './routes/ingest.js';
import { appRouter, type AppRouter } from './router.js';
import { slackRoutes } from './slack/routes.js';
import { createContextFactory } from './trpc.js';

/**
 * The api server (spec 3.1): auth, the kill switch, ledger queries over
 * tRPC, Slack's three endpoints and the agent-log webhook.
 *
 * `buildServer` takes every collaborator as an argument, so a test builds
 * the same server over fakes and `main.ts` builds it over Postgres.
 */

/**
 * Anything that could carry a credential. Pino's `redact` replaces the
 * value before it reaches a transport, so a secret cannot leak through a
 * request log even when a handler logs the whole object.
 */
export const LOGGER_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-lance-ingest-secret"]',
  'req.headers["x-slack-signature"]',
  'res.headers["set-cookie"]',
  'token',
  '*.token',
  '*.*.token',
  'secret',
  '*.secret',
  '*.*.secret',
];

type LoggerOptions = NonNullable<FastifyServerOptions['logger']>;

export const loggerOptions = (config: Config): LoggerOptions => {
  if (config.nodeEnv === 'test') return false;
  return {
    level: config.nodeEnv === 'production' ? 'info' : 'debug',
    redact: { paths: LOGGER_REDACT_PATHS, censor: '[redacted]' },
  };
};

/** Admin and tRPC, both behind one Entra check. */
const protectedRoutes =
  (deps: ApiDeps): FastifyPluginAsync =>
  async (fastify): Promise<void> => {
    fastify.addHook('onRequest', requireEntra(deps));
    await fastify.register(adminRoutes(deps));
    await fastify.register(fastifyTRPCPlugin, {
      prefix: '/trpc',
      trpcOptions: {
        router: appRouter,
        createContext: createContextFactory(deps),
      },
    } satisfies FastifyTRPCPluginOptions<AppRouter>);
  };

export const buildServer = (deps: ApiDeps): FastifyInstance => {
  const fastify = Fastify({ logger: loggerOptions(deps.config) });

  fastify.setErrorHandler((error: FastifyError, request, reply) => {
    const statusCode = error.statusCode ?? 500;
    if (statusCode >= 500) {
      request.log.error({ err: error }, 'Request failed');
      return reply.code(statusCode).send({
        error:
          'The request could not be completed. Check the api logs for the entry with this request id.',
      });
    }
    request.log.warn({ err: error }, 'Request rejected');
    return reply.code(statusCode).send({ error: error.message });
  });

  void fastify.register(healthRoutes(deps));
  void fastify.register(ingestRoutes(deps));
  void fastify.register(slackRoutes(deps));
  void fastify.register(protectedRoutes(deps));

  return fastify;
};
