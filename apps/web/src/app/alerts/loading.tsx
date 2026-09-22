import { TableSkeleton } from '@/components/data-table';

/** The eight Alerts columns, repeated here so the skeleton pulls in no server code. */
const COLUMNS = [
  'Severity',
  'Kind',
  'Alert',
  'Count',
  'First seen',
  'Last seen',
  'Provenance',
  'Actions',
];

export default function AlertsLoading() {
  return (
    <div className="flex flex-col gap-6">
      <TableSkeleton columns={COLUMNS} rows={5} />
    </div>
  );
}
