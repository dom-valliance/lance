import type { LedgerCountQuery, LedgerEventRow } from '@lance/ledger';
import type { ApiDeps } from '../deps.js';

/**
 * The Ledger page's list read (spec 12). Events are ordered `ts desc, id
 * desc` and keyset paged by the id of the oldest event shown; the reader
 * continues strictly after that event, so events that share an instant are
 * neither repeated nor skipped. `to` is only the date filter from the form.
 */

export type LedgerDeps = Pick<ApiDeps, 'ledger'>;

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

export interface ListLedgerInput extends LedgerCountQuery {
  limit?: number;
  /** The id of the oldest event on the previous page. */
  cursor?: string;
}

export interface LedgerPage {
  items: LedgerEventRow[];
  /** The id of the oldest event shown, or null when nothing lies behind this page. */
  nextCursor: string | null;
  /** Every event the filters match, across all pages; the cursor does not narrow it. */
  total: number;
}

export async function listLedger(
  deps: LedgerDeps,
  input: ListLedgerInput = {},
): Promise<LedgerPage> {
  const size = Math.min(input.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const filter: LedgerCountQuery = {
    ...(input.kind === undefined ? {} : { kind: input.kind }),
    ...(input.actor === undefined ? {} : { actor: input.actor }),
    ...(input.sourceSystem === undefined ? {} : { sourceSystem: input.sourceSystem }),
    ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
    ...(input.from === undefined ? {} : { from: input.from }),
    ...(input.to === undefined ? {} : { to: input.to }),
  };
  // A cursor naming no event is a stale or tampered link: serve the first page.
  const cursor = input.cursor === undefined ? null : await deps.ledger.get(input.cursor);
  // One row beyond the page tells us whether a next page exists; the count
  // runs beside it over the filters alone.
  const [rows, total] = await Promise.all([
    deps.ledger.query({
      ...filter,
      limit: size + 1,
      ...(cursor === null ? {} : { after: cursor.id }),
    }),
    deps.ledger.count(filter),
  ]);
  const page = rows.slice(0, size);
  const nextCursor = rows.length > size ? (page.at(-1)?.id ?? null) : null;
  return { items: page, nextCursor, total };
}
