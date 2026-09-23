/**
 * Page sizes, cursors and paging links. Pure functions, so the list pages
 * stay composition: fetch a page, render the table, render the footer.
 *
 * Every list is keyset paged. The api answers `{ items, nextCursor, total }`
 * where the cursor is the id of the last row shown and the total counts
 * every row the filters match. The cursor travels as one search param, so a
 * page link is an ordinary link and the filters in force travel with it. A
 * keyset cursor says where a page starts, not how far in it is, so the
 * next-page link also carries `start`, the 1-based position of its first
 * row, for the footer to say "Showing 51 to 100 of 109". It is not `from`,
 * which the ledger's date filter already uses.
 */

import { isUlid, selected, type SearchParams } from '@/lib/filters';

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

/** The param a cursor travels in. */
export const CURSOR_PARAM = 'cursor';

/** The param carrying the 1-based position of a page's first row. */
export const POSITION_PARAM = 'start';

/**
 * The cursor this request carries, or `undefined` for the first page. A
 * cursor is a row id; anything else is a typed or tampered URL, and the
 * first page is served rather than sending the api a value it would reject.
 */
export const cursorFrom = (params: SearchParams): string | undefined => {
  const value = selected(params, CURSOR_PARAM);
  return isUlid(value) ? value : undefined;
};

/**
 * The position of this page's first row. The first page is always 1; a
 * later page reads `start`, and a missing, fractional or non-positive value
 * is a typed or tampered URL, so it reads as 1 rather than a position the
 * footer would have to explain.
 */
export const positionFrom = (params: SearchParams): number => {
  if (cursorFrom(params) === undefined) return 1;
  const raw = selected(params, POSITION_PARAM);
  if (!/^\d+$/.test(raw)) return 1;
  const position = Number(raw);
  return Number.isSafeInteger(position) && position >= 1 ? position : 1;
};

export interface PageLinksInput {
  /** The page's own path, without a query string. */
  path: string;
  params: SearchParams;
  /** The filter params to carry on to the next page, in the order they are written. */
  keep: readonly string[];
  /** The cursor the api returned, or null when this page is the last one. */
  nextCursor: string | null;
  /** Rows on this page; the next link starts at this page's position plus these. */
  shown: number;
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
 * the cursor and the position never are, so changing a filter restarts the
 * paging and "Back to first page" drops them alone.
 */
export function pageLinks({ path, params, keep, nextCursor, shown }: PageLinksInput): PageLinks {
  const filters = new URLSearchParams();
  for (const name of keep) {
    if (name === CURSOR_PARAM || name === POSITION_PARAM) continue;
    const value = selected(params, name);
    if (value !== '') filters.set(name, value);
  }

  const onFirstPage = cursorFrom(params) === undefined;
  if (nextCursor === null) {
    return { next: null, first: onFirstPage ? null : withQuery(path, filters) };
  }

  const next = new URLSearchParams(filters);
  next.set(CURSOR_PARAM, nextCursor);
  next.set(POSITION_PARAM, String(positionFrom(params) + shown));
  return {
    next: withQuery(path, next),
    first: onFirstPage ? null : withQuery(path, filters),
  };
}

const count = new Intl.NumberFormat('en-GB');

const filteredBy = (sentence: string, filterNames: readonly string[]): string =>
  filterNames.length === 0 ? sentence : `${sentence}, filtered by ${filterNames.join(', ')}`;

export interface PageSummaryInput {
  /** The 1-based position of the first row, from `positionFrom`. */
  from: number;
  /** Rows on this page. */
  shown: number;
  /** Every row the filters match, from the api. */
  total: number;
  /** The filters in force, in plain words, where a page names them. */
  filterNames?: readonly string[];
}

/**
 * The footer sentence for a list with a stable total: "Showing 51 to 100 of
 * 109", or "Nothing to show" for an empty page. A row that arrived between
 * the page read and the count cannot make the last row outrun the total.
 */
export function pageSummary({ from, shown, total, filterNames = [] }: PageSummaryInput): string {
  if (shown === 0) return filteredBy('Nothing to show', filterNames);
  const to = from + shown - 1;
  const of = Math.max(total, to);
  return filteredBy(
    `Showing ${count.format(from)} to ${count.format(to)} of ${count.format(of)}`,
    filterNames,
  );
}
