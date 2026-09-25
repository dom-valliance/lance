import { createHash } from 'node:crypto';
import { graphConsentStates, principals, scopedDb, ULID_PATTERN, type Db } from '@lance/db';
import { and, eq, gt, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';

/**
 * The short-lived link between the three legs of the Microsoft 365
 * consent: `/auth/graph/connect` issues a state, `/auth/graph/begin` binds
 * it to the principal's browser with a cookie, and `/auth/graph/callback`
 * uses it once. Each state holds one PKCE code verifier and the principal
 * who started the consent, so the callback, which arrives without a
 * bearer, records the connection under that principal alone.
 *
 * In Postgres (migration 0021), because the api runs up to two replicas
 * without affinity and the callback may reach either. The state value is
 * `<principalId>.<random>`: the principal id lets each leg scope its
 * session to the principal before it reads, so row-level security holds
 * every read and write to that principal, and the random half is what
 * makes the state unguessable. Only its SHA-256 is stored.
 */

/** How long a consent attempt may stay open. The table's CHECK holds the same bound. */
export const CONSENT_STATE_TTL_MINUTES = 10;

const ULID = new RegExp(ULID_PATTERN);

/** The state's principal, for the scope; null when the value is not one Lance issues. */
export const principalOfState = (state: string): string | null => {
  const [principalId, random, ...rest] = state.split('.');
  if (principalId === undefined || random === undefined || rest.length > 0) return null;
  if (!ULID.test(principalId) || random.length < 32) return null;
  return principalId;
};

/** The state value for a principal, around a random half from `generateState`. */
export const stateFor = (principalId: string, random: string): string => `${principalId}.${random}`;

const hashOf = (state: string): string => createHash('sha256').update(state).digest('hex');

export interface ConsentPrincipal {
  id: string;
  upn: string;
  /** The Entra object id the principal is bound to; null before their first sign-in binds it. */
  entraOid: string | null;
}

export interface ClaimedConsent {
  codeVerifier: string;
  /** Who started the consent: the scope the callback records it in. */
  principal: ConsentPrincipal;
}

export interface ConsentStateStoreLike {
  /** Remembers the verifier for `state`, in the principal's scope. */
  issue(principalId: string, state: string, codeVerifier: string): Promise<void>;
  /**
   * Marks an unbound, unused, unexpired state bound and returns what the
   * authorise URL needs; null otherwise. Once only, so a begin link that
   * reached another browser after the principal used it binds nothing.
   */
  bind(state: string): Promise<ClaimedConsent | null>;
  /**
   * The verifier and principal for a bound state, or null when it is
   * unknown, unbound, expired or already used. One use only.
   */
  claim(state: string): Promise<ClaimedConsent | null>;
}

export function createConsentStateStore(root: Db): ConsentStateStoreLike {
  const principalOf = async (db: Db, principalId: string): Promise<ConsentPrincipal | null> => {
    const rows = await db
      .select({ id: principals.id, upn: principals.upn, entraOid: principals.entraOid })
      .from(principals)
      .where(eq(principals.id, principalId));
    return rows[0] ?? null;
  };

  /** Advances one row in its principal's scope; the policies refuse used or expired rows. */
  const advance = async (
    state: string,
    column: 'boundAt' | 'usedAt',
  ): Promise<ClaimedConsent | null> => {
    const principalId = principalOfState(state);
    if (principalId === null) return null;
    const db = scopedDb(root, { principalId });
    const rows = await db
      .update(graphConsentStates)
      .set(column === 'boundAt' ? { boundAt: sql`now()` } : { usedAt: sql`now()` })
      .where(
        and(
          eq(graphConsentStates.stateHash, hashOf(state)),
          isNull(graphConsentStates.usedAt),
          gt(graphConsentStates.expiresAt, sql`now()`),
          column === 'boundAt'
            ? isNull(graphConsentStates.boundAt)
            : isNotNull(graphConsentStates.boundAt),
        ),
      )
      .returning({ codeVerifier: graphConsentStates.codeVerifier });
    const row = rows[0];
    if (row === undefined) return null;
    const principal = await principalOf(db, principalId);
    if (principal === null) return null;
    return { codeVerifier: row.codeVerifier, principal };
  };

  return {
    async issue(principalId, state, codeVerifier): Promise<void> {
      if (principalOfState(state) !== principalId) {
        throw new Error(
          'A consent state must begin with the id of the principal it is issued for. Build it with stateFor.',
        );
      }
      const db = scopedDb(root, { principalId });
      // The principal's own finished or expired attempts go first.
      await db
        .delete(graphConsentStates)
        .where(
          or(lt(graphConsentStates.expiresAt, sql`now()`), isNotNull(graphConsentStates.usedAt)),
        );
      await db.insert(graphConsentStates).values({
        stateHash: hashOf(state),
        principalId,
        codeVerifier,
        expiresAt: sql`now() + make_interval(mins => ${CONSENT_STATE_TTL_MINUTES})`,
      });
    },

    bind: (state) => advance(state, 'boundAt'),

    claim: (state) => advance(state, 'usedAt'),
  };
}
