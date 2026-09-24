import { ConnectorError } from '../core/index.js';
import { refreshAccessToken, TokenRefreshError } from './auth.js';
import type { GraphTokenStore } from './tokenStore.js';

/**
 * Turns the stored refresh token into a usable access token, and keeps the
 * store current.
 *
 * Spec 4.2 requires the refresh token to be rotated on every use. Entra
 * issues a new refresh token with every access token, so each refresh here
 * writes the new value back to the store before the access token is handed
 * out: if the write fails, the caller gets the failure rather than a
 * working session over a token nobody has saved.
 */

/** Refresh this long before the access token actually expires. */
const EXPIRY_MARGIN_MS = 2 * 60 * 1000;

export type AccessTokenProvider = () => Promise<string>;

/**
 * Runs `work` while holding a lock that every process sharing the store
 * takes for the same principal and connector. The worker's lock is a
 * Postgres advisory lock (ADR 0022), so two replicas never race one
 * rotation: the second reads the token the first has just stored.
 */
export type RotationLock = <T>(work: () => Promise<T>) => Promise<T>;

export interface AccessTokenProviderOptions {
  store: GraphTokenStore;
  tenantId: string;
  clientId: string;
  clientSecret: string;
  /** Epoch milliseconds. Injected in tests. */
  now?: () => number;
  /**
   * Called once per refusal, before the error is rethrown, so the caller
   * can raise the P0 `token_refresh_failed` alert of spec 11 and pause the
   * affected watcher.
   */
  onRefreshFailed?: (error: TokenRefreshError) => void | Promise<void>;
  fetchImpl?: typeof fetch;
  /**
   * Held across the read of the stored refresh token, the refresh and the
   * write of the rotated one. Without it, concurrent callers in this
   * process still share one refresh, but another process could redeem
   * the same refresh token at the same time.
   */
  rotationLock?: RotationLock;
  /** The message when no token is stored: who should connect, and where. */
  notConnectedMessage?: string;
}

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

export function createAccessTokenProvider(
  options: AccessTokenProviderOptions,
): AccessTokenProvider {
  const now = options.now ?? ((): number => Date.now());
  let cached: CachedToken | null = null;
  let inFlight: Promise<string> | null = null;

  const lock: RotationLock = options.rotationLock ?? ((work) => work());

  const refresh = async (): Promise<string> => {
    const refreshToken = await options.store.getRefreshToken();
    if (refreshToken === null) {
      throw new ConnectorError(
        options.notConnectedMessage ??
          'graph token: no Microsoft Graph refresh token is stored. Open /auth/graph/connect as the principal and consent once; see docs/runbooks/entra-setup.md section 7.',
        { connector: 'graph', operation: 'token', retryable: false },
      );
    }

    try {
      const tokens = await refreshAccessToken({
        tenantId: options.tenantId,
        clientId: options.clientId,
        clientSecret: options.clientSecret,
        refreshToken,
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      });
      // Rotation first: the old refresh token is already dead.
      await options.store.setRefreshToken(tokens.refreshToken);
      cached = { token: tokens.accessToken, expiresAtMs: tokens.expiresAt.getTime() };
      return tokens.accessToken;
    } catch (error) {
      cached = null;
      if (error instanceof TokenRefreshError) {
        await options.onRefreshFailed?.(error);
      }
      throw error;
    }
  };

  return async function accessToken(): Promise<string> {
    const current = cached;
    if (current !== null && current.expiresAtMs - EXPIRY_MARGIN_MS > now()) {
      return current.token;
    }
    // Concurrent callers share one refresh, so a burst of watcher calls
    // rotates the stored token once rather than racing each other.
    inFlight ??= lock(refresh).finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}
