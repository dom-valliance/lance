import { Skeleton } from '@/components/ui/skeleton';

function CardSkeleton({ rows }: { rows: number }) {
  return (
    <div
      aria-busy="true"
      aria-label="Loading"
      className="flex flex-col gap-4 rounded-xl bg-card p-6"
    >
      <Skeleton className="h-4 w-32" />
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className={index % 2 === 0 ? 'w-[80%]' : 'w-[55%]'} />
      ))}
    </div>
  );
}

export default function ProposalLoading() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <Skeleton className="h-3 w-36" />
        <Skeleton className="h-6 w-[60%]" />
      </div>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_400px] lg:items-start">
        <CardSkeleton rows={4} />
        <CardSkeleton rows={3} />
      </div>
    </div>
  );
}
