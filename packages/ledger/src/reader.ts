import type { Db } from '@lance/db';
import { ledgerEvents } from '@lance/db';
import type { LedgerKind } from '@lance/shared';
import { and, asc, desc, eq, gte, lte, type SQL } from 'drizzle-orm';

export interface LedgerQuery {
  kind?: LedgerKind;
  actor?: string;
  sourceSystem?: string;
  correlationId?: string;
  from?: string;
  to?: string;
  limit?: number;
}

export type LedgerEventRow = typeof ledgerEvents.$inferSelect;

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 2000;

/** Read side of the ledger. Every filter is optional; results are newest first. */
export class LedgerReader {
  constructor(private readonly db: Db) {}

  async byCorrelation(correlationId: string): Promise<LedgerEventRow[]> {
    return this.db
      .select()
      .from(ledgerEvents)
      .where(eq(ledgerEvents.correlationId, correlationId))
      .orderBy(asc(ledgerEvents.ts), asc(ledgerEvents.id));
  }

  async query(filter: LedgerQuery = {}): Promise<LedgerEventRow[]> {
    const clauses: SQL[] = [];
    if (filter.kind !== undefined) clauses.push(eq(ledgerEvents.kind, filter.kind));
    if (filter.actor !== undefined) clauses.push(eq(ledgerEvents.actor, filter.actor));
    if (filter.sourceSystem !== undefined)
      clauses.push(eq(ledgerEvents.sourceSystem, filter.sourceSystem));
    if (filter.correlationId !== undefined)
      clauses.push(eq(ledgerEvents.correlationId, filter.correlationId));
    if (filter.from !== undefined) clauses.push(gte(ledgerEvents.ts, new Date(filter.from)));
    if (filter.to !== undefined) clauses.push(lte(ledgerEvents.ts, new Date(filter.to)));
    const limit = Math.min(filter.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

    return this.db
      .select()
      .from(ledgerEvents)
      .where(clauses.length > 0 ? and(...clauses) : undefined)
      .orderBy(desc(ledgerEvents.ts), desc(ledgerEvents.id))
      .limit(limit);
  }
}
