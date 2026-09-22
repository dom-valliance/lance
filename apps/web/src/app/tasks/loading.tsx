import { TableSkeleton } from '@/components/data-table';

/** The seven Tasks columns, repeated here so the skeleton pulls in no server code. */
const COLUMNS = ['Title', 'Source', 'Due', 'Assignee', 'Meeting', 'Link', 'Complete'];

export default function TasksLoading() {
  return (
    <div className="flex flex-col gap-6">
      <TableSkeleton columns={COLUMNS} rows={4} />
    </div>
  );
}
