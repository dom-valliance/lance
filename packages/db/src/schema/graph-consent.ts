import { sql } from 'drizzle-orm';
import { check, index, pgTable, text } from 'drizzle-orm/pg-core';
import { timestamptz, ulidCheck } from './columns.js';
import { principalId } from './principals.js';

/**
 * One open Microsoft 365 consent (spec 4.1, ADR 0022): the PKCE code
 * verifier behind a `state` value and the principal who started it. In
 * Postgres rather than in one api replica's memory, because the api runs
 * up to two replicas without affinity and the callback may reach either.
 *
 * `state_hash` is the SHA-256 of the state, so a read of the table cannot
 * finish a consent. A row is bound once, when the principal's browser
 * takes the consent cookie, and used once, by the callback; it lives ten
 * minutes at most. Row-level security (migration 0021) holds every read
 * and write to the principal's own scope.
 */
export const graphConsentStates = pgTable(
  'graph_consent_states',
  {
    stateHash: text('state_hash').primaryKey(),
    principalId: principalId(),
    codeVerifier: text('code_verifier').notNull(),
    issuedAt: timestamptz('issued_at').notNull().defaultNow(),
    expiresAt: timestamptz('expires_at')
      .notNull()
      .default(sql`now() + interval '10 minutes'`),
    boundAt: timestamptz('bound_at'),
    usedAt: timestamptz('used_at'),
  },
  (table) => [
    ulidCheck('graph_consent_states', 'principal_id'),
    check(
      'graph_consent_states_ten_minutes',
      sql`${table.expiresAt} <= ${table.issuedAt} + interval '10 minutes'`,
    ),
    index('graph_consent_states_expires_at_idx').on(table.expiresAt),
  ],
);

export type GraphConsentState = typeof graphConsentStates.$inferSelect;
