/**
 * The short-lived link between `/auth/graph/connect` and
 * `/auth/graph/callback`: one PKCE code verifier per `state` value, and
 * the principal who started the consent, so the callback, which arrives
 * without a bearer, records the connection under that principal alone.
 *
 * In memory on purpose. The pair is worthless once the callback has run,
 * and a consent that does not complete inside ten minutes should fail and
 * be started again rather than be resumable from a database a week later.
 * A restart between the two legs invalidates the attempt, which is the
 * safe direction.
 */

/** How long a consent attempt may stay open. */
export const CONSENT_STATE_TTL_MS = 10 * 60 * 1000;

export interface ClaimedConsent {
  codeVerifier: string;
  /** Who started the consent: the scope the callback records it in. */
  principal: { id: string; upn: string };
}

export interface ConsentStateStore {
  /** Remembers the verifier and the principal for `state`. */
  issue(state: string, codeVerifier: string, principal: ClaimedConsent['principal']): void;
  /**
   * The verifier and principal for `state`, or null when it is unknown or
   * older than the time to live. One use only: a replayed callback finds
   * nothing.
   */
  claim(state: string): ClaimedConsent | null;
  /** Open attempts, after pruning. For tests and diagnostics. */
  size(): number;
}

export interface ConsentStateStoreOptions {
  ttlMs?: number;
  /** Epoch milliseconds. Injected in tests. */
  now?: () => number;
}

interface PendingConsent extends ClaimedConsent {
  issuedAt: number;
}

export function createConsentStateStore(options: ConsentStateStoreOptions = {}): ConsentStateStore {
  const ttlMs = options.ttlMs ?? CONSENT_STATE_TTL_MS;
  const now = options.now ?? ((): number => Date.now());
  const pending = new Map<string, PendingConsent>();

  const prune = (): void => {
    const cutoff = now() - ttlMs;
    for (const [state, entry] of pending) {
      if (entry.issuedAt <= cutoff) pending.delete(state);
    }
  };

  return {
    issue(state: string, codeVerifier: string, principal: ClaimedConsent['principal']): void {
      prune();
      pending.set(state, { codeVerifier, principal, issuedAt: now() });
    },

    claim(state: string): ClaimedConsent | null {
      prune();
      const entry = pending.get(state);
      if (entry === undefined) return null;
      pending.delete(state);
      return { codeVerifier: entry.codeVerifier, principal: entry.principal };
    },

    size(): number {
      prune();
      return pending.size;
    },
  };
}
