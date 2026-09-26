import {
  commitmentNotes,
  commitments,
  newestObservationFirst,
  observations,
  type Commitment,
  type CommitmentNote,
  type Db,
} from '@lance/db';
import { and, asc, count, desc, eq, inArray, lt, or, sql, type SQL } from 'drizzle-orm';

/**
 * The Commitments page's reads and writes. The api sets the status, the
 * principal's edits to the description and due date, and the principal's
 * notes; everything else about a commitment is written by the worker when
 * it records or chases one. The source records behind a commitment are
 * read from `observations`, never fetched from the source system.
 */

export interface CommitmentQuery {
  direction?: Commitment['direction'];
  status?: Commitment['status'];
  /** Rows to return. The caller asks for one more than the page size to learn whether another page exists. */
  limit: number;
  /** The id of the last row of the previous page; rows are ordered by id, newest first. */
  cursor?: string;
}

/** The filters a count honours: the list's, without the page it would cut. */
export type CommitmentCountQuery = Omit<CommitmentQuery, 'limit' | 'cursor'>;

/** Open and overdue counts for one direction; overdue is open with a due date already past. */
export interface CommitmentTally {
  open: number;
  overdue: number;
}

export interface CommitmentSummary {
  inbound: CommitmentTally;
  outbound: CommitmentTally;
}

/** The columns the principal may change by hand (ADR 0036). */
export interface CommitmentEdit {
  description?: string;
  dueAt?: Date | null;
  dueConfidence?: number | null;
  nextChaseAt?: Date | null;
}

/** One source record a commitment cites, as its provenance names it. */
export interface SourceKey {
  system: string;
  recordId: string;
}

/** The newest observation of one cited source record. */
export interface SourceObservation {
  sourceSystem: string;
  sourceRecordId: string;
  ts: Date;
  summary: string | null;
  /** Null once retention has passed over it. */
  payload: unknown;
}

export interface CommitmentStoreLike {
  list(query: CommitmentQuery): Promise<Commitment[]>;
  /** Every row `list` would return across all its pages. */
  count(query: CommitmentCountQuery): Promise<number>;
  /** The page header's numbers, counted in SQL rather than from a page of rows. */
  summary(now: Date): Promise<CommitmentSummary>;
  get(id: string): Promise<Commitment | null>;
  /** Sets the status of a commitment that is still in `from`, and returns the row as it now stands. */
  setStatus(input: {
    id: string;
    from: Commitment['status'][];
    to: Commitment['status'];
    at: Date;
  }): Promise<Commitment | null>;
  /**
   * Applies the principal's edit to a row not changed since `unchangedSince`,
   * and returns the row as it now stands, or null when it has moved on.
   */
  update(input: {
    id: string;
    set: CommitmentEdit;
    unchangedSince: Date;
    at: Date;
  }): Promise<Commitment | null>;
  /** The commitment's notes, oldest first. */
  notes(commitmentId: string): Promise<CommitmentNote[]>;
  addNote(input: {
    id: string;
    commitmentId: string;
    body: string;
    author: string;
  }): Promise<CommitmentNote>;
  /**
   * The newest observation of each cited record that the source had not
   * removed. A record never observed in this scope is absent from the result.
   */
  sources(keys: readonly SourceKey[]): Promise<SourceObservation[]>;
}

/** The WHERE clauses `list` and `count` share, so the two cannot drift apart. */
function filtersFor(query: CommitmentCountQuery): SQL[] {
  const filters: SQL[] = [];
  if (query.direction !== undefined) filters.push(eq(commitments.direction, query.direction));
  if (query.status !== undefined) filters.push(eq(commitments.status, query.status));
  return filters;
}

export function createCommitmentStore(db: Db): CommitmentStoreLike {
  return {
    async list(query: CommitmentQuery): Promise<Commitment[]> {
      const filters = filtersFor(query);
      if (query.cursor !== undefined) filters.push(lt(commitments.id, query.cursor));

      return db
        .select()
        .from(commitments)
        .where(filters.length === 0 ? undefined : and(...filters))
        .orderBy(desc(commitments.id))
        .limit(query.limit);
    },

    async count(query: CommitmentCountQuery): Promise<number> {
      const filters = filtersFor(query);
      const rows = await db
        .select({ total: count() })
        .from(commitments)
        .where(filters.length === 0 ? undefined : and(...filters));
      return rows[0]?.total ?? 0;
    },

    async summary(now: Date): Promise<CommitmentSummary> {
      const rows = await db
        .select({
          direction: commitments.direction,
          open: count(),
          overdue:
            sql<number>`count(*) filter (where ${commitments.dueAt} < ${now.toISOString()}::timestamptz)`.mapWith(
              Number,
            ),
        })
        .from(commitments)
        .where(eq(commitments.status, 'open'))
        .groupBy(commitments.direction);

      const tally = (direction: Commitment['direction']): CommitmentTally => {
        const row = rows.find((candidate) => candidate.direction === direction);
        return { open: row?.open ?? 0, overdue: row?.overdue ?? 0 };
      };
      return { inbound: tally('inbound'), outbound: tally('outbound') };
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

    async update(input): Promise<Commitment | null> {
      // `updatedAt` in the WHERE clause stops an edit read before a chase
      // landed from writing back the chase's next date. Postgres keeps
      // microseconds and a JavaScript Date milliseconds, so the stored value
      // is compared at the precision the reader saw.
      const rows = await db
        .update(commitments)
        .set({ ...input.set, updatedAt: input.at })
        .where(
          and(
            eq(commitments.id, input.id),
            sql`date_trunc('milliseconds', ${commitments.updatedAt}) = ${input.unchangedSince.toISOString()}::timestamptz`,
          ),
        )
        .returning();
      return rows[0] ?? null;
    },

    async notes(commitmentId: string): Promise<CommitmentNote[]> {
      return db
        .select()
        .from(commitmentNotes)
        .where(eq(commitmentNotes.commitmentId, commitmentId))
        .orderBy(asc(commitmentNotes.id));
    },

    async addNote(input): Promise<CommitmentNote> {
      const rows = await db.insert(commitmentNotes).values(input).returning();
      const note = rows[0];
      if (note === undefined) {
        throw new Error(
          `The note on commitment ${input.commitmentId} was not stored. Check the api logs for a database error.`,
        );
      }
      return note;
    },

    async sources(keys: readonly SourceKey[]): Promise<SourceObservation[]> {
      if (keys.length === 0) return [];
      const cited = or(
        ...keys.map((key) =>
          and(
            eq(observations.sourceSystem, key.system),
            eq(observations.sourceRecordId, key.recordId),
          ),
        ),
      );
      return db
        .selectDistinctOn([observations.sourceRecordId], {
          sourceSystem: observations.sourceSystem,
          sourceRecordId: observations.sourceRecordId,
          ts: observations.ts,
          summary: observations.summary,
          payload: observations.payload,
        })
        .from(observations)
        .where(and(cited, sql`coalesce(${observations.payload}->>'removed', 'false') <> 'true'`))
        .orderBy(...newestObservationFirst());
    },
  };
}
