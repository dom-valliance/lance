/**
 * Page sizes, cursors and paging links. Pure functions, so the list pages
 * stay composition: fetch a page, render the table, render the footer.
 *
 * Every list is keyset paged. The api answers `{ items, nextCursor }` where
 * the cursor is the id of the last row shown, and the ledger pages by the
 * timestamp of its oldest event instead, in its own `to` parameter. Both
 * travel as one search param, so a page link is an ordinary link and the
 * filters in force travel with it.
 */

import { isIsoInstant, isUlid, selected, type SearchParams } from '@/lib/filters';

/**
 * How many rows each list page asks for. Proposals carry two lines of
 * preview each, so fewer of them fit a screen than of the flatter lists.
 */
export const PAGE_SIZES = {
  proposals: 25,
  ledger: 50,
  tasks: 50,
  commitments: 50,
  alerts: 50,
} as const;

/** The param a cursor travels in everywhere but the ledger, which uses `to`. */
export const CURSOR_PARAM = 'cursor';

/**
 * The cursor this request carries, or `undefined` for the first page. A
 * cursor is a ULID (a row id) or a full ISO instant (the ledger's `to`);
 * anything else is a typed or tampered URL, or, in the ledger's case, the
 * plain `YYYY-MM-DD` the filter form supplies, and the first page is served
 * rather than sending the api a value it would reject.
 */
export const cursorFrom = (
  params: SearchParams,
  name: string = CURSOR_PARAM,
): string | undefined => {
  const value = selected(params, name);
  if (value === '') return undefined;
  return isUlid(value) || isIsoInstant(value) ? value : undefined;
};

export interface PageLinksInput {
  /** The page's own path, without a query string. */
  path: string;
  params: SearchParams;
  /** The filter params to carry on to the next page, in the order they are written. */
  keep: readonly string[];
  /** The cursor the api returned, or null when this page is the last one. */
  nextCursor: string | null;
  /** The param the cursor travels in. */
  cursorParam?: string;
}

export interface PageLinks {
  /** The next page, or null when there is nothing behind this one. */
  next: string | null;
  /** The unpaged list, or null when this request is already the first page. */
  first: string | null;
}

const withQuery = (path: string, query: URLSearchParams): string => {
  const search = query.toString();
  return search === '' ? path : `${path}?${search}`;
};

/**
 * The two links under a table. The filters in force are carried on to both;
 * the cursor param never is, so changing a filter restarts the paging and
 * "Back to first page" drops the cursor alone.
 */
export function pageLinks({
  path,
  params,
  keep,
  nextCursor,
  cursorParam = CURSOR_PARAM,
}: PageLinksInput): PageLinks {
  const filters = new URLSearchParams();
  for (const name of keep) {
    if (name === cursorParam) continue;
    const value = selected(params, name);
    if (value !== '') filters.set(name, value);
  }

  const onFirstPage = cursorFrom(params, cursorParam) === undefined;
  if (nextCursor === null) {
    return { next: null, first: onFirstPage ? null : withQuery(path, filters) };
  }

  const next = new URLSearchParams(filters);
  next.set(cursorParam, nextCursor);
  return {
    next: withQuery(path, next),
    first: onFirstPage ? null : withQuery(path, filters),
  };
}

/** "25 shown", with the filters named where a page knows them. */
export function shownLabel(count: number, filterNames: readonly string[] = []): string {
  const shown = `${String(count)} shown`;
  return filterNames.length === 0 ? shown : `${shown}, filtered by ${filterNames.join(', ')}`;
}
