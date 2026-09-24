import type { Db } from './client.js';

/**
 * A Postgres session advisory lock around work that must not run twice at
 * once across processes (ADR 0022: refresh-token rotation). The lock is
 * taken on one pooled connection that is held for the whole of `work`
 * and released after it, so every process sharing the database queues on
 * the same key. No transaction stays open while `work` calls out.
 *
 * The key is a string hashed to Postgres's 64-bit key space with
 * `hashtextextended`; callers namespace it, for example
 * `lance:credential-rotation:graph:<principalId>`.
 *
 * If the unlock itself fails the connection is destroyed rather than
 * returned to the pool, and Postgres drops a session's locks with it.
 */
export async function withAdvisoryLock<T>(db: Db, key: string, work: () => Promise<T>): Promise<T> {
  const client = await db.$client.connect();
  let destroy: Error | undefined;
  const asError = (error: unknown): Error =>
    error instanceof Error ? error : new Error(String(error));
  try {
    try {
      await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [key]);
    } catch (error) {
      destroy = asError(error);
      throw error;
    }
    try {
      return await work();
    } finally {
      try {
        await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [key]);
      } catch (error) {
        destroy = asError(error);
      }
    }
  } finally {
    client.release(destroy);
  }
}

/** The key two replicas share for one principal's credential rotation on one connector. */
export const credentialRotationLockKey = (connector: string, principalId: string): string =>
  `lance:credential-rotation:${connector}:${principalId}`;
