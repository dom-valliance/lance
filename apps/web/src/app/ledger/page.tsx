import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  LEDGER_KINDS,
  ledgerFilterFrom,
  selected,
  SOURCE_SYSTEMS,
  type SearchParams,
} from '@/lib/filters';
import { formatInstant } from '@/lib/proposal-view';
import { apiClient } from '@/lib/trpc';

export const dynamic = 'force-dynamic';

const FIELD_CLASS =
  'h-8 rounded-lg border border-input bg-background px-2 text-sm text-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50';

export default async function LedgerPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const client = await apiClient();
  const events = await client.ledger.query.query(ledgerFilterFrom(params));

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-2xl">Ledger</CardTitle>
        </CardHeader>
        <CardContent>
          <form method="get" className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              Kind
              <select name="kind" defaultValue={selected(params, 'kind')} className={FIELD_CLASS}>
                <option value="">Any</option>
                {LEDGER_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {kind}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              Actor
              <input
                name="actor"
                defaultValue={selected(params, 'actor')}
                placeholder="user:dom"
                className={FIELD_CLASS}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              Source system
              <select
                name="sourceSystem"
                defaultValue={selected(params, 'sourceSystem')}
                className={FIELD_CLASS}
              >
                <option value="">Any</option>
                {SOURCE_SYSTEMS.map((system) => (
                  <option key={system} value={system}>
                    {system}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              From
              <input
                type="date"
                name="from"
                defaultValue={selected(params, 'from')}
                className={FIELD_CLASS}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              To
              <input
                type="date"
                name="to"
                defaultValue={selected(params, 'to')}
                className={FIELD_CLASS}
              />
            </label>
            <Button type="submit">Apply filters</Button>
            <Button asChild variant="ghost">
              <Link href="/ledger">Clear</Link>
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="overflow-x-auto">
          {events.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No events match these filters. Clear them to see the whole ledger.
            </p>
          ) : (
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Ledger events, newest first</caption>
              <thead className="text-xs text-muted-foreground">
                <tr>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    When
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Kind
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Actor
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Source system
                  </th>
                  <th scope="col" className="py-2 font-medium">
                    Correlation id
                  </th>
                </tr>
              </thead>
              <tbody>
                {events.map((event) => (
                  <tr key={event.id} className="border-t border-border">
                    <td className="py-2 pr-4">{formatInstant(event.ts)}</td>
                    <td className="py-2 pr-4">{event.kind}</td>
                    <td className="py-2 pr-4">{event.actor}</td>
                    <td className="py-2 pr-4">{event.sourceSystem}</td>
                    <td className="py-2">
                      <Link
                        href={`/ledger/${event.correlationId}`}
                        className="underline underline-offset-4 hover:text-primary"
                      >
                        {event.correlationId}
                      </Link>
                    </td>
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
