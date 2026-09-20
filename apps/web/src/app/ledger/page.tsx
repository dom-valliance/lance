import { PageHeading } from '@/components/page-heading';

export default function LedgerPage() {
  return (
    <PageHeading
      title="Ledger"
      description="Ledger events filterable by kind, actor, system and date, with the ability to follow a correlation id end to end and export a date range."
    />
  );
}
