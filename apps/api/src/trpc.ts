import { isLanceAdmin } from '@lance/shared';
import { initTRPC, TRPCError } from '@trpc/server';
import type { CreateFastifyContextOptions } from '@trpc/server/adapters/fastify';
import { requireActive, verifiedCaller } from './auth/require-entra.js';
import type { ApiDeps, Caller, ServerDeps } from './deps.js';
import { HttpError } from './errors.js';

/**
 * tRPC wiring. Every tRPC route sits behind the `requireEntra` onRequest
 * hook, so by the time a procedure runs the caller holds a Lance role and
 * their principal is resolved (ADR 0020). The context carries that
 * principal's own dependencies from the per-principal cache, so every
 * store a procedure touches is scoped to the caller.
 */

export interface ApiContext {
  server: ServerDeps;
  caller: Caller;
  /** The caller's principal's dependencies. */
  deps: ApiDeps;
  upn: string;
}

export const createContextFactory =
  (server: ServerDeps) =>
  ({ req }: CreateFastifyContextOptions): ApiContext => {
    const caller = verifiedCaller(req);
    return {
      server,
      caller,
      deps: server.depsFor(caller.principal),
      upn: caller.identity.upn,
    };
  };

const t = initTRPC.context<ApiContext>().create();

export const router = t.router;
/** Builds a direct caller over a context, for tests and server-side callers. */
export const createCallerFactory = t.createCallerFactory;

/**
 * Any signed-in caller with a Lance role, whatever their status. Only the
 * procedure that tells the web app who is signed in uses it.
 */
export const signedInProcedure = t.procedure;

/** An active principal. Onboarding, paused and offboarded callers get 403. */
export const procedure = t.procedure.use(({ ctx, next }) => {
  try {
    requireActive(ctx.caller);
  } catch (error) {
    if (error instanceof HttpError && error.statusCode === 403) {
      throw new TRPCError({ code: 'FORBIDDEN', message: error.message });
    }
    throw error;
  }
  return next();
});

/** An active principal holding `Lance.Admin` (ADR 0024). Everyone else gets 403. */
export const adminProcedure = procedure.use(({ ctx, next }) => {
  if (!isLanceAdmin(ctx.caller.identity.roles)) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message:
        'Admin procedures need the Lance.Admin role. Ask a Lance admin to add you to the Lance Admins group.',
    });
  }
  return next();
});
