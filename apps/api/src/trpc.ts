import { initTRPC } from '@trpc/server';
import type { CreateFastifyContextOptions } from '@trpc/server/adapters/fastify';
import { verifiedUpn } from './auth/require-entra.js';
import type { ApiDeps } from './deps.js';

/**
 * tRPC wiring. Every tRPC route sits behind the `requireEntra` onRequest
 * hook, so by the time a procedure runs the caller is already the
 * allowlisted UPN; the context carries it for auditing rather than for a
 * second check.
 */

export interface ApiContext {
  deps: ApiDeps;
  upn: string;
}

export const createContextFactory =
  (deps: ApiDeps) =>
  ({ req }: CreateFastifyContextOptions): ApiContext => ({ deps, upn: verifiedUpn(req) });

const t = initTRPC.context<ApiContext>().create();

export const router = t.router;
/** Builds a direct caller over a context, for tests and server-side callers. */
export const createCallerFactory = t.createCallerFactory;
/** Guarded at the HTTP layer by `requireEntra`; there is no anonymous tRPC route. */
export const procedure = t.procedure;
