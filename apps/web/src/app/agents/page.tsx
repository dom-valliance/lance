import { PageHeader } from '@/components/page-header';

export default function AgentsPage() {
  return (
    <PageHeader
      title="Agents"
      summary="Every agent and watcher with its last run, age, cursor, breaker state, error tail, cost today and over seven days, and a token chart, alongside a global cost chart."
    />
  );
}
