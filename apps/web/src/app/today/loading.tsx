import { ListSkeleton, Skeleton } from '@/components/ui/skeleton';

export default function TodayLoading() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <Skeleton className="h-6 w-56" />
        <Skeleton className="w-80 max-w-full" />
      </div>
      <ListSkeleton rows={4} />
      <ListSkeleton rows={5} />
      <ListSkeleton rows={3} />
    </div>
  );
}
