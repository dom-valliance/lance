import type { Db } from '@lance/db';
import { sql } from 'drizzle-orm';
import { REPLAY_WINDOW_SECONDS } from './verify.js';

/**
 * Replay protection for signed Slack requests (ADR 0021, deferred since
 * Phase 0). The signature verifier accepts a request whose timestamp is
 * within five minutes of now; inside that window the same bytes, and so
 * the same signature, would verify again. Each signature is recorded in
 * `slack_request_nonces` until its window has passed, and a signature that
 * is already there is refused. Postgres, not Redis: there is none.
 */
export interface ReplayGuardLike {
  /** True the first time a signature is seen inside its window; false for a replay. */
  claim(signature: string, timestampSeconds: number): Promise<boolean>;
}

export interface ReplayGuardOptions {
  /** How often expired entries are pruned, at most. Defaults to a minute. */
  pruneEveryMs?: number;
  /** Injected in tests. Milliseconds since the epoch. */
  nowMs?: () => number;
}

const DEFAULT_PRUNE_EVERY_MS = 60_000;

/**
 * The guard over the unscoped handle: the table names no principal, and a
 * request is checked before its principal is known. The entry lasts until
 * the request's own timestamp leaves the window, which the database policy
 * bounds to ten minutes from now.
 */
export function createReplayGuard(root: Db, options: ReplayGuardOptions = {}): ReplayGuardLike {
  const pruneEvery = options.pruneEveryMs ?? DEFAULT_PRUNE_EVERY_MS;
  const nowMs = options.nowMs ?? Date.now;
  let lastPruned = 0;

  const pruneIfDue = async (): Promise<void> => {
    const now = nowMs();
    if (now - lastPruned < pruneEvery) return;
    lastPruned = now;
    // The policy admits only rows whose window has passed.
    await root.execute(sql`DELETE FROM slack_request_nonces WHERE expires_at < now()`);
  };

  return {
    async claim(signature: string, timestampSeconds: number): Promise<boolean> {
      await pruneIfDue();
      const result = await root.execute(
        sql`INSERT INTO slack_request_nonces (signature, expires_at)
            VALUES (${signature}, to_timestamp(${timestampSeconds}) + make_interval(secs => ${REPLAY_WINDOW_SECONDS}))
            ON CONFLICT (signature) DO NOTHING
            RETURNING signature`,
      );
      return result.rows.length === 1;
    },
  };
}
