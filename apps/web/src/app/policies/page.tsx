import { PageHeading } from '@/components/page-heading';

export default function PoliciesPage() {
  return (
    <PageHeading
      title="Policies"
      description="A matrix of policy cells and their current decision, a rule history and evidence view per cell, a validated rule editor with hard floors shown as locked, and a shadow run form with diff output."
    />
  );
}
