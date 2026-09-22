import { TableSkeleton } from '@/components/data-table';
import { Skeleton } from '@/components/ui/skeleton';

export default function ProposalsLoading() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="w-72 max-w-full" />
      </div>
      <TableSkeleton
        columns={['Preview', 'Action class', 'Counterparty', 'System', 'Status', 'Expires']}
        rows={5}
      />
    </div>
  );
}
