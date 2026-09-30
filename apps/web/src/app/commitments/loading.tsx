import { Skeleton } from '@/components/ui/skeleton';

/** The board's loading state (design 7.5): a pulsing block per column, per lane. */
export default function CommitmentsLoading() {
  return (
    <div aria-busy="true" aria-label="Loading" className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-4 w-[55%]" />
      </div>
      {[0, 1].map((lane) => (
        <div key={lane} className="grid grid-cols-1 gap-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((column) => (
            <Skeleton key={column} className="h-22 rounded-lg" />
          ))}
        </div>
      ))}
    </div>
  );
}
