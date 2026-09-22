import { ListSkeleton, Skeleton } from '@/components/ui/skeleton';

/** The trail's header and its first few events while the api answers. */
export default function CorrelationLoading() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <Skeleton className="h-3 w-32" />
        <Skeleton className="h-6 w-80 max-w-full" />
      </div>
      <ListSkeleton rows={4} />
    </div>
  );
}
