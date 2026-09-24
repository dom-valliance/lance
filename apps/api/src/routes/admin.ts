import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { SYSTEM_MODES, SystemModeSchema } from '@lance/shared';
import { z } from 'zod';
import { requireActive, verifiedCaller } from '../auth/require-entra.js';
import { resumeAndRequeue, type ApiDeps, type ServerDeps } from '../deps.js';
import { BadRequestError } from '../errors.js';

/**
 * The kill switch over HTTP (spec 4.3, docs/runbooks/kill-switch.md). Every
 * route here sits behind `requireEntra` and acts on the caller's own
 * principal, through that principal's scoped dependencies, with the
 * caller's own ledger actor.
 */

const PauseBodySchema = z.object({ reason: z.string().min(1) });
const ModeBodySchema = z.object({ mode: SystemModeSchema });

export const adminRoutes =
  (server: ServerDeps): FastifyPluginAsync =>
  // eslint-disable-next-line @typescript-eslint/require-await
  async (fastify): Promise<void> => {
    const callerDeps = (request: FastifyRequest): ApiDeps =>
      server.depsFor(requireActive(verifiedCaller(request)).principal);

    fastify.post('/admin/pause', async (request) => {
      const deps = callerDeps(request);
      const parsed = PauseBodySchema.safeParse(request.body);
      if (!parsed.success) {
        throw new BadRequestError(
          'A pause needs a body of {"reason": "..."} with a non-empty reason, so the ledger records why.',
        );
      }
      return deps.control.pause({ reason: parsed.data.reason, actor: deps.actor });
    });

    fastify.post('/admin/resume', async (request) => resumeAndRequeue(callerDeps(request)));

    // Live or dry run (spec 6.3). Held proposals stay held: a resume after
    // the switch is what re-queues them, so the change is two deliberate steps.
    fastify.post('/admin/mode', async (request) => {
      const deps = callerDeps(request);
      const parsed = ModeBodySchema.safeParse(request.body);
      if (!parsed.success) {
        throw new BadRequestError(
          `A mode change needs a body of {"mode": "live"} or {"mode": "dry_run"}; ${SYSTEM_MODES.join(' and ')} are the only modes.`,
        );
      }
      return deps.control.setMode(parsed.data.mode, { actor: deps.actor });
    });

    fastify.get('/admin/status', async (request) => callerDeps(request).status.snapshot());
  };
