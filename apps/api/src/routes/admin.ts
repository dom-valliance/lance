import type { FastifyPluginAsync } from 'fastify';
import { SYSTEM_MODES, SystemModeSchema } from '@lance/shared';
import { z } from 'zod';
import { DOM_ACTOR, resumeAndRequeue, type ApiDeps } from '../deps.js';
import { BadRequestError } from '../errors.js';

/**
 * The kill switch over HTTP (spec 4.3, docs/runbooks/kill-switch.md). Every
 * route here sits behind `requireEntra`, so the caller is always Dom and
 * the ledger actor is always `user:dom`.
 */

const PauseBodySchema = z.object({ reason: z.string().min(1) });
const ModeBodySchema = z.object({ mode: SystemModeSchema });

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

    // Live or dry run (spec 6.3). Held proposals stay held: a resume after
    // the switch is what re-queues them, so the change is two deliberate steps.
    fastify.post('/admin/mode', async (request) => {
      const parsed = ModeBodySchema.safeParse(request.body);
      if (!parsed.success) {
        throw new BadRequestError(
          `A mode change needs a body of {"mode": "live"} or {"mode": "dry_run"}; ${SYSTEM_MODES.join(' and ')} are the only modes.`,
        );
      }
      return deps.control.setMode(parsed.data.mode, { actor: DOM_ACTOR });
    });

    fastify.get('/admin/status', async () => deps.status.snapshot());
  };
