import { newUlid, nowIso } from '@lance/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireConnectable, verifiedCaller } from '../auth/require-entra.js';
import type { JamieKeyDeps, ServerDeps } from '../deps.js';
import { BadRequestError, HttpError } from '../errors.js';

/**
 * A principal's own credentials (ADR 0022, docs/plans/multi-user.md M2 and
 * M3 step 3). `POST /credentials/jamie` takes a Jamie API key from the
 * onboarding form, makes one test call with it, and only then stores it as
 * `jamie-api-key--<principalId>` in the principal vault, which the api can
 * write and never read back.
 *
 * The key never reaches Postgres, a log line, an error message or a
 * response. The body is parsed here rather than by Fastify's JSON parser,
 * because a malformed body's parse error would quote the body back, and
 * the error handler logs every rejected request's error.
 */

const JamieKeyBodySchema = z.object({ apiKey: z.string().trim().min(1).max(1024) });

const BODY_ADVICE =
  'Send {"apiKey": "..."} as JSON, with the personal key from Jamie under Settings, Developers, API Keys.';

export const jamieKeyConfigurationError = (): HttpError =>
  new HttpError(
    503,
    'Storing a Jamie key is not configured on this api. Set PRINCIPAL_KEY_VAULT_URL, then restart the container.',
  );

const jamieDeps = (server: ServerDeps): JamieKeyDeps => {
  if (server.jamieKeys === undefined) throw jamieKeyConfigurationError();
  return server.jamieKeys;
};

/** Parses the body without ever putting any of it in an error. */
const parseBody = (raw: string): string => {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new BadRequestError(`The body is not JSON. ${BODY_ADVICE}`);
  }
  const parsed = JamieKeyBodySchema.safeParse(json);
  if (!parsed.success) throw new BadRequestError(`The body has no usable apiKey. ${BODY_ADVICE}`);
  return parsed.data.apiKey;
};

export const credentialRoutes =
  (server: ServerDeps): FastifyPluginAsync =>
  // eslint-disable-next-line @typescript-eslint/require-await
  async (fastify): Promise<void> => {
    // This plugin's own JSON parser: the body stays a string until parseBody.
    fastify.removeContentTypeParser('application/json');
    fastify.addContentTypeParser(
      'application/json',
      { parseAs: 'string' },
      (_request, body, done) => {
        done(null, body);
      },
    );

    fastify.post('/credentials/jamie', async (request, reply) => {
      const caller = requireConnectable(verifiedCaller(request));
      const jamie = jamieDeps(server);
      const apiKey = parseBody(typeof request.body === 'string' ? request.body : '');

      try {
        await jamie.check(apiKey);
      } catch {
        // The reason stays out of the reply and the log: a connector error
        // names no key, but nothing here depends on that.
        throw new BadRequestError(
          'Jamie did not accept this key. Create a personal key in Jamie under Settings, Developers, API Keys (a workspace key cannot read your meetings) and try again. Nothing was stored.',
        );
      }

      await jamie.store(caller.principal.id, apiKey);

      const deps = server.depsFor(caller.principal);
      await deps.writer.append({
        ts: (server.now ?? nowIso)(),
        actor: deps.actor,
        kind: 'state_changed',
        sourceSystem: 'jamie',
        correlationId: newUlid(),
        payload: { change: 'jamie_connected' },
      });

      return reply.code(200).send({ connected: true });
    });
  };
