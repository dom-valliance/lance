import Link from 'next/link';
import { LiveRefresh } from '@/components/live-refresh';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  ACTION_CLASSES,
  PROPOSAL_STATUSES,
  proposalFilterFrom,
  selected,
  SYSTEMS,
  type SearchParams,
} from '@/lib/filters';
import { formatInstant } from '@/lib/proposal-view';
import { apiClient } from '@/lib/trpc';

export const dynamic = 'force-dynamic';

const SELECT_CLASS =
  'h-8 rounded-lg border border-input bg-background px-2 text-sm text-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50';

function FilterSelect({
  name,
  label,
  options,
  value,
}: {
  name: string;
  label: string;
  options: readonly string[];
  value: string;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
      {label}
      <select name={name} defaultValue={value} className={SELECT_CLASS}>
        <option value="">Any</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}

export default async function ProposalsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const client = await apiClient();
  const proposals = await client.proposals.list.query(proposalFilterFrom(params));

  return (
    <div className="flex flex-col gap-6">
      <LiveRefresh streamUrl="/api/events" watch="proposal" />

      <Card>
        <CardHeader>
          <CardTitle className="text-2xl">Proposals</CardTitle>
        </CardHeader>
        <CardContent>
          <form method="get" className="flex flex-wrap items-end gap-3">
            <FilterSelect
              name="status"
              label="Status"
              options={PROPOSAL_STATUSES}
              value={selected(params, 'status')}
            />
            <FilterSelect
              name="actionClass"
              label="Action class"
              options={ACTION_CLASSES}
              value={selected(params, 'actionClass')}
            />
            <FilterSelect
              name="system"
              label="System"
              options={SYSTEMS}
              value={selected(params, 'system')}
            />
            <Button type="submit">Apply filters</Button>
            <Button asChild variant="ghost">
              <Link href="/proposals">Clear</Link>
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="overflow-x-auto">
          {proposals.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No proposals match these filters. Clear them to see the whole queue.
            </p>
          ) : (
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Proposals, newest first</caption>
              <thead className="text-xs text-muted-foreground">
                <tr>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Preview
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Action class
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Counterparty
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    System
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Status
                  </th>
                  <th scope="col" className="py-2 font-medium">
                    Expires
                  </th>
                </tr>
              </thead>
              <tbody>
                {proposals.map((proposal) => (
                  <tr key={proposal.id} className="border-t border-border">
                    <td className="py-2 pr-4">
                      <Link
                        href={`/proposals/${proposal.id}`}
                        className="underline underline-offset-4 hover:text-primary"
                      >
                        {proposal.preview}
                      </Link>
                    </td>
                    <td className="py-2 pr-4">{proposal.actionClass}</td>
                    <td className="py-2 pr-4">{proposal.counterpartyClass}</td>
                    <td className="py-2 pr-4">{proposal.targetSystem}</td>
                    <td className="py-2 pr-4">
                      <Badge variant={proposal.status === 'pending' ? 'default' : 'secondary'}>
                        {proposal.status}
                      </Badge>
                    </td>
                    <td className="py-2">{formatInstant(proposal.expiresAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
