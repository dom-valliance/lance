import { briefs, type Db } from '@lance/db';
import type { BriefKind } from '@lance/shared';
import { desc, eq } from 'drizzle-orm';

/**
 * Reads generated briefs out of the `briefs` table (spec 5.1). Nothing here
 * writes and nothing here generates: the planner already wrote every row the
 * Today page shows.
 */

export interface BriefRecord {
  id: string;
  kind: BriefKind;
  correlationId: string;
  /** The structured content, parsed against its kind's schema by the router. */
  content: unknown;
  markdown: string;
  /** ISO-8601 with an explicit offset. */
  generatedAt: string;
}

export interface BriefStoreLike {
  latest(kind: BriefKind): Promise<BriefRecord | null>;
}

export function createBriefStore(db: Db): BriefStoreLike {
  return {
    async latest(kind: BriefKind): Promise<BriefRecord | null> {
      // Two briefs of one kind can share a generated_at; the id breaks the
      // tie, so "latest" is one row rather than whichever Postgres returns.
      const rows = await db
        .select()
        .from(briefs)
        .where(eq(briefs.kind, kind))
        .orderBy(desc(briefs.generatedAt), desc(briefs.id))
        .limit(1);

      const row = rows[0];
      if (row === undefined) return null;
      return {
        id: row.id,
        kind: row.kind,
        correlationId: row.correlationId,
        content: row.content,
        markdown: row.markdown,
        generatedAt: row.generatedAt.toISOString(),
      };
    },
  };
}
