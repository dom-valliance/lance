import type { ProposalFilter } from '@lance/ledger';
import type { Proposal } from '@lance/shared';
import type { ApiDeps } from '../deps.js';

/**
 * The Proposals page's list read (spec 12). The store returns rows; this
 * adds the keyset page the page needs, so proposals answer the same
 * `{ items, nextCursor }` shape as alerts, commitments and tasks.
 */

export type ProposalDeps = Pick<ApiDeps, 'proposals'>;

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

export interface ProposalPage {
  items: Proposal[];
  nextCursor: string | null;
}

export async function listProposals(
  deps: ProposalDeps,
  filter: ProposalFilter = {},
): Promise<ProposalPage> {
  const size = Math.min(filter.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  // One row beyond the page tells us whether a next page exists without a
  // count. At the maximum page size the store's own cap swallows that row,
  // so a full 200-row page reports no next page; the pages that read a
  // cursor ask for far fewer, and a 200 read is a count rather than a page.
  const rows = await deps.proposals.list({ ...filter, limit: size + 1 });
  const page = rows.slice(0, size);
  const nextCursor = rows.length > size ? (page.at(-1)?.id ?? null) : null;
  return { items: page, nextCursor };
}
