import { commitments, type Commitment, type Db } from '@lance/db';
import { and, desc, eq, inArray, lt, type SQL } from 'drizzle-orm';

/**
 * The Commitments page's reads and its two writes. Status is the only
 * column the api sets: everything else about a commitment is written by the
 * worker when it records or chases one.
 */

export interface CommitmentQuery {
  direction?: Commitment['direction'];
  status?: Commitment['status'];
  /** Rows to return. The caller asks for one more than the page size to learn whether another page exists. */
  limit: number;
  /** The id of the last row of the previous page; rows are ordered by id, newest first. */
  cursor?: string;
}

export interface CommitmentStoreLike {
  list(query: CommitmentQuery): Promise<Commitment[]>;
  get(id: string): Promise<Commitment | null>;
  /** Sets the status of a commitment that is still in `from`, and returns the row as it now stands. */
  setStatus(input: {
    id: string;
    from: Commitment['status'][];
    to: Commitment['status'];
    at: Date;
  }): Promise<Commitment | null>;
}

export function createCommitmentStore(db: Db): CommitmentStoreLike {
  return {
    async list(query: CommitmentQuery): Promise<Commitment[]> {
      const filters: SQL[] = [];
      if (query.direction !== undefined) {
        filters.push(eq(commitments.direction, query.direction));
      }
      if (query.status !== undefined) filters.push(eq(commitments.status, query.status));
      if (query.cursor !== undefined) filters.push(lt(commitments.id, query.cursor));

      return db
        .select()
        .from(commitments)
        .where(filters.length === 0 ? undefined : and(...filters))
        .orderBy(desc(commitments.id))
        .limit(query.limit);
    },

    async get(id: string): Promise<Commitment | null> {
      const rows = await db.select().from(commitments).where(eq(commitments.id, id)).limit(1);
      return rows[0] ?? null;
    },

    async setStatus(input): Promise<Commitment | null> {
      // The `from` statuses are part of the WHERE clause, so two decisions
      // racing each other cannot both append a ledger event.
      const rows = await db
        .update(commitments)
        .set({ status: input.to, updatedAt: input.at })
        .where(and(eq(commitments.id, input.id), inArray(commitments.status, input.from)))
        .returning();
      return rows[0] ?? null;
    },
  };
}
