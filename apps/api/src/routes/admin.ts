import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { DOM_ACTOR, resumeAndRequeue, type ApiDeps } from '../deps.js';
import { BadRequestError } from '../errors.js';

/**
 * The kill switch over HTTP (spec 4.3, docs/runbooks/kill-switch.md). Every
 * route here sits behind `requireEntra`, so the caller is always Dom and
 * the ledger actor is always `user:dom`.
 */

const PauseBodySchema = z.object({ reason: z.string().min(1) });

export const adminRoutes =
  (deps: ApiDeps): FastifyPluginAsync =>
  // eslint-disable-next-line @typescript-eslint/require-await
  async (fastify): Promise<void> => {
    fastify.post('/admin/pause', async (request) => {
      const parsed = PauseBodySchema.safeParse(request.body);
      if (!parsed.success) {
        throw new BadRequestError(
          'A pause needs a body of {"reason": "..."} with a non-empty reason, so the ledger records why.',
        );
      }
      return deps.control.pause({ reason: parsed.data.reason, actor: DOM_ACTOR });
    });

    fastify.post('/admin/resume', async () => resumeAndRequeue(deps));

    fastify.get('/admin/status', async () => deps.status.snapshot());
  };
