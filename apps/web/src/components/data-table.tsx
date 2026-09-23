import type { ComponentProps, ReactNode } from 'react';
import { cn } from 'cn';

/**
 * The table shape every list page shares: a card with the table inside,
 * 12px muted header labels, hairline rows, cells at 12 by 16 with 24 at
 * the outer edges. A row can carry an accent bar (pending, held, overdue)
 * or be muted (decided, done), and `liveId` lets the live-update flash
 * find it.
 */

export function TableCard({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('overflow-hidden rounded-xl bg-card', className)}>{children}</div>;
}

export function Table({
  caption,
  className,
  children,
  ...props
}: ComponentProps<'table'> & { caption?: string }) {
  return (
    <div className="overflow-x-auto">
      <table className={cn('w-full border-collapse text-left text-sm', className)} {...props}>
        {caption === undefined ? null : <caption className="sr-only">{caption}</caption>}
        {children}
      </table>
    </div>
  );
}

export function Th({ className, ...props }: ComponentProps<'th'>) {
  return (
    <th
      scope="col"
      className={cn(
        'px-4 py-3 text-xs font-medium text-muted-foreground first:pl-6 last:pr-6',
        className,
      )}
      {...props}
    />
  );
}

export type RowAccent = 'brand' | 'pink' | 'red';

const ACCENT_CLASS: Record<RowAccent, string> = {
  brand: 'shadow-[inset_2px_0_0_var(--brand)]',
  pink: 'shadow-[inset_2px_0_0_var(--sem-pink-fg)]',
  red: 'shadow-[inset_2px_0_0_var(--sem-red-fg)]',
};

export function Tr({
  accent,
  muted = false,
  liveId,
  className,
  ...props
}: ComponentProps<'tr'> & { accent?: RowAccent; muted?: boolean; liveId?: string }) {
  return (
    <tr
      data-live-id={liveId}
      className={cn(
        // A light wash under the pointer, so the eye keeps its row while
        // reading across; the accent bar and muted text stay as they are.
        'border-t border-border transition-colors hover:bg-muted/50',
        accent !== undefined && ACCENT_CLASS[accent],
        muted && 'text-muted-foreground',
        className,
      )}
      {...props}
    />
  );
}

export function Td({ className, ...props }: ComponentProps<'td'>) {
  return <td className={cn('px-4 py-3 align-top first:pl-6 last:pr-6', className)} {...props} />;
}

/** The count and paging line under a table ("9 of 61", "Show older"). */
export function TableFooterBar({
  children,
  className,
}: {
  children: ReactNode;
  className?: string | undefined;
}) {
  return (
    <div
      className={cn(
        'flex items-center justify-between gap-4 border-t border-border px-6 py-3 text-xs text-muted-foreground',
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Column headings and pulsing bars while the rows stream in. */
export function TableSkeleton({ columns, rows = 3 }: { columns: string[]; rows?: number }) {
  return (
    <TableCard>
      <Table aria-busy="true" aria-label="Loading">
        <thead>
          <tr>
            {columns.map((column) => (
              <Th key={column}>{column}</Th>
            ))}
          </tr>
        </thead>
        <tbody className="animate-pulse">
          {Array.from({ length: rows }, (_, row) => (
            <Tr key={row}>
              {columns.map((column, index) => (
                <Td key={column} className="py-4">
                  <div
                    aria-hidden
                    className={cn(
                      'h-3 rounded bg-muted',
                      index === 0 ? 'w-64 max-w-full' : 'w-20 max-w-full',
                    )}
                  />
                </Td>
              ))}
            </Tr>
          ))}
        </tbody>
      </Table>
    </TableCard>
  );
}
