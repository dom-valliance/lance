import { createRemoteJWKSet, errors as joseErrors, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { TokenVerifier } from '../deps.js';
import { UnauthorisedError } from '../errors.js';

/**
 * Entra ID bearer verification (spec 4.1). Single tenant, one allowlisted
 * UPN, delegated tokens only. The signature comes from the tenant's JWKS
 * endpoint; tests inject a local key set instead so no network call is made.
 *
 * No error message ever contains the token or any part of it.
 */

export interface EntraVerifierOptions {
  tenantId: string;
  clientId: string;
  /** The one UPN allowed to sign in. Compared case-insensitively. */
  allowedUpn: string;
  /** Injected in tests. Defaults to the tenant's remote JWKS. */
  jwks?: JWTVerifyGetKey;
}

/** The v2.0 issuer for a single-tenant app registration. */
export const entraIssuer = (tenantId: string): string =>
  `https://login.microsoftonline.com/${tenantId}/v2.0`;

const jwksUrl = (tenantId: string): URL =>
  new URL(`https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`);

/**
 * Entra puts the signed-in user's name in `preferred_username`. Older
 * tokens and some guest scenarios use `upn`; `email` is the last resort.
 */
const claimedUpn = (payload: Record<string, unknown>): string | null => {
  for (const claim of ['preferred_username', 'upn', 'email']) {
    const value = payload[claim];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
};

/** jose error codes turned into something the caller can act on. */
const rejection = (error: unknown): UnauthorisedError => {
  if (error instanceof joseErrors.JWTExpired) {
    return new UnauthorisedError('The bearer token has expired. Sign in again for a fresh one.');
  }
  if (error instanceof joseErrors.JWTClaimValidationFailed) {
    if (error.claim === 'aud') {
      return new UnauthorisedError(
        'The bearer token was issued for a different application. Request a token whose audience is the Lance client id.',
      );
    }
    if (error.claim === 'iss') {
      return new UnauthorisedError(
        'The bearer token was issued by a different tenant. Sign in to the Valliance tenant.',
      );
    }
    return new UnauthorisedError(
      `The bearer token failed validation on the "${error.claim}" claim.`,
    );
  }
  if (error instanceof joseErrors.JWSSignatureVerificationFailed) {
    return new UnauthorisedError(
      'The bearer token signature did not verify against the tenant signing keys.',
    );
  }
  if (error instanceof joseErrors.JOSEError) {
    return new UnauthorisedError('The bearer token is not a readable Entra ID token.');
  }
  throw error;
};

export const createEntraVerifier = (options: EntraVerifierOptions): TokenVerifier => {
  const keys = options.jwks ?? createRemoteJWKSet(jwksUrl(options.tenantId));
  const issuer = entraIssuer(options.tenantId);
  const allowedUpn = options.allowedUpn.toLowerCase();

  return {
    async verify(bearer: string): Promise<{ upn: string }> {
      if (bearer.length === 0) {
        throw new UnauthorisedError(
          'No bearer token. Send an Entra ID token in the Authorization header as "Bearer <token>".',
        );
      }

      let payload: Record<string, unknown>;
      try {
        const result = await jwtVerify(bearer, keys, { issuer, audience: options.clientId });
        payload = result.payload;
      } catch (error) {
        throw rejection(error);
      }

      const upn = claimedUpn(payload);
      if (upn === null) {
        throw new UnauthorisedError(
          'The bearer token carries no preferred_username, upn or email claim, so Lance cannot tell who is calling.',
        );
      }
      if (upn.toLowerCase() !== allowedUpn) {
        throw new UnauthorisedError(
          'This account is not on the Lance allowlist. Sign in as the allowlisted user.',
        );
      }

      return { upn };
    },
  };
};
