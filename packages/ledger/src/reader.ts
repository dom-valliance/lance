import { ledgerEvents } from '@lance/db';
import type { DbExecutor } from './writer.js';
import type { LedgerKind } from '@lance/shared';
import { and, asc, count, desc, eq, gte, lte, sql, type SQL } from 'drizzle-orm';

export interface LedgerQuery {
  kind?: LedgerKind;
  actor?: string;
  sourceSystem?: string;
  correlationId?: string;
  from?: string;
  to?: string;
  /**
   * The id of the oldest event on the previous page. The query continues
   * strictly after it in `ts desc, id desc` order, so events that share an
   * instant are neither repeated nor skipped across a page boundary.
   */
  after?: string;
  limit?: number;
}

/** The filters a count honours: the query's, without the keyset position or the row limit. */
export type LedgerCountQuery = Omit<LedgerQuery, 'after' | 'limit'>;

export type LedgerEventRow = typeof ledgerEvents.$inferSelect;

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 2000;

/** The WHERE clauses `query` and `count` share, so the two cannot drift apart. */
function clausesFor(filter: Omit<LedgerQuery, 'limit'>): SQL[] {
  const clauses: SQL[] = [];
  if (filter.kind !== undefined) clauses.push(eq(ledgerEvents.kind, filter.kind));
  if (filter.actor !== undefined) clauses.push(eq(ledgerEvents.actor, filter.actor));
  if (filter.sourceSystem !== undefined)
    clauses.push(eq(ledgerEvents.sourceSystem, filter.sourceSystem));
  if (filter.correlationId !== undefined)
    clauses.push(eq(ledgerEvents.correlationId, filter.correlationId));
  if (filter.from !== undefined) clauses.push(gte(ledgerEvents.ts, new Date(filter.from)));
  if (filter.to !== undefined) clauses.push(lte(ledgerEvents.ts, new Date(filter.to)));
  if (filter.after !== undefined) {
    // The cursor's instant is read in SQL rather than round-tripped through
    // a JavaScript Date, which would drop anything finer than a millisecond
    // and break the tie on `ts`.
    const cursorTs = sql`(select ${ledgerEvents.ts} from ${ledgerEvents} where ${ledgerEvents.id} = ${filter.after})`;
    clauses.push(
      sql`(${ledgerEvents.ts} < ${cursorTs} or (${ledgerEvents.ts} = ${cursorTs} and ${ledgerEvents.id} < ${filter.after}))`,
    );
  }
  return clauses;
}

/** Read side of the ledger. Every filter is optional; results are newest first. */
export class LedgerReader {
  constructor(private readonly db: DbExecutor) {}

  /** One event by id, or null when no event carries it. */
  async get(id: string): Promise<LedgerEventRow | null> {
    const rows = await this.db.select().from(ledgerEvents).where(eq(ledgerEvents.id, id)).limit(1);
    return rows[0] ?? null;
  }

  async byCorrelation(correlationId: string): Promise<LedgerEventRow[]> {
    return this.db
      .select()
      .from(ledgerEvents)
      .where(eq(ledgerEvents.correlationId, correlationId))
      .orderBy(asc(ledgerEvents.ts), asc(ledgerEvents.id));
  }

  async query(filter: LedgerQuery = {}): Promise<LedgerEventRow[]> {
    const clauses = clausesFor(filter);
    const limit = Math.min(filter.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

    return this.db
      .select()
      .from(ledgerEvents)
      .where(clauses.length > 0 ? and(...clauses) : undefined)
      .orderBy(desc(ledgerEvents.ts), desc(ledgerEvents.id))
      .limit(limit);
  }

  /** Every event `query` would match with no row limit. */
  async count(filter: LedgerCountQuery = {}): Promise<number> {
    const clauses = clausesFor(filter);
    const rows = await this.db
      .select({ total: count() })
      .from(ledgerEvents)
      .where(clauses.length > 0 ? and(...clauses) : undefined);
    return rows[0]?.total ?? 0;
  }
}
