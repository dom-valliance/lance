import { briefs, type Db } from '@lance/db';
import type { BriefKind } from '@lance/shared';
import { and, desc, eq, gte, lt, type SQL } from 'drizzle-orm';

/**
 * Reads generated briefs out of the `briefs` table (spec 5.1). Nothing here
 * writes and nothing here generates: the worker already wrote every row the
 * Today page shows.
 */

export interface BriefRecord {
  id: string;
  kind: BriefKind;
  correlationId: string;
  /** The stored `jsonb`, handed on as it was written. */
  content: unknown;
  markdown: string;
  /** ISO-8601 with an explicit offset. */
  generatedAt: string;
}

export interface LatestBriefQuery {
  kind: BriefKind;
  /** Inclusive: midnight at the start of the local day being asked for. */
  from: Date;
  /** Exclusive: midnight at the start of the next local day. */
  to: Date;
}

export interface BriefQuery {
  kind?: BriefKind;
  /** Rows to return. The caller asks for one more than the page size to learn whether another page exists. */
  limit: number;
  /** The id of the last row of the previous page; rows are ordered by id, newest first. */
  cursor?: string;
}

export interface BriefStoreLike {
  /** The newest brief of a kind generated inside the window, or null. */
  latest(query: LatestBriefQuery): Promise<BriefRecord | null>;
  list(query: BriefQuery): Promise<BriefRecord[]>;
  get(id: string): Promise<BriefRecord | null>;
}

type BriefRow = typeof briefs.$inferSelect;

const toRecord = (row: BriefRow): BriefRecord => ({
  id: row.id,
  kind: row.kind,
  correlationId: row.correlationId,
  content: row.content,
  markdown: row.markdown,
  generatedAt: row.generatedAt.toISOString(),
});

export function createBriefStore(db: Db): BriefStoreLike {
  return {
    async latest(query: LatestBriefQuery): Promise<BriefRecord | null> {
      // Two briefs of one kind can share a generated_at; the id breaks the
      // tie, so "latest" is one row rather than whichever Postgres returns.
      const rows = await db
        .select()
        .from(briefs)
        .where(
          and(
            eq(briefs.kind, query.kind),
            gte(briefs.generatedAt, query.from),
            lt(briefs.generatedAt, query.to),
          ),
        )
        .orderBy(desc(briefs.generatedAt), desc(briefs.id))
        .limit(1);

      const row = rows[0];
      return row === undefined ? null : toRecord(row);
    },

    async list(query: BriefQuery): Promise<BriefRecord[]> {
      const filters: SQL[] = [];
      if (query.kind !== undefined) filters.push(eq(briefs.kind, query.kind));
      if (query.cursor !== undefined) filters.push(lt(briefs.id, query.cursor));

      const rows = await db
        .select()
        .from(briefs)
        .where(filters.length === 0 ? undefined : and(...filters))
        .orderBy(desc(briefs.id))
        .limit(query.limit);
      return rows.map(toRecord);
    },

    async get(id: string): Promise<BriefRecord | null> {
      const rows = await db.select().from(briefs).where(eq(briefs.id, id)).limit(1);
      const row = rows[0];
      return row === undefined ? null : toRecord(row);
    },
  };
}
