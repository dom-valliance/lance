import { TableSkeleton } from '@/components/data-table';
import { Skeleton } from '@/components/ui/skeleton';

/** The ledger's six columns while the api answers. */
export default function LedgerLoading() {
  return (
    <div className="flex flex-col gap-6">
      <Skeleton className="h-6 w-40" />
      <TableSkeleton
        columns={['When', 'Kind', 'Actor', 'Source system', 'Detail', 'Correlation id']}
        rows={8}
      />
    </div>
  );
}
