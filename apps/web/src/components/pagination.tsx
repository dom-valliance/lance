import { TableFooterBar } from '@/components/data-table';
import { TextLink } from '@/components/text-link';
import type { PageLinks } from '@/lib/pagination';

/**
 * The footer every list page shares: what is on the page, the way to the
 * next one, and the way back to the first once a cursor is in force. Plain
 * links and no client state, so a page of rows is a URL that can be shared
 * and the back button does what it says.
 */

export interface PaginationProps extends PageLinks {
  /** The sentence on the left: "25 shown", with the filters where a page names them. */
  summary: string;
  /** What the link to the next page says. The lists read newest first, so most say "Show older". */
  nextLabel?: string;
  className?: string | undefined;
}

export function Pagination({
  summary,
  next,
  first,
  nextLabel = 'Show more',
  className,
}: PaginationProps) {
  return (
    <TableFooterBar className={className}>
      <span>{summary}</span>
      <span className="flex flex-wrap items-center gap-4">
        {first === null ? null : <TextLink href={first}>Back to first page</TextLink>}
        {next === null ? (
          <span>That is everything</span>
        ) : (
          <TextLink href={next}>{nextLabel}</TextLink>
        )}
      </span>
    </TableFooterBar>
  );
}
