import { TableSkeleton } from '@/components/data-table';

/** The six Commitments columns, repeated here so the skeleton pulls in no server code. */
const COLUMNS = ['Commitment', 'Counterparty', 'Due', 'Chased', 'Provenance', 'Actions'];

export default function CommitmentsLoading() {
  return (
    <div className="flex flex-col gap-6">
      <TableSkeleton columns={COLUMNS} rows={4} />
    </div>
  );
}
