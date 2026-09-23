import type { PendingProposalSummary, ProposalCountFilter, ProposalFilter } from '@lance/ledger';
import type { Proposal } from '@lance/shared';
import type { ApiDeps } from '../deps.js';

/**
 * The Proposals page's reads (spec 12). The store returns rows; this adds
 * the keyset page the page needs, so proposals answer the same
 * `{ items, nextCursor, total }` shape as alerts, commitments and tasks,
 * and the header's pending summary.
 */

export type ProposalDeps = Pick<ApiDeps, 'proposals'>;

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

export interface ProposalPage {
  items: Proposal[];
  nextCursor: string | null;
  /** Every proposal the filters match, across all pages. */
  total: number;
}

export async function listProposals(
  deps: ProposalDeps,
  filter: ProposalFilter = {},
): Promise<ProposalPage> {
  const size = Math.min(filter.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const countFilter: ProposalCountFilter = {
    ...(filter.status === undefined ? {} : { status: filter.status }),
    ...(filter.actionClass === undefined ? {} : { actionClass: filter.actionClass }),
    ...(filter.counterpartyClass === undefined
      ? {}
      : { counterpartyClass: filter.counterpartyClass }),
    ...(filter.targetSystem === undefined ? {} : { targetSystem: filter.targetSystem }),
  };
  // One row beyond the page tells us whether a next page exists. At the
  // maximum page size the store's own cap swallows that row, so a full
  // 200-row page reports no next page; the pages that read a cursor ask for
  // far fewer. The count runs beside it over the same filters, without the
  // cursor.
  const [rows, total] = await Promise.all([
    deps.proposals.list({ ...filter, limit: size + 1 }),
    deps.proposals.count(countFilter),
  ]);
  const page = rows.slice(0, size);
  const nextCursor = rows.length > size ? (page.at(-1)?.id ?? null) : null;
  return { items: page, nextCursor, total };
}

/** How many proposals are pending and when the soonest of them expires. */
export async function proposalSummary(deps: ProposalDeps): Promise<PendingProposalSummary> {
  return deps.proposals.summary();
}
