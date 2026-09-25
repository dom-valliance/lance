import { hasLanceAccess } from '@lance/shared';
import type { FastifyRequest, onRequestHookHandler } from 'fastify';
import type { Caller, ServerDeps } from '../deps.js';
import { ForbiddenError, UnauthorisedError } from '../errors.js';

/**
 * `onRequest` guard for `/admin/*`, `/auth/graph/connect` and every tRPC
 * route (ADR 0020). It verifies the Entra bearer once, requires a Lance app
 * role, resolves the caller's principal from the token's `oid` (binding or
 * creating one on a first sign-in) and hangs both on the request, so
 * handlers and the tRPC context do not repeat the work.
 */

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by `requireEntra` once the bearer token has verified and the principal resolved. */
    caller?: Caller;
  }
}

const BEARER = /^Bearer (.+)$/i;

/** Pulls the token out of `Authorization`, rejecting anything else. */
export const bearerToken = (request: FastifyRequest): string => {
  const header = request.headers.authorization;
  if (header === undefined || header.length === 0) {
    throw new UnauthorisedError(
      'No Authorization header. Send an Entra ID token as "Bearer <token>".',
    );
  }
  const match = BEARER.exec(header);
  if (match?.[1] === undefined) {
    throw new UnauthorisedError(
      'The Authorization header is not a bearer token. Use "Bearer <token>".',
    );
  }
  return match[1].trim();
};

/** Verifies the bearer, requires a Lance role and resolves the principal. */
export const authenticate = async (
  server: Pick<ServerDeps, 'auth' | 'directory'>,
  request: FastifyRequest,
): Promise<Caller> => {
  const identity = await server.auth.verify(bearerToken(request));
  if (!hasLanceAccess(identity.roles)) {
    throw new ForbiddenError(
      'This account holds neither Lance app role. Ask a Lance admin to give you the Lance.User role, then sign in again.',
    );
  }
  const principal = await server.directory.signIn(identity);
  return { identity, principal };
};

export const requireEntra =
  (server: Pick<ServerDeps, 'auth' | 'directory'>): onRequestHookHandler =>
  async (request): Promise<void> => {
    request.caller = await authenticate(server, request);
  };

/** The resolved caller, for a handler that runs behind `requireEntra`. */
export const verifiedCaller = (request: FastifyRequest): Caller => {
  const caller = request.caller;
  if (caller === undefined) {
    throw new Error(
      'No verified caller on the request. Register requireEntra as an onRequest hook on this route.',
    );
  }
  return caller;
};

/**
 * Connecting a credential (Microsoft 365, Jamie) is part of onboarding
 * (docs/plans/multi-user.md M3, steps 2 and 3), so an onboarding principal
 * may do it as well as an active one. Paused and offboarded principals may
 * not.
 */
export const requireConnectable = (caller: Caller): Caller =>
  caller.principal.status === 'onboarding' ? caller : requireActive(caller);

/**
 * Refuses a principal who may not use Lance yet or any more. Onboarding
 * reaches only the checklist and what it calls; a paused or offboarded
 * principal reaches nothing.
 */
export const requireActive = (caller: Caller): Caller => {
  switch (caller.principal.status) {
    case 'active':
      return caller;
    case 'onboarding':
      throw new ForbiddenError(
        'Onboarding for this account is not finished. Complete the checklist at /onboarding; nothing else in Lance is available until then.',
      );
    case 'paused':
      throw new ForbiddenError(
        'This Lance account is paused. Ask a Lance admin to restore it once your access is confirmed.',
      );
    case 'offboarded':
      throw new ForbiddenError('This Lance account has been offboarded. Ask a Lance admin.');
  }
};
