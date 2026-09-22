import { ListSkeleton, Skeleton } from '@/components/ui/skeleton';

/** The header and the four cards, while the status snapshot is still in flight. */
export default function SettingsLoading() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="w-[55%]" />
      </div>
      <div className="grid items-start gap-6 lg:grid-cols-2">
        <ListSkeleton rows={4} />
        <ListSkeleton rows={3} />
        <ListSkeleton rows={4} />
        <ListSkeleton rows={3} />
      </div>
    </div>
  );
}
