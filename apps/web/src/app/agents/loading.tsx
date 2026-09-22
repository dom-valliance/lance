import { ListSkeleton, Skeleton } from '@/components/ui/skeleton';

export default function AgentsLoading() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="w-96 max-w-full" />
      </div>
      <ListSkeleton rows={2} />
      <ListSkeleton rows={4} />
      <ListSkeleton rows={4} />
    </div>
  );
}
