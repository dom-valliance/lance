import type { FastifyRequest, onRequestHookHandler } from 'fastify';
import type { ApiDeps } from '../deps.js';
import { UnauthorisedError } from '../errors.js';

/**
 * `onRequest` guard for `/admin/*` and every tRPC route. It verifies the
 * Entra bearer once and hangs the UPN on the request so handlers and the
 * tRPC context do not verify it again.
 */

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by `requireEntra` once the bearer token has verified. */
    entraUpn?: string;
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

export const requireEntra =
  (deps: ApiDeps): onRequestHookHandler =>
  async (request): Promise<void> => {
    const { upn } = await deps.auth.verify(bearerToken(request));
    request.entraUpn = upn;
  };

/** The verified UPN, for a handler that runs behind `requireEntra`. */
export const verifiedUpn = (request: FastifyRequest): string => {
  const upn = request.entraUpn;
  if (upn === undefined) {
    throw new Error(
      'No verified UPN on the request. Register requireEntra as an onRequest hook on this route.',
    );
  }
  return upn;
};
